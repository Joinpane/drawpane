/**
 * Strokes with a width per side (`strokeWeights`, Figma's individual stroke
 * weights): a list row's bottom border, a sidebar's divider, a card with a
 * thick top accent.
 *
 * Such a stroke is the region between two rounded boxes: inside, the layer's
 * box and the box inset by each side's width; centred, the two halfway out
 * and in; outside, the box outset by each width and the box itself. A corner
 * between sides of different widths shrinks (inside) or grows (outside) by
 * each side's width along its own axis, so its inner curve is elliptical, as
 * in Figma; a square corner stays square. One even-odd path draws it on the
 * canvas and in SVG alike.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import { KAPPA } from "./vector/shapes";

/** Stroke widths: top, right, bottom, left (CSS's order). */
export type Sides = readonly [number, number, number, number];

/** A corner's radii along x and y. */
type Corner = readonly [number, number];

/** A box with its own radii at each corner: top-left, top-right, bottom-right, bottom-left. */
export interface RoundBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly corners: readonly [Corner, Corner, Corner, Corner];
}

/** A layer's stroke widths per side: its own where it has them, else its one width all round. */
export function strokeWidths(node: NodeRecord): Sides {
  if (node.type === "rect" || node.type === "frame") {
    const sides = getProp(node.props, "strokeWeights");
    if (sides) return sides;
  }
  const w = getProp(node.props, "strokeWeight");
  return [w, w, w, w];
}

/** True when every side is as wide: an ordinary stroke draws it exactly. */
export function isUniform(sides: Sides): boolean {
  return sides[0] === sides[1] && sides[1] === sides[2] && sides[2] === sides[3];
}

/**
 * The region a per-side stroke covers, as the box it's drawn out to and the
 * box it's drawn in to (null when the widths meet in the middle, so the
 * region is the whole outer box).
 */
export function strokeRegion(
  w: number,
  h: number,
  radii: readonly [number, number, number, number],
  sides: Sides,
  align: "inside" | "center" | "outside",
): { outer: RoundBox; inner: RoundBox | null } {
  // As the layer's own outline: no corner rounder than half the shorter side.
  const max = Math.min(w, h) / 2;
  const r = radii.map((v) => Math.max(0, Math.min(v, max))) as unknown as Sides;
  /** The box inset by `k` of each side's width (outset where k is negative). */
  const at = (k: number): RoundBox | null => {
    // `|| 0`: a side of no width, scaled by a negative share, is 0, not −0.
    const [t, rt, b, l] = sides.map((s) => s * k || 0) as unknown as Sides;
    const width = w - l - rt;
    const height = h - t - b;
    if (width <= 1e-9 || height <= 1e-9) return null;
    // A rounded corner moves with the sides beside it; a square one stays square.
    const corner = (radius: number, dx: number, dy: number): Corner =>
      radius > 0
        ? [
            Math.min(Math.max(0, radius - dx), width / 2),
            Math.min(Math.max(0, radius - dy), height / 2),
          ]
        : [0, 0];
    return {
      x: l,
      y: t,
      width,
      height,
      corners: [corner(r[0], l, t), corner(r[1], rt, t), corner(r[2], rt, b), corner(r[3], l, b)],
    };
  };
  const [outerK, innerK] = align === "inside" ? [0, 1] : align === "center" ? [-0.5, 0.5] : [-1, 0];
  const outer = at(outerK) ?? {
    x: 0,
    y: 0,
    width: w,
    height: h,
    corners: [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  };
  return { outer, inner: at(innerK) };
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** A rounded box as SVG path data, clockwise from its top edge. */
export function roundBoxPath(box: RoundBox): string {
  const { x, y, width: w, height: h } = box;
  const [tl, tr, br, bl] = box.corners;
  const k = 1 - KAPPA;
  const parts = [`M${n(x + tl[0])} ${n(y)}`, `H${n(x + w - tr[0])}`];
  if (tr[0] > 0 || tr[1] > 0)
    parts.push(
      `C${n(x + w - tr[0] * k)} ${n(y)} ${n(x + w)} ${n(y + tr[1] * k)} ${n(x + w)} ${n(y + tr[1])}`,
    );
  parts.push(`V${n(y + h - br[1])}`);
  if (br[0] > 0 || br[1] > 0)
    parts.push(
      `C${n(x + w)} ${n(y + h - br[1] * k)} ${n(x + w - br[0] * k)} ${n(y + h)} ${n(x + w - br[0])} ${n(y + h)}`,
    );
  parts.push(`H${n(x + bl[0])}`);
  if (bl[0] > 0 || bl[1] > 0)
    parts.push(
      `C${n(x + bl[0] * k)} ${n(y + h)} ${n(x)} ${n(y + h - bl[1] * k)} ${n(x)} ${n(y + h - bl[1])}`,
    );
  parts.push(`V${n(y + tl[1])}`);
  if (tl[0] > 0 || tl[1] > 0)
    parts.push(`C${n(x)} ${n(y + tl[1] * k)} ${n(x + tl[0] * k)} ${n(y)} ${n(x + tl[0])} ${n(y)}`);
  parts.push("Z");
  return parts.join("");
}

/** A per-side stroke as SVG path data, to fill with the even-odd rule. */
export function strokeRegionPath(region: { outer: RoundBox; inner: RoundBox | null }): string {
  return roundBoxPath(region.outer) + (region.inner ? roundBoxPath(region.inner) : "");
}

/** How far a stroke reaches past each side of the box (top, right, bottom, left). */
export function strokeReach(sides: Sides, align: "inside" | "center" | "outside"): Sides {
  const k = align === "outside" ? 1 : align === "center" ? 0.5 : 0;
  return sides.map((s) => s * k || 0) as unknown as Sides;
}
