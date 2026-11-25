"""Drawpane's browser benchmarks and parity runs on a real GPU, on Modal.

Run from a checkout (see README.md):

    pnpm gpu-bench -- bench/canvas.spec.ts
    pnpm gpu-bench --browsers chromium,firefox,webkit -- bench/canvas.spec.ts
    pnpm gpu-bench --browsers chromium,firefox,webkit --project auto -- parity/engine.spec.ts
    pnpm gpu-bench --ref origin/main --ref HEAD --modes gpu,cpu -- bench/canvas.spec.ts

Locally this packs each checkout to compare (a commit through `git archive`,
or a worktree's tracked and untracked-but-not-ignored files as they are on
disk), and selects a private kit on a Modal Volume (uploading it first with
--file if needed). CPU containers build missing artifacts on the Volume first.
Each GPU container installs dependencies, restores the builds, checks the GPU
gate (gate.mjs), and runs Playwright for the selected checkouts and browsers.

GPU containers are single-use, have a timeout, and nothing is kept warm.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import io
import json
import math
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import modal
from modal.exception import Error as ModalError, NotFoundError

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
BUILDS = Path("/data/builds")
# Bump when the build recipe or its image changes outside the versions below.
BUILD_CACHE_VERSION = "ubuntu24.04-linux-x64-v1"
BUILD_ARCHIVE = "outputs.tar.gz"
LEDGER = Path.home() / ".cache/drawpane-gpu-bench/ledger.jsonl"

# Modal's list prices (modal.com/pricing, 2026-11): dollars per second.
PRICE_GPU = {"T4": 0.000164, "L4": 0.000222, "A10": 0.000306, "A10G": 0.000306}
PRICE_CORE = 0.0000131
PRICE_GIB = 0.00000222
CPU_CORES = 4.0
MEMORY_MIB = 12288
BUILD_CORES = 8.0
BUILD_MEMORY_MIB = 16384
DOCTOR_CORES = 2.0
DOCTOR_MEMORY_MIB = 4096
BUILD_ESTIMATE_SECONDS = 300

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


@app.function(
    image=image, gpu="T4", cpu=DOCTOR_CORES, memory=DOCTOR_MEMORY_MIB, timeout=900,
    single_use_containers=True,
)
def doctor(sets: list[dict]) -> dict:
    """The GPU stack without a checkout (`--doctor`): Vulkan, EGL/GLVND inventory, then the
    gate for each set ({"browser": "chromium"|"firefox"|"webkit", "mode": ..., "flags": [...],
    "headless": True|False}) in the image's browsers."""
    started = time.monotonic()
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
        return {"lines": lines, "tar": _tar(out), "seconds": time.monotonic() - started}
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


def _extract_source(source: dict, src: Path) -> None:
    src.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(source["tar"]), mode="r:gz") as tar:
        tar.extractall(src, filter="tar")


def _build_ready(folder: Path) -> bool:
    return (folder / ".complete").is_file() and (folder / BUILD_ARCHIVE).is_file()


@app.function(
    image=image, cpu=BUILD_CORES, memory=BUILD_MEMORY_MIB, timeout=1800,
    volumes={"/data": data}, single_use_containers=True,
)
def build_source(source: dict, rebuild: bool) -> dict:
    """Build the web app and its workspace dependencies on CPU, then publish the artifacts."""
    started = time.monotonic()
    key = source["buildKey"]
    folder = BUILDS / key
    result = {"key": key, "label": source["label"], "status": "error"}
    try:
        # A different invocation may have populated the cache since the preflight.
        if not rebuild and _build_ready(folder):
            result["status"] = "cached"
            return result
        src = Path("/work/0")
        _extract_source(source, src)
        env = {**os.environ, "CI": ""}
        _toolchain(src, env)
        if _run(["pnpm", "install", "--frozen-lockfile"], cwd=str(src), env=env) != 0:
            raise RuntimeError("pnpm install failed")
        if _run(["pnpm", "--filter", "@drawpane/web...", "build"], cwd=str(src), env=env) != 0:
            raise RuntimeError("building apps/web failed")

        # Wrangler serves web/dist. Its Worker and the parity specs import the
        # engine's dist directly. e2e/server.mjs generates the runner's capped Wasm.
        outputs = ["apps/web/dist"]
        if (src / "packages/engine/package.json").is_file():
            outputs.append("packages/engine/dist")
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=folder, prefix=".build-", delete=False) as temp:
            pending = Path(temp.name)
        try:
            with tarfile.open(pending, mode="w:gz") as tar:
                for output in outputs:
                    tar.add(src / output, arcname=output)
            # Forced rebuilds replace the archive atomically, so existing readers
            # can keep using the previous complete build for this same key.
            pending.replace(folder / BUILD_ARCHIVE)
            (folder / ".complete").touch()
        finally:
            pending.unlink(missing_ok=True)
        data.commit()
        result["status"] = "built"
    except Exception as error:
        result["error"] = str(error)
        _log(f"{source['label']}: {error}")
    finally:
        result["seconds"] = round(time.monotonic() - started, 2)
    return result


