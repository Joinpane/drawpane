/**
 * Fills under an opaque inside stroke. Drawn as the canvas draws them, a box's fill and its
 * inside stroke both end on the box's edge, each anti-aliased there: an edge pixel the box covers
 * a quarter of gets the fill at a quarter and the stroke at a quarter over it, 2c - c² in all
 * (about 0.44, not 0.25), a rim drawn heavier than Figma draws it. With flattening exact
 * (vendor/vello_common), that showed on every bordered control: the shadcn Carousel button's
 * edge pixel came out 98/255 where Figma has 64.
 *
 * An opaque stroke hides the fill under its band, so the fill can stop halfway under it: the
 * box's own edge is then the stroke's alone.
 */
import type { PathEntry } from "@drawpane/engine/wire";
import { getProp, type NodeRecord, type Paint } from "@drawpane/model";
import { fitCorners } from "../corner-geometry";
import { layerCorners } from "../corners";
import { isUniform, strokeWidths } from "../stroke-sides";

/** A paint that hides whatever is beneath it (render.ts `hidesWhatsUnder`). */
export function hidesWhatsUnder(paint: Paint): boolean {
  if (paint.visible === false || paint.type !== "solid" || (paint.opacity ?? 1) < 1) return false;
  if (!/^#[0-9a-f]{6}(ff)?$/i.test(paint.color.trim())) return false;
  const mode = paint.blendMode ?? "normal";
  if (mode === "normal") return true;
  const hex = paint.color.slice(1, 7).toLowerCase();
  if (hex === "ffffff") return ["linear-dodge", "screen", "lighten"].includes(mode);
  if (hex === "000000") return ["linear-burn", "multiply", "darken"].includes(mode);
  return false;
}

/**
 * The path a box's or ellipse's fills take when an opaque inside stroke covers its rim: the shape
 * shrunk by half the stroke's width (the middle of the stroke's band). `undefined` when the rim
 * isn't covered (fills take the shape), `null` when the stroke covers the whole shape.
 */
export function underRim(node: NodeRecord, w: number, h: number): PathEntry | null | undefined {
  if (node.type !== "rect" && node.type !== "frame" && node.type !== "ellipse") return undefined;
  if (getProp(node.props, "strokeAlign") !== "inside") return undefined;
  if (getProp(node.props, "strokeDashes").length > 0) return undefined;
  const sides = strokeWidths(node);
  if (!isUniform(sides) || !(sides[0] > 0)) return undefined;
  if (!getProp(node.props, "strokes").some(hidesWhatsUnder)) return undefined;
  const inset = sides[0] / 2;
  const iw = w - inset * 2;
  const ih = h - inset * 2;
  if (!(iw > 0 && ih > 0)) return null;
  if (node.type === "ellipse") return { kind: "oval", x: inset, y: inset, w: iw, h: ih };
  const { radii, smoothing } = layerCorners(node);
  const fitted = fitCorners(w, h, radii, smoothing);
  const r = (i: 0 | 1 | 2 | 3) => Math.max(0, fitted[i].radius - inset);
  return {
    kind: "box",
    x: inset,
    y: inset,
    w: iw,
    h: ih,
    radii: [r(0), r(1), r(2), r(3)],
    smoothing,
  };
}
