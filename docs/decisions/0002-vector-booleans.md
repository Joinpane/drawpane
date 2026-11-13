# 0002. Boolean operations use Skia PathOps (PathKit), loaded on demand

- Status: proposed (accepted when merged)
- Date: 2026-11-13
- Deciders: Ziyang (lead maintainer)

## Context

Union, subtract, intersect and exclude turn two or more shapes into one path. They must keep curves as curves (a union of two circles is still four arcs, not a 200-point polygon), respect each operand's fill rule, and survive the hard cases designers hit every day: shared edges, tangent curves, a shape exactly on top of another. The editor's initial bundle should stay small, since most sessions never run a boolean.

We compared three options. Sizes are measured from the published packages.

| | Skia PathOps (`pathkit-wasm` 1.0.0) | `paper` 0.17.0 path booleans | `polygon-clipping` 0.15.7 |
| --- | --- | --- | --- |
| Curves | Kept: cubics, quadratics and conics in, curves out | Kept | Lost: curves are flattened to polygons first |
| Robustness | Part of Skia, the graphics library behind Chrome, Android and Flutter; built to handle coincident and tangent edges | Keeps curves well on common cases; not stress-tested here | Robust for polygons |
| Fill rules | Nonzero and even-odd per operand | Yes | Even-odd style only |
| Size | 32.6 KB JS + 324 KB WASM (11.4 + 138 KB gzip) | 312 KB JS for `paper-core` (105 KB gzip) | 29 KB JS (9.3 KB gzip) |
| Runs in Node and Workers | Yes (pass the WASM bytes) | Yes, with a headless PaperScope | Yes |
| License | BSD-3-Clause | MIT | MIT |

## Decision

Use Skia PathOps through PathKit, behind a small engine interface:

- `packages/editor/src/vector/boolean.ts` defines `BooleanEngine.combine(operands, op)`. Operands are SVG path data in one coordinate space, each with its fill rule.
- `packages/editor/src/vector/pathkit.ts` adapts PathKit to it. `loadPathKitEngine()` imports `pathkit-wasm` dynamically, so bundlers split it into its own chunk.
- The editor loads the engine the first time a boolean runs (`Editor.booleanEngine()`), and retries if loading failed. The web app passes the WASM's asset URL (`apps/web/src/editor/boolean-engine.ts`). Opening a file downloads none of it.
- Everything around the engine is ours and engine-independent: converting rectangles, ellipses, lines and frames to paths, moving every operand into the result's parent space, the z-position, the style taken from the bottom layer, and fitting the result's box. Tests use a fake engine for that logic, plus the real WASM in Node and in a Playwright test.

## Consequences

Good:

- The best quality available, with curves kept. The result is still an editable path.
- No cost until it's used: the editor chunk doesn't grow by the engine (verified: the Emscripten loader lives only in its own chunk).
- The same engine runs in Node and Workers, so agents and the FileRoom can run booleans later with identical results.
- The interface makes the engine replaceable, for example with a Rust PathOps port compiled to WASM if we ever need smaller or faster.

Costs and risks:

- About 150 KB gzip on the first boolean in a session, roughly 45 KB more than paper.js. Both would be lazy-loaded, and it's cached after the first use.
- `pathkit-wasm` was last published in 2025 at 1.0.0. If it goes stale, we can build PathKit from the Skia tree (`modules/pathkit`) ourselves, or move to CanvasKit's path API.
- PathKit works in 32-bit floats. That's ample for design coordinates, and results are rounded to 3 decimals when serialized.
- Results are destructive (one path, not a live boolean group). Live booleans that stay editable are a separate, later decision.
