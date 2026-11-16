# 0025. Figma .fig import, read with Open Pencil and converted like the API's files

- Status: accepted
- Date: 2026-11-16
- Deciders: Ziyang (lead maintainer)

## Context

Figma import by link (decision 0014) needs a personal access token, spends one of a free plan's few monthly reads of a file, and gets only what the REST API returns (glass without its settings, for one). Figma's desktop and web apps also save a whole file locally (**File → Save local copy**), as a `.fig`: a zip holding `canvas.fig` (Figma's `fig-kiwi` container: a binary schema and a message of node records, each compressed), a thumbnail, `meta.json` and the images; older files are the bare container, with images in the message's blobs. The format is undocumented, but its schema travels inside every file and has only grown since the oldest files we've seen (version 4 to 106, no field changing its id or type), and Penpot and Open Pencil read it.

Instances are the hard part: a `.fig` saves an instance without its layers. They come from its component, with the instance's overrides, component properties, swaps and Figma's saved sizes applied. Open Pencil (MIT) has the most complete open implementation of that, published as packages.

## Decision

1. **Read `.fig` files like Penpot and Open Pencil do,** with Open Pencil's published packages `@open-pencil/fig`, `@open-pencil/kiwi` and `@open-pencil/scene-graph`, pinned at exactly 0.16.0. They're MIT, browser-safe (no Node APIs, no `eval`, so the page's CSP holds) and pure JavaScript (zstd by `fzstd`). Their licences, and kiwi's notice crediting Evan Wallace's Kiwi runtime, are in `packages/fig/NOTICE`.
2. **One converter for both ways in.** `@drawpane/fig` (MPL-2.0) reads a file with Open Pencil (`parseFigBuffer`, then `materializeDocument`) and maps the scene graph to the file Figma's REST API returns (`GET /v1/files/:key?geometry=paths`). `@drawpane/figma`'s `convertFile` converts it unchanged, so a `.fig` imports as the same file read by link would, with the same notes and the same parity tests.
   - **Ids are REST's.** A layer saved in the file keeps its guid (`12:34`); a layer an instance builds gets `I<instance>;<component layer>`, nested for instances in instances, so the converter links it to the main's layer it copies.
   - **What Open Pencil 0.16 doesn't keep comes from the records:** kinds it doesn't know (it makes them rectangles; widgets and slices stay what they are, and the converter skips them as it does from the API), image adjustments, noise and texture settings, progressive blurs, line heights in percent, font style names, page backgrounds, and images in older files' blobs (found by their SHA-1, which is their ref).
   - **Styles resolve before Open Pencil reads the records.** Open Pencil applies a style a layer links with the newer `styleIdFor…` fields, but not the older `inherit…StyleID` links, nor styles on stretches of text. Older files saved stale copies under those (black text whose style is grey), so the older links are given the newer field and runs get their styles' values first.
   - **Variables come in as the values the file saved.** Component properties are applied to each copy; the converter notes that they were.
3. **In a Worker.** The Import dialog's Figma tab takes a `.fig` dropped or chosen (as well as a link), and a `.fig` dropped anywhere on the dashboard imports too. A module Worker (`apps/web/src/dashboard/fig.worker.ts`, allowed by `worker-src 'self'`) reads, adapts and converts; the page uploads the images (as the link import does) between reading and converting, and saves. The row shows reading, building pages (one by one for large files), uploading images, converting and saving. A failed import removes the file it made.
4. **Large files.** A file of more than 20,000 records is built a page at a time (`materializeDocument` with `pageIds`), each page's graph let go once it's adapted; smaller files are quicker built at once, since each page costs Open Pencil another index of the whole file. Both give the same file (a test holds them to it). Files over 400 MB, or over 250,000 records, are refused with a plain message before building; so is a file whose layers, once its instances are filled in, pass the 200,000 one import can save. FigJam boards and Slides decks (their containers say `fig-jam.` and `fig-deck`) are refused as such.

## Consequences

- Measured on five public files, in Node 26 on this VM (`FIG_FILES=<folder> pnpm --filter @drawpane/fig exec vitest run test/fig-compat.test.ts`, one file per run for its memory). Every one converts, and every converted file passes the server's checks.

  | File | Size | Container | Pages | Layers (converted) | Linked copies | Images | Read | Peak memory |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | Pattern design system | 0.2 MB | zip, v95 | 10 | 335 | 0 | 0 | 0.3 s | 181 MB |
  | Tailwind CSS UI (ecklf) | 1.1 MB | raw, v4 | 1 | 2,070 | 174 layers in 194 instances | 3 | 1.0 s | 249 MB |
  | Google MediaNova | 1.6 MB | zip, v52 | 2 | 564 | 72 layers in 23 instances | 12 | 0.4 s | 193 MB |
  | Open Peeps | 6.4 MB | zip, v101 | 2 | 7,167 (22,780 before booleans became paths) | 2,866 layers in 2,832 instances | 0 | 6.1 s | 981 MB |
  | Flowbite (Tailwind) | 52 MB | raw, v4 | 12 | 3,270 | 188 layers in 53 instances | 123 | 2.6 s | 445 MB |

  Peak memory is the whole test process's (about 170 MB of it is the test runner). Open Peeps' is mostly Open Pencil's scene graph of 22,780 layers. Its 401 copies whose layers differ from their components' (swapped nested instances) are detached on import, as they would be by link.
- The Worker adds 157 KB gzipped, loaded only when someone imports a `.fig`.
- Open Pencil is 0.x and its shapes change between minors (line heights, image transforms). The pin is exact, and the samples above run in CI as fixtures (the three openly licensed ones) and by hand (the rest); moving the pin means running them again. Two things worth proposing upstream: resolving `inherit…StyleID` links and styles in text runs, and keeping the fields listed in decision 2.
- A copy inside a swapped nested instance can't be linked to its main's layer, by link or by file: REST's ids name the swapped-in component's layer, which the main's own copy doesn't have. Those copies keep their look, detached.
- Not compared yet: a render of each file's first page against the thumbnail it carries. The parity suite (decision 0013) covers the converter; a corpus of `.fig` renders would cover the reading.