def _restore_build(source: dict, src: Path) -> None:
    folder = BUILDS / source["buildKey"]
    if not _build_ready(folder):
        raise RuntimeError(f"The build {source['buildKey']} isn't complete on the volume.")
    # Volume snapshots are mounted when single-use GPU containers start, after
    # all CPU builds have committed. Extract onto local disk for the test run.
    _log(f"restoring build {source['buildKey']} for {source['label']}")
    with tarfile.open(folder / BUILD_ARCHIVE, mode="r:gz") as tar:
        tar.extractall(src, filter="data")


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
    started = time.monotonic()
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
            # was in the image; this is the safety net): say so before setting
            # up the checkouts, and the caller retries on another container.
            result["status"] = "no-vulkan"
            return result

        kit = None
        if job.get("kit"):
            kit = f"{KITS}/{job['kit']}"
            if not Path(kit, ".complete").exists():
                raise RuntimeError(f"The kit {job['kit']} isn't on the volume.")

        browsers = job.get("browsers") or ["chromium"]
        replay_python = None
        if job.get("env", {}).get("BENCH_W4_REPLAY") == "1":
            replay_venv = Path("/tmp/drawpane-camera-replay")
            replay_python = str(replay_venv / "bin" / "python")
            replay_log = out / "camera-replay-setup.log"
            if _run([sys.executable, "-m", "venv", str(replay_venv)], log=replay_log) != 0 or _run(
                [replay_python, "-m", "pip", "install", "numpy==2.4.6", "scikit-image==0.26.0", "flip-evaluator==1.6"],
                log=replay_log,
            ) != 0:
                raise RuntimeError("Camera replay dependency setup failed. See camera-replay-setup.log.")
        port_offset = 0
        for n, source in enumerate(sources):
            label = source["label"]
            run: dict = {"label": label, "git": source.get("git"), "buildKey": source["buildKey"],
                         "browsers": {}, "modes": {}}
            result["runs"].append(run)
            src = Path(f"/work/{n}")
            dest = out / label
            dest.mkdir(parents=True, exist_ok=True)
            log = dest / "setup.log"
            t = time.monotonic()
            _extract_source(source, src)
            env = dict(base_env)
            run["toolchain"] = _toolchain(src, env)
            if _run(["pnpm", "install", "--frozen-lockfile"], cwd=str(src), env=env, log=log) != 0:
                raise RuntimeError(f"{label}: pnpm install failed (see {label}/setup.log).")
            _restore_build(source, src)
            browser_bins: dict[str, str | None] = {}
            for browser in browsers:
                exe, version = _browser_bin(src, env, browser)
                browser_bins[browser] = exe
                run["browsers"][browser] = version
                if browser == "chromium":
                    run["chromium"] = version
            run["setupSeconds"] = round(time.monotonic() - t, 2)

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
                    if code != 0:
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
                    if replay_python:
                        test_env.setdefault("BENCH_W4_REPLAY_PYTHON", replay_python)
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
        result["status"] = "playwright-failed" if any(
            mode["exitCode"] != 0 for run in result["runs"] for mode in run["modes"].values()
        ) else "ok"
    except Exception as error:  # noqa: BLE001 - reported to the caller with what was gathered
        result["error"] = str(error)
        _log(f"error: {error}")
    finally:
        if xvfb:
            xvfb.terminate()
        result["tar"] = _tar(out)
        result["seconds"] = round(time.monotonic() - started, 2)
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
        for f in sorted(set(files) - {b""}):
            name = os.fsdecode(f)
            p = path / name
            if p.is_file() or p.is_symlink():
                tar.add(p, arcname=name, recursive=False)
    label = sha[:9] + ("-dirty" if dirty else "")
    return {"label": label, "git": {"worktree": str(path), "sha": sha, "dirty": dirty},
            "tar": buf.getvalue()}


