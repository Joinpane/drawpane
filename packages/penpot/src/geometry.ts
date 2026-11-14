/**
 * Geometry for the converter. Penpot stores every shape in absolute page
 * coordinates, with no inherited transforms: a shape's box is its unrotated
 * `selrect` turned by `transform` about the box's centre. Drawpane stores a
 * box (x, y, width, height, rotation, flip) in its parent frame's space. So
 * each shape's page affine is worked out, then expressed in its frame's.
 *
 * Paths carry absolute SVG path data instead of a box: they're parsed,
 * mapped into the frame's space and fitted with an exact bounding box.
 */

/** [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (as in SVG and canvas). */
export type Matrix = readonly [number, number, number, number, number, number];
export interface Point {
  readonly x: number;
  readonly y: number;
}

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
  if (Math.abs(det) < 1e-12) return IDENTITY;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export const apply = (m: Matrix, p: Point): Point => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
});

const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

/** A box as Drawpane stores it, in its parent frame's space. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Degrees, clockwise on screen. */
  readonly rotation: number;
  readonly flipX: boolean;
  /** The box was skewed or stretched by a transform that can't be a rotation and a flip. */
  readonly skewed: boolean;
}

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};

/**
 * A Penpot shape's page affine: from its own box (0..width, 0..height) to
 * page coordinates. `transform` turns the unrotated `selrect` about its centre.
 */
export function shapeMatrix(shape: Record<string, unknown>): Matrix {
  const sel = (shape.selrect ?? {}) as Record<string, unknown>;
  const x = num(sel.x, num(shape.x));
  const y = num(sel.y, num(shape.y));
  const width = num(sel.width, num(shape.width, 0.01));
  const height = num(sel.height, num(shape.height, 0.01));
  const t = (shape.transform ?? {}) as Record<string, unknown>;
  const m: Matrix = [num(t.a, 1), num(t.b, 0), num(t.c, 0), num(t.d, 1), num(t.e, 0), num(t.f, 0)];
  const cx = x + width / 2;
  const cy = y + height / 2;
  return multiply(translate(cx, cy), multiply(m, translate(-width / 2, -height / 2)));
}

export function shapeSize(shape: Record<string, unknown>): { width: number; height: number } {
  const sel = (shape.selrect ?? {}) as Record<string, unknown>;
  return {
    width: Math.max(0, num(sel.width, num(shape.width))),
    height: Math.max(0, num(sel.height, num(shape.height))),
  };
}

/**
 * The Drawpane box for a shape whose page affine is `world`, inside a frame
 * whose page affine is `space`: the inverse of
 * `localMatrix(box) = T(x + w/2, y + h/2) · R(rotation) · S(flip) · T(-w/2, -h/2)`.
 */
export function boxIn(space: Matrix, world: Matrix, width: number, height: number): Box {
  const local = multiply(invert(space), world);
  const centre = apply(local, { x: width / 2, y: height / 2 });
  const [a, b, c, d] = local;
  const det = a * d - b * c;
  // The second column is R·(0, 1): a flip on x leaves it alone.
  const rotation = normalizeAngle((Math.atan2(-c, d) * 180) / Math.PI);
  const flipX = det < 0;
  // A rotation (with a flip) has unit, perpendicular columns; anything else is a skew or a stretch.
  const skewed =
    Math.abs(Math.hypot(a, b) - 1) > 1e-3 ||
    Math.abs(Math.hypot(c, d) - 1) > 1e-3 ||
    Math.abs(a * c + b * d) > 1e-3;
  return {
    x: round(centre.x - width / 2),
    y: round(centre.y - height / 2),
    width: round(width),
    height: round(height),
    rotation: round(rotation),
    flipX,
    skewed,
  };
}

