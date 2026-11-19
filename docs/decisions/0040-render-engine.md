# 0040. A render engine in Rust on Vello: the GPU in the browser, the same code on the CPU in Workers

- Status: proposed (design, with a spike; nothing ships)
- Date: 2026-11-18
- Deciders: Ziyang (lead maintainer)

## Context

Editing a large iOS UI kit is "not usable at all", while Figma's performance on the same file is near perfect. The difference is architectural, not a missing optimisation.

**How Drawpane draws today:**

- **The editor draws with the browser's 2D canvas.** Each redraw re-issues every visible layer's draw calls from JavaScript (`packages/editor/src/render.ts`). Nothing drawn survives past the pixels of the last frame.
- **Effects use canvas filters and scratch canvases.** Linear dodge and burn are built from several composite operations (decision 0038). Glass and background blur copy pixels into a WebGL2 shader and back on every draw (decisions 0007 and 0039).
- **Tiling, budgets and stand-ins hide some of the cost** (decision 0028 and its revision). On the kit's page of 17,922 layers and 921 readers, the exact frame still takes 28 s to arrive on this VM.
- **Headless renders are a second implementation.** Agent images and the Worker's renders (decisions 0023 and 0033) are the SVG export rasterised by resvg:
  - resvg is 949 KB gzipped and capped at 25 MiB of memory, inside a 128 MB isolate.
  - It can't see behind a layer, so it can't draw glass or background blur, and it differs from the canvas in many smaller ways (the headless parity suite).
  - It holds every font file whole: a single Noto Sans SC weight is 10.1 MiB of its 25 MiB.

**How Figma draws.** Figma's renderer is its own C++ engine, compiled to WebAssembly for the browser and to native code for server-side renders and tests. It draws on the GPU, first through WebGL and since 2025 through WebGPU (via Dawn and emdawnwebgpu), with a fallback to WebGL mid-session ("Figma rendering: Powered by WebGPU", 2025-09-18, figma.com/blog). One engine draws the screen and the server's images, so they agree by construction, and its GPU state persists between frames.

This record decides what replaces the 2D canvas renderer and resvg:

- a native engine compiled to WebAssembly;
- that draws on the GPU through WebGPU in the browser;
- whose same code renders on the CPU in a Worker;
- that keeps every Figma rule the current renderer has learned (decisions 0007, 0013, 0016, 0028, 0031, 0037, 0038 and 0039).

A spike in `tools/render-engine-spike` proves the riskiest parts on one glass-heavy board of the kit. It is described, with its measurements, at the end.

## Decision

1. **An engine in Rust, compiled to WebAssembly, drawing with Vello's sparse-strip renderers.**
   - `vello_gpu` draws on WebGPU through wgpu in the browser. It has a WebGL2 backend for browsers without WebGPU.
   - `vello_cpu` draws on the CPU in Workers.
   - The two share `vello_common`: path flattening, stroking, tiling into strips, and coverage (anti-aliasing). So their edges agree by construction.
2. **The engine owns compositing.** Every rule where Figma differs from a textbook renderer is a kernel the engine owns: every non-normal blend, glass, blurs, shadows, masks and backdrop reads.
   - Each kernel is written twice, in Rust for the CPU and in WGSL for the GPU.
   - A conformance suite holds the two pixel to pixel.
   - Vello only fills, strokes, clips and composites source-over.
3. **TypeScript keeps the document, layout and every rule about *what* is drawn.** The engine receives a retained display list, patched by layer as the document changes, and draws it.
4. **Migration in phases behind a switch, with parity as the gate.** The 2D canvas renderer stays the fallback until the engine is at least as close to Figma on every parity suite and every kit frame.

The user suggested C++. This recommends Rust, for the reasons under "Language and libraries".

## The boundary

The document model, editing, layout, hit testing, the spatial index and the overlay stay in TypeScript. The engine is a renderer: it never sees `NodeRecord`s.

### The display list

A list of **layer records**, each keyed by the layer's id (interned to a 32-bit handle), in paint order, with parent links. A record holds what the engine needs to draw that layer, already resolved by TypeScript:

