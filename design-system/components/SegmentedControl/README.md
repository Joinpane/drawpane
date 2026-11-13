# SegmentedControl

Two to five mutually exclusive options shown at once: pane modes, layout direction, text alignment. It renders as a radio group.

**Consumer provides:** `options` (`value` plus `label` or `icon` and `title`), the current `value`, `onChange`, and an accessible `label` for the group.

- The selected option is a raised chip on the sunken track. Don't use signal here.
- Icon-only options need a `title`, which becomes the accessible name and tooltip.
- More than five options? Use a menu.
