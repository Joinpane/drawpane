# 0040. A render engine in Rust on Vello: the GPU in the browser, the same code on the CPU in Workers

- Status: proposed (design, with a spike; nothing ships). Revised on 2026-11-18 after an independent review ("approve with changes"); the lead maintainer approved Rust on Vello and answered the review's product questions (below).
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

**How Figma draws.** Figma's renderer is its own C++ engine, compiled to WebAssembly for the browser and to native code for server-side renders and tests. It draws on the GPU, first through WebGL and since 2025 through WebGPU (via Dawn and emdawnwebgpu), falling back to WebGL mid-session ("Figma rendering: Powered by WebGPU", 2025-09-18, figma.com/blog). Its GPU state persists between frames.

This record decides what replaces the 2D canvas renderer and resvg:

- a native engine compiled to WebAssembly;
- that draws on the GPU through WebGPU in the browser;
- whose same code renders on the CPU in a Worker;
- that keeps every Figma rule the current renderer has learned (decisions 0007, 0013, 0016, 0028, 0031, 0037, 0038 and 0039).

A spike in `tools/render-engine-spike` proves the riskiest integration on one glass-heavy board of the kit. It is described, with its measurements, at the end. It doesn't prove retained rendering, cache invalidation, text caching, real-hardware speed, device recovery, full effect fidelity or bounded exports; the phase 1 evidence below does.

## Decision

1. **An engine in Rust, compiled to WebAssembly, drawing with Vello's sparse-strip renderers.**
   - `vello_gpu` draws through wgpu in the browser: on WebGPU, and on WebGL2 through wgpu's GL backend. Vello's passes and ours share one wgpu device, so they share textures.
   - `vello_cpu` draws on the CPU in Workers.
   - The two share `vello_common`: path flattening, stroking, tiling into strips, and coverage. Their edges agree, though their arithmetic, sampling and rounding still differ (measured below).
2. **The engine owns compositing, on a render graph.**
   - Every rule where Figma differs from a textbook renderer is a pass the engine owns: every non-normal blend, glass, blurs, shadows, masks and backdrop reads.
   - Passes are nodes in a destination-aware render graph (below). The graph decides what a reader sees, what an edit invalidates, and what a cached picture may be reused for.
   - Each pass is written twice: a readable Rust reference, which is the semantic oracle, and a WGSL version held to it by the conformance suite.
   - Vello only fills, strokes, clips and composites source-over.
3. **Drawpane owns its text caches.** Saved outlines (decision 0037) and shaped glyphs are rasterised into coverage atlases Drawpane keys, budgets and evicts, on both backends. Vello's experimental glyph cache isn't used.
4. **TypeScript keeps the document, layout and every rule about *what* is drawn.** The engine receives a retained display list, patched by layer in atomic revisions, and draws it.
5. **Migration in phases behind a switch, with parity, freshness and frame-time gates that grow with the features.** The 2D canvas renderer stays the fallback until the engine meets the full matrix. The default switches only when no kit frame is worse.

## Acceptance criteria (the lead maintainer's answers)

These answer the review's five product questions. They set the gates below.

1. **Devices.**
   - **Full editing speed:** desktop browsers with WebGPU, meaning current Chrome, Edge and Safari on Mac and Windows laptops.
   - **WebGL2:** a supported editor path, but it may be slower.
   - **CPU only:** a viewing mode.
   - **Tablets and phones:** view-mostly for now.
2. **Freshness.** The editor always runs at 60 fps. Glass, blur and small text may show a cheaper version for up to about 250 ms after movement stops, then must be exact. That is a gate on the real-GPU interaction tests.
3. **Exports.**
   - Large exports render in bands inside the Worker's caps, up to a stated maximum: 8192 px on the longest side of the output, which is 4096 units at 2×.
   - Anything larger fails with a clear error asking for a smaller scale.
   - No separate export service.
4. **Accuracy.**
   - When the engine becomes the default, no kit frame may be worse than today's canvas renderer.
   - Small, documented per-feature differences are allowed only while it's behind the switch.
5. **Ownership.**
   - The agents maintain the engine, under the same review and parity process as everything else.
   - Vello is pinned to an exact version and vendored or patched as needed.
   - Paired kernels are acceptable while they stay small and the CPU-against-GPU suite guards them.

## The boundary

The document model, editing, layout, hit testing, the spatial index and the overlay stay in TypeScript. The engine is a renderer: it never sees `NodeRecord`s.

### The display list

A list of **layer records**, each keyed by a handle (a 32-bit index plus a generation, so a stale handle from a removed layer can't name a new one), in paint order, with parent links. A record holds what the engine needs to draw that layer, already resolved by TypeScript:

- **Its transform, relative to its parent,** not to the page.
  - The engine composes the chain, so moving a parent updates its descendants without a patch per descendant.
  - Coordinates are kept in f64 in TypeScript and rebased near the camera before they become f32. On an infinite canvas, a layer at x = 10⁶ doesn't lose sub-pixel precision.
- **Its geometry, as paths in its own units:** rectangles with radii, ellipses, vectors.
  - **Per-side strokes and fitted dashes** are resolved by TypeScript (`strokeRegion`, `fitDashes`), as today.
  - **Corner smoothing** (squircles) is the exception, generated by the engine from radii and smoothing. Rust is then the only producer of that outline, for every use: fill, stroke, clip, shadow, glass distance, hit-test outline (handed back to TypeScript) and SVG export (through the same function compiled for the editor).
- **Text, as glyph runs, not merged paths:** for each glyph, its identity (a saved outline's `glyphId`, or a font file's hash and glyph index), its origin and size, and its run's paints. The engine caches by those identities (see "Text").
- **Paints:** solid; linear, radial and angular gradients in the layer's unit square; images by content hash with their scale mode and crop; each with opacity and blend mode.
- **Stroke styles:** width, align, join, cap and miter.
- **Effects, as parameters, not pixels:**
  - drop and inner shadows (with spread, blend, and the cut-out from `dropShadowCast`);
  - layer and background blur, and progressive blur;
  - glass, with `glassParams` already applied;
  - noise and texture.
- **Grouping:**
  - opacity, and whether the layer fades as one (`fadesAsOne`) or blends as one (`blendsAsOne`);
  - clip content;
  - mask role and type, with the scope resolved by `maskScopes` (decision 0016's amendment);
  - visibility.
- **Its extent** (`Scene.extent`) and its **reach:** how far its effects read and write beyond it (blur halos, refraction margin).

**Revisions.**
- TypeScript builds patches from the scene's change log (`Scene.dirtySince`, decision 0028): a record inserted, replaced or removed, children reordered, or only a transform changed.
- A batch of patches is one revision, numbered. The engine applies a revision whole into the next scene and swaps scenes at a frame boundary, so a frame never mixes two revisions.
- Camera messages (zoom, pan, device pixel ratio, viewport) name the revision they go with.
- Remote edits arrive the same way as local ones.

**Lifecycle and limits.**
- **Protocol:** the list starts with a protocol version, and the engine refuses a version it doesn't know (the TypeScript and WebAssembly builds ship together; the check catches a stale cache).
- **Validation:** every number is checked finite; dimensions are checked against the adapter's limits; there are caps on path verbs per record, records per revision, nesting depth, dash counts and patch bytes. A list past a cap is refused whole, with the cap named, never drawn in part.
- **Assets:** images and glyph outlines are reference-counted by the records using them, and released when the count reaches zero or the page closes.
- **Unsupported operations:** anything the engine can't draw exactly (a blend with no kernel yet, an effect not implemented) is reported by the builder per layer. That page stays on the canvas renderer. It is never drawn approximately behind the switch without a documented, per-feature exception (acceptance criterion 4).

**Selection, hover, guides and handles stay out of the engine.** The overlay (`overlay.ts`: handles, guides, the marquee, size pills, the caret, remote cursors and selections) stays a 2D canvas or DOM layered on the engine's canvas. It redraws on interaction and with collaborators, and changes nothing in the display list. Layers whose drawing depends on the editor's state are flagged in their record and patched like any edit:
- text being edited, drawn from its live layout rather than saved outlines;
- layers hidden while being placed.

## The render graph

A board picture is reusable only while everything its pixels depend on is unchanged. Pass-through blends and backdrop readers make a layer's pixels depend on drawing outside its own subtree (decisions 0038 and 0039). Isolation controls how the finished picture composites. Glass inside an isolated picture can still depend on paint outside it. So caching follows a graph of what reads what, not the layer tree.

### Nodes

- **Source:** a layer's own drawing with no dependency on what's beneath (fills, strokes, glyphs, shadows of a normal blend), in its own coordinates. Its geometry (strips, glyph coverage, a glass shape's mask and height field, a shadow's blurred mask) is cached independently of any destination.
- **Scope:** where backdrops come from.
  - The page is a scope.
  - So is every layer that isolates: fading as one, a mask group (masked layers are drawn apart, 0016), a layer blur, a layer that blends as one.
  - A frame that doesn't isolate is not a scope: blending passes through it.
- **Backdrop prefix:** for a reader at paint position *p* in scope *S*, the paint available before *p*, restricted to the reader's read region (its extent grown by its reach). Ordinary blends use the current scope's prefix. Glass inherits the parent prefix beneath an isolated picture and composites the picture's preceding glass-free paint over it.
  - For an export with context (decision 0039), the page beneath the exported layers, without the page's background, is the prefix of the export's top scope.
- **Reader:** a pass whose output depends on its prefix: glass, background blur, every non-normal blend, and the copy a faded pass-through frame holding a blend draws over (0038). Its output region is its extent.
- **Filter:** a pass over a scope's own result (layer blur, noise, texture, mask application).
- **Composite:** a scope's result laid into its parent scope, by its opacity and blend.

### Versions and invalidation

- Every node has a version: its record's revision, combined with its inputs' versions.
- A reader's version includes the version of its prefix over its read region.
- A cached result is keyed by node, version, raster scale and tile.
- An edit produces dirty regions: the old and new extents grown by the old and new reach of every record it touches. Reorder, removal, a change of clip, mask, opacity or blend, or a change of reach (blur radius, refraction, depth) counts as touching.
- Invalidation sweeps each scope in paint order with a growing set of dirty regions:
  - a source intersecting a dirty region is redrawn there;
  - a reader whose read region intersects a dirty region is re-run, and its whole output region joins the dirty set, so a reader above it sees the change too;
  - a scope with any dirty region is recomposited into its parent over that region, which then continues the parent's sweep.
- This is the transitive closure an edit really requires. A change under a stack of overlapping glass invalidates each glass in turn, including glass outside the original edit's extent. It replaces `#withReaders`' fixed-point growth of strips, with the same answer and remembered between frames.

### Dragging

- **The fast path is a translate-only move of a cached picture.** It applies only when the dragged selection:
  - is contiguous in paint order within one scope (no stationary sibling between selected layers);
  - holds no reader and no non-normal blend;
  - and isn't inside a mask scope or a faded pass-through frame.

  Then the selection is drawn once as a source picture, and its scope is split around its paint position into a cached "below" result and an "above" result. Each frame composites below, the moved selection, then above. Any reader in "above" whose read region meets the selection's old or new region is re-run over that region, against the new prefix.
- **Every other drag is drawn at its actual paint position each frame.** The invalidation sweep runs over the union of the old and new regions (a glass lens being dragged re-reads its backdrop every frame; a multiply layer re-blends). The frame budget and the freshness gate govern how much is exact in that frame.
- **In and out of a board.** The editor sends the provisional parent and order as a patch, as the document will be on drop.
  - The engine treats it as a removal from the old scope and an insertion into the new one.
  - Both boards invalidate only under the layer's old and new regions.
  - The new board's clip applies once the layer is inside it.
  - Nothing is drawn over a board as an overlay out of its paint order.

### Tiles

- Large scope results are tiled (512 × 512 device pixels). A tile's inputs are its region grown by the reach of every reader and filter that writes into it, read from the prefix at that grown size, so tiles have no seams.
- Sample origins are fixed per raster scale, so a re-rendered tile lines up with its neighbours.
- Readers never read their own output (no feedback). A reader's prefix stops at its paint position.

## Retained GPU state

- **What is cached:**
  - geometry (strips, glyph atlases, glass masks and height fields, shadow masks), independent of destination;
  - scope results per tile, at a raster scale;
  - reader results only where the graph says they're reused (a reader under a drag that keeps changing isn't cached).

  Caching every expensive layer's picture and also its board's tiles would hold the same pixels twice. The policy keeps the scope tiles and the geometry, and the reader results only for readers whose prefix is stable.
- **Raster scales.** Exact output renders at the exact zoom × device pixel ratio. While zooming, cached tiles of the nearest scale stand in, scaled; scales step by √2, not by powers of two (a power-of-two bucket can hold nearly four times the pixels of the exact scale), and at most two scales of one tile live at once.
- **Level of detail** comes from projected size and error, not a fixed coarsest bucket.
  - Text below 4 device pixels draws as bars, and layers below half a device pixel are skipped, with hysteresis so a zoom back and forth doesn't flicker.
  - Those are interaction stand-ins only: idle frames, exports, thumbnails and headless renders always render exactly.
  - A coarse picture made by downsampling a fine one is a stand-in too. Blends and thresholds don't commute with downsampling.
- **GPU memory.** A budget the engine holds itself, since WebGPU exposes no free-memory query. It counts every allocation:
  - targets, mip levels and halos;
  - atlases and images;
  - Vello's internal buffers and textures;
  - transient old and new generations.

  Allocation arithmetic: a 512 × 512 RGBA8 tile is 1 MiB; a 2880 × 1800 RGBA8 view is 19.8 MiB; RGBA16F doubles that; a mip chain adds a third. By that arithmetic, a full laptop view's working set is about 170 MiB: five view-sized targets (the frame, scratch, a copy under a pass, two frost passes: 99 MiB), two raster scales of tiles under the view with halos (about 40 MiB), and the atlases (32 MiB). The default budget is 384 MiB on desktop, keeping a reserve under the adapter's `maxBufferSize` and texture limits, and 192 MiB on tablets and phones (view-mostly).

  Over budget, the engine lowers cache detail in order: reader results first, then off-screen tiles, then the coarser of two scales. It never bypasses the frame budget by drawing everything directly. Allocation failure and device loss rebuild from the canonical display list (see "Fallbacks").

### Reader scratch on WebGL2

The T4 WebGL2 test uses the same 513 × 511 view and 320 × 240 reader for glass, uniform blur and progressive blur. It tests the engine's allocation accounting through `gpu_bytes` before drawing and checks for a typed `Limit` on refusal. Ordinary paint fits at 21 MiB. At that cap the glass mask allocation is refused, and the same glass draws at 28 MiB. Uniform blur refuses at 22 MiB and draws at 24 MiB. At 22 MiB progressive blur is refused before allocating its output atlas, and it draws at 28 MiB. The caps include the glyph atlas and the render targets.

## Text: saved outlines and shaped glyphs

Vello's glyph path takes font files and marks its atlas experimental (`glifo` 0.5.0). A request to cache custom outlines was closed as not planned, with caller-side caching recommended (linebender/vello#2041). Saved outlines (decision 0037) have no font file, by design. So Drawpane owns the cache, on both backends. Interning the paths saves transport and parsing, but not rasterisation: the kit has 9,079 text layers with saved layouts over 947 distinct glyphs, and filling each occurrence's path rebuilds its strips every time a tile is rebuilt.

- **The key:**
  - **The glyph:** a saved outline's `glyphId` (16 hex digits of its outline's hash, decision 0037), or a shaped glyph's font file hash and glyph index.
  - **Its device size,** in quarter pixels up to 64 px and in steps of 2% above that.
  - **Its linear transform,** for rotated or skewed text, quantised to 1/256.
  - **Its horizontal subpixel phase,** in quarters. Baselines fall on whole pixels (decision 0037), so the vertical phase is 0 for upright text.
  - **The variant:** fill coverage only. Strokes, gradient-filled text at large size, and text used as a mask or glass shape use outlines.
- **Rasterisation:**
  - Coverage masks are made on the CPU with `vello_common`'s own coverage, for both backends, so a glyph is the same pixels on the CPU and the GPU.
  - A1 px transparent border avoids bleeding when sampled.
  - The GPU uploads masks into A8 atlas pages (2048 × 2048, 4 MiB each); the CPU keeps the same pages in WebAssembly memory.
  - A glyph is drawn as its atlas rectangle times its run's paint, so solid and gradient fills both use the atlas below the size limit.
- **When outlines are used instead:** above 256 device pixels per em, or past a skew or scale the atlas would blur, or when the atlas misses within a frame's budget (the outline is filled and the mask queued). Outline geometry stays available for every use that needs a shape.
- **Budgets and eviction:**
  - **The GPU:** 32 MiB of atlas on desktop and 16 MiB on tablets and phones.
  - **The CPU:** 4 MiB in the Worker, within the engine's cap.
  - **Eviction:** least recently used by page, with every glyph used in the current frame pinned. A page is compacted when fragmentation passes half.
- **Colour glyphs:** emoji and bitmap glyphs go in an RGBA atlas of their own. Saved outlines have none.
- **Flattening tolerance:** chosen by measurement. vello#2036 reports visible coverage loss on small curves at the shared 0.25 px tolerance. Small SF Symbols are scored against Figma's goldens at 0.25, 0.1 and 0.05 px, with preparation time measured for each.
- **Measured in phase 1:**
  - cold glyph preparation, atlas misses and atlas memory on the kit's text-heavy pages;
  - reuse while panning, and rebuilds across zoom steps;
  - typing and undo in text whose font is missing (which switches it from saved outlines to live layout, decision 0037).

## Every feature, as passes

"Pass" means a node of the render graph the engine owns: a Rust reference and its WGSL version, over pixels already drawn. "Vello" means `vello_gpu`/`vello_cpu` drawing calls, the same code on both.

