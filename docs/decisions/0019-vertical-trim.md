# 0019. Vertical trim: a text box from its capitals to its baseline

- Status: accepted
- Date: 2026-11-15
- Deciders: Ziyang (lead maintainer)

## Context

A text layer's box holds its whole line height: above the capitals sit half the leading and the font's room for accents, below the baseline its descenders and the other half. So a heading's box is taller than what's seen, and spacing it from a card's edge or an icon by the box leaves the visible gap uneven. Figma's "vertical trim" (`leadingTrim: CAP_HEIGHT`, shown as "cap height to baseline") cuts the box to what's seen, and design systems built in Figma use it for exactly that. Drawpane had no such setting, and its Figma import dropped it, so trimmed text came in taller and further down than in Figma.

## Decision

- **The model:** `leadingTrim` (`none` or `cap-height`) on a text layer, and on text styles, like the rest of its typography. It's a whole-layer setting, as in Figma, not a character style.
- **The layout, measured against Figma** (`tools/figma-parity/scenes/vertical-trim.json`): the box starts at the first line's cap height and ends at its last line's baseline. The lines keep their spacing and move up together; descenders and the half-leading hang outside the box. A line's cap height is the tallest of its characters' (a big first word sets it). It's applied after the lines are stacked, so line height, paragraph spacing, lists and truncation are as they were, and auto sizing, vertical alignment, the caret and selection all follow the trimmed box without knowing about it.
- **Cap height** is read from the font as the browser draws it: the top of an "H", measured at 1000 px like the other metrics. That's where every Latin face puts its flat capitals, and the font's own `sCapHeight` is meant to match it. Without metrics, 0.7 em stands in.
- **The inspector** shows it in type settings' Basics, as Figma does: "Standard" or "Cap height to baseline", Figma's words. Text styles have it there too.
- **Figma import** brings `leadingTrim`; **CSS export** writes CSS's own `text-box: trim-both cap alphabetic`, which trims the same way.
- **Measured:** the suite (auto-sized text at 16 and 48 px, line heights in percent and px, fixed boxes aligned to the bottom and middle, wrapping, mixed sizes, paragraph spacing, Instrument Sans, and an untrimmed control) matches Figma to a mean of 2.56 of 255. Every cell's ink lands within a device pixel of Figma's at 2×, top and bottom, as the untrimmed control does; what's left is the two rasterisers' glyphs and kerning, as in the text suite.

## Consequences

- Descenders and accents reach outside a trimmed layer's box, so clicking a descender below the box doesn't hit the layer, as in Figma.
- The Figma import fixture predates the suite, so the import parity check doesn't cover trimmed text yet; it will once the fixture is refreshed from the file (the REST budget allows it again after November 19).
