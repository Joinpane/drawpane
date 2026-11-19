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

A board picture is reusable only while everything its pixels depend on is unchanged. Pass-through blends and backdrop readers make a layer's pixels depend on drawing outside its own subtree (decisions 0038 and 0039); masks and faded frames cut that dependency off (decision 0016). So caching follows a graph of what reads what, not the layer tree.

### Nodes

- **Source:** a layer's own drawing with no dependency on what's beneath (fills, strokes, glyphs, shadows of a normal blend), in its own coordinates. Its geometry (strips, glyph coverage, a glass shape's mask and height field, a shadow's blurred mask) is cached independently of any destination.
- **Scope:** where backdrops come from.
  - The page is a scope.
  - So is every layer that isolates: fading as one, a mask group (masked layers are drawn apart, 0016), a layer blur, a layer that blends as one.
  - A frame that doesn't isolate is not a scope: blending passes through it.
- **Backdrop prefix:** for a reader at paint position *p* in scope *S*, the composition of everything before *p* in *S*, restricted to the reader's read region (its extent grown by its reach).
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
| Linear, radial, angular gradients | Vello gradient paint with the layer's unit-square transform as its paint transform (decision 0013); angular is Vello's sweep gradient. Diamond comes in as radial today and stays so. |
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
| Background blur | Reader: its prefix within its reach (repeated at the canvas's edge, stopped at clipping frames), blurred, cut to the shape (to the glyphs under text, skipped under a fill that hides what's under it), before the layer's fills (decision 0039) |
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
  - edges clamped (repeated) unless a pass says otherwise (decision 0039's clipping-frame rule is "otherwise").
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
- Readers join in paint order, then again until none joins (a fixed point, at most one pass per reader): a reader that reads after its children reads what readers inside it paint, and those come later in paint order. A record reading both before and after its children counts as reading after them.
- Where a record paints is its ops' bounds, each stroke grown by how far its outline can reach: half its width times its miter limit for mitered joins, √2 for square caps, plus a unit. The wire's miter limit is taken as at most 1,000, for drawing and bounds alike, so bounds stay finite and true (`0040-display-list.md`).
- A fresh list (a page switch, a reload, a recovery after a refused patch) drops every tile and forgets the last frame: it shows a page that's gone.
- An image put or dropped invalidates the records that paint it (`Store::image_users`).
- A change of background or of the readers' reach drops everything.
- Glyph masks are keyed by a definition's serial, which is never reused, so they can't go stale. Saved glyph sets edited and faces arriving reach the engine as patches of the text that uses them (phase 1's builder fixes), so their tiles go stale like any edit.

**Scheduling: never one long frame.**

- A frame plans its tiles over the part of each on screen. It draws first every tile nothing can stand in for (a page just opened, a jump), whatever its budget, then the others in order of distance from the view's centre while its budget lasts: 4 ms while the camera moves, 12 ms once it rests (`MOVING_BUDGET_MS`, `REST_BUDGET_MS` in `engine-view.ts`). A tile past the budget waits for a later frame; the frame goes on to the next, so nothing that must be drawn is ever left behind one that can wait. Every frame draws at least one tile.
- **Between frames at rest**, the engine draws what the next frame wants (`renderGpuAhead`, `EngineView.ahead`): the tiles the last frame shows that aren't up to date, nearest the centre first, then the tiles round the view, in slices of 6 ms (`IDLE_SLICE_MS`; at least one tile each), compositing and presenting nothing. When the camera comes to rest where the last moving frame was drawn, that frame stays on screen and the slices start at once; when the tiles it shows are all drawn, the exact frame is drawn from the slice that finished them, not a frame later. Tiles round the view (ahead of a pan, and a coarser level a zoom out stands on) are drawn the same way, with no frame for them.
- While the camera moves, the editor draws a frame each animation frame while it isn't exact. A frame asked for with no budget (`renderGpu(…, false, 0)`: tests, exports of the view) comes back exact.

**GPU memory.**

- Tiles live in pages of 2,048² (16 tiles, 16 MiB each), drawn by Vello into their slot with one shared 16 MiB depth buffer.
- They take what's left of the engine's 768 MiB beside everything else it holds (images, the glyph atlas, frames, read-backs), less 32 MiB of headroom, and at most `tile_bytes` (256 MiB by default, a limit like the others). This is worked out every frame, so images arriving shrink the tiles, never the other way round. Pages past it go, with their tiles.
- Frames are two textures (shown, being made), with no depth buffers now that they're only composited.
- **Eviction**, when a tile needs a slot: never a tile the frame shows, drew or counts on to stand in. Other levels go first, finer ones first, then the frame level's tiles farthest from the view, then the least recently used.
- **Planned within the slots.** A frame pins what it shows and the other levels' tiles it counts on to stand in, and plans its jobs within the slots left. A zoom's ladder tiles for a part of the view are planned only if they all fit. Where a tile that only another level stands in for finds no slot, it's drawn this frame instead, freeing what it counted on, so a frame at rest always progresses.
- **Degradation:** a tile the frame needs and no slot can hold is drawn straight into the frame, over the composite, through a scratch tile, and kept nowhere (`Job::direct`). If the frame's own tiles can't all be kept, the whole frame is drawn that way (`Plan::direct`). Slower, still exact, never blank.
- **The glyph atlas** (2,048², 16 MiB, allocated whole) holds the GPU's masks, and by default the masks it keeps are what it holds. When it's full and no shelf suits a mask's height (a zoom changed the scale), neighbouring shelves no tile is drawing from are merged into one that does, so masks of a new size are never refused for good. Each tile starts its own mask frame (each is its own submission, so what earlier tiles drew from may go), and room is found before a mask is rasterised: a glyph whose mask can't be kept is drawn as its outline without wasted work.

**What phase 1's frame reuse became.** The pan-shift and zoom-scale planner (`plan.rs`) is gone. Its rule, a frame texture holds exactly the camera it was drawn for, is now the tiles' rule: a tile holds exactly its own view.

**Gates added** (all in CI):

- `packages/engine/rust/tests/tiles.rs`: seeded random walks of edits, whole and fractional pans, zooms about a point, page switches, image changes and memory pressure (slots for fewer tiles than a frame shows, and for a frame and a bit), frames moving under budgets of zero to two tiles. Every frame reported exact is compared with a fresh engine's, bitwise; every frame at rest becomes exact within a bounded number of frames; a stand-in reports what's pending. Tiles against whole frames: at most 2 levels apart. Tiles drawn ahead between frames leave the next frame exact, a fresh engine's, with nothing to draw.
- `packages/engine/rust/tests/tile_regressions.rs`, each a frame that went wrong before its fix (the phase 2 review): a zoom under a one-slot budget and under one GPU page of slots never shows background where the page has content; a change beneath a reader inside a reader that reads after its children leaves no stale exact tile, and reaches readers three deep; a stroke with a miter limit of 40 isn't culled from the tile its miter reaches.
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
- In `gpu` mode (the canvas renderer's real intervals, both runs canvas): frame interval p50 16.6 to 16.7 ms, p95 17.9 to 26.2 ms, p99 18.7 to 54.5 ms.
