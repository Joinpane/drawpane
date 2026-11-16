# 0014. Figma import, through Figma's API, measured against Figma

- Status: accepted
- Date: 2026-11-15
- Deciders: Ziyang (lead maintainer)

## Context

Most people who'd move to Drawpane have their work in Figma. Penpot import exists (`@drawpane/penpot`); Figma import didn't. Figma offers two ways in: its REST API (official and documented; one file read per import, but free plans allow only a few reads of a file a month), and the `.fig` file its desktop app saves (undocumented, its schema versioned inside each file, with more in it than the API gives). Research is in the pull request that added this.

## Decision

1. **The REST API first.** `@drawpane/figma` converts a file as `GET /v1/files/:key?geometry=paths` returns it. The dashboard's Import dialog takes the file's link and a personal access token, and everything happens in the browser: the token goes to Figma only (kept for the tab, or on the device when asked), the file and its images come straight from Figma, and the result goes into a new file through the same import endpoint Penpot import uses. Nothing retries on its own, to spend as few of a free plan's reads as possible.
   - A file too large for Figma to send at once (it answers 400 "Request too large" after about a minute) is read in parts (`apps/web/src/dashboard/figma-read.ts`): an outline of its pages and their top-level layers (`?depth=2`), then each page through `/v1/files/:key/nodes`, a page still too large in halves of its top-level layers, down to single layers. The parts are put back together as the one response Figma would have sent, so the converter doesn't know the difference. Each part is another read against Figma's limits; a wait Figma asks for of up to 90 seconds is sat out, a longer one ends the import with when to try again.
   - A reply is read as it arrives and let go past 384 MB. A browser can't hold a string much longer than 512 MB, so Chrome's `response.json()` on a larger reply fails as "Unexpected end of JSON input", which is what the shadcn/ui Pro kit got. A reply that large is treated like Figma's own "Request too large", and the file is read in parts.
   - The layers read are counted as they come, and the read stops, before the rest is fetched against Figma's limits, once they pass the 200,000 one import can save. A file under that but over the 24 MB one import sends (decision 0025) is refused before uploading, with its size. Either way the import suggests the file's `.fig`, whose pages can be chosen (decision 0025).
   - Any other refusal shows Figma's own reason.
2. **What carries over, and how.**
   - Frames, components (and variant sets), instances, groups, rectangles, ellipses, lines and text stay those kinds. Instances keep their link to a main component in the file: each layer mirrors the main's layer its id names, and what it changes is worked out by comparing them, so editing the main later leaves the instance's changes alone. Copies of library components are detached.
   - Stars, polygons, arcs, vectors and booleans become paths from Figma's own geometry (open vectors from its vector network).
   - Paints (solid, gradients with Figma's handles, images with crops), strokes (with per-side weights on boxes, decision 0015; merged to the widest elsewhere), effects (shadows, blurs, noise, texture; glass with default settings, since the API doesn't give them), opacity, blending, masks (by outline, alpha or luminance, decision 0016), auto layout (flow, wrap, gaps, padding, alignment, sizing, absolute children), constraints, layout grids, and text (base style, per-character runs, and lists, decision 0017).
   - Transforms are worked out down the tree and expressed in each layer's frame, so rotation and flips land exactly; which space a group's children are relative to is checked against Figma's own bounding boxes.
   - Figma ids map to Drawpane ids one to one, so the same file always imports to the same ids (re-importing to pick up changes can match layers up).
   - What can't come across exactly is listed after the import ("2 boolean groups became paths").
3. **Measured.** The parity scenes (decision 0013) exist as a Figma file; its API response is a fixture, and `apps/web/e2e/parity/import.spec.ts` imports it, draws every cell and compares it with Figma's renders. The import matches Figma as closely as Drawpane's own drawing of the same scenes does (blurs 0.86, fills 0.18, shadows 0.27, strokes 0.03 of 255), and `import-thresholds.json` keeps it there.
4. **Shared pieces** (affines, boxes in a frame's space, SVG path data, import notes) moved to `@drawpane/import-kit`, which the Penpot importer now uses too.

## Consequences

- `.fig` files import too, read with Open Pencil and converted by the same converter: [decision 0025](0025-fig-import.md). Some of what the API leaves out (glass settings, variables on non-Enterprise plans, font axes, guides) is in them, for later.
- Real files bring what the parity scenes don't: text in many fonts, deep component trees, images. The fidelity suite grows with a corpus of such files (their API responses and renders cached, as here), and the gaps it finds rank the model changes worth making first (leading trim, per-paragraph alignment; per-side strokes, alpha masks, lists and per-range line height came first, decisions 0015 to 0018).
