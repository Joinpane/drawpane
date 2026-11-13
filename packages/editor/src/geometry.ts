/**
 * 2D geometry: affine matrices, rectangles, and node transforms.
 *
 * Coordinate spaces: a node's x/y/width/height describe its unrotated box in
 * the space of its nearest frame or page. Groups have no geometry of their
 * own; their children share the group's parent space. Rotation turns the box
 * about its centre; flips mirror it about its centre.
 */
import { getProp, type NodeRecord } from "@drawpane/model";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Affine matrix [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0) return IDENTITY;
  const inv = 1 / det;
  return [
    m[3] * inv,
    -m[1] * inv,
    -m[2] * inv,
    m[0] * inv,
    (m[2] * m[5] - m[3] * m[4]) * inv,
    (m[1] * m[4] - m[0] * m[5]) * inv,
  ];
}

export function apply(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function translate(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y];
}

export function rotate(degrees: number): Matrix {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, 0, 0];
}

export function scale(sx: number, sy = sx): Matrix {
  return [sx, 0, 0, sy, 0, 0];
}

/** The rotation of a matrix in degrees, in (-180, 180]. */
export function rotationOf(m: Matrix): number {
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
}

export function boxOf(node: NodeRecord): Box {
  const p = node.props;
  return {
    x: getProp(p, "x"),
    y: getProp(p, "y"),
    width: getProp(p, "width"),
    height: getProp(p, "height"),
    rotation: getProp(p, "rotation"),
    flipX: getProp(p, "flipX"),
    flipY: getProp(p, "flipY"),
  };
}

/** Maps a node's local box (0,0)-(w,h) into its parent space. */
export function localMatrix(box: Box): Matrix {
  const cx = box.width / 2;
  const cy = box.height / 2;
  let m = translate(box.x + cx, box.y + cy);
  if (box.rotation !== 0) m = multiply(m, rotate(box.rotation));
  if (box.flipX || box.flipY) m = multiply(m, scale(box.flipX ? -1 : 1, box.flipY ? -1 : 1));
  return multiply(m, translate(-cx, -cy));
}

export function rectCorners(r: Rect): [Point, Point, Point, Point] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
}

export function boundsOfPoints(points: Iterable<Point>): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Number.POSITIVE_INFINITY) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function unionRects(rects: Iterable<Rect>): Rect | null {
  return boundsOfPoints(
    (function* () {
      for (const r of rects) {
        yield { x: r.x, y: r.y };
        yield { x: r.x + r.width, y: r.y + r.height };
      }
    })(),
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Rounds to 2 decimals, which is as precise as the inspector shows and avoids float noise in files. */
/** An angle in degrees, in the range [-180, 180). */
export function normalizeDegrees(degrees: number): number {
  return round2(((((degrees + 180) % 360) + 360) % 360) - 180);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