def _build_key(archive: bytes) -> str:
    """Hash the inputs as extracted, independent of gzip and checkout timestamps."""
    h = hashlib.sha256()
    h.update(json.dumps([
        BUILD_CACHE_VERSION, NODE_VERSION, PNPM_VERSION, RUST_VERSION, WASM_BINDGEN_VERSION,
    ]).encode() + b"\n")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for member in sorted(tar.getmembers(), key=lambda item: item.name):
            if member.isdir():
                continue
            # Git tracks the executable bit. The rest of the mode varies with umask.
            h.update(json.dumps([
                member.name, member.type.hex(), member.mode & 0o111, member.linkname, member.size,
            ]).encode() + b"\n")
            if member.isfile():
                with tar.extractfile(member) as content:
                    for chunk in iter(lambda: content.read(1 << 20), b""):
                        h.update(chunk)
    return h.hexdigest()


def _cached_build(key: str) -> bool:
    try:
        entries = data.listdir(f"/builds/{key}")
    except (FileNotFoundError, NotFoundError):
        return False
    return {".complete", BUILD_ARCHIVE} <= {Path(entry.path).name for entry in entries}


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


def _cost(kind: str, seconds: float, gpu: str) -> float:
    if kind == "build":
        return seconds * (BUILD_CORES * PRICE_CORE + BUILD_MEMORY_MIB / 1024 * PRICE_GIB)
    cores, memory = (DOCTOR_CORES, DOCTOR_MEMORY_MIB) if kind == "doctor" else (CPU_CORES, MEMORY_MIB)
    return seconds * (PRICE_GPU[gpu] + cores * PRICE_CORE + memory / 1024 * PRICE_GIB)


def _money(value: str) -> float:
    amount = float(value)
    if not math.isfinite(amount) or amount < 0:
        raise ValueError("cost must be finite and non-negative")
    return amount


def _utc_today() -> datetime:
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)


def _billing(start: datetime, today: datetime) -> list:
    # Modal returns whole intervals. Include today's in-progress daily bucket,
    # as the CLI's `billing report --for today` does.
    return modal.Workspace.from_context().billing.report(start=start, end=today + timedelta(days=1))


def _check_cost(estimate: float, max_cost: float, daily_cap: float) -> None:
    if estimate > max_cost:
        raise SystemExit(f"Estimated cost ${estimate:.2f} exceeds --max-cost ${max_cost:.2f}.")
    today = _utc_today()
    try:
        spend = sum(float(row.cost) for row in _billing(today, today))
    except Exception as error:
        print(f"Warning: Modal billing unavailable ({type(error).__name__}); continuing.", file=sys.stderr)
        return
    if spend + estimate > daily_cap:
        raise SystemExit(f"Modal workspace spend today ${spend:.2f} + estimated ${estimate:.2f} "
                         f"exceeds GPU_BENCH_DAILY_CAP ${daily_cap:.2f}.")
    print(f"Modal workspace spend today ${spend:.2f} + estimated ${estimate:.2f} "
          f"within daily cap ${daily_cap:.2f}.")


def _record_usage(usage: list[dict], kind: str, result: dict, gpu: str) -> dict:
    seconds = result.get("seconds")
    row = {"kind": kind, "seconds": seconds, "status": result["status"],
           "estimatedCostUsd": _cost(kind, seconds, gpu) if seconds is not None else None}
    usage.append(row)
    return row


@contextmanager
def _tracked_app():
    usage: list[dict] = []
    app_id = None
    try:
        # An ephemeral app stops on disconnect and times out when the client's
        # heartbeats disappear, including when the Python process is killed.
        with modal.enable_output(), app.run(detach=False):
            app_id = app.app_id
            yield usage
    finally:
        if app_id:
            try:
                LEDGER.parent.mkdir(parents=True, exist_ok=True)
                with LEDGER.open("a") as ledger:
                    fcntl.flock(ledger, fcntl.LOCK_EX)
                    ledger.write(json.dumps({
                        "finishedAt": datetime.now(timezone.utc).isoformat(),
                        "appId": app_id,
                        "cpuSeconds": sum(row["seconds"] or 0 for row in usage if row["kind"] == "build"),
                        "gpuSeconds": sum(row["seconds"] or 0 for row in usage if row["kind"] != "build"),
                        "estimatedCostUsd": sum(row["estimatedCostUsd"] or 0 for row in usage),
                        "calls": usage,
                    }) + "\n")
            except OSError as error:
                print(f"Warning: couldn't write {LEDGER}: {error}", file=sys.stderr)


