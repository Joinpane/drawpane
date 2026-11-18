/**
 * How much of the rasteriser's memory a headless render holds (decision
 * 0033), estimated before it's drawn, so a picture too large for it can be
 * drawn smaller instead of failing.
 *
 * resvg's memory is capped and a render past the cap traps. What a render
 * holds is a fixed part (the module itself, and the font files and images
 * it's handed, each copied in whole) and a part that grows with the
 * picture's pixels:
 *
 * - the picture itself, and its PNG as it's encoded;
 * - a layer the size of the whole picture for each group of layers drawn
 *   apart from what's under it: a frame that clips its children, a layer
 *   with children and opacity or a blend mode, a mask. Nested ones are held
 *   at once; one after another, one at a time. A single shape with opacity
 *   or a blend mode, and text, are drawn straight onto the picture;
 * - for a layer with a shadow, blur, glass, noise or texture, its own layer
 *   and the buffers its filter works in, the size of its paint.
 *
 * Bytes per pixel, measured on resvg 2.6.2 at 512 to 2048 px (uncapped, the
 * memory it grew to): a flat picture 8; a clip, a group or a mask 4.3 to 5
 * more each, up to 7.5 each twenty deep; a drop shadow as large as the
 * picture 12.6 more, an inner shadow 18.6, a blur on a shadow 5 more. A
 * 2048 × 2048 picture took 34 MiB flat, 54 MiB in a clipping frame and 107
 * MiB with a shadow in one. The estimate rounds each up, and on every case
 * measured it came out above what resvg took.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import { paintOutset } from "./export";
import type { Rect } from "./geometry";
import type { Scene } from "./scene";

/** What any render holds in resvg before its picture: the module's own memory and its glue. */
export const RASTER_BASE_BYTES = 2.5 * (1 << 20);

/** Per output pixel: the picture, and its PNG as it's encoded. */
const PICTURE = 8;
/** Per output pixel: a layer drawn apart (a clip, a group's opacity or blend mode, a mask). */
const LAYER = 5.5;
/** Per pixel of a layer's paint: a shadow's buffers (any number of shadows), or glass, noise or texture's. */
const FILTER = 15;
/** Per pixel of a layer's paint: a layer blur's buffers, on top of the others'. */
const BLUR = 6;

/**
 * Bytes per output pixel a render of these layers holds at most, over
 * `bounds` (the page rect drawn): the picture, and the deepest stack of
 * layers and filter buffers in it. The same at any scale.
 */
export function bytesPerPixel(scene: Scene, ids: readonly string[], bounds: Rect): number {
  const area = Math.max(1, bounds.width * bounds.height);
  /** The share of the picture a layer's paint covers, from 0 to 1. */
  const share = (node: NodeRecord): number => {
    const b = scene.bounds(node.id);
    if (!b) return 1;
    const o = paintOutset(node);
    const x0 = Math.max(bounds.x, b.x - o.left);
    const y0 = Math.max(bounds.y, b.y - o.top);
    const x1 = Math.min(bounds.x + bounds.width, b.x + b.width + o.right);
    const y1 = Math.min(bounds.y + bounds.height, b.y + b.height + o.bottom);
    return Math.min(1, (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / area);
  };
  const visible = (id: string) => {
    const node = scene.doc.get(id);
    return node && node.props.visible !== false ? node : null;
  };
  /** What a layer holds while it's drawn, its children's deepest included. */
  const held = (id: string): number => {
    const node = visible(id);
    if (!node) return 0;
    const children = scene.doc.childIds(id).filter((c) => visible(c));
    let own = 0;
    if (node.type !== "page") {
      const effects = getProp(node.props, "effects").filter((e) => e.visible !== false);
      let filter = effects.some((e) => e.type !== "layer-blur" && e.type !== "background-blur")
        ? FILTER
        : 0;
      if (effects.some((e) => e.type === "layer-blur")) filter += BLUR;
      // A filtered layer and its buffers are the size of its paint.
      if (filter > 0) own += (LAYER + filter) * share(node);
      if (children.length > 0) {
        if (node.type === "frame" && getProp(node.props, "clipContent")) own += LAYER;
        if (getProp(node.props, "opacity") < 1 || getProp(node.props, "blendMode") !== "normal")
          own += LAYER;
      }
    }
    if (children.some((c) => visible(c)?.props.isMask === true)) own += LAYER;
    let deepest = 0;
    for (const child of children) deepest = Math.max(deepest, held(child));
    return own + deepest;
  };
  let deepest = 0;
  for (const id of ids) deepest = Math.max(deepest, held(id));
  return PICTURE + deepest;
}
