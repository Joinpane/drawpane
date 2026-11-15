# 0007. Glass: a refraction effect drawn by a small WebGL shader

- Status: accepted
- Date: 2026-11-14
- Deciders: Ziyang (lead maintainer)

## Context

Figma offers a Glass effect, after Apple's "liquid glass": what's behind a layer is seen through it as through a lens with curved edges. Near the edge the backdrop bends (refraction), colours split slightly (dispersion), the glass can be frosted, and light catches the rim from a direction. Its controls are Light (an angle and an intensity), Refraction, Depth, Dispersion, Frost and Splay. The maintainer wants it in Drawpane.

Drawpane draws with the 2D canvas. Background blur already reads what's behind a layer by drawing the canvas onto itself through a blur filter, clipped to the layer's shape. Glass needs more than a filter: each pixel takes its colour from somewhere else in the backdrop, by an amount that depends on how close it is to the shape's edge and which way the edge faces. The 2D canvas has no per-pixel displacement (a `getImageData` loop is far too slow for a frame), and SVG's `feDisplacementMap` can't reach the backdrop.

## Decision

**A glass effect on any shape, drawn by a WebGL2 fragment shader**, on one small WebGL canvas the renderer keeps, used only while something has glass:

1. The **backdrop** is the canvas under the layer, as for background blur, with a margin around it for the bent rays to reach into. **Frost** blurs it first.
2. The **edge profile** comes from the layer's own shape: its mask, blurred by the **Depth** (the width of the curved rim). That blurred mask rises from 0 outside to 1 a depth inside the edge; its gradient is the rim's slope and direction. This works for every shape (rectangles, paths, text) without a distance function for each.
3. The shader moves each backdrop sample along the slope by **Refraction**: strongest on the rim, nothing in the flat middle. **Dispersion** moves red and blue by different amounts, so edges fringe like real glass. **Splay** fans the bend outward from the shape's centre as well as across its edge, so the glass magnifies more. **Light** brightens the rim where it faces the light's angle, by its intensity, and shades the side facing away a little.
4. The result is cut to the shape (antialiased by its mask) and drawn where background blur would be: under the layer's own fills, so a translucent fill tints the glass, as in Figma.

The model gains `{ type: "glass", angle, intensity, refraction, depth, dispersion, frost, splay }` in `effects`, with Figma's defaults (−45°, 80%, 80, 20, 50, 4, 0). Values are 0–100 except the angle (degrees) and frost and depth (px).

Without WebGL2 (a few old browsers, headless contexts), glass degrades to frost plus a rim highlight drawn with the 2D canvas.

## Consequences

- One more drawing path to keep in step, contained in one module (`glass.ts`) with its shader; its parameters are mapped by pure functions that are unit-tested, and its look by a browser test.
- A glass layer costs a backdrop copy, two small uploads and one draw per frame, only for layers on screen; files without glass pay nothing (the WebGL context is made on first use).
- SVG and PDF can't read what's behind a layer either, so they get an approximation: the layer's fills with a soft rim highlight. PNG export, drawn by the canvas renderer, has the real effect.

## Revision: a smooth rim (2026-11-14)

The first version took the rim's slope from the shape's mask blurred by the 2D canvas: 8 bits of height, differenced across single pixels. Quantised height made visible terraces and moiré in the bend, and noisy colour fringes, most of all at rounded corners. It now:

- **Finds the edge exactly.** It takes every pixel's distance and direction to the shape's edge from a jump-flooded distance field on the GPU (half floats, seeded at sub-pixel edge points from the anti-aliased mask, and only as far as the rim is deep). Right at the edge, the direction blends into the mask's own slope.
- **Bends without folding.** The rim is an analytic profile. A pixel a fraction *t* of the depth in sees the backdrop `refraction × (1 − t)³` further in. That eases into the flat middle without a crease, and at most about a third of the depth, so content folds back on itself only in a sliver at the very edge, as thick glass does.
- **Fringes subtly.** Dispersion parts the colours by up to a quarter of the bend.
- **Lights the rim.** A fine specular line runs along the edge facing the light, with a softer line opposite (light inside the glass) and a gentle sheen across the lit side of the rim. The flat middle shows the backdrop as it is, frosted.


## Revision: calibrated to Figma (2026-11-14)

The shader's constants (`GlassTuning`) are now fitted to Figma's own glass, not set by eye. `tools/glass-calibration` draws the same 22 cells in both (one backdrop, one glass shape, one setting varied at a time), fetches Figma's renders through its REST API, and searches the constants by coordinate descent until Drawpane's renders match (see its README). The fit took the mean difference over the glass and its rim from 10.3 to 2.7 (of 255). What changed:

