# Badge

A short status label beside a name: a file's branch, a component's role, a merge result. Status tones (`success`, `warning`, `danger`, `info`) always show an icon and a word, so color is never the only cue.

**Consumer provides:** `children` (one to three words), optional `tone` and `icon`.

- `signal` tone counts unseen changes or work that needs you. Use no more than one per row.
- `component` tone marks main components and variants only.
- Badges are not buttons. If it does something on click, use a ghost Button.
