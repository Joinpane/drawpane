# @drawpane/engine

Drawpane's render engine (docs/decisions/0040-render-engine.md): a retained render graph in Rust, patched by display lists from TypeScript, drawn by Vello on the GPU (WebGPU, through wgpu) in the browser and on the CPU in Workers. Phase 1 draws transforms, opacity and normal blending, clipping, solid and gradient fills, image fills in every scale mode, strokes (align, dashes, caps, joins, per-side widths), text from HarfBuzz's shaping and from saved glyph outlines, and corner radii. Everything else (effects, masks, other blend modes, glass, corner smoothing) is reported per layer, and a page holding any is drawn by the canvas renderer.

## What's here

- `rust/`: the crate.
  - `wire.rs`, `record.rs`: the display list's format, validated in full (docs/decisions/0040-display-list.md).
  - `store.rs`: the render graph: records by stable handle, transactional revisions, bounds, paint order and invalidation (backdrop readers, transitively).
  - `exec.rs`: draws the graph on a backend; `cpu.rs` (vello_cpu, bands and tiles) and `gpu.rs` (vello_gpu on WebGPU, read back through a buffer for tests).
  - `masks.rs`, `glyphs.rs`: interned glyph outlines and the glyph coverage cache (both backends, rasterised by vello_cpu).
  - `images.rs`, `png.rs`, `kernels.rs` (the reference reader the tests use), `limits.rs`, `lib.rs` (the WebAssembly boundary: typed results, no panics).
  - `tests/fuzz.rs`: patched equals fresh, dirty regions hold every change, tiles equal the whole frame, transactions, limits, random bytes.
- `src/`: TypeScript: `wire.ts` (the format, written), `index.ts` (typed results around the modules), `compare.ts` (decision 0040's parity scores), `node.ts` (the modules in Node), `glue.d.ts` (the types of wasm-bindgen's glue, so the repo typechecks without building Rust).
- `scripts/build.mjs`: builds both modules into `dist/` and holds them to their size budgets.

`dist/` and `rust/target/` are build output, never committed. The Worker build's test in workerd, beside the agent runner's set, is `tools/engine-workerd` (`pnpm --filter @drawpane/engine-workerd test:workerd`).

## Building and testing

The toolchain is this folder's `mise.toml` (Rust 1.99.1 with the wasm32 target, rustfmt and clippy, wasm-bindgen 0.2.130). Run `mise install` here once.

```sh
pnpm --filter @drawpane/engine build        # dist/worker (CPU) and dist/browser (GPU and CPU)
pnpm --filter @drawpane/engine test         # the modules in Node
pnpm --filter @drawpane/engine test:rust    # cargo test (property and fuzz tests)
pnpm --filter @drawpane/engine fuzz         # wider fuzzing (FUZZ_RUNS, FUZZ_SEED=random)
pnpm --filter @drawpane/engine-workerd test:workerd # the Worker build in workerd, under the caps
```

`ENGINE_ONLY=worker` builds one module while iterating; `ENGINE_SKIP_BUILD=1` keeps what `dist/` holds (CI builds once and hands the modules to the other jobs).

## In the editor

Behind a switch: `?renderer=engine` in the URL, or `localStorage["drawpane:renderer"] = "engine"` (`engine-compat` for WebGPU's compatibility feature level). `localStorage["drawpane:engine-present"] = "readback"` reads frames back through a buffer instead of presenting the WebGPU canvas, for headless browsers, where presenting loses the device. A page the engine can't draw, a lost device or a browser without WebGPU falls back to the canvas renderer, with a console note and a `drawpane:renderer-fallback` event.
