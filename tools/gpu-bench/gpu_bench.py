"""Drawpane's browser benchmarks and parity runs on a real GPU, on Modal.

Run from a checkout (see README.md):

    pnpm gpu-bench -- bench/canvas.spec.ts
    pnpm gpu-bench --browsers chromium,firefox,webkit -- bench/canvas.spec.ts
    pnpm gpu-bench --browsers chromium,firefox,webkit --project auto -- parity/engine.spec.ts
    pnpm gpu-bench --ref origin/main --ref HEAD --modes gpu,cpu -- bench/canvas.spec.ts

Locally this packs each checkout to compare (a commit through `git archive`,
or a worktree's tracked and untracked-but-not-ignored files as they are on
disk), uploads the private kit named by --file to a Modal Volume (once per
content hash), and calls one GPU container that, for every checkout in turn:
installs its dependencies, builds apps/web, passes the GPU gate (gate.mjs)
and runs the Playwright project for each selected browser. The results come
back as a tarball and are unpacked into the output folder, with a summary.

The container is single-use, has a timeout, and nothing is kept warm.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent

# Baked into the image; a checkout that pins other versions (mise.toml, the
# packageManager field, @playwright/test) gets them installed at run time.
NODE_VERSION = "26.13.0"
PNPM_VERSION = "12.18.0"
PLAYWRIGHT_VERSION = "1.65.0"
# The engine's toolchain (packages/engine/mise.toml).
RUST_VERSION = "1.99.1"
WASM_BINDGEN_VERSION = "0.2.130"

APP_NAME = "drawpane-gpu-bench"
DATA_VOLUME = "drawpane-gpu-bench-data"
KITS = "/data/kits"

# Modal's list prices (modal.com/pricing, 2026-11): dollars per second.
PRICE_GPU = {"T4": 0.000164, "L4": 0.000222, "A10": 0.000306, "A10G": 0.000306}
PRICE_CORE = 0.0000131
PRICE_GIB = 0.00000222
CPU_CORES = 4.0
MEMORY_MIB = 12288

BROWSERS = ("chromium", "firefox", "webkit")

# Chromium's flags for each mode. `--headless` (new headless) comes from
# Playwright; the wrapper merges every --enable-features into one.
#
# gpu: GL (ANGLE) on Vulkan on the NVIDIA GPU for the 2D canvas, WebGL and
# compositing. Chromium's own Vulkan stays off: its compositor needs
# VK_EXT_headless_surface, which the NVIDIA driver lacks, and with it on the
# GPU process crashes or compositing falls back to software. In this setup
# Chromium offers no NVIDIA adapter for core WebGPU (SwiftShader instead), so
# WebGPU runs in compatibility mode on Dawn's OpenGL ES backend over ANGLE.
BASE_GPU_FLAGS = [
    "--use-angle=vulkan",
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--disable-gpu-sandbox",
    "--enable-dawn-features=allow_unsafe_apis,disable_adapter_blocklist",
]
MODE_FLAGS = {
    "gpu": [*BASE_GPU_FLAGS, "--use-webgpu-adapter=opengles"],
    # webgpu: core WebGPU on Dawn's Vulkan backend on the NVIDIA GPU, which needs
    # Chromium's Vulkan; without a surface for it, compositing is in software.
    "webgpu": [
        *BASE_GPU_FLAGS,
        "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan",
        "--disable-vulkan-surface",
    ],
    "cpu": ["--disable-gpu"],
}
# Only the NVIDIA Vulkan driver: Mesa's lavapipe (software) is installed alongside.
NVIDIA_ICD = "/etc/vulkan/icd.d/nvidia_icd.json"

image = (
    modal.Image.from_registry("ubuntu:24.04", add_python="3.12")
    .env({"DEBIAN_FRONTEND": "noninteractive", "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright"})
    .apt_install(
        "ca-certificates", "curl", "xz-utils", "git", "vulkan-tools", "libvulkan1",
        "libxext6", "libx11-6", "libatomic1", "dbus", "fonts-liberation",
        "xvfb", "mesa-utils", "openssl",
        # GLVND: the NVIDIA Vulkan driver (libGLX_nvidia) loads it at run time and
        # answers no vkCreateInstance without it.
        "libglvnd0", "libgl1", "libglx0", "libegl1",
    )
    .run_commands(
        f"curl -fsSL https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz"
        " | tar -xJ -C /opt",
        f"ln -s /opt/node-v{NODE_VERSION}-linux-x64 /opt/node",
    )
    .env({"PATH": "/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"})
    .run_commands(
        f"npm install -g pnpm@{PNPM_VERSION} playwright@{PLAYWRIGHT_VERSION}",
        "playwright install --with-deps chromium firefox webkit",
    )
    # The render engine (packages/engine, decision 0040) is Rust built to WebAssembly with its
    # folder's mise.toml; apps/web's build needs it. The toolchain is baked in so a run only
    # compiles the crate.
    .apt_install("build-essential", "pkg-config")
    .env({"MISE_DATA_DIR": "/opt/mise", "MISE_YES": "1", "PATH": "/opt/mise/shims:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"})
    .run_commands(
        "curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh",
        f"mise use -g rust@{RUST_VERSION} && mise exec rust@{RUST_VERSION} -- rustup target add wasm32-unknown-unknown",
        f"mise use -g cargo:wasm-bindgen-cli@{WASM_BINDGEN_VERSION}",
    )
    .add_local_file(HERE / "gate.mjs", "/opt/gpu-bench/gate.mjs")
)

app = modal.App(APP_NAME)
data = modal.Volume.from_name(DATA_VOLUME, create_if_missing=True)


# --------------------------------------------------------------------------
# In the container.


def _log(msg: str) -> None:
    print(f"[gpu-bench {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _run(cmd: list[str], *, cwd: str | None = None, env: dict | None = None,
         log: Path | None = None, timeout: float | None = None) -> int:
    """Runs a command, streaming its output to the terminal and to `log`."""
    _log("$ " + " ".join(cmd))
    out = open(log, "a") if log else None
    timer = None
    try:
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, errors="replace",
                                start_new_session=True)

        def expire() -> None:
            _log(f"timed out after {timeout:.0f} s: stopping {cmd[0]}")
            os.killpg(proc.pid, signal.SIGKILL)

        timer = threading.Timer(timeout, expire) if timeout else None
        if timer:
            timer.start()
        assert proc.stdout
        for line in proc.stdout:
            sys.stdout.write(line)
            if out:
                out.write(line)
                out.flush()
        return proc.wait()
    finally:
        if timer:
            timer.cancel()
        if out:
            out.close()


def _sh(cmd: str, env: dict | None = None) -> str:
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, env=env).stdout


def _vulkan(env: dict) -> dict:
    """What the NVIDIA Vulkan driver reports, if it loads at all."""
    gpu = _sh("nvidia-smi --query-gpu=name,driver_version --format=csv,noheader").strip()
    name, _, driver = gpu.partition(", ")
    summary = _sh("vulkaninfo --summary 2>&1", env)
    devices = re.findall(r"deviceName\s*=\s*(.+)", summary)
    ok = "DRIVER_ID_NVIDIA_PROPRIETARY" in summary
    return {"gpu": name, "driver": driver, "vulkanDevices": devices, "ok": ok,
            "vulkaninfo": summary}


def _start_xvfb() -> subprocess.Popen | None:
    """Starts Xvfb on :99 so browsers that need an X11 display for EGL/GLX have one."""
    proc = subprocess.Popen(
        ["Xvfb", ":99", "-screen", "0", "1920x1080x24", "+extension", "GLX", "+render", "-noreset"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(0.5)
    return proc


@app.function(image=image, gpu="T4", cpu=2.0, memory=4096, timeout=900, single_use_containers=True)
def doctor(sets: list[dict]) -> dict:
    """The GPU stack without a checkout (`--doctor`): Vulkan, EGL/GLVND inventory, then the
    gate for each set ({"browser": "chromium"|"firefox"|"webkit", "mode": ..., "flags": [...],
    "headless": True|False}) in the image's browsers."""
    out = Path("/out")
    out.mkdir()
    env = _container_env()
    xvfb = _start_xvfb()
    try:
        vk = _vulkan(env)
        lines = [f"{vk['gpu']}, driver {vk['driver']}, Vulkan devices {vk['vulkanDevices']}"]
        (out / "vulkaninfo.txt").write_text(vk["vulkaninfo"])
        gl_info = _sh(
            "ls -la /usr/share/glvnd/egl_vendor.d/ /etc/vulkan/icd.d/ /dev/dri 2>&1; "
            "echo '--- glxinfo ---'; DISPLAY=:99 glxinfo -B 2>&1; "
            "echo '--- eglinfo ---'; eglinfo -B 2>&1",
            env,
        )
        (out / "gl-inventory.txt").write_text(gl_info)
        chrome = str(next(Path("/ms-playwright").glob("chromium-*/chrome-linux64/chrome")))
        for n, one in enumerate(sets):
            browser = one.get("browser", "chromium")
            headless = one.get("headless", True)
            mode = one["mode"]
            at = out / f"gate-{n}-{browser}-{mode}{'' if headless else '-xvfb'}"
            at.mkdir()
            set_env = dict(env)
            if not headless:
                set_env["DISPLAY"] = ":99"
            for item in one.get("flags", []):
                if item.startswith("env:-"):
                    set_env.pop(item[5:], None)
                elif item.startswith("env:"):
                    k, _, v = item[4:].partition("=")
                    set_env[k] = v
            flags = [f for f in one.get("flags", []) if not f.startswith("env:")]
            cmd = [
                "node",
                "/opt/gpu-bench/gate.mjs",
                "--browser",
                browser,
                "--headless",
                "true" if headless else "false",
                "--host-gpu-ok",
                "true" if mode != "cpu" and vk["ok"] else "false",
                "--expect",
                mode,
                "--out",
                str(at),
            ]
            if browser == "chromium":
                wrapper = _wrapper(Path(f"/tmp/chrome-doctor-{n}"), chrome, flags, at / "chrome.log")
                cmd += ["--chrome", wrapper]
            code = _run(cmd, env=set_env, log=at / "gate.log", timeout=240)
            lines.append(
                f"[gate-{n}] {browser} ({mode}, headless={headless}): "
                f"{'passed' if code == 0 else 'FAILED'} with {' '.join(one.get('flags', []))}"
            )
        (out / "doctor.txt").write_text("\n".join(lines) + "\n")
        return {"lines": lines, "tar": _tar(out)}
    finally:
        if xvfb:
            xvfb.terminate()


