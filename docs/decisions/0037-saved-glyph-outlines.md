# 0037. Saved glyph outlines: text whose font isn't here, drawn as Figma laid it out

- Status: accepted
- Date: 2026-11-18
- Deciders: Ziyang (lead maintainer)

## Context

Text in a font Drawpane doesn't have draws in a fallback face: narrower or wider, lighter or heavier, and private-use symbols (SF Symbols) as empty boxes (decision 0036, "Missing glyphs"). Font aliases (0036) fix a family the team has under another name, but not one nobody can upload: Apple licenses SF Pro, SF Pro Rounded, SF Compact and SF Compact Rounded, so they can't ship with Drawpane, and the static files a team may have lack the symbols. On a large iOS UI kit, text in fallback faces and symbols as boxes were 40% of the measured difference from Figma (kit parity, decision 0030).

Figma has the same problem and solves it in the file: every text layer in a `.fig` keeps the glyphs Figma laid it out in (`derivedTextData`: each glyph's outline as a path blob, its place on the baseline, its size and first character). That's how Figma shows a font it doesn't have. In the iOS kit, 6,029 of 6,030 text records have them.

## Decision

1. **Keep them on import.** The `.fig` reader turns each text layer's glyphs (as Open Pencil resolves them, copies included) into outlines: SVG path data in thousandths of an em, y up, to a tenth (`commandsToGlyph`), always starting with a move. Glyphs turned or stretched (text on a path, a copy resized out of proportion), and layers with one that can't be read, keep none. REST files have no glyphs, so nothing changes for them.

2. **Store each outline once, in the file.**
   - A new root-level node, `glyphSet`, beside pages, text styles and collections, holds `glyphOutlines`: outline by id, the id 16 hex digits of the outline's hash (`glyphId`), so identical outlines are one entry however many layers, sizes or fonts use them.
   - A text layer holds `glyphLayout`: the ids it uses (`refs`, each once), then for each glyph its index in `refs` and its origin (x, y, in px, to a hundredth), the font size (`size`, or `s` per glyph when sizes differ), each glyph's first character only where it isn't the glyph's own index (`c`), its advance only when the text is underlined or struck through (`a`), the box it was laid out in (`w`, `h`), and `key` (point 3).
   - Bounds: a set holds at most 512 glyphs and 512,000 characters of outlines (a row the size of the largest text rows, decision 0026); a file at most 16,384 distinct glyphs and 8,000,000 characters of outlines (so at most 32 sets), and 2,000,000 placed glyphs; a layer at most 8,192 glyphs. A layer that would pass a bound keeps none and is laid out as usual; the import notes how many (`glyphs-dropped`).
   - **What a room holds.** Sets and layouts are ordinary rows and values: the room reads them a page at a time bounded by characters (decision 0026, `tablePages`), caches at most 8 MB of rows (`STORE_CACHE_BYTES`), and the agent engine's meter counts them as it builds the editor (`BuildBudget`), as for any value. Nothing on the server gathers the table or every layout: the largest single value is a set's 512,000 characters, under a text layer's 200,000 CJK characters (600 KB) that the 128 MB room already bounds. A file at every bound adds about 8 MB of outlines and about 40 MB of layouts (2,000,000 glyphs at about 20 bytes), which the 1,000,000-node, 640 MB import already allows for; real files are far below (see Measured). Compact copies (decision 0029) store a copy's layout only where it differs from its main's.

3. **Drawn only while it's still what the layer looks like.** `key` is the fingerprint (`glyphKey`) of what the glyphs were laid out from: the characters and every property that moves a glyph (family, weight, style, size, line height, letter spacing, alignment, auto-resize, case, decoration, OpenType features, variable axes, vertical trim, paragraph and list spacing, lists, maximum lines), and the runs with their fills taken out, merged into one form. A layer is drawn from its glyphs when:
   - some of its text is set in a face nothing here draws, after aliases (`TextMeasurer.missing`: in the browser, the font registry's view, the same one the missing fonts panel shows; in the Worker, a face without a file); and
   - its fingerprint is its layout's `key`; and
   - its box still fits: text that wraps must have the width it was laid out at; text that doesn't (auto width) keeps its lines whatever its width, placed by its alignment, and a taller or shorter box places them by vertical alignment; and
   - every glyph it names is in the file.

   Otherwise it's laid out as usual. Colours, opacity, effects, position and rotation don't matter: glyphs take the layer's fills and each run's own, as laid-out text does. Baselines fall on whole pixels from the box's top, as Figma draws them (`drawnBaseline`).

4. **Edits.** Editing the text, or anything in the fingerprint, while the font is missing makes the layout stale: it's never drawn again, and the text falls back to today's behaviour (the alias, a fallback face, or the missing-glyph box for symbols). Undoing the edit brings it back. A stale layout stays in the file until it's replaced; nothing has to clear it, since the fingerprint can't match again unless the text and type do. The missing fonts panel says how many layers draw from saved outlines and that edited text shows in a fallback; the font field's warning says the same for the selection.

5. **Fonts that arrive.** When the font is uploaded or aliased, the text is drawn in it, and the outlines stay as the fallback for anyone without it.

6. **Copies.** Figma lays out each copy's text for it, so a copy's layout is its own, like a hug size: sync doesn't replace it with its main's (`syncInstanceOps`) and the import doesn't mark it overridden. An edit that changes a copy's text makes the copy's layout stale like any other.

7. **Where it's drawn.** The canvas (fills, strokes, shadows, glass masks), SVG export, and through SVG the headless renderer (agent images), PDF and the Worker's renders; thumbnails are the canvas's. All draw the same paths from `savedGlyphGroups`: one path per set of paints, with underline and strikethrough bars from each glyph's advance. Hit testing, selection and caret placement keep using the layout, which only matters once the text is being edited, and then the layout is what's drawn.

## Measured

On the large iOS UI kit (kit parity, 400 frames at 2×, both runs on the same base, `--allow-missing-fonts`), and the shadcn/ui kit, which has every font:

Both runs on main at 34dbafd and this change, same sample, at 2×. Score is the mean RGB difference from Figma's render, 0 to 255.

| | Large iOS UI kit, before | after | shadcn/ui kit, before | after |
| --- | --- | --- | --- | --- |
| Frames | 400 | 400 | 761 | 761 |
| Median | 2.49 | 0.87 | 0.78 | 0.78 |
| p90 | 17.05 | 14.81 | 3.27 | 3.27 |
| Total | 2,970.4 | 2,351.1 | 1,188.3 | 1,188.3 |
| Over 1 / 2 / 5 / 10 / 20 | 273 / 218 / 140 / 87 / 26 | 190 / 147 / 99 / 64 / 22 | 347 / 169 / 46 / 10 / 1 | 347 / 169 / 46 / 10 / 1 |
| Frames better / worse | | 232 / 0 | | 0 / 0 |

- **Where the iOS kit's difference went** (the triage's per-pixel attribution, `attribute.mjs`, run on both): text in a fallback face (cause 1) 853.7 to 472.7, SF Symbols drawn as boxes (cause 4) 346.5 to 118.4. Together 1,200 to 591: half of what missing fonts cost is gone. Every other cause is within 1 of where it was. What's left of the two is mostly text with no outlines (below) and text on dark boards that cause 2 colours wrong.
- **shadcn/ui kit**, every font present: every frame draws as before (one frame within 0.01 of its score). An earlier run of the same change had one frame on the "Welcome" page at 2.02 instead of 1.18: its labels came out in a fallback face, not from outlines (their saved layout is monospaced), as that page sometimes does when fonts arrive late. A second run scored it 1.17.
- **Size.** The iOS kit's converted nodes grew from 19.7 MB to 22.1 MB (2 glyph sets, 947 distinct glyphs, 9,079 of 11,436 text layers with a layout). The shadcn/ui kit's, materialized, from 278.4 MB to 298.0 MB (2 glyph sets, 44,219 of 45,592 text layers); stored as compact copies, a copy keeps a layout only where it differs from its main's.
- **Figma's blobs often close before their first move**, which SVG path data can't: a browser's `Path2D` then draws nothing. The import drops such a close, and drawing skips one in outlines saved before that.

## Consequences

- Text in fonts nobody can upload looks as it does in Figma until it's edited, SF Symbols included. Fonts a team uploads still win.
- Files grow by their outlines and layouts. The iOS kit's converted nodes grew 12% (19.7 to 22.1 MB), the shadcn/ui kit's 7%.
- A layer whose font size or other shaping value the import resolves differently from what Figma laid out (a variable bound in another mode) keeps no outlines: its fingerprint can't match the glyphs Figma saved. In the iOS kit those are about 2,300 text layers whose Dynamic Type sizes the import resolves in another mode (Open Pencil drops their glyphs for the same reason). Resolving variables in each layer's own mode would bring their outlines back.
- Copying a text layer into another file, or a library's text into a file using it, takes its layout but not the glyph sets, so it's laid out as usual there.
