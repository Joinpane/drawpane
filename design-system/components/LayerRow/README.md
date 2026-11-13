# LayerRow

One row in the Layers tree. Rows are 28px tall, indent 12px per level, and show visibility and lock actions on hover, or permanently when a layer is hidden or locked.

**Consumer provides:** `name`, `kind` (sets the glyph), `depth`, and the state flags `selected`, `hidden`, `locked`, `hasChildren`, `expanded`. Pass `presence` (1–8) when a collaborator has the layer selected.

- Selected rows use `signal-soft` with semibold `ink` text. Components and instances use the `component` glyph and `component-ink` names, so they're recognisable without reading.
- Hidden layers dim to `ink-muted`; they're never removed from the tree.
- Double-click renames in place. Names are never truncated in the middle; long names truncate at the end and show in full in a tooltip.
