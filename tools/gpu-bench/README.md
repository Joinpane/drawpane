# GPU bench

Runs apps/web's Playwright benchmark, parity, and e2e suites (`apps/web/e2e/**/*.spec.ts`)
across Chromium, Firefox, and WebKit on a real NVIDIA GPU on [Modal](https://modal.com), from
any machine, in one command. Canvas, WebGL2, and WebGPU timings from a machine without
a GPU (like the development VM) say little about a designer's laptop. These do.

```sh
# This worktree as it is on disk, the canvas bench, on a T4:
pnpm gpu-bench -- bench/canvas.spec.ts

# All three browsers (Chromium, Firefox, WebKit) in one T4 container:
pnpm gpu-bench --browsers chromium,firefox,webkit --env BENCH_RENDERER=engine -- bench/canvas.spec.ts

# Cross-browser render engine parity on a real T4:
pnpm gpu-bench --browsers chromium,firefox,webkit --env ENGINE_PARITY_BACKENDS=auto -- parity/engine.spec.ts

# A baseline and a change, back to back in the same container:
pnpm gpu-bench --ref origin/main --ref HEAD -- bench/canvas.spec.ts

# A real file, with Chromium's GPU disabled too for comparison:
pnpm gpu-bench --file <converted kit folder> --modes gpu,cpu -- bench/file.spec.ts

# Real input on the iOS kit's Examples page, using the private volume:
pnpm gpu-bench --kit 2ddaf31f5bb47444 --modes gpu -- bench/real-input.spec.ts
```

Results land in `tools/gpu-bench/runs/<time>/` (ignored by git): `summary.md`,
`result.json`, and per checkout and mode the gate's findings, the Playwright
log and JSON report, `bench.json` (each test's `bench` annotation), CPU
profiles with `--profile`, and Playwright's traces of failed tests.

## Setup

- A Python with the Modal client (`pip install modal`, 1.6 or later). The
  launcher uses `$MODAL_PYTHON`, else `~/.venvs/modal/bin/python`, else
  `python3`.
- Modal credentials: `modal token set`, or `MODAL_TOKEN_ID` and
  `MODAL_TOKEN_SECRET` in the environment (for example through a secret
  manager that runs the command with them set). Never commit them.
- Nothing to build locally: the container installs the checkout's
  dependencies and builds apps/web itself, so a run is the same from any
  machine (this VM is arm64, Modal's GPUs are x86-64).

## Options

| Option | |
| --- | --- |
| `--ref <commit>` | Run this commit (`git archive`). Repeatable; runs in order, in one container, on one GPU. |
| `--worktree <path>` | Run this worktree as it is on disk: tracked files and untracked files git doesn't ignore. Repeatable. The default when neither is given is the current worktree. |
| `--gpu T4\|L4` | Modal GPU type, default T4. |
| `--browsers <list>` | Comma-separated: `chromium` (default), `firefox`, `webkit`. |
| `--project <name>` | Playwright project override; by default auto-picks `bench`/`bench-firefox`/`bench-webkit` for `bench/` specs and `chromium`/`firefox`/`webkit` for parity and e2e specs. |
| `--modes <list>` | Comma-separated, run in order in the same container: `gpu` (default: the 2D canvas, WebGL and compositing on the GPU), `webgpu` (core WebGPU on the GPU, compositing in software), `cpu` (GPU disabled). See *Modes*. |
| `--chrome-flag <flag>` | An extra Chromium flag for the `gpu` and `webgpu` runs (repeatable). |
| `--file <folder>` | A kit folder from `tools/kit-parity`'s convert step, for `bench/file.spec.ts` (`BENCH_FILE`). See *Private data*. |
| `--kit <hash>` | Reuse a converted kit already in the private volume by its 16-digit content hash. Sets `BENCH_FILE` just like `--file`. |
| `--env KEY=VALUE` | Passed to the bench, e.g. `BENCH_PAGES`, `BENCH_FRAMES`, `BENCH_PAGE_COUNT`. |
| `--profile` | CPU profiles of each measurement (`BENCH_PROFILE`). |
| `--timeout <min>` | Per Playwright run, default 45. The container's own timeout is that per run plus room for builds. |
| `--attempts <n>` | Containers to try when the NVIDIA Vulkan driver doesn't load (default 3). |
| `--out <dir>` | Output folder. |
| `--doctor` | Only check the GPU stack on a small container: Vulkan, then the gate for the `gpu` and `webgpu` modes. No checkout is built. |

Anything else, or everything after `--`, goes to `playwright test
--project=bench` (default `bench/`; `file.spec.ts` skips itself without a
kit).

## What runs where

`gpu_bench.py` is both the local runner and the Modal app. Locally it packs
each checkout (about 13 MB compressed), uploads the kit if one is named, and calls the
`bench` function once with every checkout. The function runs on a
single-use container (4 cores, 12 GiB, the chosen GPU) whose image has:

- Ubuntu 24.04, Node and pnpm at the repo's versions (`mise.toml`,
  `packageManager`; a checkout pinning others gets them installed at run
  time);
- the Chromium, Firefox, and WebKit builds that `@playwright/test` pins, with
  their system dependencies (while keeping GLVND `libglvnd0`, `libgl1`, `libglx0`,
  `libegl1` intact), plus `xvfb`, `mesa-utils`, and `openssl`;
- the Vulkan loader and `vulkaninfo`.

For each checkout it runs `pnpm install --frozen-lockfile` and `pnpm
--filter @drawpane/web build`, then for each mode the gate and `playwright
test --project=bench`, with `CHROMIUM_PATH` pointing at a wrapper that adds
the mode's flags. The tarball of `/out` comes back as the function's result.

### The NVIDIA driver and Vulkan

Modal runs containers in gVisor, and it mounts the host's own NVIDIA
user-space libraries into every GPU container (`libGLX_nvidia`,
`libnvidia-glcore`, and `/etc/vulkan/icd.d/nvidia_icd.json`), so they
always match the host's kernel driver. Nothing NVIDIA is installed or pinned
in the image: a `libnvidia-gl-*` package there could only mismatch. In
November 2026 T4 hosts ran drivers 610.57.04 and 620.70.06; both work.

The trap is elsewhere: the NVIDIA Vulkan driver loads GLVND
(`libGLdispatch`, `libGLX`) at run time, and without it in the image it
answers no `vkCreateInstance`. The loader then reports "Found no drivers",
`vulkaninfo` lists only llvmpipe, and Chromium silently falls back to
SwiftShader. The image installs `libglvnd0`, `libgl1`, `libglx0` and
`libegl1` for that.

Every run still starts with `vulkaninfo`, limited to the NVIDIA ICD
(`VK_DRIVER_FILES`: Mesa's software lavapipe is installed alongside and must
not be picked). If the NVIDIA driver doesn't load, the container stops
before building anything and the runner tries a new container, up to
`--attempts` times. `vulkaninfo.txt` in the output keeps what it said.
`pnpm gpu-bench --doctor` checks this and the gate on one small container.

### Modes

What headless Chromium 158 can do on this setup (found with `--doctor`, which
writes chrome://gpu and Chromium's log for each try):

- Chromium's own Vulkan (feature `Vulkan`) can't composite: in headless mode
  its compositor wants `VK_EXT_headless_surface`, which the NVIDIA driver
  doesn't offer. With `VulkanFromANGLE` the GPU process crashes on start
  (a null function pointer, three times, then no WebGL); without it, or with
  `--disable-vulkan-surface`, compositing falls back to software.
- GL through ANGLE on Vulkan works: the 2D canvas, WebGL and compositing are
  all hardware accelerated on the NVIDIA GPU. But then Chromium offers core
  WebGPU only SwiftShader, though Dawn sees the T4: an NVIDIA adapter comes
  only in compatibility mode, on Dawn's OpenGL ES backend over ANGLE
  (`--use-webgpu-adapter=opengles`).
- Core WebGPU on Dawn's Vulkan backend needs Chromium's Vulkan, and so
  software compositing.
- Xvfb with a windowed Chromium doesn't help: the NVIDIA driver can't make a
  swapchain on Xvfb (no DRI3).
- In both GPU setups a WebGPU device renders (read back through a buffer),
  but a WebGPU canvas copied into a 2D canvas comes back empty.

So there are two GPU modes:

| Mode | 2D canvas, WebGL | Compositing | WebGPU | Flags beyond the common ones |
| --- | --- | --- | --- | --- |
| `gpu` | NVIDIA (ANGLE, Vulkan) | NVIDIA | NVIDIA in compatibility mode; core gets SwiftShader | `--use-webgpu-adapter=opengles` |
| `webgpu` | NVIDIA (ANGLE, Vulkan) | software | NVIDIA, core | `--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan --disable-vulkan-surface` |
| `cpu` | SwiftShader | software | none | `--disable-gpu` only |

`gpu` is what the canvas renderer benchmarks want: frame intervals include
compositing, so it must be on the GPU. `webgpu` is for timing WebGPU work
itself (compute and render passes); don't read its frame intervals as a
laptop's. The common flags are `--use-angle=vulkan --enable-unsafe-webgpu
--ignore-gpu-blocklist --disable-gpu-sandbox
--enable-dawn-features=allow_unsafe_apis,disable_adapter_blocklist`;
Playwright adds `--headless` (the new headless mode in Chrome for Testing).
The wrapper merges every `--enable-features` and `--disable-features` with
Playwright's own and writes Chromium's stderr to `chrome.log`.

### Firefox and WebKit on Modal

- **Firefox** disables WebGPU and WebGL2 in `--headless` mode on Linux, so
  `gpu_bench.py` runs Firefox under Xvfb (`DISPLAY=:99`, `GPU_BENCH_XVFB=1`,
  `headless: false`) with `dom.webgpu.enabled=true` and
  `gfx.webgpu.ignore-blocklist=true`. In that mode Firefox's `wgpu` WebGPU
  stack opens the real NVIDIA T4 over Vulkan (`maxTextureDimension2D: 32767`)
  and presents WebGPU canvases directly, while Xvfb GLX WebGL2 falls back to
  llvmpipe.
- **WebKit** (Playwright's Linux MiniBrowser) has no WebGPU, so the engine
  selects WebGL2. With `__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json`
  and `WEBKIT_DISABLE_DMABUF_RENDERER=1`, WebKit opens WebGL2 on the NVIDIA T4
  via Surfaceless EGL (`maxTextureSize: 32768`; WebKit masks
  `UNMASKED_RENDERER_WEBGL` to `"Apple GPU"`). Because Linux WebKit rejects
  `Secure` (`__Host-`) cookies over `http://localhost`, `apps/web/e2e/fresh-instance.ts`
  automatically fronts the local Worker with an ephemeral self-signed HTTPS
  proxy (`ignoreHTTPSErrors: true`) and installs a pure-WebCrypto P-256 virtual
  passkey authenticator for Firefox and WebKit.

### The gate

`gate.mjs` runs before each mode's bench, with the same Chromium, wrapper and
flags, on a page served from `127.0.0.1` (WebGPU needs a secure context). It
prints and saves (`gate.json`, `chrome-gpu.txt`, `gate.png`):

- the adapters `navigator.gpu.requestAdapter()` gives, core and compatibility
  mode, with their `info` (vendor, architecture, fallback or not), and
  whether each device renders (a texture cleared and read back through a
  buffer) and presents (a WebGPU canvas copied into a 2D canvas);
- WebGL2's `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL`: the GPU that
  also rasterizes the 2D canvas;
- chrome://gpu's feature status (Canvas, Rasterization, Compositing, WebGL,
  WebGPU), with the whole page kept as text;
- read-backs of a 2D canvas and a WebGL clear.

The run aborts unless:

- `gpu`:
  - **Chromium:** WebGL renderer is NVIDIA (not software), Canvas/Rasterization/Compositing/WebGL are "Hardware accelerated", 2D/WebGL readbacks and onscreen WebGL screenshot presentation succeed, and a non-fallback NVIDIA WebGPU adapter renders;
  - **Firefox:** 2D readback passes and either non-fallback hardware WebGPU renders + presents onscreen (verified via `#cgpu` screenshot) or non-software WebGL2 presents onscreen;
  - **WebKit:** 2D readback and non-software WebGL2 readback + onscreen `#cgl` screenshot presentation succeed with hardware texture limits;
- `webgpu`: Chromium core WebGPU runs on a working NVIDIA adapter (compositing may be software);
- `cpu`: GPU ICDs are forced to Mesa software (`llvmpipe` / `lavapipe`), and the gate fails if any hardware GPU renderer or non-fallback WebGPU adapter is still exposed.

In addition, `bench/canvas.spec.ts` and `bench/interactions.spec.ts` verify in-app DOM renderer state (`data-renderer`, `data-renderer-software`, `data-renderer-presented`, presented frame delta, zero fallback frames) and non-blank composited `.canvas` screenshots whenever `BENCH_RENDERER=engine`.

## Private data

`--file` uploads the folder to the Modal Volume `drawpane-gpu-bench-data`
in the account's workspace (private to it), under `/kits/<content hash>/`,
once. Later runs with the same content skip the upload, and `--kit <hash>`
can use it without a local copy. The container mounts the Volume and points
`BENCH_FILE` at it. Kit content never goes into an
image or this repository. Large licensed kits (such as a large iOS UI kit)
stay on the Volume only; remove one with
`modal volume rm -r drawpane-gpu-bench-data /kits/<hash>`.

## Cost

Modal bills per second while the container runs (list prices, November
2026): T4 $0.000164/s, L4 $0.000222/s, plus $0.0000131 per core and
$0.00000222 per GiB each second. With 4 cores and 12 GiB a T4 container
costs about $0.86 an hour, an L4 about $1.07. The summary gives each run's
container time and estimated cost. Containers are single-use, nothing is
kept warm, and every Playwright run and the container itself have a timeout.

Measured on a T4 in November 2026 (the image cached; building it the first
time takes about 3 minutes more):

| Run | Container time | Wall time | Cost |
| --- | --- | --- | --- |
| `bench/canvas.spec.ts`, modes `gpu,cpu` | 142 s | 153 s | $0.035 |
| canvas and `file.spec.ts` with a large iOS UI kit, modes `gpu,cpu` | 443 s | 465 s (with the kit's first upload) | $0.11 |
| canvas, two commits, modes `gpu,webgpu` | 279 s | 319 s | $0.07 |

Installing dependencies and building apps/web takes 5 to 15 s per checkout.

T4 is the default: a Turing part with roughly a laptop GPU's 2D throughput,
and the cheapest. L4 (Ada) is closer to a recent laptop's; compare a
baseline and a change on the same type.

## Camera fidelity replay

Set `BENCH_W4_REPLAY=1` with the real-file engine bench to capture motion
pixels in a second, untimed run of each gesture. The harness captures each
requested camera after its presentation, and waits for that readback before
advancing the gesture. It re-renders each selected camera at the original DPR in exact
mode. The final pair measures the change between motion and exact rendering
at the stopping camera. The report includes tile content errors, sharpness,
LDR FLIP, and sharpness changes for adjacent captured steps. The thresholds
are provisional until calibrated on a laptop.

Set `BENCH_W4_REPLAY_PPD` to the target display's pixels per degree, such as
80 for a 2× laptop at typical viewing distance. Modal installs the evaluator
only for replay runs. To run locally, set `BENCH_W4_REPLAY_PYTHON` to a Python
environment with `numpy`, `scikit-image`, and NVIDIA's `flip-evaluator`.
Capture pixels stay in temporary storage until scoring completes. Cadence
still comes from the earlier gesture with no pixel readback.
