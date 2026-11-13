# Kbd

Key caps for keyboard shortcuts in menus, tooltips, onboarding and docs. Keys are set in `kbd` style (JetBrains Mono 11px) on `surface-sunken`.

**Consumer provides:** `keys`, an array of key labels in the order they are pressed.

- Use platform symbols on macOS (⌘ ⌥ ⇧ ⌃ ↵) and words elsewhere (Ctrl, Alt, Shift, Enter). The app swaps them; never hard-code one platform in docs.
- One cap per key. Don't write "+" between caps.
