# 0007. Glass: a refraction effect drawn by a small WebGL shader

- Status: accepted
- Date: 2026-11-14
- Deciders: Ziyang (lead maintainer)

## Context

Figma offers a Glass effect, after Apple's "liquid glass": what's behind a layer is seen through it as through a lens with curved edges. Near the edge the backdrop bends (refraction), colours split slightly (dispersion), the glass can be frosted, and light catches the rim from a direction. Its controls are Light (an angle and an intensity), Refraction, Depth, Dispersion, Frost and Splay. The maintainer wants it in Drawpane.

Drawpane draws with the 2D canvas. Background blur already reads what's behind a layer by drawing the canvas onto itself through a blur filter, clipped to the layer's shape. Glass needs more than a filter: each pixel takes its colour from somewhere else in the backdrop, by an amount that depends on how close it is to the shape's edge and which way the edge faces. The 2D canvas has no per-pixel displacement (a `getImageData` loop is far too slow for a frame), and SVG's `feDisplacementMap` can't reach the backdrop.

## Decision

**A glass effect on any shape, drawn by a WebGL2 fragment shader**, on one small WebGL canvas the renderer keeps, used only while something has glass:

1. The **backdrop** is the canvas under the layer, as for background blur, with a margin around it for the bent rays to reach into. **Frost** blurs it first.
2. The **edge profile** comes from the layer's own shape: its mask, blurred by the **Depth** (the width of the curved rim). That blurred mask rises from 0 outside to 1 a depth inside the edge; its gradient is the rim's slope and direction. This works for every shape (rectangles, paths, text) without a distance function for each.
3. The shader moves each backdrop sample along the slope by **Refraction**: strongest on the rim, nothing in the flat middle. **Dispersion** moves red and blue by different amounts, so edges fringe like real glass. **Splay** fans the bend outward from the shape's centre as well as across its edge, so the glass magnifies more. **Light** brightens the rim where it faces the light's angle, by its intensity, and shades the side facing away a little.
4. The result is cut to the shape (antialiased by its mask) and drawn where background blur would be: under the layer's own fills, so a translucent fill tints the glass, as in Figma.

The model gains `{ type: "glass", angle, intensity, refraction, depth, dispersion, frost, splay }` in `effects`, with Figma's defaults (−45°, 80%, 80, 20, 50, 4, 0). Values are 0–100 except the angle (degrees) and frost and depth (px).

Without WebGL2 (a few old browsers, headless contexts), glass degrades to frost plus a rim highlight drawn with the 2D canvas.

## Consequences

- One more drawing path to keep in step, contained in one module (`glass.ts`) with its shader; its parameters are mapped by pure functions that are unit-tested, and its look by a browser test.
- A glass layer costs a backdrop copy, two small uploads and one draw per frame, only for layers on screen; files without glass pay nothing (the WebGL context is made on first use).
- SVG and PDF can't read what's behind a layer either, so they get an approximation: the layer's fills with a soft rim highlight. PNG export, drawn by the canvas renderer, has the real effect.

## Revision: a smooth rim (2026-11-14)

The first version took the rim's slope from the shape's mask blurred by the 2D canvas: 8 bits of height, differenced across single pixels. Quantised height made visible terraces and moiré in the bend, and noisy colour fringes, most of all at rounded corners. It now:

- **Finds the edge exactly.** It takes every pixel's distance and direction to the shape's edge from a jump-flooded distance field on the GPU (half floats, seeded at sub-pixel edge points from the anti-aliased mask, and only as far as the rim is deep). Right at the edge, the direction blends into the mask's own slope.
- **Bends without folding.** The rim is an analytic profile. A pixel a fraction *t* of the depth in sees the backdrop `refraction × (1 − t)³` further in. That eases into the flat middle without a crease, and at most about a third of the depth, so content folds back on itself only in a sliver at the very edge, as thick glass does.
- **Fringes subtly.** Dispersion parts the colours by up to a quarter of the bend.
- **Lights the rim.** A fine specular line runs along the edge facing the light, with a softer line opposite (light inside the glass) and a gentle sheen across the lit side of the rim. The flat middle shows the backdrop as it is, frosted.