- **Its transform to page units,** from `Scene.worldMatrix`.
- **Its geometry, as paths in its own units:** rectangles with radii, ellipses, vectors, and text as glyph outlines.
  - **Text outlines** come from the HarfBuzz shaper, or from the saved layout (`savedGlyphGroups`, decision 0037). A glyph is an interned path referenced by id, so a font's glyphs are sent once.
  - **Per-side strokes and fitted dashes** are resolved into geometry by TypeScript (`strokeRegion`, `fitDashes`), so the engine doesn't learn those rules twice.
  - **Corner smoothing** (squircles) is geometry too: the path generator lives in one place, Rust, so the CPU and GPU draw the same curve.
- **Paints:** solid; linear, radial and angular gradients in the layer's unit square; images by content hash with their scale mode and crop; each with opacity and blend mode.
- **Stroke styles:** width, align, join, cap and miter. Align is done by clipping, as today.
- **Effects, as parameters, not pixels:**
  - drop and inner shadows (with spread, blend, and the cut-out from `dropShadowCast`);
  - layer and background blur, and progressive blur;
  - glass, with `glassParams` already applied;
  - noise and texture.
- **Grouping:**
  - opacity, and whether the layer fades as one (`fadesAsOne`) or blends as one (`blendsAsOne`);
  - clip content;
  - mask role and type, with the scope already resolved by `maskScopes` (decision 0016's amendment);
  - visibility.
- **Its extent,** from `Scene.extent`: the cull box and the invalidation box.

**Edits.** The scene already knows, per document change, which layers changed and where they painted before (`Scene.dirtySince`, decision 0028). The same information becomes the engine's diff:

- a record replaced;
- a record removed;
- children reordered;
- or only a transform changed (the cheap case: a drag).

A frame message carries the camera (zoom, pan, device pixel ratio) and the viewport, and nothing else. Pan and zoom never resend records.

The wire format is little-endian 32-bit words, as in the spike (`engine/src/dl.rs`, `src/encode.ts`): a list built in one `ArrayBuffer` and passed to WebAssembly memory in one copy, with no JSON and no per-object calls. The spike sends the whole board each time (116 KB for 290 layers); the engine proper sends records once and patches them.

**Selection, hover, guides and handles stay out of the engine.** The overlay (`overlay.ts`: handles, guides, the marquee, size pills, the caret) stays a 2D canvas or DOM layered on the engine's canvas. It redraws only on interaction, is cheap, and its text uses the browser's fonts. Hover and selection change nothing in the display list. Layers whose drawing does depend on the editor's state are flagged in their record and patched like any edit:
- text being edited, drawn from its live layout rather than saved outlines;
- layers hidden while being dragged into place.

### What crosses, and how often

| Event | TypeScript sends | The engine does |
| --- | --- | --- |
| Open a page | Every record on it, once | Builds its tree and caches nothing yet |
| Pan | Camera | Composites cached surfaces; draws what's newly uncovered |
| Zoom | Camera | Composites cached surfaces scaled (a stand-in); re-rasterises at the new zoom bucket progressively |
| Drag | The dragged layers' transforms | Moves their cached surface; redraws readers whose backdrop changed |
| Edit | Changed records | Invalidates their surfaces and anything reading through them |
| Hover, select | Nothing | Nothing (the overlay redraws) |

## Retained GPU state

The engine keeps work between frames. A change of camera moves cached pixels and re-rasterises only what can't be reused, as Figma does.

- **Surfaces.** A surface is a GPU texture holding a subtree drawn at a zoom bucket (zoom rounded up to a power of two):
  - every top-level board;
  - every layer that is expensive to draw (glass, background or layer blur, a shadow larger than a few pixels, a mask group);
  - and, while dragging, the dragged selection.
- **Composition.** A frame composites surfaces under the camera. Within a bucket, pan and zoom are a textured quad per surface. Across buckets, the old surface stands in, scaled, while the new one is drawn within the frame budget, centre first, so the never-wrong-for-long rule of decision 0028 carries over.
- **Large surfaces are tiled** (512 × 512 device pixels), so a board 20,000 pixels tall at high zoom keeps only the tiles on screen and near it.
- **Invalidation.** A record change invalidates the surfaces holding it and the tiles its old and new extents touch.
- **Readers.** Glass and background blur read the backdrop. A reader's surface is invalid when anything beneath it, within its reach, changes. The dependency is the same one `#withReaders` computes today, kept as a list per reader instead of recomputed per strip.
- **Drags.**
  - The dragged layers are drawn once into their own surface and moved.
  - The board is redrawn once without them.
  - Readers the drag passes under are redrawn per frame. A drag over glass costs one glass draw per frame, not a strip regrown to everything the glass reads.
- **GPU memory budget.** A budget the engine holds itself, since WebGPU exposes no free-memory query: 256 MiB by default on desktop, 128 MiB on mobile, configurable. Surfaces are kept least recently used first. Off-screen surfaces are evicted before on-screen tiles at a coarser bucket. A tile that doesn't fit is drawn directly into the frame without being cached (correct, just slower).
- **Level of detail when zoomed out:**
  - the surfaces of the coarser buckets form a mip pyramid, so a whole page at fit zoom composites from boards drawn at 1/8 scale;
  - text below 4 device pixels is drawn as bars and layers below half a device pixel are skipped (today's rules, `render.ts`);
  - glass and blurs at a coarse bucket are drawn at that bucket's resolution, which is what they look like there anyway.

## Every feature, as GPU passes

"Kernel" means a pass the engine owns, written in WGSL for the GPU and in Rust for the CPU, over pixels already drawn. "Vello" means `vello_gpu`/`vello_cpu` drawing calls, the same code for both.

| Feature | How it's drawn |
| --- | --- |
| Solid fill | Vello fill, nonzero or even-odd |
| Linear, radial, angular gradients | Vello gradient paint with the layer's unit-square transform as its paint transform (decision 0013); angular is Vello's sweep gradient. Diamond comes in as radial today and stays so. |
| Images (fill, fit, stretch, crop, tile) | Vello image paint with a transform per scale mode (the same arithmetic as `images.ts`); tile uses `Extend::Repeat`. Images are uploaded once per content hash, with mipmaps, under the GPU budget. |
| Strokes: align | Center is a Vello stroke. Inside and outside clip a double-width stroke to the shape or its outside, as today. |
| Strokes: dashes, caps, joins, miter | kurbo's stroker (in `vello_common`) with the dash pattern each segment gets from `fitDashes`; caps and joins as the record says; miter limit 10, the canvas's default |
| Per-side stroke widths | An even-odd region from `strokeRegion`, filled |
| Text, shaped | HarfBuzz (TypeScript side, as now) gives glyph ids and positions; outlines are interned paths, filled by Vello. Glyphs are cached per font and size bucket as coverage masks in an atlas (Vello's glyph cache), reused across frames. |
| Text, saved outlines (0037) | The same, from `glyphLayout`, baselines on whole pixels (`drawnBaseline`) |
| Decorations | Bars, filled |
| Clipping (clip content) | Vello clip *paths*, not clip layers: a clip path doesn't isolate, so a blend or kernel inside it still sees the page (the spike relies on this) |
| Opacity, fading as one | Vello opacity layer (isolates, as `fadesAsOne` requires) |
| Normal blend | Vello source-over |
| Every other blend (separable, non-separable, linear dodge and burn) | Kernel. The layer (or the paint) is drawn apart over its bounds, then composited over what's beneath by Figma's formula: W3C's for the standard modes; for linear dodge `c = min(a, cs + cb)` and linear burn `c = max(0, cs + cb − as·ab)` with normal alpha (decision 0038). One kernel replaces `BlendApart`'s chain of canvas operations. |
| Pass-through frames, faded frames holding blends | A blend kernel reads the page, so a frame that doesn't isolate passes blending through by construction. A faded frame holding a blend draws over a copy of what's under it and fades over it, as today (0038). |
| Masks: alpha, luminance, outline-of-a-picture | Kernel: the masked layers drawn apart over the mask's reach, the mask drawn apart, then `destination-in` by alpha, by Rec. 709 luminance × alpha, or by alpha × 255. Scope from `maskScopes` (0016's amendment). `vello_cpu` has mask layers; `vello_gpu` panics on them today, so the kernel is the path on both. |
| Masks: outline of one filled shape | Vello clip path |
| Drop shadow | Kernel: the shape (grown by spread; exact for boxes and ellipses) drawn apart, blurred by an exact Gaussian of σ = blur ÷ 2, offset, cut out under the shape where `dropShadowCast` says, then composited by its own blend mode or the layer's (0031, 0038). For boxes, Vello's analytic blurred rounded rectangle (`fill_blurred_rounded_rect`) gives the same shadow in one pass. |
| Inner shadow | Kernel: the ring (a large rectangle minus the shape shrunk by spread) drawn apart, blurred, offset, clipped to the shape, then blended (0038) |
| Layer blur | Kernel: an exact separable Gaussian, σ = radius ÷ 2 (decision 0013), with downsampling only where the error stays below a level. Vello's own blur is an approximation by repeated decimation that also clips at 3σ, which the spike shows as visible box edges on the kit's 13 px shadows. |
| Background blur | Kernel: the backdrop within the layer's reach (repeated at the canvas's edge, stopped at clipping frames, `#clipWithin`), blurred, cut to the shape (to the glyphs under text, skipped under a fill that hides what's under it), drawn before the layer's fills (decision 0039) |
| Progressive blur | Kernel: a Gaussian whose σ follows the gradient, read from a mip pyramid of the backdrop and interpolated between levels. Not drawn today (the importer evens it out); it becomes possible here. |
| Glass | Kernel, every rule of decisions 0007 and 0039, ported from `glass.ts`'s shader: the rim's height field (blurred mask and derivative-of-Gaussian slopes), the exact box distance, the bend `(1 − d/depth)^falloff` with Figma's measured profiles for boxes, ellipses and other shapes, dispersion, splay along the edge, frost through mipmaps, the hairline and shade, the depth clamped to the inradius. Premultiplied throughout, keeping the backdrop's alpha; on a canvas that may be see-through it *replaces* what's under its shape. Each glyph is its own lens. |
| What an export's readers see (0039) | The context pass: the page beneath the exported layers, without its background, drawn into the readers' backdrop textures first. On the GPU this is a render into a texture the export's kernels read, not a second canvas. |
| Noise, texture | Kernel: the same fields as `noise.ts` and `texture.ts` (seeded, periodic), computed in the shader instead of tiled from a canvas |
| Corner smoothing | Geometry: the squircle path, generated in Rust from the radii and smoothing, the same for every backend and every use (fill, stroke, clip, shadow, glass distance) |

## The CPU backend for Workers

**The same crate, built without wgpu.**
- The executor that walks the display list is generic over Vello's two scene types (their drawing APIs are the same; `engine/src/exec.rs`). It drives `vello_cpu` and Rust kernels instead of `vello_gpu` and WGSL ones.
- In the spike, that build is 389 KB of WebAssembly (150 KB gzipped), against resvg's 2,479 KB (949 KB gzipped).
- It needs no fonts: text arrives as outlines.

**Memory, under the 128 MB isolate.**
- The engine's memory is capped in its module, as resvg's is (`withMemoryMaximum`, decision 0033). It takes resvg's 25 MiB. The rest of the budget stays as decision 0033 set it: HarfBuzz 32 MiB, the editor's 48 MiB, and the 17 MB baseline.
- What a render holds is its picture (4 bytes a pixel), a scratch picture for layers drawn apart, the backdrop of the largest kernel in floats, and Vello's strips.
- The kit's 880 × 2168 board took 18.5 MiB (below).
- Larger pictures render in row bands: the executor already renders each segment only in the rows it touched. A band's kernels read a halo the size of their reach, so a 4096-pixel-wide picture fits in the cap at any height, at the cost of re-running kernels that straddle bands.
- No font file is copied into the engine. That lifts decision 0033's "fonts alone don't fit" failure, because CJK text costs its outlines, not its 10 MiB font.

**What differs from the GPU, and the tolerance we accept.**
- Coverage is the same code, so edges agree.
- What differs is arithmetic:
  - `vello_cpu`'s fast pipeline composites in 8-bit and 16-bit integers where the GPU uses floats;
  - texture sampling rounds differently;
  - the GPU writes 8-bit targets between passes as the CPU does, but rounds its own way.
- On the kit board, CPU against GPU (SwiftShader) is a mean of 0.13 of 255, p99 2, at most 5 in any channel. With `vello_cpu`'s float pipeline it's 0.05, p99 1, at most 4, at 1.7× the CPU time.
- **The tolerance:** per parity cell and kit frame, CPU against GPU at most 0.25 mean and 4 at p99. The headless parity suite (decision 0023) is re-baselined as engine CPU against engine GPU, and its approximate effects (glass, background blur, noise, texture) stop being approximate.

**It replaces resvg for every raster headless render:** agent tools' `export_image`, thumbnails rendered on the server, and the Worker's previews.
- `renderPng` keeps its interface.
- Inside, it builds the display list from the headless editor's scene (the same builder the canvas uses), instead of the SVG export.
- The memory estimate in `render-memory.ts` becomes the engine's: pixels × 3 plus the largest kernel's backdrop, instead of resvg's nested-layer factors.

**SVG and PDF export stay separate,** as vector outputs. Their approximations of glass and background blur are a property of the formats, not of the renderer.

## Fallbacks

**Where WebGPU is, today** (the gpuweb implementation status wiki, last edited 2026-10-02; caniuse, October 2026 data):

| Browser | WebGPU |
| --- | --- |
| Chrome and Edge, Windows x64, macOS, ChromeOS | Since 113 |
| Chrome and Edge, Windows on ARM | Behind a flag |
| Chrome, Android | Android 12+ on ARM, Qualcomm and Intel GPUs since 121; Imagination on Android 16+ since 139; others to be decided |
| Chrome, Linux | Intel Gen12+ since 144; NVIDIA on Wayland (driver 535.183.01+) since 147; other GPUs, AMD included, behind flags |
| Safari | 26, on macOS 26, iOS 26, iPadOS 26 and visionOS 26 (caniuse marks 26.0 to 27.3 on macOS as partial without saying what is missing) |
| Firefox | Windows since 141; Apple Silicon Macs since 145 and all macOS versions since 147; Intel Macs and Linux in Nightly only (the Linux release bug is open); Android behind a flag |

caniuse puts WebGPU at 88.6% of global use (86.8% full, 1.8% partial) and WebGL2 at about 97.3%.

**The fallbacks, in order:**
1. **WebGPU,** where the adapter isn't blocklisted. Blocklisting follows Figma's practice: devices whose WebGPU sessions fall back or fail often are moved to the next path, by telemetry.
2. **WebGL2, through the same engine.**
   - `vello_gpu` has a native WebGL2 backend that draws the same scenes. Our kernels then need GLSL.
   - Rather than write a third copy, the kernels go through wgpu's WebGL2 backend, which translates their WGSL with naga, as Figma translates its shaders.
   - That costs download: Vello's own size ceilings are 3.6 MiB for its WebGL example against 7 MiB for its wgpu one, so the WebGL2 build is a separate module loaded only where needed.
   - WebGL2 lacks compute shaders, which nothing here requires, and is fast enough for this renderer's work (it's what CanvasKit and Flutter draw with).
3. **The CPU backend in a Web Worker,** drawing into an `OffscreenCanvas`, for the rare browser with neither. A full frame of the kit board is about 200 ms on this VM, and the retained surfaces make pans cheap. It is correct and slow, which beats a broken canvas.
4. **The 2D canvas renderer,** until it's retired (phase 5).

## Language and libraries

| | C++ with Skia | Rust with Vello (recommended) | Rust with our own renderer on wgpu, tiny-skia on the CPU |
| --- | --- | --- | --- |
| WebGPU on the web | Not shipped. CanvasKit 0.42.0 (2026-08-18) ships three WebGL (Ganesh) builds and no WebGPU build. Upstream's `compile.sh webgpu` (Graphite on Dawn) has no published build; skia-discuss reports API mismatches with emscripten's `webgpu.h`; the community WebGPU builds (open-pencil/canvaskit-webgpu, archived 2026-11-08) are forks. Graphite ships in Chrome on Apple Silicon, natively. | `vello_gpu` 0.4.0 (2026-11-11) on wgpu 30 (WebGPU first class), drawn in the spike on Chromium's WebGPU | wgpu 30, first class |
| WebGL2 | Ganesh, mature (Flutter, CanvasKit) | `vello_gpu`'s native WebGL2 backend, or wgpu's | wgpu's, best effort |
| CPU path with matching semantics | Skia's raster backend: mature, but a different rasteriser from the GPU backends (analytic AA, tessellation, MSAA on the GPU) | `vello_cpu`, sharing `vello_common`'s coverage with `vello_gpu`: 0.13 mean apart in the spike | tiny-skia: a different rasteriser from ours; 20 to 100% slower than Skia on x86-64 and 100 to 300% on ARM (its README); no blur or filters; 0.12.0 was its first release in two years |
| Code size | CanvasKit default build 7.32 MB raw, 2.94 MB gzipped; a build without Skottie and fonts "about half" | Spike: 389 KB (CPU, 150 KB gzipped), 709 KB (GPU with CPU, 263 KB gzipped) | Smallest renderer code; tiny-skia "about 200 KiB" natively; wgpu as Vello's |
| Fidelity control for Figma's rules | SkSL runtime effects (blenders, shaders, image filters) give one source for CPU and GPU, a real advantage; backdrop filters in `saveLayer` | Vello doesn't do Figma's rules; we own them as kernels in two languages (the spike: blend kernel about 60 lines each, glass about 130) | Everything ours, twice |
| Maturity | Very mature (Chrome, Android, Flutter) | Pre-1.0, no API stability; `vello_cpu` "the most mature choice", `vello_gpu` "slightly less mature"; mask layers and some blends panic on the GPU (we route them through kernels); its blur is approximate (we replace it) | wgpu mature; the renderer is ours to mature |
| Memory in a capped isolate | Emscripten's `malloc` returns null and Skia then mostly aborts; CanvasKit in Workers has worked with manual `.delete()` and about 65 ms cold starts (pmil.me, undated) | Rust's allocation failure aborts the instance, which decision 0033's fresh-instance-per-render already plans for; no manual frees across the JS boundary for the display list | As Vello |
| Toolchain in our monorepo and CI | gn, ninja, Python and emsdk 4.0.7; a 4 to 8 GiB checkout; long builds, or a binary we build elsewhere and commit or fetch | `cargo` and `wasm-bindgen` from a folder's `mise.toml` (the spike's); a minute or two to build | As Vello |

