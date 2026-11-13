/**
 * Geometric hit testing for paths, without a canvas: fills by winding number
 * over flattened curves, strokes by distance. Runs the same in browsers,
 * Workers and Node.
 */
import type { Point } from "../geometry";
import { Lru, parsePathCached } from "./cache";
import { type Cubic, cubicAt, segmentOf, segments, type VectorPath } from "./path";

/** A subpath flattened to a polyline: x0,y0,x1,y1,... */
interface Ring {
  readonly points: Float64Array;
  readonly closed: boolean;
}

function cubicSteps(c: Cubic): number {
  const len =
    Math.hypot(c.p1.x - c.p0.x, c.p1.y - c.p0.y) +
    Math.hypot(c.p2.x - c.p1.x, c.p2.y - c.p1.y) +
    Math.hypot(c.p3.x - c.p2.x, c.p3.y - c.p2.y);
  return Math.max(4, Math.min(64, Math.ceil(Math.sqrt(len) * 2)));
}

export function flattenPath(path: VectorPath): Ring[] {
  const rings: Ring[] = [];
  for (const sub of path) {
    const pts: number[] = [];
    const n = sub.anchors.length;
    if (n === 0) continue;
    const first = sub.anchors[0];
    if (!first) continue;
    pts.push(first.x, first.y);
    const count = n < 2 ? 0 : sub.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const a = sub.anchors[i];
      const b = sub.anchors[(i + 1) % n];
      if (!a || !b) continue;
      if (a.out === null && b.in === null) {
        pts.push(b.x, b.y);
        continue;
      }
      const c = segmentOf(a, b);
      const steps = cubicSteps(c);
      for (let k = 1; k <= steps; k++) {
        const p = cubicAt(c, k / steps);
        pts.push(p.x, p.y);
      }
    }
    rings.push({ points: Float64Array.from(pts), closed: sub.closed });
  }
  return rings;
}

const flattened = new Lru<Ring[]>();

function flattenCached(d: string): Ring[] {
  return flattened.get(d, () => flattenPath(parsePathCached(d)));
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

export interface PathHitOptions {
  /** Test the inside of closed subpaths. Open subpaths are only ever hit on their stroke. */
  readonly fill: boolean;
  readonly fillRule: "nonzero" | "evenodd";
  /** Distance from the centreline that counts as a stroke hit. */
  readonly strokeReach: number;
}

/** True when local point `p` hits the path's fill or stroke. */
export function hitPathData(d: string, p: Point, options: PathHitOptions): boolean {
  return hitRings(flattenCached(d), p, options);
}

export function hitRings(rings: readonly Ring[], p: Point, options: PathHitOptions): boolean {
  const reachSq = options.strokeReach * options.strokeReach;
  let winding = 0;
  let crossings = 0;
  for (const ring of rings) {
    const pts = ring.points;
    const n = pts.length / 2;
    if (n === 1) {
      const dx = (pts[0] as number) - p.x;
      const dy = (pts[1] as number) - p.y;
      if (dx * dx + dy * dy <= reachSq) return true;
      continue;
    }
    const edges = ring.closed ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      const j = (i + 1) % n;
      const ax = pts[i * 2] as number;
      const ay = pts[i * 2 + 1] as number;
      const bx = pts[j * 2] as number;
      const by = pts[j * 2 + 1] as number;
      if (distToSegmentSq(p.x, p.y, ax, ay, bx, by) <= reachSq) return true;
      if (!options.fill || !ring.closed) continue;
      if (ay <= p.y) {
        if (by > p.y && (bx - ax) * (p.y - ay) - (p.x - ax) * (by - ay) > 0) {
          winding++;
          crossings++;
        }
      } else if (by <= p.y && (bx - ax) * (p.y - ay) - (p.x - ax) * (by - ay) < 0) {
        winding--;
        crossings++;
      }
    }
  }
  if (!options.fill) return false;
  return options.fillRule === "evenodd" ? crossings % 2 === 1 : winding !== 0;
}

export interface NearestPoint {
  readonly s: number;
  /** Index of the segment's starting anchor. */
  readonly i: number;
  readonly t: number;
  readonly point: Point;
  readonly distance: number;
}

const SAMPLES = 24;

function coarse(c: Cubic, p: Point): { t: number; d: number } {
  let bestT = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let k = 0; k <= SAMPLES; k++) {
    const t = k / SAMPLES;
    const q = cubicAt(c, t);
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  return { t: bestT, d: bestD };
}

function refine(c: Cubic, p: Point, t0: number): { t: number; point: Point; distance: number } {
  // Ternary search around the best sample; the distance is unimodal there.
  let lo = Math.max(0, t0 - 1 / SAMPLES);
  let hi = Math.min(1, t0 + 1 / SAMPLES);
  for (let iter = 0; iter < 48; iter++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const q1 = cubicAt(c, m1);
    const q2 = cubicAt(c, m2);
    const d1 = (q1.x - p.x) ** 2 + (q1.y - p.y) ** 2;
    const d2 = (q2.x - p.x) ** 2 + (q2.y - p.y) ** 2;
    if (d1 < d2) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2;
  const point = cubicAt(c, t);
  return { t, point, distance: Math.hypot(point.x - p.x, point.y - p.y) };
}

/** The closest point on any segment of the path to `p`. */
export function nearestOnPath(path: VectorPath, p: Point): NearestPoint | null {
  // Sample every segment coarsely, then refine only the few closest candidates.
  const candidates: Array<{ s: number; i: number; c: Cubic; t: number; d: number }> = [];
  for (const { s, i, a, b } of segments(path)) {
    const c = segmentOf(a, b);
    const r = coarse(c, p);
    candidates.push({ s, i, c, t: r.t, d: r.d });
  }
  candidates.sort((x, y) => x.d - y.d);
  let best: NearestPoint | null = null;
  for (const cand of candidates.slice(0, 3)) {
    const r = refine(cand.c, p, cand.t);
    if (!best || r.distance < best.distance) best = { s: cand.s, i: cand.i, ...r };
  }
  return best;
}
