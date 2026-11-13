/**
 * The editable form of a vector path: subpaths of anchors, each with optional
 * in and out handles. Every segment is a cubic Bézier (a line when neither end
 * has a handle), so SVG lines, quadratics, smooth curves and arcs all become
 * the same structure. Coordinates are in the node's local box.
 */
import type { Point } from "../geometry";

export interface Anchor {
  readonly x: number;
  readonly y: number;
  /** Incoming control point (absolute), or null for none (the anchor itself). */
  readonly in: Point | null;
  /** Outgoing control point (absolute), or null for none. */
  readonly out: Point | null;
}

export interface Subpath {
  readonly anchors: readonly Anchor[];
  readonly closed: boolean;
}

export type VectorPath = readonly Subpath[];

/** Addresses one anchor: subpath index and anchor index. */
export interface AnchorRef {
  readonly s: number;
  readonly i: number;
}

/** A stable string key for an anchor, for selection sets. */
export function anchorKey(ref: AnchorRef): string {
  return `${ref.s}:${ref.i}`;
}

export function parseAnchorKey(key: string): AnchorRef | null {
  const m = /^(\d+):(\d+)$/.exec(key);
  if (!m) return null;
  return { s: Number(m[1]), i: Number(m[2]) };
}

/** The four control points of the segment that leaves anchor `a` and arrives at `b`. */
export interface Cubic {
  readonly p0: Point;
  readonly p1: Point;
  readonly p2: Point;
  readonly p3: Point;
}

export function segmentOf(a: Anchor, b: Anchor): Cubic {
  return {
    p0: { x: a.x, y: a.y },
    p1: a.out ?? { x: a.x, y: a.y },
    p2: b.in ?? { x: b.x, y: b.y },
    p3: { x: b.x, y: b.y },
  };
}

/** Number of segments in a subpath: n-1 when open, n when closed. */
export function segmentCount(sub: Subpath): number {
  const n = sub.anchors.length;
  if (n < 2) return 0;
  return sub.closed ? n : n - 1;
}

/** Visits every segment with its subpath and starting anchor index. */
export function* segments(
  path: VectorPath,
): Generator<{ s: number; i: number; a: Anchor; b: Anchor }> {
  for (let s = 0; s < path.length; s++) {
    const sub = path[s] as Subpath;
    const n = sub.anchors.length;
    const count = segmentCount(sub);
    for (let i = 0; i < count; i++) {
      yield { s, i, a: sub.anchors[i] as Anchor, b: sub.anchors[(i + 1) % n] as Anchor };
    }
  }
}

/** Evaluates a cubic at t. */
export function cubicAt(c: Cubic, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const d = 3 * mt * t * t;
  const e = t * t * t;
  return {
    x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x,
    y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y,
  };
}

/** Splits a cubic at t (de Casteljau). */
export function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (p: Point, q: Point): Point => ({
    x: p.x + (q.x - p.x) * t,
    y: p.y + (q.y - p.y) * t,
  });
  const p01 = lerp(c.p0, c.p1);
  const p12 = lerp(c.p1, c.p2);
  const p23 = lerp(c.p2, c.p3);
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  const mid = lerp(p012, p123);
  return [
    { p0: c.p0, p1: p01, p2: p012, p3: mid },
    { p0: mid, p1: p123, p2: p23, p3: c.p3 },
  ];
}

/** How an anchor's handles relate: none or one handle, independent, collinear or mirrored. */
export type AnchorKind = "corner" | "free" | "asymmetric" | "mirrored";

const COLLINEAR_EPS = 1e-3;

export function anchorKind(a: Anchor): AnchorKind {
  if (!a.in || !a.out) return "corner";
  const ix = a.in.x - a.x;
  const iy = a.in.y - a.y;
  const ox = a.out.x - a.x;
  const oy = a.out.y - a.y;
  const li = Math.hypot(ix, iy);
  const lo = Math.hypot(ox, oy);
  if (li < 1e-9 || lo < 1e-9) return "corner";
  // Opposite directions: the cross product is ~0 and the dot product negative.
  const cross = (ix * oy - iy * ox) / (li * lo);
  const dot = (ix * ox + iy * oy) / (li * lo);
  if (Math.abs(cross) > COLLINEAR_EPS || dot > 0) return "free";
  return Math.abs(li - lo) <= Math.max(0.01, 1e-3 * Math.max(li, lo)) ? "mirrored" : "asymmetric";
}
