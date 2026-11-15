# 0018. Line height on part of a text, stacked as Figma does

- Status: accepted
- Date: 2026-11-15
- Deciders: Ziyang (lead maintainer)

## Context

A heading and its body are often one text layer in Figma, each with its own line height. Drawpane had one line height a layer, so those came in with the body's line height everywhere (decision 0014 noted it), and couldn't be made here. And when line heights differ within a text, where each line goes depends on the stacking rule, which differs between CSS and Figma.

## Decision

- **Line height is a character style** (`lineHeight` on runs, like font size): set on the selected characters while editing, on the layer otherwise; applying a text style clears it from the runs with the rest of the typography. A line's line height is the tallest of its characters'.
- **Lines stack as Figma stacks them**, measured on a `text-ranges` parity suite built in Figma: each line's baseline is its own line height below the last's (a taller line pushes itself down, not the line after it), and the first line sits centred in its own line height, as before. CSS centres every line in its own box instead, so a 200% paragraph after a 120% one would sit 25.6 px down at 16 px instead of Figma's 32. With one line height throughout, the two rules are the same: nothing that was drawn before moves (the text suite stays at 4.07).
- **Figma import** brings a range's own line height onto its characters; only per-paragraph alignment and paragraph spacing, which Drawpane keeps for the whole text, are still noted. (Figma itself applies paragraph spacing to the whole text: set on one paragraph through its API, it spaces them all.)
- **Measured:** the `text-ranges` suite (a heading's line height over its body's, two line heights on one line, a percentage on one paragraph) matches Figma to a mean of 2.55 of 255, every line within a pixel of Figma's.

## Consequences

- A tall character in a line's middle doesn't push the line below it further down: as in Figma, its descenders may reach into that line.