**Why Rust and Vello rather than C++ and Skia:**

1. **Skia has no WebGPU path for the web that anyone ships.** The point of the engine is WebGPU in the browser; with Skia we'd be maintaining a Graphite-on-emdawnwebgpu build ourselves, which is what the archived forks tried.
2. **Size.** The whole CPU engine is smaller than resvg compressed, and the GPU engine a tenth of CanvasKit raw. Both download on every cold editor load and sit in the agent runner's isolate.
3. **The CPU and the GPU share coverage.** Edges, the largest source of per-pixel difference between rasterisers, agree by construction (measured), so the tolerance can be tight.
4. **The toolchain is small and reproducible.** It's already set up in a folder's `mise.toml`. Skia's would dominate CI.
5. **C++ isn't what makes Figma fast.** What makes it fast is its own renderer, retained GPU state and doing its compositing itself, all of which this design has. A C++ engine of our own on Dawn would be the third column's work in a language with a heavier toolchain and no memory safety in an isolate where an overrun costs a room's sockets (decision 0033).

**What Skia would do better, and its mitigation.** Skia's SkSL is one source for the CPU and the GPU. Our kernels are written twice.
- They are small: the spike's blend kernel and glass are about 60 and 130 lines in each language.
- The conformance suite runs both on every parity scene and fails on the tolerance above.
- Should that cost grow, the kernels can move to a single source compiled to both. That means WGSL interpreted on the CPU by naga, or rust-gpu, neither ready today.