- **The rim stays inside the shape.** A rim deeper than the shape's inner radius (half its smaller side) now stops there, so the bend fades to nothing where rims from opposite sides meet instead of flipping direction, which drew streaks along the corners' diagonals. Thicker glass still bends more.
- **Figma's look, in numbers.** The bend is stronger (0.88 of the depth at full refraction), frost is about half as strong per pixel, dispersion subtler (0.11), and the light is a fine line right at the edge, with a softer line opposite and no broad glow, sheen or shade.
- **What's left.** A rim far deeper than the shape (depth 80 on a 140-tall shape) still folds a little at rounded corners, where Figma bends smoothly.

## Revision: a smooth height field (2026-11-15)

The calibrated version still had defects Figma's glass doesn't: hairline fans at rounded corners, creases along the corners' diagonals once the rim was deep, and shimmer where the lens compressed the backdrop. Their causes were the rim's direction, taken from the nearest edge pixel the jump flooding found (quantised: a degree off becomes pixels off at a large bend), inner contours that sharpen at corners, and one texel read per pixel. It now:

- **Takes the rim from a smooth height field.** The shape is blurred by a Gaussian a share of the depth wide (on the GPU, in half floats, at a resolution the blur can spare), and its slope comes from derivative-of-Gaussian kernels in the same two passes. The bend follows that slope: smooth everywhere and for any shape, rounding inner contours, and fading where rims from opposite sides meet.
- **Reads the backdrop through mipmaps,** filtered over each bent ray's footprint, so compressed content averages instead of shimmering.
- **Places the specular line by the height itself.** Near a straight edge a blurred shape's height is a Gaussian's cumulative distribution of the distance in, so its inverse gives the distance back. The jump flooding is gone.
- **Costs less:** six glass layers redraw in about two thirds of the time they did (a software renderer without a GPU, so relative numbers only), from dropping the flooding passes and reading the downsampled mask four pixels at a time.

Calibrated again (mean 3.0 of 255), every cell but the deepest rim is within 4.5 of Figma's (most about 2), and the deepest is smooth where it creased. Figma's deep rims bend the surroundings into the glass in closed loops; matching that profile exactly is the gap left.

## Revision: glass where people use it (2026-11-15)

The calibration cells are rounded rectangles held still in the middle of the view. Glass in a real file sits on text, stars and paths, is cut off by the screen's edge, and is panned past. A stress sheet of those situations, and a parity suite of ten cells built in Figma (`tools/figma-parity/scenes/glass.json`: text, a star, an ellipse, a rotated card, a polygon, a thin bar, a small chip, square corners, overlapping lenses), found five defects, all fixed:

- **Seams after a pan.** A pan moves the last frame and draws only the uncovered strips, but glass and background blur cut by a strip read the moved frame's finished pixels (their own glass included) past its edge, and left a step there. Now a layer that reads the backdrop and paints in a strip is redrawn whole with everything it reads, in one clipped pass, grown until nothing else it touches is cut (`CanvasRenderer.#withReaders`). A layer blurred or textured is always drawn whole into its own canvas, so its blur doesn't see a strip's edge either.
- **A rim along the screen's edge.** A layer the screen cut had its mask cut there too, so it grew a lit rim along the cut, and its frosted backdrop faded to nothing at the edge. Both now reach past the canvas as far as they count for what's on it, the backdrop's edge pixels repeated there (`copyExtended`), as a GPU clamps a texture to its edge. Background blur reads the same way, and only its layer's area rather than the whole canvas each time.
- **Text was a box.** Glass on text frosted its whole box. As in Figma, each glyph is now a lens of its own: the mask is the glyphs.
- **Rims deeper than the shape.** Figma's rim is no deeper than the shape is thick: a 24 px bar with a 20 px depth matches a 12 px one, and a glyph's rim is as deep as its strokes are wide. The depth is now clamped to the shape's largest inscribed radius (half the smaller side of a box or ellipse; for anything else measured once per version with an exact Euclidean distance transform, `inradius.ts`). The thin bar went from 2.06 to 0.71, small text from 2.47 to 1.36, and the calibration's deepest rim from 20.2 to 16.9 (mean 2.99 to 2.84, nothing else changed).
- **Panning cost.** Redrawing glass whole on every pan step would cost a full lens per step. So each layer's glass, drawn whole on screen, is kept with what it depended on (the renderer's content generation, the transform up to a whole-pixel shift, the settings) and copied while those hold. A pan over glass costs about what it did before (p50 63 ms a step against 55 ms on this GPU-less VM), now without the seams.

The glass suite's mean is 1.52. What's left is the deep-rim profile (Figma's loops, and much subtler colour fringes there than a share of the bend gives), and ellipses that bend the backdrop a little less near the rim than Figma's.

## Measured: where Figma bends each ray (2026-11-15)

To stop guessing at Figma's rim from pictures, the `glass-probe` parity suite draws glass with its light, frost and dispersion off over ramps that encode position (black to white across the glass's box, along x in one cell and y in the other), so each pixel's grey says where its ray landed. `tools/glass-calibration/displacement.mjs` turns a report of it into both bend fields. What it found, for whoever takes the deep rim on:

