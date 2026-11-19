# 0040. Corner smoothing: Figma's squircles, one outline for every renderer

- Status: accepted
- Date: 2026-11-19
- Deciders: Ziyang (lead maintainer)

## Context

Figma's corner smoothing makes a rounded corner ease into its edges instead of meeting them as a quarter circle: Apple's continuous corners, the "squircle". It's a number from 0 to 1 on rectangles, frames, components and instances (iOS uses 0.6), next to the corner radii. A large iOS UI kit sets it on 2,789 records, which come to 8,622 layers; Drawpane had no field for it, so every one came out as a plain rounded rectangle (kit triage in decision 0030's harness).

Each consumer of a box's outline drew its own: the canvas with `roundRect`, the SVG export with `<rect rx>` or arcs, dashes with circular arcs, per-side strokes with quarter-ellipse cubics, flatten and booleans with cubics, the glass shader with a circular distance. All clamped every radius to half the shorter side.

### What Figma draws

Read from Figma's own geometry (the plugin API's `fillGeometry`) for 448 boxes built in the parity file: eight sizes from 300 × 50 to 10 × 6, radii from 0 to 500, smoothing 0, 0.2, 0.6 and 1, and eight sets of per-corner radii. They're kept as `packages/editor/test/fixtures/figma-corners.json`.

- **A corner** of radius `R` and smoothing `s` reaches `p = (1 + s) R` along both of its edges. It's Figma's published construction ("Desperately seeking squircles"): a cubic eases off the edge, a circular arc of `90 (1 − s)` degrees on the circle of radius `R` tangent to both edges, and a cubic eases onto the other edge. With `θ = 90 (1 − s)`, `c = R tan((90 − θ) / 4) cos(45 s)`, `d = c tan(45 s)`, `b = (p − √2 R sin(θ / 2) − c − d) / 3` and `a = 2b`, the first cubic runs from the edge at `p` through controls at `p − a` and `p − a − b` on the edge to the point `(p − a − b − c, d)` off it, and the second mirrors it. Figma's own geometry draws the arc as one cubic (handles `4/3 tan(θ/4) R`), and a quarter circle the same way. At `s = 0` the easing curves vanish; at `s = 1` the arc does.
- **Space is shared per corner.** Along each edge, a corner may use the edge's length in proportion to its radius against the radius at the edge's other end (`edge × r / (r + r_other)`), and its budget is the smaller of its two edges' shares. The radius is cut to the budget first; then the smoothing to what's left (`s ≤ budget / R − 1`), so the corner never reaches past its budget and its curve isn't distorted. A uniform radius gets half the shorter side, as before. A large corner beside square ones gets more: a 200 × 120 box with radii 200, 0, 200, 0 has two corners of radius 120, a leaf. Drawpane cut them to 60.

Every one of the 448 outlines matches the construction to within 0.02 px. Strokes in Figma's `strokeGeometry` are the outline's own offsets, so stroking the outline (as every renderer already did) is exact. A shadow's spread, read from Figma's renders at 4× with no blur, is the box grown by the spread with each rounded corner's radius as drawn plus the spread and the same smoothing (within a quarter pixel, as for plain corners); an exact offset of the outline is further off. Dashes are fitted to each segment of the outline: a smoothed corner's two easing curves and its arc each get a whole number of the pattern.

## Decision

1. **The model** has `cornerSmoothing` on frames and rectangles (`CORNERS`), a number from 0 to 1. A missing value is 0, a plain circle, so every stored file keeps meaning what it meant: no migration and no protocol change. Setting it to 0 in the inspector removes the property. It's kept on square corners too, as Figma keeps it: a radius set later (an instance's override, an edit) is smoothed as the designer chose. It's a style property for history, copy and paste properties, compact copies and branch reviews.
2. **One geometry** (`packages/editor/src/corners.ts`): `fitCorners` (each corner's radius, smoothing and reach as drawn) and `boxPath` (the outline as move, line and cubic commands, Figma's own, starting where Figma's does). Every consumer goes through it:
   - the canvas: fills, strokes (stroked and clipped as before), frames' clips, outline masks, background blur, the glass mask and the shadows' cut-outs (`boxPath2D`), shadows' spread shapes, dashes (`boxPieces`, through `boxOutline`) and per-side strokes (`stroke-sides.ts`, whose smoothed corners are the layer's curve stretched to each corner's two radii);
   - the SVG export, so the PDF export (svg2pdf) and the headless renderer (resvg, agents' and the Worker's renders) too: a `<path>` of the same commands, except a box whose corners are alike and unsmoothed, which stays a `<rect rx>` as Figma exports it;
   - flatten, booleans and outline to path (`rectPath`), hit testing (a click in a corner's cut misses a rectangle or a frame, within the click's tolerance), and the hover outline, which follows a rounded box's corners;
   - the glass shader's distance from the edge (`cornerDistance`: the circle where the arc is, the easing curve's height above the edge, measured square to it, elsewhere), given each corner's radius and smoothing as drawn.
   The paths are cached by size, radii and smoothing (4,096 outlines and as many `Path2D`s, least recently used first out): a screen of one button shares one.
3. **Importers.** The REST importer reads `cornerSmoothing` beside the radii, the `.fig` reader passes Open Pencil's, and a swapped nested instance takes its new component's smoothing (and whether its corners are independent) with the rest of its look. Penpot and SVG have no smoothing.
4. **The inspector** has a Corner smoothing slider under the corner radius, 0 to 100%, with iOS's 60% as a named stop under the track (`SliderField` gained marks and a mixed value). One drag is one undo step; a selection that differs shows Mixed. The command bar takes `smoothing 60%`; agents' JSX takes `smoothing={0.6}` (or `"60%"`), and `get_jsx` writes it. Dev mode's inspect panel shows it; CSS has no equivalent in every browser, so code export leaves `border-radius` as it was.

## Consequences

- Smoothed corners draw as Figma draws them in every renderer, and the renderers agree with each other and with hit testing (`test/corners.test.ts`, `test/corners-drawn.test.ts`, the parity suites `corners` and `corners-glass` against Figma, and the headless parity suite against the canvas).
- Files without smoothing draw as before except for two corrections: per-corner radii larger than half the shorter side now get Figma's budget instead of being cut to half the shorter side, and a plain corner is Figma's cubic rather than a true arc (at most 0.03% of the radius apart).
- An old tab (from before this change) keeps the property through loading, edits and undoing them, but can't duplicate, paste or undo the delete of a layer that has it ("Unknown property"), and reloads its file when another tab changes it. Tabs offer a reload once a newer Drawpane is deployed (#167).
- On the iOS kit and the shadcn kit, numbers in the pull request.