def _toolchain(src: Path, env: dict) -> dict:
    """Node and pnpm at the checkout's versions, on PATH in `env`."""
    node = NODE_VERSION
    mise = src / "mise.toml"
    if mise.exists():
        m = re.search(r'^node\s*=\s*"([^"]+)"', mise.read_text(), re.M)
        if m:
            node = m.group(1)
    pkg = json.loads((src / "package.json").read_text())
    pnpm = (pkg.get("packageManager") or f"pnpm@{PNPM_VERSION}").split("@")[1].split("+")[0]
    path = env["PATH"]
    if node != NODE_VERSION:
        target = Path(f"/tmp/node-v{node}-linux-x64")
        if not target.exists():
            _log(f"installing Node {node}")
            subprocess.run(f"curl -fsSL https://nodejs.org/dist/v{node}/node-v{node}-linux-x64.tar.xz"
                           " | tar -xJ -C /tmp", shell=True, check=True)
        path = f"{target}/bin:{path}"
    if pnpm != PNPM_VERSION:
        prefix = f"/tmp/pnpm-{pnpm}"
        if not Path(prefix).exists():
            _log(f"installing pnpm {pnpm}")
            subprocess.run(["npm", "install", "-g", "--prefix", prefix, f"pnpm@{pnpm}"],
                           check=True, env={**env, "PATH": path})
        path = f"{prefix}/bin:{path}"
    env["PATH"] = path
    return {"node": node, "pnpm": pnpm}


