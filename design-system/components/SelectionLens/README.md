# SelectionLens

A compact floating toolbar anchored 12px below the current selection. It holds the 4–6 controls that matter most for that layer type, so your eyes stay on the work instead of travelling to the Inspector. `⌘ .` toggles the full Inspector.

**Consumer provides:** `kind` (layer type and mode, e.g. "Frame · Auto layout"), `kindIcon`, and `children`: compact NumberFields, TokenChips or SegmentedControls chosen per layer type.

| Selection | Lens controls |
| --- | --- |
| Frame with auto layout | W, H, gap, padding |
| Text | font token, size, weight, fill |
| Shape | W, H, fill, radius |
| Instance | variant picker, the 2 most-used props |

- The Lens flips above the selection when there's no room below, and hides while dragging, scrubbing or panning.
- It never shows more than six controls. Anything else lives in the Inspector.
- Users can turn it off in settings; the command bar and the Inspector still work.
