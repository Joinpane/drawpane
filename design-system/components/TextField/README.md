# TextField

A labelled text input for forms outside the editor canvas: dashboard, settings, share and invite dialogs. It's 36px tall, with a `line-control` border that meets 3:1 on every surface.

**Consumer provides:** `label`, optional `hint` or `error`, and native input props.

- Labels sit above the field, in sentence case, with no colon.
- Errors say what happened and what to do, in one sentence. Never "Invalid input".
- Inside the editor, use NumberField or an inline-editable label instead.
