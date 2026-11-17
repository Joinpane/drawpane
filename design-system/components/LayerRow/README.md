# LayerRow

One row in the Layers tree. Rows are 28px tall and indent 12px per level, with a faint `line` indent guide under each ancestor's caret so depth still reads when a deep tree is scrolled sideways.

**Lock and visibility** sit at the row's end, in fixed slots so every row's toggles line up:

- **Locked:** a solid, closed padlock (`lock`), always shown, in `ink`.
- **Hidden:** a slashed eye (`eye-off`), always shown, in `ink`; the name and glyph dim to `ink-muted`.
- **Unlocked or visible:** nothing, until the row is hovered or focused; then a faint open padlock (`unlock`) and eye in `ink-muted` offer to lock or hide it.
- Each is a toggle button with a fixed name ("Lock", "Hide") and `aria-pressed` for its state; its tooltip says what a click does ("Unlock", "Show"). On the row holding the tree's focus, Tab reaches them; ⌘⇧L and ⌘⇧H work on the selection.
- In a tree that scrolls sideways, they stick to the panel's right edge over the row's own ground, and names fade out under them.

**Consumer provides:** `name`, `kind` (sets the glyph), `depth`, and the state flags `selected`, `hidden`, `locked`, `hasChildren`, `expanded`. Pass `presence` (1–8) when a collaborator has the layer selected.

- Selected rows use `signal-soft` with semibold `ink` text. Components and instances use the `component` glyph and `component-ink` names, so they're recognisable without reading.
- Hidden layers dim to `ink-muted`; they're never removed from the tree.
- Double-click renames in place, except on the kind icon: double-clicking that zooms the canvas to the layer, as in Figma, with no tooltip or hover state of its own. Names are never truncated in the middle; long names truncate at the end and show in full in a tooltip.
