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

## Revision: ellipses, and a rim that remembered the last glass (2026-11-15)

- **Ellipses bend as Figma's do.** A probe suite (`glass-ellipses`: circles 80, 160 and 240 units across and a 300 × 140 ellipse, at depths 10 to 70, over position-encoding ramps) found Figma bends an ellipse less than a box at the same depth, by a share that grows with the depth and not with the size: 0.38 of depth × refraction at 10, 0.59 at 20, 0.78 at 40, 0.87 at 70, fitting 1 − 12.1 / (depth + 9.5). Ellipses keep the slope's profile, which already followed Figma's shape, at that strength. The suite went from 0.42 to 0.35 (its bend field from 1.90 to 1.59 px), the glass suite's ellipse cell from 1.28 to 0.83 and its overlapping lenses from 2.05 to 1.38.
- **The rim's height no longer reads what an earlier glass left.** Its textures only grow, and each glass writes only its own corner of them; the blur read past that corner, into what a larger glass drawn before had left there. So a glass's rim depended on what had been drawn before it (found when one suite run before another moved a text cell from 4.25 to 5.18). Past what's been written is now outside the shape.

## Revision: what's behind it, as Figma exports it (2026-11-18)

Glass keeps its backdrop's alpha (over nothing it shows nothing, light included) and, in an export, sees what's under the exported layers on the page. Measured and decided in decision 0039.

## Measured: stacked and overlapping glass (2026-11-20)

When two glass layers overlap, Figma does not render nested glass. To pin down the exact rule rather than guess, a 15-cell parity suite (`tools/figma-parity/scenes/glass-stack.json`) places stacked, nested, adjacent, faded, blended, and blur-paired glass layers over a high-contrast striped gradient with bold text (`AaBb01`). Every cell was built and measured in Figma in a single session, capturing both Figma's 2x `exportAsync` PNGs (`tools/figma-parity/goldens/glass-stack/`) and 100%-zoom live canvas screenshots.

### Live canvas vs `exportAsync`

Downsampling Figma's 2x `exportAsync` renders to 1x and aligning them against Figma's 100%-zoom canvas screenshots gives a mean RGB channel difference of **0.53** across all 15 cells (range 0.37 to 0.68, p99 2 to 6). Both paths obey the same stacked-glass rule.

The committed [100% live canvas recaptures](../../tools/figma-parity/live/glass-stack) cover the same 15 scenes. Comparing these new captures with the original 2× goldens downsampled by a 2 × 2 box filter gives a mean RGB difference of 0.79 (range 0.45 to 1.41, p99 3 to 22). The live images were cropped to the exact 240 × 160 frame bounds.

### Best-supported tested rule (`b*`)

Among the seven candidate stacking models tested below, the best-supported model (`b*`) is:

**A glass effect writes only to the visible output, never to the backdrop that later backdrop readers (`glass` or `background-blur`) sample.** Every other part of the layer tree writes to both the visible output and the backdrop in normal paint order.

This cuts the 15-cell mean RGB error from **6.84** (raw Canvas baseline **6.89** over 15 cells, **6.92** over the 14 non-blend cells) to **2.87**, and the average of per-cell `p99`s from **74** to **57**. Notice that substantial local rim and text residuals remain across both single-reader and overlap regions (see "Residual attribution" below), so this records the best-supported model among the tested candidates rather than claiming closed-form exactness across every Figma edge case.

Specifically, under `b*`:

1. **What a reader's backdrop contains.** When a `glass` or `background-blur` layer samples the prefix beneath it in paint order, every earlier layer is present *except* earlier `glass` effects. Earlier `glass` layers keep their own fills, strokes, and children in the backdrop, any non-glass layers drawn between them are kept, ancestor opacity groups apply their opacity to the non-glass backdrop as well, and earlier `background-blur` effects are kept.
2. **Per-layer (backdrop-level), not per-region.** Suppressing earlier glass happens in the backdrop read by the upper layer, not by erasing or turning off the lower glass in the overlapping pixels of the output. When the upper glass has `opacity < 1` (`opacity-half`) or a non-normal blend mode (`blend-multiply`), it computes its lens over the glass-free backdrop and composites normally onto the visible canvas where the lower glass remains visible underneath. Even when two glass layers touch without overlapping (`adjacent-frost`), the second layer's frost does not pull in the first layer's glass highlight or blur across the seam.
3. **Children, fills, strokes, and layers between.** Removing the lower glass's fills or strokes (`lower-fill-stroke`, `full-containment`, `nested-glass`), hiding its children (`nested-with-child`), or capturing one shared backdrop before the first glass layer (`between-sibling`) all fail badly. Only the earlier `glass` effect pass itself is absent from the backdrop.
4. **Interaction with `background-blur`.** The tested asymmetry is consistent:
   - `glass` over `background-blur` (`over-bg-blur`): the upper glass **does** read the lower layer's background blur (mean **3.45 (p99 42)** keeping it vs **8.99 (p99 99)** stripping it from the upper glass's backdrop).
   - `background-blur` over `glass` (`bg-blur-over-glass`): the upper background blur does **not** read the lower layer's glass effect, while keeping the lower layer's fill (overlap ROI `x = 90..150, y = 20..140` RGB mean **3.57 (p99 30)** without lower glass vs **8.33 (p99 36)** with lower glass vs **13.59 (p99 32)** omitting the lower layer).