def _ledger_spend(start: datetime, today: datetime) -> tuple[float, float]:
    day_total = week_total = 0.0
    try:
        with LEDGER.open() as ledger:
            fcntl.flock(ledger, fcntl.LOCK_SH)
            for line in ledger:
                try:
                    row = json.loads(line)
                    finished = datetime.fromisoformat(row["finishedAt"])
                    cost = float(row["estimatedCostUsd"])
                    if finished.tzinfo is None:
                        continue
                except (KeyError, TypeError, ValueError):
                    continue
                if finished >= start:
                    week_total += cost
                if finished >= today:
                    day_total += cost
    except FileNotFoundError:
        pass
    return day_total, week_total


def _show_spend() -> None:
    today = _utc_today()
    start = today - timedelta(days=today.weekday())
    try:
        rows = _billing(start, today)
        day_total = sum(float(row.cost) for row in rows if row.interval_start.date() == today.date())
        week_total = sum(float(row.cost) for row in rows)
        source = "Modal workspace billing"
    except Exception as error:
        print(f"Warning: Modal billing unavailable ({type(error).__name__}).", file=sys.stderr)
        day_total, week_total = _ledger_spend(start, today)
        source = "estimated GPU bench spend from the local ledger"
    print(f"Today: ${day_total:.2f}\nThis week: ${week_total:.2f}\nSource: {source} (UTC)")


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


