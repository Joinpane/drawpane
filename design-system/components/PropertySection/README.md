# PropertySection

One titled group in the Inspector: Frame, Auto layout, Fill, Stroke, Effects, Export. Sections are separated by `line` hairlines, never boxed, so the pane reads as one calm column.

**Consumer provides:** `title`, optional `actions` (IconButtons, at most three), and `children` laid out with the `dp-row` grid helpers (`dp-row` two columns, `dp-row--3` three, `dp-row--label` label plus control).

- Titles are nouns in sentence case. Empty sections (no stroke yet) show only the header with a "+" action.
- Keep the order fixed across selections, so muscle memory works: Frame, Layout, Appearance, Fill, Stroke, Effects, Export.
- The Selection Lens shows the 4–6 most used fields from these sections. The Inspector remains the full set.
