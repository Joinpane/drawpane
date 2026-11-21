# Kit parity

How close a real Figma file comes out in Drawpane, frame by frame: Figma's own render and layout of a sample of the file's frames, against the same file imported into Drawpane (the `.fig` read and converted exactly as the dashboard's import does it), drawn by Drawpane's canvas renderer. It measures what a hill-climb needs: one score per frame, a scoreboard, and a report that shows the worst frames first with their layout deltas. Fixes are then judged by running it again.

The parity suites in `tools/figma-parity` hold small, synthetic scenes to thresholds in CI. This works on any real file, too large and usually too private to commit, so it runs by hand and keeps its output outside the repo (decision 0030).

## What it needs

- The file as a `.fig` (Figma: **File → Save local copy**) and its Figma file key.
- A Figma account with **edit** access to that file, in a browser session (`FIGMA_EMAIL` or `FIGMA_LOGIN_USERNAME`, and `FIGMA_PASSWORD`; the session is kept in `FIGMA_PROFILE`, by default `/tmp/figma-parity-profile`). Figma runs no plugins in a file you can only view, and the plugin API is how Figma's renders and layout are read. Nothing is written to the file: see "Read only" below. The REST image API is not used; it's rationed.
- `pnpm build` done (the Drawpane side runs the built app in a local Worker).
- An output folder outside the repo, or in a gitignored one, when the file isn't yours to publish.

## Running it

```sh
OUT=/path/outside/the/repo/my-kit
node tools/kit-parity/kit-parity.mjs sample   --fig kit.fig --out $OUT     # pick the frames
node tools/kit-parity/kit-parity.mjs figma    --key <key>   --out $OUT     # Figma's renders and trees
node tools/kit-parity/kit-parity.mjs drawpane --fig kit.fig --out $OUT --port 8951
node tools/kit-parity/kit-parity.mjs compare  --out $OUT --port 8951
# or all four in turn:
node tools/kit-parity/kit-parity.mjs all --fig kit.fig --key <key> --out $OUT --port 8951
```

For a large file give Node room: `node --max-old-space-size=12000 tools/kit-parity/kit-parity.mjs …`.

### The steps

1. **sample** (`src/sample.ts`) reads the `.fig` and picks about 400 units (`--count`): each page's top-level frames, with sections opened up and anything too large to export at 2× replaced by its children; component sets and their components; then the frames built from the most instances, as screens. Every page gets an even share, picked at even intervals in Figma's order, so the same file always gives the same sample. It's saved by Figma node id in `$OUT/sample.json`.
2. **figma** (`src/figma-truth.mjs`) opens the file in a headless browser, signed in, and for each sampled frame saves Figma's PNG at 2× (`exportAsync`, the node's own box) and its node tree as Figma lays it out: id, name, type, visibility, absolute box and render bounds, auto layout and sizing, and for text the fonts and whether Figma has them. It's resumable (saved frames are skipped) and slow on purpose: one frame at a time, a new session when one fails. Each frame's name and page are checked against the sample, so ids that name another node in Figma are caught.
3. **drawpane** converts the `.fig` (`src/convert.ts`: `openFig`, `read`, images as the server stores them, `convertFile`, `pinInstances`) into `$OUT/drawpane-cache/<key>/`, cached by the file's bytes and the source of the packages conversion runs through (a large kit takes minutes), then runs the opt-in spec `apps/web/e2e/kit-parity.spec.ts`. It imports the converted nodes into a fresh local instance on `--port` the way the dashboard saves an import, opens the file in the editor, and for each frame loads and checks its fonts, reads its layout (`scene.bounds` of every layer) and draws it at 2× over the page rect Figma exported (`drawpaneParity` on the debug handle). Output goes to `$OUT/runs/<timestamp>/drawpane/`. Missing fonts fail the step, since they'd swamp every other difference (unless `--allow-missing-fonts`, see "Another file").
4. **compare** scores each frame in the browser, both sides over white: the mean difference over RGB (0 to 255) and its 99th percentile, as `e2e/parity/pixels.ts` measures them, and a heat map. Layout is compared layer by layer, matched by Figma id (`src/layout-diff.ts`): moves relative to the parent and size changes past 0.5 px, text boxes, visibility, layers missing on either side (boolean operands, which import as one path, are counted apart). It writes `scoreboard.json` and `report.html` into the run's folder (`--run` picks a run; the latest by default).

## Judging a fix

