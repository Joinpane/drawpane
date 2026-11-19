# 0042. Glass and background blur drawn coarse while moving, never left out

- Status: accepted
- Date: 2026-11-19
- Deciders: Ziyang (lead maintainer)

## Context

Decision 0028's revision drew a page's glass and background blur ("readers": they read what's drawn around them) in tiles: a tile, a pan's strip or a change that readers paint in is drawn with them and all they read in one pass when that fits what's left of the frame's budget; otherwise it's drawn without them, and they're drawn again, exactly, once the tiles are done and there's time.

While a layer is dragged, every frame is a change, so on a board of glass that doesn't fit the budget the readers' second pass never comes until the drag stops. A designer dragging a glass rectangle over a photo, with other glass nearby, saw the dragged layer and its neighbours lose their glass and draw as plain translucent fills, with a hard rectangular seam where the redrawn part met glass still showing from before. Pans did the same at a strip's edge.

The new engine's freshness rule (decision 0040) holds here too: glass and blur may show a cheaper version for up to about 250 ms after movement stops, then must be exact, and never vanish.

## Decision

1. **Where something moved or changed (a pan's strips, what a change touched, and the tiles of a change too large for a frame), a pass too costly to draw its readers exactly draws them coarse instead of leaving them out.** The tiles of a whole frame (a page shown, a zoom settling, under a stand-in) still leave readers to their exact pass, as before: redrawing each reader whole for every tile it touches made showing a page several times slower. The part being redrawn is grown by where every reader painting in it paints (`#withReaders(…, paintsOnly)`), and so on, so each such reader is redrawn whole: none is left half redrawn, and there's no seam. What a reader reads past that is the canvas as it was, close enough for a coarse picture and far less to draw than all it reads. Its effect is cheaper:
   - **glass and background blur** show what's under the layer on the canvas, blurred (glass by its frost, at least 3 device pixels at 100%; background blur by its own radius), cut to the layer's shape: one copy of the canvas into itself through a blur (`#coarseFrost`). Glass loses its rim's bend and light until it's drawn exactly. Text glass and background blur behind text, whose shapes aren't a path, are drawn exactly.
   - **shadows that blend their own way** (linear burn and dodge, which a glass control usually has three of) are left out: drawn apart, each costs a canvas of its own.
2. **Each reader drawn coarse is drawn exactly once there's time**, as a reader left out was before (`#pendingReaders`, `#drawReaders`): when the frame's budget allows, and every frame once nothing moves. The canvas says it's exact only when none is left.
3. Only on screen. Exports, thumbnails and previews draw everything exactly, as before.

Tried first and dropped, on a T4 with the large iOS UI kit: the same glass shaders at a quarter of the resolution, over all a reader reads (each reader's backdrop still goes to the GPU and back, so frames cost twice main's); and reading the canvas once per pass into another canvas for the coarse readers (that read stalls on the GPU: seconds a frame).

## Consequences

- No frame shows a reader without its effect, or in two states across a seam. While something moves, glass looks frosted rather than bent and lit, without its blended inner shadows; it comes back exact within a few frames of stopping.
- A costly frame draws the readers touching what changed whole, where it drew only what changed before. Numbers in the pull request.
- `e2e/glass-drag.spec.ts` drags glass among glass and background blur, and pans and zooms, with the canvas's budget made tiny (`drawpaneFrames.budget`, a test knob), and checks that every frame keeps frosted glass frosted. On main the drag check fails.
