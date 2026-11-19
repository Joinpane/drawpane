import { getProp, type NodeRecord } from "@drawpane/model";

/**
 * Rounded and smoothed box corners, as Figma draws them (decision 0040):
 * the one outline every consumer of a rectangle's or frame's shape uses,
 * so fills, strokes, clips, shadows, glass, masks, hit testing, outlines and
 * every export agree.
 *
 * Each corner is Figma's squircle construction: with smoothing `s` (0 to 1)
 * a corner of radius `R` reaches `(1 + s) R` along both edges, as a cubic
 * that eases off the edge, a circular arc of 90 (1 − s) degrees (one cubic,
 * as Figma's own geometry has it), and a cubic easing back onto the other
 * edge. At `s = 0` it is a plain quarter circle.
 *
 * Space is shared out per corner: along each edge, a corner may use the
 * edge's length in proportion to its radius against the radius at the
 * edge's other end, and its budget is the smaller of its two edges' shares.
 * The radius is cut to the budget first, then the smoothing, so the corner
 * never reaches past it (Figma lowers the smoothing rather than distorting
 * the curve). A uniform radius so gets half the shorter side, as before;
 * one large corner beside square ones can reach further.
 *
 * Checked against Figma's own fill geometry for several hundred boxes
 * (test/corners.test.ts, fixture test/fixtures/figma-corners.json).
 */

/** Radii per corner: top left, top right, bottom right, bottom left. */
export type Radii = readonly [number, number, number, number];

/** One corner as drawn. */
export interface FittedCorner {
  /** Its radius, cut to the space it has. */
  readonly radius: number;
  /** Its smoothing, cut to the space it has (0 to 1). */
  readonly smoothing: number;
  /** How far it reaches along each of its edges from the box's corner: `(1 + smoothing) × radius`. */
  readonly extent: number;
}

/**
 * A box outline as path commands: `ops` has one letter per command (`M`,
 * `L`, `C`, `Z`) and `pts` their coordinates in order (two for `M` and `L`,
 * six for `C`). Clockwise from the top-left corner's end on the left edge.
 * Shared and cached: never change one.
 */
export interface BoxPath {
  readonly ops: string;
  readonly pts: readonly number[];
}

/** What draws a path: a Path2D, a canvas context, or anything shaped like them. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
  closePath(): void;
}

const clampUnit = (v: number) => (v > 0 ? Math.min(v, 1) : 0);
const nonNegative = (v: number) => (v > 0 && Number.isFinite(v) ? v : 0);

/** A corner's share of an edge `length` long, against the radius at the edge's other end. */
function share(r: number, other: number, length: number): number {
  const sum = r + other;
  return sum > 0 ? (length * r) / sum : 0;
}

/** The corners as drawn on a `w` × `h` box: radii and smoothing cut to the space each has. */
export function fitCorners(
  w: number,
  h: number,
  radii: Radii,
  smoothing: number,
): readonly [FittedCorner, FittedCorner, FittedCorner, FittedCorner] {
  const W = nonNegative(w);
  const H = nonNegative(h);
  const [tl, tr, br, bl] = radii.map(nonNegative) as unknown as Radii;
  const s = clampUnit(smoothing);
  const fit = (r: number, alongX: number, alongY: number): FittedCorner => {
    if (r <= 0) return { radius: 0, smoothing: 0, extent: 0 };
    const budget = Math.min(share(r, alongX, W), share(r, alongY, H));
    const radius = Math.min(r, budget);
    if (radius <= 0) return { radius: 0, smoothing: 0, extent: 0 };
    const smooth = Math.max(0, Math.min(s, budget / radius - 1));
    return { radius, smoothing: smooth, extent: Math.min((1 + smooth) * radius, budget) };
  };
  return [fit(tl, tr, bl), fit(tr, tl, br), fit(br, bl, tr), fit(bl, br, tl)];
}

/**
 * One corner's curve, in a frame where the corner is at the origin, `x` is
 * the distance back along the edge coming in and `y` the distance along the
 * edge going out: a list of cubics (six numbers each) from (extent, 0) to
 * (0, extent). Empty for a square corner.
 */
