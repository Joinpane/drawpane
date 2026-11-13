# Switch

An on/off setting that takes effect immediately, such as "Clip content" or "Snap to pixel grid". The off track has a `line-control` border; on fills with `signal`.

**Consumer provides:** `checked`, `onChange`, and `label`.

- The label names the setting, not the state: "Clip content", not "Content is clipped".
- If the choice only applies after Save, use a checkbox in a form instead.