5. **Faded groups (`lower-faded-group`).** A glass layer inside a frame with `opacity < 1` still samples the backdrop behind that frame, composites its glass and fills inside the group, and the group fades onto the output; a later glass sibling sees the lower layer's fills faded by the group's opacity, without the lower glass effect.

### Candidate model fit

All seven candidate models and targeted controls are reproduced by `apps/web/e2e/calibration/glass-stack-models.spec.ts`, using Drawpane's exact `CanvasRenderer`, glass shader, fills, strokes, and shaped Inter fonts so only the stacking rule varies:

```bash
PARITY_PORT=9246 pnpm --filter @drawpane/web exec playwright test \
  e2e/calibration/glass-stack-models.spec.ts --project=calibration
```

Values below are **mean RGB channel error (per-cell p99 of max RGB channel diff)** on a 0 to 255 scale against Figma's 2x `exportAsync` goldens. The bottom **Average** row reports the arithmetic mean of the 15 cell means and the **average of the 15 per-cell p99 values** (not a single pooled p99 across all pixels):

- **(a) Faithful nested glass:** every reader samples the full visible output so far (what Drawpane's 2D canvas renderer does today).
- **(b) Glass skips earlier glass:** `glass` reads a backdrop with earlier `glass` effects removed (fills, strokes, children, intermediate layers, and earlier `background-blur` kept); `background-blur` reads the full output.
- **(b*) Unified no-glass backdrop (chosen rule):** every backdrop reader (`glass` and `background-blur`) reads a backdrop with earlier `glass` effects removed, while earlier `background-blur`, fills, strokes, children, and intermediate layers are kept; glass writes only to the visible output.
- **(b2) Per-region suppression:** like (b), except pixels covered by an overlapping upper glass also suppress the lower glass effect underneath it (tested on `opacity-half`, `blend-multiply`, and non-overlapping `adjacent-frost`).
- **(c1) Lower glass layers omitted:** earlier glass layers (including their fills, strokes, and non-ancestor children) are omitted from upper glass's backdrop.
- **(c2) Lower glass own paint omitted, children kept:** earlier glass layers' glass, fills, and strokes are omitted, while their children remain.
- **(d) Shared pre-glass backdrop:** every glass layer samples a single snapshot captured before the first glass layer in the frame.

| Cell | (a) Nested | (b) Glass-only | (b*) Unified | (b2) Per-region | (c1) Omit layer | (c2) Omit own | (d) Pre-glass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `partial-overlap` | 8.40 (90) | 2.98 (65) | **2.98 (65)** | 2.98 (65) | 4.85 (69) | 4.85 (69) | 4.85 (69) |
| `partial-clear` | 11.33 (123) | 3.45 (59) | **3.45 (59)** | 3.45 (59) | 3.44 (59) | 3.45 (59) | 3.44 (59) |
| `full-containment` | 11.11 (91) | 2.83 (51) | **2.83 (51)** | 2.82 (51) | 6.45 (62) | 6.46 (62) | 6.45 (62) |
| `nested-glass` | 11.07 (91) | 2.80 (51) | **2.80 (51)** | 2.80 (50) | 6.42 (62) | 6.42 (62) | 6.42 (62) |
| `nested-with-child` | 6.20 (68) | 2.72 (50) | **2.72 (50)** | 2.72 (50) | 14.29 (196) | 4.51 (58) | 14.29 (196) |
| `between-sibling` | 7.17 (96) | 3.51 (81) | **3.51 (81)** | 3.51 (81) | 5.03 (94) | 4.74 (82) | 12.79 (182) |
| `lower-fill-stroke` | 6.27 (70) | 2.74 (60) | **2.74 (60)** | 2.74 (60) | 9.88 (213) | 9.88 (213) | 9.88 (213) |
| `diff-params` | 6.09 (121) | 3.69 (121) | **3.69 (121)** | 3.69 (121) | 3.69 (121) | 3.69 (121) | 3.69 (121) |
| `three-stacked` | 7.12 (62) | 2.52 (43) | **2.52 (43)** | 2.52 (43) | 6.43 (65) | 6.43 (65) | 6.43 (65) |
| `over-bg-blur` | 3.45 (42) | 3.45 (42) | **3.45 (42)** | 3.45 (42) | 3.45 (42) | 3.45 (42) | 3.45 (42) |
| `opacity-half` | 3.95 (34) | 2.23 (35) | **2.23 (35)** | 3.52 (36) | 3.52 (44) | 3.52 (44) | 3.52 (44) |
| `blend-multiply` | 6.53 (39) | 1.71 (32) | **1.71 (32)** | 6.73 (56) | 2.94 (47) | 2.94 (47) | 2.94 (47) |
| `adjacent-frost` | 2.02 (24) | 1.85 (24) | **1.85 (24)** | 2.02 (24) | 1.85 (24) | 1.85 (24) | 1.85 (24) |
| `bg-blur-over-glass` | 4.20 (88) | 4.20 (88) | **3.26 (88)** | 4.20 (88) | 4.20 (88) | 4.20 (88) | 4.20 (88) |
| `lower-faded-group` (*) | 7.72 (77) | 3.25 (58) | **3.25 (58)** | 3.25 (58) | 6.17 (74) | 6.17 (74) | 6.17 (74) |
| **Average (mean / avg cell p99)** | **6.84 (74)** | **2.93 (57)** | **2.87 (57)** | **3.29 (60)** | **5.51 (84)** | **4.84 (74)** | **6.03 (90)** |

(*) On `lower-faded-group`, Drawpane's unmodified 2D canvas renderer drops the lower glass because isolating the `opacity: 0.8` parent clears its offscreen canvas before the child reads it, scoring **8.45 (p99 78, worst 32x32 tile 43.92)** raw (15-cell raw Canvas mean **6.89**; 14-cell common non-blend Canvas mean **6.92**). The table row above applies the parent's `opacity: 0.8` directly to its single glass child so the backdrop reaches the lower glass as in Figma, isolating the stacking rule cleanly.

Additional targeted controls (all reported as RGB channel mean and p99 of max RGB channel diff):

- Stripping earlier `background-blur` from upper glass's backdrop raises `over-bg-blur` from **3.45 (p99 42)** to **8.99 (p99 99)**.
- In the overlap ROI (`x = 90..150, y = 20..140`) of `bg-blur-over-glass`, reading the glass-free backdrop (`b*`) scores **3.57 (p99 30)** vs **8.33 (p99 36)** when reading the lower glass and **13.59 (p99 32)** when omitting the lower layer.
- In the seam ROI (`x = 120..160, y = 20..140`) of `adjacent-frost`, `b*` scores **2.48 (p99 27)** vs **3.79 (p99 27)** when the right card's frost reads the left card's glass.
- In the overlap ROI of `lower-faded-group`, `b*` scores **5.69 (p99 110)** vs **29.51 (p99 82)** for nested glass `(a)` and **21.24 (p99 118)** for omitting the lower card `(c1)`.

### Residual attribution (`diff-params` p99 = 121 and per-ROI tails)

Under `b*`, every non-reader background pixel across all 15 cells scores RGB mean **0.32 to 0.33 (p99 1, 0 pixels >= 40)**, confirming layout, stripes, and text placement align cleanly. The remaining error concentrates on sharp rim refraction and text edges inside reader footprints (worst 32x32 tile across `b*` ranges from **6.27** on `adjacent-frost` to **37.91** on `diff-params`).

In particular, `diff-params` keeps **p99 = 121** under every candidate model (`a` through `d`). Single-reader controls in `glass-stack-models.spec.ts` show this tail comes from single-lens rim refraction and dispersion at extreme settings (`depth=40, refraction=100, dispersion=100, frost=0` over sharp diagonal stripes and bold `AaBb01` text), not from stacking:

- `diff-params` **lower card alone** (`x = 20..90`, lower-only ROI): RGB mean **11.45, p99 153**.
- `diff-params` **upper card alone** (`x = 150..220`, upper-only ROI, `frost=24, dispersion=0`): RGB mean **2.19, p99 21**.
- `diff-params` **b* per-ROI split**: single-reader (`one`) pixels score mean **6.61, p99 144** (`6,129` pixels >= 40), whereas the `overlap` region scores mean **3.18, p99 53** (`562` pixels >= 40).

More broadly, single-lens rim and text-edge residuals (such as `partial-overlap` single upper card alone in the upper-only ROI: mean **5.57, p99 96**) account for the high per-cell `p99` tails even after `b*` removes nested-glass artifacts; closing those single-lens refraction/dispersion rim residuals at high depth/refraction over sharp text remains open follow-up work.

### Consequences for the render engine

Because a glass effect never writes to the backdrop read by subsequent readers under `b*`, there is no glass-to-glass backdrop dependency. Editing a glass layer's glass parameters (or a glass layer without fills, strokes, or children) never invalidates a later reader's backdrop, and consecutive glass layers without intervening non-glass writes share one backdrop snapshot and mipmap chain.
