# 0017. Bulleted and numbered lists

- Status: accepted
- Date: 2026-11-15
- Deciders: Ziyang (lead maintainer)

## Context

Text in interfaces, landing pages, documents and slides is full of lists. Figma has bulleted and numbered lists with nesting; Drawpane had none, and its Figma import dropped them without a word (decision 0014), leaving the items as plain paragraphs.

## Decision

- **The model:** `listType` (`none`, `bullet`, `number`) and `listLevel` (0–8), on a text layer and on its runs, like any other character style. A paragraph takes the list of its first character. Kept on characters rather than in a list of paragraphs, a list stays right through editing for free: runs already follow every edit (`remapRuns`), so a line break typed in a list item starts another item, and deleting one joins its text to the item above. Applying a text style leaves lists alone.
- **The layout, measured against Figma** (`tools/figma-parity/scenes/lists.json`, built in Figma, its `lineTypes` and 1-based `lineIndentations`): each level indents the item's text 1.5 em (of its first character's size); wrapped lines hang under the text; a bullet is centred in its level's last indent; a number ends 0.375 em before the text (both measured at 16 and 28 px). Numbers count per level and start over after a paragraph out of the list. The indent is part of where each line starts (`lineOffset`), so the caret, selection, hit testing and drawing all follow it without knowing about lists.
- **Editing:** the inspector's Text section has bulleted and numbered toggles and outdent and indent; ⌘⇧8 and ⌘⇧7, as in Figma; while typing, Tab and ⇧Tab nest an item, "- ", "* " or "1. " at a paragraph's start makes one, Enter on an empty item ends the list, and Backspace at an item's start takes it out of the list before joining lines. While text is edited these act on the paragraphs the caret or selection touches; otherwise on whole layers, in one step.
- **Export:** SVG draws the markers and indents; PNG and PDF draw what the canvas does.
- **Figma import** brings each line's list type and indentation as list props on its characters, merged with the character styles.
- **Measured:** the lists suite (bullets, numbers, nesting, a list between plain paragraphs, wrapping, large type) matches Figma to a mean of 3.76 of 255, about the text suite's own (decision 0013): what's left is two rasterisers drawing small glyphs; the bullets land on Figma's pixels and the wrapped lines break where Figma's do.

## Consequences

- CSS export describes a text layer's type, not its structure: it doesn't turn list items into `<ul>`/`<ol>`.
- The text's last paragraph, when empty, has no characters of its own: it continues the list of the one before (so Enter at the end of a list continues it), and setting its list sets the line break before it.
- Markers are drawn in their item's first character's font and fill, with no letter spacing or text case.