## Migration, behind a switch, with parity as the gate

The switch is a per-user setting and a URL flag (`?renderer=engine`), off by default until phase 5. The gate for every phase:
- every Figma parity suite within its threshold;
- the headless parity suite within the CPU-GPU tolerance;
- and both kits through `tools/kit-parity` (the large iOS UI kit and the shadcn/ui kit, 400 and 761 frames) with no frame worse than the canvas renderer's score on the same base (kit parity's `--against`, a change above 0.01 counting).

0. **The spike** (this record): done.
1. **The engine package.**
   - `packages/engine`: the crate, its two builds and their TypeScript bindings.
   - The display-list builder, from the spike's `board.ts` grown to every feature, moved into the editor beside `Scene`.
   - The conformance suite (CPU against GPU on every parity scene) in CI on the CPU.
   - Nightly on a GPU machine through `tools/gpu-bench`.
2. **Pan, zoom and drag first.** The engine draws the screen behind the switch with retained surfaces, for pages without readers or masks first.
   - This is where the user's pain is: whole-page pans, zooms and drags become texture composition.
   - The 2D canvas renderer still draws everything the engine can't, and the switch falls back per page.
3. **Effects to parity.** Exact shadows and blurs, glass with its height field, masks, background blur, noise and texture. Each lands with its parity suite passing on the engine, then the kits.
4. **Headless.** `renderPng` on the engine's CPU build. resvg leaves the agent runner, with its cap and the font copies. The headless parity suite becomes CPU against GPU.
5. **Default on, then retire.** On by default where WebGPU or WebGL2 is available. The canvas renderer stays for one release behind the switch, then goes, with `glass.ts`'s WebGL, `luminance.ts`, `linear-blend.ts` and the tiles' stand-in machinery.