Run `drawpane` on the fix (a new run folder, with `--run`), then `compare --against <baseline run>/scoreboard.json`. It prints the median, p90 and total before and after and how many frames got better or worse, writes the lists to the run's `against.json` (worst regressions first), and shows each frame's change in the report. A fix should make its frames better and none worse. With `--same` it fails instead unless nothing changed at all: that's how two runs on the same code are checked to score the same.

The conversion cache key covers the packages conversion runs through, `pnpm-lock.yaml` and `patches/`, so a fix there, or a patch to Open Pencil, converts again; nothing else does.

The `drawpane` step holds a lock in the temp folder while it converts and draws: a large kit takes several GB, and two or three at once run a machine out of memory. A second run waits and says whose run it's waiting for. `KIT_PARITY_NO_LOCK=1` skips it.

## Relayout stability

```sh
node --max-old-space-size=12000 tools/kit-parity/kit-parity.mjs relayout --fig kit.fig --out $OUT [--name <label>]
node --max-old-space-size=12000 tools/kit-parity/kit-parity.mjs relayout --nodes <nodes.ndjson> --out $OUT [--name <label>]
```

Runs the editor's layout and constraint fixups in a fresh `Doc` with the kit's variables, styles, and inherited modes. It uses every imported layer as a layout target and uses the text sizes the import saved. It compares the resulting parent-relative x, y, width, and height with the imported boxes. A layer counts once when any value changes by more than 0.5 px. A group's box comes from its children.

`relayout[-<label>].json` includes kit totals, counts for each frame subtree, and examples grouped by observable causes. Totals and causes count layers visible after relayout. A separate count shows which visible boxes already differed when the editor resolved bindings, before running layout. Hidden box changes are reported separately and include descendants of hidden layers. Nested frame counts overlap, so use the kit totals to compare whole files.

## What edits cost

```sh
node --max-old-space-size=14000 tools/kit-parity/kit-parity.mjs edits --nodes <nodes.ndjson> --pages "Dropdown Menu,Combobox" --out $OUT [--only drag,nudge,fill,type] [--name <label>]
```

Opens the kit in a headless `Editor` with copies stored compact, as a room stores them, and builds every copy as the browser does when a file opens. Then, on each named page's busiest board (picked as `bench/interactions.spec.ts` picks it), it makes the interaction bench's edits through `Editor` and `Interaction`: a 60-step drag and its drop, nudges and their undos, a fill changed in one gesture, and typing. It times each step. No renderer and no React run, so this is the editor's own share: copies, variables, layout, history and sync's bookkeeping. Compare a change with main on the same machine, one after the other, twice: timings swing with the machine's load. Text is measured by a fixed-width stand-in, so typing costs what layout and the model cost, not what a browser's text measuring costs.

`edits[-<label>].json` has every step's time. The table it prints has the median, p95 and worst step of each edit.

## Copies that stay copies

```sh
node --max-old-space-size=12000 tools/kit-parity/kit-parity.mjs detach --fig kit.fig --out $OUT --name <label>
node --max-old-space-size=12000 tools/kit-parity/kit-parity.mjs detach --nodes <lines.json> --out $OUT --name <label>
```

How many of the file's instances the import keeps linked to their mains, and why it unlinks the rest (`src/detach.ts`). With `--fig` it converts as the `drawpane` step does (cached), keeping what the converter gave before `pinInstances` too (`unpinned.ndjson`, with `KIT_PARITY_KEEP_UNPINNED=1`); `--nodes` takes nodes as lines of JSON instead, a stored snapshot's included. Two stages unlink copies, and both are measured:

1. `pinInstances`, at import: a copy that syncing with its main would change in structure (a layer created, deleted or moved) is unlinked, with what's inside it. Each is grouped by the first such change and what it's about (measured when `unpinned.ndjson` is next to the nodes).
2. `compactByInstance`, before upload into a file that stores compact copies (decision 0029): an instance whose compact form wouldn't rebuild it exactly is detached, and the reason given. "No copy of X" ones are grouped by what the layer and X are.

It prints the counts and the commonest reasons, and writes everything to `$OUT/detach-<label>.json`. It holds the machine's lock, as `drawpane` does.

## What the file uses, and what comes across

```sh
node --max-old-space-size=14000 tools/kit-parity/kit-parity.mjs coverage --fig kit.fig --out $OUT [--name <label>]
```

A census of every Figma feature the file uses, each judged on the converted output (`src/coverage.ts`). It reads the `.fig`'s raw records (Open Pencil's parsed `NodeChange`s, before anything resolves) and lists, with counts:

