# Render engine spike (design, not for production)

The spike behind decision 0040 (`docs/decisions/0040-render-engine.md`). It shows that one Rust engine, compiled to WebAssembly, can draw a glass-heavy board of a real kit in two places:

- on the GPU through WebGPU in the browser (`vello_gpu` on wgpu);
- on the CPU inside workerd (`vello_cpu`), under the Worker's memory caps with HarfBuzz loaded beside it.

It measures how far apart the two renders are, and how far each is from Figma's. No product code uses it, and no switch turns it on.

## What's here

- `engine/`: the crate.
  - `dl.rs`: the display list's wire format.
  - `exec.rs`: the executor, generic over Vello's two scene types, and the blend kernel.
  - `cpu.rs`, `gpu.rs`: the backends.
  - `glass.rs`, `kernels.wgsl`: the kernels, in Rust and in WGSL.
  - `lib.rs`: the wasm-bindgen API.
- `src/`: TypeScript.
  - `encode.ts`: the wire format.
  - `board.ts`: a board of a converted file as a display list, using the editor's scene, saved glyphs, glass parameters, shadow casts, fitted dashes and per-side strokes.
  - `kit.ts`: the input.
  - `compare.ts`: kit parity's score.
- `worker/`: a Worker with the CPU build and HarfBuzz, both memory-capped as the agent runner caps its own. Local only (`wrangler dev`); never deployed.
- `page/`, `e2e/browser.spec.ts`: the GPU build in a page, driven by Playwright.
- `scripts/`:
  - `build-wasm.sh`: builds both modules into `dist/`.
  - `cap-wasm.mjs`: writes the capped Worker modules into `wasm/`.
  - `measure-worker.mjs`: the workerd measurement.

`dist/`, `wasm/`, `target/` and `out/` are build output and never committed.

## Running it

The toolchain is this folder's `mise.toml`: Rust 1.99.1 with the `wasm32-unknown-unknown` target, and `wasm-bindgen-cli` at the version the crate pins. Nothing is installed globally. Run `mise install` here once.

The input is a kit converted by kit-parity's `drawpane` step: a folder with `nodes.ndjson`, the same thing `BENCH_FILE` names. It's private; nothing from it is committed.

```sh
cd tools/render-engine-spike
mise install
pnpm build:wasm                      # dist/cpu and dist/gpu
node scripts/cap-wasm.mjs            # wasm/, for the Worker

export SPIKE_FILE=/path/to/kit-parity-out/drawpane-cache/<key>
export SPIKE_BOARD=7:53847           # the board's Figma id (this is the default)
# Figma's render of it, if not in kit-parity's figma/ folder beside the cache:
# export SPIKE_REFERENCE=/path/to/figma/7-53847.png
# The canvas renderer's render of it, from a kit-parity run, to compare with:
# export SPIKE_CANVAS=/path/to/runs/<run>/drawpane/7-53847.png

node scripts/measure-worker.mjs      # out/worker.json, out/cpu.png (wrangler dev on SPIKE_WORKER_PORT, 8869)
pnpm measure                         # out/browser.json, out/gpu.png, heat maps (Playwright)
```

Run the Worker measurement first. The browser spec then scores the GPU render against the Worker's pixels (`out/cpu.rgba`); without them it uses the page's own CPU render, which is identical.

### On a GPU machine

The browser spec takes everything from the environment, so a GPU bench can run it as is:

- `SPIKE_FILE` and `SPIKE_BOARD`: the input.
- `SPIKE_OUT`: where results go.
- `CHROMIUM_PATH`: the browser.
- `SPIKE_CHROME_ARGS`: extra flags (`--enable-unsafe-webgpu` is always passed).
- `SPIKE_RUNS`: frames timed, after a first one that's reported apart.

`browser.json` records the adapter as the page sees it (`navigator.gpu.requestAdapter().info`, including `isFallbackAdapter`) and labels its timings "software adapter, not representative" on SwiftShader, llvmpipe or any fallback adapter.

### Finding faults

`SPIKE_OMIT` (comma-separated) leaves features out of the display list:

- `glass`, `inner-shadow`, `drop-shadow`: the effect;
- `linear`: kernel blends by linear dodge and burn, drawn normally;
- `apart`: every kernel blend, drawn normally.

`SPIKE_VELLO_SRC_OVER=0` makes the GPU path lay each segment on with the source-over kernel instead of vello_gpu's own.

## What it cuts

- **Glass** handles boxes only. It takes the rim's direction from the box's exact distance and reads without mipmaps.
- **Shadows and layer blur** use Vello's blur, which is approximate (the decision explains).
- **Not drawn:** gradients, images, masks, background blur, vectors and noise. `board.ts` counts what it skips in `unsupported`.
- **Nothing is retained between frames:** the display list is rebuilt and decoded each time.

The measurements don't cut corners. The results and what they mean are in the decision.
