# Engine default-on: the gap list and the plan

An audit of main at `970efc07` (2026-11-21, after phase 3) against decision 0040's default-on gate (phase 5: "default on, then retire the canvas renderer"). Phase 4 (headless on the engine) is being built in parallel and isn't counted here. Every number below was measured for this audit unless it names its source.

## In short

- **Accuracy is close.** On the frames it draws, the engine is as close to Figma as the canvas renderer, or closer: median frame error 0.47 against 0.49 on the iOS kit and 1.05 against 1.10 on shadcn. Every Figma parity suite passes on a T4 with WebGPU. It still misses "no frame worse than the canvas renderer" on many frames (171 of 280 drawn iOS frames, 248 of 734 shadcn frames), almost all by tiny amounts (edge alpha on small components). That's tuning work, not a redesign.
- **But it can't draw the files people use yet.** Text set in a font Drawpane doesn't have, with no outlines saved in the file, makes the engine refuse the whole page. The canvas renderer just draws it in a fallback font. That sends the large iOS kit's two heaviest pages, and a shadcn page, back to the canvas renderer, and it refuses 108 of the iOS kit's 400 sampled frames. Separately, the engine holds a page's images only up to 256 MiB, and one iOS page needs 821 MiB. These two are the top blockers.
- **Speed: panning is fine, zooming and editing on heavy pages are not.** On a T4 the engine pans at 60 fps on every page measured. On the iOS kit's heaviest page, though, a zoom stalls for about 4 seconds a frame, and drag, resize and undo didn't respond within 10 minutes. On shadcn it settles after a page switch in 4.0 s (canvas: 0.3 s), and edits answer in about 57 ms (canvas: 34 ms). The cause found: tiles that nothing can stand in for get drawn at full glass and blur cost, about 270 ms each.
- **Much of the gap to Figma isn't the renderer at all.** Dragging a shadcn component runs at about 10 fps, and small edits take about 70 ms, on both renderers. Drawing is 2 to 5 ms of that. The rest is the editor recomputing component copies, variables and layout. Typing into the iOS kit takes 8 to 9 s to settle on both renderers.
- **Several product features still need the canvas renderer.** PNG/JPEG export, export previews, dashboard thumbnails, component previews, template previews and the prototype player all draw with it. When the engine hits a limit, the canvas renderer draws that frame. Each needs an engine path before the old renderer can go.
- **The plan:** eight workstreams. Fix text first (it unblocks every measurement) and land the measuring tools alongside it. Then, in parallel: product flows, removing the canvas fallback (including image memory), performance (the zoom stall, then edits), accuracy tuning, and cross-browser text layout through HarfBuzz. Flip the default when the gate is green on the T4 and on real laptops. Delete the canvas renderer, about 6,600 lines, one release later.

## Contents

