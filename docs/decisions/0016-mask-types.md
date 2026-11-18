# 0016. Masks by alpha and luminance

- Status: accepted
- Date: 2026-11-15
- Deciders: Ziyang (lead maintainer)

## Context

A Drawpane mask clipped the layers above it to its outline. Figma's masks mask by their alpha unless set to their outline: a gradient fading to transparent fades a photo out, a translucent mask shows the photo faintly, a blurred mask gives it a soft edge. A third kind masks by luminance (light shows, dark hides). Every Figma file with a soft-edged mask came in with a hard edge (decision 0014 noted it as a loss), and none could be made here.

## Decision

- **The model:** `maskType` on maskable layers: `outline` (a clip, the default, so masks made before keep their look), `alpha` or `luminance`. Outline stays the default rather than Figma's alpha because an alpha mask with no visible fill hides everything, which masks made here before couldn't have meant.
- **The canvas:** layers masked by alpha or luminance are drawn into a canvas of their own over the mask's reach (nothing outside it shows), the mask layer into another (its fills, gradients, opacity, effects and, for a frame, its children), and kept with `destination-in` where the mask is. For luminance, a small WebGL2 pass first turns the mask's picture into alpha (Rec. 709 luminance times alpha), with a pixel loop where there's no WebGL2. Outline masks keep the clip, which costs nothing extra.
- **SVG:** a `<mask>` with `mask-type` alpha or luminance holding the mask layer as it's drawn, so exports keep the fade.
- **The inspector:** "Masks by" (outline, alpha, luminance) under the Mask switch.
- **Figma import** keeps the mask type; a file too old to say has alpha masks unless `isMaskOutline` says otherwise.
- **Measured:** a masks parity suite (gradient fades by alpha and luminance, a translucent mask both ways, a blurred mask, a half-opacity mask layer, a radial luminance spot) matches Figma to a mean difference of 0.31 of 255, the blurred mask's 0.93 being layer blur's own difference (decision 0013).

## Consequences

- Layers masked by alpha or luminance are drawn apart from what's below them, so a blend mode among them blends with the other masked layers, not with what's under the mask, and glass or background blur among them sees only those layers.
- Hit testing and group bounds still use the mask's outline: a click on a fully faded part of a masked photo still picks it.

## Amendment (2026-11-18): where a mask ends, and what can be one

Measured on a large iOS UI kit, whose worst frame was a popover drawn white: its arrow, a mask at the bottom, masked the card's background two layers up.

- **Scope:** a mask masks the siblings above it up to the next mask, the end of its parent, or a visible frame that clips its content (a component's copy too), which shows unmasked with everything above it up to the next mask. Figma's help says so ("The mask applies to all siblings above it until it reaches … a frame or component with clip content on"), and Figma's renders of both kits agree for every mask in their samples: a clipping sibling above a mask is never masked, a non-clipping one always is. A hidden frame, like a hidden mask, changes nothing. One rule in the editor's `masks.ts`, read by the canvas, SVG export (so headless renders), hit testing, group bounds and the layers panel.
- **Any layer can be a mask,** as in Figma: groups (icon sets mask by a group's luminance), texts (symbol glyphs masking a tint) and lines join frames and shapes. Masks by alpha or luminance draw the mask's picture whatever it is. An outline mask that's one filled shape still clips to it; a group, text or line masking by its outline masks by its picture made opaque (alpha times 255), on the canvas and in SVG (`feFuncA slope="255"`). Hit testing on a group mask looks at the layers in it. The import's "mask-kind" note is gone.
- **Import:** a `.fig` names an outline mask `OUTLINE` where the REST API says `VECTOR`; they came in as alpha masks and now come in as outline masks.