def _browser_bin(src: Path, env: dict, browser_name: str) -> tuple[str | None, str]:
    """Ensures the checkout's pinned Playwright browser is installed and returns its path and version."""
    web = src / "apps/web"
    core = subprocess.run(
        ["node", "-p", "require.resolve('playwright-core/package.json',"
         "{paths:[require.resolve('@playwright/test')]})"],
        cwd=web, env=env, capture_output=True, text=True, check=True).stdout.strip()
    browsers = json.loads((Path(core).parent / "browsers.json").read_text())
    entry = next(b for b in browsers["browsers"] if b["name"] == browser_name)
    root = Path(env["PLAYWRIGHT_BROWSERS_PATH"]) / f"{browser_name}-{entry['revision']}"
    if not root.exists():
        _log(f"installing {browser_name} {entry['browserVersion']} (r{entry['revision']})")
        subprocess.run(["node_modules/.bin/playwright", "install", browser_name], cwd=web, env=env,
                       check=True)
    exe = None
    if browser_name == "chromium":
        exe = str(root / "chrome-linux64/chrome")
    return exe, entry["browserVersion"]


def _wrapper(path: Path, chrome: str, flags: list[str], log: Path) -> str:
    """Chromium as Playwright launches it plus `flags`, every --enable-features and
    --disable-features merged into one each; its stderr goes to `log`."""
    path.write_text(f"""#!/bin/bash
# Chromium for the bench: Playwright's arguments plus ours.
args=()
enable=()
disable=()
for a in "$@" {' '.join(shlex.quote(f) for f in flags)}; do
  case "$a" in
    --enable-features=*) enable+=("${{a#--enable-features=}}") ;;
    --disable-features=*) disable+=("${{a#--disable-features=}}") ;;
    *) args+=("$a") ;;
  esac
done
join() {{ local IFS=,; echo "$*"; }}
[[ ${{#enable[@]}} -gt 0 ]] && args+=("--enable-features=$(join "${{enable[@]}}")")
[[ ${{#disable[@]}} -gt 0 ]] && args+=("--disable-features=$(join "${{disable[@]}}")")
exec {shlex.quote(chrome)} "${{args[@]}}" --enable-logging=stderr 2>>{shlex.quote(str(log))}
""")
    path.chmod(0o755)
    return str(path)


def _tar(folder: Path) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        tar.add(folder, arcname=".")
    return buf.getvalue()


def _container_env() -> dict:
    os.makedirs("/tmp/xdg", mode=0o700, exist_ok=True)
    subprocess.run("mkdir -p /run/dbus && dbus-daemon --system --fork", shell=True,
                   capture_output=True)
    env = {
        **os.environ,
        "CI": "",
        "VK_DRIVER_FILES": NVIDIA_ICD,
        "VK_ICD_FILENAMES": NVIDIA_ICD,
        "XDG_RUNTIME_DIR": "/tmp/xdg",
    }
    # Point EGL at NVIDIA's vendor ICD if present so Firefox/WebKit pick the T4 over Mesa software.
    nvidia_egl = "/usr/share/glvnd/egl_vendor.d/10_nvidia.json"
    if Path(nvidia_egl).exists():
        env["__EGL_VENDOR_LIBRARY_FILENAMES"] = nvidia_egl
    return env


