# 0005. OpenType features: shaping text ourselves where they're used

- Status: accepted
- Date: 2026-11-14
- Deciders: Ziyang (lead maintainer)

## Context

The PRD's v0.1 text row promises "Rich text, OpenType features". Designers expect tabular figures in tables and prices, ligatures on or off, small caps, slashed zero, fractions, and a typeface's stylistic sets (`ss01`–`ss20`): Figma and Penpot both offer them.

Drawpane draws text with the 2D canvas's `fillText`, measured with `measureText`. That API can't apply OpenType features. Probed in Chromium (November 2026), `CanvasRenderingContext2D` offers `fontKerning`, `fontVariantCaps` (small caps), `fontStretch`, `letterSpacing`, `wordSpacing` and `textRendering`. It has no `fontFeatureSettings`, `fontVariantNumeric` or `fontVariantLigatures`. CSS can set features in `@font-face`, but only Firefox honours that descriptor.

So only small caps could ship with today's renderer. Everything else needs a different way to turn text into glyphs.

## Options

1. **Ship small caps only** (`fontVariantCaps`). Cheap, but it isn't what designers mean by OpenType features.
2. **Draw feature text through the DOM**: lay the run out in an HTML element with `font-feature-settings`, then rasterize it (SVG `foreignObject`, or reading glyph positions back from the DOM). Rasterizing is asynchronous and slow, positions read back from the DOM are inexact, and both break the one-frame budget the PRD sets.
3. **Shape text ourselves** with HarfBuzz compiled to WebAssembly. HarfBuzz is the shaper browsers use, a few hundred KB, loaded on first use. It turns a run, its font's bytes and the requested features into glyph ids and positions. We draw the glyph outlines from the font (cached as `Path2D`s). Export (SVG, PDF) writes the same outlines, so what's exported is what was on the canvas.

## Decision

Option 3, for the runs that need it. A text run with no features set keeps today's fast path (`fillText`). A run with features is shaped by HarfBuzz and drawn from glyph outlines. That needs the font's bytes:

- Google Fonts and team fonts already pass through the Worker and R2, so their bytes are at hand.
- Built-in fonts ship with the app.
- Fonts installed on someone's computer (system or local) have no bytes we can read without asking for the Local Font Access permission, which only Chromium offers. Features on such a font show a note in the inspector ("Features need a Google, team or built-in font"), and the text draws without them.

The model gains `fontFeatures` on text (and on rich-text ranges): a map of OpenType tags to on/off, for example `{ "tnum": true, "liga": false, "ss01": true }`. The inspector offers the common ones by name (tabular figures, ligatures, small caps, slashed zero, fractions, case-sensitive forms) and lists a font's stylistic sets by the names in its `name` table.

Text editing keeps working on characters: HarfBuzz reports which characters each glyph came from (clusters), so the caret, selection and hit-testing map back to characters.

## Consequences

- One new dependency (HarfBuzz WebAssembly), loaded only when a file uses features.
- Two text paths to keep in step: measurement, wrapping, the caret and export each need to handle shaped runs. The fast path stays the default.
- Rendering performance for feature-heavy text depends on caching shaped runs and glyph paths (by font, size, features and text), which the renderer's existing per-node caches can carry.
- Penpot's text model has no OpenType features to bring over on import (its `font-variant-id` is the weight and style).

## Implementation (November 2026)

- Model: `fontFeatures` on text, text styles and rich-text runs (a run's map replaces the layer's, like its other properties).
- `packages/editor/src/shaping.ts`: `Shaper` (HarfBuzz via `harfbuzzjs`, a separate chunk and a 444 KB `.wasm`, imported on first use) and `ShapingMeasurer`. Layout passes each span's `FeatureRun` (now `ShapingRun`, which also carries variable axes: decision 0009) to the measurer, so line breaking, auto-size, the caret and hit-testing use shaped widths; the renderer fills the shaped glyphs' outlines as one path per run (so gradient and image fills line up with the box).
- Font bytes: `apps/web/src/fonts/font-files.ts`, shared with PDF export (Google and built-in fonts as TrueType through the proxy; team fonts' TrueType and OpenType files).
- Inspector: type settings' Details tab (it was an "OpenType" row under decoration and case), showing the features the font offers; reading them loads HarfBuzz and the font only when the tab opens.
- SVG export writes `font-feature-settings`, which SVG text honours.
- PDF export draws runs with features as their shaped glyphs (`exportSvg`'s `outlineFeatures`): svg2pdf sets real text, which can't take features. Those runs aren't selectable text in the PDF; everything else still is.
