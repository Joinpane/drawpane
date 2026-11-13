/**
 * Exact bounds, transforms and box fitting for vector paths.
 */
import { apply, type Matrix, type Point, type Rect } from "../geometry";
import { type Anchor, type Cubic, cubicAt, segments, type VectorPath } from "./path";

/** Parameters in (0, 1) where one axis of a cubic has a local extremum. */
function extremaT(p0: number, p1: number, p2: number, p3: number, out: number[]): void {
  // Derivative / 3: a t² + b t + c.
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const eps = 1e-12;
  if (Math.abs(a) < eps) {
    if (Math.abs(b) > eps) {
      const t = -c / b;
      if (t > 0 && t < 1) out.push(t);
    }
    return;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return;
  const sq = Math.sqrt(disc);
  const t1 = (-b + sq) / (2 * a);
  const t2 = (-b - sq) / (2 * a);
  if (t1 > 0 && t1 < 1) out.push(t1);
  if (t2 > 0 && t2 < 1) out.push(t2);
}

/** Tight bounds of one cubic, from its endpoints and curve extrema (not its control points). */
export function cubicBounds(c: Cubic): Rect {
  let minX = Math.min(c.p0.x, c.p3.x);
  let maxX = Math.max(c.p0.x, c.p3.x);
  let minY = Math.min(c.p0.y, c.p3.y);
  let maxY = Math.max(c.p0.y, c.p3.y);
  const ts: number[] = [];
  extremaT(c.p0.x, c.p1.x, c.p2.x, c.p3.x, ts);
  extremaT(c.p0.y, c.p1.y, c.p2.y, c.p3.y, ts);
  for (const t of ts) {
    const p = cubicAt(c, t);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Tight bounds of a path, or null when it has no anchors. */
export function pathBounds(path: VectorPath): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const sub of path) for (const a of sub.anchors) add(a.x, a.y);
  if (minX === Number.POSITIVE_INFINITY) return null;
  for (const { a, b } of segments(path)) {
    if (a.out === null && b.in === null) continue;
    const c: Cubic = {
      p0: a,
      p1: a.out ?? a,
      p2: b.in ?? b,
      p3: b,
    };
    // Skip the extrema solve when the control points are already inside.
    if (
      c.p1.x >= minX &&
      c.p1.x <= maxX &&
      c.p2.x >= minX &&
      c.p2.x <= maxX &&
      c.p1.y >= minY &&
      c.p1.y <= maxY &&
      c.p2.y >= minY &&
      c.p2.y <= maxY
    )
      continue;
    const r = cubicBounds(c);
    add(r.x, r.y);
    add(r.x + r.width, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Maps every anchor and handle through an affine matrix (exact for Béziers). */
export function transformPath(path: VectorPath, m: Matrix): VectorPath {
  const map = (p: Point | null) => (p ? apply(m, p) : null);
  return path.map((sub) => ({
    closed: sub.closed,
    anchors: sub.anchors.map((a): Anchor => {
      const p = apply(m, a);
      return { x: p.x, y: p.y, in: map(a.in), out: map(a.out) };
    }),
  }));
}

export function translatePath(path: VectorPath, dx: number, dy: number): VectorPath {
  return transformPath(path, [1, 0, 0, 1, dx, dy]);
}

/**
 * Normalizes a path to its own box: translates it so its exact bounds start
 * at 0,0. Returns the moved path and where its bounds were.
 */
export function fitPath(path: VectorPath): { path: VectorPath; bounds: Rect } {
  const bounds = pathBounds(path) ?? { x: 0, y: 0, width: 0, height: 0 };
  if (bounds.x === 0 && bounds.y === 0) return { path, bounds };
  return { path: translatePath(path, -bounds.x, -bounds.y), bounds };
}
