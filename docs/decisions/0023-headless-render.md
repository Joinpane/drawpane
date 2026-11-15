# 0023. Headless rendering: the SVG export, rasterised by resvg in the Worker

- Status: accepted
- Date: 2026-11-15
- Deciders: Ziyang (lead maintainer)

## Context

Agents check their work with `export_image` (decision 0021). With an editor open, the picture comes from the canvas renderer, as every export does. Headless, in the Worker, there is no canvas. Decision 0021 settled on rasterising the editor's SVG export in WebAssembly; this records how, and how closely it matches the canvas.

## Decision

1. **resvg, as `@resvg/resvg-wasm` 2.6.2,** wrapped in a small package of its own, `@drawpane/raster`. It has no DOM types and no Node APIs, so the Worker, the editor and the parity suite all import it and all run the same WebAssembly file. Measured against the alternatives (gzip is the WebAssembly alone):

   | Build | resvg inside | gzip | Gaps for our export |
   | --- | --- | --- | --- |
   | `@resvg/resvg-wasm` 2.6.2 (chosen) | about 0.35 | 949 KB | `mask-type` only as an attribute (the export now writes it so); no `font-variation-settings` |
   | `@resvg/resvg-wasm` 2.7.0-alpha.2 | the same | 962 KB | an alpha of the same thing |
   | `@cf-wasm/resvg` 0.4.0 | wraps 2.6.2 | 949 KB | adds loading helpers only |
   | `resvg-wasm` 0.5.0 | 0.47 | 729 KB | built without image decoding: image fills come out blank |
   | `svg2png-wasm` 1.4.1 | 0.36 | 776 KB | the same era as 2.6.2, a smaller project |

   Skia's CanvasKit (several MB, no SVG filters) and ThorVG (none of the filters or masks we write) don't draw our export. Building resvg 0.47 ourselves would be smaller and newer, at the price of a Rust toolchain in the build or a committed binary; worth it if the gaps above start to matter.

   A Worker imports the `.wasm` file as a compiled module (Workers can't compile WebAssembly at run time) and sets resvg up on its first render, not at start-up. The Worker pins the same `@resvg/resvg-wasm` version as `@drawpane/raster`, and a test holds the two together. On this VM a 300 × 200 scene with a blurred shadow, a mask and two lines of text takes about 55 ms at 1× and 155 ms at 2×.

2. **`renderPng` lives in the editor** (`createHeadlessRenderer(deps).renderPng(doc, nodeId, { scale, background })`, `src/headless-render.ts`). It needs the SVG export, export bounds, text layout and the document, all editor code; what differs by host is passed in: the text measurer (HarfBuzz in the Worker), a font loader, an image loader and the rasteriser, which may answer asynchronously (a render Worker behind a service binding would).
   - **Fonts** come through one small interface, `FontBytesLoader` (`@drawpane/raster`'s fonts.ts): a face (family, weight, italic, and `variable` for text that sets axes) in, TrueType or OpenType bytes out. The editor's HarfBuzz shaper already took exactly this, so the type moved there to be shared by the shaper, the headless measurer and the renderer. The renderer asks for every face the layers' text and runs use; a family without files is drawn in Instrument Sans at the same weight and style, and named in `missingFonts`.
   - **Images** come by content hash (`ImageBytesLoader`: bytes, type, natural size) and go into the SVG as data: URLs, as the SVG download already embeds them.
   - **Text is written for rasterising** (the export's new `raster` option): each upright line sits on a whole output pixel and underlines and strikethroughs are the canvas's own bars, as the canvas draws them. Runs with OpenType features or variable axes are glyph outlines from the measurer's shaper (`outlineFeatures`, as PDF does), so resvg's lack of `font-variation-settings` doesn't show.
   - **Sizes are capped** at 4096 px a side and 2048 × 2048 pixels in all: a Worker has 128 MB, and resvg draws each filter and group into a layer of its own.
   - The result lists what it couldn't draw exactly: `approximate` (glass, noise, texture, background blur), `missingFonts` and `missingImages`, so tools can mark a headless image as approximate.

3. **The Worker supplies the loaders** (`apps/worker/src/render/`), not yet wired to anything; the headless engine does that.
   - Team fonts from R2: the static face nearest the weight (a variable upload only for text that sets axes, since resvg draws a variable file at its default). WOFF and WOFF2 uploads are for browsers and are skipped.
   - Google and built-in families as static TrueType from Google's stylesheet API (the face asked for, else the family's regular), or the family's variable file for axes. Files are kept in R2 under the font proxy's own keys, so the proxy and the renderer share one copy. Nothing when `GOOGLE_FONTS=off`.
   - Images from R2 `media/`, only those the file's team may read.

4. **It stays in the main Worker.** The bundle today is 1,880 KB, 350 KB gzipped. resvg adds 943 KB gzipped (1,293 KB in all). The rest of the headless engine adds about 105 KB for the editor's code, 175 KB for HarfBuzz and 132 KB for PathKit, so about 1.7 MB gzipped: well inside the free plan's 3 MB and the paid plan's 10 MB. The installer now carries the Worker's `.wasm` modules beside its script. If the bundle outgrows the free plan, `Rasteriser` is already asynchronous, so rendering can move to a Worker of its own behind a service binding without changing `renderPng`.

5. **Parity, measured** (`apps/web/e2e/parity/headless.spec.ts`, thresholds in `tools/headless-parity/`). 187 cells, the Figma parity scenes and four of its own (radii and open ends; auto layout cards and type in Inter and Instrument Sans at several sizes and weights; rich text; image fills), each exported at 2× by the canvas and by `renderPng`, rasterised in Node by the same WebAssembly the Worker imports. Both sides draw the same document laid out by the page, so this measures the SVG export and the rasteriser; the text measurer has its own test. Mean difference over RGB (0–255), per suite, first run → now (a blank where the suite didn't exist yet or didn't finish):

   | Suite | First | Now | Worst cell now |
   | --- | --- | --- | --- |
   | fills | 7.78 | 0.09 | angular 0.26 |
   | strokes | 0.29 | 0.03 | corner-radii 0.09 |
   | shapes | | 0.05 | rotated-gradient 0.23 |
   | shadows | 0.11 | 0.11 | drop-large 0.24 |
   | masks | 0.17 | 0.17 | alpha-blurred 0.37 |
   | images | | 0.16 | fit 0.42 |
   | text | 0.87 | 0.22 | wrapped lines 0.59 |
   | rich-text | | 0.21 | paragraphs 0.35 |
   | text-ranges | 0.58 | 0.23 | lh-paragraphs 0.33 |
   | lists | 0.87 | 0.25 | list-wrapped 0.35 |
   | vertical-trim | 0.52 | 0.18 | runs 0.32 |
   | cards | | 0.33 | instrument-card-32 0.48 |
   | blurs | 2.58 | 2.58 | background-32 8.19 |
   | grain | 4.32 | 2.29 | texture-coarse 8.03 |
   | glass | 4.24 | 4.24 | square-corners 6.92 |

   The suite found five ways the SVG export drew differently from the canvas, all fixed there, so the SVG people download is better for them too:
   - **Blend modes in a clipping frame** blended with nothing: the frame's children sat in a clip group of their own, which SVG composites in isolation. The frame's fills now go inside the clip with them (fills 7.78 → 0.21).
   - **Dashes** on boxes and ellipses are fitted to each side and corner, as the canvas has done since decision 0013 (strokes' dashes 4.34 → 0.02).
   - **Angular gradients** are laid out in the layer's unit square, so their wedges fan out on a wide layer as the canvas's do (3.07 → 0.26).
   - **Duo noise** gives its second colour grain of its own, as decision 0008's revision made the canvas do (noise-duo-strong 22.0 → 3.7).
   - **Masks** say `mask-type` as an attribute rather than a style, which more renderers read (resvg dropped masked layers without it).

   What's left is mostly glyph rasterising (resvg's outlines against Skia's, and its shaping placing glyphs a fraction of a pixel apart along a line), plus three effects SVG can't draw as the canvas does: background blur (SVG can't see behind a layer), glass (only its rim) and noise and texture (turbulence, not the canvas's grain fields). Those are the `approximate` effects.

## Consequences

- Agents get a picture with no editor open, within a fraction of a level of the canvas for everything but the approximate effects, and told when it's approximate.
- The SVG export gained the fixes above for everyone.
- resvg 2.6.2 is two years old. The table above is the case for building our own if variable fonts in SVG or a smaller bundle start to matter.
- Renders cost CPU: tens to a few hundred milliseconds each. Cloudflare's free plan gives a request 10 ms of CPU, so headless images need the paid plan's limits; the engine should say so rather than fail opaquely.
- Every `renderPng` change can be checked against the canvas: `UPDATE_THRESHOLDS=1 npx playwright test e2e/parity/headless.spec.ts` locks in an improvement.
