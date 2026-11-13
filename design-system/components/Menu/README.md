# Menu

Context menus and dropdown menus. Items are 28px tall, with an optional icon column, a label and a right-aligned shortcut or submenu chevron. The keyboard-active item uses `surface-hover`: Drawpane highlights calmly and saves `signal` for selection.

**Consumer provides:** `items` (`label`, `icon`, `shortcut`, `checked`, `danger`, `disabled`, `submenu`), plus `{ separator: true }` and `{ heading: 'Selection' }` entries.

- Order items by frequency, then group with separators. Destructive items always go last.
- Every command in a menu must also be reachable from the command bar.
- Never more than two levels of submenu.