1. [The default-on gate, item by item](#the-default-on-gate-item-by-item)
2. [Accuracy on the two kits](#accuracy-on-the-two-kits)
3. [Figma parity suites](#figma-parity-suites)
4. [Product flows](#product-flows)
5. [Cross-browser text](#cross-browser-text)
6. [Performance](#performance)
7. [The gap list, prioritized](#the-gap-list-prioritized)
8. [Workstreams](#workstreams)
9. [Order of work](#order-of-work)
10. [What gets deleted](#what-gets-deleted)
11. [Risks](#risks)
12. [Decisions made in this audit](#decisions-made-in-this-audit)
13. [How to reproduce](#how-to-reproduce)

## The default-on gate, item by item

Decision 0040, "Migration, behind a switch": default-on needs "every Figma suite, both kits with no frame worse, both GPU backends, resource stress, the product flows below, and the interaction gates on the devices of criterion 1."

| Requirement | State on main | Evidence |
| --- | --- | --- |
| Every Figma parity suite within its thresholds | **Met** on SwiftShader (CI) and on the T4 with WebGPU; on the T4 with WebGL2 one gate fault (grain, G20) | `apps/web/e2e/parity/engine.spec.ts`, 24 suites, CPU, WebGPU and WebGL2 |
| Both kits, no frame worse than the canvas renderer | **Not met**: iOS 108 frames refused, 10 drawn without images, 171 of 280 worse; shadcn 8 refused, 248 of 734 worse (most by under 0.1) | "Accuracy on the two kits" |
| No kit page falls back | **Not met**: iOS Examples and Toolbars, shadcn Dropdown Menu | Live editor on a T4: `textWithoutOutlines` 708, 47 and 2 layers |
| Both GPU backends | **Partly met**: WebGL2 measured on the T4; WebGPU only on SwiftShader, or with software compositing on Modal | `pnpm gpu-bench` `gpu` and `webgpu` modes |
| Resource stress | **Partly met**: budgets, admission and loss recovery are tested; memory-pressure handling doesn't exist | `engine.spec.ts` loss and budget tests; no `memory pressure` handling in `engine-view.ts` |
| Product flows | **Not met**: see "Product flows" | |
| Interaction gates on the devices of criterion 1 | **Not met**: no Mac or Windows laptop has run them; Modal can't present WebGPU | `tools/gpu-bench` README, "Modes" |
| Telemetry of backend choice and fallbacks | **Missing**: console note and a DOM event only | `EngineView.#report` |

## Accuracy on the two kits

Kit parity drew every sampled frame with the canvas renderer and with the engine (CPU backend and WebGL2), as an export draws it, on a T4, and scored each against Figma's render with 0040's metrics. "Worse" is 0040's default-on gate per frame: the engine's mean over white and black more than 0.01 above the canvas renderer's, its worst 32 × 32 tile more than 1 above, or its alpha mean more than 0.05 above. Raw means are 0 to 255.

**Large iOS UI kit** (400 sampled frames, 44 pages; fresh conversion `aff55ac3997b7282`):

| | Frames |
| --- | --- |
| Refused by the engine (would fall back) | **108** (27%), all `textWithoutOutlines`: SF Pro, SF Compact and SF Pro Rounded text with no saved outlines. Most on Examples, Colors and Text Styles (11 each), Layout Guides and Steppers (8 each) |
| Drawn, images missing because the page's images exceed the engine's 256 MiB | **10** (Product Bezels: 821 MiB of images; engine mean up to 229, G19) |
| Drawn, everything else | 280 |
| ...of which worse than the canvas renderer by the gate | **171**: 158 by mean, 81 by alpha, 20 by worst tile |
| ...worse by more than 0.1 / 0.25 / 0.5 mean | 51 / 23 / 4 (largest 0.75: Page Controls, a spinner, an inactive window: edge alpha on small components over transparency) |
| ...better than the canvas renderer by more than 0.1 | 51 |
| Median / mean of frame means, those 280 | canvas 0.487 / 0.914; engine **0.472 / 0.863** |
| CPU against WebGL2 (T4) within 0040's tolerance | 286 of 292; the 6 outside miss on mean only (at most 1.0, p99 2, no severe pixels), mostly glass |

So on the frames it draws, the engine is closer to Figma than the canvas renderer on average, and its misses against the "no frame worse" gate are mostly small: edge coverage and alpha on small components, glass at transparent edges. The blocking items are the 108 refusals (G1) and Product Bezels' images (G19).

**shadcn/ui kit** (761 sampled frames, 88 pages, about 500,000 layers; conversion `172d037e7be04faf`; run in 3 parallel shards):

| | Frames |
| --- | --- |
| Refused by the engine | **8**: 4 `textWithoutOutlines` (Style Guide's Typography, Kbd's keyboard symbols, two chat bubble frames) and 4 frames longer than the engine's 8,192 px side (two Aspect Ratio frames at 10,927 px, two "Wrapper" frames at 8,761 and 8,848 px; 0040's criterion 3 refuses exports past 8,192 px on purpose) |
| Not drawn by the harness | 19 frames over 12 megapixels (component page overviews), skipped after one crashed the tab (see "Decisions") |
| Drawn | 734 |
| ...worse than the canvas renderer by the gate | **248**: 220 by mean, 83 by alpha, 29 by worst tile |
| ...worse by more than 0.1 / 0.25 / 0.5 / 1 mean | 31 / 8 / 5 / 4 (largest 4.09, on a 32 × 32 dialog icon button) |
| ...better than the canvas renderer by more than 0.01 / 0.1 | 226 / 48 |
| Median / mean of frame means | canvas 1.103 / 1.837; engine **1.047 / 1.828** |
| CPU against WebGL2 (T4) within 0040's tolerance | **734 of 734** (largest mean 0.115) |

On shadcn the engine draws almost everything, beats the canvas renderer at the median and on average, and its gate misses are overwhelmingly under 0.1.

## Figma parity suites

`apps/web/e2e/parity/engine.spec.ts`: all 24 Figma suites, each cell drawn on the CPU and on the GPU, held to the canvas renderer's recorded thresholds (`tools/figma-parity/thresholds.json`), to the live canvas renderer on the 5 replacement suites (shadows, blurs, linear blends, masks, grain), and to 0040's CPU-GPU tolerance, plus the Worker build bit for bit.

- **SwiftShader (CI):** green on `970efc07` (the 4 e2e shards include this spec, WebGPU and WebGL2).
- **T4, `webgpu` mode (core WebGPU on the NVIDIA GPU):** 25 of 25 tests pass.
- **T4, `gpu` mode (WebGL2 on the NVIDIA GPU):** 24 of 25 pass. `grain` fails on 4 cells by 0.01 to 0.11 over its recorded limits (for example `noise-duo-strong` 3.95 against 3.84). The CPU and WebGL2 scores fail alike, and the same CPU pixels score 1.20 here and 1.12 in `webgpu` mode, so the comparison's statistical blur (drawn on a 2D canvas, rasterized by the GPU in this mode) is what moves. That's a gate fix (blur in Node, or limits per raster backend), not an engine fault (G20).
- **No cell falls back** in any suite on any backend.

Mean difference from Figma per suite, CPU / GPU on the T4 (0 to 255):

| Suite | CPU / WebGL2 | Suite | CPU / WebGL2 |
| --- | --- | --- | --- |
| strokes | 0.06 / 0.06 | glass-dark | 0.67 / 0.67 |
| diamonds | 0.11 / 0.11 | glass-context | 0.66 / 0.66 |
| corners | 0.13 / 0.13 | text-overlap | 0.65 / 0.65 |
| shadows | 0.13 / 0.14 | blurs | 0.66 / 0.65 |
| masks | 0.14 / 0.14 | corners-glass | 0.77 / 0.80 |
| linear-blends | 0.18 / 0.18 | grain | 1.20 / 1.20 (1.12 in `webgpu` mode) |
| fills | 0.19 / 0.18 | glass | 1.21 / 1.24 |
| glass-ellipses | 0.30 / 0.30 | text-ranges | 1.32 / 1.32 |
| glass-probe | 0.33 / 0.33 | vertical-trim | 1.47 / 1.47 |
| glass-alpha | 0.36 / 0.36 | lists | 1.75 / 1.75 |
| text-strokes | 0.48 / 0.48 | text | 2.60 / 2.60 |
| glass-probe-2 | 0.60 / 0.61 | glass-stack | 2.75 / 2.77 |

WebGPU on the T4 scores the same as WebGL2 within 0.01 on every suite except grain. The text suites carry the largest remaining differences from Figma; those are layout and shaping (W6), on both renderers.

## Product flows

0040's "Product flows before the canvas renderer retires", checked against the code on main.

| Flow | State | What's there | What's missing |
| --- | --- | --- | --- |
| Accessibility | **Partial** | The canvas is `role="application"` with a label; the layers panel, keyboard selection and the reading-order tools are DOM and renderer-independent (`e2e/accessibility.spec.ts`); reduced motion is the editor's (`prefers-reduced-motion` in `editor.ts`), not the renderer's | No accessibility spec runs with the engine on; no DOM descriptions of canvas objects for screen readers |
| Text input, caret and IME | **Partial** | Typing goes through a hidden textarea (IME, spellcheck, clipboard), and the caret and selection come from the editor's own layout (`TextEditor.tsx`). The engine draws the edited text from its live layout (`whole: s.editingText`). Typing is in the interaction bench | No test that the caret lines up with the engine's frame (only with the canvas's); missing-font typing falls back today (the top blocker); browser zoom and DPR changes are tested for the overlay (`overlay-retained.spec.ts`), not for caret alignment |
| Collaboration overlays | **Partial** | Cursors, selections, name tags, guides and hover are the shared 2D overlay (`OverlayRenderer`), retained and dirty-region drawn (phase 3C); remote edits are display-list patches like local ones | No two-client test with the engine on; overlay cost per collaborator not measured |
| Raster export (PNG, JPEG) | **Missing in the editor** | The engine has banded and streaming CPU output (`renderBands`, `renderPng`) and export context for readers (0039); phase 4 moves the agent runner to it | `exporting.ts` and `ExportSection.tsx` (the preview) draw with `CanvasRenderer`; no 8,192 px limit message in the editor path |
| SVG, PDF and print | **Done, renderer-independent** | SVG export and PDF (svg2pdf, embedded fonts) don't use a raster renderer; they import only the `LinearMode` type from the canvas renderer's `linear-blend.ts` | Documented approximations of backdrop effects in SVG and PDF (0040 asks for them); there's no print flow beyond PDF |
| Thumbnails and previews | **Missing** | | `thumbnail.ts` (dashboard thumbnail), `ComponentPreview.tsx`, `new-file/create.ts` (template previews) and the prototype `Player.tsx` (the prototype viewer itself) all draw with `CanvasRenderer`; the server's thumbnails come from the browser, and agent images from resvg until phase 4 lands |
| Lifecycle | **Partial** | Page switches, resize (`ResizeObserver`), DPR changes, device and context loss with recovery and step-down, and switching renderers in place are tested (`engine.spec.ts`, `renderer-switch.spec.ts`, `overlay-retained.spec.ts`) | No sleep-and-resume test; no memory-pressure handling; every limit or refusal still ends in the canvas renderer (`ErrorCode.Limit` makes the canvas draw that frame), which can't survive retirement |

## Cross-browser text

**The problem.** Line breaks and text widths come from the browser's `measureText` (`CanvasTextMeasurer` in `packages/editor/src/text.ts`, wrapped by `ShapingMeasurer` in `apps/web/src/editor/shaping.ts`). Each browser's font stack measures slightly differently, so the same file wraps differently in Chrome, Safari and Firefox. Phase 3C saw one-word shifts on WebKit in 4 text suites. The engine draws glyphs shaped by HarfBuzz, so under the engine a line's breaks come from the browser while its glyphs come from HarfBuzz.

**What already exists.** `HarfBuzzMeasurer` (`packages/editor/src/harfbuzz-measurer.ts`, 737 lines) measures text with HarfBuzz the way Chromium's canvas does, for the headless editor (decision 0021). `e2e/parity/text.spec.ts` holds it to the canvas measurer within 0.05 px at 16 px, metrics within 0.5%, on Latin text across weights, sizes, kerning, letter spacing, wrapped paragraphs, axes and features. It already handles unicode-range subsets, the fallback chain to Instrument Sans, and Chromium's choice of ascent and descent.

**The scope.**

1. Measure layout with `HarfBuzzMeasurer` in the browser as well, behind a switch. It needs face bytes, which the shaper already fetches (`fontBytes`). Then Chrome, Safari, Firefox and the agent runner all wrap identically, matching Chromium's metrics.
2. Font loading becomes byte loading: layout can't measure a face until its file is in HarfBuzz, so text stays provisional until then, as the engine's text already does (`TextMeasurer.loading`).
3. The engine's shaped glyphs and the layout's widths then come from the same shaper. Today they agree only as far as Chromium's canvas and HarfBuzz agree.
4. Scripts that need system fonts the app can't read (CJK, Arabic, emoji): the browser draws them from system fonts that HarfBuzz can't see. `HarfBuzzMeasurer` estimates those today (`approximations`). Either ship fallback faces for them (Noto subsets through the font proxy), or keep `measureText` for those runs only and record it in the file as an approximation.
5. Stored files: text boxes the old measurer sized (auto-width, hug layouts) may change by fractions of a pixel. Layout must not rewrite them on open. Only an edit should relayout, as today (see "Avoid stored-file migrations").

**Acceptance.** The text parity suites (`text`, `text-ranges`, `lists`, `vertical-trim`, `text-overlap`, `text-strokes`) give identical line breaks on Chromium, Firefox and WebKit on the GPU bench, with each line's text, start and width the same across browsers. `kit-parity text-widths` on both kits is no worse than today. The relayout stability tool shows no box changes on open.

## Performance

All numbers are presented frame intervals on a Modal T4 (Chromium 158, `gpu` mode: canvas, WebGL and compositing on the GPU), p50 / p95 / p99 ms, unless they say otherwise. In `gpu` mode the engine runs on WebGL2, because Chromium there offers core WebGPU only on SwiftShader. Figma itself wasn't run on the same hardware (see "Decisions"). 0040's gates stand in for "close to Figma": 60 fps, p95 at most 16.7 ms and p99 at most 20 ms while moving, exact within 250 ms, a useful first image within 1 s and the exact page within 3 s.

**The iOS kit's heaviest pages.** On main, the engine doesn't draw them: both fall back to the canvas renderer (G1). The engine numbers below come from the audit's local prototype of W1 (missing faces shaped in Instrument Sans; 23 text layers on Examples that no face could shape left out), so they show the engine as it would be once W1 lands.

| iOS Examples (17,922 layers, 921 backdrop readers, 4,644 shadows) | Canvas renderer | Engine (prototype) |
| --- | --- | --- |
| Open: useful image / exact | not reported / 40.5 s | 7.3 s / 35.0 s |
| Pan, whole page | 16.7 / 17.6 / 31.2 | 16.7 / 17.8 / 37.7 (content 7.3 ms p50) |
| Zoom, whole page | 16.6 / 19.9 / 37.4, exact after 8.7 s | **17.7 / 4,071 / 4,385**, exact after 9.7 s |
| Pan, 50% / 100% | 16.6 / 17.5 / 17.7 both | 16.8 / 20.9 / 44.5 and 16.6 / 17.9 / 18.0 |
| Drag 60 frames (interactions) | 44.9 / 93.9 / 130.5 | **no answer in 10 minutes** |
| Drag into the next board, resize, undo | 51.8 / 137.2 / 334.3; 58 ms; 30 ms | **no answer in 10 minutes each** (the run then hit its 75-minute limit) |
| Type: answer / exact | 67.5 ms / 9.4 s | not reached |

| iOS Toolbars (1,714 layers, 168 readers, 1,140 shadows) | Canvas renderer | Engine (prototype) |
| --- | --- | --- |
| Open: useful image / exact | not reported / 4.4 s | 25 ms / 7.0 s |
| Pan, whole page | 16.7 / 65.2 / 81.3 | 16.7 / 17.4 / 17.7 |
| Zoom, whole page | 16.7 / 24.9 / 31.2 | **77.1 / 2,350 / 2,384** |
| Pan, 50% | 19.2 / 36.4 / 40.3 | 16.6 / 78.4 / 136.5 |
| Pan, 100% | 29.7 / 56.3 / 66.6 | 16.7 / 50.5 / 177.3 |
| Drag 60 frames | 14.7 / 208.1 / 229 | not reached |

**shadcn Combobox** (2,906 layers, 4 readers, 129 shadows), drawn by the engine on main:

| | Canvas renderer | Engine |
| --- | --- | --- |
| Open: useful image / exact | 67 ms (two frames) / 403 ms | 138 ms / 547 ms |
| Pan, whole page | 16.8 / 17.4 / 29.8 | 16.9 / 25.4 / 26.4 |
| Zoom, whole page | 16.7 / 25.6 / 40.7, exact after 182 ms | 17.0 / 62.1 / 97.4, exact after 43 ms (profiled run: 17.1 / 44.1 / 70.5) |
| Pan, 100% (interactions) | 16.7 / 17.2 / 17.4 | 16.6 / 20.8 / 22.8 |
| Drag 60 frames | 33.4 / 34.8 / 439 | 16.8 / 33.3 / 34.0 |
| Switch page: answer / exact | 66 ms / 336 ms | 148 ms / 3,968 ms |
| Type: answer / exact | 37 ms / 686 ms | 47 ms / 669 ms |
| Change fill / change effect: answer | 34 / 34 ms | 58 / 57 ms |

**shadcn Dropdown Menu** (4,459 layers) falls back on main (2 text layers, G1). With either renderer: drag 60 frames p50 100 ms, drag answer 69 to 76 ms, nudge and undo 70 to 72 ms, type 67 ms, fill and effect changes 71 to 72 ms. Drawing is 1 to 5 ms of each.

**Other browsers.** Phase 3C measured Firefox (WebGPU under Xvfb) and WebKit (WebGL2) on the 10,000-layer bench file on a T4. WebKit's frame intervals improve with the engine. Firefox's don't, because Xvfb presentation sets the pace there. Neither ran a kit page. Real Safari and desktop Firefox haven't been measured (G8).

**The biggest remaining costs, by evidence:**

1. **Tiles nothing can stand in for, drawn regardless of budget, at full reader cost** (zoom on reader-heavy pages). On Examples, one zoom frame drew 16 such tiles in 4,340 ms, about 270 ms a tile; on Toolbars, 21 tiles in 2,336 ms. Readers aren't drawn coarse in that path, so a zoom out past what was drawn stalls for seconds. Core WebGPU on the T4 (`webgpu` mode) stalls the same way (Examples zoom content p95 3.3 s, Toolbars 2.1 s), so it isn't the WebGL2 backend. Decision 0042's coarse readers, and a budget for "must draw" tiles (coarse first, exact in idle slices), are the fix to try first. The edits that never answered on Examples (drag, resize, undo) likely meet the same path: an edit under 921 readers invalidates reader tiles that then redraw exact.
2. **Fresh display list builds and first exact tiles.** Examples' list (17,922 records) takes 645 ms to build on the T4 (3.9 s on this loaded VM), and open to exact takes 35 s. Switching to Combobox takes 3,968 ms to exact against the canvas's 336.
3. **The edit pipeline on both renderers.** A 60-frame instance drag on Dropdown Menu spends 6.3 s of main thread: about 1.9 s presenting compact copies (`packages/model/src/copies.ts`: `get`, `childIds`, `builtFrom`), 0.8 s resolving variables and styles (`token-view.ts` `present`), 0.84 s in `getProp` from those paths, and layout (`layout.ts` `measure`, `box`). Typing on iOS Examples takes 8 to 9 s to settle exact on both renderers.
4. **GL call overhead on WebGL2.** `texSubImage2D`, `framebufferTexture2D`, `flush`, `fenceSync` and `bufferSubData` are the largest named costs in the engine's pan and zoom profiles on Combobox, and "(program)" (native time, much of it GL) is about 1 s of each 3 s profile.
5. **Image uploads through `getImageData`** on the main thread: 191 ms of the first frame on Combobox. And image memory: the engine keeps every image of a page at full resolution, with levels, within 256 MiB. iOS Product Bezels needs 821 MiB and Examples 225 MiB (see G19).
6. **Garbage collection while zooming:** 262 ms in a 3.3 s zoom profile on Combobox.

## The gap list, prioritized

Ranked by what blocks the default the most. P0 blocks default-on, P1 must land before the canvas renderer is deleted, P2 can follow.

| # | Gap | Priority | Measured | Workstream |
| --- | --- | --- | --- | --- |
| G1 | **Text in a missing face without saved outlines refuses the whole page** (`UNSUPPORTED.textWithoutOutlines`). The canvas renderer draws it in the fallback chain (`"Missing glyph", "Instrument Sans Variable", system-ui`). | P0 | iOS Examples: 737 text layers (all SF Pro, 713 of them with OpenType features) have no `glyphLayout`, and 708 refuse on the T4; Toolbars 47; shadcn Dropdown Menu 2. A local prototype that shapes in Instrument Sans brought Examples from 708 to 23. The 23 left are text the fallback face can't shape either: `Shaper` returns null when a face lacks a character, so it needs per-character fallback (SF Symbols to the missing-glyph box) | W1 |
| G2 | **Progressive layer blur with a varying radius is unsupported** (`layer.ts` sets `UNSUPPORTED.layerBlur`) | P0 | Not in either kit's pages (census: 0 pages); the renderer fallback fixture uses it on purpose | W7 |
| G3 | **Limits and refusals end in the canvas renderer.** `ErrorCode.Limit` (content or budget), CPU view mode's limit, an unsupported page and a failed start all hand frames to `CanvasRenderer`. | P0 | Code: `engine-view.ts` `#cpuUnsupportedPage`, `ErrorCode.Limit` branches, chain step 4 | W3 |
| G4 | **Raster export, export preview, thumbnails, component previews, prototype player and new-file template previews draw with `CanvasRenderer`** | P0 | Code: `exporting.ts`, `ExportSection.tsx`, `thumbnail.ts`, `ComponentPreview.tsx`, `prototype/Player.tsx`, `new-file/create.ts` | W2 |
| G5 | **Kit frames the engine draws worse than the canvas renderer** | P0 | iOS: 108 frames refused (text), 10 drawn without images (Product Bezels, G19), and 171 of the other 280 worse by the gate (51 by more than 0.1 mean, 4 by more than 0.5). shadcn: 8 refused (4 text, 4 longer than 8,192 px), 248 of 734 drawn worse (31 by more than 0.1, 4 by more than 1). Most misses are edge alpha and coverage on small components over transparency | W7 |
| G6 | **The engine zooms, settles and edits slower than the canvas renderer** | P0 | Zoom on reader-heavy pages stalls: iOS Examples zoom p95 4,071 ms a frame (canvas 20), Toolbars 2,350 (canvas 25), from must-draw tiles at about 270 ms each; on Examples, drag, resize and undo never answered within 10 minutes each. shadcn Combobox, T4: exact after switching pages 3,968 ms (canvas 336); fill and effect changes answered in 57 to 58 ms (34); zoom p95 44 to 62 ms (26). Opening Examples: useful image 7.3 s, exact 35 s (targets 1 s and 3 s) | W4 |
| G7 | **Edit pipeline costs dominate interaction on real kits, on both renderers** | P0 for "close to Figma", not for the default | shadcn Dropdown Menu: drag 100 ms a frame, nudge, undo and fill answer in 70 ms with 2 ms of drawing; iOS Examples: typing exact after 8.4 to 9.4 s, open to exact 40.5 s on canvas | W4 |
| G8 | **No interaction gates on the devices of criterion 1**, and no hardware WebGPU presentation measured | P0 | Modal can't present WebGPU canvases (`gpu-bench` README); no Mac or Windows host | W5 |
| G9 | **No engine-on run of the product e2e suites** (the 4 CI shards run the canvas renderer) | P0 | `.github/workflows/ci.yml` | W5 |
| G10 | **No telemetry** of the backend chosen and of fallbacks (0040, "Loss and switching") | P1 | `EngineView.#report` logs and dispatches an event only | W3 |
| G11 | **Line breaks differ per browser** (`measureText`) | P1 | Phase 3C: one-word shifts on WebKit in 4 text suites | W6 |
| G12 | **Engine-on but page falls back costs more than the canvas renderer alone** (the builder keeps patching) | P1 while the switch exists | iOS Examples with the engine on but falling back: switch page 7,381 ms (canvas alone 278); pan content 12 ms a frame (0.3); nudge 43 ms (30) | W3 |
| G13 | **Memory pressure** isn't handled (no eviction on `memory` pressure signals, no test) | P1 | Code search | W3 |
| G14 | **Interaction bench cases hang** (`resize`, `drag`, `nudge`, `undo` probes never answer on some pages), and the run stops at the first | P1 | Every real-file `interactions.spec.ts` run in this audit failed on one case, both renderers | W5 |
| G15 | **Kit parity draws only with the canvas renderer** | P1 | `kit-parity.spec.ts` before this audit; the audit's engine mode is described in "How to reproduce" | W5 |
| G16 | **CPU against GPU isn't measured on kit frames** | P1 | Only on the parity suites; this audit measured CPU against WebGL2 on kit frames (see "Accuracy") | W5 |
| G17 | Phase 3 follow-ups: GPU frost-100 mip phase drift (cap 0.30), Worker admission very conservative (26 of 40 fuzz cases refused, peak at most 58% of the cap), onscreen WebGL2 coarse fence and presentation gates missed, the half-resolution stand-in softens the whole frame, tiles near the frame edge differ from whole frames by up to 39 levels, 3 Figma goldens missing (glass in a picture mask, a layer-blurred frame, a noise frame) | P2 | 0040's phase 3B amendment and the phase 3 merge notes | W7 |
| G18 | Documented SVG and PDF approximations of backdrop effects | P2 | 0040, "Product flows" | W2 |
| G19 | **Image memory: every image of a page is held at full resolution with levels, within 256 MiB** (`Limits::image_bytes`) | P0 | iOS Product Bezels needs 821 MiB of decoded images and doesn't fit; Examples needs 225 MiB (88% of the cap); the kit's pages need 1,443 MiB in all. The canvas renderer draws them through the browser's own image cache | W3 |
| G20 | **The grain suite fails on the T4 in `gpu` mode** because its statistical blur is drawn by the browser's 2D canvas, whose raster backend changes the score | P2 | 4 cells over their limits by 0.01 to 0.11; the same pixels pass in `webgpu` mode | W5 |

## Workstreams

Owners are open. Each workstream lists its scope, what it depends on, and the tests that close it. "Kit census" means the engine page census from kit parity's engine mode: every page of a kit built as the live editor builds it, with its unsupported features counted.

### W1. Text the engine can always draw (P0, start first)

- **Scope:** never refuse text. Shape a run whose face won't load in the face the canvas draws it in. Follow the canvas's fallback chain per character: the run's family, then the missing-glyph box for private-use characters (decision 0036), then Instrument Sans, then a bundled last resort. That means itemizing runs by cmap coverage in `Shaper` (it returns null today when a face lacks a character) and in `HarfBuzzMeasurer` (which already walks the chain for widths). The same applies to list markers. Remove `UNSUPPORTED.textWithoutOutlines` as a refusal; keep it as a counted note.
- **Depends on:** nothing. W6 builds on it.
- **Acceptance:**
  - Kit census: 0 pages fall back on either kit for text; Examples, Toolbars and Dropdown Menu are drawn by the engine in the live editor on the T4 (`file.spec.ts` reports `renderer: engine`).
  - A new parity cell set, "missing faces": SF Pro text with features, with SF Symbols and with mixed scripts, no saved glyphs, scored against the canvas renderer's fallback drawing (no Figma golden can show a missing font).
  - An e2e test: typing into a text layer in a missing face with the engine on stays on the engine, caret aligned (G9's matrix covers the rest).

### W2. Product flows on the engine (P0)

- **Scope:** one "engine snapshot" service used by every non-canvas picture: the CPU build in a dedicated Worker (`renderBands`, streaming `renderPng`), fed a display list built by `DisplayListBuilder.buildLayers(ids, { context })`.
  - Raster export (PNG and JPEG, transparency, scales, contextual backdrops per 0039, the 8,192 px limit with a clear error), the export panel preview, dashboard thumbnails (`thumbnail.ts`), component and library previews, new-file template previews.
  - The prototype player is a live view, not a snapshot: it gets an `EngineView` of its own, with the same backend chain as the editor.
  - SVG and PDF keep their vector path; write down their approximations of glass and background blur in the export panel and the docs.
- **Depends on:** W1 (thumbnails of kit files have text in missing faces). Shares the CPU build's export path with phase 4.
- **Acceptance:**
  - Export suites (`e2e/images.spec.ts`, `export` cases in the editor specs, the headless parity suite pointed at the browser path) pass with `CanvasRenderer` unconstructable (a test build that throws in its constructor).
  - Thumbnails are deterministic per revision (same bytes twice), have no overlays, and come within the CPU-GPU tolerance of the editor's frame.
  - Large export: an 8,192 px frame streams within the Worker caps; 8,193 px is refused with the message.

### W3. No canvas behind the engine (P0)

- **Scope:** replace every path that ends in `CanvasRenderer`.
  - `ErrorCode.Limit`: draw coarser (lower raster scale, tiles, direct jobs) and say so in the status chip, never hand off.
  - Unsupported: after W1 and G2 nothing should be. Anything left draws its supported parts and marks the layer, with telemetry, rather than refusing the page.
  - Startup failure on every GPU backend: CPU view mode is the floor; if even that fails, a clear "can't draw this file here" state.
  - Image residency (G19): upload an image at the level the camera needs, not always at full resolution; evict images no tile on screen or near it uses; keep the CPU copy out of the wasm heap where the backend allows. iOS Product Bezels (821 MiB of images) must draw.
  - Memory pressure: evict tiles, blur pyramids and glyph masks on a pressure signal and on `visibilitychange` to hidden; rebuild on return. Sleep and resume test.
  - Telemetry: the backend chosen, adapter class, every fallback and its reason, and frames drawn coarse, sent to the instance's own health endpoint (decision 0003), so blocklisting can follow.
  - While the switch exists, an unsupported page shouldn't pay for the builder (G12): stop patching a page the engine has refused until its revision changes what was refused.
- **Depends on:** W1 for the text refusal.
- **Acceptance:** iOS Product Bezels draws on the engine with every image, at most 256 MiB held, and no frame worse than the canvas renderer. `engine.spec.ts` gains: a page over the content limit stays on the engine, drawn coarse, with the chip saying so; repeated loss ends in CPU view mode, never the canvas; a pressure event evicts and the next frame rebuilds exact; hide and show the tab and the frame is exact within 250 ms. A grep test: nothing in `apps/web/src` imports `CanvasRenderer` except the code W8 deletes.

### W4. Performance: renderer and edit pipeline (P0)

- **Scope, renderer (measured on the T4, WebGL2 and WebGPU):**
  - Must-draw tiles on reader-heavy pages, first: a zoom past what was drawn draws every tile nothing stands in for, whatever the budget, with readers exact (about 270 ms a tile on iOS Examples, 4.3 s frames). Draw them with coarse readers (decision 0042) inside the frame budget, then exact in idle slices. Then find why drag, resize and undo on Examples never answer (likely the same reader redraws, after an edit).
  - GL call overhead on WebGL2: `texSubImage2D`, `framebufferTexture2D`, `flush`, `fenceSync` and `bufferSubData` are the largest named costs in the engine's pan and zoom profiles. Batch uploads, reuse framebuffers, fence once per frame.
  - Image uploads at open: 191 ms of `getImageData` in the first frame on Combobox. Decode with `createImageBitmap` straight to the GPU (`copyExternalImageToTexture` on WebGPU, `texImage2D` from the bitmap on WebGL2), off the main thread for the CPU copy the CPU backend needs.
  - Garbage collection while zooming: 262 ms of GC in a 3.3 s zoom profile. Find the per-frame allocations (camera messages, typed arrays crossing wasm).
  - Settling after a page switch (3,968 ms against the canvas's 336) and after edits (fill and effect changes 22 ms of content against 1.6): the fresh display list build (Examples' 17,922 records took 3.9 s to build on this loaded VM) and the first exact tiles. Profile with wasm names kept (`build.mjs`, see the GPU render engine notes).
  - Zoom: p95 44 to 62 ms against 26 for canvas on Combobox (`file.spec`).
- **Scope, edit pipeline (both renderers):** profile drag, nudge, undo, fill change and typing on shadcn Dropdown Menu and iOS Examples (instance relayout, override propagation, sync encoding, layers panel updates). The audit's profiled run is listed under "How to reproduce".
- **Depends on:** W1 (the iOS pages must draw on the engine to be measured), W5's bench fixes.
- **Acceptance:** on both kits' heaviest pages (iOS Examples and Toolbars, shadcn Combobox and Dropdown Menu), on the T4 in `gpu` mode and on the laptops: pan, zoom and drag frame intervals p95 at most 16.7 ms and p99 at most 20 ms; exact within 250 ms of movement stopping (p95); edits answered in at most 50 ms and exact within 250 ms where the dependency closure fits a frame; open: useful image within 1 s, exact within 3 s; and no case worse than the canvas renderer on the same run.

### W5. Gates, benches and harness (P0, early)

- **Scope:**
  - Land kit parity's engine mode (the audit's branch `t3/kit-parity-engine-mode-audit`, reviewed and cleaned up), including a debug renderer that releases images as the live editor does: the engine page census, per-frame engine drawing with refusal reasons, inline scoring with 0040's metrics, and the GPU bench mode (`E2E_KIT_PARITY_FROM_BENCH`), so both kits run on a T4 in about 40 minutes each instead of days on this VM.
  - Make interaction cases independent: a case that never answers is reported and the run goes on (the audit's prototype does this), and fix the probes that hang (`resize`, `drag`, `nudge`, `undo` on kit boards).
  - An engine-on CI matrix: the 4 e2e shards again with the renderer switch on (SwiftShader, `drawpane:engine-software=allow`), allowed to fail per spec at first, then required.
  - Real devices: a written protocol and a results page for `/diagnostics/renderer` plus the interaction suite on a Mac laptop (Safari, Chrome) and a Windows laptop with integrated graphics (Edge, Chrome), run by a person until a device host exists.
  - CPU against GPU on kit frames (the audit measured CPU against WebGL2 on the T4).
- **Depends on:** nothing.
- **Acceptance:** a scheduled kit parity run on both kits posts its scoreboard and the gate's verdict; the engine-on CI matrix is green and required; one laptop run per device class is recorded against the gates.

#### Engine-on CI follow-ups

The four engine-on Chromium shards run with SwiftShader and the editor's engine switch enabled. Each shard reports failed specs in its job summary. Each exception in `apps/web/e2e/engine-ci-allowed.json` needs an observed failure and a follow-up below. An unexpected spec failure fails the engine-on check.

### W6. Text layout through HarfBuzz (P1)

- **Scope:** "Cross-browser text" above: `HarfBuzzMeasurer` as the browser's layout measurer, byte-loaded faces, fallback faces for scripts the app can't read, no relayout on open.
- **Depends on:** W1's per-character fallback.
- **Acceptance:** identical line breaks in the text suites on Chromium, Firefox and WebKit on the GPU bench; `text.spec.ts` widths unchanged; relayout stability on both kits shows no change on open.

### W7. Accuracy to no frame worse (P0)

- **Scope:** every kit frame in G5, root-caused by feature with the per-pixel attribution scripts (`ios27/analysis/scripts/attribute.mjs`) and fixed in the engine with a parity cell; progressive layer blur with a varying radius (G2); the phase 3 follow-ups (G17).
- **Depends on:** W1 (refused frames must draw to be scored), W5 (kit parity's engine mode).
- **Acceptance:** 0040's kit gate on both kits: no frame's mean (over white and black) worse than the canvas renderer's by more than 0.01, no worst tile worse by more than 1, alpha not worse; and every Figma parity suite within its thresholds on SwiftShader and on the T4, both backends.

### W8. Flip, then retire (after the gate)

- **Scope:** flip the default (`rendererChoice` returns `engine`; `?renderer=canvas` stays for one release as the escape hatch). One release later, delete the canvas renderer ("What gets deleted").
- **Depends on:** W1 to W5 and W7 green; W6 can land after the flip.
- **Acceptance:** the default-on gate table above all green; after the deletion, `pnpm -r typecheck && pnpm lint` and every suite pass with no `CanvasRenderer` in the tree.

## Order of work

1. **Now, in parallel:** W1 (text) and W5 (harness, bench fixes, engine-on CI matrix). Both are small to medium and unblock everything else.
2. **Once W1 lands:** rerun kit parity and the T4 benches on both kits. That turns G5 and G6 into complete lists, since the iOS kit's heaviest pages will draw on the engine.
3. **In parallel after that:** W2 (product flows), W3 (no canvas behind the engine), W4 (performance, renderer and edit pipeline), W7 (accuracy), W6 (HarfBuzz layout).
4. **Flip the default** (W8, first half) when the gate table is green on the T4 and on one laptop of each class.
5. **One release later, retire** the canvas renderer (W8, second half).

W4's edit-pipeline half doesn't block the flip (the canvas renderer has the same costs), but it decides whether the product feels close to Figma, so it starts in step 3, not after.

## What gets deleted

Once the default is on and a release has passed (0040, phase 5). Lines are as of `970efc07`.

**Canvas renderer, editor package (`packages/editor/src`):**

| File | Lines | Notes |
| --- | --- | --- |
| `render.ts` | 3,389 | `CanvasRenderer`, its tiles and stand-ins (decision 0028), coarse readers (0042). Keep `fadesAsOne`, `GREEK_BELOW`, `greekLines` and `largestFontSize`, which the engine's builder imports (`engine/layer.ts`): move them to a shared module first |
| `glass.ts` | 1,211 | Glass in WebGL2 with copies in and out. Keep `glassParams` (the builder imports it): move it first |
| `webgl.ts` | 284 | The shared WebGL2 helper for glass, luminance, linear blends, noise, texture and inradius |
| `luminance.ts` | 108 | Luminance masks on the canvas |
| `linear-blend.ts` | 283 | Linear dodge and burn on the canvas (0038). Move the `LinearMode` type that `svg.ts` and `svg-linear.ts` import |
| `tiles.ts` | 187 | The canvas's tile work list (stand-ins) |
| `inradius.ts` | 130 | Glass distance on the canvas |
| `corners-canvas.ts` | 33 | Plain corners on `roundRect` |
| `noise.ts` | 268 | The canvas's `NoiseTiles` and `paintNoise`. Keep `noiseThresholdZ` and the seeding that `svg.ts` uses |
| `texture.ts` | 170 | `TexturePainter`. Keep `textureReach` (`post-effects.ts`) |
| `render-memory.ts`, `headless-render.ts` | 107, 463 | resvg's headless path, once phase 4 is in |

**Tests:** `packages/editor/test/glass.test.ts`, `linear-blend.test.ts`, `inradius.test.ts`, `headless-render.test.ts`, and the canvas renderer's cases in `apps/web/e2e/canvas-render.spec.ts`, `canvas-scale.spec.ts` and `glass.spec.ts`. `e2e/parity/parity.spec.ts` (the canvas against Figma) goes; `engine.spec.ts` keeps the goldens and `thresholds.json`, with the canvas-relative replacement gates turned into fixed limits at the canvas's last recorded scores. `e2e/parity/headless.spec.ts` (resvg against the canvas) goes with phase 4.

**App (`apps/web/src/editor`):** the canvas branch of `Canvas.tsx` (the `CanvasRenderer`, `contentCanvas`, the settle timer and fallback-frame counting), the canvas step of `engine-view.ts`'s chain, `parity-debug.ts`'s canvas render (kit parity then draws only through the engine), `engine-debug.ts`'s `canvasRender`, the `canvas` value of the renderer switch, and the renderer status chip's "Canvas renderer" state. Every remaining `CanvasRenderer` caller moves to W2's snapshot service first.

**Agent runner and packages:** `packages/raster` (resvg, 419 lines) and `apps/agent-runner/wasm/resvg.wasm` with `scripts/cap-wasm.ts`, once phase 4's `renderPng` on the CPU build replaces them.

**Bench and tools:** `BENCH_RENDERER=canvas` and `both` in the benches, kit parity's canvas drawing, the `canvas` arm of the gpu-bench examples.

In total, about 6,600 lines of renderer source and 850 lines of its unit tests, before e2e specs and the app's canvas branch. The shared 2D overlay (`overlay-renderer.ts`, `overlay.ts`, `labels.ts`) stays: it draws handles, guides, labels and collaborators over the engine.

## Risks

- **The fallback-face fix changes what users see.** Drawing missing-face text in Instrument Sans matches the canvas renderer, which already does so. Figma draws such text from its saved outlines. The 737 Examples layers that have none differ from Figma either way, and kit parity will show that, not hide it.
- **Per-character fallback is real work in `Shaper` and `HarfBuzzMeasurer`.** Itemizing by cmap, then shaping each item, must keep kerning inside items and agree with the layout measurer, or lines will break where glyphs don't fit.
- **The engine isn't faster yet on the pages it draws.** If W4 can't bring settle and edit times under the canvas's, the flip waits. 0040's "When they fail" applies: cache granularity, pass scheduling and batching first, the engine choice last.
- **WebGL2 is what the T4 runs, not WebGPU.** Full speed is promised on WebGPU (criterion 1), but Modal's Chromium can't present WebGPU, so the main hardware numbers here are WebGL2's. A laptop run on WebGPU may be better or worse. W5's device protocol is the only way to know.
- **The edit pipeline, not the renderer, may be most of the gap to Figma.** If so, flipping the renderer won't change how the kits feel. That's why W4 measures both halves.
- **Retirement removes the safety net.** After the deletion, an engine bug shows as a wrong or missing picture with nothing to fall back to. W3's telemetry and coarse paths, and a release behind the flipped default, are the mitigation.
- **Kit data is private and large.** Kit parity on Modal uploads the converted kits with Figma's renders to the private Volume (`drawpane-gpu-bench-data`). They must never enter an image, a repository or a log.
- **Shared-VM load.** This VM's load reached 40 to 47 during the audit. Local kit parity ran at about 5 minutes a frame, and two local runs failed to start their Worker in time. Heavy measurement belongs on Modal.

## Decisions made in this audit

- **Kit parity through the engine draws each frame as an export does** (the frame alone, with backdrop context for readers, `buildLayers(ids, { context: true })`), the way kit parity's canvas drawing already does (`renderNodes(…, true)`), so both sides draw the same thing.
- **Engine frames are scored on the CPU backend and on WebGL2 on the T4.** The CPU backend is the engine's reference. WebGL2 is what Modal's `gpu` mode gives real hardware. Core WebGPU on Modal composites in software and core WebGPU on this VM is SwiftShader, so neither was used for kit frames.
- **The 0040 kit gate is computed per frame** with `packages/engine/src/compare.ts`: the engine is worse when its mean (over white and black) exceeds the canvas renderer's by more than 0.01, its worst 32 × 32 tile by more than 1, or its alpha mean by more than 0.05 (the slack `engine.spec.ts` uses for alpha).
- **Kit parity moved to Modal** after local runs proved infeasible (about 5 minutes a frame at load 40+, and two failed Worker starts). The iOS kit was converted fresh (cache `aff55ac3997b7282`). The shadcn kit used the latest existing conversion (`172d037e7be04faf`, 2026-11-19) instead of a 12 to 50 minute reconversion: both renderers read the same input, so the comparison is fair, but import changes since then aren't reflected.
- **The heaviest pages are kit-pages' own ranking** (backdrop readers, then shadows, then layers): iOS Examples and Toolbars, shadcn Combobox and Dropdown Menu.
- **Figma wasn't benchmarked on the same hardware.** Driving Figma's editor through Playwright on a T4 is possible with the vault account but would measure a different product on a shared session. 0040's confirmed targets stand in for "close to Figma".
- **A local prototype measured the iOS pages on the engine** (`AUDIT PROTOTYPE` in `engine/layer.ts`, never committed): runs in a missing face are shaped in Instrument Sans, and text no face can shape is left out (23 layers on Examples). It shows what W1 makes possible and is labelled wherever its numbers appear.
- **A second prototype made the interaction bench's cases non-fatal**, so a hanging probe doesn't end the run (also never committed; W5 lands it properly).
- **The audit's harness changes are not in this pull request,** which is docs only. They're on the branch `t3/kit-parity-engine-mode-audit` (`84392f12`, pushed, no pull request) for W5 to review and land, and described in "How to reproduce".
- **The engine page census is an early look, not the editor's verdict.** It builds each page right after the file opens, before the shaper's 3 s face deadline, so text in missing faces is still "loading" there, not refused. Both kits' censuses show 0 pages falling back, while the live editor on the T4 hands three pages back. The per-frame drawing waits for the deadline and is the number to trust.
- **Huge frames were skipped in the harness.** A 2,560 × 8,004 frame crashed the tab: each frame crosses the page as base64 several times. Frames over 12 megapixels (19 shadcn component overviews) weren't drawn by the engine in kit parity (`E2E_KIT_PARITY_ENGINE_MAX_PIXELS`). That's a harness limit, not an engine result; W5's harness should pass pixels without base64.
- **Image placeholders from the harness were rerun, not counted.** The debug renderer kit parity draws through (`engine-debug.ts`) uploads every image of a frame's page and never releases one. Over a whole run, its images pass the engine's 256 MiB and later images draw as the loading checkerboard. The live editor drops images the page no longer uses (`EngineView.#dropUnused`), so frames on pages with images were redrawn with a fresh editor per kit page (`E2E_KIT_PARITY_RELOAD_PER_PAGE`). Only iOS Product Bezels, whose own images need 821 MiB, still fails, and that one is real (G19).

## How to reproduce

Everything ran from `970efc07` unless it says otherwise. GPU numbers come from Modal T4 containers (NVIDIA Tesla T4, Chromium 158), launched with `t3-vault run modal-token-id -- t3-vault run modal-token-secret -- pnpm gpu-bench …`.

- **Benches, iOS kit** (`--file` the converted kit, cache `aff55ac3997b7282`): `--ref 970efc07 --modes gpu --env BENCH_RENDERER=engine|canvas --env BENCH_PAGE_COUNT=2 --env BENCH_ONLY=file -- bench/file.spec.ts bench/interactions.spec.ts`. The engine runs on WebGPU used `--modes webgpu --env BENCH_ENGINE_PRESENT=readback`.
- **Benches, shadcn kit** (cache `172d037e7be04faf`): the same options. The profiled run added `--profile --env BENCH_PAGES=Combobox` on `bench/file.spec.ts`.
- **Prototype runs:** the same, with `--worktree` on a checkout of `970efc07` carrying the two `AUDIT PROTOTYPE` changes above.
- **Kit parity through the engine:** `apps/web/e2e/kit-parity.spec.ts` on the branch `t3/kit-parity-engine-mode-audit`, with these new environment variables:
  - `E2E_KIT_PARITY_ENGINE=cpu,webgl` draws each frame with the engine on those backends as well, writes `pages.json` (the page census) and `facts.ndjson` (per frame: drawn or refused, the unsupported features, timings);
  - `E2E_KIT_PARITY_INLINE=1` scores every frame in the page with `compare.ts` and writes `scores.ndjson`, keeping pictures only for frames the engine draws worse;
  - `E2E_KIT_PARITY_FROM_BENCH=1` takes the kit, its `sample.json` and `figma/` from `BENCH_FILE`, so the GPU bench can run it: `pnpm gpu-bench --worktree <checkout> --file <folder with meta.json, nodes.ndjson, images/, sample.json, figma/> --modes gpu --timeout 300 --env E2E_KIT_PARITY_FROM_BENCH=1 --env E2E_KIT_PARITY_INLINE=1 --env E2E_KIT_PARITY_ENGINE=cpu,webgl --env E2E_KIT_PARITY_ALLOW_MISSING_FONTS=1 --env E2E_KIT_PARITY_RUN=/out/kitrun --env E2E_KIT_PARITY_STAGE=render -- e2e/kit-parity.spec.ts`.
- **Figma parity on the T4:** `pnpm gpu-bench --ref 970efc07 --modes gpu,webgpu --env ENGINE_PARITY_BACKENDS=auto -- parity/engine.spec.ts`.
- **Saved glyph coverage:** for each text layer of a page in `nodes.ndjson`, whether `glyphLayout` exists and its `key` equals `glyphKey(props)` (`@drawpane/model`).
- **Raw results** (private kit data, outside the repository): the audit's run folders on the development VM, `~/audit-0040/gpu/*`.