- **node fields:** kinds of layers, effects by type (and whether a shadow shows behind transparent areas), paints by type, blend mode and image scale mode, strokes (alignment, dashes, per-side widths, caps and joins), corners (independent radii, smoothing), constraints, auto layout (direction, wrap, min and max sizes, absolute children, baseline alignment, spacing modes, strokes in layout), grid layout, text (fonts by family and style, case, decorations, OpenType, variable axes, truncation, lists, styled runs, links, vertical trim), vectors, masks and booleans;
- **component properties:** definitions by type (variant, boolean, text, instance swap, slot), the layers that reference them by field, and the instances that set them;
- **variables:** collections and their modes, variables by type, aliases, expressions, scopes, code syntax, hidden ones, and frames that set a mode;
- **bound variables** by field: on layers, in instances' overrides, in stretches of text, on paints and on effects;
- **styles** by type, whether they're bound to variables, and the layers using them;
- **prototype** interactions by trigger and action, scrolling, export settings, guides, plugin data and dev mode status.

Each use is a hit: the layer to look at in the output (a saved layer's Figma id, or the id an instance gives a layer it overrides). The step converts the file as `drawpane` does (cached, under the machine's lock), finds each hit's layer by its Drawpane id and compares: **faithful** when the output carries the feature (the same effect with the same values, a binding, a collection with the same modes), **approximate** when it carries the look but not the feature (a bound value baked, a boolean made a path, a property applied to each copy and gone as a property), **lost** when neither or the layer is missing. Impact is layers affected (a component's layer counts once for itself and once per copy) × importance (visual 3, editing 2, metadata 1) × the share not faithful (lost whole, approximate half). It also compares the overrides each copy lists with the ones Figma saved for that layer.

It writes `$OUT/coverage[-<label>].json` (every feature, with up to ten failing ids each) and `.md` (gaps ranked by impact, the override comparison, what came across, and how each gap was judged). `--nodes <lines.json>` judges a conversion already made instead.

```sh
node tools/kit-parity/kit-parity.mjs text-widths --out $OUT [--run <dir>] [--only id,id] [--name <label>]
```

Text widths per font, from a run (`src/text-widths.ts`): for auto-width text, Figma's box against the width Drawpane measures for the same characters (recorded by the `drawpane` step as each text layer's `text.width`, its widest line unwrapped), and the text layers Drawpane draws in another face than Figma's. A font Drawpane measures wider cuts or wraps the text of hug-sized buttons and chips. Writes `text-widths[-<label>].json` and `.md` into the run.

## Another file

Every file gets its own output folder (`--out`), so files never mix: the sample, Figma's truth, the conversion cache and the runs all live there. For a new file:

1. Save a local copy from Figma (**File → Save local copy**) and note its file key. The Figma account needs edit access to that file (or to your own duplicate of it, which has the same node ids).
2. `sample`, then `figma` (resumable, about 7 s a frame on a VM without a GPU, faster for small frames), then `drawpane` and `compare`. That run is the file's baseline.
3. Check `figma/failed.json` (frames Figma couldn't export) and the compare log's id check (`idsMismatched` must be 0: the sample's ids must name the same nodes in Figma).
4. Fonts: a run fails when Drawpane can't draw a face the file uses. Google fonts load by themselves; anything else needs a team font upload first. When that can't be done yet, `--allow-missing-fonts` (on `drawpane` and `compare`) lists the missing faces instead (run.json, each frame's `drawpaneMissingFonts`), and the frames score with their text in a fallback face: count those frames apart when ranking causes.

## Read only

The Figma file is never edited. The session types only into Figma's quick actions box once it has focus (so no keys land on the canvas as shortcuts), runs a plugin only to get the plugin API on the page, and reads: node properties, styled text segments, and exports. Every page visited is watched for changes made from the session (`nodechange`); one stops the run. Shared plugin data on the document is compared at the end, and the session has no plugin id, so it can't write private plugin data.

## Output

```
$OUT/
  sample.json
  coverage.json, coverage.md   what the file uses and what comes across
  figma/<id>.png, <id>.json, failed.json
  drawpane-cache/<key>/nodes.ndjson, images/, meta.json
  runs/<timestamp>/
    run.json            what was drawn, git head, timings, missing fonts
    drawpane/<id>.png, <id>.json
    heat/<id>.png
    scoreboard.json     per-frame scores and layout deltas, and a summary
    against.json        with --against: before and after, what got better and worse
    report.html         worst first: Figma, Drawpane and the difference side by side
    text-widths.json    with text-widths: Figma's text widths against Drawpane's, per font
```

Ids in file names spell `:` as `-` and `;` as `_`.
