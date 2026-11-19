/**
 * What the editor builds on the corner geometry (corner-geometry.ts,
 * decision 0041): the outline cached per size, radii and smoothing, as SVG
 * path data, flattened for hit testing, split into pieces for dashes, and a
 * layer's corners read from its properties. Nothing here draws: the canvas's
 * own adapter is corners-canvas.ts.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import { type BoxCommand, boxCommands, fitCorners, type Radii } from "./corner-geometry";

export {
  type BoxCommand,
  boxCommands,
  cornerCubics,
  type FittedCorner,
  fitCorners,
  type Radii,
} from "./corner-geometry";

/** A box's outline as path commands (corner-geometry.ts). Shared and cached: never change one. */
export type BoxPath = readonly BoxCommand[];

/** What a path is drawn into: a Path2D, a canvas context, or anything shaped like them. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
  closePath(): void;
}

/**
 * The most outlines kept: a kit draws thousands of boxes, but most share a
 * few sizes (every button, every cell), so this holds a whole screen's.
 */
export const KEPT = 4096;
const kept = new Map<string, BoxPath>();

/** The cache key for a box's outline. */
export function keyOf(w: number, h: number, radii: Radii, smoothing: number): string {
  return `${w},${h},${radii[0]},${radii[1]},${radii[2]},${radii[3]},${smoothing}`;
}

/** Keeps `value` under `key`, forgetting the least recently used past `limit`. */
export function keep<V>(map: Map<string, V>, key: string, value: V, limit: number): V {
  if (map.size >= limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
  return value;
}

/** Looks `key` up, marking it most recently used. */
export function recall<V>(map: Map<string, V>, key: string): V | undefined {
  const hit = map.get(key);
  if (hit !== undefined) {
    map.delete(key);
    map.set(key, hit);
  }
  return hit;
}

/** The outline of a `w` × `h` box at the origin with these corners, cached by its inputs. */
export function boxPath(w: number, h: number, radii: Radii, smoothing = 0): BoxPath {
  const key = keyOf(w, h, radii, smoothing);
  return recall(kept, key) ?? keep(kept, key, boxCommands(w, h, radii, smoothing), KEPT);
}

/** True when the box has no rounded corner: its outline is the plain box. */
export function isSquare(radii: Radii): boolean {
  return !(radii[0] > 0 || radii[1] > 0 || radii[2] > 0 || radii[3] > 0);
}

/** Draws `path` into `sink`, moved by (dx, dy). */
export function tracePath(sink: PathSink, path: BoxPath, dx = 0, dy = 0): void {
  for (const c of path) {
    if (c[0] === "M") sink.moveTo(c[1] + dx, c[2] + dy);
    else if (c[0] === "L") sink.lineTo(c[1] + dx, c[2] + dy);
    else if (c[0] === "C")
      sink.bezierCurveTo(c[1] + dx, c[2] + dy, c[3] + dx, c[4] + dy, c[5] + dx, c[6] + dy);
    else sink.closePath();
  }
}

const n3 = (v: number) => String(Math.round(v * 1000) / 1000);

/** `path` as SVG path data, moved by (dx, dy), numbers through `n` (three decimals by default). */
export function pathData(path: BoxPath, dx = 0, dy = 0, n: (v: number) => string = n3): string {
  let d = "";
  tracePath(
    {
      moveTo: (x, y) => {
        d += `M${n(x)} ${n(y)}`;
      },
      lineTo: (x, y) => {
        d += `L${n(x)} ${n(y)}`;
      },
      bezierCurveTo: (x1, y1, x2, y2, x, y) => {
        d += `C${n(x1)} ${n(y1)} ${n(x2)} ${n(y2)} ${n(x)} ${n(y)}`;
      },
      closePath: () => {
        d += "Z";
      },
    },
    path,
    dx,
    dy,
  );
  return d;
}

/** A point on a cubic at `t`. */
function cubicAt(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  t: number,
): [number, number] {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const e = t * t * t;
  return [a * x0 + b * x1 + c * x2 + e * x3, a * y0 + b * y1 + c * y2 + e * y3];
}

/** A cubic's length, by summing a fine polyline (exact enough for dashes and hit testing). */
export function cubicLength(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  steps = 24,
): number {
  let len = 0;
  let px = x0;
  let py = y0;
  for (let i = 1; i <= steps; i++) {
    const [x, y] = cubicAt(x0, y0, x1, y1, x2, y2, x3, y3, i / steps);
    len += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return len;
}

/**
 * The outline as a polygon (closed, without repeating its first point),
 * each cubic cut into `steps` straight pieces: for hit testing.
 */
export function flattenBox(path: BoxPath, steps = 8): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  let cx = 0;
  let cy = 0;
  for (const c of path) {
    if (c[0] === "M" || c[0] === "L") {
      cx = c[1];
      cy = c[2];
      out.push({ x: cx, y: cy });
    } else if (c[0] === "C") {
      for (let j = 1; j <= steps; j++) {
        const [x, y] = cubicAt(cx, cy, c[1], c[2], c[3], c[4], c[5], c[6], j / steps);
        out.push({ x, y });
      }
      cx = c[5];
      cy = c[6];
    }
  }
  return out;
}

/** True when (x, y) is inside the polygon (nonzero; the outline is simple, so any rule agrees). */
function inside(poly: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as { x: number; y: number };
    const b = poly[j] as { x: number; y: number };
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** The distance from (x, y) to the polygon's outline. */
function distanceToOutline(
  poly: ReadonlyArray<{ x: number; y: number }>,
  x: number,
  y: number,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j] as { x: number; y: number };
    const b = poly[i] as { x: number; y: number };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
  }
  return best;
}