export function cornerCubics(corner: FittedCorner): number[] {
  const { radius: R, smoothing: s, extent: p } = corner;
  if (R <= 0) return [];
  const deg = Math.PI / 180;
  // Figma's construction (its "Desperately seeking squircles"): the arc keeps 90 (1 − s)
  // degrees, the rest of the turn goes to the two easing curves.
  const arcAngle = 90 * (1 - s);
  const arcChord = Math.sin((arcAngle / 2) * deg) * R * Math.SQRT2;
  const alpha = (90 - arcAngle) / 2;
  const p3ToP4 = R * Math.tan((alpha / 2) * deg);
  const beta = 45 * s;
  const c = p3ToP4 * Math.cos(beta * deg);
  const d = c * Math.tan(beta * deg);
  const b = (p - arcChord - c - d) / 3;
  const a = 2 * b;
  const out: number[] = [];
  // The easing curve off the incoming edge, from (p, 0) to the arc's start.
  const x3 = p - a - b - c;
  if (p - x3 > 1e-9 || d > 1e-9) out.push(p - a, 0, p - a - b, 0, x3, d);
  // The arc, centred on (R, R), from (x3, d) to (d, x3), as one cubic.
  const sweep = arcAngle * deg;
  if (sweep > 1e-9) {
    const k = (4 / 3) * Math.tan(sweep / 4) * R;
    // Unit tangents along the direction of travel: at the start, perpendicular to the radius.
    const sx = x3 - R;
    const sy = d - R;
    const ex = d - R;
    const ey = x3 - R;
    const sl = Math.hypot(sx, sy) || 1;
    const el = Math.hypot(ex, ey) || 1;
    // Travel goes from the incoming edge toward the outgoing one (x falls, y rises).
    const t0x = sy / sl;
    const t0y = -sx / sl;
    const t1x = ey / el;
    const t1y = -ex / el;
    out.push(x3 + t0x * k, d + t0y * k, d - t1x * k, x3 - t1y * k, d, x3);
  }
  // The easing curve back onto the outgoing edge, to (0, p).
  if (p - x3 > 1e-9 || d > 1e-9) out.push(0, p - a - b, 0, p - a, 0, p);
  return out;
}

/** The outline of a `w` × `h` box at the origin. */
function buildBoxPath(w: number, h: number, radii: Radii, smoothing: number): BoxPath {
  const corners = fitCorners(w, h, radii, smoothing);
  let ops = "";
  const pts: number[] = [];
  // Corner origin and the unit vectors for its frame: `u` points back along the incoming
  // edge (+x), `v` along the outgoing edge (+y). Clockwise, starting with the top left.
  const frames = [
    [0, 0, 0, 1, 1, 0],
    [w, 0, -1, 0, 0, 1],
    [w, h, 0, -1, -1, 0],
    [0, h, 1, 0, 0, -1],
  ] as const;
  for (let i = 0; i < 4; i++) {
    const corner = corners[i] as FittedCorner;
    const [ox, oy, ux, uy, vx, vy] = frames[i] as (typeof frames)[number];
    const at = (x: number, y: number) => [ox + ux * x + vx * y, oy + uy * x + vy * y] as const;
    const [sx, sy] = at(corner.extent, 0);
    if (i === 0) {
      ops += "M";
      pts.push(sx, sy);
    } else {
      ops += "L";
      pts.push(sx, sy);
    }
    const cubics = cornerCubics(corner);
    for (let j = 0; j < cubics.length; j += 6) {
      const [x1, y1] = at(cubics[j] as number, cubics[j + 1] as number);
      const [x2, y2] = at(cubics[j + 2] as number, cubics[j + 3] as number);
      const [x, y] = at(cubics[j + 4] as number, cubics[j + 5] as number);
      ops += "C";
      pts.push(x1, y1, x2, y2, x, y);
    }
  }
  ops += "Z";
  return { ops, pts };
}

/**
 * The most outlines kept: a kit draws thousands of boxes, but most share a
 * few sizes (every button, every cell), so this holds a whole screen's.
 */
const KEPT = 4096;
const kept = new Map<string, BoxPath>();

function keyOf(w: number, h: number, radii: Radii, smoothing: number): string {
  return `${w},${h},${radii[0]},${radii[1]},${radii[2]},${radii[3]},${smoothing}`;
}

