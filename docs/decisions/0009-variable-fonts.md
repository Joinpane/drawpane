# 0009. Variable fonts: any point on a font's axes, shaped by HarfBuzz

- Status: accepted
- Date: 2026-11-14
- Deciders: Ziyang (lead maintainer)

## Context

A variable font carries a design space rather than a handful of styles. Its axes are registered ones (weight `wght`, width `wdth`, slant `slnt`, optical size `opsz`, italic `ital`) and the font's own (Roboto Flex has a dozen, such as `GRAD` grade and `XTRA` counter width). Figma shows a slider for each axis a font has, and the PRD lists variable fonts for Drawpane's text.

Drawpane already handles weight. Text sets `fontWeight` to any value from 1 to 1000, the browser draws variable Google fonts at that weight, and the shaper sets `wght` (decision 0005). Every other axis is out of reach of the 2D canvas, which takes a weight and a few width keywords but no `font-variation-settings`. Browsers and CSS do take them, as do SVG and HarfBuzz.

The bytes are the other problem. HarfBuzz reads TrueType and OpenType, not WOFF2. Google's stylesheet API serves a variable family to browsers only as WOFF2, split into Unicode-range subsets. Anything else gets static TrueType at the default instance. Google's download manifest (`fonts.google.com/download/list`, which its own download button uses) does list each family's full variable TrueType files on `fonts.gstatic.com`, the host the font proxy already caches from.

## Decision

1. **Model.**
   - Text layers, runs and text styles gain `fontVariations: { [tag]: number }`, at most 32 axes, each a four-character tag.
   - Weight stays `fontWeight` and italic stays `fontStyle`, so `wght` and `ital` aren't allowed in the map. One value lives in one place, and text without variations doesn't change.
   - An axis left out is at the font's default. Optical size left out follows the font size, as CSS's `font-optical-sizing: auto` does.
2. **Drawing.**
   - A run that sets variations is shaped and drawn from glyph outlines, like a run with OpenType features. Runs, measuring and the outline cache are the same; the run now carries its variations too (`ShapingRun`, formerly `FeatureRun`).
   - The shaper opens the family's *variable* file for such runs. It keeps one HarfBuzz font per set of variations, sharing the face, and clamps each value to its axis.
   - Text without variations keeps the canvas's own drawing, so most text pays nothing.
3. **Files.**
   - The Worker's `GET /api/fonts/google-variable?family=` reads Google's download manifest server-side and caches it at the edge for a day. It returns the family's variable files (roman and italic) through the existing `/api/fonts/gstatic/` proxy, so browsers still never contact Google and R2 keeps each file once.
   - If the manifest's shape changes or Google is turned off (`GOOGLE_FONTS=off`), the answer is empty. Variable axes then aren't offered for Google families, and nothing else breaks.
   - Team fonts use their uploaded TrueType or OpenType file. Whether it's variable is read from the file.
4. **Axes come from the font.**
   - The inspector asks the shaper for the face's axes: tag, range, default, and the font's own name for the axis (its `name` table, so custom axes read "Grade", not `GRAD`).
   - Axes a font marks hidden aren't shown.
   - Weight is one of the sliders, and it sets `fontWeight`.
5. **Exports.**
   - SVG and CSS write `font-variation-settings`.
   - PDF already outlines shaped runs, so it gets the variations exactly.
   - PNG is drawn by the canvas renderer.

## Consequences

- Any axis of any variable Google or team font, drawn exactly on the canvas and in PDF and PNG, with one model value and one drawing path shared with OpenType features.
- Variable files are bigger than static ones (Roboto Flex is about 1.7 MB). They're fetched only for text that sets variations, and only once per instance (R2) and per browser (cache). Files over the proxy's 8 MB cap (some CJK families) aren't offered, and the panel says why.
- The download manifest isn't a documented API. If it changes, the endpoint returns nothing and the feature degrades to weight only. The parsing is small and unit-tested, so a fix is a one-file change.
