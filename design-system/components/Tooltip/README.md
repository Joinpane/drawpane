# Tooltip

The one inverted surface in Drawpane: `ink-inverse` on `surface-inverse`, 11px, with the shortcut in mono. It appears after 500 ms of hover and immediately on keyboard focus.

**Consumer provides:** `label` and optional `shortcut`; positioning comes from the host popover layer.

- Name the thing, not the instruction: "Rectangle", not "Click to draw a rectangle".
- Never put interactive content in a tooltip. Use a popover instead.