| Feature | How it's drawn |
| --- | --- |
| Solid fill | Vello fill, nonzero or even-odd |
| Linear, radial, angular, diamond gradients | Vello gradient paint with the layer's unit-square transform as its paint transform (decision 0013); angular is Vello's sweep gradient; diamond (`clamp(\|u\| + \|v\|, 0, 1)`) is evaluated on CPU and GPU within the memory budget with its optional second-axis handle (`width`) preserved on Figma import. |
| Images (fill, fit, stretch, crop, tile) | Vello image paint with a transform per scale mode (as `images.ts`); tile uses `Extend::Repeat`. Uploaded once per content hash, with mipmaps, under the GPU budget, as wgpu textures. |
| Strokes | Center is a Vello stroke (kurbo's stroker); inside and outside clip a double-width stroke to the shape or its outside, as today; dashes from `fitDashes`; miter limit 10, the canvas's default |
| Per-side stroke widths | An even-odd region from `strokeRegion`, filled |
| Text | Glyph runs through the atlas (see "Text"); outlines where the atlas doesn't apply. Decorations are bars. |
| Clipping | Vello clip *paths*, not clip layers: a clip path doesn't isolate, so a reader inside it still sees its prefix (the spike depends on this) |
| Opacity, fading as one | A scope, composited by its opacity |
| Normal blend | Vello source-over |
| Separable blends (multiply to exclusion) | Reader: the layer or paint drawn apart over its bounds, then composited over its prefix by W3C's formula |
| Non-separable blends (hue, saturation, colour, luminosity) | Reader, by W3C's formulas. Not in the spike, which refuses them rather than drawing them as normal. |
| Linear dodge and burn | Reader, by Figma's rule: `c = min(a, cs + cb)` and `c = max(0, cs + cb − as·ab)` with normal alpha (decision 0038) |
| Pass-through and faded frames | A non-isolating frame isn't a scope, so its blends read through it. A faded frame holding a blend draws over a copy of its prefix and fades over it (0038). |
| Masks (alpha, luminance, outline of a picture) | A scope of the masked layers, the mask drawn apart, then a filter keeping the scope by alpha, Rec. 709 luminance × alpha, or alpha × 255; scope from `maskScopes`. `vello_gpu` panics on mask layers, so this is our pass on both backends. |
| Mask by one filled shape's outline | Vello clip path |
| Drop and inner shadows | Source (normal blend) or reader (any other blend): the shape grown or shrunk by spread, blurred by the reference Gaussian, offset, cut out where `dropShadowCast` says (0031). Vello's analytic blurred rounded rectangle may stand in for boxes only where it matches the reference within the tolerance. |
| Layer blur | Filter: the reference Gaussian, σ = radius ÷ 2 (decision 0013). Vello's own blur (repeated decimation, clipped at 3σ) is not used: the spike shows box edges around the kit's 13 px shadows. |
| Background blur | Reader: its prefix within its reach (clamped at export crops and CPU frame edges, extended past the viewport in GPU editor views when the working set fits, stopped at clipping frames), blurred, cut to the shape (to the glyphs under text, skipped under a fill that hides what's under it), before the layer's fills (decision 0039) |
| Progressive blur | Reader: a Gaussian whose σ follows the gradient. The reference evaluates it per pixel; the GPU may interpolate between mip levels within the tolerance. Not drawn today; becomes possible here. |
| Glass | Reader, every rule of decisions 0007 and 0039, ported from `glass.ts`'s shader: the rim's height field, the exact box distance, the bend `(1 − d/depth)^falloff` with Figma's measured profiles for boxes, ellipses and other shapes, dispersion, splay, frost, the hairline and shade, the depth clamped to the inradius. Premultiplied throughout, keeping the prefix's alpha; on a canvas that may be see-through it *replaces* what's under its shape. Each glyph is its own lens. |
| What an export's readers see (0039) | The prefix of the export's top scope: the page beneath the exported layers, without its background |
| Noise, texture | Filter: the same seeded, periodic fields as `noise.ts` and `texture.ts` |
| Corner smoothing | Geometry, in Rust (see "The boundary") |

## The engine's contract

The rules both backends follow. Without them, two implementations could agree on a wrong answer, or disagree for reasons nobody can name.

- **Colour:**
  - **Space:** compositing is in gamma-encoded sRGB, as the 2D canvas composites today (and as Figma's renders match).
  - **Alpha:** premultiplied everywhere inside the engine.
  - **Output:** straight alpha only at the boundary.
- **Targets.**
  - Between passes, results are RGBA8, rounded to nearest at the write.
  - Passes that accumulate (blurs, glass's height field) compute in f32 internally. The GPU uses RGBA16F intermediates only where the reference also keeps that precision.
- **Sampling:**
  - pixel centres at half-integers;
  - bilinear filtering where a pass samples between pixels;
  - Repeat edge pixels at the export crop or CPU frame boundary. GPU editor views sample page pixels beyond the viewport when the working set fits. Decision 0039's clipping-frame rule still limits that reach.
- **The reference Gaussian:**
  - a normalised discrete kernel over ±⌈3σ⌉;
  - separable, edges as above.
  - A GPU version may downsample or use fewer taps only within the tolerance against the reference.
  - "Exact" in this record means this kernel, not a continuous Gaussian.
- **Order per layer:** as `render.ts` draws today: drop shadows, background blur, glass, fills, inner shadows, children (clipped), strokes. Then the layer's filters and its composite.
- **Oracles:**
  - **The Rust reference passes** are the semantic oracle. They are readable first and fast second, and the production CPU path may be a faster equivalent checked against them.
  - **Figma's goldens and kit renders** are the product oracle.
  - **Both are needed:** paired passes can share a mistake.

### Backdrop sampling at the viewport edge

GPU editor tiles already draw page paint beyond the viewport to supply reader halos. A whole GPU editor view draws the reachable off-viewport area into full-resolution scratch and copies the viewport back. The draw uses the frame texture directly when no padding is needed. The stationary motion prefix uses the padded view and size when it is cached. If padded scratch cannot fit, the previous clamped whole-frame draw remains available. GPU crop renders, export lists with context and CPU frames use their crop edge.

On the T4 WebGL2 edge fixture, the tiled blur sampled [106, 36, 159, 255] at the viewport edge. Before padding, the whole view sampled [0, 26, 255, 255]. Padding makes the two samples match.

## The CPU backend and exports

**The same crate, built without wgpu:** 389 KB of WebAssembly in the spike (150 KB gzipped), against resvg's 2,479 KB (949 KB gzipped). It holds no font files: text arrives as glyph identities and outlines.

### Memory, bounded

The engine's linear memory is capped in its module at resvg's 25 MiB (`withMemoryMaximum`, decision 0033). The isolate's other tenants keep decision 0033's budget: HarfBuzz 32 MiB, the editor's 48 MiB, the 17 MB baseline. Every render draws inside the cap, by construction:

- **Output streams in tiles.** A render never holds its whole picture.
  - It renders a band of output rows at a time, in tiles of at most 1024 × 256 output pixels.
  - Each tile is encoded straight into a streaming PNG (or JPEG) encoder, and its rows are freed.
  - The encoder's output (compressed) is the only thing that grows, and it lives in the JavaScript heap of the request, not the engine's memory. The spike's full-picture `Pixmap` is gone.
- **Every tile's working set is bounded.** For a tile of *w* × *h* output pixels and a halo *r* (the largest reach of any reader or filter over it, capped below), the engine holds at most:
  - the tile and its halo, (*w* + 2*r*) × (*h* + 2*r*) pixels at 4 bytes;
  - one scratch picture of the same size per scope open at once (at most four), at 4 bytes each;
  - the largest pass's f32 working buffers over the same area (glass keeps the backdrop and its frosted copy: two at 16 bytes);
  - Vello's strips for the tile's geometry.

  That's 52 bytes per pixel of the grown tile. At the largest halo (*r* = 128), a 512 × 128 tile holds (768 × 384) × 52 bytes = 14.6 MiB. That leaves about 10 MiB for the glyph atlas (4 MiB), strips and the display list. With smaller halos and shallower nesting, the executor picks larger tiles from the same formula.
- **Reach and nesting are capped.**
  - A reader or filter whose reach exceeds 128 output pixels at the requested scale renders that band at the largest scale that fits, as decision 0033 does for the whole picture, and the result says so (`reduced`).
  - More than four scopes nested and open at once is refused at the display-list boundary, with the cap named.
- **The preflight estimate** adds, before drawing:
  - the tile working set above;
  - decoded images at their drawn size (not natural size, where the image cache can decode smaller);
  - the glyph atlas (4 MiB);
  - the display list and interned geometry as copied into the engine;
  - the encoder's buffers.

  A render that can't fit at the requested scale takes the largest scale that does, down to the 256 px floor of decision 0033, and says so.
- **The maximum** is 8192 px on the longest side of the output (acceptance criterion 3). Past it, the render fails with a clear error asking for a smaller scale.
- **Every render gets a fresh engine instance,** and a trap fails the render cleanly (decision 0033's lifecycle). The next render starts from a fresh instance.

### Tested as the whole agent runner

Phase 1's acceptance includes the complete runner under its caps, not the engine alone, in vitest-pool-workers with the runner's real configuration:
- the headless editor admitted near its 48 MiB meter;
- HarfBuzz with the CJK fonts decision 0033 measured (Noto Sans SC at two weights with JP);
- images decoded;
- the engine beside them;
- scene to display list to streaming PNG.

The cases:
- a near-limit file;
- deep opacity, mask and filter stacks;
- large readers;
- long and tall exports up to the 8192 px limit;
- a render past the limit (the error);
- a trap followed by a small successful render;
- several files sharing one runner isolate;
- missing and reduced assets still reported.

Local workerd timing (wall time less an empty request) is a latency estimate, not Cloudflare's CPU accounting. A deployed validation needs explicit authorisation and is not part of this record.

### What differs from the GPU, and the tolerance

Coverage is the same code. What differs is arithmetic:
- `vello_cpu`'s fast pipeline composites in integers where the GPU uses floats;
- texture sampling rounds its own way.

On the kit board, the GPU against the CPU is a mean of 0.13 (see the spike's table for the full score). `vello_cpu`'s float pipeline brings it to 0.05 at 1.7× the CPU time; the reference passes use floats regardless. The tolerance is in "Parity gates".

**It replaces resvg for every raster headless render:** agent tools' `export_image`, server thumbnails and the Worker's previews. `renderPng` keeps its interface and its `reduced`, `missingFonts`, `missingImages` and `approximate` notes. `approximate` becomes empty for glass, background blur, noise and texture.

**SVG and PDF export stay separate,** as vector outputs, with their documented approximations of backdrop effects. CPU-against-GPU parity doesn't validate them; their own suites stay.

## Amendment: phase 4 headless rendering

- `renderPng` prepares the export's display list and assets, then renders through the CPU engine. `renderPngStream` hands the PNG bands to a host as they are compressed. The MCP tool buffers up to 6 MiB of compressed PNG because its response carries a single base64 image. Each runner export leases one fresh 25 MiB engine instance.
- Selected layers use the display-list builder's reader context (decision 0039). It prepares the assets of the selection and its relevant page prefix, and excludes the page background from reader inputs. Unsupported operations produce typed refusals. A render whose reach or memory demand exceeds the cap can be reduced to the largest admitted scale down to the 256 px floor. The maximum requested side is 8,192 px.
- PNG admission picks an output band height before producing bytes. The camera is pinned with the revision. Shorter bands keep the same device coordinates, so they preserve resolution. Compressed bytes move out of the encoder's pending buffer as rows are written. Admission budgets for the peak of drawing and encoding and reserves the same runtime headroom as the CPU pass guard.
- HarfBuzz still computes glyph advances, substitutions and outlines. Workerd compiles a small callback module with the runner so the HarfBuzz function table can call the JavaScript draw callbacks. The bridge adds 251 bytes of WebAssembly (154 gzipped), and the CPU render build measures 362 KB gzipped against its 400 KB limit.
- The runner chooses an image level from the projected paint size and retains the natural dimensions for crop, fill and tile placement. Ordinary PNGs decode by row and average into that level. JPEG uses a scaled IDCT. For progressive JPEG, the decoder retains the low-frequency coefficients used at the selected scale and tracks the others with one significance bit per coefficient so it can consume later scans. A 4,032 × 3,024 photo with 4:2:0 sampling needs 4.4 MiB of coefficients at quarter scale, down from 34.9 MiB. The decoder admits against the actual sampled grid within its existing 16 MiB cap. The original content-addressed JPEG supplies the pixels for both existing and new uploads. GIF expands one indexed row at a time, keeping one byte per source pixel to order the rows of an interlaced first frame. Interlaced PNG and WebP use bounded whole-image decoders. The decoder is 161 KB gzipped against its 200 KB limit. One decoder instance lives within each export lease, and its linear memory counts against the combined 25 MiB for decoding and rendering. The runner releases the instance with the engine and reuses the compiled module. When the requested image level cannot fit, the runner tries smaller levels and reports the reduction. Missing and over-budget images are reported separately. SVG and PDF keep their separate vector exports.
- Headless text uses the same font itemizer and fixed Unicode fallback slices as the browser engine. Kana and Hangul in the layer select Japanese and Korean Han forms, respectively. Han-only layers use the explicit `export_image.locale` when supplied. The implicit preference is the document author's locale when recorded. The current document schema has no author locale, so implicit exports use Simplified Chinese (`zh-Hans`) regardless of the requesting client's language. The CPU export allows up to 8 MiB of unique outlines, charged to the engine's cap. If the text still exceeds the outline budget, the error asks for a smaller portion of the text to export.
- Worker PNG admission bounds the projected number of processed pixels across tiles and passes in addition to the peak working set. The full runner checks a 45-second deadline between font loading, image decoding and drawing steps. The deadline also releases the engine when a PNG stream goes unread. Local wall time can vary with machine load and request I/O.
- On 40 seeded blur and isolation cases, main streamed 17 PNGs and refused 23. Adaptive bands streamed 22 and refused 18. Every admitted export completed inside the 25 MiB module maximum. The 2,048 × 640 fixture with three faded groups and one backdrop blur streams at full resolution.
- Run `ENGINE_EXPORT_FUZZ_FULL=1 pnpm --filter @drawpane/engine test -t 'seeded Worker blur'` to stream every admitted case. Routine CI checks all 40 admissions and streams six cases.
- The 8,192 × 8,192 workerd fixture drew 7,200 records and 41 unique live glyph outlines with 18.2 MiB of engine memory. The full runner's live-font test exports images and backdrop readers with two Noto Sans SC weights and Noto Sans JP beside roughly 46.5 MiB of document text payload.
- Run `AGENT_TEST_LIVE_FONTS=1 pnpm --filter @drawpane/worker test test/agent-export-image.test.ts --maxWorkers=1` to exercise the real runner with the pinned CJK font files.
- The translucent-mask cell's headless-versus-canvas comparison measures 0.374 mean, 1 at p99 and 0.84 on the worst tile. Unpremultiplication amplifies integer rounding at low alpha. The old resvg-based mean ceiling was 0.32. The headless cell allows 0.43, and the browser-engine parity and exact CPU comparisons keep their criteria.
- The `corners/layer-blur` headless cell compares directly with the frozen Figma capture because Chromium's Canvas CSS blur result varies across platforms. Headless against Figma measures 0.314 mean, 4 at p99 and 1.46 on the worst tile. In that capture run Canvas against Figma measures 0.951 mean. The headless gate for this cell is 0.45 mean, 5 at p99 and 2 on the worst tile.

## Fallbacks

**Where WebGPU is** (the gpuweb implementation status wiki, last edited 2026-10-02; caniuse's source table):

| Browser | WebGPU |
| --- | --- |
| Chrome and Edge, Windows x86 and x64, macOS, ChromeOS | Since 113 |
| Chrome and Edge, Windows on ARM | Behind a flag |
| Chrome, Android | Android 12+ on ARM, Qualcomm and Intel GPUs since 121; Imagination on Android 16+ since 139; Samsung Xclipse and others not enabled everywhere |
| Chrome, Linux | Intel Gen12+ since 144; NVIDIA on Wayland (driver 535.183.01+) since 147; other GPUs, AMD included, behind flags |
| Safari | 26, on macOS 26, iOS and iPadOS 26 and visionOS 26; older OS versions have none |
| Firefox | Windows since 141; Apple Silicon Macs on macOS 26+ since 145 and on other supported macOS versions since 147; Intel Macs and Linux on by default in Nightly only (Linux release builds can enable it by preference, gpuweb#6331); Android behind a flag |
| Browsers on iOS | Safari's engine, so Safari's support, whatever their brand |

caniuse's table gives 86.8% of global use full support and 3.3% partial (Safari's partial support is the macOS 26 requirement); WebGL2 is about 97%. Neither says how many Drawpane sessions get a working adapter. Secure contexts, blocklists, initialisation failures and device loss need runtime detection and telemetry.

**The paths, in order:**
1. **WebGPU,** where a capability probe succeeds (adapter and device created, the engine's pipelines compiled, a probe scene rendered and read back), not just where the browser version says so. Full editing speed is required here (acceptance criterion 1).
2. **WebGL2, chosen and validated:** Vello's wgpu renderer and all of our passes on one wgpu device whose backend is GL.
   - Vello renders into wgpu textures; our passes read and write the same wgpu textures; no pixel goes through the CPU between effects.
   - Our WGSL is translated to GLSL ES 3.0 by naga inside wgpu. The device asks for wgpu's WebGL2 downlevel limits with the adapter's texture and buffer sizes, as Vello's own wgpu-on-WebGL example does.
   - **Validated in the spike:** the kit board with glass, blurs, separable and linear blends draws through it with the same pixels as the WebGPU path (both at a mean of 0.13 from the CPU; see the spike's table).
   - **Its cost:** the WebGL2 module is far larger than the WebGPU one (naga's translation and wgpu's GL backend; the spike's table has the sizes), so it's a separate module loaded only after the WebGPU probe fails. It compiles its pipelines at start (measured below). A supported editor path, slower (criterion 1).
   - Two pitfalls the spike hit, now part of the design:
     - wgpu's GL backend on the web runs buffer-map and work-done callbacks only when polled, and a blocking poll spins the page's thread (WebGL can't wait on a fence). The engine polls without blocking and yields to the browser.
     - GL needs its canvas's context: the engine's device is created from a canvas surface.
   - The other topology (Vello's native WebGL renderer with our passes as hand-managed GLSL on the same context) was rejected: two resource APIs over one context, and a third copy of every pass.
3. **The CPU backend in a Web Worker,** a viewing mode (criterion 1).
   - The worker renders tiles for the current revision and camera and transfers them to the page as `ImageBitmap`s, which the page composites on a 2D canvas.
   - A new camera or revision cancels queued tiles of the old one.
   - Pan and zoom move tiles already received; edits wait for their tiles. About 200 ms for one full board on this VM is a few fresh boards a second, not an interactive full-page rate, and the mode says so.
4. **The 2D canvas renderer,** until it's retired.

**Loss and switching.**
- **Device and context loss:** WebGPU device loss and WebGL context loss rebuild every GPU resource from the canonical display list and the current revision; nothing in the document is lost.
- **Falling back:** a backend that fails to initialise, or loses its device three times in a minute, falls back one step for the session. It never switches back and forth: the choice is remembered per session, and the next session probes again.
- **Telemetry:** the backend chosen and every fallback are recorded, so blocklisting can follow Figma's practice of moving devices whose sessions fail often.

## Parity gates

- **The score.** Kit parity's mean and p99 over white stay, so numbers compare with past runs. They can't see alpha: transparent white and opaque white score 0 over white, and five wrong pixels in a 100 × 100 picture pass a frame mean. So every gate also takes, unrounded:
  - the mean and p99 over black as well as white, the larger of the two;
  - alpha's own mean and largest difference;
  - the worst 32 × 32 tile's mean, so a missing symbol or a hairline can't hide in a frame average;
  - the count of pixels more than 16 apart in any channel or alpha, and the most of them in any tile (a cluster is a defect; scattered single pixels are rounding).

  The spike's `src/compare.ts` computes all of these and its tests hold the two counterexamples.
- **CPU against GPU,** per parity cell and kit frame, on SwiftShader (repeatable) and on real GPUs of each vendor and backend (compilers, precision, drivers):
  - mean ≤ 0.25;
  - p99 ≤ 4;
  - worst tile ≤ 2;
  - at most 4 pixels more than 16 apart in any tile.

  Exact identities get exact assertions instead of tolerances: blends with a transparent source or backdrop, opaque normal paint, masks by an opaque or empty mask, and each linear blend's formula at chosen values.
- **Against Figma:**
  - Every Figma parity suite within its thresholds.
  - Both kits through kit parity, scored with the same additions:
    - while the engine is behind the switch, a frame may be worse than the canvas renderer only by a documented per-feature difference (criterion 4);
    - to become the default, no frame worse than the canvas renderer: mean (over white and black) not worse by more than 0.01, worst tile not worse by more than 1, alpha not worse.
  - Kit comparisons freeze the document, assets, fonts and the canvas baseline's commit.
  - The grain suite keeps its statistical comparison (both sides blurred), separate from the deterministic CPU-GPU agreement.
- **Unsupported operations fail the gate.** A display list with any unsupported operation fails the conformance run, as does a missing or mismatched reference. The spike's browser spec now does both.
- **Patched equals fresh.**
  - After every patch sequence, the retained render must equal a fresh render of the same revision: bitwise on the CPU, within the CPU-GPU tolerance on the GPU.
  - Sequences come from a seeded generator (fast-check, as `pnpm fuzz` does elsewhere): edit, undo, reorder, parent move, drag across boards and in and out of masks, remote patches.
  - The scenes are small adversarial ones: overlapping readers, a reader moving over changing content, nested masks, a faded pass-through frame, two selected layers separated in paint order, zero alpha, extreme transforms.
  - The same transitions then run on the kit's effect-heavy page.
- **End-to-end tests stay.** The headless, layout and export suites keep comparing whole products (scene to pixels), not only two backends consuming one display list.

## Interaction gates on real GPUs

Visual parity never gates 60 fps, and a frame-rate gate never shows stale glass. These are separate gates, run on real hardware.

- **Where:**
  - `tools/gpu-bench` (planned, being built in another PR): headless Chrome with WebGPU on a Modal NVIDIA GPU, refusing software adapters. It runs the spike's spec today and the engine's interaction suite from phase 1.
  - Datacenter GPUs aren't laptops, so the same suite also runs on the target devices of criterion 1: a Mac laptop (Safari and Chrome, Apple GPU) and a Windows laptop with integrated graphics (Edge and Chrome).
  - Each run records the browser version, the adapter the engine itself selected (vendor, architecture, backend), the driver, target formats, the input and reference hashes, every frame time and memory counter.
- **Scenarios,** on the large iOS UI kit (the 17,922-layer page with 921 readers, and the masked device screens) and the shadcn/ui kit:
  - warm pan and zoom;
  - pan into content never drawn;
  - zoom across raster scales repeatedly, under memory pressure;
  - drag of an eligible selection;
  - drag of a glass lens over changing content;
  - sustained drag under many readers;
  - an edit under a stack of readers;
  - typing in text with a missing font;
  - undo and redo;
  - opening the page cold.
- **Measured:**
  - presented frame intervals, from the browser's frame timing through presentation, not encode or GPU completion;
  - main-thread time per frame for patches and engine work;
  - GPU time where timestamp queries exist;
  - the share of frames showing a stand-in (stale or coarse);
  - for every input, the time until the frame is exact. The engine reports exactness per frame, and the bench checks it by comparing that frame with a fresh render.
- **Gates (acceptance criterion 2), on the full-speed devices:**
  - presented frame interval p95 ≤ 16.7 ms and p99 ≤ 20 ms during every movement scenario, worst reported, no frame over 50 ms without an explanation;
  - main-thread engine and patch work ≤ 8 ms at p95;
  - glass, blur and small text exact within 250 ms of movement stopping (pan, zoom, drag), at p95, and everything else exact by then too;
  - after an edit, exact within 250 ms at p95 for edits whose dependency closure fits a frame's budget, with the stand-in share reported for larger ones;
  - opening the kit's heaviest page: a useful first image within 1 s, exact within 3 s, measured on real GPU hardware (confirmed by the lead maintainer on 2026-11-19; gated in the engine's bench cases, `bench/file.spec.ts` with `BENCH_RENDERER=engine`, on hardware adapters).

  On WebGL2 the same suite runs and reports, gated only against regressions (criterion 1: supported, may be slower).
- **When they fail:** if these fail on the phase 1 vertical slice, cache granularity, pass scheduling and batching are revisited before more features are built, and if that fails too, the engine choice. The trigger is a measured limit and a concrete alternative.

## Language and libraries

| | C++ with Skia | Rust with Vello (chosen) | Rust with our own renderer on wgpu |
| --- | --- | --- | --- |
| WebGPU on the web | The npm CanvasKit (0.42.0, 2026-08-18) ships WebGL (Ganesh) builds only. Upstream's `compile.sh` accepts `webgpu` (Graphite on Dawn, Ganesh off), so a build path exists, but nobody publishes a supported build; we'd own its build and integration. Graphite ships in Chrome natively. | `vello_gpu` 0.4.0 (2026-11-11) on wgpu 30, drawn in the spike on Chromium's WebGPU and on WebGL2 | wgpu 30 |
| WebGL2 | Ganesh, mature (Flutter, CanvasKit) | wgpu's GL backend, shared with our passes (validated in the spike; wgpu calls WebGL2 downlevel, best effort) | wgpu's GL backend |
| CPU path | Skia's raster backend: mature; a different rasteriser from its GPU backends | `vello_cpu`, sharing `vello_common`'s coverage with `vello_gpu` | Ours to build; tiny-skia is one option, with its own edges, no filters, 100 to 300% slower than Skia on ARM (its README) |
| Code size | npm CanvasKit default build 7.32 MB raw, 2.93 MB gzipped; a stripped build ("about half") is the fair comparison and wasn't measured | The spike's builds (no gradients, images, masks, full glass or text atlas yet, so a lower bound): see the spike's table | Smallest renderer, largest effort |
| Custom rules | SkSL runtime effects: one source for CPU and GPU, a real advantage, though not bit-identical across backends either, and CanvasKit's bindings may need extending | Our passes, twice, under the contract and the CPU oracle | Everything ours, twice |
| Maturity | Very mature | Pre-1.0, active (main at 84ffc24, 2026-11-16), weak API stability (0.3 renamed the crate, 0.4 changed renderer construction and images); mask layers and some blends panic on the GPU, its blur is approximate and its glyph cache experimental, all of which we route around | wgpu mature; the renderer ours |
| Toolchain | gn, ninja, Python and emsdk 4.0.7, a 4 to 8 GiB checkout | cargo and wasm-bindgen from a folder's `mise.toml` | As Vello |

**Why Rust and Vello** (the lead maintainer approved this direction after the review):

1. **The browser target exists today.** Vello draws through wgpu on WebGPU and on WebGL2 with our passes on the same device, demonstrated in the spike. Skia's WebGPU build for the web is a path we'd have to build and maintain ourselves.
2. **One coverage implementation for both backends,** so CPU-GPU differences are arithmetic, not two rasterisers' edges.
3. **Size.** The CPU engine is a fraction of resvg, and the WebGPU engine a fraction of CanvasKit's npm build. Both are lower bounds; the size budget is a phase 1 gate.
4. **A small, reproducible toolchain** in our monorepo and CI.
5. **C++ isn't what makes Figma fast.** Its own renderer, retained GPU state and its own compositing are, all of which this design has. C++ with Dawn (emdawnwebgpu ships prebuilt packages) is a real route, but it means owning flattening, coverage, glyph caching and a CPU rasteriser too, which is the most work of the three. Neither language makes a capped isolate recover from exhaustion by itself; decision 0033's fresh instance does.

**What would change it.** A reproducible custom Skia build (Graphite on WebGPU plus its CPU backend with runtime effects) that fits the browser and Worker budgets and clearly lowers the total work. Or measured limits in Vello's preparation, small paths or resources that caching and batching don't fix, which would favour a renderer of our own on wgpu. A failure confined to Workers could move headless rendering elsewhere without changing the browser engine.

## Paired passes: the maintenance policy

- **Every pass has a Rust reference and a WGSL version,** changed together. A change to a formula changes the reference, both backends and their tests in one pull request.
- **Parameter layouts and constants are generated** from one Rust definition into both (uniform structs, tuning constants such as `DEFAULT_GLASS_TUNING`), so they can't drift.
- **Each pass lands with a parity cell,** exact assertions for its identities, and its CPU-GPU scores.
- **Paired code is measured and its fault history kept.** If keeping two copies becomes a recurring source of faults, a small expression generator for pointwise formulas (blends, colour maths) is the next step.
- **What doesn't qualify:** a general shading language, and WGSL interpreted on the CPU. naga parses and translates WGSL for GPUs; it doesn't execute it. Neither is planned (criterion 5: paired passes are acceptable while small and guarded).

## Migration, behind a switch

The switch is a per-user setting and a URL flag (`?renderer=engine`), off by default until phase 5. A page with an unsupported operation, or a failed probe, stays on the canvas renderer automatically.

**Gates grow with the features.**
- During phases 1 to 4, each phase is gated on the parity suites and kit frames its features cover, with documented per-feature differences allowed (criterion 4), plus the interaction gates for the scenarios it covers, plus patched-equals-fresh.
- Default-on (phase 5) needs the whole matrix: every Figma suite, both kits with no frame worse, both GPU backends, resource stress, the product flows below, and the interaction gates on the devices of criterion 1.

0. **The spike** (this record): done.
1. **The engine package and the vertical slice.** This is the commitment point: the slice either meets its gates, or the design or the engine choice is revisited.
   - **The package:** `packages/engine`, the crate with its WebGPU, WebGL2 and CPU builds and their TypeScript bindings, and size budgets per build.
   - **The builder:** the display-list builder, incremental, beside `Scene` in the editor, with the protocol checks and caps.
   - **The render graph,** semantically complete for sources, scopes, readers, masks and filters, even where a pass is still temporary.
   - **The glyph atlas** for saved outlines and shaped text.
   - **One exact stack:** glass, blur, a separable and a linear blend, and a mask inside a faded frame, on both backends.
   - **Forced WebGL2** on that stack, with device and context loss and the fallback rules.
   - **The conformance suite:** CPU against GPU, patched against fresh, unsupported operations failing, run in CI on the CPU and SwiftShader.
   - **The interaction suite** on `tools/gpu-bench` and the laptops, on the kit's heaviest page.
   - **The bounded export prototype** and the full-runner memory test.
2. **Pan, zoom and drag** on the engine for everything the slice supports, with the canvas renderer for the rest.
3. **Effects to parity:** every blend, exact shadows and blurs, glass on every shape, masks, background and progressive blur, noise and texture. Each lands with its reference, its cell and its kit frames.
4. **Headless:** `renderPng` on the CPU build with streaming output; resvg leaves the agent runner.
5. **Default on, then retire** the canvas renderer after one release behind the switch, with `glass.ts`'s WebGL, `luminance.ts`, `linear-blend.ts` and the tiles' stand-in machinery.

**Risks:**
- **Vello is pre-1.0 with weak API stability.** Pin exact versions (the spike pins `=0.4.0`), wrap only the subset used (fill, stroke, clip path, opacity layer, gradient, image), keep lockfiles, and vendor or patch when needed (criterion 5).
- **Two copies of every pass:** the contract, the oracle, and the policy above.
- **Text preparation:** the atlas is phase 1 work, measured on the kit's text-heavy pages.
- **Readers in volume.** An edit under hundreds of overlapping readers really does need them all recomputed. The graph limits the work to the dependency closure and to tiles on screen, shares equal blur pyramids, and refreshes progressively, within the freshness gate where it fits a frame and reported where it doesn't.
- **Command submission.** The spike submits one command buffer per segment and kernel (132 a frame). The engine batches passes into few encoders per frame, reuses pipelines, bind groups and uniform buffers, and bounds each encoder's work (vello#1246 reports a stall from one huge command buffer).
- **Download:** the WebGPU module is small; the WebGL2 module isn't, which is why it loads only on fallback.

## Product flows before the canvas renderer retires

A bitmap engine provides none of these by itself; each needs acceptance coverage before phase 5:

- **Accessibility:** the layers panel and DOM descriptions for canvas objects, focus, keyboard-only selection and editing, screen-reader text, reduced motion.
- **Text input:** caret and selection in step with the engine's frame, IME, browser zoom and device pixel ratio changes, missing-font transitions (saved outlines are a rendering fallback, not the editable text), the clipboard.
- **Collaboration:** remote cursors and selections, comments, guides and hover during patches and camera moves, with overlay work scaling with visible collaborators, not with the scene.
- **Raster export:** PNG and JPEG transparency, scales, contextual backdrops (0039), streaming large images, export-panel previews, missing and reduced asset notes.
- **SVG, PDF and printing:** vector text and paths, documented approximations of backdrop effects, print layout and resolution.
- **Thumbnails and previews:** browser and server, requested size, exact output, deterministic per revision, no overlays.
- **Lifecycle:** opening and switching pages, resizing, sleep and resume, device and context loss, memory pressure, switching renderers mid-session without losing edits.

## How we measure

**This VM has no GPU.** Chromium's WebGPU and WebGL2 here run on SwiftShader, a software adapter (`isFallbackAdapter: true`). Its timings mean nothing about a GPU.

What can be measured here:
- **Correctness:** the parity scores above, for the CPU, the GPU path on SwiftShader (the same shaders a GPU runs) and the WebGL2 path, against Figma, the canvas renderer and each other.
- **Memory:** the engine's WebAssembly memory, which only grows, so after a render it's the peak; HarfBuzz's beside it; the workerd process's resident memory.
- **CPU-backend timing** in workerd (from outside the Worker, whose clock stands still while it computes), in Node and natively. The VM is shared (load averages of 9 to 17 on 4 cores), so take medians, and compare against a baseline run, not a budget.

**What needs real GPUs:** the interaction gates above, on `tools/gpu-bench` (planned, in another PR) and the target laptops. The spike's browser spec reads its input from the environment (`SPIKE_FILE`, as `BENCH_FILE` names a converted kit; `SPIKE_BACKEND`, `CHROMIUM_PATH`, `SPIKE_CHROME_ARGS`), so the bench runs it unchanged.

## The spike

`tools/render-engine-spike` (not a product switch; see its README):
- the engine crate (`engine/`: display list, executor, CPU and GPU backends, passes in Rust and WGSL);
- the board-to-display-list builder in TypeScript (`src/board.ts`);
- a Worker with the CPU build and HarfBuzz (`worker/`);
- a page and a Playwright spec for the GPU builds (`page/`, `e2e/`);
- the score (`src/compare.ts`).

**The board** is the "Sliders" component set of a large iOS UI kit: 440 × 1084, drawn at 2× (880 × 2168), 290 layers. It has:
- fills;
- strokes, including a dashed one and per-side ones;
- SF Symbols drawn from saved outlines;
- 45 drop and inner shadows drawn, many blended by linear dodge or burn;
- 5 layer blurs;
- multiply and linear burn layers;
- five glass knobs.

It reads the kit as converted by kit-parity at `3972943cb5b5b001`, the cache the canvas renderer's latest kit run drew from. The cache first named for the spike, `d9faee5604607ab1`, predates decision 0037's saved outlines and 0039's glass settings.

**What the spike cut:**
- Glass handles boxes only. Its rim direction comes from the box's exact distance rather than the blurred height's slope, and it reads without mipmaps.
- Shadows and layer blur use Vello's blur.
- Gradients, images, masks, background blur, vectors, noise and non-separable blends aren't drawn: refused if a board uses them, none on this one.
- Nothing is retained between frames.

| Measurement | Result |
| --- | --- |
| WebAssembly, CPU build (vello_cpu, passes, decoder) | 389 KB raw, 150 KB gzipped, plus 11 KB of wasm-bindgen JavaScript (resvg today: 2,479 KB raw, 949 KB gzipped) |
| WebAssembly, WebGPU build (vello_gpu, wgpu, WGSL passes, and the CPU path) | 718 KB raw, 267 KB gzipped, plus 78 KB of JavaScript |
| WebAssembly, WebGL2 build (the same on wgpu's GL backend) | 2,774 KB raw, 989 KB gzipped, plus 81 KB of JavaScript; both backends in one module: 2,843 KB, 1,012 KB gzipped |
| Display list | 116 KB: 530 ops (213 fills, 18 strokes, 37 clips, 50 blurs, 10 opacity groups, 50 layers drawn apart for a blend pass, 5 glass) |
| Peak memory in the Worker | Engine 18.5 MiB of its 25 MiB cap, the same over ten renders; HarfBuzz 0.4 MiB beside it with Inter loaded and a line shaped (not the full runner: see "Tested as the whole agent runner"). The workerd process grew 28 to 30 MB on the first render (the engine's memory, its compiled code, the request) and 24 MB more when the 7.6 MB of pixels were returned (copies of the response, which streaming output removes). |
| CPU render time in workerd | 201 ms median (request less an empty request; nine runs at a load average of 9 to 12 on 4 cores); 594 ms in a later run at a load average of 19 to 28. A latency estimate, not deployed CPU accounting. |
| Where the CPU's time goes (warm, in Node) | Rendering segments 45 to 70 ms, layers drawn apart 32 to 80, the blend pass 17 to 36, glass 25 to 70 |
| GPU render time | **Software adapter (SwiftShader), not representative.** WebGPU: median 2.8 s in a quiet run and 10.2 s at a load average of 27; 132 command buffers a frame. WebGL2: median 2.2 s. |
| Start-up, software adapter | WebGPU: module 223 ms, engine created (pipelines compiled) 301 ms. WebGL2: 432 ms and 1,403 ms. |
| CPU (Worker) against CPU (page) | Identical |
| WebGPU against WebGL2 | Identical (both on SwiftShader; real GPUs will differ by their drivers, which the interaction suite records) |
| GPU against CPU | Mean 0.13 (over white and black), p99 2, max 5; alpha mean 0.11, max 5; worst 32 × 32 tile 1.69; no pixel more than 16 apart. Inside the tolerance on both backends. With `vello_cpu`'s float pipeline, mean 0.05, max 4, at 1.7× the CPU time. |
| Against Figma's render | GPU mean 0.52 (kit parity's own score 0.52), worst tile 17.0 at a glass knob, 542 pixels more than 16 apart in that tile. CPU 0.58, worst tile 16.3. The canvas renderer today: 0.22, worst tile 6.8. |

**Against Figma, the spike is worse than today's canvas renderer.** That's a demonstrated deficit, not a measured attribution. By section of the board (GPU against canvas, each section's share of the frame mean):
- idle knobs 0.126 against 0.049;
- pressed knobs with glass 0.323 against 0.114;
- disabled 0.072 against 0.053.

The worst tiles are at the glass knobs, and the shadows around the white knobs show Vello's blur's box edges. So the spike's glass shortcuts and Vello's blur are the likely causes, to be confirmed by ablation when the exact passes land.

What the spike found, all now in the design above:

- **Vello renders each scene from an isolated root.** Over pixels an earlier scene drew, a Vello blend layer blends with nothing (the kit's white multiply over the glass came out solid white). So every non-normal blend is the engine's pass, and clips are clip paths, which don't isolate.
- **`vello_cpu` visits its whole target on every render,** even an empty scene: 5 ms per segment natively for this board. Rendering each segment only in its rows brought that to 1 ms and the board's native render from 290 to 890 ms down to 190 to 310 ms (three runs each, noisy VM). Streaming output tiles (above) builds on the same fact.
- **Vello's Gaussian blur is approximate and clipped at 3σ,** which shows on large shadows. Shadows and blurs use the reference Gaussian.
- **Readers set the pace.** 25 of the frame's flushes are for passes: each blended layer and each glass ends a segment. The render graph runs them when their prefix changes, not every frame.
- **wgpu's WebGL2 backend needs non-blocking polling** on the web (above).

## The review, item by item

The independent review (head 9157d37) asked for six changes before the architecture is settled, and six more it should have. Phase 1 had already started from the first version of this record; these change its deliverables.

| Item | Where it's answered |
| --- | --- |
| M1. A render graph: ordered backdrops, transitive invalidation, drags in and out of cached boards | "The render graph"; patched-equals-fresh in "Parity gates"; phase 1 |
| M2. Drawpane-owned glyph caches on both backends | "Text: saved outlines and shaped glyphs"; per-glyph records in "The boundary" |
| M3. Effect-heavy real-GPU interaction tests with frame-time and freshness gates | "Interaction gates on real GPUs", with acceptance criterion 2; phase 1 is the commitment point |
| M4. One shared-texture WebGL2 pipeline, chosen and validated, its cost stated | "Fallbacks", path 2: wgpu's GL backend for Vello and our passes, run in the spike |
| M5. Bounded export memory and a full agent-runner test | "The CPU backend and exports": streaming tiles, the working-set formula, caps, the 8192 px limit, the runner test |
| M6. Stronger parity gates: alpha, local defects, unsupported operations, patched equals fresh | "Parity gates" and "The engine's contract"; the spike's score and spec now enforce the first three |
| S1. Migration gates by feature set | "Migration": gates that grow, the full matrix for default-on |
| S2. Maturity, Skia and size wording | "Language and libraries" corrected: Skia's WebGPU build path exists but isn't shipped; sizes are lower bounds; Vello's API instability and gaps stated |
| S3. The hardware bench | `tools/gpu-bench` is planned (another PR), not existing; the spike records the engine's own adapter beside the browser's |
| S4. Display-list lifecycle | "The boundary": versions, validation, caps, handle generations, atomic revisions, reference counting, local transforms and rebasing, corner smoothing's single producer |
| S5. Product flows | "Product flows before the canvas renderer retires" |
| S6. Paired-pass policy | "Paired passes: the maintenance policy" |

## Consequences

- The editor gets a renderer that keeps work between frames, on a graph that knows what each picture depends on. Pans, zooms and drags become composition where the graph allows and exact re-evaluation where it doesn't.
- Headless renders become the same engine as the canvas, within a measured tolerance, with glass and background blur drawn exactly, in bounded memory. resvg, its cap and its whole-font copies leave the agent runner.
- The repo gains a Rust toolchain, scoped to the engine's folder through `mise`, and a WebAssembly build step in CI.
- Every Figma rule has two homes until phase 5: the canvas renderer and the engine. New rules land in the engine first once phase 3 starts.
- Phase 1 is a reversible experiment with a commitment point: its vertical slice on real hardware decides.

## Amendment: phase 1 as built (2026-11-19)

Phase 1's first part is in `packages/engine` (the crate, its two builds and their bindings), `packages/editor/src/engine` (the display-list builder) and the editor behind `?renderer=engine`. The display list is specified in [0040-display-list.md](0040-display-list.md). This records what it does, where it differs from the record above, and what phase 1 still owes.

**What the engine draws:** transforms (relative to the parent, composed by the engine), opacity (isolating where the layer fades as one, multiplied down otherwise) and normal blending, clip paths, solid and gradient fills (linear, radial, angular; colours interpolated unpremultiplied, as the canvas does), image fills in every scale mode (one upload per image, halved levels shared by both backends), strokes (centre, and inside and outside by clipping; fitted dashes, caps, joins, end markers, per-side widths as regions), text from HarfBuzz's shaping and from saved outlines (decision 0037), with decorations and list markers, and corner radii. Everything else is flagged per layer by the builder and refused by the engine, so its page falls back to the canvas renderer whole: shadows, blurs, glass, noise, texture, masks, every non-normal blend, corner smoothing (until the shared squircle function lands), text strokes outside the glyphs, and text whose outlines aren't to hand. A refused record counts its box grown by its reach, so it can't be culled while it may show.

**Where it differs from the record:**

- **Glyph cache keys and storage.** A glyph's identity is its interned outline (saved outlines by their path data, shaped glyphs by the shaper's own glyph objects) rather than a `glyphId` or a font hash and index; the effect is the same and works for both sources. Device scale is keyed exactly (its f32 bits) rather than in quarter-pixel steps, and the subpixel phase in eighths on both axes rather than quarters horizontally, so a cached glyph lands within 1/16 px of its outline. Masks are RGBA8 (vello_gpu's alpha-mask tint reads alpha from a filterable texture), one 2,048² atlas page on the GPU and one pixmap per glyph on the CPU, evicted least recently used per glyph at a frame's start. When the atlas is full, its least recently used shelf (one not drawn from in the frame being drawn) is emptied and reused, never the whole page. Masks are keyed by a glyph definition's serial, which no other definition ever has (across resets and fresh lists), and a glyph is immutable while a record uses it. Only solid fills use masks; gradient-filled text fills its outlines. Masks are used up to 160 device pixels a side. Budgets: 32 MiB on the GPU, 4 MiB in the Worker.
- **Invalidation is resolved on the device, for a camera** (`dirtyFor`): a patch's changes in page units, grown by 1.5 device pixels, then readers in paint order. A place recorded before a structural change in the same message counts as beneath every reader. The fuzz tests found both rules necessary: readers sample whole pixels, and paint-order numbers from before a reorder aren't comparable with those after.
- **Handles have no generation:** layer handles are never reused within a session, so a stale one can't name another layer.
- **Coordinates:** transforms are f64 on the wire and composed in f64; paths are f32 in their layer's units. No rebasing near the camera is needed for that precision.
- **Exports:** bands of at most 2 MiB of rows (64 rows at 8,192 px; the engine refuses more), drawn in tiles of at most 1,024 columns, with the scene kept in whole-frame coordinates so tiles are bit-identical to a whole frame. The PNG streams band by band (rows filtered by `Sub`, deflated as they come), and a Worker returns it as a stream, so neither the picture nor the compressed file is held whole. The 8,192 px limit is enforced and named. An export is refused before its first byte when the page holds anything the engine doesn't draw (anywhere on it, not only in the crop), when another export streams, or when its working set wouldn't fit beside what the engine holds under the Worker's 25 MiB; while it streams the engine refuses changes, so it draws one revision. The reduced-scale fallback for oversized reach is phase 4's; phase 1 refuses reach past 512 px, summed through readers.
- **Worker memory.** The shipped Worker module's memory section holds its 25 MiB maximum (linked with `--max-memory`), and the workerd test checks those bytes rather than capping a copy. Its budgets are smaller than the browser's (`WORKER_LIMITS`): messages 8 MiB, the graph 10 MiB, images 6 MiB, glyph outlines 4 MiB. After a trap (memory that can't grow) the facade renews the module's instance from the module already compiled, so the next render works; a test traps it on purpose.
- **Revisions and fresh lists.** A patch must make `base + 1`; a fresh list must move the revision forward. A fresh list is built beside the graph it replaces and swapped in whole, so a refused one changes nothing (both graphs count against the graph's budget while it's built). The builder is told what came of each message and answers a refusal with a fresh list past the engine's revision.
- **Generated geometry is budgeted.** A frame may generate 4,000,000 path elements (dashes, glyph runs expanded, shapes); glyphs off the viewport aren't expanded; dash patterns too fine for their path are refused before stroking; arcs have a tolerance relative to their size; a transform that overflows on the device is refused; at most 512 clips and layers are open at once. Each is `Limit`, and the page falls back. The count covers the paths the engine builds (an outside clip's box and the shape cut out of it included), shared by all the passes of one frame (a pan's strips); the segments Vello makes flattening curves and expanding strokes come after it, and are bounded by the paths it was given. Unreadable text's stand-in bars are bounded by the text's characters, in the canvas renderer too.
- **A frame texture holds its own camera, exactly** (`plan.rs`). Only the very same camera reuses a frame as it was; a move under half a pixel keeps the frame as a stand-in; a pan (by whole pixels, or a fractional one by the nearest whole pixel) shifts the frame and draws the strips it uncovers, the texture keeping the old camera's numbers shifted by whole pixels; a zoom scales the last full frame only while that still covers half the view, and otherwise the whole scene is drawn. Error can't accumulate on a frame reported exact.
- **Engines on one module.** A trap kills every engine on the module's instance (an epoch moves on), not only the one that trapped, and the facade's objects are detached from wasm-bindgen's finalizers, so nothing calls into, reads from or frees in the instance that replaces it. In the editor, a read-back on its way is dropped when a newer content frame is the canvas renderer's, or the page or the size changes.
- **Stand-ins and exact frames in the editor.** Interactive frames may be stand-ins: a pan by whole device pixels shifts the last frame on the GPU and draws only the strips it uncovers; a zoom scales the last full frame; unreadable text draws as bars and specks are skipped. Once the camera rests (120 ms), the editor draws an exact frame, and reports a frame exact only when it is (no stand-in, no level of detail) and on screen. A read-back frame shows once it lands; which canvas shows changes only when a content frame is drawn.
- **Retained scene fragments aren't possible on Vello 0.4.** Its scenes have no append or recording to replay under another transform: `fill_path` turns geometry into device-space strips at once. So phase 1 reuses pixels (the pan and zoom stand-ins above), and retained, re-transformable pictures are phase 2's board textures. Nothing in phase 1 stands in their way: frames are already drawn into the engine's own textures, a frame can be made from another, and the graph's dirty regions are in place.
- **Adapters.** The editor uses a hardware adapter at WebGPU's core level, else a hardware one at compatibility level (some drivers offer only that, through OpenGL ES), else refuses with a typed reason (`NoAdapter`) and the canvas renderer draws; a software adapter only when `drawpane:engine-software` allows it (headless tests do).
- **Presentation in headless browsers.** Headless Chromium loses a WebGPU device as soon as a WebGPU canvas presents (SwiftShader here, NVIDIA on the GPU bench). The editor's e2e reads frames back through a buffer (`drawpane:engine-present` = "readback") and checks that the default presentation falls back cleanly; presenting on a real laptop is still to be checked by hand.
- **Compatibility mode** is requested by asking `navigator.gpu.requestAdapter` for `featureLevel: "compatibility"` while the engine creates its device (wgpu 30 can't say it), and the device takes the adapter's own limits. The editor picks it when only compatibility mode reaches a hardware adapter (see "Adapters"). **Vello 0.4 can't run in compatibility mode:** on the GPU bench's T4 through OpenGL ES, every one of its pipelines is refused because its vertex outputs interpolate `flat, first`, which compatibility mode forbids. The engine makes its pipelines inside validation and out-of-memory error scopes when it creates its device, so such an adapter is refused there, typed (`NoAdapter`) and with that reason, and the canvas renderer draws. Running in compatibility mode needs Vello's shaders to use `flat, either` (a patch to the vendored Vello, or upstream); until then, WebGPU without core level means the canvas renderer.
- **Failures are typed everywhere across the facade:** every call answers a `Result` (dirty regions, children, unsupported records, `gpuFinished` and `gpuPixels` included), a PNG stream errors with an `EngineFailure` that keeps its code, and the editor catches anything thrown on the way and falls back. A page that falls back raises `drawpane:renderer-page-fallback` with what it holds; the session's fallback stays `drawpane:renderer-fallback`.
- **Resources are released:** glyphs on their last record (`glyphFree`), images when no record on the page paints them; the engine's own GPU allocations (images, the atlas, its frame textures and depth buffers, and read-back buffers while they're in flight) count against 768 MiB, and at most two read-backs are in flight. What Vello allocates inside its renderer (strip, tile and alpha buffers, and their growth with a scene) isn't in that count: Vello 0.4 doesn't report it. An image upload is refused before its bytes are copied when it's past the image budget with its levels. A canvas that can't take a frame (its surface lost, or a validation error) is a failure after one reconfiguration.
- **Text in Workers.** harfbuzzjs can't give glyph outlines in a Worker: its draw callbacks need WebAssembly compiled at run time, which Workers forbid. The shaper now says so (`ShapedText.outlines: false`) instead of answering empty outlines, and the builder refuses that text. Until phase 4 brings outlines another way, a Worker draws text from saved outlines or from outlines handed to it. The workerd test hands it the runs shaped in Node, as a file's saved outlines would arrive.
- **Readers:** the render graph orders and invalidates by them, and the tests exercise it with a reference reader (a box mean over the backdrop, clipped like any paint), but no real reader is drawn yet.

**Phase 1 still owes:** the one exact effects stack (glass, blur, a separable and a linear blend, a mask in a faded frame), forced WebGL2 on it, the interaction suite on real GPUs and laptops with its gates (the bench cases are in place and gate the confirmed targets where the engine draws a page on a hardware adapter), glyph-atlas measurements on the kit's text-heavy pages, and the CJK half of the full-runner test. Those decide the commitment point.

**Measured** (this VM: 4 arm64 cores, shared, no GPU; SwiftShader timings aren't representative):

| | |
| --- | --- |
| Worker module (CPU) | 537 KB of WebAssembly, 208 KB gzipped (budget 400 KB); glue 28 KB |
| Browser module (GPU and CPU) | 909 KB, 340 KB gzipped (budget 1 MB); glue 100 KB |
| CPU against GPU (SwiftShader), 69 parity cells drawn | mean ≤ 0.129, p99 ≤ 1, worst 32 × 32 tile ≤ 0.35, no severe pixels (tolerance 0.25, 4, 2, 4) |
| Worker build against browser build, CPU | bit-identical on every cell and on the package's own scenes |
| Engine against Figma, by suite (cells drawn) | strokes 0.06 (17), fills 0.27 (10; 15 blend cells fall back), lists 1.74 (6), text 2.60 (20), text ranges 1.32 (3), vertical trim 1.47 (12), glass-context's one plain cell 0.02; every drawn cell at least 0.21 inside the canvas renderer's threshold. The phase 3 suites (shadows, blurs, glass, masks, grain, linear blends) fall back cell by cell. |
| Engine against the canvas renderer, the editor's e2e scene | mean 0.62, p99 19, worst tile 3.7 (text: the engine fills HarfBuzz's outlines where the canvas draws plain text with the browser's rasteriser) |
| Patched against fresh | bitwise on the CPU: random sequences of 12 patches on four seeds in Rust (with and without readers, every changed pixel inside the dirty region, and a fresh list on the warmed engine every fourth step), and 400 random editor sequences through the builder; on screen, bitwise on the GPU once exact after pans, zooms and edits |
| Worker build in workerd, an 8,192 × 8,192 export of 7,200 layers with real text, beside HarfBuzz and the headless editor | isolate peak 60 to 66 MiB over runs (JS heap 41 to 48, engine 16.9 of its 25 MiB cap, HarfBuzz 1.6); 8,193 px refused with the limit named, and the isolate keeps working |
| The display list on the scale corpus (decision 0027), 500,021 layers; its largest page, 40,401 layers | a fresh list in 867 ms median (1,025 ms from a new builder; 11.9 MB), applied in 186 ms; before this round 1,247 and 330 ms. A drag's patch built in 0.6 ms and applied in 0.1 ms; a restyle 0.2 and 0.4 ms; a hundred restyles 10 and 1.2 ms. The VM's load was about 7.5 on 4 cores. |
| CPU backend frames on that page, 1,440 × 900 | the whole page at fit 605 ms (text as bars); 100% 20 ms, a pan there 26 ms (median) |

**On the GPU bench** (`pnpm gpu-bench --modes webgpu,gpu --env BENCH_RENDERER=engine -- bench/canvas.spec.ts`, a Modal T4, 10,000 layers at 2,880 × 1,800; Chromium's compositing is software in `webgpu` mode, so frame intervals there say little):

| content time, p50 / p95 ms | before this round | now |
| --- | --- | --- |
| pan, whole page | 66 / 69 | 0.8 / 2.6 |
| pan, 25% | 78 / 84 | 3.1 / 4.3 |
| pan, 100% | 12 / 13 | 1.7 / 2.0 |
| zoom, whole page | 83 / 150 | 0.3 / 0.4 |

Every pan frame was a shifted stand-in (0.2 ms encoding, 0.3 ms in the renderer; the GPU 8.6 ms p50). An exact whole frame, drawn back to back, breaks down as: encoding 92.5 ms p50 (the walk and Vello's strips, on the CPU), the renderer's preparing and uploading 10.9 ms, submitting 0.1 ms, the GPU 16.6 ms p50 (73 p95), and a read-back of the full frame 47.9 ms. So the exact frame after the camera rests is one long frame on a page this size: the CPU's encoding is its cost, and retained board pictures (phase 2) are what remove it. In `gpu` mode core WebGPU is SwiftShader and compatibility mode can't run Vello (above): the engine refuses and the canvas renderer draws, holding 16.7 ms.

**Opening the heaviest page:** building and applying its fresh list takes about 1.05 s on this loaded VM, against the confirmed 1 s for a useful first image on real hardware. What made it faster: transforms from the layer's own box (no world matrices inverted), the list written as the page is walked (no records held, the buffer sized from the last list, no copy at the end), hidden text not shaped, and the engine reading a fresh list once. Shaping only the visible boards' text first is the next step if the hardware runs need it.

## Amendment: phase 2, board textures (2026-11-19)

Phase 2 keeps the page's picture between frames, so pans, zooms and the exact frame after the camera rests are made from pixels already drawn instead of a scene encoded again (Vello 0.4 can't replay scene fragments, see phase 1). The model is in `packages/engine/rust/src/tiles.rs`, decided apart from either backend and tested natively; `engine.rs` runs it on the CPU (the tests' reference), `gpu.rs` on the GPU.

**What's cached: tiles of the page's own picture.** The page is a scope (see "The render graph"), so what's kept is its composited result over 512 × 512 device pixels of a grid, background included: the final picture there. That is "each board, or each tile of a large board", without drawing boards apart:

- a board drawn alone and laid over the page differs from a fresh render by rounding at every translucent edge (source-over isn't associative in 8 bits), so a frame made of board pictures could never be bitwise exact;
- a frame that doesn't isolate isn't a scope: in phase 3 its pass-through blends and readers read the page through it, so its picture alone would be wrong;
- caching boards and the page's tiles would hold the same pixels twice (see "Retained GPU state").

**Exact by construction.**

- A *level* is a raster scale (device pixels per page unit) and a phase (where the page's origin falls within a device pixel). A frame at that scale and phase lies on the level's grid: frame pixel = grid pixel + a whole-pixel origin.
- A tile is only ever drawn under its own view, a function of its level and its place. Its pixels never depend on which frame asked for it.
- So a frame at rest is copies of tiles, and an exact frame is bitwise what an engine that never drew anything makes from the same list (on the CPU, which the tests check), and within the CPU-GPU tolerance of the CPU on the GPU.
- Against a frame drawn whole under the camera (phase 1's `render_cpu`, still what exports draw), tiles differ by at most 2 levels: coordinates differ in their last bits. The loading checkerboard is anchored on the pixel the page's origin falls in, not on the frame's corner, so tiles and whole frames draw it alike.

**Stand-ins, never reported exact.** Where the frame's own tiles aren't drawn yet, it shows, back to front:

1. the last frame, moved and scaled;
2. tiles of other levels within 4× of the scale, scaled (the nearest on top);
3. the frame level's own tiles, stale ones included.

Exact means every tile the frame shows is up to date and drawn without level of detail. A stale tile, a scaled level or the last frame anywhere on screen makes the frame a stand-in.

**Levels while zooming.** While the scale changes, tiles of the passing scale would be wasted a frame later, so none are drawn. Where nothing stands in (zooming out past what was drawn), *ladder* tiles are drawn instead: scales of the form 2^(k/2) at or below the zoom, with level of detail (text too small to read as bars, specks skipped). Ladder tiles are only stand-ins. The first frame at a new scale that doesn't move draws the exact level.

**Invalidation through the render graph.**

- Each applied message's changes (where the touched records painted before and paint now, page units, with paint order) are turned into each held level's grid pixels by `Store::dirty`: grown by 1.5 device pixels for anti-aliasing, with every reader they reach, transitively. Every tile they touch is marked stale.
- Readers join from a worklist (a fixed point): a reader that reads after its children reads what readers inside it paint, and those come later in paint order. A record reading both before and after its children counts as reading after them. Each reader checks each change once: a pass checks only the changes added since its last, so a chain of R readers against D changes costs at most R × (D + R) checks, however the chain runs against paint order (`Store::dirty_checks`, the review's N2).
- Where a record paints is its ops' bounds, each stroke grown by how far its outline can reach: half its width times its miter limit for mitered joins, √2 for square caps, plus a unit. The wire's miter limit is taken as at most 1,000, for drawing and bounds alike, so bounds stay finite and true (`0040-display-list.md`).
- A fresh list (a page switch, a reload, a recovery after a refused patch) drops every tile and forgets the last frame: it shows a page that's gone.
- An image put or dropped invalidates the records that paint it (`Store::image_users`).
- A change of background or of the readers' reach drops everything.
- Glyph masks are keyed by a definition's serial, which is never reused, so they can't go stale. Saved glyph sets edited and faces arriving reach the engine as patches of the text that uses them (phase 1's builder fixes), so their tiles go stale like any edit.

**Scheduling: never one long frame.**

- A frame plans its tiles over the part of each on screen. It draws first every tile nothing can stand in for (a page just opened, a jump), whatever its budget, then the others in order of distance from the view's centre while its budget lasts: 4 ms while the camera moves, 12 ms once it rests (`MOVING_BUDGET_MS`, `REST_BUDGET_MS` in `engine-view.ts`). A tile past the budget waits for a later frame; the frame goes on to the next, so nothing that must be drawn is ever left behind one that can wait. Every frame draws at least one tile.
- **Between frames at rest**, the engine draws what the next frame wants (`renderGpuAhead`, `EngineView.ahead`): the tiles the last frame shows that aren't up to date, nearest the centre first, then the tiles round the view, in slices of 16 ms (`IDLE_SLICE_MS`; at least one tile each), compositing and presenting nothing. When the camera comes to rest where the last moving frame was drawn, that frame stays on screen and the slices start at once; when the tiles it shows are all drawn, the exact frame is drawn from the slice that finished them, not a frame later. Tiles round the view (ahead of a pan, and a coarser level a zoom out stands on) are drawn the same way, with no frame for them.
- While the camera moves, the editor draws a frame each animation frame while it isn't exact. A frame asked for with no budget (`renderGpu(…, false, 0)`: tests, exports of the view) comes back exact.

**GPU memory.**

- Tiles live in pages of 2,048² (16 tiles, 16 MiB each), drawn by Vello into their slot with one shared 16 MiB depth buffer.
- They take what's left of the engine's 768 MiB beside everything else it holds (images, the glyph atlas, frames, read-backs), less 32 MiB of headroom, and at most `tile_bytes` (256 MiB by default, a limit like the others). This is worked out every frame, so images arriving shrink the tiles, never the other way round. Pages past it go, with their tiles.
- Frames are two textures (shown, being made), with no depth buffers now that they're only composited.
- **Eviction**, when a tile needs a slot: never a tile the frame shows, drew or counts on to stand in. Other levels go first, finer ones first, then the frame level's tiles farthest from the view, then the least recently used.
- **Planned within the slots.** A frame pins what it shows and the other levels' tiles it counts on to stand in, and plans its jobs within the slots left. A zoom's ladder tiles for a part of the view are planned only if they all fit. Where a tile that only another level stands in for finds no slot, it's drawn this frame instead, freeing what it counted on, so a frame at rest always progresses. Tiles drawn ahead (round the view, the coarser level) are pinned only in slots no visible tile was promised, and a tile that still finds no slot when its turn comes is drawn straight into the frame and counted as drawn, not pending (the review's N1).
- **Degradation:** a tile the frame needs and no slot can hold is drawn straight into the frame, over the composite, through a scratch tile, and kept nowhere (`Job::direct`). If the frame's own tiles can't all be kept, the whole frame is drawn that way (`Plan::direct`). Slower, still exact, never blank.
- **Glyphs, a run at a time; a text layer as one shape.** Glyph masks are kept on the CPU on both backends (16 MiB of them by default, least recently used going first, `masks.rs`). A run of glyphs in one colour has its masks laid into one image of the run, each at its device pixel, coverage combined as source-over, and that image is drawn once, tinted: one draw a run instead of one a glyph (the densest tiles hold 85,000 glyphs in 15,000 runs), and a run's overlaps covered once. The builder puts a text layer's glyphs in a row with the same paints and size, across fragments and lines, in one run (`layer.ts`), so the layer composites as one shape where its glyphs overlap, as Figma draws it. Measured (`text-overlap` in the parity suites, half-alpha red on white, 2×): Figma covers lines set tighter than their glyphs and letters tighter than their spacing once (green 143 at its darkest, where twice would be 87); the canvas renderer covers them per glyph and line (87, and 59 three deep); the engine once on both backends (0.65 from Figma, the canvas renderer 1.06 to 2.79). The GPU's atlas (2,048², 16 MiB, allocated whole) holds the run images of the tile being drawn, cut to it, packed in rows from its top left and uploaded a write a row before the tile renders; the next tile packs from the top left again (its uploads run after the tiles before have drawn). The CPU (exports, Workers, the native tests) makes each run's image whole, every glyph of it wherever the band is, so an export's bands are bitwise its whole frame (vello_cpu rounds an image's pixels a level differently by the image's size: `fuzz.rs` found the level on CI when runs were cut to bands), at most 4 MiB pixels a run. A run whose image doesn't fit fills its glyphs' outlines, as one shape still. Before, the CPU laid its masks one over another and a layer's lines were runs of their own (the second re-check: alpha 192 on the CPU and in PNGs where the GPU drew 128); and each glyph's mask once lived in the atlas, with a shelf allocator to share it between tiles, and was its own draw: about 4 µs a glyph between the engine and Vello.

**Encoding a tile.** What a dense tile costs is its records and glyphs:

- Vello's uploads go through the queue on the web (`queue.write_buffer_with`, `queue.write_texture`) instead of its staging belt, whose buffers come back only after a map callback, so every tile allocated new mapped buffers. Vello 0.4's `vello_gpu` is vendored for this (`packages/engine/rust/vendor/vello_gpu`, `VENDORED.md`).
- Rounded corners reuse their arcs: the cubics of a quarter circle are kept per radius.
- A box's stroke with no dashes, whose corners all round at least half its width (or are square with a miter or round join), is filled as a ring between two rounded boxes, not stroked.
- A clip a record's children never reach past is left out: an axis-aligned box (rounded or not) whose children's extent sits inside it by 1.5 device pixels, corners included. Glyph masks then take Vello's fast path for unclipped rectangles.
- Glyph-run masks rasterised from the run's outlines were tried and left out: after a zoom every run misses, and rasterising them costs more than the glyphs' masks. Run images laid from the glyphs' cached masks (above) cost a copy a glyph.
- Zoomed out, a stroke under a uniform scale is drawn on the device: vello strokes to a quarter of the path's own units, so the further out the finer its curve offsetting is on the device (a fortieth of a pixel at 10%), and offsetting the curves of small strokes (icons, circles, smoothed corners) was two thirds of a dense tile's time when opening the 40,401-layer page. Scaled to its device size and as wide as it is there, the stroke is the same outline, made to the quarter pixel fills are flattened to (solid paints; other paints keep their transform). Only the scale is applied first and the translation after, as before, so a band or tile under another translation strokes the same outline.

**What phase 1's frame reuse became.** The pan-shift and zoom-scale planner (`plan.rs`) is gone. Its rule, a frame texture holds exactly the camera it was drawn for, is now the tiles' rule: a tile holds exactly its own view.

**Gates added** (all in CI):

- `packages/engine/rust/tests/tiles.rs`: seeded random walks of edits, whole and fractional pans, zooms about a point, page switches, image changes and memory pressure (slots for fewer tiles than a frame shows, and for a frame and a bit), frames moving under budgets of zero to two tiles. Every frame reported exact is compared with a fresh engine's, bitwise; every frame at rest becomes exact within a bounded number of frames; a stand-in reports what's pending. Tiles against whole frames: at most 2 levels apart. Tiles drawn ahead between frames leave the next frame exact, a fresh engine's, with nothing to draw.
- `packages/engine/rust/tests/tile_regressions.rs`, each a frame that went wrong before its fix (the phase 2 reviews): a zoom under a one-slot budget and under one GPU page of slots never shows background where the page has content; a change beneath a reader inside a reader that reads after its children leaves no stale exact tile, and reaches readers three deep; a stroke with a miter limit of 40 isn't culled from the tile its miter reaches; tiles drawn ahead can't take the slots a missing visible tile was promised; a chain of readers against paint order checks each change once; a clip left out, a box stroked as a ring and a curved stroke drawn on the device draw what they replace. (The atlas's shelf allocator, and the re-check's test of it, went when the atlas came to hold only the tile's run images.)
- `apps/web/e2e/engine-tiles-gpu.spec.ts` (SwiftShader, through the browser glue alone): the same zoom at one GPU page of slots, and a spent time budget still drawing the tile nothing stands in for.
- `packages/editor/test/engine-tiles.test.ts`: no stale tile after a saved glyph set changes, faces arrive, an image loads or the page switches, each with tiles already drawn. The builder's random editor sequences (`engine-display-list.test.ts`) now also compare the patched engine's kept tiles with a fresh engine's at every step.
- `apps/web/e2e/engine.spec.ts` (SwiftShader):
  - the on-screen frame, once exact, equals a fresh engine's GPU frame bitwise, and is within the CPU-GPU tolerance of the CPU's whole frame (so the GPU's tiles hold the picture, not only agree with themselves), after pans, zooms, edits and a seeded walk of them;
  - the first frame at a new scale is reported a stand-in.

**Measured on the GPU bench** (`pnpm gpu-bench --modes webgpu,gpu --env BENCH_RENDERER=both --env BENCH_ENGINE_PRESENT=readback -- bench/canvas.spec.ts`: a Modal T4, the 10,000-layer file at 2,880 × 1,800, the canvas renderer and then the engine on the same file in one container). In `webgpu` mode Chromium composites in software, so frame intervals there are ~27 to 40 ms for both renderers and say little about a laptop. The engine can't run in `gpu` mode (core WebGPU is SwiftShader there, and Vello 0.4 can't run in compatibility mode), so it refuses, typed, and the canvas renderer draws.

| `webgpu` mode, ms | content p50 / p95 / p99 | exact drawn after | exact shown after (read back) | slowest frame |
| --- | --- | --- | --- | --- |
| engine, pan whole page | 0.4 / 5.9 / 33.1 | 31 | 84 | 62.3 (tiles entering the view with nothing to stand in for them) |
| engine, pan 25% | 0.4 / 6.3 / 9.7 | 31 | 83 | 11.0 |
| engine, pan 100% | 0.4 / 5.2 / 5.8 | 31 | 84 | 10.0 |
| engine, zoom whole page | 0.7 / 1.0 / 1.1 | 246 (226 and 233 in two more runs) | 292 | 8.5 |
| canvas, pan whole page | 0.2 / 0.4 / 3.8 | | 33 | |
| canvas, pan 25% | 3.8 / 9.6 / 13.5 | | 37 | |
| canvas, pan 100% | 1.2 / 1.5 / 2.0 | | 31 | |
| canvas, zoom whole page | 0.1 / 7.1 / 9.0 | | 274 | |

- Exact frames drawn back to back at the bench's last camera (whole page): cold (every tile dropped first, 83 tiles: the view, the ring round it and the coarser level) 155 ms of encoding, 18 ms of renderer preparation and 8 ms of GPU (p50). Warm (from the tiles kept): 0.3 ms of GPU, nothing encoded. Phase 1 drew the same view in one frame of 92.5 ms encoding and 16.6 ms of GPU.
- Drawing every tile into a target of its own size mattered: drawn into a 2,048 px page, the same cold frame took 279 ms of GPU (Vello's work per render follows its target's size).
- **Settling after a zoom** (traced by the bench, `Settle` in `bench/frames.ts`): the zoom ends near the whole page, where each of the six central tiles holds about 1,600 records and 6,000 glyphs (about 17 ms each to encode, every mask from the cache), and the other 22 cost under 1 ms. Drawn in slices between frames, the exact frame came 226 to 246 ms after the zoom's last frame, against 307 to 345 ms when only frames drew them (12 ms each, a frame every ~28 to 40 ms here). What's left besides encoding is the first animation frame after the zoom (~30 ms) and the main thread's share of reading frames back (about 15 ms each, headless only).
- Pans settle within a frame now (31 ms): the tiles round the view are drawn between frames at rest, before the next pan, instead of a frame at a time. The pan of the whole page has a slower worst frame than before (62 ms against 44): a frame now draws every tile entering the view that nothing stands in for, where it used to stop at its budget and leave them blank (the review's B3).
- **An image placed past sampling paints nothing, decided from the record.** vello_cpu turns a sample's position into a pixel index with float arithmetic: NaN or infinity becomes an index past the image on x86 (a panic CI's random-bytes fuzz found), and a repeat's remainder (`euclid_mod`) is exact only for positions below 2^24 and indexes past the image beyond (the second re-check: a 3×3 image repeated every 1e-8 units). So an image paints only when the record's transform to the device and the image's placement each neither collapse nor blow up space (their linear parts and inverses within 10¹²), and, repeated, its positions over all the record's entry paints (its bounds grown by a stroke's reach and two device pixels) stay within 2^22. A padded image's positions are clamped, so any finite one does. Nothing in the decision depends on where the frame or tile sits, so a tile and the whole frame decide alike (the old guard bounded the inverse's translation, which they don't share). The loading checkerboard is anchored within one period of the page's origin, so its positions stay small however far the view is from it. Tests: the re-check's two cases, and a property test of 400 placements repeated or padded, scaled 1e-12 to 1e12 per axis, skewed, turned and nearly singular, none panicking, tiles within 2 levels of the whole frame.
- **Settling, round 3** (`settles` in `bench/frames.ts`): ten gestures of 20 frames each, alternating direction, clocked from the last input; drawn is when the exact frame was submitted, GPU done when the GPU finished it (`onSubmittedWorkDone`, no read-back), shown when the read-back frame was painted (this bench's presentation, software compositing). The engine, on the 10,000-layer file:

  | settle after, ms (p50 / p95) | drawn | GPU done | shown (read back) |
  | --- | --- | --- | --- |
  | zoom at fit | 203 / 245 | 232 / 266 | 242 / 290 |
  | pan at fit | 14 / 32 | 63 / 91 | 108 / 160 |
  | pan at 100% | 11 / 31 | 51 / 76 | 97 / 208 |
  | drag at 100% | 89 / 99 | 128 / 150 | 176 / 198 |

  The zoom's settle is two frames' latency (the zoom's last frame waits for an animation frame, ~20 to 40 ms here), then six dense tiles at about 9 ms each and the rest under 1 ms, drawn in idle slices. Locally, a cold redraw of the whole page went from 316 ms to about 128 ms with the uploads, corners, rings, clips and batched masks above.
- In `gpu` mode (the canvas renderer's real intervals, both runs canvas): frame interval p50 16.6 to 16.7 ms, p95 17.9 to 26.2 ms, p99 18.7 to 54.5 ms.

### Drags (phase 2, part 2)

The engine follows drags from the messages themselves: no editor API. The editor already sends a layer's move as a `transform` command.

- **Following a drag.**
  - A message that only moves records continues the drag of exactly those records, or starts one.
  - An edit beside the drag doesn't end it: a collaborator's edit, or text re-sent while its faces load. Its parts are drawn again where the edit changed them.
  - One that changes the structure, or touches the selection, ends it.
  - One that touches a record the selection is drawn inside (a board starting to fade as one, say) decides the fast path again, as a new drag: moving a picture may not be exact any more, and the parts were drawn for the old one.
  - A record set again exactly as it is, and an order that changes nothing, are no-ops: they neither continue nor end a drag, and nothing is drawn again for them. A record's hash is cleared when a `transform` moves it, so setting it back later is a change.
- **The fast path**, when moving a picture of the selection is exact by "Dragging" above: the selection is consecutive children of one parent, there's no reader on the page, and no ancestor fades as one.
  - The tiles the selection has touched are composited from three things, laid over each other in order:
    - the page painted before it (kept for the drag, background included);
    - the selection, drawn afresh at its real position each frame, with its ancestors' transforms, opacity and clips;
    - the page painted after it (kept, over nothing).
  - Paint order is split by a filter in the executor (`exec::Split`). Nodes on the selection's path are walked in every part. Paint order passes the selection after any of them, walked or culled: a culled board once left what follows it in the part below, which the random drags found.
  - It's exact but for rounding: within 4 levels of a fresh frame, since source-over isn't associative in 8 bits. So drag frames are reported as stand-ins.
  - While the selection moves, the tiles under it that the drag composites aren't drawn: they'd be stale by the next move. Once it rests, they're drawn exactly under the frame budget, and the composite stands in until then.
  - **Bounded.** The drag records a tile it touched only while a frame needs it: while the tile is kept stale (its picture may show the selection where it was), or while it's on screen under the selection now or under where the last frame drew it (that frame's pixels show it there whether or not a tile was kept, so the drag composites the tile again, without it once it's gone). A selection's footprint is taken over the tiles shown and kept, never its whole extent, so neither a huge selection nor a long drag grows the record past the tiles the cache holds. Only tiles the drag composites lose their jobs.
  - **Never blank.** A tile whose parts find no slot is drawn whole and exact, straight into the frame.
- **Without the fast path** (selected layers apart in paint order, a faded ancestor), the selection is drawn at its real position every frame: every tile the drag touched is one nothing stands in for.
- **Into or out of a board.** The editor reparents on drop, so the drop is a structural message: it ends the drag, and the layer is removed from one board and inserted in the other at its real place in paint order. If the editor later sends a provisional parent mid-drag, as "Dragging" above allows, the same happens there. Tiles an ended drag left showing its selection where it was are drawn again at once, never left as stand-ins.
- **Gates** (`rust/tests/tiles.rs`):
  - seeded drags of runs of siblings, sometimes not consecutive, sometimes with an edit mid-drag: composited frames within rounding of a fresh frame, frames without a fast path exact, and every drag bitwise exact within bounded frames at rest;
  - drags into a board and on inside it;
  - edits beside a drag;
  - a record set back after a move.
  - From the phase 2 review (`rust/tests/tile_regressions.rs`): 2,048 moves far off screen leave nothing recorded with no slot drawn; a 34,000 px selection (over more than 4,096 tiles) dragged into a view with nothing to stand in keeps the view drawn; a board fading mid-drag ends the fast path. From the re-check: a selection moved out of a tile no tile was kept for is erased from it by a frame with no budget for optional tiles.
  - The builder sends a move alone, in plain and compact-copy documents (`packages/editor/test/engine-tiles.test.ts`).
  - On the GPU (`apps/web/e2e/engine.spec.ts`): composited while moving, exact once dropped, into another board too. The 34,000 px drag on the GPU under a spent budget, and the selection erased where only the last frame showed it (`apps/web/e2e/engine-tiles-gpu.spec.ts`).

### Opening a page (phase 2, part 3)

- **A page just shown starts coarse.** The first frame after a fresh list (a page opened or switched to) has nothing to stand on. Under a frame budget it draws ladder tiles of a level up to four times coarser than the view (the first step of the ladder at or above a quarter of its scale, so the composite always lays it: one rule, `tiles::stands_in`, for what the plan counts on and what the composite lays), with level of detail on (text as bars, specks skipped): a few tiles, most of a large page specks at that scale. They're a stand-in. Asked for with no budget (`renderGpu(…, false, 0)`), the first frame is exact at once, as before.
- **Text is sent provisional first.** The fresh list made when a page is shown (`DisplayListBuilder.build(…, { deferText: true })`) doesn't shape its text. Each text record carries only its coarse bars, flagged provisional:
  - display list 1.1 adds flag 8: drawn as its coarse ops at every scale, never exact, never exported;
  - the rest is sent whole in slices between frames (16 ms each, `EngineView.ahead`), what's in view first (`setView`, `pendingVisible`), read incrementally from a queue;
  - what's in view is found by a scan of the queue inside each slice's budget, each layer's bounds found once and kept until the page changes, and started again when the view moves: a camera change never sorts the queue, and asking how much is in view finds nothing itself (the re-check's N3). While the scan isn't through, the text in view counts as at least one;
  - while text in view is still to come, frames draw only what nothing stands in for: a tile drawn before its text arrives would be drawn again.
- **Text whose face is loading stays provisional.** Shaping a run whose face file is still loading (`TextMeasurer.loading`) sends the record provisional, its bars, and notes the faces it waits for. When faces arrive (the measurer's `faceGeneration`) only what waited for them is queued again, a few at a time, never every text on the page; when fonts, aliases or the catalog change, every text is queued the same way, and the frame isn't reported exact until the text in view is sent. A face that won't come (unavailable, or a character the font lacks) still sends the page to the canvas renderer, typed (`textWithoutOutlines`). Before, any text whose face was loading sent the whole page there.
- **A face's load has a deadline** (`Shaper`, 3 s, `FACE_LOAD_DEADLINE_MS`): one still loading then is unavailable, so its text goes where an unavailable face's does instead of staying provisional for as long as the file is open. Its file may still come: then the face is ready, its text is queued again, and the page goes back to the engine. A face that failed or timed out loads again on `retry` (the re-check's N2). The debug setting `drawpane:face-deadline-ms` changes the deadline (tests that hold a face back). When the canvas renderer retires, an unavailable face needs a drawn fallback of its own: that's phase 5's to settle.
- **Provisional is never exact, wherever it is.** A provisional record counts its box, grown by its reach, in its bounds whatever its placeholder ops cover, so it's never culled away uncounted, and its tiles go stale when the text arrives. A tile is exact only if nothing stood in for any of its records: no level of detail, no provisional record. And no frame is exact while any shown record on the page is provisional: its text, once it arrives, may paint past its box (an overhang, text overflowing a fixed box), and nothing knows where until it's shaped (`Store::provisional_shown`, found once a revision; the re-check's B3). The frame can still be settled: as drawn as the list allows.
- **Never exported.** PNG export and bands are refused (`ErrorCode.State`) before their first byte while any shown record is provisional, wherever it is in the crop: the list isn't the document yet.
- **Drawn once, not every frame.** A tile drawn at full detail stays current until something it shows changes, even when a provisional record keeps it from being exact (`TileEntry::current`): neither frames nor the slices between them draw it again meanwhile. A frame that's as drawn as the list allows (`settled`) ends the editor's loop; the faces' arrival redraws it.
- **Coming to rest never swallows a change.** When the camera comes to rest where the last moving frame was drawn, that frame stays on screen and the time between frames settles it, but only if nothing but the camera changed since: an edit, an image, a face or a font landing after the moving frame (`Canvas`'s `changed`) sends the next frame through the engine as usual. And a slice between frames that finds nothing to do hands whatever's left to a frame: a frame at rest that's as drawn as the list allows ends the loop (the re-check's N1; `apps/web/e2e/engine-idle.spec.ts` holds a face and the page's CSS font back so nothing else wakes the editor, and failed before the fix).
- **A moving frame draws a tile only if one fits.** At rest a frame always draws at least one tile, so it makes progress. While the camera moves it draws an optional tile if a tile, at what tiles have lately cost (a running average), fits what's left of its budget, and its first if one fits three budgets (12 ms); tiles nothing stands in for are drawn whatever the budget. So a pan keeps up with ordinary tiles, and a dense one, about 30 ms at 25% on a 40,000-layer page, never makes a long moving frame. A frame waiting for text in view draws no optional tile at all.
- **Glyph masks reuse one render context** (`masks::Rasterizer`), reset and resized per mask: rasterising was mostly setting up a context per glyph (16 µs a mask natively, now 4 to 8), and a page opening rasterises thousands. The same coverage, bitwise.
- **The scale bench.** It runs the engine (`BENCH_RENDERER=engine|both`) and can strip effects (`BENCH_NO_EFFECTS=1`): the generated kit's screens carry drop shadows, which the engine draws only from phase 3, so with them its largest page falls back whole. It tells the engine's frames of the page apart (`EngineView.last`'s page and frame number), any page-level fallback, and a timeline of frames and slices between them (`spent`, `timeline`).
- **Opening, as the targets mean it** (`opening` in `bench/frames.ts`, for the scale and real-file benches): clocked from the page being shown. The useful first image is the first frame on screen that looks like the page: every frame the engine puts on screen is sampled as it lands (its canvas scaled to blocks of 16 device pixels), and once the page is exact, the first sample within 40 levels of the exact frame in every channel, in at least 90% of the blocks where the exact frame isn't background and of all blocks, is the useful one (coarse tiles and text as bars pass; the loading checkerboard, a blank frame or the page before don't). The exact frame is stamped three ways: drawn (submitted), GPU done (`onSubmittedWorkDone`, no read-back) and shown (on the bench's headless browser, a read-back painted; presented to a WebGPU canvas, the first animation frame after the GPU finished it, the earliest a compositor could show it, never the submission). A settle gesture missing any stamp counts as timed out, never as a sample in some columns and not others. Each run is stamped with who drew it, the page and the engine's revision. The real-file bench gates the heaviest page it measures, as shown; when that page falls back to the canvas renderer, the run says so instead of gating a lighter one.
- **Measured, round 3, on the T4** (`webgpu` mode, read-back presentation; one run each of `bench/canvas.spec.ts` and of `bench/scale.spec.ts` with `BENCH_SCALE=500000 BENCH_NO_EFFECTS=1`, the top of the stack). Opening the 40,401-layer page at fit, from the page shown:

  | | before (the re-check, #224 at `99705c7`) | runs drawn as one image | and strokes on the device |
  | --- | --- | --- | --- |
  | useful image shown | (not measured) | 806 | 755 |
  | exact frame drawn | 2,981 | 2,664 | 2,435 |
  | GPU done | | 3,141 | 2,478 |
  | shown (read back) | 3,449 | 3,141 | 2,478 |
  | the densest tile (encode + render) | 432 | 341 | 199 |

  The text is sent whole by 1.8 s (13,792 records, 709 ms of slices); the tiles follow. The GPU work the dense tiles left after their frame (480 ms) was the strokes: offset to a fortieth of a pixel, they made that many more strips to draw.

  Settling on the 10,000-layer file, ten gestures each, from the latest input (ms, p50 / p95):

  | | drawn | GPU done | shown (read back) |
  | --- | --- | --- | --- |
  | zoom at fit | 184 / 231 | 204 / 265 | 225 / 284 |
  | pan at fit | 12 / 31 | 61 / 119 | 121 / 174 |
  | pan at 100% | 11 / 31 | 57 / 96 | 125 / 170 |
  | drag at 100% | 39 / 74 | 102 / 121 | 169 / 227 |

  The zoom's p95 misses 250 ms once the GPU and the read-back are counted. Its settle is the zoom's last frame waiting for an animation frame (about 30 ms here), six dense tiles in idle slices (about 8 ms each), the main thread's share of compositing a frame in software between slices (one gap of about 30 ms), the GPU (about 20 to 35 ms) and, headless only, the read-back (about 20 to 40 ms).
- **The second re-check's T4 runs** (the same head, its own runs): zoom settle on the 10,000-layer file drawn 187 / 218 ms, GPU done 198 / 235, shown (read back) 225 / 255 (p50 / p95); with read-backs turned off, drawn 129 / 171 and GPU done 136 / 177. Opening the 40,401-layer page: a useful image at 799 ms, the exact frame shown at 2,825 ms. So the zoom's p95 misses 250 ms by 5 ms with the read-back and meets it by 73 ms at GPU completion without it; presentation on a hardware compositor is still unmeasured.
- **Engine parity waits for faces.** Since text whose face is loading goes provisional (bars), the debug renderer the parity suites draw through (`engine-debug.ts`) waits while any layer's text waits for a face, not only for text without outlines: it drew bars on the CPU and text on the GPU a moment later, so every text suite's CPU, GPU and Worker renders disagreed.
- **What the bench can't measure.** The GPU bench's Chromium composites in software and can't present a WebGPU canvas, so frames there are read back: shown is later than a laptop would show them, and presenting on hardware isn't measured. The scale bench strips effects, and glass and blur are phase 3: opening a page with them is unmeasured.
- **Measured on the T4** (`webgpu` mode, the 500,000-layer corpus without effects, its largest page of 40,401 layers at fit, 2,880 × 1,800): first frame 820 ms (the fresh list built in 376 ms, applied in 125); text sent whole between 0.9 and 1.9 s (16,675 records, 707 ms of slices); the four densest tiles (about 15,000 records and 85,000 glyphs each) 930 ms; the exact frame drawn at 2,998 to 3,060 ms over two runs and shown at 3,434 to 3,540 (headless browsers read it back). No fallback: the engine drew the exact frame. Before this round it was 4,018 ms, through the canvas renderer. On the same build, the 10,000-layer file's exact frame after pans was drawn 12 to 16 ms after the pan's last frame, and after a zoom 234 to 258 ms.

### Mip phase on large clear glass

Large clear lenses align the near and far bounds of each chunk to the same three-level mip grid. The grid also preserves the rim-height downsample phase. Odd-sized levels would otherwise stretch the sampled stripe pattern differently in each chunk. For the 1,300 × 900 rounded lens at refraction 100, dispersion 100 and depth 40, the CPU chunked and single-region renders now differ by at most one level over the full frame, with 94 of 1.4 million pixels differing. The previous maximum difference was 17 levels.

## Amendment: phase 3C cross-browser work (2026-11-20)

Phase 3C completed the WebGL2 backend, automatic backend selection and loss recovery, tiled CPU Worker view mode, the three remaining geometry items from phase 1, cross-browser Modal T4 testing (Chromium, Firefox, WebKit), and the standalone `/diagnostics/renderer` page.

### What landed

1. **WebGL2 backend (`packages/engine`, lazy `webgl` build):**
   - `vello_gpu = 0.4.0` (with phase 2's queue-upload vendoring in `packages/engine/rust/vendor/vello_gpu`) runs on `wgpu` 30's GL (`webgl`) backend, sharing one `wgpu::Device` with the engine's own WGSL passes (translated to GLSL ES 3.0 by naga) and phase 2's tile cache and drag compositing.
   - Requests WebGL2 downlevel limits (`downlevel_webgl2_defaults().using_resolution(adapter.limits())`) so adapters keep their full texture and buffer dimensions (`maxTextureDimension2D` up to 32,768 on T4, and 16,384 on macOS Safari ANGLE Metal).
   - Non-blocking `pump()` polls `device.poll(PollType::Poll)` and yields with `setTimeout(..., 0)` between ticks so read-backs and `onSubmittedWorkDone` never block the page thread; renewed Wasm engine instances isolate stale generations, GPU wait timeouts are returned distinctly as `ErrorCode::Timeout` (12), and `Drop for Gpu` releases owned GPU resources.
   - Built as a separate lazy module (`dist/webgl`) that loads only after WebGPU probing fails, so WebGPU browsers never download it. Measured sizes against budgets after rebasing onto phase 2: `worker` 249 KB gz (budget 400 KB), `browser` 409 KB gz (budget 1,000 KB), `webgl` 1,140 KB gz (budget 1,400 KB).
   - Forced-WebGL2 conformance runs in CI (`ENGINE_PARITY_BACKENDS=gpu,webgl`), checking CPU against both WebGPU and WebGL2, alongside parameterized WebGPU + WebGL2 tile tests (`e2e/engine-tiles-gpu.spec.ts`).

2. **Backend selection, loss recovery, and tiled CPU Worker view mode (`apps/web/src/editor/engine-view.ts`, `engine-cpu.worker.ts`):**
   - Automatic selection order: WebGPU (core) -> WebGL2 -> CPU Worker view mode -> canvas renderer (WebGPU compatibility mode is opt-in via `?renderer=engine-compat` because Vello's shaders require core `flat, first` interpolation).
   - Every candidate backend (`webgpu`, `webgl2`, `cpu-worker`) is probed on its own fresh detached `<canvas>` and committed into the React-owned DOM slot only after attach succeeds and ownership is verified.
   - **WebKit / Safari 16K-safe adapter classification:** WebKit's privacy-masked `Apple GPU` and extension-hidden `WebKit WebGL` labels are classified as `"unknown"` (never assumed hardware or software from the string alone). Native macOS Safari's ANGLE Metal backend sets `max2DTextureSize` to `16384` (WebKit `DisplayMtl.mm`), so the in-app probe never rejects `16384`; instead, WebKit privacy aliases are accepted once `failIfMajorPerformanceCaveat: true` and a 512 x 512 16-pass WebGL2 ALU fill-rate probe pass (`<= 100 ms`; measured 2 to 4 ms on T4 EGL vs 156 ms on Mesa `llvmpipe`). Software and non-WebKit generic adapters are refused by default (overridable via `drawpane:engine-software=allow` for headless tests).
   - Every step-down logs clearly to the console and emits `drawpane:renderer-fallback` with structured backend, adapter, and reason details.
   - Startup `ErrorCode.Timeout` (12) retries once without blacklisting the backend; runtime timeouts on a healthy context back off gently without spending the device-loss budget. Confirmed device loss and WebGL context loss rebuild the GPU surface and re-upload the current display list without losing edits. More than two recoveries inside 60 seconds step down permanently for the session (`webgpu -> webgl2 -> cpu-worker -> canvas`).
   - CPU Worker view mode runs `vello_cpu` inside a dedicated Web Worker (`engine-cpu.worker.ts`) through phase 2's tiled CPU path (`renderCpuTiled`) in bounded slices with worker-wide in-flight transfer credit backpressure (`MAX_INFLIGHT_TILES = 4`), `EngineView.ahead()` deferred text shaping, and a `4096 x 4096` pixel cap, displaying a "CPU view mode" status pill in the editor.

3. **Geometry items retired from `UNSUPPORTED`:**
   - **Corner smoothing (squircles):** exact Rust `f64` port of `packages/editor/src/corners.ts` verified across all 455 unique test vectors within `1e-6` before wire `f32` quantization (preserving phase 2's cached quarter-circle fast path when `smoothing == 0`), unlocking all 20 pure squircle cells in `parity/engine.spec.ts` `corners` at mean `0.11` against Figma on CPU, WebGPU, and WebGL2.
   - **Diamond gradient:** exact L1 distance (`|u| + |v|`) paint in both Rust CPU and WGSL GPU shader passes (compiled to GLSL ES 3.0 on WebGL2 too), preserving Figma's second gradient axis via an optional `width` handle, charging temporary diamond raster allocations against CPU (including tiled CPU rendering and streaming exports) and GPU memory budgets, exporting exact 4-quadrant linear contours in SVG/CSS, and gated on 6 real Figma goldens (`tools/figma-parity/scenes/diamonds.json`, mean `0.11`).
   - **Outside text strokes:** isolated `OP.layer` (`SrcOver`) + `OP.layer` (`DestOut`) + `OP.unlayer` wire ops on display list wire version `1.2` (strictly gated on wire header `minor >= 2`, since phase 2 claimed `1.1` for `FLAG.provisional = 8`), matching Figma's paint-major order and list-marker stroking across Canvas and Engine, and gated on 4 real Figma goldens (`tools/figma-parity/scenes/text-strokes.json`, mean `0.48`).

4. **Cross-browser Modal T4 measurements and gate hardening:**
   - **Hardened standalone and in-app GPU/CPU gates (`e03b54ac`, `tools/gpu-bench/runs/gate-verify-pr236/summary.md`):**
     - All three browsers passed 6/6 on `--modes gpu,cpu` (Chromium `gpu`/`cpu`, Firefox `gpu`/`cpu`, WebKit `gpu`/`cpu`).
     - Adapter identity (`hardware`, `software`, `unknown`, `none`) is recorded independently of host Vulkan verification (`hostGpuOk`). The `maxTextureSize >= 32768` check in `tools/gpu-bench/gate.mjs` is scoped strictly to Modal's Linux EGL environment (distinguishing T4 EGL `32768` from Mesa `llvmpipe` `16384`) and is never applied to native macOS Safari's 16K Metal path.
     - Onscreen presentation is verified via element screenshots independently of 2D canvas-copy readback (so Firefox cannot be blocked by a 2D copy failure), and Chromium WebGPU buffer-readback-only results are labeled `render-only`, never `onscreen`.
     - In-app benchmarks (`apps/web/e2e/bench/engine-gate.ts`) assert live DOM renderer attributes, non-zero presented frame deltas, zero fallback frames, and non-blank composited engine pixels with overlay layers temporarily hidden during sampling.
   - **Matched shadow-free baseline on Modal T4 (`e03b54ac`, `dirty: false`, `trace: "off"`, NVIDIA Tesla T4 driver `620.70.06`, 10,000-layer / 400-card file, 0 drop-shadows on both renderers, `1,440 x 900 @ 2x DPR = 2,880 x 1,800`, measured prior to rebasing onto phase 2 tiles):**
     - An earlier run was invalidated because `Canvas` drew 400 drop-shadows while `Engine` drew 0. Both renderers below ran the exact same shadow-free scene (`benchShadows() === false`, `shadowCount: 0`) with `trace: "off"` and zero fallback frames asserted across every engine scenario. **Headline metric: frame interval (p50 / p95 ms)**, with `content` and `overlay` times beside it.

| Browser (Modal T4, `e03b54ac`) | Backend chosen (engine) | `bench/canvas.spec.ts` frame interval p50/p95 ms (Canvas -> Engine) | `bench/interactions.spec.ts` frame interval p50/p95 ms (Canvas -> Engine) | `content` p50/p95 ms (`pan, 25%` / `pan, 100%`, Canvas -> Engine) | `overlay` p95 ms (`pan, 25%`, Canvas -> Engine) | `type` exact ms (Canvas -> Engine) |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium 158 (`gpu`) | WebGL2 (`ANGLE NVIDIA T4`, direct present, 0 fallback) | `pan, whole` 16.6/18.4 -> 16.6/18.8; `pan, 25%` 16.6/18.3 -> 16.6/18.9; `pan, 100%` 16.6/18.1 -> 16.6/17.9; `zoom, whole` 16.6/18.3 -> 16.7/17.6 | `pan, fit` 16.6/19.7 -> 16.7/18.2; `pan, 100%` 16.6/18.9 -> 16.6/18.3; `pan, 400%` 16.7/17.6 -> 16.6/18.5; `drag, 60f` 31.5/40.2 -> 28.3/40.7 | `pan, 25%` 3.3/8.3 -> 3.5/4.8; `pan, 100%` 1.0/1.5 -> 1.7/2.2 | 4.3 -> 5.2 | 283 -> 266 (`longtask`: 0) |
| Firefox 159 (Xvfb) | WebGPU core (unidentified on verified T4 host, direct present, 0 fallback) | `pan, whole` 43/49 -> 50/59; `pan, 25%` 47/52 -> 51/56; `pan, 100%` 43/46 -> 51/57; `zoom, whole` 41/47 -> 34/42 | `pan, fit` 43/50 -> 50/57; `pan, 100%` 40/45 -> 61/85; `pan, 200%` 41/43 -> 65/82; `pan, 400%` 40/44 -> 66/82; `drag, 60f` 51/57 -> 70/86 | `pan, 25%` 33/37 -> 6/8; `pan, 100%` 29/31 -> 5/6 | 13 -> 18 | 456 -> 313 (`longtask`: n/a) |
| WebKit 27.2 (Surfaceless EGL) | WebGL2 (masked `Apple GPU`, `maxTex=32768`, `perfMs=3`, direct present, 0 fallback) | `pan, whole` 23/81 -> 19/46; `pan, 25%` 26/78 -> 23/45; `pan, 100%` 22/72 -> 18/40; `zoom, whole` 20/54 -> 18/42 | `pan, fit` 24/83 -> 18/52; `pan, 100%` 26/76 -> 18/32; `pan, 200%` 25/73 -> 18/36; `pan, 400%` 28/68 -> 17/42; `drag, 60f` 31/61 -> 38/57 | `pan, 25%` 8/35 -> 5/12; `pan, 100%` 3/34 -> 3/7 | 6 -> 8 | 301 -> 360 (`longtask`: n/a) |

   - **Chromium (WebGL2):** Both renderers hold 60 Hz (`16.6-16.7 ms` p50, `17.6-18.9 ms` p95) on pan and zoom with `trace: "off"`, and the engine tightens `pan, 25%` content p95 (`8.3 -> 4.8 ms`) and `drag, 60 frames` median (`31.5 -> 28.3 ms`).
   - **WebKit (WebGL2, Linux Surfaceless EGL):** Disabling Playwright traces (`trace: "off"`) removed substantial capture overhead. The engine improves every pan and zoom frame interval over Canvas (`canvas.spec.ts` p50 `20-26 -> 18-23 ms`, p95 `54-81 -> 40-46 ms`; `interactions.spec.ts` zoomed pan p50 `25-28 -> 17-18 ms`, p95 `68-76 -> 32-42 ms`), while `drag, 60 frames` p50 was `38 ms` vs `31 ms` on pre-phase-2 full-frame re-encode.
   - **Firefox (WebGPU on Xvfb) pacing findings and caveats:**
     - Disabling Playwright traces (`trace: "off"`) fixed the 5-minute Firefox hang on `bench/canvas.spec.ts` (completing cleanly in 172 s Canvas / 205 s Engine).
     - On the matched 0-shadow scene, the engine reduced Firefox `content` time (`33/37 -> 6/8 ms` at 25%, `29/31 -> 5/6 ms` at 100%), improved `zoom, whole` (`41/47 -> 34/42 ms`), and improved `type` exact latency (`456 -> 313 ms`), **but user-visible pan frame intervals did not improve (`43-47 -> 50-51 ms` in `canvas.spec.ts` and `40-41 -> 61-66 ms` at 100% to 400% in `interactions.spec.ts`)**.
     - The earlier 6-point ablation (`BENCH_FRAME_DIAG=1` at 25% on `e75707e30`) supports two conclusions on that headless Xvfb configuration: (a) a presentation/compositor bottleneck outside `content` (calling `view.draw()` directly in rAF with zero React updates and no overlay redraw still paced at `58/70 ms` while `emptyRaf` paced at `17/18 ms`), and (b) a real shared 2D overlay cost (both renderers clear and redraw the full `2,880 x 1,800` 2D overlay canvas and artboard labels every frame; hiding or shrinking the overlay reduced JS overlay cost). That ablation does **not** identify WebRender's internal copy mechanism, does **not** equate an explicit `134 ms` buffer readback with implicit presentation latency, and does **not** establish a universal `58 ms` floor (the standalone gate's simpler `2,880 x 1,800` Firefox WebGPU canvas paced at `17 ms` median).
     - Real desktop Firefox with hardware WebRender compositing (macOS, Windows, or Linux Wayland) and native macOS Safari must be measured directly (via `/diagnostics/renderer` and desktop testing) before claiming those browsers meet the freshness gate. Optimizing the shared TypeScript 2D overlay is tracked in a dedicated follow-up PR.
   - **Parity and diagnostics on Modal T4:** `diagnostics-renderer.spec.ts` passed 2/2 (all 10 cells + `noindex` + clipboard) on Chromium, Firefox, and WebKit; `parity/engine.spec.ts` passed `diamonds` (`0.11`), `text-strokes` (`0.48-0.51`), and `corners` (`0.11`) identically on Chromium and Firefox, and passed `diamonds` (`0.11`) and `corners` (`0.11`) on WebKit (CPU vs WebGL2 matched identically on WebKit; Linux WebKit `CanvasTextMeasurer` Cairo/Pango metrics shift text wrapping and `outside-list` bullet offset).

5. **WebKit black-glass investigation and engine guardrails:**
   - `e2e/glass.spec.ts` passed 5/5 on Chromium, Firefox, and Linux WebKit 27.2 (NVIDIA T4 EGL). That narrows the reproduction environment (Linux WebKit EGL does not reproduce the reported macOS Safari black-glass bug), but does not by itself isolate a specific macOS backend or establish causation without testing on an affected macOS Safari system.
   - Probing Linux WebKit confirmed two concrete differences: `ctx.filter = "blur(...)"` is unsupported (`ctxFilterBlur: false`), and `__Host-` Secure cookies are rejected on `http://localhost`.
   - Auditing `packages/editor/src/glass.ts` surfaced candidate hypotheses (unconfirmed pending an affected macOS Safari run) that the Rust engine avoids by design and phase 3B glass should keep avoiding defensively:
     1. Zero-base `pow` defensive hygiene: GLSL ES 3.0 defines `pow(x, y)` as undefined for `x < 0` or `x == 0 && y <= 0`. Although `glass.ts`'s box falloff defaults to `2.55 + depth > 0`, some GPU shader compilers lower `pow(x, y)` via `exp2(y * log2(x))` without a zero guard; engine WGSL shaders should guard `x > 0.0` or clamp `max(x, 1e-6)` before `pow` as defensive hygiene.
     2. Cross-context `OffscreenCanvas` 2D -> WebGL2 `texImage2D` (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`) and WebGL2 `OffscreenCanvas` (`preserveDrawingBuffer: false`) blitted twice to 2D (`#place` then `#keep`), which may behave differently across macOS Safari / CoreGraphics / ANGLE-Metal drivers. The engine keeps all passes inside one `wgpu::Device` on GPU textures with no 2D/WebGL2 `OffscreenCanvas` handoffs.
     3. Reliance on `ctx.filter` in `#fallback()`, which WebKit ignores. The engine owns its Gaussian blur and glass shaders directly.
   - No blind change was made to the retiring `glass.ts` because the bug did not reproduce on Linux WebKit and awaits confirmation on an affected macOS Safari host.

6. **Standalone diagnostics page (`/diagnostics/renderer`):**
   - Lazy code-split route (`68.9 KB` gz) in `apps/web` requiring no sign-in and making zero `/api/*` requests, unreachable from main navigation, and explicitly opted out of search indexing via both `X-Robots-Tag: noindex, nofollow` (Worker + `_headers`) and `<meta name="robots" content="noindex, nofollow">`.
   - Ships 10 deterministic zero-font, zero-network test cells (exact 8-bit sRGB channels so CPU and hardware GPUs agree without `.5` UNORM8 clear-rounding ambiguity) with expected CPU-oracle PNGs (`apps/web/src/diagnostics/expected-pixels.ts`), structured so phase 3A/3B effects and glass cells drop straight in.
   - Separates the single correctness render + readback from the warm timing samples (`renderGpu` + `gpuFinished` on GPU backends, `renderCpu` on CPU), and reports browser/platform info, chosen backend and selection fallback notes, adapter features and limits, WebKit/canvas probes, per-cell Expected/Actual/Diff canvases and pass/fail against `CPU_GPU_TOLERANCE`, warm frame timings, and a one-click "Copy report" Markdown + JSON export for real macOS Safari and Firefox verification.

### Shared 2D overlay optimization (`OverlayRenderer`, retained labels, dirty transient clears)

Following the cross-browser measurements above, the interactive 2D overlay stayed in TypeScript (as this decision specifies) and was split into a retained artboard-labels layer plus a dirty-region transient overlay (`packages/editor/src/overlay-renderer.ts`, `labels.ts`, `overlay.ts`, `apps/web/src/editor/Canvas.tsx`):

- **Cached label layout and single sprite atlas:** artboard label text layout (`text`, `style`, `maxWidth`, `dpr`) is cached with `LRU` eviction, and label glyphs are rasterized into one shared `2048 x 1024` shelf-packed canvas atlas (avoiding hundreds of per-label `OffscreenCanvas` objects and repeated `ctx.fillText` calls). Sprite sizes, direct zoom draws, and damage clears all use measured `actualBoundingBox*` glyph ink padding so tall combining marks and script overhangs are neither clipped nor left behind.
- **Overscanned CSS `translate3d` pan translation with strict 4096px cap:** the retained `.canvas__labels` layer is overscanned by up to `144 CSS px` per side while staying within `4096` device px per axis. If the viewport itself exceeds `4096` device px on either axis (for example `2560 x 1440 @ 2x DPR`), the retained surface is disabled (`1x1`, hidden) and `OverlayRenderer` falls back cleanly to single-canvas overlay rendering on `.canvas__overlay`. Both `ResizeObserver` and `matchMedia` / draw-time DPR tracking keep backing resolutions synchronized across DPR-only changes.
- **Direct zoom path and measured dirty transient regions:** zoom frames draw viewport labels directly onto `.canvas__labels` without overscan shifts or atlas churn, recording measured ink rects for later sparse clears. Transient UI (selection bounds, hover outlines, resize handles, guides, collaborator cursors and measured name tags) tracks previous and current device-pixel bounding boxes and clears/redraws only the dirty union (skipping clears entirely on empty pan frames), while `overlayStateChanged()` avoids scheduling overlay redraws for unrelated editor state changes.

**Measured A/B on Modal T4** (`e03b54ac` before vs `f0ba6ed5` after, same container per renderer, `dirty: false`, `trace: "off"`, 0 drop-shadows on both renderers, `1,440 x 900 @ 2x DPR`, measured prior to rebasing onto phase 2 tiles; `tools/gpu-bench/runs/overlay-ab-canvas-v2/summary.md` and `overlay-ab-engine-v2/summary.md`). **Headline metric: frame interval (p50 / p95 ms)**, with `overlay` p95 ms beside it.

| Browser + Renderer (Modal T4, `e03b54ac` -> `f0ba6ed5`) | `pan, whole` interval p50/p95 ms (overlay p95) | `pan, 25%` interval p50/p95 ms (overlay p95) | `pan, 100%` interval p50/p95 ms (overlay p95) | `interactions` `pan, fit` interval p50/p95 ms (overlay p95) | `drag, 60f` interval p50/p95 ms (overlay p95) | `select` / `type` / `change fill` answer p50 ms |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium 158 Canvas | 16.6/18.4 (4.8) -> 16.7/18.0 (0.2) | 16.6/18.3 (4.3) -> 16.7/18.4 (0.1) | 16.6/18.1 (4.4) -> 16.7/17.7 (0.1) | 16.6/19.7 (10.7) -> 16.7/17.8 (1.5) | 31.5/40.2 (4.5) -> 29.2/38.4 (0.3) | 16.4->11.6 / 19.1->9.4 / 23.4->11.4 |
| Chromium 158 Engine (WebGL2, 0 fallback) | 16.6/18.8 (5.7) -> 16.7/17.9 (0.1) | 16.6/18.9 (5.2) -> 16.6/18.3 (0.1) | 16.6/17.9 (4.5) -> 16.7/17.7 (0.2) | 16.7/18.2 (5.6) -> 16.7/18.0 (1.5) | 28.3/40.7 (5.8) -> 25.9/36.9 (0.9) | 16.4->10.6 / 29.4->21.1 / 27.7->21.8 |
| Firefox 159 Canvas (Xvfb) | 43/49 (14) -> 35/49 (1) | 47/52 (13) -> 42/50 (1) | 43/46 (13) -> 37/47 (1) | 43/50 (16) -> 35/49 (13) | 51/57 (16) -> 45/55 (6) | 28->18 / 31->24 / 35->28 |
| Firefox 159 Engine (WebGPU Xvfb, 0 fallback) | 50/59 (20) -> 50/60 (1) | 51/56 (18) -> 50/64 (1) | 51/57 (17) -> 51/61 (1) | 50/57 (20) -> 51/68 (19) | 70/86 (24) -> 71/89 (15) | 30->19 / 50->60 / 42->49 |
| WebKit 27.2 Canvas (EGL) | 23/81 (7) -> 20/81 (1) | 26/78 (6) -> 23/105 (1) | 22/72 (5) -> 18/67 (1) | 24/83 (8) -> 22/65 (2) | 31/61 (7) -> 28/59 (1) | 17->12 / 28->25 / 25->12 |
| WebKit 27.2 Engine (WebGL2 EGL, 0 fallback) | 19/46 (10) -> 17/31 (1) | 23/45 (8) -> 17/44 (1) | 18/40 (7) -> 17/30 (1) | 18/52 (8) -> 18/32 (1) | 38/57 (7) -> 31/55 (1) | 18->19 / 45->42 / 33->21 |

- **Takeaways:** Overlay p95 JS during pan dropped to `0.1-0.2 ms` on Chromium and `1 ms` on both Firefox and WebKit across both renderers. On Chromium, Engine `drag, 60f` improved from `28.3/40.7` to `25.9/36.9 ms` (faster than Canvas `29.2/38.4 ms`) and interactive click/edit answer latency dropped sharply (`select` `16.4 -> 10.6 ms`, `drag` `31.7 -> 20.2 ms`, `type` `29.4 -> 21.1 ms`). On WebKit, Engine hit 17-18 ms p50 across every pan scenario (`pan, whole` `19/46 -> 17/31 ms`, `pan, 100%` `18/40 -> 17/30 ms`, `pan, fit` `18/52 -> 18/32 ms`, `drag, 60f` `38/57 -> 31/55 ms`). On headless Xvfb Firefox, Canvas pan intervals improved by 5 to 8 ms (`43-47 -> 35-42 ms`), while Engine pan intervals remained ~50-68 ms despite overlay JS dropping from `17-20 ms` to `1 ms`, reinforcing that real hardware-composited desktop Firefox and macOS Safari must be measured directly.

## Amendment: reference Gaussian blur (phase 3A, 2026-11-20)

The reusable separable Gaussian blur pass (`packages/engine/rust/src/blur.rs` and `blur.wgsl`) implements sigma = 0.45 × radius (decision 0013) without Vello's blur, shared across CPU and GPU and reusable by shadows, layer blur, background blur, and glass frost.

- **Kernel support (`±ceil(3.5 * sigma)`):** Extending support from `±ceil(3 * sigma)` to `±ceil(3.5 * sigma)` reduces the omitted Gaussian tail from 0.27% (0.69 / 255 in 1D, 1.38 / 255 in 2D) to 0.046% (0.12 / 255), removing the 3-sigma truncation shelf on large shadows and eliminating level-transition mismatch when the pyramid adds downsample support.
- **Shareable blur pyramids above `DIRECT_SIGMA_MAX = 10` px:** Sigmas up to 10 device px run directly at full resolution. Larger sigmas halve through a shareable pyramid keyed by `(source_id, clamp_bounds, edge)` with 32 x 32-texel dirty-block coverage (`TileCoverage`).
  - A 2x2 box downsample with 8-bit intermediates failed the 0.25 tolerance on 2 px stripes (aliasing near edges: mean 0.35 to 0.64) and smooth gradients (8-bit quantization across cascaded levels: mean 0.31).
  - Replacing it with a separable 4-tap `[1, 3, 3, 1]/8` filter into 2-texel-aproned levels (preserving exact `Zero`, `Clamp`, and `Border` extensions across all odd/even sizes and cascade depths) with 16-bit internal precision (`u16` UNORM on CPU, `Rgba16Float` on GPU when renderable and filterable, with automatic `Rgba8Unorm` fallback on restricted WebGL2 adapters) and variance compensation `(4^L - 1) / 4 + 4^L / 6` keeps every pattern, edge mode, and sigma well inside tolerance.
- **WebGL2 / GLSL ES 3.00 compatibility:** `blur.wgsl` uses only full-screen triangle fragment passes with `set_scissor_rect`, dynamic uniform offsets, `textureLoad`, and `textureSampleLevel` (no compute shaders or storage buffers).
- **Bounded taps and strict intra-frame cache budgets:** Because every downsampled level stores a 2-texel apron on all sides, halving continues up to `MAX_PYRAMID_LEVELS = 8` even on tiny sources (e.g. `2 x 2` at `sigma = 256`), keeping every production CPU and GPU convolution pass within `MAX_KERNEL_RADIUS = 35` taps per side (also clamped in `blur.wgsl`). Constant `1 x 1` `Clamp` sources short-circuit in O(1) at any finite sigma; non-constant inputs above `MAX_BLUR_SIGMA = 2560` or past the engine memory budget return a typed `Limit` error without trapping Wasm. Both `CpuBlurCache` and `GpuBlur` account for level bytes and evict LRU entries before allocating, including earlier entries from the same frame, running oversized single pyramids ephemerally so retained pyramid memory never exceeds its budget.
- **Measured conformance:** CPU pyramid vs CPU reference across 180 combinations (5 adversarial patterns, 3 edge modes, sigmas 0.5 to 48 px on odd 129 x 97 dimensions, scored over both white and black) has worst mean 0.1229, p99 1, max 1, worst tile 0.333, 0 severe. Browser GPU (SwiftShader) vs CPU pyramid has worst mean 0.0554; GPU vs CPU reference has worst mean 0.0804; offset subrect GPU matches both offset CPU and cropped full GPU. Worker vs browser CPU is bit-identical. Module sizes: worker 569 KB raw / 220 KB gzipped (budget 400 KB), browser 979 KB raw / 367 KB gzipped (budget 1000 KB).

## Amendment: drop and inner shadows (phase 3A, 2026-11-20)

Drop and inner shadows (`Op::DropShadow` opcode 13, `Op::InnerShadow` opcode 14, wire version 1.4) are drawn by both backends, clearing `UNSUPPORTED.shadow`. Shadows with non-normal `blendMode` continue to report `UNSUPPORTED.blend` until blend modes land.

- **Figma blur calibration and curve fidelity (`blur.rs`, `shadow.rs`, `geometry.rs`, `Cargo.toml`):** Shadows convert Figma radius to Gaussian sigma via the shared `blur::sigma_from_radius` helper (`FIGMA_BLUR_SIGMA = 0.45`, decision 0013 revision). `vello_cpu` uses `f32_pipeline` and `RenderMode::OptimizeQuality`, and `geometry.rs` subdivides quarter-circle arcs into `2..=8` exact circular sub-cubics to eliminate Vello's `0.25 px` chord flattening on ellipses and rounded corners.
- **Analytic fast path and measured domain (`shadow.rs`):** Uniform-radius rounded rectangles under similarity transforms (including spread `PathEntry::Box` shapes) with `min(w, h) >= 8`, `sigma >= 2`, `radius <= 0.25 * min(w, h)`, `sigma <= 0.25 * min(w, h)`, and `alpha <= 0.28` (both drop and inner) use Vello's `fill_blurred_rounded_rect_in` (`blurred_rounded_rect` feature on `vello_gpu`). A permanent 1,080-case sweep test verifies zero accepted cases exceed decision 0040's tolerance across sizes, radii, sigmas, fractional positions, and rotations; everything outside that domain routes to the general mask-and-blur path.
- **General mask-and-blur path, downsampled large-sigma path, and canonical cache (`shadow.rs`, `shadow.wgsl`):** Non-uniform corners, ellipses (`PathEntry::Oval`), arbitrary vector paths, spread shapes, stroked open paths (wire `shadowFlags` bit 1, matching canvas), and combined text glyph plus decoration outlines rasterize a coverage mask into a phase-locked scratch target, run `blur.rs` (`EdgeMode::Zero`), and composite tinted with the shadow color. Large sigmas (`> DIRECT_SIGMA_MAX`) rasterize the mask at reduced resolution (`shadow_raster_shift`) and bilinearly upsample (with fused inner-shadow alpha inversion in `shadow.wgsl::fs_upsample_mask`), bounding Worker export working sets cleanly (a `4096 x 1800` radius-700 drop shadow completes inside 25 MiB without trapping Wasm, and sigmas past `MAX_BLUR_SIGMA` refuse with `ErrorCode::Limit` at admission). Canonical rounded-rect and ellipse masks reuse a strictly budgeted LRU `ShadowMaskCache` (16 MiB GPU, 2 MiB CPU) with a persistent `mask_scene` on GPU. Zero-alpha shadows (`#00000000`) are elided by the display-list builder.
- **Decision 0031 drop shadow cut-out and winding parity:** When `dropShadowCast` produces a cut-out (`showBehind: false`), the builder clips the shadow op to `PathEntry::Outside(shape)`. Text drop shadows combine glyph runs and decoration bars into a single `DropShadow` op so overlapping glyphs and underlines do not double-darken. Canvas inner-shadow clipping (`render.ts`) now respects `evenodd` winding rule to match the engine.
- **Offscreen isolation, tile bit-identity, and readback presentation (`cpu.rs`, `gpu.rs`, `engine-view.ts`):** Faded layers (`FLAG_ISOLATE`) whose subtree contains an offscreen pass (`subtree_has_pass`) push a pooled offscreen target (`push_isolated` / `pop_isolated`) so mid-frame flushes never break Vello opacity layers, and `Store` records isolated ancestors (`IsoAncestor`) during patches so flipping `subtree_has_pass` dirties the whole isolated subtree. On CPU, `flush_barrier` keeps tiled exports bit-identical to whole-frame renders under `f32_pipeline` across shadow seams. In headless readback mode (`drawpane:engine-present = "readback"`), `Gpu` pools `MAP_READ` staging buffers, copies opaque frames directly from mapped memory to JS without an intermediate Wasm copy, and supports sub-rectangle strip readbacks (`gpuPixelsRects`) for `Plan::Pan` into an opaque CPU-backed 2D canvas (`{ alpha: false, willReadFrequently: true }`), eliminating the software-compositor GPU readback stall.
- **Measured conformance and sizes:**
  - `shadows` parity suite: 15/15 cells drawn, 0 fallbacks. Against Figma: CPU mean 0.14, GPU mean 0.14 (beating current canvas 0.24 on every single cell in both mean and worst 32x32 tile). CPU vs GPU (SwiftShader): well inside tolerance, 0 severe. Worker vs browser CPU: bit-identical on 15/15.
  - `corners` parity suite: 2 cells drawn (Figma CPU 0.08, GPU 0.08); `strokes` 17 drawn (0.06 / 0.06).
  - Editor e2e suite: 15/15 passed, including decision 0031 cut-out, open stroked drop shadow, even-odd inner shadow, rotated translucent cut-out, mixed-weight underlined text shadow, non-normal blend refusal, and pan strip readback pixel exactness.
  - Worker regressions: `4096 x 1800` drop shadow at radii 128, 256, 384, and 700 completes cleanly in 25 MiB Worker without trapping; radius 10,000 returns `ErrorCode::Limit`; `1157 x 305` DPR 1.35 73-row banded export matches whole-frame CPU bit-for-bit across shadow seams.
  - Fuzz: 200/200 random tiled exports match whole-frame CPU bit-for-bit; patched == fresh holds with shadows and isolated ancestors.
  - Module sizes: worker 599 KB raw / 236 KB gzipped (budget 400 KB); browser 1062 KB raw / 400 KB gzipped (budget 1000 KB).
  - Workerd 8,192 x 8,192 export: engine 17.3 / 25 MiB, isolate peak 62.1 MiB.
- **Real-GPU Modal T4 timings (NVIDIA Tesla T4, driver 620.70.06, Chromium 158.0.8127.18, `webgpu` mode, `BENCH_ENGINE_PRESENT=readback`, 120 frames, 1440 x 900 DPR 2):**
  - `Switch` (820 layers, 311 shadows): first frame 131 ms, exact 167 ms (down from 601 ms; canvas 147 / 147 ms); `pan, whole` interval 29.7 / 33.5 ms (canvas 33.8 / 38.7); `zoom, whole` 33.3 / 36.1 ms (canvas 38.2 / 48.5); `pan, 50%` content 1.8 / 2.9 ms, interval 30.3 / 32.6 ms (canvas 2.1 / 9.6, 36.2 / 51.4); `pan, 100%` content 1.4 / 2.0 ms, interval 30.5 / 32.0 ms (canvas 3.5 / 9.3, 36.9 / 46.0).
  - `Checkbox` (955 layers, 115 shadows): `pan, 100%` interval 30.6 / 33.5 ms (canvas 32.7 / 35.6); `Slider` (189 layers, 53 shadows): `pan, 100%` 30.3 / 32.1 ms (canvas 31.8 / 35.7); `Input OTP` (410 layers, 170 shadows): `pan, 100%` 30.5 / 35.8 ms (canvas 34.4 / 44.3).

**Stacked shadows.** When a record has multiple visible drop shadows, each uses a
rasterized mask and the reference Gaussian. A single eligible drop shadow can use Vello's
analytic rounded-box path. Its approximation error can accumulate where shadows overlap.
In the two-shadow `drop-layered` parity cell, the stacked mask path scored 0.21 on CPU and
0.23 on both T4 GPU backends against Figma (the live canvas scored 0.24). The fixed 0.23
ceiling was the rounded GPU score itself. This cell uses the same Figma and live-canvas
gates as the rest of the shadow suite, including the 0.01 mean allowance against live canvas.

A normal-blend shadow draws its mask into the Vello scene. It can stay inside a Vello
opacity layer, which keeps adding or removing the shadow from changing when unrelated
pixels are quantized during a scene flush.

A flush writes the active Vello target as RGBA8. An edit that adds, removes or moves a
flush can change rounding anywhere overlapping draws cross that boundary, even far from
the edited record. Invalidation includes the enclosing picture or page scope in that
case. A container whose bounds or compositing mode change can also start or stop a
descendant's flush as the container becomes visible or gets culled. Ordinary paint edits keep
their local dirty rectangles when they leave those boundaries alone.

## Amendment: layer blur (phase 3A, 2026-11-20)

Layer blur (`FLAG_POST = 32`, `POST.layerBlur = 1`, `PostEffect::LayerBlur`, wire version 1.4) is drawn by both backends, clearing `UNSUPPORTED.layerBlur`. Progressive blur remains behind `UNSUPPORTED.progressiveBlur` (phase 3B).

- **Figma blur calibration and phase-locked offscreen rendering (`exec.rs`, `cpu.rs`, `gpu.rs`):** A record with active layer blur(s) renders its whole subtree (fills, strokes, shadows, children) into a transparent offscreen target sized to the content plus blur support (`align_area_checked` aligned to `max(pyramid_step, 4)` so pyramid downsampling never shifts phase across tiled exports, returning `ErrorCode::Limit` cleanly rather than silently trimming if a source exceeds `Limits::texture_side`). The walk widens culling to `src_area` while preserving `full_frame` / `full_viewport` flush tracking for `flush_barrier` bit-identity across tile seams, applies Figma's calibrated blur sigma (`blur::sigma_from_radius(radius) * view_scale`, `FIGMA_BLUR_SIGMA = 0.45`, decision 0013 revision), runs `blur.rs` (`EdgeMode::Zero`), and composites the blurred result with the layer's opacity through its open parent clips. On GPU, `blur_isolated(&[(IRect, f32)])` fuses the pending offscreen Vello render and the entire blur chain into one `CommandEncoder` and one `queue.submit`.
- **Direct Worker `renderCpu` admission and internal banding (`engine.rs`, `cpu.rs`, `lib.rs`):** Under a non-zero `Limits::memory_bytes` budget (default `25 MiB` in the Worker Wasm build), `Engine::render_cpu_into` admits the frame upfront and renders in bounded horizontal bands directly into `Engine::pixels` (holding one output buffer instead of duplicating the framebuffer beside a full-frame target, and copying directly to JS via `js_sys::Uint8Array::from` without cloning in Wasm), returning `ErrorCode::Limit` cleanly when a frame cannot fit rather than trapping Wasm.
- **Export admission and Worker memory guards (`engine.rs`, `cpu.rs`):** `export_effect_working_set` walks world transforms, validates visible layer-blur sigmas against `MAX_BLUR_SIGMA`, checks `src_w`/`src_h` against `Limits::texture_side`, and accounts for offscreen source, blur scratch/pyramid, scene strips, and output bytes beside isolated-stack depth so a `4096 x 1800` radius-700 layer blur returns `ErrorCode::Limit` cleanly before streaming any PNG byte rather than trapping the 25 MiB Worker. `Cpu::push_isolated` and `Cpu::blur_isolated` also enforce runtime `check_memory` before allocating.
- **Dirty invalidation (`store.rs`):** `bounds_and_pad` adds `r.post_pad()` (`2.25 * radius + 6.0`) after children and `children_clip`, and `dirty_extent` inflates any touched descendant's dirty rect by the sum of visible ancestors' `post_pad()` so editing a child inside a blurred parent invalidates the full smeared halo.
- **Per-cell fallback and live canvas replacement parity gates (`apps/web/e2e/parity/engine.spec.ts`):** `engine.spec.ts` enforces exact per-cell expected fallback lists (`EXPECTED_CELL_FALLBACKS`), fails on missing Figma goldens, and gates replacement suites (`shadows`, `blurs`) directly against the live current canvas renderer (`<= canvas + 0.01` mean, `<= canvas + 1.0` worst 32x32 tile, `<= canvas + 0.05` alpha mean).
- **Measured conformance and sizes:**
  - `blurs` parity suite: 5/5 `layer-*` cells drawn (5 `background-*` fall back with `backgroundBlur`). Against Figma: CPU mean 0.67, GPU mean 0.64, beating live canvas (mean 0.79) on every single cell (`layer-2` 0.60/0.57 vs canvas 0.72, `layer-8` 0.61/0.58 vs 0.68, `layer-24` 0.80/0.79 vs 1.02, `layer-ellipse-12` 0.59/0.55 vs 0.72, `layer-and-shadow` 0.73/0.71 vs 0.80). CPU vs GPU (SwiftShader): worst mean 0.0690 (<= 0.25), p99 1 (<= 4), worst 32x32 tile 0.167 (<= 2), 0 severe. Worker vs browser CPU: bit-identical on 5/5.
  - `corners` parity suite: `layerBlur` removed from expected fallbacks (`mask` has `["cornerSmoothing", "mask"]`, all other 23 fallback cells have `["cornerSmoothing"]`).
  - Worker regressions: `4096 x 1800` layer blur at radii 128, 256, 384, 700, and 10,000 completes or refuses cleanly with `ErrorCode::Limit` in the 25 MiB Worker without trapping Wasm; `1157 x 305` DPR 1.35 73-row banded CPU renders match whole-frame bit-for-bit across all 5 shadow and layer-blur seam cases (including odd coordinates, blur+shadow, two successive blurs, and large blur+shadow).
  - Fuzz: 200/200 random tiled exports match whole-frame CPU bit-for-bit; patched == fresh holds across layer blurs, shadows, and isolated ancestors.
  - Module sizes: worker 612 KB raw / 242 KB gzipped (budget 400 KB); browser 1082 KB raw / 408 KB gzipped (budget 1000 KB).
  - Workerd 8,192 x 8,192 export: engine 17.4 / 25 MiB, isolate peak 61.8 MiB.
  - Kit unlocks: shadcn sampled direct frames 514 -> 517 / 521 (+3 frames, 99.2%; `Drawer` page unlocked).
- **Real-GPU Modal timings (NVIDIA Tesla T4, `webgpu` mode, `BENCH_RENDERER=engine`, `BENCH_ENGINE_PRESENT=readback`, 60 frames):**
  - shadcn `Drawer` (1,399 layers, 49 shadows, 12 layer blurs): `origin/main` fell back to canvas (`layerBlur: 12, shadow: 25`; first frame 174 ms, exact 269 ms, zoom 2.9 / 10.2 ms, pan 100% 3.6 / 49.1 ms); layer-blur branch draws on WebGPU engine (`unsupported: {}`, GPU 63.8 / 110.6 ms p50/p95 with readback, first frame 162 ms, exact 250 ms, zoom 0.4 / 0.7 ms, pan 100% 1.8 / 4.5 ms).
  - Large iOS UI kit `Sliders` (8 layer blurs, 31 shadows): `shadow` (31 -> 0) and `layerBlur` (8 -> 0) cleared; page still falls back to canvas pending corner smoothing, blends, and glass, with no regression (first frame 136 vs 176 ms, exact 843 vs 1156 ms, pan 100% 2.6 / 23.7 vs 8.3 / 26.1 ms).

## Amendment: blend modes (phase 3A, 2026-11-20)

All 17 non-normal blend modes (`FLAG_BLEND = 64`, paint/shadow/layer blend codes `1..=17`, wire version 1.4) are drawn by both backends, clearing `UNSUPPORTED.blend`.

- **W3C + Figma linear-dodge / linear-burn kernels (`blend.rs`, `blend.wgsl`):** Implements all 11 W3C separable modes (`multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`), 4 W3C non-separable HSL modes (`hue`, `saturation`, `color`, `luminosity`), and Figma's `linear-dodge` (Plus lighter: `c = min(a, cs + cb)`) and `linear-burn` (Plus darker: `c = max(0, cs + cb - as * ab)`) per decision 0038 on both CPU and GPU. `blend.wgsl` uses pure full-screen triangle fragment passes (WebGL2 / GLSL ES 3.00 compatible) with an optional clip-mask binding so open Vello clip paths mask blended ops cleanly.
- **Pass-through faded frames holding blends (`exec.rs`, `cpu.rs`, `gpu.rs`, `store.rs`):** Faded isolated frames (`FLAG_ISOLATE`, `opacity < 1`, `blend == 0`, no post effects) whose subtree contains a non-normal blend (`Store::subtree_has_blend`) initialize their offscreen target with a copy of the parent backdrop (`push_isolated_backdrop`), run their children's blends against that backdrop, and composite back with `BLEND_LERP` (`b + (s - b) * opacity * clip_a`) so untouched backdrop pixels remain bit-identical at any backdrop alpha (decision 0038).
- **Worker admission and memory guards (`engine.rs`, `cpu.rs`):** `export_effect_working_set` charges isolated depth and scratch bytes for blended layers, pass-through frames, and blended fill/stroke/shadow ops, and `Cpu::push_isolated_backdrop` / `Cpu::pop_blended` enforce runtime `check_memory` before allocating targets or clip masks.
- **Measured conformance and sizes:**
  - `fills` parity suite: 25/25 cells drawn, 0 fallbacks. Against Figma: CPU mean 0.21, GPU mean 0.20 (all 15 `blend-*` cells well inside canvas thresholds; CPU vs GPU worst mean 0.2162, 0 severe). Worker vs browser CPU: bit-identical on 25/25.
  - `linear-blends` parity suite: 19/19 cells drawn, 0 fallbacks. Against Figma: CPU mean 0.20, GPU mean 0.20 (beating live canvas mean 0.31 and passing the live replacement gate on every single cell; `burn-paint-probe` and `burn-layer-probe` 0.00/0.00 vs canvas 0.15 and 0.58; CPU vs GPU worst mean 0.0542, 0 severe). Worker vs browser CPU: bit-identical on 19/19.
  - `glass-context` parity suite: 8/18 cells drawn (`normal-half`, `dodge`, `burn`, `multiply`, `multiply-grey`, `screen`, `layer-dodge`, `layer-multiply`; Figma CPU 0.04, GPU 0.04; remaining 10 fall back with `glass`/`backgroundBlur`).
  - `glass-alpha` parity suite: 1/20 cells drawn (`dodge-over-none`; Figma CPU 0.47, GPU 0.47; remaining 19 fall back with `glass`/`backgroundBlur`).
  - Rust unit + fuzz tests: 26/26 lib tests (including exact W3C, decision 0038 linear-dodge/burn, and `BLEND_LERP` identity tests) and 8/8 `FUZZ_CASES=200` fuzz tests (200/200 bit-identical tiled exports + patched == fresh).
  - Editor e2e suite: 15/15 passed (including `multiplied-shadow` on CPU and GPU vs canvas).
  - Module sizes: worker 629 KB raw / 249 KB gzipped (budget 400 KB); browser 1118 KB raw / 421 KB gzipped (budget 1000 KB).
  - Workerd 8,192 x 8,192 export: engine 17.4 / 25 MiB, isolate peak 46.5 MiB.

## Amendment: outline, alpha, and luminance masks (phase 3A, 2026-11-20)

All three Figma mask types (outline, alpha, and luminance, plus sibling scope termination by visible clipping frames; `FLAG_MASK = 128`, `FLAG_ENDS_MASK = 256`, `MASK` codes `1..=5`, wire version 1.4) are drawn by both backends, clearing `UNSUPPORTED.mask`.

- **Sibling mask scoping and outline clip paths (`exec.rs`, `layer.ts`, `store.rs`):** Both `ROOT` and container `Op::Children` walk siblings through `Walk::draw_children` with exact `masks.ts` scoping: an active mask ends any prior mask scope, a visible clipping frame (`FLAG_ENDS_MASK`) closes the active mask scope and draws unmasked, and hidden masks or clipping frames have no effect. Outline masks on single filled shapes (`frame`, `rect`, `ellipse`, `polygon`, `star`, `path`) clip masked siblings via Vello's clip stack (`Open::Clip` on `paths[0]` with `NonZero` or `EvenOdd`), ignoring mask opacity and translucency.
- **Picture mask pass (`mask.rs`, `mask.wgsl`, `cpu.rs`, `gpu.rs`, `exec.rs`):** Alpha masks (`MASK_ALPHA = 4`), luminance masks (`MASK_LUMINANCE = 5`, Rec. 709 premultiplied `dot(m.rgb, [0.2126, 0.7152, 0.0722])` matching `luminance.ts`), and non-shape outline masks (`MASK_OUTLINE_PICTURE = 3`, `m.a > 0 ? 1 : 0` matching `opaqueAlpha`) render masked siblings into a `content` offscreen target and the mask subtree (with its fills, gradients, opacity, layer blur, strokes, and children) into an equal-sized `picture` offscreen target over the mask's device bounds, then modulate `content` by `picture` (`mask_cpu` on CPU; pure full-screen triangle fragment pass `mask.wgsl` fused with pending `picture` rendering into one `CommandEncoder` and one `queue.submit` on GPU) and composite onto the parent. Never uses Vello's unsupported GPU mask layer API.
- **Invalidation and Worker memory bounds (`store.rs`, `engine.rs`):** Editing, moving, adding, or removing a mask or `FLAG_ENDS_MASK` record dirties all siblings in its parent (`note_mask_siblings`) so `Store::dirty` covers every changed pixel. `export_effect_working_set` charges two concurrent offscreen targets (`next_depth + 2`) for active picture masks.
- **Measured conformance and sizes:**
  - `masks` parity suite: 7/7 cells drawn, 0 fallbacks. Against Figma: CPU mean 0.27, GPU mean 0.27 (overall better than live canvas 0.31; `alpha-blurred` 0.46/0.46 vs canvas 0.93; every cell well under half its `thresholds.json` limit; CPU vs GPU worst mean 0.00077, 0 severe). Worker vs browser CPU: bit-identical on 7/7.
  - `corners` parity suite: `mask` cell fallback narrowed from `["cornerSmoothing", "mask"]` to `["cornerSmoothing"]`.
  - Rust unit + fuzz tests: 29/29 lib tests (including exact `alpha`, Rec. 709 `luminance`, and `outlinePicture` mask tests) and 8/8 `FUZZ_CASES=200` fuzz tests (200/200 bit-identical tiled exports + patched == fresh + dirty coverage with random outline/alpha/luminance masks and `ends_mask` frames).
  - Banded CPU seam regression (`regressions.test.ts`): 10/10 cases (including alpha, luminance, and blurred alpha picture masks across 73-row DPR 1.35 bands) match whole-frame CPU bit-for-bit.
  - Module sizes: worker 640 KB raw / 253 KB gzipped (budget 400 KB); browser 1139 KB raw / 428 KB gzipped (budget 1000 KB).
  - Workerd 8,192 x 8,192 export: engine 17.4 / 25 MiB.

## Amendment: noise and texture (phase 3A, 2026-11-20)

Procedural noise (`POST.noise = 2`: mono, duo, and multi) and Perlin-displacement texture (`POST.texture = 3`: clipped and unclipped) are drawn in declared effect order alongside layer blur (`FLAG_POST = 32`, wire version 1.4), clearing `UNSUPPORTED.noise` and `UNSUPPORTED.texture`.

- **Noise tiles and GPU retirement (`noise.rs`, `noise.wgsl`, `cpu.rs`, `gpu.rs`):** Synthesizes the same 320 x 320 periodic Perlin fields and `noise.ts` transfer curves (`mono`, `duo`, and `multi` with straight-channel rounding before premultiplication so CPU and GPU match `u8` quantization). Both CPU and GPU caches cap at 8 tiles (`NOISE_TILE_LIMIT`), evict before allocating, and `GpuNoise` holds evicted tiles in `retired` until after `queue.submit` so chains exceeding 8 distinct noise looks in one submission never destroy in-flight textures. UVs are evaluated from origin-invariant device coordinates (`dev_pos = dst_origin + pixel + 0.5`).
- **Origin-invariant texture displacement (`texture.rs`, `texture.wgsl`, `exec.rs`):** Evaluates the 2D gradient Perlin displacement field from origin-invariant device coordinates (`dev_to_layer` plus `dst_origin`), keeping tiled and banded exports bit-identical across fractional camera zooms and offsets. Extreme texture radii or lattice coordinates overflow cleanly into `ErrorCode::Limit` before rendering.
- **Invalidation and Worker admission (`store.rs`, `record.rs`, `engine.rs`):** `Record::post_dirty_pad()` includes both clipped and unclipped texture displacement radius so descendant edits and image replacements (`image_users`) dirty all displaced halo pixels. `export_effect_working_set` walks the full ordered `post_effects` chain, charging coexisting halo-expanded intermediates and noise working-set memory before any PNG byte streams.

## Amendment: backdrop readers, glass, and background / progressive blur (phase 3B, 2026-11-20)

Phase 3B executes backdrop readers on CPU and GPU in the tiled renderer and banded exports. The combined display list uses wire 1.4. Context and reader opcodes 9 through 11 require minor 3, and opcode 12 stays reserved. Phase 3A effect flags and opcodes 13 and 14 require minor 4.

- **Shared blur strength** follows decision 0013. Uniform and progressive background blur and glass frost use `blur::FIGMA_BLUR_SIGMA = 0.45` from the phase 3A Gaussian pass. Both GPU blur variants reserve working textures against the same memory budget before encoding. The CPU uses float rasterization for reader scenes and masks. Readerless pages keep their original integer pixels, with page-wide tile invalidation when a patch changes the mode.
- **Non-nested stacked readers.** The measured `b*` rule in decision 0007 keeps earlier glass out of the sampled backdrop. Glass writes only to `main`. Background and progressive blur write to both targets. Faded pass-through groups preserve each parent prefix separately and interpolate their results back once, preserving translucent backdrop alpha.
- **Shared isolation with phase 3A.** Each blend, picture mask, and post-effect step composites against the corresponding plane. An explicitly blended layer flattens its own picture before it blends. A lens on that layer reads the containing picture's glass-free prefix. The mandatory two-lens fixture checks the masked lower lens, two different blends, a layer blur and a fade on both GPU backends. Moving a reader flush uses phase 3A's broader invalidation. Export selections crossing an effect or a picture-mask scope can return a typed `Unsupported` where they need the surrounding scope.
- **Glass prefilter precision.** Both GPU backends use explicit bilinear texel loads and round-half-up RGBA8 writes for the mip and frost passes. In a paired T4 run, the old prefilter exceeded the CPU/GPU mean limit on `full-containment`, `diff-params`, and `adjacent-frost`. With explicit rounding the three means were 0.0891, 0.0942, and 0.0734 on both backends. The multiply lens scores 1.72 against Figma on CPU, with a hardware CPU/GPU mean of 0.1885. The `diff-params` Figma residual p99 remains 121, attributed in decision 0007.
- **Geometric halos, whole-frame fallback, and split-tile bit-equality:** Reader halos are computed over the geometric dependency DAG intersecting the requested crop (taking the maximum across disjoint readers rather than summing unrelated off-crop readers). When an exact frame's reader reach exceeds `limits.halo`, GPU rendering falls back to untiled whole-frame execution (`render_whole`) rather than refusing. Non-reader tiles use `tile_halo = 0` via a dedicated 2-slot scratch cache, coarse moving frames skip off-screen prefetch and use `frame_halo = 0`, and reader scratch textures keep a `1,048,576`-pixel shrink floor to avoid mid-frame reallocation churn. Glass regions chunk automatically with identical thresholds across browser and Worker CPU builds, preserving frame-anchored coordinates. Background and progressive blurs anchor cropped pyramid `x0`/`y0` modulo `1 << level` and evaluate progressive sigma gradients in frame coordinates so split CPU tiles match whole frames bit-for-bit (`0` differing pixels on 600 x 420 split 189 x 71 tiles).
- **Transitive export context:** `DisplayListBuilder.buildLayers(..., { context: true })` walks earlier siblings in reverse paint order, clipping each candidate's extent to `clipContent: true` ancestors and expanding the required context rectangle whenever an included backdrop reader brings in its own earlier inputs.
- **Memory and GPU scratch budgets:** `admit_export` accounts for peak reader and isolated-group buffers before starting a Worker export, and both CPU (`check_memory`) and GPU (`reader_budget_room` + `evict_frame_scratch`) enforce budgets before allocating scratch textures, masks, mips, or blur outputs. Rim-height textures automatically fall back from `Rgba16Float` to `Rgba8Unorm` on adapters lacking filterable renderable half-float.
- **Progressive background blur storage:** Additive optional fields on `Blur` (`blurType`, `startRadius`, `startOffset`, `endOffset`) preserve backwards-compatible uniform behavior when absent, `NORMAL`, or incomplete across `.fig` and Figma REST import. Progressive layer blur remains flagged as unsupported.
- **Pre-integration conformance on CPU, WebGPU and WebGL2 in Chromium/SwiftShader.** All 99 drawn Figma cells in nine suites passed. Worker CPU matched browser CPU byte for byte across all 99. The highest CPU-to-GPU mean was 0.1503, with maximum p99 of 1, worst tile of 0.50 and no severe clusters. The Worker, WebGPU and WebGL2 modules fit their respective size budgets.
  - Figma mean error on CPU / WebGPU / WebGL2 was `blurs` 0.71 / 0.68 / 0.68, `corners-glass` 0.80 / 0.82 / 0.82, `glass-alpha` 0.35 / 0.35 / 0.35, `glass-context` 1.01 / 1.01 / 1.01, `glass-dark` 0.67 / 0.67 / 0.67, `glass-ellipses` 0.38 / 0.38 / 0.38, `glass-probe` 0.41 / 0.41 / 0.41, `glass` 1.25 / 1.27 / 1.27 and `glass-stack` 2.84 / 2.87 / 2.87. The `diff-params` cell still has p99 121 and worst tile 37.64. Decision 0007 attributes the tail to the lower lens's refraction and dispersion.
  - On both GPU backends, the shared Gaussian integration moved `glass-context/blur` from 0.44 to 0.49, `glass-context/blur-text-faint` from 2.73 to 2.75, `glass-dark/frost-split` from 0.61 to 0.62, and `glass-stack/bg-blur-over-glass` from 2.94 to 2.95 compared with the rebased pre-integration run. The separate 0.50 vs 0.45 comparison in decision 0013 records `glass/text` moving from 3.96 to 3.99. Among the cells drawn in the original review, only `glass-stack/lower-faded-group` CPU worsened, from 2.84 to 2.85.
  - Progressive background blur passed uniform, direction and sharp-control checks, plus diagonal and clipped cases. The CPU/WebGPU mean was 0.0133, p99 1, maximum 12 and worst tile 1.226. Forced WebGL2 passed the same tolerance and Worker CPU was bit-identical.
  - The product import and CPU export exercised four original 804 × 1,748 frames from a large iOS UI kit. The two Examples frames contained two and three glass effects and one progressive blur each. The two Control Centre frames contained 14 glass effects each. All four returned typed `Unsupported` for shadows or non-normal blends. The Examples scenes also use masks and had missing text outlines. Full-frame Figma scores depend on the combined effects stack.
  - `glass-probe-2` runs in the engine gate. Its maximum-frost step edge uses a cell-specific CPU/GPU mean cap of 0.30. The tiled CPU and GPU mip sampling phases give a mean of 0.289, p99 1, max 2, worst tile 0.912 and no severe pixels. The default tail, tile and cluster gates also apply to this cell. The maximum-settings `all-100` cell can return an explicit Worker memory limit on whole-frame rendering. Any Worker trap fails parity and reports its own error.
  - Capped Worker admission and the CPU reader passes charge their peak working set for halo-grown targets, source and clip copies, isolates, Gaussian intermediates and pyramid levels, progressive stop images and glass frost scratch. The Worker regression drains every admitted stream through IEND. A refused stream leaves the module usable, including the two reproduced full-width blur scenes.
- **Measured GPU work on Modal Tesla T4 at 2,880 × 1,800.** The glass benchmark gates exact GPU fence p95 at 80 ms, coarse fence p95 at 16.7 ms and moving content p95 at 8 ms. It gates exact presentation within 250 ms of the latest edit and checks presentation intervals where the browser presents directly.
  - One coarse pass avoids redundant encoding across the six to eight tiles a stacked drag typically invalidates. Rendering that pass at half resolution and using a bilinear upscale lowered stacked drag content p95 from 11.0 to 6.4 ms on the integrated run. Encoding fell from 9.5 to 4.4 ms p95, with patching at 1.4 ms and rendering at 0.3 ms. The exact frame still uses full resolution. An odd-size framebuffer regression checks that settlement restores a one-pixel paint on WebGPU and WebGL2.
  - Forced six-layer coarse fence p95 fell from 47.0 to 4.2 ms, and total forced coarse p95 fell from 53.9 to 7.6 ms. Stacked total forced coarse p95 fell from 12.7 to 7.6 ms. The candidate's exact fence p95 was 44.5 ms for six layers and 52.9 ms for the stack. Latest-revision settle max was 136.7 ms. A separate paired run also passed the Chromium T4 gates with 5.8 ms stacked drag content p95.
  - Chromium's core WebGPU run on Modal uses readback and software compositing. Hardware-composited Chromium with forced WebGL2 improved drag content p95 from 10.9 to 6.7 ms and showed frames at 16.7 ms median. Confirmed presentation p95 / p99 was 17.5 / 31.4 ms. The six-layer coarse and exact fences missed their p95 gates at 17.8 and 174.5 ms. The stacked case met both fence gates and settled in at most 116.2 ms. Firefox's Xvfb WebGPU run showed frames at 69 ms p95 with 9 ms p95 drag content.
- **Combined 3A and 3B verification.** All 154 drawn cells across ten suites passed on forced WebGPU and WebGL2 in Chromium/SwiftShader and on Modal T4. Worker pixels were identical in 153 cells. The maximum-settings `all-100` case returned typed `Limit`. Of the 130 drawn cells shared with the earlier SwiftShader run, only `blurs/background-clear-12` increased, from 0.38 to 0.39 on CPU. The progressive Figma golden and both-backend two-lens fixture also passed.
  - Two original Control Centre frames from a large iOS UI kit rendered at 804 × 1,748 with 20 reader passes each. Means against Figma were 1.518 and 1.482 on CPU, compared with 1.804 and 1.747 on Canvas. Engine p99 was 16 in both cases, compared with 17 on Canvas. The worst tiles stayed near 65.2 with missing fonts, and one alpha mean rose from 0.122 to 0.157. Two Examples frames returned typed `Unsupported` for missing text outlines.
  - The restacked T4 WebGPU readback benchmark passed both cases. The six-layer exact and coarse fence p95 values were 31.9 and 4.2 ms. Stacked drag content p95 was 6.0 ms, with 3.1 ms encoding and 1.8 ms rendering. Latest exact settlement took at most 122.2 ms.
  - Onscreen T4 WebGL2 measured 50.2 and 17.2 ms for the six-layer exact and coarse fence p95. Stacked drag content p95 was 11.1 ms, including 5.0 ms encoding and 4.0 ms rendering. Confirmed presentation intervals were 16.6 ms median, 19.5 ms p95 and 25.4 ms p99. The coarse six-layer fence and the drag work and presentation tails missed their gates.
- **Open conformance coverage** includes desktop WebGPU presentation with hardware compositing and native Safari Metal and ANGLE-Metal.

### Reader-only motion

Whole-view motion draws ordinary paint at device resolution. The stand-in for an unclipped reader samples a half-resolution backdrop pyramid. A short top-level drag can reuse the stationary paint before the first affected layer or effect. The cache is limited to one view and is dropped when that paint may change or the view settles. An exact frame reruns the reader passes at full quality.

In paired Chromium/WebGL2 runs on the T4, stacked drag main-thread p95 fell from 6.7 to 3.6 ms, including encoding from 3.3 to 1.2 ms. The six-layer coarse GPU fence p95 was 13.5 ms. Stacked drag frame intervals were 16.6 / 17.5 ms (p50 / p95), compared with 16.5 / 17.9 ms. The GPU-completion presentation proxy remained above the target at 18.0 ms p95. Chromium WebGPU readback and Firefox Xvfb both remained above 16.7 ms p95.

The repeated paired run used the browser's animation-frame timestamp on both revisions. The timestamp marks the frame in which the benchmark observed a GPU completion. It excludes delay within that frame before the callback ran. Chromium WebGL2 met the presentation gate at 16.7 ms p95 using this clock. On the paired run, the six-layer coarse GPU fence p95 fell from 18.0 to 8.8 ms and stacked drag content p95 fell from 8.4 to 4.9 ms. Linux WebKit's drag content p95 improved from 17 to 13 ms. Its presentation p95 was still above the gate at 37 ms.

The optional dense-text benchmark adds 550 text layers that qualify for stand-ins. Both revisions drew 20 tiles at p95 and presented at 33.4 ms p95 in the paired T4 WebGL2 run. Full-detail moving paint increased main-thread p95 from 28.3 to 31.5 ms. Encoding rose from 11.1 to 12.7 ms and render work from 16.9 to 18.1 ms. The repeat was interrupted by Modal's workspace spend limit. Run the same fixture with `BENCH_GLASS_DENSE_TEXT=1`.

### Frost mip phase

Exact glass uses the same region split on CPU, WebGPU and WebGL2. Each chunk samples the original prefix. If the lens reads the same plane it writes, the GPU copies that plane once before drawing the first chunk. Otherwise it reads the existing glass-free plane directly.

On the T4, all 31 `glass-probe-2` cells and all 15 `glass-stack` cells passed on both backends. The `frost-100` CPU/GPU mean fell from 0.295 to 0.021, with p99 and maximum of 1. Its CPU, WebGPU and WebGL2 means against Figma were all 2.53. The cell uses the standard 0.25 mean cap.

### Glass inside isolated pictures

A lens inside a picture mask, an explicitly blended layer, or a layer blur, noise or texture picture samples the page prefix beneath the picture with the interior paint so far composited over it. Both inputs use the glass-free planes. A pass-through fade that already copied its immediate parent contributes that paint once. The mask, post effect or blend still operates on the scope's transparent picture, including the lens.

The `glass-scopes` fixtures put the lens across the edge of translucent interior paint over opaque stripes. In a paired Worker render, mean error from Figma went from 2.15 to 0.42 for the mask, 3.59 to 0.61 for layer blur and 3.23 to 0.73 for noise. The unfiltered p99 went from 53 to 9, 64 to 7 and 71 to 30. The native nested mask and layer blur test checks the sampled page and interior pixels, the outer scope's multiply composite, patch/fresh equality and banded export equality.

The added cells measure glass in a mask under multiply, in a layer-blurred multiply frame, in a multiply frame under layer blur, and in a texture picture. Their measured Worker mean differences from Figma are 1.99, 2.50, 0.61 and 1.08. The largest remaining differences in the two outer multiply cells occur where translucent interior paint overlaps the lens.

A translucent luminance mask uses the Rec. 709 luminance of its premultiplied picture multiplied by the picture's alpha. The Figma masks fixture varies the luminance at constant 80% opacity, making the white end cover about 64% of the content.

## Amendment for text with missing faces

Saved outlines still draw as before. For live text, the engine shapes the run's resolved face, then itemizes by character coverage when shaping the whole run fails. Private-use code points that lack their own glyph use the box from decision 0036. Other characters fall through to Instrument Sans. The web build bundles its variable TrueType file so the fallback's outlines are available without the font proxy. List markers use the same chain.

Characters reachable only through browser system fonts draw with bundled last-resort outlines and retain the advances the browser measured. The headless measurer shares the coverage partitioner and uses em estimates for characters beyond its font files. Supporting the system scripts in full and sharing one layout measurer across browsers are part of W6.

Loading faces still mark their records provisional. When a face reaches its deadline the record resolves through the fallback chain, and a later arrival queues the record again. The existing `textWithoutOutlines` bit counts layers that used fallback outlines. The builder and Rust engine exclude it when deciding whether a page can draw.

### System faces, fallback files and bidirectional text

The browser's measured advances determine the reading edge and layout width of each visible run when a requested face is inaccessible. Local Font Access supplies the matching font file when the browser grants access. Without access, the engine places open substitutes at the measured reading edge and preserves their own glyph spacing. Arabic joins and Latin, Greek and Cyrillic kerning stay intact.

The browser preloads Instrument Sans and the private-use box when the engine starts. Bundled face loads stay provisional until they finish, and failed downloads retry with bounded backoff. The display list indexes the faces each text layer uses so a settled face only requeues its dependants.

Engine layout resolves Unicode bidi levels per paragraph and places each wrapped line in visual order. The caret and selection use the same fragment positions. Wrapping oversized words searches a local prefix and bidi range lookup starts at the intersecting paragraph, so wrapping work does not repeatedly measure the remaining paragraph.

After Instrument Sans, the engine uses open Noto outlines for Greek, Cyrillic, CJK, Arabic, Hebrew and symbols. The canvas stack keeps its platform fallbacks. The first engine use of a slice starts its load, with the same per-face settlement tracking as other outlines.

The browser engine and Worker use one fixed catalogue. CJK and monochrome emoji use 256-code-point Unicode blocks. Smaller script faces load whole so joining alphabets share a font file. Browser requests batch up to twelve family and slice identifiers and retry rate-limited batches using Retry-After and exponential backoff. Google receives stock family requests or the catalogue's fixed Unicode ranges. The proxy requires a session, allows 240 slices per account per minute, and reserves one R2 object per entry. Confirmed upstream misses are cached for one day.

Drawpane has no language field on a text layer. Hiragana or katakana anywhere in a layer selects Japanese Han forms, and Hangul selects Korean in a layer without kana. Shared punctuation does not vote. Otherwise the viewer locale selects Noto Sans JP, KR, SC or TC. Traditional Chinese locales include Hant, Taiwan, Hong Kong and Macao. Worker exports use the explicit export locale or the implicit document default described in the phase 4 amendment. Width measurement and outlines both use the node's region. Japanese sound marks and the middle dot use the Japanese face for their own glyphs.

The engine and Worker exports shape the same bundled Twemoji COLRv0 font. HarfBuzz resolves each colour grapheme to glyph IDs and the renderer draws the corresponding ordered palette outlines. The paths scale with the camera or export at any output scale. Emoji outside the bundled font use the outline fallback chain.

## Amendment: opening a large page without blocking input

A live GPU page opens over several revisions. Each frame admits a time-budgeted slice of the initial display list. Parents and sibling paint order are preserved. Descendants of branches in view are sent ahead of the distant branches. The application reports the preview as inexact while the list is incomplete, and sends text through the existing deferred shaping queue. That queue uses the same resolved-face and fallback shaping as a fresh display list. Only one opening preview is submitted at a time, so a long GPU queue cannot bury the first picture. A page switch or an edit affecting the opening page discards the incomplete build. Changes confined to other pages keep the current progress. A preview that misses its presentation deadline uses the renderer recovery path.

In a local SwiftShader reproduction using the Examples records without media, the page switch itself returned in 1.4 ms. The fresh list of 17,922 records took 3,159 ms to build and 506 ms to apply. The longest browser task took 42,954 ms, with WebGPU buffer and texture uploads dominating the sampled CPU profile. The run used the main revision before the missing-face fallback. It previously refused unoutlined text. The fallback amendment above removed that refusal.

With sliced opening, the first message took 15.5 ms to build and 1.1 ms to apply. The longest task in the candidate run was 324 ms. The first GPU preview reached the readback canvas after 5.44 s on this loaded software renderer. This run verifies that opening yields to browser tasks and reduces the blocking work. It leaves the 1 s first-image target open on the real page.

## Amendment: on-demand image levels in the editor (2026-11-21)

The editor retains compressed sources and assigns image handles independently
of resident pixels. It requests levels for both projected axes of each paint,
including crop and repeat, on screen and in the neighbouring tile ring. Two
finer levels can be prefetched. Visible work has priority, uploads are paced
across frames, and an oversized individual texture gets its own upload slice.

The device budget combines adapter limits and reported device memory. The
browser CPU Worker has a separate cap. Under pressure, the cache evicts
off-screen and speculative levels, protecting a visible image's last level
until a replacement is resident. If the visible set exceeds the cap, the
largest levels are reduced first. The view follows every camera and edit with
the best resident pixels, and a permanent reduction can settle at that detail.
The renderer chip reports reductions including unavailable media.

WebGPU copies resized ImageBitmaps directly. WebGL2 uses the bitmap overload
of texSubImage2D. Only the CPU view Worker reads RGBA into WebAssembly.
A level change dirties raster scales whose image sampler would choose
different pixels. The view releases its caches after 30 seconds continuously
hidden. Allocation refusals reclaim optional levels. Missing sources back off
and corrupt bytes are retried only when the source changes or the view reloads.
The strict raw-pixel export API retains its admission checks.

## Amendment for photo detail during zoom and tab restore

While zooming in, the editor projects the recent logarithmic zoom velocity
180 ms ahead. It starts the predicted level while the current level can
still draw and carries an in-flight prediction forward when it can serve
the current view. Up to four decode jobs can run, with a separate 64 MiB
limit on their requested bitmap sizes. Uploads use the existing frame budget.
Speculative levels use the power-of-two pyramid to cover roughly 2× and
4× the current zoom. Active zoom and velocity predictions use the same
pyramid to avoid a new decode at every small step.

The closest useful resident level stays available through decode. A sharper
decoded bitmap can replace that level under the same residency cap, using a
tiny resident copy as the fallback during the swap. After 30 seconds hidden
the view drops nearby and speculative levels and keeps the drawn level of
each visible photo. A backend allocation refusal while hidden can reclaim
those levels down to their thumbnails.

At rest, large sources use 256-device-pixel size steps above 1024 px to avoid
rounding a 5K viewport's photos up to a full 4096 px level. The image budget
scales at 48 MiB per reported GiB of device memory. When memory is unknown,
it defaults to 128 MiB on mobile and touch devices and 192 MiB elsewhere.
Adapter and renderer caps still apply, including 64 MiB on the CPU Worker.

## Amendment: high zoom raster limits in the editor

Glass chunks grow from their visible output, with the sampling grid anchored to
the lens. Gaussian pyramids crop large source planes to the output and kernel
support, aligned to the original pyramid grid. Layer isolation and effect
scratch use the current render target and each effect's support.

The GPU checks the proposed padded target and its working set before changing
frame storage. It renders into a back buffer and configures the surface only
after drawing the replacement. A raster that fits is reused through nearby
camera changes, with a larger candidate checked when the camera settles.
Readback timeouts use the ordinary bounded device recovery path.

The lower-resolution whole view is an interim measure. The intended renderer
keeps the viewport at device resolution and draws only the offscreen halo at
the sampling resolution its readers need. The glass sampling path must also
lift its 4,096 px margin clamps when it can draw that halo. Software adapters
have a smaller padded work budget. A rejected display list or a view that still
exceeds the raster floor uses Canvas for the affected page or view while the
engine stays active. CPU view mode admits tiles by their working target and
tries a direct viewport render at full resolution before reducing it.

An editor viewport that cannot admit its full-resolution glass padding draws
the glass-free prefixes in a second, lower-density pass. Each lens takes its
samples at its own paint position, so later fills and earlier lenses do not
enter the sampled backdrop. The device-resolution pass still draws coverage,
clipping, ordinary paint, and clear lens samples whose rays land in the
viewport. Frost and offscreen refraction use the reduced backdrop. Other
readers retain their own native padding. The frame reports a glass sampling
reduction, and the 4,096 px optical padding cap is replaced by normal texture
and working-set admission.

For clear glass the height mask and bend keep device pixel coordinates. The mask
covers only the visible lens and the support of the height kernel. Rays into the
offscreen prefix still sample on the lower-density grid. A wide uniform
background blur in the page plane can use the same replay. The replay saves
the blurred prefix at that reader's paint position, and the device pass
applies the blur with native shape and clip coverage.

The coarse replay keeps its own render target and backdrop planes, and the GPU
pools the captured textures. Moving frames use the normal retained tiles and
settle with the reader halo when needed. The CPU Worker retries up to half of
device resolution. If it cannot fit that view it reports a viewport limit so
Canvas can draw the view while the Worker stays available.

Progressive backdrop blur keeps its narrow Gaussian stops on the device
grid. Wide stops share a cropped atlas from the lower-density replay,
with the same stop ladder in both passes. The device pass evaluates the
gradient and interpolates variance between stops in device coordinates.
The sharp end can therefore use the original backdrop pixels.

Wide backdrop blur also captures the glass-free backdrop inside an
isolated picture. Patch coordinates use the picture's origin, and the
device pass still applies the shape, clips, and group opacity. The replay
includes the full Gaussian support when the radius exceeds the native
kernel limit.

A backdrop blur feeding a spatial post-effect keeps its native padding.
The post-effect may sample the isolated picture beyond the captured
output patch.

## Amendment: exact camera motion (W4, 2026-11-21)

Pan and zoom on Examples and Toolbars from a large iOS UI kit and on shadcn Combobox must present zero degraded frames, with frame intervals at most 16.7 ms at p95 and 20 ms at p99. This tightens the quality requirement during camera motion. Coarse readers, half-resolution pictures, incomplete coverage, and stand-ins outside a measured scale and sampling phase fail the fidelity gate. Count unpresented camera requests too, since keeping the last exact picture on screen can still leave the camera stalled.

In two earlier paired T4 runs, every arm submitted 120 degraded zoom frames on each of the three pages. Both WebGL2 hardware presentation and WebGPU readback missed the motion and fidelity gates. The earlier reader-upload experiment and its main baseline measured these WebGL2 zoom frame intervals across the two runs.

| Page | Main p95 / p99 | Earlier experiment p95 / p99 |
| --- | --- | --- |
| Examples | 5.50–5.60 s / 5.92–5.97 s | 5.60–5.64 s / 6.00–6.01 s |
| Toolbars | 3.18–3.70 s / 3.26–3.75 s | 3.25–3.83 s / 3.28–3.89 s |
| Combobox | 32.0–36.7 ms / 42.5–51.0 ms | 29.6–81.3 ms / 41.5–99.0 ms |


### What resampling changes

A frosted rounded lens over stripes and one-pixel black paint on white were rasterized at the source scale, bilinearly resampled, and compared with a fresh native raster at the destination. The table reports the worst observed mean and p99 errors in each crop across 1× and 2× device pixel ratios and integer and quarter-device-pixel phases. The aligned 1× control scored zero. The decision's thresholds are 0.25 mean and 4 p99 on the 0 to 255 scale.

| Destination scale | Frosted glass mean / p99 | Sharp paint mean / p99 |
| --- | --- | --- |
| 0.80× | 1.776 / 14 | 6.250 / 19 |
| 0.99× | 0.666 / 21 | 1.213 / 35 |
| 1.01× | 0.736 / 26 | 1.689 / 60 |
| 1.25× | 0.187 / 8 | 4.000 / 15 |

The real Toolbars crops at 2× device pixel ratio scored 0.869 / 32 at 0.8× and 1.035 / 30 at 1.25×. Examples exceeded the thresholds at 0.97× and 1.03×. A quarter-device-pixel translation alone exceeded them on the sharp-paint fixture. Individual images and transforms can qualify. These results give no shared band for either composited pictures or unrestricted ordinary paint.

Device-space rasterization computes coverage of glyphs and edges on the destination grid. Resampling interpolates coverage already integrated on the source grid. Glass also depends on scale at the point of shading: refraction, rim height and frost use device-pixel parameters. Recalculation can change the integer frost mip, height-field resolution, reader bounds, and derivative-driven refraction LOD. Odd-sized mip levels use centered sampling tied to those bounds. Resampling the finished lens retains the old decisions. The 1% measurements show that the combined differences can exceed tolerance close to native scale.

### Design

Examples has 630 glass layers and 291 background blurs. If all 630 lenses draw, a 16.7 ms frame leaves an average of 26.5 µs per lens before ordinary paint, blur, or presentation. Toolbars has 164 glass layers and four background blurs. Combobox's four readers are all background blurs. A glass-only improvement therefore needs separate validation of background blur and native paint costs.

Rasterize sharp paint at the requested device scale and phase, and accelerate native glass separately. Share exact backdrop inputs when the source paint inside each extended read region agrees. Preserve scope, extension, clamp rules, and the region-local filter grid. Non-glass paint and other backdrop-writing effects invalidate intersecting read regions. A single unconditional blur pyramid would cross intervening paint and change filtering around region boundaries. Keep independently reusable source work, such as geometry and mask inputs, separate from reader output that depends on the prefix.

Start by reducing redundant work inside the exact reader path. Preserve the CPU reference, including its intermediate rounding, and keep fragment passes as the common backend. Compare fused compute on WebGPU if it can preserve these rules and reduce measured cost. Recomputing the existing exact path at every camera change costs seconds on the largest cold views, including on T4 WebGPU, so it cannot meet the frame budget as built.

Retain completed tiles where the revision, camera scale and device phase match. These cover revisits and integral-device-pixel pans. Continually changing scales and fractional phases need fresh sharp rasterization. Predict the device-space viewport from pan velocity and the rate of change of log zoom, and prioritize work that will cover it soon. Use an explicit encoding and in-flight GPU budget for background preparation. Charge prediction and reader scratch to the engine's 768 MiB default GPU budget and charge retained frames to its 256 MiB tile cap within that budget. Evict speculative work before visible coverage. If a cold camera jump outruns preparation, a held frame counts as a missed presentation. This keeps the gate honest while the exact path is too slow.

Figma publicly describes retained GPU rendering through WebGPU and WebGL. Its visible motion is consistent with keeping geometry and working textures resident, rerasterizing sharp edges, and batching effect work across compatible sources. That is a hypothesis about the internal renderer. The acceptance evidence here is paired T4 runs with hardware presentation in WebGL2 and GPU execution measured separately through WebGPU readback.

### Measurement

Use `BENCH_W4_CAMERA_GATE=1` with `bench/file.spec.ts` in both T4 modes. `BENCH_W4_NATIVE=1` draws the whole reader viewport at its requested device scale and phase during the sampled gestures. Use it on both arms to isolate exact rendering changes from the established motion policy. The gate counts submissions, confirmed presentations, and camera requests without a new frame. The frame-interval thresholds apply to hardware-composited presentation. Readback on the T4 exposes WebGPU work and fidelity with software compositing.

The first exact-reader change skips the mask reduction pass when its factor is one, applying the same height-format conversion in the horizontal filter. It builds the original backdrop only through the integer level frost samples. Refraction still has the full frosted chain. Retained mip bind groups and one reader-uniform write per encoder submission reduce recording work. The rim and frost shaders iterate only the taps in their Gaussian radius.

In a 230 × 145 SwiftShader WebGL2 fixture with six lenses, the final RGBA readback was byte-identical on main and the candidate. The independent SwiftShader comparison found byte equality in 339 of 341 matching cell renders, including all matching WebGL2 cells. On WebGPU, two text-shaped lenses changed by one to two 8-bit levels because the factor-one path moves half-float rounding from the attachment write to the horizontal filter. Both cells stayed within CPU/GPU tolerance and moved slightly closer to the CPU reference. Framebuffer attachments fell from 1,437 to 1,017 per frame and buffer uploads from 77 to 42. Both arms issued 13 fences, which still follow Vello staging boundaries. Fence timing varied substantially in software and WebGPU startup probes timed out. These results quantify the work removed. The real-page motion gates remain open.

## Amendment: product flows on the engine (W2, 2026-11-21)

Every browser picture outside the live editor canvas now has an engine implementation gated behind the existing renderer switch (`rendererChoice() !== "canvas"`), keeping canvas mode intact until W8 flips the default:

- **Browser engine snapshot service (`apps/web/src/editor/engine-snapshot.ts`, `engine-snapshot.worker.ts`):** One dedicated Web Worker loads the browser CPU build (`@drawpane/engine/browser-glue`, matching `engine-cpu.worker.ts`) with a device-scaled image budget (`deviceImageBudget(192 MiB)`), exact drawn photo sizing (`chooseDrawnImageSize`), a lazy streaming Wasm decoder fallback (`@drawpane/engine/decode`), a per-job watchdog, priority scheduling (`high` for exports, `normal` for export previews and prototype overlays, `low` for thumbnails and asset/template previews), `AbortSignal` cancellation before and between bands, and a fresh `RenderEngine` per job. PNG renders stream band by band (`renderPngStream`) up to 8,192 × 8,192 px; JPEG and WebP render band by band (`renderBand`) onto an `OffscreenCanvas`.
- **Shared export helpers (`packages/editor/src/export.ts`):** Preserves the 16,384 px product export limit (`MAX_EXPORT_SIDE = 16_384`), adds `exportSizeError`, `exportBackgroundRgba`, exact drawn photo sizing and image budgeting (`collectExportImageUses`, `chooseImageLevel`, `chooseDrawnImageSize`, `budgetExportImages`, shared with `headless-render.ts`), `thumbnailLayout`, and `vectorApproximations` / `vectorApproximationNotes`.
- **Product flows following the renderer switch:**
  - Raster exports (`exporting.ts`: PNG, JPEG, WebP, Copy as PNG) use the engine snapshot service when the switch is on (with transparency, JPEG opaque white default, scales, decision 0039 contextual backdrops, inline/toast notes if images are reduced, and lazy `CanvasRenderer` fallback for 8,193..16,384 px exports or unsupported effects such as progressive layer blur with offsets), and `CanvasRenderer` in canvas mode.
  - Export panel preview (`ExportSection.tsx`), dashboard page thumbnails (`thumbnail.ts`, WebP at 0.85 stepped to fit the 64 KiB keepalive budget), component and team-library previews (`ComponentPreview.tsx`), new-file template previews (`new-file/create.ts`), and prototype screen thumbnails and overlays follow the same switch with lazy canvas fallback on engine refusals.
- **Prototype player (`apps/web/src/prototype/stage.ts`, `Player.tsx`):** Keeps the synchronous `CanvasRenderer` stage in canvas mode, and runs live on its own `EngineView` (`webgpu -> webgl2 -> cpu-worker`) when the engine switch is on. Animated transitions capture the outgoing frame directly from the live GPU view (`EngineView.captureFrame()` via `gpuPixels()`) before drawing the incoming screen. When the engine cannot draw a screen (`NOT_DRAWN` or backend unavailability), the stage hides stale pixels and falls back per page to `CanvasRenderer` or displays an unavailable status with hotspots disabled.
- **SVG and PDF vector paths:** Kept on their vector exporters. Both formats omit background blur and approximate glass as a lit rim without refraction, frost, or external backdrop context; this is documented in decision 0039 and surfaced inline in `ExportSection.tsx` and `InspectPanel.tsx`.
- **Lazy `CanvasRenderer` in `Canvas.tsx`:** `CanvasRenderer` is only instantiated when canvas mode is active or a fallback occurs, so engine-only sessions never construct it.

### Batching exact readers

Keep sharp paint at the current camera scale and device-pixel phase. The
follow-up calibration puts the high-frequency energy ratio of a bilinear
1% zoom stand-in near 0.52 on retina text and hairlines. Fractional pan
reaches 0.34, and even a 2× cache with area filtering reaches only 0.82.
Frosted interiors without a rim have smaller errors, with p99 of 1 to 2
levels for the examples tested. This rules out a page-wide scale ladder.
It also rules out freely resampling sharp paint and rerendering only glass.
Keep exact tile reuse for matching scales and integer-device-pixel pans.
Use prediction to queue visible work, with the existing memory budget and
speculative eviction policy.

The six-lens WebGPU trace on main recorded 143 render passes, 114 reader
passes, 124 bind groups, and 13 queue submissions. Packing uniform writes
and trimming unused mip levels still leaves submission boundaries between
Vello paint and lens masks. At Examples' 630 lenses, the entire 16.7 ms
frame would allow only 26.5 µs per lens before sharp paint, backdrop blur,
and presentation. Reduce the number of passes and submissions by grouping
lens work.

Decision 0007's glass-free backdrop permits sharing when each lens sees the
same paint inside its own extended read region. A group may cross intervening
paint whose conservative bounds miss those regions. Preserve the order of
writes to the visible plane. A pending visible write must finish before
intersecting paint or readers that sample the visible plane. Isolation,
masks, clips, blend operations and unknown paint bounds split a group
unless their effects are accounted for. Batch frost and height work over
region-sized atlas allocations. Keep each lens's extension and clamp rules,
region-local mip phase, and intermediate precision. Cap atlas scratch
against the reader budget and split before exceeding the cap. Fall back to
the existing serial reader for unsupported cases or allocation pressure.

Rounded rectangles, capsules and ellipses can evaluate the rim from their
geometry. The reference filters sampled mask coverage, including corner
curvature and device-pixel phase. Compare analytic height and final pixels
against the reference across small lenses, phase shifts and rotated shapes
before enabling any analytic case. Arbitrary outlines keep raster masks.
A dual-attachment composite writes the same premultiplied paint delta to
the visible and glass-free planes in one pass, with source-over blending
on each. Glass itself still writes only the visible plane.

Capture the exact camera and pixels of confirmed motion presentations in
an untimed replay pass. After the gesture, render native exact references at
those cameras and the same DPR. Evaluate missing or wrong content with the
per-tile share of pixels exceeding ΔE2000 of 10, sharpness with the
high-frequency energy ratio (0.85 to 1.2), and NVIDIA LDR FLIP at declared
pixels per degree. Compare the last moving frame with the settled frame at
the same camera and track changes in sharpness across consecutive samples.
Keep the frame-interval and missed-presentation measurements independent of
readback. Thresholds for perceived quality remain provisional until
calibrated on a laptop.

The first direct-distance spike plugs a rounded-box or ellipse distance and
its local normal into the existing lighting and refraction equations. It
removes the Vello shape mask and the two height-filter passes for eligible
lenses. In a six-lens SwiftShader WebGL2 trace, framebuffer attachments
dropped from 1,017 to 777, uniform writes from 42 to 13, and submissions
from 13 to seven. The larger candidate fixture timed out during readback.
In an independent sampled-field check at 0.25× to 1×, direct coverage
differed from the supersampled edge by up to 22 levels. The p99 inward
direction error reached 36.6° for the rounded box and 11.3° for the ellipse.
Curved and adjacent boundaries contribute jointly to the Gaussian field.
A nearest-edge normal and a half-plane height omit that combined influence.
Keep the raster reference while batching coverage first. Admit a parameter
range for analytic height only after it passes the same-camera pixel gate.

The first batch groups raster mask coverage for simple lenses into one
bounded atlas in exact whole-view draws. Coverage is independent of the
backdrop, so this step can cross any number of backdrop changes without
reordering paints. The atlas packs lenses in display-list paint order,
visiting children where their parent draws them. Vello flattens geometry
and generates coverage in each lens's local coordinates, then translates
the finished strips to tile-aligned slots. A lens keeps its original
raster dimensions and uses the serial path when clipped to a different
region, split, or too large to fit. Coverage plus depth fits within the
reader budget and is capped at 8 MiB. Source extraction, frost, height
filtering, and visible writes remain in paint order. Dual-plane paint uses one attachment pass when
both targets have matching allocated extents. Mismatched pooled targets
use the serial composite passes.

A paired six-lens 230 × 145 SwiftShader fixture matched the reference byte
for byte on WebGL2 and WebGPU. WebGL2's framebuffer attachment calls fell
from 1,017 with serial composites to 972 with the dual-plane pass, then to
872 after batching masks. Submissions on both backends fell from 13 to
eight after batching. WebGPU's Vello render passes fell from 19 to nine,
and its paint composites fell from ten to five. Each arm still encoded
six backdrop extracts, six pairs of frost passes and 36 mip passes.
These counts cover one native camera sample after warming the renderer.
They measure the work removed from preparation and composition.

The two T4 comparisons of the first reader setup change used 120 native
Examples zoom requests per arm. Confirmed WebGL2 frame intervals were
12.40/13.12 s at p95/p99 on the baseline and 11.94/13.67 s on the candidate
in the first pair. Reversing the order gave 11.67/13.88 s and 12.00/13.44 s.
This does not establish a motion improvement on the full page. The core
WebGPU adapters passed GPU verification. All four core WebGPU cases timed
out waiting for the opening view to settle before zoom.

An early atlas prototype reduced submissions from 49 to 26 in a
24-lens fixture. It rasterized at atlas coordinates, which changed three
of 133,400 color bytes by one level. The slot-local rasterizer makes current
atlas and serial whole-frame draws byte-identical. The regression suite
compares a seven-lens atlas to a budget-forced serial render and compares
an edited six-lens atlas to a fresh engine. Both comparisons are byte-exact
on WebGPU and WebGL2. The separate whole-frame versus tiled fixture
permits up to two levels of edge rounding across the tile boundary.

The 24-request T4 pairs against main 4957f364 used hardware WebGL2
presentation and submitted the same exact camera sequence on each arm.
Mask batching and dual-plane paint measured 13.26/13.26 s and 12.57/13.20 s
confirmed p95/p99. The paired baselines measured 13.86/13.90 s and
14.01/14.35 s. Core WebGPU submitted the inputs with software presentation
and confirmed zero readback frames.

The first pixel replay version missed confirmation or scoring deadlines
during those runs. The untimed replay now waits for each confirmation and
readback before advancing, with the cadence run unchanged. A two-camera
WebGL2 smoke run on T4 after #270 passed both same-camera comparisons at
2× DPR. Content error and FLIP were zero and the sharpness ratio was 1.0,
including at the stopping camera.


### CPU encoding on the T4

The engine skips rasterizing an open clip when its coverage is provably
full over the pixels being drawn. It keeps the same scope compositing
arithmetic. A blend uniform buffer holds 256 aligned parameter slots, so
consecutive blends can share a submission.

Before those two changes, an eight-input WebGPU Examples zoom measured
5,614.5 ms of CPU work at p50, with 16,354 submissions and 12,246 Vello
renders per frame. Vello render preparation accounted for 2,811.3 ms
and submission for 445.5 ms. A separate six-sample near-fit measurement
recorded 4,092.6 ms on the CPU and a 154.9 ms GPU completion tail, with
14,814 submissions and 11,322 Vello renders per frame.

In the main-first paired run against main 42b7fb7e, WebGPU zoom CPU p50
was 5,458.9 ms on main and 5,293.8 ms on the PR. Submissions per frame
fell from 16,885 to 15,419 and Vello renders from 16,100 to 15,293. The
six near-fit samples measured 3,936.8 ms CPU and 153.0 ms GPU tail on
main, and 3,892.9 ms CPU and 146.9 ms GPU tail on the PR. The tail starts
after the CPU draw returns. GPU timestamps spanning the frame also
include gaps while the CPU prepares later submissions.

Both arms sent 24 camera inputs. WebGL2 confirmed all 24 presentations
in each arm, with confirmed p95 falling from 13.593 s to 11.797 s.
Core WebGPU waited for each requested frame's asynchronous readback
before advancing. Main confirmed 24 of 24 submissions and the PR
confirmed 26 of 28, including additional draws during the gesture.
These timings leave the opening and interaction gates open.

WebGPU still spends seconds preparing and submitting Vello work. Vello
render preparation took 3,211.5 ms of the PR's 5,293.8 ms zoom CPU p50.
The compute path should address that preparation cost and reduce the
number of Vello render segments by batching reader work. On WebGL2,
most of the measured draw time is spent inside submission.

## Amendment: the compute P0 review and P1-0 (2026-11-21, corrected 2026-11-22)

PR #291 recorded P0, the kill gate for Vello 0.12's GPU compute pipeline on ordinary paint, as passed. **It did not pass.** The independent review of #291 blocked it, and this records what it found, what was rebuilt since, and the gates P1-0 has to clear before P1 begins. A second independent review, of the rebuilt stack, found bugs in it too; the fixes and the numbers below are from after that review.

**What the review found.**

- **Undersized buffers, reported exact.** Bump buffers were sized from the path count alone. `coarse` reserves `PTCL_INITIAL_ALLOC` (64) command words for every 16 x 16 tile before it allocates anything: 1,301,760 words at 2,880 x 1,800. On a Tesla T4, an 857-path page at 100% drew nothing below row 352, and a 40k-path page at fit overflowed its line buffer, leaving 71% of its pixels more than 16 levels off. Both frames were reported exact, with `bump.failed` clear in the first case.
- **No failure path.** Bump counters were read back after the frame was presented, for statistics only. Nothing grew a buffer, redrew a frame, fell back, or stopped after validation errors.
- **Understated CPU cost.** The reported 0.2 ms per frame excluded `is_ordinary_page`, which walked the whole store on every frame. The main-thread wall time of the render call was 2.6 to 3.3 ms at 10.8k records and 10.1 ms at 40k. Every edit rebuilt and uploaded the whole page: 42 to 68 ms at 10.7k paths with warm caches, 155 to 270 ms at 40k.
- **Real files aren't ordinary.** Routing whole pages to compute covered 1.6% of the visible layers in a large iOS UI kit and 0.04% in shadcn. Routing per top-level board would cover 5.9% and 8.7%. Drop shadows alone blocked 52 of shadcn's 83 pages. In the iOS kit, more layers use a non-normal blend than a drop shadow: 5,143 fill blends and 3,851 layer blends, against 4,480 drop shadows and 1,517 images. Glass and background blur block most of the rest.
- **Cost for every user.** The default browser module grew from 608 to 849 KB gzipped for every WebGPU user, flag or no flag.
- **What held.** Fidelity held. All 100 compute-drawn parity cells met the CPU/GPU tolerance (worst mean 0.214, p99 at most 1). The shared geometry moved the CPU oracle closer to Figma on 26 cells, farther on 4 (each by at most 0.02), and left 276 unchanged. #291's high-zoom stroke test held 0.04 device px at 256x Retina, but it only drew circles; the stack review found other curves far off (see #293 below).
- **Methodology.** The GPU median for 10.7k paths was 4.5 ms at 100% and 8.4 ms at fit, with a repeatable 25 ms p99 at 100%. The bench kept only quantiles, so which frames were slow was lost. The vello_gpu baseline was 24 forced whole-frame samples, so its p95 and p99 were its second-worst and worst frames.
- **Upstream status.** `vello_shaders` 0.12 ships from Vello's `research/` directory: the classic compute pipeline is no longer Vello's main line, and P1 to P3 own a fork of it.

**What was rebuilt (P1-0 items 1 and 2).** These pieces are separate PRs, stacked: #293, #297, #298, #299, #300 and #303.

- **The shared geometry merges on its own (#293).** That covers one flattener for every backend, cached stroke outlines, camera-independent ellipses and the cross-line glyph sweep.
  - **High zoom.** A cached outline is expanded once, at 0.025 record units, so zooming in magnifies its error. At 256x Retina (512 device px per unit) the stack review measured a 200 x 40 ellipse 3.52 px off the true stroke, a 3,000 x 200 ellipse 10.29 px and two cubic S-curves 6.84 and 16.72 px. A draw now passes its device scale. Past 5 px per unit it gets a finer outline, the base tolerance halved until it is within 0.125 device px, and up to two finer outlines are kept per stroke beside the base one. The same four shapes are now 0.09, 0.30, 0.30 and 0.69 px off, against main's 0.24, 0.43, 0.30 and 0.69. The S-curves' remaining error is their round caps, as on main: kurbo draws a cap as one cubic per quarter turn.
  - **Memory.** Kept outlines count against a 48 MiB cap per engine (`Limits::stroke_bytes`). Past it, each frame drops the least recently drawn outlines down to three quarters of the cap, never one drawn in this frame or the last. The largest kit page the review measured holds 26 MiB (shadcn; 1.8 MiB in the iOS kit).
  - #291 also clipped reader-free frames and outline masks with isolated clip layers. In vello_gpu that cost opening time: over three paired T4 runs against main with #278, the clip-heavy Colors page opened in 1,016 to 1,067 ms against main's 762 to 959 ms, failing the 1 s gate each time. Without the clip layers it opened in 837 ms in the same container, and in 786 to 895 ms in two later pairs. #293 therefore keeps vello_gpu on clip paths.
  - Only compute uses clip layers, because Vello 0.12 compute has nothing else. The two differ only where children overlap an anti-aliased clip edge (up to about 48 levels on those pixels). The capacity matrix's pages don't put children on clip edges; real pages do, so P1 needs a parity cell for it.
  - GPU pan medians moved by -1.5 to +6.0 ms across six paired runs, and by +0.4 and -0.5 ms on the two pages in the pair on #293's head.
  - On a T4 against main with #278, CPU parity against Figma moved closer on 26 cells and farther on 4 (by at most 0.02). WebGPU parity moved closer on 27 and farther on 3. All 27 suites passed with no fallbacks.
- **Compute is a separate, opt-in module (#297).** The `compute` Cargo feature builds `dist/compute`, which only `?compute=1` loads, and only where `navigator.gpu` exists. The default browser module carries no compute code: 634 KB gzipped with the whole stack, against 630 KB on main. The compute module is 878 KB gzipped. Both are decimal kilobytes of gzip, from the T4 build logs.
- **Every compute frame is checked before it is shown (#298).**
  - Buffers are sized from the canvas as well as the scene, and the per-tile command region is always included (`compute_caps.rs`).
  - Each frame draws into a back buffer and is presented only after its bump counters, error scopes and the device check come back clean.
  - A count past its capacity is an overflow even without Vello's flag, because Vello never bounds-checks `segments`.
  - On overflow, buffers grow to what was asked for plus half again, and the same frame is redrawn.
  - Six draws of one frame, any GPU error or a lost device turns compute off for the session, and the status chip says so.
  - Binding limits and the engine's GPU budget are checked before every buffer is allocated, the scan scratch included, which is sized after the page's encoding.
  - A frame is checked for the content it was staged for, background included: one staged before a background change is dropped, never shown. While content changes, vello_gpu draws, and compute takes over once it holds still for a frame, so a resize can't starve the canvas.
  - A fresh page resets the buffer sizes learned on the last one.
  - The page's encoding is kept apart from the canvas-sized buffers, so growth and resizes never re-encode it.
  - The ordinary-page check is cached per revision.
- **The capacity matrix is the gate.** `/diagnostics/renderer?compute=1` and `bench/compute-matrix.spec.ts` run it.
  - It draws generated ordinary pages of 900, 10,000 and 40,000 layers at 1x and 2x, at 100%, 200% and fit, plus "tight" cells that start from minimal buffers so they must grow and redraw. Each is compared with vello_gpu on its own device. Later cells check a fresh page after a large one, nine drag steps (#300) and the bump gate.
  - On a T4, on the stack's head (#303), all 42 cells were drawn by compute and passed. Across the 30 page cells the worst mean was 0.173, p99 at most 3 and the worst 32 x 32 tile 0.386; the largest single channel difference was 26, on the 40k page. 49 checks caught an overflow and redrew, and none of those frames was shown.
  - The 857-path Retina page and the 40k fit view the review reproduced are within tolerance now.
  - `bench/compute-editor.spec.ts` drives the editor itself: a frame staged under one background never shows once the background has changed.
- **Benchmarks are honest (#299).** CPU counts the main-thread wall of every engine call a frame takes, routing included, split into staging, showing, any vello_gpu fallback and the engine's own encode, render and submit. Every frame is kept in order with its GPU pass times, and the slowest are listed. Edits and drags patch the card in the middle of the view, at 10k and 40k layers, against vello_gpu. A browser a person drives presents to a real canvas; automation reads back, because headless Chromium loses a WebGPU device that presents. Safari has no timestamps and shows "No timestamps" rather than a failure.
  - On a T4 (all figures from one run on #303's head), compute cost 0.3 / 0.5 / 0.7 ms of main thread per frame (p50 / p95 / p99) on the 10k page, and 1.95 / 2.47 / 2.49 ms of GPU at 100% and 4.46 / 5.51 / 5.78 ms at fit. The 25 ms p99 #291 reported did not appear: around 100%, the slowest frames are the most zoomed-out ones.
  - The check delays showing. Checked frames reached the screen 25 to 52 ms after they were asked for at p95, across four runs, against 17.5 ms for vello_gpu's moving frames (#303 below).
  - #299's first version edited a card 3,000 px off screen, so vello_gpu drew nothing and its drag cost read about 15 times too low. On screen, a vello_gpu drag frame costs 9.0 / 11.0 ms of main thread (p50 / p95) at 10k layers and 10.7 / 11.2 ms at 40k.
  - A recolour re-encodes the page on compute: 35 ms of main thread at 10k and 142 ms at 40k (p50), against vello_gpu's 8.4 and 9.7 ms.
- **Drags don't re-encode the page (#300).** A patch that only moves records (`Applied::moved`) changes nothing in the encoding but the world transforms of the moved subtrees.
  - The encoder records each record's span of the transform stream and forces a fresh transform at each record boundary.
  - A move left-multiplies `new_world * old_world⁻¹` into its subtree's spans, in f64, and uploads only those transforms. The subtree comes from the store's tree, so a group that draws nothing of its own doesn't move with its only child, and a move costs its own subtree, not the page.
  - A move under an ancestor that bounds its children with a fixed layer rect (an isolated translucent group, a blend or an `Op::Layer`) re-encodes, since the rect was sized from where the children were.
  - Patched equals fresh to one f32 ulp (`tests/compute_moves.rs`, including one-child groups, bounded ancestors and 500 cards moved at once on a 40k page).
  - The stack review's repros of the first version (a one-child group, a child dragged out of an isolated group, 500 cards in one move) showed 7,200 and 1,600 wrong pixels reported exact, and 103 ms per move. Each now has a native test and a matrix cell.
  - On a T4, with the card on screen, a drag frame costs 0.6 / 0.8 ms of main thread (p50 / p95) at 10k layers and 1.4 / 2.4 ms at 40k, against vello_gpu's 9.0 / 11.0 and 10.7 / 11.2 ms. All 60 drag patches in the bench were applied in place.
- **Compute frames can skip the wait (#303).** A checked frame waits for its read-back before it shows, so on a T4 a compute frame took 25 to 52 ms at p95 from request to screen, against vello_gpu's 17.5 ms. The prototype draws the frame into a private texture, then a full-canvas pass reads the bump counters on the GPU and copies the frame onto the canvas only if every stage fit. Otherwise it discards the whole frame, and the canvas keeps its last good pixels: an overflow costs a dropped frame, never a wrong one. The frame is presented at once; the read-back still decides exactness and grows the buffers.
  - On a T4, gated frames on the 10k page reached the screen in 17.6 ms at p95 around 100% and 17.5 ms around fit, against 17.5 ms for vello_gpu's moving frames, at 2.35 and 4.45 ms of GPU (p50). The matrix's two gate cells overflow on purpose: the canvas kept the last good frame unchanged, and the redraw after growing was within tolerance.
  - The editor uses the gate for a still view only. Moving frames stay on vello_gpu until laptop numbers say whether compute should draw motion.

**P1-0 gates, before any of P1.**

1. **Correctness.** The capacity matrix passes on every device class measured: every cell exact or fallen back, never wrong. *Met on a T4.*
2. **Laptops.** The 10k Retina bench on Apple Silicon (base and Pro) and an Intel iGPU, in Chrome and Safari on Apple Silicon, through `/diagnostics/renderer?compute=1`.
   - The gate is GPU p95 at most 8 ms at 100%.
   - If 100% runs past about 10 ms of GPU time, viewport culling becomes P1's first task. Today flatten's work is O(page), not O(view).
   - Safari has no timestamp queries, so it reports CPU and shown times only. *Open: the page is ready; the reports are not in yet.*
3. **Edits.**
   - Drag frames cost at most 8 ms of main thread at 10k and 40k paths. *Met for drags on a T4, multi-card moves included (0.8 ms p95 at 10k, 2.4 ms at 40k). Open for other edits: a recolour costs 35 ms at 10k and 142 ms at 40k (p50).*
   - Edits other than moves need per-board encodings spliced into the packed scene. Vello 0.12 consumes one packed scene with prefix scans over the whole tag stream, so a splice re-uploads from the edit onward and reruns the scans on the GPU. That is cheap on the GPU, but uploads are O(page) unless boards get fixed-capacity slots. This decides whether compute can be the only rasterizer.
   - Per-board (or spatial-chunk) encodings with viewport culling would address both this and gate 2's O(page) flatten, so if either gate misses, that is P1's first build.
4. **Latency.** A compute frame reaches the screen within one display frame of vello_gpu's on the same device, at p95, and never shows an overflowed frame. Checked frames miss this by one to two display frames. *Met on a T4 through the bump gate's zoom sweeps (17.6 ms p95 against vello_gpu's 17.5). Open: laptops, and motion in the editor, which still draws on vello_gpu.*
5. **Coverage.** Report the share of visible kit layers compute actually draws for each routing expansion, and state what each kit should expect. P1's scope (below) is chosen from these counts: shadcn gains most from drop shadows and images, while the iOS kit needs blends first and still stops at its readers.
6. **Bundle.** Attribute the compute module's size (twiggy) and set a realistic gate. P3's "main + 100 KB" doesn't fit a separate module that is loaded only when asked for.

**P1 scope: drop shadows, image fills and blends.**

- **Drop shadows** stay exact by reusing the existing Gaussian path rather than Vello's analytic blurred rounded rect, which approximates corners.
  - The GPU shadow pass already renders each shadow's blurred, tinted mask at device scale and caches it by shape, blur, colour and scale.
  - Compute draws those masks as image fills from its image atlas, at the shadow's place in paint order and on whole device pixels, so sampling is exact under translation.
  - A zoom re-renders the masks, as vello_gpu's shadows already do.
  - Inner shadows follow the same path, inside the shape's clip.
- **Image fills** use Vello 0.12's image draw, which is already in the encoding.
  - Visible image levels are chosen as vello_gpu chooses them and packed into atlas pages with the local sampling transform and extend mode.
  - They stay premultiplied, as now.
- **Blends.** Non-normal fill and layer blends are the iOS kit's largest blocker. Vello 0.12 compute already draws blend layers (the vendored `blend.wgsl`, with its patches), so they need routing and parity rather than a new pass.
- All three need CPU-reference and Figma parity gates before routing counts them.
- **Readers** (glass, background and progressive blur) stay out of P1. A page with readers either splits into compute chunks between reader passes, or keeps a stable rasterizer per chunk. Swapping rasterizers mid-page shifts anti-aliased edges, which 0040's item 6 forbids on Core devices.
