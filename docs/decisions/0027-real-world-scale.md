# 0027. Real-world scale: files the size of real UI kits

- Status: accepted
- Date: 2026-11-16
- Deciders: Ziyang (lead maintainer)

## Context

Drawpane was built against a 10,000-layer file (the PRD's canvas target). Real design systems are far larger. The shadcn/ui Pro kit for Figma, a typical paid kit, has about 101,000 saved layers and 88 pages; filled in, its component copies come to about 503,000 layers and 225 MB of node JSON. Kits of a million layers exist. A file that size couldn't come in at all (decision 0025 had to offer a page picker capped at about 45,000 layers), and nothing had been measured past 10,000.

Three ceilings stand in the way, from the shallowest:

1. **Server paths that gather a whole file.** The room keeps a file's nodes in SQLite and streams them to clients, but importing, saving and restoring versions, creating, diffing and merging branches, publishing a library and reading a file over MCP each held every node in memory at once, or sent them in one RPC call. A Durable Object has 128 MB, and an RPC argument is capped at 32 MiB.
2. **Drawing.** The renderer walks a page's whole tree every frame to cull what's off screen, and redraws everything visible on a full repaint. It already redraws only the strip a pan uncovers, but full repaints (zooming, the occasional pan frame) grow with the page.
3. **Copies stored in full.** An instance is a frame whose every layer is a real, stored node (`mirrors`-linked to its main's), and an edit to a main writes the change into every copy in the same transaction (decision 0010, `components.ts`). So a file is about five times larger than its saved Figma counterpart, on the wire, in storage and in memory, and editing a main costs as much as the copies it has.

## Decision

**Files of 500,000 layers open, draw, edit and save as a 10,000-layer file does; 1,000,000 is the stretch.** The PRD's targets move to that size (performance table and requirements). The work goes in measured phases, each held to the benchmark below before the next:

| Phase | What | Lifts |
| --- | --- | --- |
| 0 | A benchmark of kit-shaped files of any size, and this record | Knowing where each limit is |
| 1 | No server path holds a whole file or sends it in one message: imports in parts, versions and branches streamed (decision 0026) | Importing, saving and branching a 500,000-layer file |
| 2 | Drawing that doesn't grow with the page: a spatial index instead of walking the tree, cached tiles and levels of detail for zoomed-out views, no full repaint spikes | Smooth panning and zooming at any size |
| 4 | Copies stored as their main plus what's overridden, presented to the editor as ordinary layers; editing a main changes only the main | 5x less to store, send and hold; a main edit costs the same at 10 copies or 10,000 |
| 3 | Opening a file loads the page shown and the components it uses; other pages load when visited | Opening time and memory in proportion to a page, not the file |

Phase 4 comes before phase 3. A client that has loaded one page can't write a main edit into copies on pages it hasn't loaded, so page loading needs copies that follow their mains without being written to; with copies stored in full it would need the server to fan edits out, which phase 4 makes unnecessary.

**The benchmark** (`apps/web/e2e/bench/scale.spec.ts`, `pnpm --filter @drawpane/web bench -- scale`, sizes in `BENCH_SCALE`) loads a generated kit into the real editor the way opening a file does and measures loading, the JS heap, panning and zooming the largest page, and a fill change on the most used main through the editor's commit. The kit (`@drawpane/corpus`) is shaped like a real one: 160 icons; buttons, inputs, badges, avatars and checkboxes made of icon copies; cards, table rows, nav items and dialogs made of those; and pages of screens made of copies, all in auto layout. Copies are made by the editor's own `instantiateOps` and laid out by its layout engine. Its layers weigh about 340 bytes of JSON each, against 410 to 510 for the shadcn/ui kit converted.

## Consequences

Baseline, before any phase, on this VM (Chromium without a GPU, so frame times are slower than a laptop's; compare runs on one machine):

| | 10,000 layers | 100,000 | 500,000 |
| --- | --- | --- | --- |
| Node JSON | 3 MB | 32 MB | 162 MB |
| Copies | 3,324 | 34,566 | 173,252 |
| Load (one document reset) | 14 ms | 228 ms | 1,016 ms |
| First frame of the largest page | 319 ms | 1,075 ms | 1,595 ms |
| JS heap for the file | 6 MB | 42 MB | 169 MB |
| Pan, whole page: content p95 / worst | 6.8 / 10.6 ms | 45.7 / 67.1 ms | 69.2 / 230.6 ms |
| Pan at 25%: content p95 | 17.7 ms | 18.2 ms | 24.3 ms |
| Zoom, whole page: worst frame | 140 ms | 452 ms | 480 ms |
| Edit the most used main (copies) | 277 ms (254) | 1,820 ms (2,607) | 7,031 ms (13,174) |

- Memory is the least of it: about 340 bytes of heap a layer, so a whole 500,000-layer file fits a tab. Full repaints and main edits are what grow, and the main edit grows with the copies a main has, which is the shape of the model, not a slow path.
- Targets for 500,000 layers, on the PRD's reference laptop: panning and zooming p95 under 16 ms and no frame over 50 ms; the largest page interactive within 3 s of opening (warm cache); an edit to any main drawn within 100 ms whatever its copies; the file importable as one file. Each phase's pull request reports the benchmark before and after.
- Not measured yet: opening from the server end to end at these sizes (it needs phase 1's import), collaboration with several people on a large file, and a 1,000,000-layer sweep.