def _summary(result: dict) -> str:
    lines = [f"## {result['container']}", ""]
    host = result.get("host", {})
    lines.append(f"Host: {host.get('gpu')} (driver {host.get('driver')}), Vulkan devices: "
                 f"{', '.join(host.get('vulkanDevices', [])) or 'none'}")
    lines.append(f"{len(result['attempts'])} attempt(s), "
                 f"about ${result['estimatedCostUsd']:.3f} including retries.")
    if result.get("error"):
        lines += ["", f"**Error:** {result['error']}"]
    for run in result.get("runs", []):
        git = run.get("git") or {}
        versions = ", ".join(f"{b} {v}" for b, v in (run.get("browsers") or {}).items()) or f"Chromium {run.get('chromium')}"
        lines += ["", f"### {run['label']} ({git.get('ref') or git.get('worktree')}), "
                  f"{versions}, setup {run.get('setupSeconds')} s"]
        for mode, entry in run["modes"].items():
            g = entry["gate"]
            lines += ["", f"#### {mode.upper()}: gate {'passed' if g['ok'] else 'FAILED'} "
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


def _estimate_gpu_seconds(job: dict, source_count: int, attempts: int) -> int:
    # Filtered specs usually finish in a couple of minutes. Give an unfiltered
    # project 15 minutes. Each gate gets 30 s and an early Vulkan retry 10 s.
    specs = sum(".spec." in arg and not arg.startswith("-") for arg in job["args"])
    suite_seconds = min(job["timeout"], 120 * specs if specs else 900)
    suites = sum(
        len(job["modes"]) if browser == "chromium" else max(1, len(set(job["modes"]) - {"webgpu"}))
        for browser in job["browsers"]
    )
    return source_count * (30 + suites * (30 + suite_seconds)) + 10 * (attempts - 1)


def _run_containers(job: dict, sources: list[dict], usage: list[dict],
                    repeat: int, max_attempts: int, out: Path) -> list[dict]:
    gpu = job["gpu"]
    budget = len(sources) * (5 * 60 + len(job["browsers"]) * len(job["modes"]) * (job["timeout"] + 5 * 60))
    fn = bench.with_options(gpu=gpu, timeout=min(budget, 24 * 3600))
    calls = [fn.spawn(job, sources) for _ in range(repeat)]
    results = []
    for index, call in enumerate(calls, 1):
        container = f"c{index}"
        attempts: list[dict] = []
        for attempt in range(1, max_attempts + 1):
            try:
                result = call.get()
            except ModalError as error:
                result = {"status": "error", "error": str(error)}
            attempts.append(_record_usage(usage, "bench", result, gpu))
            if result["status"] != "no-vulkan" or attempt == max_attempts:
                break
            host = result["host"]
            print(f"{container}: NVIDIA Vulkan didn't load ({host['gpu']}, driver {host['driver']}); "
                  "trying another container.")
            call = fn.spawn(job, sources)
        dest = out / container
        dest.mkdir(parents=True, exist_ok=True)
        if packed := result.pop("tar", None):
            with tarfile.open(fileobj=io.BytesIO(packed), mode="r:gz") as tar:
                tar.extractall(dest, filter="data")
        result["container"] = container
        result["attempts"] = attempts
        result["estimatedCostUsd"] = sum(row["estimatedCostUsd"] or 0 for row in attempts)
        (dest / "result.json").write_text(json.dumps(result, indent=1) + "\n")
        results.append(result)
    return results


def _batch_summary(batch: dict) -> str:
    job = batch["job"]
    lines = [f"# GPU bench: {job['gpu']}", "",
             f"Estimated total at list prices ${batch['estimatedCostUsd']:.3f} "
             f"over {batch['wallSeconds']} s wall time.", "", "## Builds", ""]
    for build in batch["builds"]:
        lines.append(f"- {build['label']} (`{build['key'][:12]}`): {build['status']}, "
                     f"{build.get('seconds', 0)} s on CPU, about ${build['estimatedCostUsd']:.3f}.")
        if build.get("error"):
            lines.append(f"  {build['error']}")
    if batch["containers"]:
        lines += ["", "| Container | Result | GPU seconds incl. retries | Estimated GPU cost |",
                  "| --- | --- | ---: | ---: |"]
        for result in batch["containers"]:
            seconds = sum(attempt["seconds"] or 0 for attempt in result["attempts"])
            partial = " reported" if any(attempt["seconds"] is None for attempt in result["attempts"]) else ""
            lines.append(f"| {result['container']} | {result['status']} | {seconds:.2f}{partial} | "
                         f"${result['estimatedCostUsd']:.3f}{partial} |")
        lines += ["", *(_summary(result) for result in batch["containers"])]
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
    kits = parser.add_mutually_exclusive_group()
    kits.add_argument("--file", help="upload a converted kit folder for the bench (BENCH_FILE)")
    kits.add_argument("--kit", help="use an existing private volume kit by its 16-digit content hash")
    parser.add_argument("--env", action="append", default=[], help="KEY=VALUE for the bench (repeatable)")
    parser.add_argument("--profile", action="store_true", help="CPU profiles (BENCH_PROFILE)")
    parser.add_argument("--timeout", type=int, default=45,
                        help="minutes for each Playwright run (default 45); the container gets "
                             "enough for every run plus setup")
    parser.add_argument("--attempts", type=int, default=3,
                        help="containers to try when the NVIDIA Vulkan driver doesn't load (default 3)")
    parser.add_argument("--out", help="output folder (default tools/gpu-bench/runs/<time>)")
    parser.add_argument("--rebuild", action="store_true", help="rebuild every unique source on CPU")
    parser.add_argument("--repeat", type=int, default=1,
                        help="run the same set of checkouts in this many GPU containers in parallel")
    parser.add_argument("--max-cost", type=_money, default=5.0,
                        help="refuse jobs estimated above this many US dollars (default 5)")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--spend", action="store_true", help="print today's and this week's Modal spend")
    parser.add_argument("--chrome-flag", action="append", default=[],
                        help="an extra Chromium flag for GPU runs (repeatable)")
    actions.add_argument("--doctor", action="store_true",
                         help="only check the GPU stack (Vulkan, then the gate across Chromium, Firefox, WebKit)")
    # Keep pass-through options, including ones whose names match our flags.
    split = argv.index("--") if "--" in argv else len(argv)
    args, rest = parser.parse_known_args(argv[:split])
    rest += argv[split + 1:]
    if args.spend:
        _show_spend()
        return 0
    args.gpu = args.gpu.upper()
    if args.gpu not in PRICE_GPU:
        parser.error(f"--gpu takes one of {', '.join(PRICE_GPU)}")
    if min(args.repeat, args.attempts, args.timeout) < 1:
        parser.error("--repeat, --attempts and --timeout must be positive")
    try:
        daily_cap = _money(os.environ.get("GPU_BENCH_DAILY_CAP", "25"))
    except ValueError as error:
        parser.error(f"invalid GPU_BENCH_DAILY_CAP: {error}")
    if args.kit and not re.fullmatch(r"[a-f0-9]{16}", args.kit):
        parser.error("--kit takes a 16-digit lowercase hexadecimal content hash")
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
        seconds = min(900, 15 + 30 * len(flag_sets))
        estimate = _cost("doctor", seconds, args.gpu)
        print(f"Estimated cost ${estimate:.2f} (one {args.gpu} doctor container × {seconds} s).")
        _check_cost(estimate, args.max_cost, daily_cap)
        with _tracked_app() as usage:
            result = doctor.with_options(gpu=args.gpu).remote(flag_sets)
            _record_usage(usage, "doctor", {**result, "status": "ok"}, args.gpu)
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
        "kit": args.kit,
    }
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    out = Path(args.out or HERE / "runs" / stamp).resolve()
    unique = {}
    for source in sources:
        key = source["buildKey"] = _build_key(source["tar"])
        unique.setdefault(key, source)
        print(f"Packed {source['label']}: {len(source['tar']) / 1e6:.1f} MB (build {key[:12]}).")
    gpu_seconds = _estimate_gpu_seconds(job, len(sources), args.attempts)
    gpu_cost = _cost("bench", args.repeat * gpu_seconds, args.gpu)
    check_cache = not args.rebuild and gpu_cost <= args.max_cost
    cached = {key for key in unique if _cached_build(key)} if check_cache else set()
    misses = len(unique) - len(cached)
    estimate = (_cost("build", misses * BUILD_ESTIMATE_SECONDS, args.gpu)
                + gpu_cost)
    cache_info = f"{len(cached)} cached build(s)" if check_cache else "cache lookup skipped"
    print(f"Estimated cost ${estimate:.2f} ({misses} CPU build(s) × {BUILD_ESTIMATE_SECONDS} s, "
          f"{args.repeat} {args.gpu} container(s) × {gpu_seconds} s; {cache_info}).")
    _check_cost(estimate, args.max_cost, daily_cap)

    out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    builds = []
    containers = []
    with _tracked_app() as usage:
        for key, source in unique.items():
            if key in cached:
                print(f"Reusing build {key[:12]} for {source['label']}.")
                build = {"key": key, "label": source["label"], "status": "cached", "seconds": 0}
            else:
                print(f"Building {source['label']} on CPU (build {key[:12]}).")
                try:
                    build = build_source.remote(source, args.rebuild)
                except ModalError as error:
                    build = {"key": key, "label": source["label"], "status": "error", "error": str(error)}
                _record_usage(usage, "build", build, args.gpu)
            build["estimatedCostUsd"] = _cost("build", build.get("seconds") or 0, args.gpu)
            builds.append(build)
            if build["status"] == "error":
                break
        else:
            if args.file:
                job["kit"] = _upload_kit(Path(args.file).resolve())
            containers = _run_containers(job, sources, usage, args.repeat, args.attempts, out)

    failed = [f"{result['container']}/{run['label']} ({mode})"
              for result in containers for run in result.get("runs", [])
              for mode, entry in run["modes"].items() if entry.get("exitCode") not in (0, None)]
    ok = len(containers) == args.repeat and all(result["status"] == "ok" for result in containers)
    batch = {
        "status": "ok" if ok else "error",
        "wallSeconds": round(time.monotonic() - started),
        "job": {**job, "sources": [{k: v for k, v in source.items() if k != "tar"} for source in sources]},
        "builds": builds,
        "containers": containers,
        "estimatedCostUsd": sum(row["estimatedCostUsd"] or 0 for row in usage),
    }
    (out / "result.json").write_text(json.dumps(batch, indent=1) + "\n")
    summary = _batch_summary(batch)
    (out / "summary.md").write_text(summary)
    print(f"\n{summary}\nResults in {out}")
    if failed:
        print(f"Playwright failed for {', '.join(failed)}: see each one's bench.log.")
    return 0 if ok else 1


def _install_signal_handlers() -> None:
    interrupted = False

    def stop(signum, _frame):
        nonlocal interrupted
        if not interrupted:
            interrupted = True
            raise SystemExit(128 + signum)

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, stop)

    if os.environ.pop("GPU_BENCH_PARENT_FD", None) == "3":
        def watch_launcher():
            # The launcher owns the other end. EOF also covers SIGKILL.
            os.read(3, 1)
            os.kill(os.getpid(), signal.SIGTERM)

        threading.Thread(target=watch_launcher, daemon=True).start()


if __name__ == "__main__":
    _install_signal_handlers()
    sys.exit(main(sys.argv[1:]))