**Risks:**
- **Vello is pre-1.0.** Pin exact versions (the spike pins `=0.4.0`). Keep the Vello surface we use small: fill, stroke, clip path, opacity layer, gradient, image. Be ready to vendor.
- **Two copies of every kernel.** The conformance suite is the mitigation; each kernel lands with a parity cell.
- **GPU driver bugs and blocklists,** which Figma reports managing by telemetry. We need the same fallback telemetry before phase 5.
- **Text.** Glyph outlines filled per frame are slower than a glyph atlas at small sizes. The atlas is a phase 2 item; the spike fills outlines.
- **The kit's 921 readers on one page.** Retained surfaces make each reader cost one kernel when what's under it changes, not per frame, but a full-page first draw still runs every reader once. The GPU bench must show that page's first frame and pans before phase 2 closes.
- **Download.** The GPU module adds about 260 KB gzipped, and the WebGL2 module more where it's needed. Both are cached and loaded beside the editor's code.

## How we measure

**This VM has no GPU.** Chromium's WebGPU here is SwiftShader, a software adapter (`isFallbackAdapter: true`), and its timings mean nothing about a GPU. What can be measured here:

- **Correctness:**
  - kit parity's score for the CPU backend and for the GPU backend on SwiftShader, which runs the same shaders as a GPU, against Figma's render, the canvas renderer's and each other;
  - the parity suites, once the engine draws them.