/** Keeps `value` under `key`, forgetting the least recently used past `limit`. */
function keep<V>(map: Map<string, V>, key: string, value: V, limit: number): V {
  if (map.size >= limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
  return value;
}

/** The outline of a `w` × `h` box at the origin with these corners, cached by its inputs. */
export function boxPath(w: number, h: number, radii: Radii, smoothing = 0): BoxPath {
  const key = keyOf(w, h, radii, smoothing);
  const hit = kept.get(key);
  if (hit) {
    // Most recently used goes last.
    kept.delete(key);
    kept.set(key, hit);
    return hit;
  }
  return keep(kept, key, buildBoxPath(w, h, radii, smoothing), KEPT);
}

/** True when the box has no rounded corner: its outline is the plain box. */
export function isSquare(radii: Radii): boolean {
  return !(radii[0] > 0 || radii[1] > 0 || radii[2] > 0 || radii[3] > 0);
}

/** Draws `path` into `sink`, moved by (dx, dy). */
export function tracePath(sink: PathSink, path: BoxPath, dx = 0, dy = 0): void {
  const { ops, pts } = path;
  let k = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops.charCodeAt(i);
    if (op === 77 /* M */) {
      sink.moveTo((pts[k] as number) + dx, (pts[k + 1] as number) + dy);
      k += 2;
    } else if (op === 76 /* L */) {
      sink.lineTo((pts[k] as number) + dx, (pts[k + 1] as number) + dy);
      k += 2;
    } else if (op === 67 /* C */) {
      sink.bezierCurveTo(
        (pts[k] as number) + dx,
        (pts[k + 1] as number) + dy,
        (pts[k + 2] as number) + dx,
        (pts[k + 3] as number) + dy,
        (pts[k + 4] as number) + dx,
        (pts[k + 5] as number) + dy,
      );
      k += 6;
    } else sink.closePath();
  }
}

const n3 = (v: number) => String(Math.round(v * 1000) / 1000);

/** `path` as SVG path data, moved by (dx, dy), numbers through `n` (three decimals by default). */
export function pathData(path: BoxPath, dx = 0, dy = 0, n: (v: number) => string = n3): string {
  let d = "";
  const sink: PathSink = {
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
  };
  tracePath(sink, path, dx, dy);
  return d;
}

const kept2D = new Map<string, Path2D>();

/**
 * The outline as a Path2D, at (x, y), cached by its inputs: a screen of
 * identical buttons builds one. Shared: never add to it.
 */
export function boxPath2D(w: number, h: number, radii: Radii, smoothing = 0, x = 0, y = 0): Path2D {
  const key = `${keyOf(w, h, radii, smoothing)},${x},${y}`;
  const hit = kept2D.get(key);
  if (hit) {
    kept2D.delete(key);
    kept2D.set(key, hit);
    return hit;
  }
  const path = new Path2D();
  if (isSquare(radii)) path.rect(x, y, w, h);
  else tracePath(path, boxPath(w, h, radii, smoothing), x, y);
  return keep(kept2D, key, path, KEPT);
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
  const { ops, pts } = path;
  let k = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op === "M" || op === "L") {
      cx = pts[k] as number;
      cy = pts[k + 1] as number;
      out.push({ x: cx, y: cy });
      k += 2;
    } else if (op === "C") {
      const [x1, y1, x2, y2, x3, y3] = pts.slice(k, k + 6) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      for (let j = 1; j <= steps; j++) {
        const [x, y] = cubicAt(cx, cy, x1, y1, x2, y2, x3, y3, j / steps);
        out.push({ x, y });
      }
      cx = x3;
      cy = y3;
      k += 6;
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
  const { ops, pts } = boxPath(w, h, radii, smoothing);
  const out: Array<
    | { kind: "line"; x0: number; y0: number; x1: number; y1: number; length: number }
    | { kind: "cubic"; pts: number[]; length: number }
  > = [];
  let k = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let run: number[] | null = null;
  let runLength = 0;
  const endRun = () => {
    if (run && runLength > 1e-6) out.push({ kind: "cubic", pts: run, length: runLength });
    run = null;
    runLength = 0;
  };
  const lineTo = (x: number, y: number) => {
    endRun();
    const length = Math.hypot(x - cx, y - cy);
    if (length > 1e-6) out.push({ kind: "line", x0: cx, y0: cy, x1: x, y1: y, length });
    cx = x;
    cy = y;
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op === "M") {
      cx = sx = pts[k] as number;
      cy = sy = pts[k + 1] as number;
      k += 2;
    } else if (op === "L") {
      lineTo(pts[k] as number, pts[k + 1] as number);
      k += 2;
    } else if (op === "C") {
      const c = pts.slice(k, k + 6) as number[];
      endRun();
      run = [cx, cy, ...c];
      runLength += cubicLength(
        cx,
        cy,
        c[0] as number,
        c[1] as number,
        c[2] as number,
        c[3] as number,
        c[4] as number,
        c[5] as number,
      );
      cx = c[4] as number;
      cy = c[5] as number;
      k += 6;
    } else lineTo(sx, sy);
  }
  endRun();
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
