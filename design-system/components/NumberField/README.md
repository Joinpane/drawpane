# NumberField

The Inspector's numeric input. Its label is also a scrub handle: drag left or right to change the value, holding Shift for steps of 10 and Alt for steps of 0.1. Fields accept math and units (`24*2`, `1.5rem`, `50%`), and evaluate on Enter.

**Consumer provides:** `label` (one to three characters) or `icon`, `value` or `defaultValue`, optional `unit`, and `token` when the value is bound to a token. A bound field shows a TokenChip instead of the number.

- The field is identified by its `surface-sunken` well and its label. It gets a `line-strong` border on hover and a `signal` border while focused.
- Values use tabular figures so columns of numbers align.
- Show "Mixed" in `ink-muted` when a multi-selection has different values.