- **Memory:** the engine's WebAssembly memory, which only grows, so after a render it's the peak; HarfBuzz's beside it; and the workerd process's resident memory before and after.
- **CPU-backend timing** in workerd (from outside the Worker: a Worker's clock stands still while it computes), in Node and natively. The VM is shared (load averages of 9 to 17 on 4 cores during these runs), so take medians, and compare against a baseline run, not a budget.

**What needs a GPU machine:** GPU frame times (first frame, pan, zoom, drag at p50, p95 and worst), GPU memory, and the comparison with the canvas renderer on the kit's heaviest pages (decision 0028's table).
- `tools/gpu-bench` runs headless Chrome with WebGPU on a real NVIDIA GPU. It refuses software adapters.
- The spike's browser measurement is a Playwright spec whose input comes from environment variables (`SPIKE_FILE`, as `BENCH_FILE` names a converted kit), so the bench can run it there unchanged.

## The spike

`tools/render-engine-spike` (not a product switch; see its README):
- the engine crate (`engine/`: display list, executor, CPU and GPU backends, kernels in Rust and WGSL);
- the board-to-display-list builder in TypeScript (`src/board.ts`, reusing the editor's scene, saved glyphs, glass parameters, shadow casts, dashes and stroke sides);
- a Worker with the CPU build and HarfBuzz (`worker/`);
- a page and a Playwright spec for the GPU build (`page/`, `e2e/`).

**The board** is the "Sliders" component set of a large iOS UI kit: 440 × 1084, drawn at 2× (880 × 2168), 290 layers. It has:
- fills;
- strokes, including a dashed one and per-side ones;
- SF Symbols drawn from saved outlines (Apple's fonts aren't here);
- 45 drop and inner shadows drawn, many blended by linear dodge or burn;
- 5 layer blurs;
- multiply and linear burn layers;
- five glass knobs.

**Input data.** It reads the kit converted by kit-parity at `3972943cb5b5b001`, the cache the canvas renderer's latest kit run drew from. The cache first named for the spike, `d9faee5604607ab1`, predates decision 0037's saved outlines and 0039's glass settings (no glyph layouts; Figma's default glass instead of Apple's), so it can't show either.

**What the spike cut:**
- Glass handles boxes only (the kit's knobs and buttons). It takes the rim's direction from the box's exact distance instead of the blurred height's slope, and reads without mipmaps.
- Shadows and layer blur use Vello's blur, which is approximate.
- Gradients, images, masks, background blur, vectors and noise aren't on this board and aren't drawn (the builder counts anything it skips; on this board, nothing).
- The display list is rebuilt and decoded per frame; nothing is retained.

| Measurement | Result |
| --- | --- |
| WebAssembly, CPU build (vello_cpu, kernels, decoder) | 389 KB raw, 150 KB gzipped, 125 KB brotli (resvg today: 2,479 KB raw, 949 KB gzipped) |
| WebAssembly, GPU build (vello_gpu, wgpu WebGPU, WGSL kernels, and the CPU path) | 709 KB raw, 263 KB gzipped, 214 KB brotli, plus 75 KB of wasm-bindgen JavaScript |
| Display list | 116 KB: 530 ops (213 fills, 18 strokes, 37 clips, 50 blurs, 10 opacity groups, 50 layers drawn apart for a kernel blend, 5 glass) |
| Peak memory in the Worker | Engine 18.5 MiB of its 25 MiB cap (it stays there over ten renders); HarfBuzz 0.4 MiB beside it with Inter loaded and a line shaped. The workerd process grew 29.7 MB on the first render (the engine's memory, its compiled code, the request) and 23.7 MB more when the 7.6 MB of pixels were sent back (copies of the response). |
| CPU-backend render time in workerd | 201 ms (median request 229 ms, less an empty request's 28 ms; nine runs, 163 to 321 ms); first render 356 ms. Load average 9 to 12 on 4 cores. Natively (aarch64), 190 to 300 ms. |
| Where the CPU's time goes (warm, in Node) | Rendering segments 45 to 70 ms, layers drawn apart 32 to 80, the blend kernel 17 to 36, glass 25 to 70 |
| GPU render time | **Software adapter (SwiftShader), not representative:** median 2,846 ms per frame, first 7,557 ms; 156 ms of that median spent encoding on the CPU; 132 command buffers per frame (one per segment and kernel) |
| CPU (Worker) against CPU (page) | Identical: 0 difference |
| GPU against CPU, kit parity's metric | Mean 0.13, p99 2, max 5 of 255; no pixel more than 32 apart. With `vello_cpu`'s float pipeline: 0.05, p99 1, max 4 (305 ms against 182 ms in Node). |
| Against Figma's render, kit parity's metric | GPU 0.52 (p99 13), CPU 0.58 (p99 12); the canvas renderer today 0.22 (p99 4). By section of the board, GPU against canvas: idle knobs 0.126 / 0.049, pressed knobs with glass 0.323 / 0.114, disabled 0.072 / 0.053. The glass shortcuts and Vello's approximate blur (visible box edges around the knobs' 13 px shadows) account for most of the gap. |

What the spike found besides the numbers, all now in the design above:

- **Vello renders each scene from an isolated root.** Over pixels drawn by an earlier scene, a Vello blend layer blends with nothing (the kit's white multiply over the glass came out solid white). So the engine owns every non-normal blend as a kernel, and clips are clip paths, which don't isolate.
- **`vello_cpu` visits its whole target on every render,** even for an empty scene: 5 ms for this board natively, per segment. Rendering each segment only in the rows it drew in (a band of the page's buffer) took that to 1 ms, and the board's native render from 290 to 890 ms down to 190 to 310 ms (three runs each on a noisy VM).
- **Vello's Gaussian blur is approximate and clipped at 3σ,** which shows on large shadows. Shadows and blurs get exact kernels.
- **The backdrop readers set the pace.** 25 of the frame's flushes are for kernels: each blended layer and each glass ends a segment. The engine proper keeps the frame in surfaces, so those run when what's under them changes, not every frame.

## Consequences

- The editor gets a renderer that can keep work between frames. Pans, zooms and drags on the iOS kit become composition, as in Figma.
- Headless renders become the same engine as the canvas, within a measured tolerance, with glass and background blur drawn exactly. resvg, its cap and its whole-font copies leave the agent runner.
- The repo gains a Rust toolchain, scoped to the engine's folder through `mise`, and a WebAssembly build step in CI.
- Every Figma rule now has two homes until phase 5: the canvas renderer and the engine. New rules land in the engine first once phase 3 starts.
- `packages/editor`'s rendering code shrinks to the display-list builder and the overlay once the canvas renderer retires.
