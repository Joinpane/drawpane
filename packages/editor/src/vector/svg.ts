/**
 * SVG path data to and from the editable structure.
 *
 * The parser accepts the full SVG grammar: absolute and relative commands,
 * implicit repeats, H/V, smooth curves (S/T), quadratics (Q, elevated to
 * cubics exactly) and elliptical arcs (A, converted to cubics). Like browsers,
 * it keeps everything before the first error and ignores the rest.
 *
 * The serializer writes absolute M, L, C and Z only, with up to 3 decimals.
 */
import type { Point } from "../geometry";
import type { Anchor, Subpath, VectorPath } from "./path";

interface MutableAnchor {
  x: number;
  y: number;
  in: Point | null;
  out: Point | null;
}

const PARAMS: Record<string, number> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
};

/** Coincidence tolerance when a Z lands on the subpath's first anchor. */
const CLOSE_EPS = 1e-6;

export function parsePath(d: string): VectorPath {
  const out: Subpath[] = [];
  let anchors: MutableAnchor[] = [];
  let pos = 0;
  const len = d.length;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  // Reflection points for S and T.
  let lastC2: Point | null = null;
  let lastQ: Point | null = null;
  let afterClose = false;

  const skipSep = () => {
    while (pos < len) {
      const ch = d.charCodeAt(pos);
      // space, tab, LF, CR, FF, comma
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12 || ch === 44) pos++;
      else break;
    }
  };
  const isDigit = (ch: number) => ch >= 48 && ch <= 57;
  // A hand-rolled scanner for [+-]digits[.digits][e[+-]digits]: the hot loop of
  // every parse, several times faster than a sticky regex on long paths.
  const readNumber = (): number | null => {
    skipSep();
    const start = pos;
    let ch = d.charCodeAt(pos);
    if (ch === 43 || ch === 45) ch = d.charCodeAt(++pos); // + -
    let digits = 0;
    while (isDigit(ch)) {
      digits++;
      ch = d.charCodeAt(++pos);
    }
    if (ch === 46) {
      // .
      ch = d.charCodeAt(++pos);
      while (isDigit(ch)) {
        digits++;
        ch = d.charCodeAt(++pos);
      }
    }
    if (digits === 0) {
      pos = start;
      return null;
    }
    if (ch === 101 || ch === 69) {
      // e E: only an exponent when digits follow.
      let q = pos + 1;
      let c = d.charCodeAt(q);
      if (c === 43 || c === 45) c = d.charCodeAt(++q);
      if (isDigit(c)) {
        while (isDigit(c)) c = d.charCodeAt(++q);
        pos = q;
      }
    }
    const n = Number(d.slice(start, pos));
    return Number.isFinite(n) ? n : null;
  };
  const readFlag = (): number | null => {
    skipSep();
    const ch = d[pos];
    if (ch === "0" || ch === "1") {
      pos++;
      return ch === "1" ? 1 : 0;
    }
    return null;
  };
  const finishSubpath = (closed: boolean) => {
    if (anchors.length === 0) return;
    if (closed && anchors.length > 1) {
      const first = anchors[0] as MutableAnchor;
      const last = anchors[anchors.length - 1] as MutableAnchor;
      if (Math.abs(first.x - last.x) <= CLOSE_EPS && Math.abs(first.y - last.y) <= CLOSE_EPS) {
        first.in = last.in;
        anchors.pop();
      }
    }
    out.push({ anchors: anchors.map(freeze), closed });
    anchors = [];
  };
  const ensureSubpath = () => {
    if (anchors.length === 0 || afterClose) {
      if (afterClose) afterClose = false;
      anchors = [{ x: cx, y: cy, in: null, out: null }];
    }
  };
  const lineTo = (x: number, y: number) => {
    ensureSubpath();
    anchors.push({ x, y, in: null, out: null });
    cx = x;
    cy = y;
  };
  const cubicTo = (c1: Point, c2: Point, x: number, y: number) => {
    ensureSubpath();
    const last = anchors[anchors.length - 1] as MutableAnchor;
    last.out = c1.x === last.x && c1.y === last.y ? null : c1;
    anchors.push({ x, y, in: c2.x === x && c2.y === y ? null : c2, out: null });
    cx = x;
    cy = y;
  };

  let cmd = "";
  for (;;) {
    skipSep();
    if (pos >= len) break;
    const ch = d[pos] as string;
    let command: string;
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      command = ch;
      pos++;
    } else {
      // Implicit repeat of the previous command (M repeats as L).
      if (cmd === "" || cmd === "z" || cmd === "Z") break;
      command = cmd === "M" ? "L" : cmd === "m" ? "l" : cmd;
    }
    const lower = command.toLowerCase();
    // Path data must start with a moveto.
    if (cmd === "" && lower !== "m") break;
    const rel = command !== command.toUpperCase();
    const count = PARAMS[lower] ?? 0;
    const args: number[] = [];
    let ok = true;
    for (let k = 0; k < count; k++) {
      const v = lower === "a" && (k === 3 || k === 4) ? readFlag() : readNumber();
      if (v === null) {
        ok = false;
        break;
      }
      args.push(v);
    }
    if (!ok) break;
    const a = (k: number) => args[k] as number;
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    switch (lower) {
      case "m": {
        if (anchors.length > 0) finishSubpath(false);
        afterClose = false;
        cx = a(0) + ox;
        cy = a(1) + oy;
        sx = cx;
        sy = cy;
        anchors = [{ x: cx, y: cy, in: null, out: null }];
        lastC2 = lastQ = null;
        break;
      }
      case "l":
        lineTo(a(0) + ox, a(1) + oy);
        lastC2 = lastQ = null;
        break;
      case "h":
        lineTo(a(0) + ox, cy);
        lastC2 = lastQ = null;
        break;
      case "v":
        lineTo(cx, a(0) + (rel ? cy : 0));
        lastC2 = lastQ = null;
        break;
      case "c": {
        const c1 = { x: a(0) + ox, y: a(1) + oy };
        const c2 = { x: a(2) + ox, y: a(3) + oy };
        cubicTo(c1, c2, a(4) + ox, a(5) + oy);
        lastC2 = c2;
        lastQ = null;
        break;
      }
      case "s": {
        const c1 = lastC2 ? { x: 2 * cx - lastC2.x, y: 2 * cy - lastC2.y } : { x: cx, y: cy };
        const c2 = { x: a(0) + ox, y: a(1) + oy };
        cubicTo(c1, c2, a(2) + ox, a(3) + oy);
        lastC2 = c2;
        lastQ = null;
        break;
      }
      case "q":
      case "t": {
        const q: Point =
          lower === "q"
            ? { x: a(0) + ox, y: a(1) + oy }
            : lastQ
              ? { x: 2 * cx - lastQ.x, y: 2 * cy - lastQ.y }
              : { x: cx, y: cy };
        const x = lower === "q" ? a(2) + ox : a(0) + ox;
        const y = lower === "q" ? a(3) + oy : a(1) + oy;
        const c1 = { x: cx + (2 / 3) * (q.x - cx), y: cy + (2 / 3) * (q.y - cy) };
        const c2 = { x: x + (2 / 3) * (q.x - x), y: y + (2 / 3) * (q.y - y) };
        cubicTo(c1, c2, x, y);
        lastQ = q;
        lastC2 = null;
        break;
      }
      case "a": {
        const x = a(5) + ox;
        const y = a(6) + oy;
        for (const c of arcToCubics(cx, cy, a(0), a(1), a(2), a(3) === 1, a(4) === 1, x, y)) {
          if (c === null) lineTo(x, y);
          else cubicTo(c[0], c[1], c[2].x, c[2].y);
        }
        cx = x;
        cy = y;
        lastC2 = lastQ = null;
        break;
      }
      case "z": {
        if (anchors.length > 0 && !afterClose) {
          finishSubpath(true);
          afterClose = true;
        }
        cx = sx;
        cy = sy;
        lastC2 = lastQ = null;
        break;
      }
    }
    cmd = command;
  }
  if (anchors.length > 0 && !afterClose) finishSubpath(false);
  return out;
}

