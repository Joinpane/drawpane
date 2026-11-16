# 0028. Drawing at scale: a spatial index, redrawing what changed, and frames drawn a tile at a time

- Status: accepted
- Date: 2026-11-16
- Deciders: Ziyang (lead maintainer)

## Context

Phase 2 of decision 0027: drawing that doesn't grow with the page. Measured before this change (on this VM, Chromium without a GPU, so compare rows, not budgets), a full repaint of the largest page of a 500,000-layer kit took most of a second, and full repaints came often: the first frame of a page, every zoom past what scaling the last frame can stand in for, the first pan frame after a zoom, and every edit (any change to the document redrew the whole canvas). Pans already redrew only the strip they uncovered, but culling walked the whole tree each time, and `Scene` dropped every matrix and bounds it had cached whenever the document changed at all.

A profile of the first frame (1.2 s at 500,000 layers) showed where the time goes: most of it rasterising (fills, strokes, transforms of tens of thousands of shapes a few pixels across), a fifth walking the tree. So an index alone can't make a full repaint fast. What can be fast is never needing one in a single frame.

## Decision

1. **The scene keeps what it derives.** `Doc` keeps its last 256 changes (`changesSince`), and `Scene` catches up from them when it's next asked something, dropping only what a change affects: a moved or resized layer and everything below it, the extents of its ancestors, a group's bounds. A change to a layer's look keeps its matrix and bounds. Scenes made for a moment (exports, tests) never subscribe, so nothing leaks.
2. **Extents, and an index of them.** A layer's extent is its bounds grown by what it paints outside them (strokes, shadows, blur, end markers; `reach.ts`) and, unless it's a frame that clips, its children's extents. A container with 48 or more children keeps a grid of its children's extents (`spatial.ts`), cells about the size of a typical child, updated in place as children change. Drawing, hit testing and the marquee ask the scene for the children near a rect (`childrenIn`) instead of trying every child.
3. **Culling by extent.** The renderer used to cull a layer by its box, so a frame that doesn't clip, just off a strip being redrawn, took its overflowing children with it: a pan could leave them cut where a whole frame shows them. Culling by extent draws in a part of the canvas exactly what a whole frame draws there. The margin culling allows for what paints past even that (type overhanging its box) is now 64 page units, never more than the 64 screen pixels it was, so zoomed out it no longer quadruples what a small region draws. Type that runs past a fixed-size text box is part of the extent: a bound on how far it can run, from its characters, sizes and spacing, without laying it out (`textOverflow` in reach.ts), held against the real layout by a property test with real fonts.
4. **Edits redraw where they were and are.** The scene notes, for every change, where the changed layers painted before (from what it had cached) and the renderer adds where they paint now; only those places are redrawn, as a pan's strips are. A layer becoming or ceasing to be a mask, a reset, or a change log the renderer has fallen behind redraw everything.
5. **Frames that cost more than a frame are drawn a tile at a time.** The canvas gives the renderer a budget (8 ms). When a whole frame or a change would take longer, by the page's measured drawing cost per pixel at that zoom, the renderer shows a stand-in and draws the exact frame in tiles, centre first, a few a frame, until none is left (`tiles.ts`). Tiles are sized from the same measure to cost about half the budget. Pans move the work with the canvas; a change marks its tiles again. The stand-in is the last frame scaled, over frames kept at other zooms of the same page (a small raster pyramid, four frames at half size at most, each cleared where the document has changed since), so zooming out shows the page at once, coarser, and sharpens.
6. **Never wrong for long, exact when idle.** The canvas reports when it's exact (`drawpaneFrames.exact`); work continues every frame until it is, without waiting for the camera to settle. A page with glass or background blur, which read the pixels around them, is drawn whole as before: in tiles they'd read tiles not drawn yet. Exports, thumbnails and previews pass no budget and draw whole, as before; parity (decision 0013) and headless parity (0023) are unchanged.

`e2e/canvas-scale.spec.ts` holds the renderer to that: a kit too large to draw at once is opened, panned while still being drawn, zoomed far out and in, and edited (a main whose copies are everywhere, and a screen dragged up close), and after each the canvas is compared with the same view drawn whole on the same canvas. With document changes ignored it fails.

## Consequences

The scale benchmark (`bench -- scale`) before and after, on this VM, run one after the other on the same build setup; "exact" is when the first frame is the whole exact picture (before, the first frame was):

| 500,000 layers | Before | After |
| --- | --- | --- |
| First frame of the largest page | 902 ms | 210 ms (exact after 2,020 ms) |
| Pan, whole page: content p95 / worst | 66.9 / 129 ms | 7.7 / 11.3 ms |
| Pan at 25%: p50 / p95 / worst | 13.9 / 20.4 / 28.3 ms | 8.4 / 25.1 / 51.7 ms |
| Pan at 100%: p95 / worst | 3.0 / 5.4 ms | 5.1 / 27.2 ms |
| Zoom, whole page: worst frame | 642 ms | 12.1 ms |
| Edit the most used main (13,174 copies) | 8,859 ms | 6,814 ms |

| 100,000 layers | Before | After |
| --- | --- | --- |
| First frame of the largest page | 865 ms | 212 ms (exact after 1,877 ms) |
| Pan, whole page: content p95 / worst | 45.6 / 71.6 ms | 5.7 / 12.6 ms |
| Pan at 25%: p95 / worst | 18.8 / 38.3 ms | 12.4 / 31.8 ms |
| Zoom, whole page: worst frame | 421 ms | 12.5 ms |
| Edit the most used main (2,607 copies) | 1,804 ms | 1,402 ms |

The canvas benchmark at 10,000 layers didn't regress: whole-page pan p95 15.8 → 2.1 ms, zoom's worst frame 179 → 25 ms, pans at 25% and 100% within noise (p95 21.2 → 12.1 and 4.6 → 3.1 ms; worst 131.7 → 44.6 and 7.1 → 10.8 ms). The VM is shared, with a load average of 3 to 8 during these runs, so single-run worst frames move by tens of milliseconds between runs.

- Every full repaint spike is gone: zooming, the first pan after a zoom, and edits now cost what the budget allows. Panning a whole page and zooming it are inside 16 ms at p95 on this VM, without a GPU.
- **Panning up close carries the rest of a pass.** After a zoom, the frames that follow draw what's left of the exact frame within the budget, so a pan's p95 at 25% and 100% includes that work (and at 25% the strips themselves, dense with layers, are what's left over 16 ms here). The median frame at 25% went down.
- **Reaching exact takes longer than a whole frame took.** A whole page at fit zoom is drawn exactly after about 2 s instead of 0.9 s, since each frame does a slice and tiles overlap a little at their margins. It shows at once, coarsely, and is usable throughout.
- **Main edits are still slow**, now nearly all of it in applying the edit and laying out its copies, not drawing: phase 4's job.
- **Tile edges and software rasterising.** A shape crossing a tile's edge is antialiased a shade differently there by Chromium's software rasteriser, as it always was along a pan's strips: after a first frame drawn in tiles, 40 of 1.3 million pixels differ from a whole redraw, by at most 6 levels of 255 (small icons on an edge by up to about 50). After 30 pans, about 2,400 pixels differ, before this change as after. A GPU-backed canvas clips to whole pixels exactly, so laptops should show none; not measured here.
- Not done: levels of detail beyond what the renderer already did (unreadable text as bars, specks skipped): the stand-ins carry zoomed-out views instead. Hit testing and the minimap read only what's near the pointer or the page's top level; the layers panel reads no bounds. Phase 4 changes how copies are stored but presents them through `Doc` with its change log, which is all the scene reads.
