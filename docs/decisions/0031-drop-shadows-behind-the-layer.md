# 0031. Drop shadows behind the layer, as Figma casts them

- Status: accepted
- Date: 2026-11-17
- Deciders: Ziyang (lead maintainer)

## Context

Drawpane cast every drop shadow from the layer's shape grown by its spread, and drew it under the layer whatever the layer filled. Figma doesn't. Measured on a 500k-layer commercial UI kit (decision 0030), focus and invalid rings are spread shadows on fields whose fill is fully transparent; Drawpane filled those fields grey or red, and drew a ring round them that Figma doesn't draw at all. It was the third largest difference in the kit.

Figma's drop shadows have a setting, "Show behind transparent areas" (`showShadowBehindNode` in the REST API and in `.fig` files, saved on every shadow in the kit: 1,548 on, 331 off). The importer dropped it, and the model had nowhere to keep it.

What Figma draws, read from its renders of the kit:

- **A layer that fills something visible** casts its shadow from its shape grown by the spread. With the setting off, the shadow is cut out under the shape: rectangles with a 10% white fill show their shadow outside at full strength (within two levels of Drawpane's) and none inside. With it on, the shadow shows through a see-through fill.
- **A layer that fills nothing visible** (no fills, hidden ones, or only fully transparent ones) casts no shadow from its shape, whatever the setting: no ring round 49 fields with a 0% fill, on or off. Its shadow is cast from what it draws (strokes, children), and spread doesn't grow that.
- **Linked effect styles win over the effects saved on the layer** (as fills and text styles do, decision 0025): a ring shows on an opaque button that links a focus style and saves a plain shadow.

## Decision

1. **Shadows say whether they show behind the layer.** `showBehind` on a drop shadow; false cuts it out under the layer's shape. Missing means it shows, as Drawpane's shadows always have, so documents made in Drawpane draw as before where they fill something. The inspector has the switch ("Show behind transparent areas"). The Figma importer keeps Figma's setting when it's off.
2. **One rule for how a layer casts a drop shadow** (`dropShadowCast` in the editor), shared by the canvas renderer and SVG export (and so the server's renders):
   - fills something visible and opaque: from the shape grown by the spread, drawn whole (nothing would show under the fill);
   - fills something see-through: from the grown shape, cut out under the shape when `showBehind` is false;
   - fills nothing visible: from the shape *without* spread, cut out under it. That's an approximation of Figma's shadow of the layer's contents: right for a panel that fills its frame (a translucent menu keeps its soft shadow outside and a clear inside) and for rings (no offset, no blur: nothing shows, as in Figma), rougher for a frame holding a few small children, which Figma shadows one by one.
   - text casts from its glyphs, as before.
3. **Crops may reach past the image.** Not this decision's subject, but found by the same measurement: an image fill whose Figma transform shows more than the image (a screenshot inset in a dark card) came in clamped to the whole image, stretched over the card. Image crops may now reach up to ten images' worth past the image's edges; the crop tool keeps a crop it makes inside the image, and slides an inset one without letting the image leave the box.

## Consequences

- On the kit, the frames whose difference came mostly from rings drop sharply (numbers in the pull request). The render parity suite's cells are unchanged or closer: its shadows all sit on opaque fills.
- A Drawpane document with a shadow on a layer that fills nothing visible draws differently: no spread, nothing under the layer. Figma draws those so; there are few such documents.
- Shadows cast from a layer's contents (a frame without fills over small children, a stroke-only vector) remain an approximation. Doing it exactly needs the layer drawn into a canvas of its own, as post effects are (decision 0008); not worth the cost at 500k layers until a file shows the difference.
