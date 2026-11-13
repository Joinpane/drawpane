/**
 * Pure editing operations on vector paths. Each returns a new path and never
 * mutates its input, so a drag can always recompute from where it started.
 */
import type { Point } from "../geometry";
import {
  type Anchor,
  type AnchorRef,
  anchorKey,
  anchorKind,
  type Subpath,
  segmentOf,
  splitCubic,
  type VectorPath,
} from "./path";

const shift = (p: Point | null, dx: number, dy: number) =>
  p ? { x: p.x + dx, y: p.y + dy } : null;

export function moveAnchor(a: Anchor, dx: number, dy: number): Anchor {
  return { x: a.x + dx, y: a.y + dy, in: shift(a.in, dx, dy), out: shift(a.out, dx, dy) };
}

export function replaceAnchor(path: VectorPath, ref: AnchorRef, next: Anchor): VectorPath {
  return path.map((sub, s) =>
    s !== ref.s
      ? sub
      : { closed: sub.closed, anchors: sub.anchors.map((a, i) => (i === ref.i ? next : a)) },
  );
}

/** Moves the selected anchors, with their handles, by a delta. */
export function moveAnchors(
  path: VectorPath,
  keys: ReadonlySet<string>,
  dx: number,
  dy: number,
): VectorPath {
  return path.map((sub, s) => ({
    closed: sub.closed,
    anchors: sub.anchors.map((a, i) => (keys.has(anchorKey({ s, i })) ? moveAnchor(a, dx, dy) : a)),
  }));
}

/**
 * Moves one handle. "mirror" keeps a smooth anchor smooth: the opposite
 * handle stays collinear, and keeps equal length when it was mirrored.
 * "free" (Alt) moves this handle alone, breaking the pair.
 */
export function setHandle(
  path: VectorPath,
  ref: AnchorRef,
  side: "in" | "out",
  p: Point,
  mode: "mirror" | "free",
): VectorPath {
  const sub = path[ref.s];
  const a = sub?.anchors[ref.i];
  if (!a) return path;
  const other = side === "in" ? a.out : a.in;
  const kind = anchorKind(a);
  let opposite = other;
  if (mode === "mirror" && other && (kind === "mirrored" || kind === "asymmetric")) {
    const vx = p.x - a.x;
    const vy = p.y - a.y;
    const len = Math.hypot(vx, vy);
    if (len > 1e-9) {
      const olen = kind === "mirrored" ? len : Math.hypot(other.x - a.x, other.y - a.y);
      opposite = { x: a.x - (vx / len) * olen, y: a.y - (vy / len) * olen };
    }
  }
  const handle = Math.hypot(p.x - a.x, p.y - a.y) < 1e-9 ? null : p;
  const next: Anchor =
    side === "in"
      ? { x: a.x, y: a.y, in: handle, out: opposite }
      : { x: a.x, y: a.y, in: opposite, out: handle };
  return replaceAnchor(path, ref, next);
}

/** Splits segment `i` of subpath `s` at `t`, keeping the curve's shape. Returns the new anchor's ref. */
export function insertAnchor(
  path: VectorPath,
  s: number,
  i: number,
  t: number,
): { path: VectorPath; ref: AnchorRef } {
  const sub = path[s];
  if (!sub) return { path, ref: { s, i } };
  const n = sub.anchors.length;
  const a = sub.anchors[i];
  const j = (i + 1) % n;
  const b = sub.anchors[j];
  if (!a || !b) return { path, ref: { s, i } };
  let na: Anchor;
  let nb: Anchor;
  let mid: Anchor;
  if (a.out === null && b.in === null) {
    mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, in: null, out: null };
    na = a;
    nb = b;
  } else {
    const [left, right] = splitCubic(segmentOf(a, b), t);
    na = { ...a, out: left.p1 };
    mid = { x: left.p3.x, y: left.p3.y, in: left.p2, out: right.p1 };
    nb = { ...b, in: right.p2 };
  }
  const anchors = sub.anchors.map((x, k) => (k === i ? na : k === j ? nb : x));
  anchors.splice(i + 1, 0, mid);
  const next = path.map((x, k) => (k === s ? { closed: sub.closed, anchors } : x));
  return { path: next, ref: { s, i: i + 1 } };
}

/**
 * Deletes anchors. Their neighbours join directly, keeping their own handles.
 * A subpath left with fewer than two anchors goes away.
 */
export function deleteAnchors(path: VectorPath, keys: ReadonlySet<string>): VectorPath {
  const out: Subpath[] = [];
  path.forEach((sub, s) => {
    const anchors = sub.anchors.filter((_, i) => !keys.has(anchorKey({ s, i })));
    if (anchors.length < 2) return;
    out.push({ closed: sub.closed, anchors });
  });
  return out;
}

/** Corner becomes smooth (mirrored handles along the neighbours' direction); smooth becomes corner. */
export function toggleSmooth(path: VectorPath, ref: AnchorRef): VectorPath {
  const sub = path[ref.s];
  const a = sub?.anchors[ref.i];
  if (!sub || !a) return path;
  if (a.in || a.out) return replaceAnchor(path, ref, { x: a.x, y: a.y, in: null, out: null });
  const n = sub.anchors.length;
  const prev = ref.i > 0 || sub.closed ? sub.anchors[(ref.i - 1 + n) % n] : undefined;
  const next = ref.i < n - 1 || sub.closed ? sub.anchors[(ref.i + 1) % n] : undefined;
  const from = prev ?? a;
  const to = next ?? a;
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return path;
  dx /= len;
  dy /= len;
  const dPrev = prev ? Math.hypot(a.x - prev.x, a.y - prev.y) : 0;
  const dNext = next ? Math.hypot(next.x - a.x, next.y - a.y) : 0;
  const count = (prev ? 1 : 0) + (next ? 1 : 0);
  const h = (dPrev + dNext) / (3 * Math.max(1, count));
  return replaceAnchor(path, ref, {
    x: a.x,
    y: a.y,
    in: { x: a.x - dx * h, y: a.y - dy * h },
    out: { x: a.x + dx * h, y: a.y + dy * h },
  });
}

/** Snaps `p` to the nearest 45° ray from `origin`, projecting onto it. */
export function snap45(origin: Point, p: Point): Point {
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const len = dx * ux + dy * uy;
  return { x: origin.x + ux * len, y: origin.y + uy * len };
}

/** Keeps only keys that still name an anchor (after undo or a teammate's edit). */
export function validKeys(path: VectorPath, keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const [s, i] = key.split(":").map(Number);
    return s !== undefined && i !== undefined && path[s]?.anchors[i] !== undefined;
  });
}
