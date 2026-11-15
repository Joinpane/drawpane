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
   - **Gradients are laid out in the layer's unit square.** A linear gradient's bands run across its handles there, so on a wide layer they slant; a radial or angular one is a circle there, so an ellipse on screen. Fills are drawn exactly (in the gradient's own space, through a transform); strokes and text get exact linear gradients and circular approximations of the others. SVG export uses the same layout.
   - **A see-through layer fades as one picture** when its parts overlap: shadows under its fill, a stroke over it, a frame's or group's children. Fading each part let shadows show through the card above them.
   - **Background blur shows where the layer paints.** A layer with no visible fill or stroke blurs nothing.
   - **Dashes fit each side and corner.** A box's or ellipse's outline is split into its sides, corners and quarters; each gets a whole number of the dash pattern, stretched or squeezed to fit, with a dash centred on each end. Paths still dash continuously.
3. **Starting scores**, mean difference over each suite: strokes 1.11 → 0.03, fills 1.26 → 0.18, shadows 1.02 → 0.27, blurs 6.0 → 0.86.

## Revision: text (2026-11-15)

A text suite (20 cells in Inter: sizes and weights, italic, wrapping, line height, letter spacing, alignment, case, decoration, runs, paragraph spacing) found three ways Drawpane set type apart from Figma, all fixed:

- **Auto line height is the font's own height,** ascent plus descent, rounded to whole pixels, and the baseline sits half the extra leading plus the ascent from the line's top. Drawpane had used 1.25 em and a 0.8 em ascent for every font, so Inter's text sat 0.044 em high and wrapped lines drifted apart. The measurer reads the font's metrics from the browser (`TextMeasurer.metrics`); CSS export says `line-height: normal` for auto.
- **Metrics and widths are measured at 1000 px and scaled.** Browsers round a font's ascent and descent, and on Linux each glyph's advance, to whole pixels at the size measured; measured large, they're the font's own, as Figma uses them. Centred and right-aligned lines now land where Figma's do.
- **Text is always kerned** where it's measured and drawn.

The suite's mean went from 5.33 to 4.07; what's left is mostly the difference between two rasterisers drawing small glyphs (and, on Linux, Chromium snapping drawn glyphs to whole pixels).

## Consequences

- Documents that relied on the old drawing (circular radial gradients on wide layers, blurs half as strong) look different after this change. There are no published files yet; matching Figma now is cheaper than a migration later.
- More suites follow the same pattern: text (needing the same fonts on both sides), noise and texture (compared after a blur, since their grain is random), images, and import fidelity (whole Figma files imported, rendered and compared frame by frame).
- Refreshing goldens needs an editable Figma file, a Figma login for the browser automation, and a token to fetch renders (see the README).
