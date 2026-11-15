# 0024: Imported files open as they were made

- Status: accepted
- Date: 2026-11-15

## Context

Kits added from the store (decision 0022) looked broken once opened. That was true of most of them, though the converter placed nearly every layer where Penpot had it. A sweep over the 91 importable kits showed where the difference came from. Each kit was converted, opened in an `Editor` with the real text measurer and the kits' Google fonts, and every layer's corners were compared with the corners Penpot records (`packages/penpot/test/kits-compat.test.ts`).

- Converted, before anyone opened it: 4,631 of 462,922 layers off by more than 1 px.
- Opened, once its fonts had loaded: 135,320 layers off, 100,549 of them by more than 10 px, and two files whose opening threw.

Opening a file changed it in three ways:

1. **Every text was measured again** when its web font arrived (`Editor.refitText`). Any difference from the stored size, even 0.01 px, laid out every auto layout frame around it again. Penpot keeps its layouts as last computed, and a file's stored layout is often stale (a text edited without its frame laid out again). So Drawpane "corrected" layouts that Penpot shows as stored.
2. **Copies were synced to their mains.** Penpot doesn't record as overrides many ways a copy differs from its main (a resized copy, layers its constraints moved). Drawpane's sync, with no override, snapped them back.
3. **Copies whose structure differs from their main's**, which Penpot allows, were rebuilt from the main: a layer the main lacks, layers in another order, a reference to a shape the main no longer has. Sync deleted and recreated their layers. In nested copies it failed halfway ("Node … doesn't exist").

The converter also had four translation errors:

- Penpot's `stretch` alignment never resizes (only Fill does), while Drawpane's does. Text stretched to zero width wrapped a letter per line, and frames grew tens of thousands of pixels tall.
- Grid items Penpot auto-placed were left to Drawpane's own auto placement, which follows layer order.
- A copy nested in a copy wasn't linked to the outer main.
- An id Penpot repeats across pages (a duplicated page keeps its ids) named two layers.

## Decision

- **Opening a file doesn't change it.** `refitText` re-measures only text this editor measured, which is the only text that can have been measured with a fallback font. Text as the file has it keeps the size it was saved with, whoever measured it. Editing a text measures it, as before.
- **Imports pin their copies** (`pinInstances` in `@drawpane/editor`, used by the Penpot and Figma imports and so by the kit store).
  - Each property syncing would change is marked overridden, so the copy keeps it and still follows its main's other changes.
  - A copy whose layers can't be matched to its main's is detached. It keeps every layer, without the link, and the import summary says how many.
- **The converter translates Penpot's layout as Penpot computes it** (from Penpot's `flex_layout` and `grid_layout` sources).
  - `stretch` places items at the start at their own size, and an item's own `stretch` defers to its parent.
  - Every grid item keeps the cell Penpot put it in.
- **The converter links a nested copy** to the outer main, as Drawpane's nested instances are.
- **The converter makes repeated ids unique.**
  - The page with a component's main keeps the original ids, otherwise the first page does.
  - On other pages, a repeated id gets a deterministic new one, and that page's parents, children, grid cells, interactions, flows and guides follow.
  - `ConvertedFile.idOf` maps a page's Penpot shape to its layer.

## Consequences

- The same sweep afterwards:
  - Converted: 2,235 layers off by more than 1 px.
  - Opened: the same 2,235, with no failures and no layers lost.
  - The rest are Penpot's own stale data, mostly a group's stored box or a path's stored box that its path data disagrees with. Drawpane draws both from their contents, as Penpot does.
- Layers not converted at all (6,296) are inside boolean groups, which become one path, and Penpot's raw SVG elements (`svg-raw`, about 630), which aren't imported yet.
- Laid out again by Drawpane (the harness's `relayout` phase, as if every auto layout frame were edited), 31,516 layers move. Most of that is stale Penpot layout being computed afresh, as Penpot itself would on an edit. Auto layout margins, which Drawpane doesn't have, account for the rest. Supporting margins is future work.
- A file saved by a client whose font never loaded keeps that text's size until someone edits it. Before, any editor opening it re-measured it.
- Detached copies no longer follow their component. The summary says so, and they look as they did.
- Run the sweep with `PENPOT_KITS=<folder of .penpot files> PENPOT_PHASE=static|open|relayout pnpm --filter @drawpane/penpot exec vitest run test/kits-compat.test.ts`. It writes a report and every mismatch to the folder.
