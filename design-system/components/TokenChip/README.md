# TokenChip

A token reference inside a property field, a list or the command bar. Tokens, variables and styles are one concept in Drawpane, so every bound value looks the same, whatever its type.

**Consumer provides:** `name` (the token path as authored, e.g. `space/300`), `swatch` for color tokens, and `detached` when the layer overrides the token's value.

- Names are set in mono, because they are the names developers will type.
- A detached chip is struck through with a `warning` outline. Clicking it offers "Reattach" and "Update token".
- Don't truncate the last path segment. Truncate from the left: `…/brand/500`.
