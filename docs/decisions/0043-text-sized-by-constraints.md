# 0043. Text a constraint resizes stops sizing itself on that axis

- Status: accepted
- Date: 2026-11-21, copies and Hug frames 2026-11-22
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
- **Copies follow Figma's instances, which don't switch** (probed 2026-11-22, below). In an instance, a copy text that sizes itself on an axis keeps doing so, and keeps its mode. Its constraints still place it, but don't size it on that axis.
  - Auto width text keeps its own width and height in a narrowed or widened instance, under Left and right or Scale. Scale moves it (its left edge scales); Left and right leaves it where it is.
  - Auto height text takes the width Left and right or Scale gives it and measures its height there, but Top and bottom doesn't size it.
  - Fixed size text follows its constraints, as any layer does.
  - So a copy's mode is always its main layer's (another mode is a person's override), and `laidOutProps` counts only that one as laid out. The width a constraint used to give auto width text in an instance (on main) is gone: it measures itself, as its main does.
- **A frame whose auto layout hugs on an axis keeps its size** when a constraint would stretch or scale it there, plain or a copy, and what's inside it stays where it is. Figma places it: stretched, it's centred in the span stretching would give it (centred in its frame once that span is gone); scaled, its centre scales.
- `packages/editor/test/constraints.test.ts` ("text a constraint resizes") checks the table's rows.

### Figma's instances and Hug frames (2026-11-22)

Probed the same way, on a scratch page of the parity draft file, removed afterwards. Each text was "Words wrap here" in Inter 16 at x 10 in a 160 × 60 component, read back from an instance resized to 100 wide (or 120 tall for Top and bottom) and from a plain frame resized the same way:

| Text, constraints | In the instance | In the plain frame |
| --- | --- | --- |
| Auto width, Left and right | Auto width, 129 × 19, unmoved (220 wide: the same) | Auto height, 69 × 57 |
| Auto width, Scale | Auto width, 129 × 19, x 6.25 (13.75 at 220) | Auto height, 80.62 × 38, x 6.25 |
| Auto width, Center or Right | Auto width, moved only (x −20, −50) | the same |
| Auto height, Left and right | Auto height, 69 × 57 (189 × 19 at 220) | Auto height, 69 × 57 |
| Fixed size, Left and right | Fixed, 69 × 19 | Fixed, 69 × 19 |
| Auto width or auto height, Top and bottom | unchanged | Fixed size, 129 × 79 |

A rectangle with Left and right in the same instance went from 100 to 40 wide, so constraints do apply to instance layers; it's only self-sizing text that keeps its size. (Groups have no constraints in Figma's plugin API, so the group rows of this decision weren't comparable.)

A 40 × 20 row with Hug height at y 10 in a 160 × 80 frame, Top and bottom or Scale, in a plain frame and in an instance:

| Frame height | 70 | 60 | 50 | 40 | 30 | 100 | 120 | 160 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Top and bottom, in an instance | 5 | 10 | 15 | 10 | 5 | 20 | 30 | 50 (plain) |
| Scale, either | 7.5 | 5 | 2.5 | 0 | −2.5 | 15 | 20 | 30 |

The frame stayed 20 tall throughout, and an absolutely placed 8 × 8 layer inside it, Scale, stayed at y 4. Scale fits its centre scaling exactly. Top and bottom fits centring in the stretched span wherever that span has room (70, 100, 120, 160). Below that, Figma centres it in its frame (50, 40, 30), except at exactly zero room (60), where it stays at 10. We take the centring in the frame there too.
 The edit-layout oracle now generates constrained auto-sized text, which it used to leave out because of the old disagreement.
