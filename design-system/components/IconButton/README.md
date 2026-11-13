# IconButton

A square, icon-only button for tools and pane actions. It always carries an accessible `label`, which doubles as its tooltip together with the shortcut.

**Consumer provides:** `icon`, `label`, optional `shortcut`, `pressed` for toggles (renders `aria-pressed`), and `size` (`sm` 24px in pane headers, `md` 28px in the command strip).

- A pressed toggle uses `signal-soft` with a `signal-ink` glyph; the active tool is the only pressed button in the command strip.
- Never use an IconButton for a destructive action; use a Button with a word.
- Group related IconButtons with a 1px `line-strong` separator, not with boxes.
