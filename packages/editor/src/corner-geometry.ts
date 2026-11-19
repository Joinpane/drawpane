/**
 * The geometry of rounded and smoothed box corners, as Figma draws them
 * (decision 0041): one pure function from a box's size, corner radii and
 * smoothing to the path commands of its outline. No canvas, no model, no
 * state, so every renderer (and the Rust engine of decision 0040, which
 * ports it) draws the same outline. Its test vectors, checked against
 * Figma's own geometry, are `test/fixtures/corner-vectors.json`; any port
 * must reproduce them.
 *
 * Each corner is Figma's squircle construction: with smoothing `s` (0 to 1)
 * a corner of radius `R` reaches `p = (1 + s) R` along both edges, as a
 * cubic that eases off the edge, a circular arc of 90 (1 − s) degrees on the
 * circle of radius `R` tangent to both edges (one cubic, as Figma's own
 * geometry has it), and a cubic easing back onto the other edge. At `s = 0`
 * it is a plain quarter circle; at `s = 1` there is no arc.
 *
 * Space is shared out per corner: along each edge, a corner may use the
 * edge's length in proportion to its radius against the radius at the
 * edge's other end, and its budget is the smaller of its two edges' shares.
 * The radius is cut to the budget first, then the smoothing
 * (`s ≤ budget / R − 1`), so the corner never reaches past its budget and
 * its curve keeps its shape. A uniform radius gets half the shorter side;
 * one large corner beside square ones can reach further.
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

/** One path command, as SVG has it: move, line, cubic, close. */
export type BoxCommand =
  | readonly ["M", number, number]
  | readonly ["L", number, number]
  | readonly ["C", number, number, number, number, number, number]
  | readonly ["Z"];

const clampUnit = (v: number) => (v > 0 ? Math.min(v, 1) : 0);
const nonNegative = (v: number) => (v > 0 && Number.isFinite(v) ? v : 0);

/** A corner's share of an edge `length` long, against the radius at the edge's other end. */
function share(r: number, other: number, length: number): number {
  const sum = r + other;
  return sum > 0 ? (length * r) / sum : 0;
}

/**
 * The corners as drawn on a `w` × `h` box: radii and smoothing cut to the
 * space each has. Negative, infinite and missing numbers count as 0;
 * smoothing past 1 counts as 1.
 */
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
 * edge going out: cubics (six numbers each: two controls and an end) from
 * (extent, 0) to (0, extent). Empty for a square corner.
 */
export function cornerCubics(corner: FittedCorner): number[] {
  const { radius: R, smoothing: s, extent: p } = corner;
  if (R <= 0) return [];
  const deg = Math.PI / 180;
  // Figma's construction ("Desperately seeking squircles"): the arc keeps 90 (1 − s) degrees,
  // the rest of the turn goes to the two easing curves.
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
  // The easing curve off the incoming edge, from (p, 0) to where the arc starts.
  const x3 = p - a - b - c;
  const eases = p - x3 > 1e-9 || d > 1e-9;
  if (eases) out.push(p - a, 0, p - a - b, 0, x3, d);
  // The arc, centred on (R, R), from (x3, d) to (d, x3), as one cubic.
  const sweep = arcAngle * deg;
  if (sweep > 1e-9) {
    const k = (4 / 3) * Math.tan(sweep / 4) * R;
    // Unit tangents in the direction of travel (x falls, y rises): perpendicular to the radius.
    const sx = x3 - R;
    const sy = d - R;
    const ex = d - R;
    const ey = x3 - R;
    const sl = Math.hypot(sx, sy) || 1;
    const el = Math.hypot(ex, ey) || 1;
    const t0x = sy / sl;
    const t0y = -sx / sl;
    const t1x = ey / el;
    const t1y = -ex / el;
    out.push(x3 + t0x * k, d + t0y * k, d - t1x * k, x3 - t1y * k, d, x3);
  }
  // The easing curve back onto the outgoing edge, to (0, p).
  if (eases) out.push(0, p - a - b, 0, p - a, 0, p);
  return out;
}

/**
 * The outline of a `w` × `h` box at the origin with these corners, as path
 * commands, clockwise: it starts where the top-left corner meets the left
 * edge (as Figma's own geometry does), each corner's cubics follow a line
 * to where it starts, and it closes. A square corner is a line to the box's
 * corner.
 */
export function boxCommands(w: number, h: number, radii: Radii, smoothing = 0): BoxCommand[] {
  const W = nonNegative(w);
  const H = nonNegative(h);
  const corners = fitCorners(W, H, radii, smoothing);
  const out: BoxCommand[] = [];
  // Each corner's origin and the unit vectors of its frame: `u` back along the incoming edge
  // (its x), `v` along the outgoing edge (its y). Clockwise, from the top left.
  const frames = [
    [0, 0, 0, 1, 1, 0],
    [W, 0, -1, 0, 0, 1],
    [W, H, 0, -1, -1, 0],
    [0, H, 1, 0, 0, -1],
  ] as const;
  for (let i = 0; i < 4; i++) {
    const corner = corners[i] as FittedCorner;
    const [ox, oy, ux, uy, vx, vy] = frames[i] as (typeof frames)[number];
    const x = (a: number, b: number) => ox + ux * a + vx * b;
    const y = (a: number, b: number) => oy + uy * a + vy * b;
    const e = corner.extent;
    out.push([i === 0 ? "M" : "L", x(e, 0), y(e, 0)] as BoxCommand);
    const c = cornerCubics(corner);
    for (let j = 0; j < c.length; j += 6) {
      const [a1, b1, a2, b2, a3, b3] = c.slice(j, j + 6) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      out.push(["C", x(a1, b1), y(a1, b1), x(a2, b2), y(a2, b2), x(a3, b3), y(a3, b3)]);
    }
  }
  out.push(["Z"]);
  return out;
}