def _project_for(browser: str, project_opt: str | None, pw_args: list[str]) -> str:
    """Resolves the Playwright project name for a browser and spec list."""
    if project_opt and project_opt != "auto":
        return project_opt
    is_bench = not pw_args or any("bench/" in a or a == "bench" for a in pw_args)
    if is_bench:
        return "bench" if browser == "chromium" else f"bench-{browser}"
    return browser


def _bench_annotations(report: Path) -> dict:
    """The `bench` annotations of every test in Playwright's JSON report."""
    found: dict = {}
    if not report.exists():
        return found

    def walk(suite: dict, trail: list[str]) -> None:
        for spec in suite.get("specs", []):
            for t in spec.get("tests", []):
                for r in t.get("results", []):
                    for a in r.get("annotations", []) + t.get("annotations", []):
                        if a.get("type") == "bench":
                            found[" › ".join(trail + [spec["title"]])] = json.loads(a["description"])
                status = [r.get("status") for r in t.get("results", [])]
                found.setdefault("_status", {})[" › ".join(trail + [spec["title"]])] = status
        for s in suite.get("suites", []):
            walk(s, trail + [s["title"]])

    for s in json.loads(report.read_text()).get("suites", []):
        walk(s, [s["title"]])
    return found


@app.function(
    image=image,
    gpu="T4",
    cpu=CPU_CORES,
    memory=MEMORY_MIB,
    timeout=3600,
    volumes={"/data": data},
    single_use_containers=True,
)
def bench(job: dict, sources: list[dict]) -> dict:
    started = time.time()
    out = Path("/out")
    out.mkdir()
    result: dict = {"status": "error", "runs": []}
    base_env = _container_env()
    xvfb = _start_xvfb()
    try:
        vk = _vulkan(base_env)
        result["host"] = {k: v for k, v in vk.items() if k != "vulkaninfo"}
        (out / "vulkaninfo.txt").write_text(vk["vulkaninfo"])
        _log(f"{vk['gpu']}, driver {vk['driver']}, Vulkan devices {vk['vulkanDevices']}")
        if {"gpu", "webgpu"} & set(job["modes"]) and not vk["ok"]:
            # The NVIDIA Vulkan driver didn't load here (it did on every host once GLVND
            # was in the image; this is the safety net): say so before building
            # anything, and the caller retries on another container.
            result["status"] = "no-vulkan"
            return result

        kit = None
        if job.get("kit"):
            kit = f"{KITS}/{job['kit']}"
            if not Path(kit, ".complete").exists():
                raise RuntimeError(f"The kit {job['kit']} isn't on the volume.")

        browsers = job.get("browsers") or ["chromium"]
        port_offset = 0
        for n, source in enumerate(sources):
            label = source["label"]
            run: dict = {"label": label, "git": source.get("git"), "browsers": {}, "modes": {}}
            result["runs"].append(run)
            src = Path(f"/work/{n}")
            src.mkdir(parents=True)
            dest = out / label
            dest.mkdir(parents=True, exist_ok=True)
            log = dest / "build.log"
            t = time.time()
            with tarfile.open(fileobj=io.BytesIO(source["tar"]), mode="r:gz") as tar:
                tar.extractall(src, filter="tar")
            env = dict(base_env)
            run["toolchain"] = _toolchain(src, env)
            if _run(["pnpm", "install", "--frozen-lockfile"], cwd=str(src), env=env, log=log) != 0:
                raise RuntimeError(f"{label}: pnpm install failed (see {label}/build.log).")
            # With its workspace dependencies: the engine's WebAssembly is one (decision 0040).
            if _run(["pnpm", "--filter", "@drawpane/web...", "build"], cwd=str(src), env=env,
                    log=log) != 0:
                raise RuntimeError(f"{label}: building apps/web failed (see {label}/build.log).")
            browser_bins: dict[str, str | None] = {}
            for browser in browsers:
                exe, version = _browser_bin(src, env, browser)
                browser_bins[browser] = exe
                run["browsers"][browser] = version
                if browser == "chromium":
                    run["chromium"] = version
            run["buildSeconds"] = round(time.time() - t)

            for browser in browsers:
                browser_modes = job["modes"] if browser == "chromium" else [
                    m for m in job["modes"] if m != "webgpu"
                ] or ["gpu"]
                for mode in browser_modes:
                    t = time.time()
                    key = mode if browser == "chromium" else f"{browser}-{mode}"
                    at = dest / key
                    at.mkdir()
                    gate_env = dict(env)
                    if mode == "cpu":
                        # Actively hide hardware GPU ICDs and force Mesa software paths so
                        # Firefox and WebKit cannot silently pick the NVIDIA T4 in cpu mode.
                        lavapipe = "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json"
                        mesa_egl = "/usr/share/glvnd/egl_vendor.d/50_mesa.json"
                        gate_env["VK_DRIVER_FILES"] = lavapipe if Path(lavapipe).exists() else "/dev/null"
                        gate_env["VK_ICD_FILENAMES"] = gate_env["VK_DRIVER_FILES"]
                        gate_env["__EGL_VENDOR_LIBRARY_FILENAMES"] = (
                            mesa_egl if Path(mesa_egl).exists() else "/dev/null"
                        )
                        gate_env["LIBGL_ALWAYS_SOFTWARE"] = "1"
                        gate_env["GALLIUM_DRIVER"] = "llvmpipe"
                        gate_env["MOZ_WEBRENDER"] = "0"
                        gate_env["MOZ_ACCELERATED"] = "0"
                        gate_env["WEBKIT_DISABLE_COMPOSITING_MODE"] = "1"
                    gate_cmd = [
                        "node",
                        "/opt/gpu-bench/gate.mjs",
                        "--checkout",
                        str(src),
                        "--browser",
                        browser,
                        "--host-gpu-ok",
                        "true" if mode in ("gpu", "webgpu") and vk["ok"] else "false",
                        "--expect",
                        mode,
                        "--out",
                        str(at),
                    ]
                    wrapper = None
                    if browser == "chromium":
                        flags = MODE_FLAGS[mode] + (job.get("chromeFlags", []) if mode != "cpu" else [])
                        wrapper = _wrapper(Path(f"/tmp/chrome-{mode}"), browser_bins[browser], flags,
                                           at / "chrome.log")
                        gate_cmd += ["--chrome", wrapper]
                    elif browser == "webkit":
                        gate_env.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
                        gate_env["DISPLAY"] = ":99"
                    elif browser == "firefox":
                        # Firefox headless on Linux disables WebGPU and WebGL2; running under
                        # Xvfb enables real Vulkan WebGPU on the NVIDIA T4.
                        gate_env["DISPLAY"] = ":99"
                        gate_env["GPU_BENCH_XVFB"] = "1"
                        gate_cmd += ["--headless", "false"]

                    code = _run(gate_cmd, env=gate_env, log=at / "gate.log", timeout=180)
                    gate = json.loads((at / "gate.json").read_text()) if (at / "gate.json").exists() else {}
                    entry: dict = {
                        "browser": browser,
                        "mode": mode,
                        "gate": {
                            "ok": code == 0,
                            **gate.get("summary", {}),
                            "problems": gate.get("problems", []),
                        },
                    }
                    run["modes"][key] = entry
                    if code != 0 and job.get("strictGate", True):
                        raise RuntimeError(
                            f"{label} ({key}): the GPU gate failed; see {label}/{key}/gate.log."
                        )

                    project = _project_for(browser, job.get("project"), job["args"])
                    verified_backends = gate.get("summary", {}).get("verifiedBackends", [])
                    test_env = {
                        **gate_env,
                        "ENGINE_BROWSER": browser,
                        "ENGINE_PARITY_OUT": str(at / "engine-parity"),
                        "PLAYWRIGHT_JSON_OUTPUT_NAME": str(at / "report.json"),
                        "E2E_PORT": "8849",
                        "TOUR_PORT": "8859",
                        "PARITY_PORT": "8935",
                        "E2E_INSPECTOR_PORT": "9379",
                        **job.get("env", {}),
                    }
                    # Wrangler may still be closing a socket from the preceding Playwright run.
                    for port in ("E2E_PORT", "TOUR_PORT", "PARITY_PORT", "E2E_INSPECTOR_PORT"):
                        test_env[port] = str(int(test_env[port]) + port_offset)
                    port_offset += 200
                    if verified_backends:
                        test_env["BENCH_VERIFIED_BACKENDS"] = ",".join(verified_backends)
                    if wrapper:
                        test_env["CHROMIUM_PATH"] = wrapper
                    if kit:
                        test_env["BENCH_FILE"] = kit
                        test_env.setdefault("BENCH_OUT", str(at / "file.json"))
                    if job.get("profile") and browser == "chromium":
                        test_env["BENCH_PROFILE"] = str(at / "profiles")
                    code = _run(
                        ["node_modules/.bin/playwright", "test", f"--project={project}",
                         "--reporter=list,json", f"--output={at / 'test-results'}", *job["args"]],
                        cwd=str(src / "apps/web"), env=test_env, log=at / "bench.log",
                        timeout=job["timeout"])
                    entry["exitCode"] = code
                    entry["seconds"] = round(time.time() - t)
                    entry["bench"] = _bench_annotations(at / "report.json")
                    (at / "bench.json").write_text(json.dumps(entry["bench"], indent=1) + "\n")
                    _log(f"{label} ({key}): Playwright exited {code} after {entry['seconds']} s")
            shutil.rmtree(src, ignore_errors=True)
        result["status"] = "ok"
    except Exception as error:  # noqa: BLE001 - reported to the caller with what was gathered
        result["error"] = str(error)
        _log(f"error: {error}")
    finally:
        if xvfb:
            xvfb.terminate()
        result["seconds"] = round(time.time() - started)
        (out / "result.json").write_text(json.dumps(result, indent=1) + "\n")
        result["tar"] = _tar(out)
    return result


