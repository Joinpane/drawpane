# 0043. Text a constraint resizes stops sizing itself on that axis

- Status: accepted
- Date: 2026-11-21
- Deciders: Ziyang (lead maintainer)

## Context

A text layer can size itself: auto width (it's as wide as its longest line and breaks only at its own line breaks), auto height (its width is fixed, it wraps, and its height follows its lines) or neither (fixed size). Constraints move and size a layer when its parent is resized: Left and right (stretch) and Scale change its width with the parent's, Top and bottom and Scale its height.

The two disagreed. An auto width text with Left and right in a frame that narrowed was given the narrower width but kept auto width, so it stored a width its words didn't fit, while still claiming to size itself. The next edit to its words snapped it back out past the frame. Auto height text a constraint narrowed kept its old height and didn't wrap, because the commit never measured text that only its constraints resized. Both were on main, found by the edit-layout oracle (PR 266's re-check).

Figma's developer docs describe the three modes (`TextNode.textAutoResize`): `WIDTH_AND_HEIGHT` sizes the box to the text, `HEIGHT` keeps the width and grows the height, `NONE` keeps both. Its help pages say resizing a text layer by hand makes it Fixed size. Neither says what a parent's resize does to its constrained text.

So we checked current Figma (2026-11-21). In a scratch page of a draft file, we resized only the parent frame through the plugin API, whose `resize` applies constraints to children as dragging the frame does, and read each text's mode and size back. The text was "Words wrap here" in Inter 16 inside a 180 × 100 frame. The parent was narrowed to 125, widened to 260, made taller, made shorter, then the words were lengthened:

| Text, constraints | After narrowing | After widening | Taller or shorter | Words lengthened |
| --- | --- | --- | --- | --- |
| Auto width, Left and right | Auto height, 74 wide, 57 tall (wrapped) | Auto height, 209 wide, one line | Auto height, unchanged | Auto height, grows taller |
| Auto width, Scale | Auto height, 89.58 wide, wrapped | Auto height | Auto height, unchanged | Auto height, grows taller |
| Auto width, Left, Right or Center | Auto width, moved only | Auto width, moved only | unchanged | Auto width, grows wider |
| Auto height, Left and right | Auto height, wrapped, taller | Auto height, one line | unchanged | grows taller |
| Fixed size, Left and right | Fixed, width follows, height kept | Fixed | unchanged | unchanged |
| Auto width or auto height, Top and bottom | unchanged (width not touched) | unchanged | Fixed size, height follows (11 tall when shorter, clipping) | unchanged |

Figma switches the mode as soon as a constraint changes the text's size on an axis, and only then. A constraint that only moves the text, or a resize on the other axis, leaves the mode alone.

## Decision

1. **A text layer a constraint resizes gives that axis up, as Figma does.** When a parent's resize changes a text layer's width by its constraint (Left and right, or Scale), auto width becomes auto height: it takes the width the constraint gives and wraps there, its height following its lines. When the constraint changes its height (Top and bottom, or Scale), any auto size becomes fixed. It's the same rule auto layout already follows when Fill or stretch takes a text layer's size (`textResizeWhenSized` in `layout.ts`, shared by both). The new mode is written in the same commit as the resize (`constraintOps`), so undo restores both together, and a mode the same edit sets itself wins.
2. **Text a constraint resizes is measured in that commit**, like text the edit touched itself, so an auto height text narrowed by its constraint grows to fit its new lines at once.
3. **Group members** a stretching or scaling group resizes follow the same rule. Figma wasn't checked for this case. Keeping a group's text auto width would leave it the width its words don't fit, the disagreement this decision ends.

The stored mode is the source of truth, as before. A file saved with constrained auto width text at a width its words don't fit (made before this decision, or imported) keeps it until something resizes or edits that text. There's no migration.

## Consequences

- Narrowing a frame wraps its stretched text and grows it downward, as in Figma. Widening it again unwraps the lines, but the text stays auto height, as in Figma.
- An instance resized in an editor gives its stretched text the same switch, as a laid-out value on the copy. Its main keeps auto width.
- `packages/editor/test/constraints.test.ts` ("text a constraint resizes") checks the table's rows. The edit-layout oracle now generates constrained auto-sized text, which it used to leave out because of the old disagreement.
