# Icon

Drawpane's own icon set: 43 glyphs on a 16px grid, drawn with a 1.5px stroke, round caps and round joins. Icons inherit `currentColor`, so color them with the text token of their context.

**Consumer provides:** `name` (one of `Drawpane.icons`), optional `size` (16 default, 12 for dense rows and chips), and `label` only when the icon stands alone and means something. Decorative icons stay `aria-hidden`.

- Default ink is `icon`. Use `component` for component and instance glyphs, `signal-ink` for the active state, `ink-disabled` when disabled.
- Never mix in another icon family. When a glyph is missing, draw it on the same grid and add it to `assets/Icons/`.
- Don't put emoji in UI chrome.
