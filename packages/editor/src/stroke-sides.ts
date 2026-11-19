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
import { cornerCubics, fitCorners } from "./corner-geometry";
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
  /**
   * Each corner's smoothing (corners.ts), the same order; missing is 0. A
   * smoothed corner's curve is the layer's own, stretched to its radii.
   */
  readonly smoothing?: readonly [number, number, number, number];
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
  smoothing = 0,
): { outer: RoundBox; inner: RoundBox | null } {
  // As the layer's own outline (corners.ts): each corner's radius and smoothing as drawn.
  const fitted = fitCorners(w, h, radii, smoothing);
  const r = fitted.map((c) => c.radius) as unknown as Sides;
  const smooth = fitted.map((c) => c.smoothing) as unknown as Sides;
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
      ...(smooth.some((v) => v > 0) ? { smoothing: smooth } : {}),
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

/**
 * One corner's curve as SVG cubics: `at` maps the corner's own frame (x
 * back along the edge coming in, y along the edge going out, in units of
 * its radius) to the box. Smoothed corners use corners.ts's curve for a
 * radius of 1, stretched; plain ones a quarter ellipse.
 */
function cornerPath(smoothing: number, at: (x: number, y: number) => string): string {
  if (smoothing <= 0) {
    const k = 1 - KAPPA;
    return `C${at(k, 0)} ${at(0, k)} ${at(0, 1)}`;
  }
  const c = cornerCubics({ radius: 1, smoothing, extent: 1 + smoothing });
  let d = "";
  for (let i = 0; i < c.length; i += 6)
    d += `C${at(c[i] as number, c[i + 1] as number)} ${at(c[i + 2] as number, c[i + 3] as number)} ${at(c[i + 4] as number, c[i + 5] as number)}`;
  return d;
}

/** A rounded box as SVG path data, clockwise from its top edge. */
export function roundBoxPath(box: RoundBox): string {
  const { x, y, width: w, height: h } = box;
  const [tl, tr, br, bl] = box.corners;
  const [stl = 0, str = 0, sbr = 0, sbl = 0] = box.smoothing ?? [];
  // How far each corner reaches along x and along y.
  const ext = (c: Corner, s: number) => [c[0] * (1 + s), c[1] * (1 + s)] as const;
  const [etl, etr, ebr, ebl] = [ext(tl, stl), ext(tr, str), ext(br, sbr), ext(bl, sbl)];
  const round = (c: Corner) => c[0] > 0 || c[1] > 0;
  const parts = [`M${n(x + etl[0])} ${n(y)}`, `H${n(x + w - etr[0])}`];
  // Each corner's frame: from its point, back along the incoming edge, along the outgoing one.
  if (round(tr))
    parts.push(cornerPath(str, (u, v) => `${n(x + w - u * tr[0])} ${n(y + v * tr[1])}`));
  parts.push(`V${n(y + h - ebr[1])}`);
  if (round(br))
    parts.push(cornerPath(sbr, (u, v) => `${n(x + w - v * br[0])} ${n(y + h - u * br[1])}`));
  parts.push(`H${n(x + ebl[0])}`);
  if (round(bl))
    parts.push(cornerPath(sbl, (u, v) => `${n(x + u * bl[0])} ${n(y + h - v * bl[1])}`));
  parts.push(`V${n(y + etl[1])}`);
  if (round(tl)) parts.push(cornerPath(stl, (u, v) => `${n(x + v * tl[0])} ${n(y + u * tl[1])}`));
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
