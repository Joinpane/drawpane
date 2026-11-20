# 0013. Render parity with Figma, measured

- Status: accepted
- Date: 2026-11-15
- Deciders: Ziyang (lead maintainer)

## Context

People move to Drawpane from Figma, with Figma files. A design that looks a little different here (a softer blur, a gradient at another slant, a shadow showing through a faded card) reads as a broken import or a worse tool, whichever is at fault. "Close to Figma" was judged by eye, one effect at a time; nothing kept it from drifting.

The glass calibration (decision 0007) showed the way: draw the same scene in both, fetch Figma's render through its REST API, and compare pixels.

## Decision

1. **A parity suite, in CI.** `tools/figma-parity/scenes/*.json` describe grids of small scenes in Drawpane's own properties, one thing varied per cell: shadows, blurs, fills and blend modes, strokes (63 cells to start). Figma builds the same scenes (`figma-builder.js`, run in Figma's page by `build-in-figma.mjs`); its renders at 2× are committed as goldens. The e2e suite `apps/web/e2e/parity` draws every cell and compares: mean difference over RGB (0–255), its 99th percentile, and a heat map in a report. Each cell's mean must stay within `thresholds.json`, so drifting from Figma fails CI and getting closer is locked in by recording thresholds again. CI needs no Figma account: only refreshing goldens does.
2. **Where Drawpane drew differently, it now follows Figma.** Each was found by the suite; each is how designers already expect their files to look:
   - **Blur radius is twice the Gaussian's deviation** (layer blur, background blur, and glass frost already, by calibration), as Figma's own CSS export writes it and as canvas shadows already were.
   - **Gradients are laid out in the layer's unit square.** A linear gradient's bands run across its handles there, so on a wide layer they slant; a radial or angular one is a circle there, so an ellipse on screen. Fills are drawn exactly (in the gradient's own space, through a transform); strokes and text get exact linear gradients, and radial and angular ones as a pattern of the same exact gradient, drawn once per paint at the zoom rounded up to a power of two (checked by `e2e/gradient-strokes.spec.ts`: an inside stroke covering a 2:1 layer matches its fill). SVG export uses the same layout.
   - **A see-through layer fades as one picture** when its parts overlap: shadows under its fill, a stroke over it, a frame's or group's children. Fading each part let shadows show through the card above them.
   - **Background blur shows where the layer paints.** A layer with no visible fill or stroke blurs nothing.
   - **Dashes fit each side and corner.** A box's or ellipse's outline is split into its sides, corners and quarters; each gets a whole number of the dash pattern, stretched or squeezed to fit, with a dash centred on each end. Paths still dash continuously.
3. **Starting scores**, mean difference over each suite: strokes 1.11 → 0.03, fills 1.26 → 0.18, shadows 1.02 → 0.27, blurs 6.0 → 0.86.

## Revision: text (2026-11-15)

A text suite (20 cells in Inter: sizes and weights, italic, wrapping, line height, letter spacing, alignment, case, decoration, runs, paragraph spacing) found three ways Drawpane set type apart from Figma, all fixed:

- **Auto line height is the font's own height,** ascent plus descent, rounded to whole pixels, and the baseline sits half the extra leading plus the ascent from the line's top. Drawpane had used 1.25 em and a 0.8 em ascent for every font, so Inter's text sat 0.044 em high and wrapped lines drifted apart. The measurer reads the font's metrics from the browser (`TextMeasurer.metrics`); CSS export says `line-height: normal` for auto.
- **Metrics and widths are measured at 1000 px and scaled.** Browsers round a font's ascent and descent, and on Linux each glyph's advance, to whole pixels at the size measured; measured large, they're the font's own, as Figma uses them. Centred and right-aligned lines now land where Figma's do.
- **Text is drawn at those same advances** (`textRendering: "geometricPrecision"`, where the browser has it). Drawn with the default, Linux Chromium rounded each advance at the size drawn, so a run came out wider or narrower than layout measured it, and styled runs collided ("Three thingson") or left double gaps. With it the text suite's mean went from 4.07 to 3.29 and text with styled runs from 2.55 to 1.72. Two cells read further from Figma than before (bold Inter at 32 px, and bottom-aligned lines in the vertical trim suite): the web's Inter and Figma's are slightly different versions, and the old rounding happened to hide it there.
- **Text is always kerned** where it's measured and drawn.

The suite's mean went from 5.33 to 4.07, then to 3.29 with text drawn at exact advances; what's left is mostly the difference between two rasterisers drawing small glyphs, and between Inter's versions.

## Revision: noise and texture (2026-11-15)

A grain suite (12 cells: noise of each kind at several sizes and densities, texture fine, coarse and clipped) is compared after a blur of 3, since grain is random on both sides and only its look can match, not its pixels. It found Figma's grain to be a different thing from Drawpane's, so both effects were remodelled on it (decision 0008):

- **Noise is soft blobs, not square cells.** Figma thresholds a smooth noise field. Measured on its renders, density sets the cut so that grain covers 1.3% of the layer at 20%, 8.6% at 50% and a third at 85%, far less than the density's percentage. Drawpane's field is three octaves of periodic gradient noise, standardised and cut at z = 2.82 − 2.85 × density, with an edge a tenth of a deviation soft. Duo's second colour is a set of blobs of its own rather than every cell left over. SVG export uses the same law for its threshold.
- **Texture is smooth displacement.** A fractal field of offsets, rather than one random offset per cell, so edges are ragged as Figma's are rather than stepped.

The suite's mean went from 7.36 to 1.12. Goldens now come from Figma's own exporter in the browser (`export-in-figma.mjs`), not the REST API, whose image reads a file on Figma's free plan can spend in a few runs; the two were checked to agree (shadows score 0.25 against the exporter's goldens, 0.27 against REST's).

## Revision: blur sigma calibration across effects (2026-11-20)

The initial parity pass set `sigma = radius / 2` (0.50) across effects while glass frost calibration converged on `0.45 * radius`. When implementing the phase 3 render engine, a controlled CPU A/B comparison (holding code, scenes, crops, and scoring constant while changing only the radius-to-sigma multiplier between `0.50` and `0.45`) was measured against the 2x Figma goldens:

| Suite or family | Mean at 0.50 | Mean at 0.45 | Breakdown |
| --- | --- | --- | --- |
| `shadows` | 0.270 | 0.143 | 13 better, 2 sharp controls identical |
| `blurs` (layer blur) | 0.868 | 0.666 | 5 better |
| `blurs` (uniform background blur) | 0.874 | 0.714 | 4 better, 1 identical control |
| `glass` default frost | 1.398 | 1.248 | 9 better, 1 worse (`glass/text`: 3.96 vs 3.99) |
| `glass-alpha` frost | 0.407 | 0.362 | 3 better, 1 rounded tie |
| `glass-context` frost | 1.213 | 1.107 | 3 better |
| `glass-dark` frost | 0.729 | 0.668 | 1 better, 4 rounded ties |
| `glass-stack` frost | 3.225 | 2.901 | 12 better |
| `corners-glass` frost | 1.210 | 0.900 | 1 drawable plain lens better |
| `glass-probe-2` frost edge probes (partial, 21/31) | 0.85 / 3.51 / 7.81 | 0.32 / 1.30 / 2.78 | `frost-20`, `frost-50`, `frost-100` all favor 0.45 |

Overall, 32 of 38 measured frost-sensitive cells favored `0.45`, 5 tied at suite precision, and 1 (`glass/text`) favored `0.50`; all 13 blurred shadow cells, all 5 layer-blur cells, and all 9 sensitive background-blur cells favored `0.45`.

Real-kit frame evidence is mixed or insensitive: four blur-sensitive shadcn shadow frames gave two small improvements (`Hover Card` 0.21 to 0.20, `Open=Yes` 2.89 to 2.87) and two rounded ties; five zero-radius shadow frames were identical; the shadcn `Drawer` frame (via banded PNG streaming) scored 0.4954 at 0.45 vs 0.4940 at 0.50 with identical worst tile and p99; a large iOS UI kit background frame (`10509:2668`) was bit-identical (mean ~0.004), while other sampled kit frames with readers or layer blurs waited on additional phase 3 effects. Progressive blur endpoints use the same radius conversion contract as uniform background blur, though no progressive Figma golden has calibrated them yet.

**Decision:** Standardize the render engine's Figma blur radius-to-sigma conversion on the single shared constant `FIGMA_BLUR_SIGMA = 0.45` (`sigma_from_radius(radius)` in `packages/engine/rust/src/blur.rs`), shared by shadows, layer blur, background blur, progressive blur, and glass frost so every effect shares one radius contract. This is an empirical parity calibration against Figma's exports, not a claim about Figma's internal kernel or truncation algorithm.

## Consequences

- Documents that relied on the old drawing (circular radial gradients on wide layers, blurs half as strong) look different after this change. There are no published files yet; matching Figma now is cheaper than a migration later.
- A glass suite (decision 0007's revision of 2026-11-15) covers what the calibration's rounded rectangles don't: text, stars, paths, thin bars and overlapping lenses.
- More suites follow the same pattern: images, and import fidelity (whole Figma files imported, rendered and compared frame by frame).
- Refreshing goldens needs an editable Figma file and a Figma login for the browser automation (see the README); a REST token is optional.