/**
 * True when (x, y), in the box's own units, lands on the box's shape or
 * within `reach` of its outline (a stroke's half width, a click's tolerance).
 */
export function hitsBox(
  w: number,
  h: number,
  radii: Radii,
  smoothing: number,
  x: number,
  y: number,
  reach: number,
): boolean {
  // Past the box grown by the reach: a miss, whatever the corners.
  if (x < -reach || y < -reach || x > w + reach || y > h + reach) return false;
  if (isSquare(radii)) return true;
  const corners = fitCorners(w, h, radii, smoothing);
  // Away from every corner's reach, the box is its own outline.
  const e = Math.max(corners[0].extent, corners[1].extent, corners[2].extent, corners[3].extent);
  if ((x >= e && x <= w - e) || (y >= e && y <= h - e)) return true;
  const poly = flattenBox(boxPath(w, h, radii, smoothing));
  return inside(poly, x, y) || distanceToOutline(poly, x, y) <= reach;
}

/**
 * The box's outline split for dashing (dashes.ts), as Figma splits it: each
 * segment of the outline on its own, so a straight edge, and each of a
 * smoothed corner's three curves (its easing curves and its arc), gets its
 * own whole number of dashes. A cubic piece is its start point, then six
 * numbers.
 */
export function boxPieces(
  w: number,
  h: number,
  radii: Radii,
  smoothing: number,
): Array<
  | { kind: "line"; x0: number; y0: number; x1: number; y1: number; length: number }
  | { kind: "cubic"; pts: number[]; length: number }
> {
  const out: Array<
    | { kind: "line"; x0: number; y0: number; x1: number; y1: number; length: number }
    | { kind: "cubic"; pts: number[]; length: number }
  > = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const lineTo = (x: number, y: number) => {
    const length = Math.hypot(x - cx, y - cy);
    if (length > 1e-6) out.push({ kind: "line", x0: cx, y0: cy, x1: x, y1: y, length });
    cx = x;
    cy = y;
  };
  for (const c of boxPath(w, h, radii, smoothing)) {
    if (c[0] === "M") {
      cx = sx = c[1];
      cy = sy = c[2];
    } else if (c[0] === "L") lineTo(c[1], c[2]);
    else if (c[0] === "C") {
      const length = cubicLength(cx, cy, c[1], c[2], c[3], c[4], c[5], c[6]);
      if (length > 1e-6)
        out.push({ kind: "cubic", pts: [cx, cy, ...c.slice(1)] as number[], length });
      cx = c[5];
      cy = c[6];
    } else lineTo(sx, sy);
  }
  // Start with the top edge, as the outline always has: the top-left corner's curves, which the
  // path draws first, go last.
  let lead = 0;
  while (lead < out.length - 1 && out[lead]?.kind === "cubic") lead++;
  return [...out.slice(lead), ...out.slice(0, lead)];
}

/** A rectangle's or frame's corner radii and smoothing (`cornerRadii` wins over `cornerRadius`). */
export function layerCorners(node: NodeRecord): { radii: Radii; smoothing: number } {
  const r = getProp(node.props, "cornerRadius");
  return {
    radii: getProp(node.props, "cornerRadii") ?? [r, r, r, r],
    smoothing: getProp(node.props, "cornerSmoothing"),
  };
}

/**
 * The radii of the box grown by `spread` on every side (shrunk when
 * negative), as shadows spread it: each rounded corner's radius as drawn,
 * plus the spread; square corners stay square.
 */
export function spreadRadii(
  w: number,
  h: number,
  radii: Radii,
  smoothing: number,
  spread: number,
): Radii {
  const fitted = fitCorners(w, h, radii, smoothing);
  return fitted.map((c) => (c.radius > 0 ? Math.max(0, c.radius + spread) : 0)) as unknown as Radii;
}

/**
 * The box's outline as SVG path data, its plain corners (smoothing 0) as SVG
 * arcs, as the canvas draws them (corners-canvas.ts); smoothed ones as
 * `pathData` gives them.
 */
export function arcPathData(
  w: number,
  h: number,
  radii: Radii,
  smoothing: number,
  dx = 0,
  dy = 0,
  n: (v: number) => string = n3,
): string {
  const corners = fitCorners(w, h, radii, smoothing);
  if (corners.some((c) => c.smoothing > 0))
    return pathData(boxPath(w, h, radii, smoothing), dx, dy, n);
  const [tl, tr, br, bl] = corners.map((c) => c.radius) as [number, number, number, number];
  const arc = (r: number, x: number, y: number) =>
    r > 0 ? `A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y)}` : "";
  return [
    `M${n(dx + tl)} ${n(dy)}`,
    `H${n(dx + w - tr)}`,
    arc(tr, dx + w, dy + tr),
    `V${n(dy + h - br)}`,
    arc(br, dx + w - br, dy + h),
    `H${n(dx + bl)}`,
    arc(bl, dx, dy + h - bl),
    `V${n(dy + tl)}`,
    arc(tl, dx + tl, dy),
    "Z",
  ].join("");
}