/** The page affine Drawpane will give a box in a frame whose page affine is `space`. */
export function boxMatrix(space: Matrix, box: Box): Matrix {
  const cx = box.width / 2;
  const cy = box.height / 2;
  const r = (box.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  let m = multiply(translate(box.x + cx, box.y + cy), [cos, sin, -sin, cos, 0, 0]);
  if (box.flipX) m = multiply(m, [-1, 0, 0, 1, 0, 0]);
  return multiply(space, multiply(m, translate(-cx, -cy)));
}

function normalizeAngle(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Math.abs(a) < 1e-6 ? 0 : a;
}

export const round = (n: number, places = 3) => {
  const f = 10 ** places;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

// ---------------------------------------------------------------------------
// Path data

/** An absolute path in M, L, C and Z commands, the form everything here works in. */
export type Segment =
  | { readonly c: "M" | "L"; readonly p: Point }
  | { readonly c: "C"; readonly c1: Point; readonly c2: Point; readonly p: Point }
  | { readonly c: "Z" };

/**
 * Penpot path content: an SVG path string (normally only absolute M, L, C
 * and Z, but any SVG path is accepted, relative commands, arcs and all), or
 * the older array of segments.
 */
export function parsePenpotPath(content: unknown): Segment[] {
  if (typeof content === "string") return parseSvgPath(content);
  if (!Array.isArray(content)) return [];
  const out: Segment[] = [];
  for (const raw of content as Array<Record<string, unknown>>) {
    const params = (raw.params ?? {}) as Record<string, unknown>;
    const p = { x: num(params.x, Number.NaN), y: num(params.y, Number.NaN) };
    switch (raw.command) {
      case "move-to":
      case "line-to":
        if (Number.isFinite(p.x) && Number.isFinite(p.y))
          out.push({ c: raw.command === "move-to" ? "M" : "L", p });
        break;
      case "curve-to":
        if (Number.isFinite(p.x) && Number.isFinite(p.y))
          out.push({
            c: "C",
            c1: { x: num(params.c1x, p.x), y: num(params.c1y, p.y) },
            c2: { x: num(params.c2x, p.x), y: num(params.c2y, p.y) },
            p,
          });
        break;
      case "close-path":
        out.push({ c: "Z" });
        break;
    }
  }
  return out;
}

/** Full SVG path syntax to absolute M, L, C and Z. */
export function parseSvgPath(d: string): Segment[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: Segment[] = [];
  let i = 0;
  let cmd = "";
  let cur = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let lastControl: Point | null = null;
  let lastQuad: Point | null = null;
  const isNum = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i] as string);
  const next = () => Number.parseFloat(tokens[i++] as string);
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i] as string)) cmd = tokens[i++] as string;
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const at = (x: number, y: number): Point => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });
    const upper = cmd.toUpperCase();
    if (upper === "Z") {
      out.push({ c: "Z" });
      cur = start;
      lastControl = lastQuad = null;
      cmd = "";
      continue;
    }
    if (!isNum()) {
      cmd = "";
      continue;
    }
    switch (upper) {
      case "M": {
        const p = at(next(), next());
        out.push({ c: "M", p });
        cur = start = p;
        // Further pairs after a move are lines.
        cmd = rel ? "l" : "L";
        lastControl = lastQuad = null;
        break;
      }
      case "L": {
        const p = at(next(), next());
        out.push({ c: "L", p });
        cur = p;
        lastControl = lastQuad = null;
        break;
      }
      case "H": {
        const x = next();
        const p = { x: rel ? cur.x + x : x, y: cur.y };
        out.push({ c: "L", p });
        cur = p;
        lastControl = lastQuad = null;
        break;
      }
      case "V": {
        const y = next();
        const p = { x: cur.x, y: rel ? cur.y + y : y };
        out.push({ c: "L", p });
        cur = p;
        lastControl = lastQuad = null;
        break;
      }
      case "C": {
        const c1 = at(next(), next());
        const c2 = at(next(), next());
        const p = at(next(), next());
        out.push({ c: "C", c1, c2, p });
        lastControl = c2;
        lastQuad = null;
        cur = p;
        break;
      }
      case "S": {
        const c1 = lastControl
          ? { x: 2 * cur.x - lastControl.x, y: 2 * cur.y - lastControl.y }
          : cur;
        const c2 = at(next(), next());
        const p = at(next(), next());
        out.push({ c: "C", c1, c2, p });
        lastControl = c2;
        lastQuad = null;
        cur = p;
        break;
      }
      case "Q":
      case "T": {
        const q: Point =
          upper === "Q"
            ? at(next(), next())
            : lastQuad
              ? { x: 2 * cur.x - lastQuad.x, y: 2 * cur.y - lastQuad.y }
              : cur;
        const p = at(next(), next());
        out.push({
          c: "C",
          c1: { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) },
          c2: { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) },
          p,
        });
        lastQuad = q;
        lastControl = null;
        cur = p;
        break;
      }
      case "A": {
        const rx = next();
        const ry = next();
        const angle = next();
        const large = next() !== 0;
        const sweep = next() !== 0;
        const p = at(next(), next());
        out.push(...arcToCurves(cur, p, rx, ry, angle, large, sweep));
        lastControl = lastQuad = null;
        cur = p;
        break;
      }
      default:
        i++;
    }
  }
  return out;
}