- **The bend follows the distance in from the edge,** about `1.04 × refraction × depth × (1 − distance / depth)^n` with n between 2.7 and 3.5 (the deeper the rim, the higher), reaching nothing at the rim's depth: a band of even width all round, corners included. Ours follows the rim's slope, which peaks about a fifth lower at the edge and dies off sooner.
- **The depth is clamped to the shape's inscribed radius:** `depth-80` on the 140-tall card fits only with a depth of 70, as the revision above found from pictures.
- **Ellipses bend about half as much** as boxes at the same depth (a circle's peak is 0.56 of a card's), though a pill's round ends bend fully.
- **Following the distance alone isn't enough.** Taking it from the blurred height overstates the bend at convex corners (deep-rim corner error 9 px to 14); an exact rounded-rectangle distance field fixes that and beats today's shader at depth 40 (field error 1.3 px against 1.6), but only ties it at 80 (4.8 px), where the difference is the bend's direction near corners, not its size.

At Figma's default depth (20), the two fields already agree to the measurement's floor (about a pixel), so the shader is unchanged; the probe holds it there.

## Revision: square corners (2026-11-15)

A rectangle with square or slightly rounded corners showed glass as if it had a large radius: a lit, rounded wedge in each corner, and the backdrop bent round a curve that wasn't there. The rim's distance in from the edge came from the blurred height (its inverse Gaussian), which reads short at a convex corner, so a corner pixel took itself for an edge pixel. Rectangles and frames now measure it exactly: the shader computes the rounded box's signed distance (square, rounded or per-corner, any rotation), and the bend's size and the light follow that distance, with the same Gaussian falloff a straight edge had (so sides look as calibrated). The direction still comes from the height's slope, smooth everywhere, so nothing creases along a corner's diagonal. Other shapes (paths, stars, text) keep the height's distance.

The calibration's mean went from 2.84 to 2.70 (`depth-40` 4.32 to 3.74, `depth-80` 16.9 to 15.2, square corners 1.84 to 1.74, nothing worse), and the probe's bend field from 1.78 to 1.72 px off Figma's (the deepest rim's corners 9.2 to 6.5).

## Revision: Figma's glass, measured setting by setting (2026-11-15)

Side by side with Figma at the top of its ranges, our glass still looked different: a fainter, lopsided light on the bevel, a bend that died off too soon at depth 100, and frost that dragged while moving the layer. Instead of fitting constants to pictures, a second probe suite (`glass-probe-2`, built in Figma) takes Figma's glass apart one setting at a time: the light alone over flat grey at several angles and strengths (refraction and frost change nothing about it), the bend at refraction and depth 100 and 50 over position-encoding ramps, each colour's bend at full dispersion, splay against the same cell without it, and frost across a sharp edge. What it showed, now what we draw (`DEFAULT_GLASS_TUNING`):

- **The light is a hairline and a faint shade.** A hairline along each edge, about a third of a unit wide, mixes toward white by the light's strength × 3.7 × (facing − 0.45) on edges facing the light, and × 2.4 × (−facing − 0.42) on edges facing away: square-on edges go white, edges at 45° get 80% of the strength, side-on edges nothing. Across the rim, a shade of 0.09 × strength × facing darkens the side facing the light and lightens the other, gone at 0.55 of the depth. It's linear in the strength, symmetric (−45° lights top and left alike: our fitted 5° offset is gone), and the same whatever the refraction, depth or frost.
- **A box's bend is the depth times the refraction at its edge,** falling off as (1 − distance in / depth)^n, n growing from about 2.7 at depth 20 to 3.3 at 100. Boxes measure their distance exactly (the square-corners revision), so they take this profile; other shapes keep the slope's.
- **Dispersion** parts red (further in) and blue (less) by a tenth of the bend at 100, around an unmoved green: half what we did.
- **Splay** pulls a ray along its edge toward the edge's middle (about 0.58 of the bend at the edge's ends), not outward from the centre, which had cancelled the bend at each side's middle.
- **Frost** is a Gaussian of 0.44 units per unit of frost, as we had; but **what it sees** stops at the frames that clip the layer, and past them is the nearest one's own fill, not whatever the canvas has beyond. (A layer's colour does bleed in from what's beside it, not under it, within its frame: the frost's reach.)
- **Ranges** are Figma's: depth and frost at most 100 (deeper rims in older files draw at 100).

**Faster:** frost ran as a 2D canvas `blur()` over the backdrop's whole reach, every frame of a drag: at frost 100 a Gaussian 90 pixels wide at 2×. It's now two GPU passes read from the backdrop's mipmaps at a level where what's left of the blur is a few texels wide, so strong frost costs what weak frost does. And a glass's picture is kept for pans only once it's drawn twice against the same content: a drag, whose every frame is new, no longer copies it every frame.

The probe suite went from 1.78 to 0.63, its bend fields from 4.61 to 2.65 px off Figma's, the calibration from 2.70 to 2.32 (every cell better or equal; the deepest rim 15.2 to 11.4), with the light cells at about 0.2.
