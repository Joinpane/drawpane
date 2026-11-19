# 0038. Linear dodge and burn, and shadows that blend

- Status: accepted
- Date: 2026-11-18
- Deciders: Ziyang (lead maintainer)

## Context

Apple builds its "vibrant" colours with two blend modes Drawpane didn't have: linear dodge and linear burn, Figma's "Plus lighter" and "Plus darker" (Apple's plus-lighter and plus-darker). Measured on a large iOS UI kit (decision 0030), they're everywhere: on 1,141 and 1,129 layers, on 2,000 paints, and on the shadows Apple stacks inside its glass (160 inner shadows by linear dodge, 35 by burn, 112 drop shadows by burn). The importer drew them as colour dodge and colour burn, which look nothing alike, and dropped effects' blend modes, so a dark grey shadow that Apple adds as a faint highlight came out as a dark rim. Together that was about an eighth of the kit's difference from Figma.

What Figma draws, read from its renders of a parity suite built for it (`tools/figma-parity/scenes/linear-blends.json`: greys over grey bands at several opacities, over half-opaque and empty backdrops):

- On premultiplied colour `c` with alpha `a`, the source `s` over the backdrop `b`, the alpha is normal blending's, `as + ab - as·ab`, and
  - linear dodge: `c = min(a, cs + cb)`;
  - linear burn: `c = max(0, cs + cb - as·ab)`.
- Over an opaque backdrop that's `cb + cs` clamped at 1, and `cb + cs - as` clamped at 0: a #606060 paint at 50% over #808080 is 48, where the W3C formula (blending the unpremultiplied colours, then mixing by alpha) gives 64. Over nothing, both are the source.
- Layers and paints blend the same way; a layer's opacity is its source alpha, as a paint's is.
- A frame faded by its opacity doesn't cut its layers off from what's under it: a layer blending inside it blends with what's under the frame (Figma's frames pass blending through unless they set a mode of their own).

## Decision

1. **Two more blend modes**, `linear-dodge` and `linear-burn`, for layers and paints, and a blend mode on drop and inner shadows (missing means normal). The importers bring Figma's (REST and `.fig`) as they are; every other Figma mode already maps to its own. SVG import reads CSS's `plus-lighter` and `plus-darker`. The inspector names them as Figma does.
2. **The canvas renderer draws them exactly:**
   - linear dodge is the canvas's `lighter` on a canvas known to be opaque (the screen, an export with an opaque background). Where both pictures are partly see-through, `lighter` adds the alphas where Figma keeps normal blending's: a component's translucent fills over nothing came out opaque and dark (a page control's glass: 105 where Figma has 162). So elsewhere it's drawn apart, exactly: the sum laid on black (an opaque picture of the premultiplied colour), clamped by normal blending's alpha as a grey (darken), divided by it (colour-dodge by its inverse) and multiplied back (destination-in);
   - linear burn has no canvas mode, but it's linear dodge between the two pictures' inverses, inverted back (`filter: invert(1)` inverts colour and keeps alpha). What's under the drawing is copied inverted into a scratch canvas, the drawing is made apart and added inverted, and the result goes back inverted, through the canvas's clip; on a canvas that may be see-through, through the exact steps above.
   - Bounded by the drawing's box and the canvas; the scratch canvases are kept while they fit (`BlendApart`, `linear-blend.ts`; see the revision below).
   - A layer blending linearly is drawn as one picture first (the post effects' canvas, decision 0008) when its parts overlap, and always for burn; a lone fill blends in place.
   - Shadows with a blend mode are drawn apart and then blended in, whatever the mode: Chrome blends a shadow cast from a shape drawn off the canvas (how shadows are drawn without their shape) as nothing.
   - Paints blend on strokes and text too now, not only fills; text with a burnt paint draws one paint at a time.
   - A layer that fades as one picture and holds something that blends is drawn over a copy of what's under it, then faded over it, as Figma's pass-through frames are. For layers that don't blend that is the same picture, so only those are drawn this way.
3. **SVG export and the headless renderer** (resvg) build them from blends every renderer has: CSS's `plus-lighter` isn't in resvg (nor `plus-darker` anywhere but Safari), `feComposite operator="arithmetic"`, SVG's way to add two pictures, traps in resvg's WebAssembly build, and a filter that brings the source and the backdrop together holds a buffer per step, past resvg's memory at 2x for a layer of any size. On opaque pictures blends are plain arithmetic: the backdrop's copy (inverted for burn, by a white difference), the source laid on black (its inverse for burn) at half opacity over it gives their average, and mid grey by colour-dodge doubles it, clamped at 1 (inverted back for burn). That's exact where the backdrop is opaque; where it's empty both modes give the source as it is. So the sum is drawn masked by the backdrop's alpha and the source masked by the rest (`svg-linear.ts`): exact where the backdrop is opaque or empty, as on the canvas, within two levels of Figma's renders. The backdrop is what's drawn under the layer in its group (a frame's clip doesn't cut it off, as on the canvas), moved into `<defs>` and copied by reference. Faded layers holding something that blends get a copy of what's under them first, as on the canvas. Paints that blend on strokes now do too; on text they stay as SVG export had them (not covered).

## Consequences

- On the iOS kit, numbers in the pull request.
- Documents made in Drawpane draw as before, except text and stroke paints with a blend mode (now blended, as Figma does) and faded frames holding blended layers (now blended with what's under them, as Figma does).
- Linear burn costs two copies of the drawing's box per burnt drawing; a burnt layer also a canvas of its own. Bounded, and only where burn is used.

## Revision: burn in place on an opaque canvas (2026-11-19)

Burn over an opaque canvas copied the box under the drawing into a scratch canvas (`drawImage` from the screen). Chromium snapshots a canvas that's drawn from and copies all of it on the next draw into it, so every burnt drawing on screen cost a copy of the whole 2880 × 1800 canvas, not of its box. A large iOS UI kit lights each glass control with three blended inner shadows and many shapes with burnt hairline shadows: a profile of dragging a layer in one of its glass boards put 30 of 51 seconds in those copies, and switching to its heaviest page took minutes to come out exact.

- On a canvas known to be opaque, burn is now drawn in place: the box under the drawing is inverted (a white `difference`: the canvas stays opaque), the drawing, inverted, is added (`lighter`), and the box is inverted back, within the canvas's clip. That's the same arithmetic as before, in the same 8-bit steps, without reading the canvas into another.
- The scratch canvases are kept while they fit and are at most four times the size needed (as the post effects' are, decision 0028's revision), so a scratch canvas grown once for a whole screen no longer costs that copy for every small blend drawn through it after.
- Only what differs is copied into the scratch canvas's state (a font or filter set again is parsed again).

Canvases that may be see-through (exports over transparency) still go through the exact steps above. Numbers in the pull request.