/** An SVG elliptical arc as cubic curves (the standard endpoint-to-centre conversion). */
function arcToCurves(
  from: Point,
  to: Point,
  rxIn: number,
  ryIn: number,
  angleDeg: number,
  large: boolean,
  sweep: boolean,
): Segment[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (from.x === to.x && from.y === to.y)) return [{ c: "L", p: to }];
  const phi = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const sign = large === sweep ? -1 : 1;
  const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = sign * Math.sqrt(Math.max(0, num2 / den));
  const cx1 = (co * rx * y1) / ry;
  const cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2;
  const angleOf = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta = angleOf(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angleOf((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const parts = Math.ceil(Math.abs(delta) / (Math.PI / 2));
  const step = delta / parts;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number, r = 1): Point => {
    const ex = rx * Math.cos(t) * r;
    const ey = ry * Math.sin(t) * r;
    return { x: cx + cos * ex - sin * ey, y: cy + sin * ex + cos * ey };
  };
  const out: Segment[] = [];
  for (let i = 0; i < parts; i++) {
    const t1 = theta + i * step;
    const t2 = t1 + step;
    const e1 = { x: -rx * Math.sin(t1), y: ry * Math.cos(t1) };
    const e2 = { x: -rx * Math.sin(t2), y: ry * Math.cos(t2) };
    const p1 = point(t1);
    const p2 = i === parts - 1 ? to : point(t2);
    out.push({
      c: "C",
      c1: { x: p1.x + k * (cos * e1.x - sin * e1.y), y: p1.y + k * (sin * e1.x + cos * e1.y) },
      c2: { x: p2.x - k * (cos * e2.x - sin * e2.y), y: p2.y - k * (sin * e2.x + cos * e2.y) },
      p: p2,
    });
  }
  return out;
}

export function transformPath(path: readonly Segment[], m: Matrix): Segment[] {
  return path.map((s) =>
    s.c === "Z"
      ? s
      : s.c === "C"
        ? { c: "C", c1: apply(m, s.c1), c2: apply(m, s.c2), p: apply(m, s.p) }
        : { c: s.c, p: apply(m, s.p) },
  );
}

/** The exact bounds of a path (curves by their extrema, not their control points). */
export function pathBounds(
  path: readonly Segment[],
): { x: number; y: number; width: number; height: number } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const add = (p: Point) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  let cur: Point | null = null;
  let start: Point | null = null;
  for (const s of path) {
    if (s.c === "Z") {
      cur = start;
      continue;
    }
    if (s.c === "M") start = s.p;
    if (s.c === "C" && cur) {
      for (const t of cubicExtrema(cur, s.c1, s.c2, s.p)) add(cubicAt(cur, s.c1, s.c2, s.p, t));
    }
    add(s.p);
    cur = s.p;
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Where a cubic's derivative is zero on either axis, inside (0, 1). */
function cubicExtrema(p0: Point, p1: Point, p2: Point, p3: Point): number[] {
  const out: number[] = [];
  for (const k of ["x", "y"] as const) {
    const a = -p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k];
    const b = 2 * (p0[k] - 2 * p1[k] + p2[k]);
    const c = p1[k] - p0[k];
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) out.push(-c / b);
      continue;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const r = Math.sqrt(disc);
    out.push((-b + r) / (2 * a), (-b - r) / (2 * a));
  }
  return out.filter((t) => t > 0 && t < 1);
}

/** Path data for Drawpane: absolute commands, numbers to 3 places. */
export function serializePath(path: readonly Segment[]): string {
  const n = (v: number) => String(round(v));
  const pt = (p: Point) => `${n(p.x)} ${n(p.y)}`;
  const parts: string[] = [];
  for (const s of path) {
    if (s.c === "Z") {
      // Penpot writes "ZZ"; one is enough.
      if (parts.at(-1) !== "Z") parts.push("Z");
    } else if (s.c === "C") parts.push(`C${pt(s.c1)} ${pt(s.c2)} ${pt(s.p)}`);
    else parts.push(`${s.c}${pt(s.p)}`);
  }
  return parts.join(" ");
}
