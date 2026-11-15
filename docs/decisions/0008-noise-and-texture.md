# 0008. Noise and texture: effects on the layer's finished picture

- Status: accepted
- Date: 2026-11-14
- Deciders: Ziyang (lead maintainer)

## Context

Figma's effects menu has two more kinds besides shadows, blurs and glass:

- **Noise** sprinkles grain over a layer, clipped to what the layer paints. It comes in three kinds: Mono (one colour), Duo (two colours) and Multi (many colours, at an opacity). Noise size scales the grain, and density sets how much of the layer it covers.
- **Texture** roughens a layer's edges, as if printed on rough paper. Size sets the grain of the roughening, and radius sets how far it reaches past the edge. "Clip to shape" keeps it inside the layer's outline.

Both work on the layer's whole picture: its fills, strokes, shadows and a frame's children. Layer blur already works this way: the layer is drawn on its own canvas and then composited blurred. Figma applies noise, texture and layer blur in the order they're listed.

## Decision

**Layer blur, noise and texture are *post effects*.** A layer that has any of them is drawn by itself onto a canvas of its own, as layer blur already is. Its post effects then apply to that picture in list order, and the result is composited with the layer's opacity and blending. The pipeline is one method in the renderer (`#drawProcessed`), replacing the blur-only path.

- **Noise** is a tile of grain, generated once per look (kind, density, colours) from a fixed seed. Grain is blobs where a smooth noise field rises past a threshold set by the density, with soft edges (revised by decision 0013 to match Figma: originally square cells, each on with the density's chance). Mono paints the blobs in its colour. Duo paints them in the first colour and a second, independent set in the second. Multi paints them in colours that vary slowly across the layer, at its opacity. The tile is drawn as a pattern over the picture with `source-atop`, so it lands only where the layer paints and keeps its edges. The pattern follows the layer's transform, scaled by `size`, so grain moves, scales and rotates with the layer. This is pure 2D canvas: there's no WebGL and no per-pixel loop in a frame.
- **Texture** needs per-pixel displacement, which the 2D canvas doesn't have. So, like glass (decision 0007), it's a small WebGL2 shader. A smooth field of offsets (fractal gradient noise with features about `size` units across, anchored to the layer) moves each pixel by up to `radius`. Edges break up into grain, and so does any detail inside. With "Clip to shape" the result is cut to the layer's own coverage, so nothing reaches past the edge but the edge still roughens inward. Without WebGL2 the picture is left unroughened. (Revised by decision 0013: originally each `size` cell moved by one random offset, which broke edges into square steps where Figma's are ragged.)
- A layer's reach (for culling, the post canvas and exports) grows by an unclipped texture's radius.
- **The model:**
  - `{ type: "noise", noiseType: "mono" | "duo" | "multi", size, density, color, secondaryColor, opacity }`. All of these are kept whichever kind is chosen, so switching kinds and back loses nothing.
  - `{ type: "texture", size, radius, clipToShape }`.
  - Size is in px (0.5 to 50), radius in px (0 to 100), and density and opacity are 0 to 100.

**SVG and PDF** have no per-pixel randomness, but SVG filters come close:
- Noise is `feTurbulence` at the grain's frequency, thresholded to the density, flooded with the colours and composited `atop` the layer.
- Texture is `feTurbulence` driving `feDisplacementMap`, cut to the source's alpha when clipped.

They're approximations: `feTurbulence` is a different smooth noise from the canvas's, though noise uses the same coverage law for its threshold. PNG export, drawn by the canvas renderer, matches the editor. CSS has no equivalent, so code output leaves them out.

## Consequences

- One pipeline for every effect that works on the finished picture, so a new one (a future colour adjustment, say) is a case in a switch, not another isolation path.
- A layer with noise costs one isolated draw and one pattern fill per frame. Texture adds a texture upload and one shader draw. Files without them pay nothing, and the WebGL context is made on first use.
- Noise is deterministic, being seeded and anchored to the layer. The same file looks the same on every screen and export, and grain doesn't crawl while panning.
