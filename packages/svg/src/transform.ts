/**
 * The `transform` attribute (and CSS `transform` in a style) as one affine:
 * matrix, translate, scale, rotate (about a point), skewX and skewY, applied
 * right to left as the spec says. And the viewBox mapping, with
 * preserveAspectRatio's alignments, meet and slice.
 */
import { IDENTITY, type Matrix, multiply } from "@drawpane/import-kit";
import { parseNumbers, type Viewport } from "./units";

const rad = (deg: number) => (deg * Math.PI) / 180;

/** A transform list, or the identity for anything it can't read. */
export function parseTransform(text: string | null | undefined): Matrix {
  if (!text) return IDENTITY;
  let m: Matrix = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const name = (match[1] as string).toLowerCase();
    // CSS writes units ("10px", "45deg"); the attribute doesn't. Numbers either way.
    const raw = match[2] as string;
    const n = parseNumbers(raw);
    const turnUnits = /rad|turn|grad/.test(raw);
    const angle = (v: number) =>
      turnUnits
        ? raw.includes("turn")
          ? v * 360
          : raw.includes("grad")
            ? v * 0.9
            : (v * 180) / Math.PI
        : v;
    let t: Matrix = IDENTITY;
    switch (name) {
      case "matrix":
        if (n.length >= 6) t = [n[0], n[1], n[2], n[3], n[4], n[5]] as unknown as Matrix;
        break;
      case "translate":
        t = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0];
        break;
      case "scale":
        t = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const a = rad(angle(n[0] ?? 0));
        const r: Matrix = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        const cx = n[1] ?? 0;
        const cy = n[2] ?? 0;
        t = multiply(multiply([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case "skewx":
        t = [1, 0, Math.tan(rad(angle(n[0] ?? 0))), 1, 0, 0];
        break;
      case "skewy":
        t = [1, Math.tan(rad(angle(n[0] ?? 0))), 0, 1, 0, 0];
        break;
    }
    m = multiply(m, t);
  }
  return m;
}

export interface ViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A `viewBox`, or null when it's missing or not a positive size. */
export function parseViewBox(text: string | null | undefined): ViewBox | null {
  const n = parseNumbers(text);
  if (n.length !== 4) return null;
  const [x, y, width, height] = n as [number, number, number, number];
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** The viewBox onto a viewport of `size` at the origin, by `preserveAspectRatio`. */
export function viewBoxMatrix(
  box: ViewBox,
  size: Viewport,
  preserve: string | null | undefined,
): Matrix {
  const [align = "xMidYMid", mode = "meet"] = (preserve ?? "").trim().split(/\s+/).filter(Boolean);
  let sx = size.width / box.width;
  let sy = size.height / box.height;
  if (align !== "none") {
    const s = mode === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = s;
    sy = s;
  }
  let tx = -box.x * sx;
  let ty = -box.y * sy;
  if (align !== "none") {
    const extraX = size.width - box.width * sx;
    const extraY = size.height - box.height * sy;
    if (align.includes("xMid")) tx += extraX / 2;
    else if (align.includes("xMax")) tx += extraX;
    if (align.includes("YMid")) ty += extraY / 2;
    else if (align.includes("YMax")) ty += extraY;
  }
  return [sx, 0, 0, sy, tx, ty];
}