# --------------------------------------------------------------------------
# Locally.


def _git(args: list[str], cwd: Path, text: bool = True):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, check=True,
                          text=text).stdout


def _pack_ref(repo: Path, ref: str) -> dict:
    sha = _git(["rev-parse", "--verify", f"{ref}^{{commit}}"], repo).strip()
    tar = subprocess.run(["git", "archive", "--format=tar.gz", sha], cwd=repo,
                         capture_output=True, check=True).stdout
    return {"label": sha[:9], "git": {"ref": ref, "sha": sha, "dirty": False}, "tar": tar}


def _pack_worktree(path: Path) -> dict:
    sha = _git(["rev-parse", "HEAD"], path).strip()
    files = _git(["ls-files", "-z", "-co", "--exclude-standard"], path, text=False).split(b"\0")
    dirty = bool(_git(["status", "--porcelain"], path).strip())
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for f in files:
            name = f.decode()
            p = path / name
            if name and (p.is_file() or p.is_symlink()):
                tar.add(p, arcname=name, recursive=False)
    label = sha[:9] + ("-dirty" if dirty else "")
    return {"label": label, "git": {"worktree": str(path), "sha": sha, "dirty": dirty},
            "tar": buf.getvalue()}


def _kit_hash(folder: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(x for x in folder.rglob("*") if x.is_file()):
        h.update(p.relative_to(folder).as_posix().encode() + b"\0")
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        h.update(b"\0")
    return h.hexdigest()[:16]


def _upload_kit(folder: Path) -> str:
    """Puts the converted kit on the private Volume, once per content hash."""
    key = _kit_hash(folder)
    try:
        names = {Path(e.path).name for e in data.listdir(f"/kits/{key}")}
    except Exception:  # noqa: BLE001 - not there yet
        names = set()
    if ".complete" in names:
        print(f"Kit {key} is already on the volume {DATA_VOLUME}.")
        return key
    size = sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())
    print(f"Uploading the kit ({size / 1e6:.0f} MB) to the volume {DATA_VOLUME} as {key}...")
    with data.batch_upload(force=True) as batch:
        batch.put_directory(str(folder), f"/kits/{key}")
    with data.batch_upload(force=True) as batch:
        batch.put_file(io.BytesIO(key.encode()), f"/kits/{key}/.complete")
    return key


