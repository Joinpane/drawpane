# Button

A labelled action. Secondary is the default; **primary** (signal fill, dark `on-signal` text) appears at most once per view, for the action the view exists for.

**Consumer provides:** `children` (the label), optional `variant` (`primary`, `secondary`, `ghost`, `danger`), `size` (`sm` 24px in panes, `md` 28px default, `lg` 36px on the dashboard and in dialogs), `icon`, `shortcut`, and any native button props.

- Labels are verb-first, sentence case, 1–3 words: "Publish library", not "Publish" or "Library Publishing".
- Show the shortcut in the button only for the dialog's confirm action.
- Use `danger` only for irreversible actions, and always confirm them. Never put white text on signal.
- Use `ghost` inside panes, where a filled button would compete with the design.