function freeze(a: MutableAnchor): Anchor {
  return { x: a.x, y: a.y, in: a.in, out: a.out };
}

/**
 * Converts an SVG arc to cubic Béziers (SVG 1.1 F.6.5), at most 90° each.
 * Yields null for a degenerate arc that is drawn as a straight line.
 */
export function* arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  angle: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): Generator<[Point, Point, Point] | null> {
  if (x1 === x2 && y1 === y2) return;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) {
    yield null;
    return;
  }
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  // Scale up radii that are too small to reach.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const centreX = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const centreY = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const vecAngle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = vecAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = vecAngle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const map = (ux: number, uy: number): Point => ({
    x: centreX + rx * ux * cos - ry * uy * sin,
    y: centreY + rx * ux * sin + ry * uy * cos,
  });
  let t = theta1;
  for (let i = 0; i < segments; i++) {
    const c0 = Math.cos(t);
    const s0 = Math.sin(t);
    const t1 = t + step;
    const c1 = Math.cos(t1);
    const s1 = Math.sin(t1);
    const p1 = map(c0 - k * s0, s0 + k * c0);
    const p2 = map(c1 + k * s1, s1 - k * c1);
    // Land exactly on the requested endpoint.
    const p3 = i === segments - 1 ? { x: x2, y: y2 } : map(c1, s1);
    yield [p1, p2, p3];
    t = t1;
  }
}

/** Formats a coordinate: at most 3 decimals, no trailing zeros, no "-0". */
export function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  if (r === 0 || !Number.isFinite(r)) return "0";
  return String(r);
}

export function serializePath(path: VectorPath): string {
  const parts: string[] = [];
  const pt = (x: number, y: number) => `${fmt(x)} ${fmt(y)}`;
  for (const sub of path) {
    const n = sub.anchors.length;
    if (n === 0) continue;
    const first = sub.anchors[0] as Anchor;
    parts.push(`M${pt(first.x, first.y)}`);
    const count = n < 2 ? 0 : sub.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const a = sub.anchors[i] as Anchor;
      const b = sub.anchors[(i + 1) % n] as Anchor;
      const closing = sub.closed && i === n - 1;
      if (a.out === null && b.in === null) {
        // The closing line is drawn by Z itself.
        if (!closing) parts.push(`L${pt(b.x, b.y)}`);
      } else {
        const c1 = a.out ?? a;
        const c2 = b.in ?? b;
        parts.push(`C${pt(c1.x, c1.y)} ${pt(c2.x, c2.y)} ${pt(b.x, b.y)}`);
      }
    }
    if (sub.closed) parts.push("Z");
  }
  return parts.join("");
}