def _cost(gpu: str, seconds: float) -> float:
    return seconds * (PRICE_GPU.get(gpu, 0) + CPU_CORES * PRICE_CORE + MEMORY_MIB / 1024 * PRICE_GIB)


def _fmt(s: dict | None) -> str:
    if not s:
        return "–"
    return f"{s['p50']} / {s['p95']}"


def _flatten(value: dict, prefix: str = "") -> list[tuple[str, object]]:
    """A bench annotation's measurements by name; nested groups (a page's cases) get its name first."""
    out: list[tuple[str, object]] = []
    for name, s in value.items():
        label = f"{prefix}{name}"
        if isinstance(s, dict) and s and all(isinstance(v, dict) for v in s.values()) \
                and "content" not in s and "answer" not in s:
            out += _flatten(s, f"{label}: ")
        else:
            out.append((label, s))
    return out


def _summary(result: dict, job: dict, wall: float, attempts: int) -> str:
    gpu = job["gpu"]
    lines = [f"# GPU bench: {gpu}", ""]
    host = result.get("host", {})
    lines.append(f"Host: {host.get('gpu')} (driver {host.get('driver')}), Vulkan devices: "
                 f"{', '.join(host.get('vulkanDevices', [])) or 'none'}")
    lines.append(f"Container time {result.get('seconds')} s, wall time {wall:.0f} s, attempts {attempts}, "
                 f"about ${_cost(gpu, result.get('seconds') or 0):.3f} at list prices "
                 f"({gpu} + {CPU_CORES:g} cores + {MEMORY_MIB // 1024} GiB).")
    if result.get("error"):
        lines += ["", f"**Error:** {result['error']}"]
    for run in result.get("runs", []):
        git = run.get("git") or {}
        versions = ", ".join(f"{b} {v}" for b, v in (run.get("browsers") or {}).items()) or f"Chromium {run.get('chromium')}"
        lines += ["", f"## {run['label']} ({git.get('ref') or git.get('worktree')}), {versions}, build {run.get('buildSeconds')} s"]
        for mode, entry in run["modes"].items():
            g = entry["gate"]
            lines += ["", f"### {mode.upper()}: gate {'passed' if g['ok'] else 'FAILED'} "
                      f"(presentation: {g.get('presentationMode', 'n/a')}), "
                      f"bench {entry.get('seconds')} s, exit {entry.get('exitCode')}", "",
                      f"- WebGPU adapter: {g.get('webgpuAdapter')} (identity={g.get('webgpuIdentityClass')}, hostGpuOk={g.get('hostGpuOk')})",
                      f"- WebGPU adapter, compatibility mode: {g.get('webgpuCompatAdapter')}",
                      f"- WebGL renderer: {g.get('webglRenderer')} (identity={g.get('webglIdentityClass')}, maxTex={g.get('webglMaxTextureSize')}, caveatOk={g.get('webglCaveatOk')}, perfMs={g.get('webglPerfProbeMs')})"]
            if entry.get("browser", "chromium") == "chromium":
                lines.append(
                    f"- chrome://gpu: Canvas {g.get('canvas')}; Rasterization {g.get('rasterization')}; "
                    f"Compositing {g.get('compositing')}; WebGL {g.get('webgl')}; WebGPU {g.get('webgpu')}"
                )
            lines += [f"- problem: {p}" for p in g.get("problems", [])]
            for test, value in (entry.get("bench") or {}).items():
                if test == "_status":
                    continue
                tables: list[tuple[str, dict]] = []
                if "pages" in value:
                    for page in value["pages"]:
                        name = page["page"]["name"]
                        opened = page.get("open")
                        if isinstance(opened, dict):
                            useful = (opened.get("useful") or {}).get("shown")
                            exact = (opened.get("exact") or {}).get("shown")
                            lines.append(f"- {name}: useful image {useful} ms, exact shown {exact} ms")
                        else:
                            lines.append(f"- {name}: first frame {page.get('firstFrameMs')} ms, exact after "
                                         f"{page.get('exactMs')} ms")
                        tables += [(f"{name}: {k}", v) for k, v in page["canvas"].items()]
                else:
                    tables += _flatten(value)
                frames = [(n, s) for n, s in tables if isinstance(s, dict) and "answer" not in s and "content" in s]
                answers = [(n, s) for n, s in tables if isinstance(s, dict) and "answer" in s]
                numbers = [(n, s) for n, s in tables if isinstance(s, (int, float))]
                lines += ["", f"{test}", ""]
                lines += [f"- {name}: {s} ms" for name, s in numbers]
                if frames:
                    lines += ["", "| measurement | frame interval p50 / p95 ms | content p50 / p95 ms | overlay p95 ms |",
                              "| --- | --- | --- | --- |"]
                    for name, s in frames:
                        lines.append(f"| {name} | {_fmt(s.get('interval'))} | {_fmt(s.get('content'))} | "
                                     f"{(s.get('overlay') or {}).get('p95')} |")
                if answers:
                    # Interaction cases (bench/interactions.ts): input to the frame showing it.
                    lines += ["", "| interaction | answer p50 / worst ms | drawing p50 ms (content + overlay) | "
                              "exact ms | busy ms | longest task ms |", "| --- | --- | --- | --- | --- | --- |"]
                    for name, s in answers:
                        a = s["answer"]
                        draw = round(s["content"]["p50"] + s["overlay"]["p50"], 1)
                        lt = s.get("longTask")
                        lt_str = "n/a" if lt is None else str(lt)
                        lines.append(f"| {name} | {a['p50']} / {a['max']} | {draw} | {s.get('exact')} | "
                                     f"{s.get('quiet', '-')} | {lt_str} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--":
        argv = argv[1:]
    parser = argparse.ArgumentParser(
        prog="pnpm gpu-bench",
        allow_abbrev=False,
        description="Runs apps/web's Playwright suites on a Modal GPU. Arguments it doesn't know "
                    "(or everything after --) go to `playwright test`.")
    parser.add_argument("--ref", action="append", default=[],
                        help="a commit to run (repeatable; in order, in the same container)")
    parser.add_argument("--worktree", action="append", default=[],
                        help="a worktree to run as it is on disk (repeatable); the default is this one")
    parser.add_argument("--gpu", default="T4", help="Modal GPU type: T4 (default) or L4")
    parser.add_argument("--browsers", default="chromium",
                        help="comma-separated: chromium (default), firefox, webkit")
    parser.add_argument("--project", default=None,
                        help="Playwright project override (default auto-picks bench/chromium/firefox/webkit)")
    parser.add_argument("--modes", default="gpu",
                        help="comma-separated: gpu (default; the canvas, WebGL and compositing on "
                             "the GPU), webgpu (core WebGPU on the GPU, software compositing), cpu "
                             "(GPU disabled)")
    parser.add_argument("--file", help="a converted kit folder for bench/file.spec.ts (BENCH_FILE)")
    parser.add_argument("--env", action="append", default=[], help="KEY=VALUE for the bench (repeatable)")
    parser.add_argument("--profile", action="store_true", help="CPU profiles (BENCH_PROFILE)")
    parser.add_argument("--timeout", type=int, default=45,
                        help="minutes for each Playwright run (default 45); the container gets "
                             "enough for every run plus builds")
    parser.add_argument("--attempts", type=int, default=3,
                        help="containers to try when the NVIDIA Vulkan driver doesn't load (default 3)")
    parser.add_argument("--out", help="output folder (default tools/gpu-bench/runs/<time>)")
    parser.add_argument("--chrome-flag", action="append", default=[],
                        help="an extra Chromium flag for GPU runs (repeatable)")
    parser.add_argument("--doctor", action="store_true",
                        help="only check the GPU stack (Vulkan, then the gate across Chromium, Firefox, WebKit)")
    args, rest = parser.parse_known_args(argv)
    if "--" in rest:
        rest.remove("--")
    if args.doctor:
        out = Path(args.out or HERE / "runs" / f"doctor-{time.strftime('%Y%m%d-%H%M%S')}").resolve()
        flag_sets = [
            {"browser": "chromium", "mode": "gpu", "flags": MODE_FLAGS["gpu"] + args.chrome_flag, "headless": True},
            {"browser": "chromium", "mode": "webgpu", "flags": MODE_FLAGS["webgpu"] + args.chrome_flag, "headless": True},
            {"browser": "firefox", "mode": "info", "flags": [], "headless": True},
            {"browser": "firefox", "mode": "info", "flags": [], "headless": False},
            {"browser": "webkit", "mode": "info", "flags": ["env:WEBKIT_DISABLE_DMABUF_RENDERER=1"], "headless": True},
            {"browser": "webkit", "mode": "info", "flags": ["env:WEBKIT_DISABLE_DMABUF_RENDERER=1"], "headless": False},
        ]
        if os.environ.get("GPU_BENCH_DOCTOR_SETS"):
            flag_sets += json.loads(os.environ["GPU_BENCH_DOCTOR_SETS"])
        with modal.enable_output(), app.run():
            result = doctor.with_options(gpu=args.gpu).remote(flag_sets)
        out.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(result["tar"]), mode="r:gz") as tar:
            tar.extractall(out, filter="data")
        print("\n".join(result["lines"]) + f"\nDetails in {out}")
        return 0
    repo = Path(_git(["rev-parse", "--show-toplevel"], Path.cwd()).strip())

    browsers = [b.strip() for b in args.browsers.split(",") if b.strip()]
    if not browsers or any(b not in BROWSERS for b in browsers):
        parser.error("--browsers takes a comma-separated list of chromium, firefox and webkit")
    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    if not modes or any(m not in MODE_FLAGS for m in modes):
        parser.error("--modes takes a comma-separated list of gpu, webgpu and cpu")
    sources = [_pack_ref(repo, r) for r in args.ref]
    sources += [_pack_worktree(Path(w).resolve()) for w in args.worktree]
    if not sources:
        sources = [_pack_worktree(repo)]
    labels = [s["label"] for s in sources]
    for i, s in enumerate(sources):
        if labels.count(s["label"]) > 1:
            s["label"] = f"{i + 1}-{s['label']}"
    env = dict(e.split("=", 1) for e in args.env)
    job = {
        "gpu": args.gpu,
        "browsers": browsers,
        "project": args.project,
        "modes": modes,
        "args": rest or ["bench/"],
        "env": env,
        "chromeFlags": args.chrome_flag,
        "profile": args.profile,
        "timeout": args.timeout * 60,
        "kit": None,
    }
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = Path(args.out or HERE / "runs" / stamp).resolve()
    out.mkdir(parents=True, exist_ok=True)
    for s in sources:
        print(f"Packed {s['label']}: {len(s['tar']) / 1e6:.1f} MB")

    budget = len(sources) * (15 * 60 + len(browsers) * len(modes) * (job["timeout"] + 5 * 60))
    started = time.time()
    attempts = 0
    with modal.enable_output(), app.run():
        if args.file:
            job["kit"] = _upload_kit(Path(args.file).resolve())
        fn = bench.with_options(gpu=args.gpu, timeout=min(budget, 24 * 3600))
        while True:
            attempts += 1
            result = fn.remote(job, sources)
            if result["status"] != "no-vulkan" or attempts >= args.attempts:
                break
            host = result.get("host", {})
            print(f"The NVIDIA Vulkan driver didn't load on this host ({host.get('gpu')}, driver "
                  f"{host.get('driver')}); trying another container.")
    wall = time.time() - started
    with tarfile.open(fileobj=io.BytesIO(result.pop("tar")), mode="r:gz") as tar:
        tar.extractall(out, filter="data")
    result["wallSeconds"] = round(wall)
    result["attempts"] = attempts
    result["job"] = {**job, "sources": [{"label": s["label"], "git": s["git"]} for s in sources]}
    result["estimatedCostUsd"] = round(_cost(args.gpu, result.get("seconds") or 0), 4)
    (out / "result.json").write_text(json.dumps(result, indent=1) + "\n")
    summary = _summary(result, job, wall, attempts)
    (out / "summary.md").write_text(summary)
    print(f"\n{summary}\nResults in {out}")
    failed = [f"{run['label']} ({mode})" for run in result.get("runs", [])
              for mode, entry in run["modes"].items() if entry.get("exitCode") not in (0, None)]
    if failed:
        print(f"Playwright failed for {', '.join(failed)}: see each one's bench.log.")
    return 0 if result["status"] == "ok" and not failed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
