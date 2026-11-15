# 0015. A stroke width per side

- Status: accepted
- Date: 2026-11-15
- Deciders: Ziyang (lead maintainer)

## Context

Interfaces are full of strokes on some sides only: a list row's bottom border, a sidebar's divider, a card with a thick accent along its top. Figma draws them with individual stroke weights on rectangles and frames. Drawpane had one width for every side, so a Figma row with a 1 px bottom border came in as a 1 px box around the row (decision 0014 noted it as a loss), and nobody could draw one here without a separate line layer that doesn't follow the row when it resizes.

## Decision

- **The model:** `strokeWeights`, a width per side (top, right, bottom, left, CSS's order) on rectangles and frames, or `null` for one width all round. It overrides `strokeWeight`; the inspector keeps `strokeWeight` at the widest side, so whatever reads one width still sees what the layer shows.
- **The geometry** (`packages/editor/src/stroke-sides.ts`): the stroke is the region between two rounded boxes. Inside, the layer's box and the box inset by each side's width; centred, halfway out and halfway in; outside, the box outset by each width and the box itself. A rounded corner between sides of different widths moves by each side's width along its own axis, so the curve inside a thick top and thin side is elliptical, as Figma draws it; a square corner stays square. One even-odd path draws it, on the canvas and in SVG. Widths that are all alike take the ordinary stroke path, so nothing changes for the strokes that existed.
- **CSS export:** `border-width` with four values (an outline can't vary by side); outside strokes keep the content box, where a border lies outside the layer's box, as the stroke does.
- **The inspector:** a Sides control (all, one side, or custom, with four widths laid out like auto layout's padding). The width field sets the side shown, or every side. Changing the sides is one undo step.
- **Figma import:** individual stroke weights come in as they are on boxes; the note remains only for layer types that can't hold them.
- **Measured:** four cells in the strokes parity suite (bottom only; a thick top on a rounded box; centred left and right; outside on a rounded box) match Figma to a mean difference of 0.00–0.23 of 255.

## Consequences

- Dashes on a stroke with a width per side aren't drawn as dashes (Figma's dashed per-side strokes are rare); the region is solid.
- Flattening a box to a path keeps the widest side all round: paths have one width.
EOF
cd /workspace/drawpane-figma && python3 - <<'EOF'
p="docs/decisions/0014-figma-import.md"
s=open(p).read()
import re
i=s.find("stroke")
print(s[max(0,i-300):i+200] if i>=0 else "no stroke mention")
EOF