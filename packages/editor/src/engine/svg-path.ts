/**
 * SVG path data as the engine's path verbs, with the canvas's `Path2D` semantics: absolute and
 * relative commands, smooth curves, arcs (as cubics), implicit line-tos after a move, and
 * parsing that stops at the first error, drawing what came before (as `new Path2D(d)` does).
 */
import { PathData } from "@drawpane/engine/wire";
import { arcToCubics } from "../vector/svg";

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Parses `d` into `into` (a fresh path by default), scaled and moved by (k, x, y) if given. */
export function svgPathData(
  d: string,
  into = new PathData(),
  k = 1,
  ox = 0,
  oy = 0,
  flipY = false,
): PathData {
  const sy = flipY ? -k : k;
  const X = (v: number) => ox + v * k;
  const Y = (v: number) => oy + v * sy;
  let i = 0;
  const n = d.length;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy0 = 0;
  // The last control point, for S and T.
  let qx = 0;
  let qy = 0;
  let last = "";
  let open = false;
  const skip = () => {
    while (i < n) {
      const c = d.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44) i++;
      else break;
    }
  };
  const num = (): number | null => {
    skip();
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(d);
    if (!m) return null;
    i = NUMBER.lastIndex;
    const v = Number(m[0]);
    return Number.isFinite(v) ? v : null;
  };
  const flag = (): number | null => {
    skip();
    const c = d[i];
    if (c === "0" || c === "1") {
      i++;
      return c === "1" ? 1 : 0;
    }
    return null;
  };
  // After a close, a drawing command starts a new subpath where the closed one began.
  const ensureOpen = () => {
    if (!open) {
      into.moveTo(X(cx), Y(cy));
      open = true;
    }
  };
  let first = true;
  while (true) {
    skip();
    if (i >= n) break;
    let cmd = d[i] as string;
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(cmd)) i++;
    else if (last && last.toUpperCase() !== "Z") {
      // Repeated arguments: a move repeats as line-tos.
      cmd = last === "M" ? "L" : last === "m" ? "l" : last;
    } else break;
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    if (first && upper !== "M") break; // Path data must start with a move.
    first = false;
    const count = ARGS[upper] ?? 0;
    const a: number[] = [];
    let ok = true;
    for (let j = 0; j < count; j++) {
      const v = upper === "A" && (j === 3 || j === 4) ? flag() : num();
      if (v === null) {
        ok = false;
        break;
      }
      a.push(v);
    }
    if (!ok) break;
    const bx = rel ? cx : 0;
    const by = rel ? cy : 0;
    switch (upper) {
      case "M": {
        cx = bx + (a[0] as number);
        cy = by + (a[1] as number);
        sx = cx;
        sy0 = cy;
        into.moveTo(X(cx), Y(cy));
        open = true;
        qx = cx;
        qy = cy;
        break;
      }
      case "L":
      case "H":
      case "V": {
        ensureOpen();
        if (upper === "L") {
          cx = bx + (a[0] as number);
          cy = by + (a[1] as number);
        } else if (upper === "H") cx = bx + (a[0] as number);
        else cy = by + (a[0] as number);
        into.lineTo(X(cx), Y(cy));
        qx = cx;
        qy = cy;
        break;
      }
      case "C":
      case "S": {
        ensureOpen();
        let x1: number;
        let y1: number;
        let k0 = 0;
        if (upper === "C") {
          x1 = bx + (a[0] as number);
          y1 = by + (a[1] as number);
          k0 = 2;
        } else {
          const smooth = /[CcSs]/.test(last);
          x1 = smooth ? 2 * cx - qx : cx;
          y1 = smooth ? 2 * cy - qy : cy;
        }
        const x2 = bx + (a[k0] as number);
        const y2 = by + (a[k0 + 1] as number);
        const x = bx + (a[k0 + 2] as number);
        const y = by + (a[k0 + 3] as number);
        into.cubicTo(X(x1), Y(y1), X(x2), Y(y2), X(x), Y(y));
        qx = x2;
        qy = y2;
        cx = x;
        cy = y;
        break;
      }
      case "Q":
      case "T": {
        ensureOpen();
        let x1: number;
        let y1: number;
        let k0 = 0;
        if (upper === "Q") {
          x1 = bx + (a[0] as number);
          y1 = by + (a[1] as number);
          k0 = 2;
        } else {
          const smooth = /[QqTt]/.test(last);
          x1 = smooth ? 2 * cx - qx : cx;
          y1 = smooth ? 2 * cy - qy : cy;
        }
        const x = bx + (a[k0] as number);
        const y = by + (a[k0 + 1] as number);
        into.quadTo(X(x1), Y(y1), X(x), Y(y));
        qx = x1;
        qy = y1;
        cx = x;
        cy = y;
        break;
      }
      case "A": {
        ensureOpen();
        const x = bx + (a[5] as number);
        const y = by + (a[6] as number);
        for (const seg of arcToCubics(
          cx,
          cy,
          a[0] as number,
          a[1] as number,
          a[2] as number,
          a[3] === 1,
          a[4] === 1,
          x,
          y,
        )) {
          if (seg === null) into.lineTo(X(x), Y(y));
          else
            into.cubicTo(
              X(seg[0].x),
              Y(seg[0].y),
              X(seg[1].x),
              Y(seg[1].y),
              X(seg[2].x),
              Y(seg[2].y),
            );
        }
        cx = x;
        cy = y;
        qx = cx;
        qy = cy;
        break;
      }
      case "Z": {
        if (open) into.close();
        open = false;
        cx = sx;
        cy = sy0;
        qx = cx;
        qy = cy;
        break;
      }
    }
    last = cmd;
  }
  return into;
}
