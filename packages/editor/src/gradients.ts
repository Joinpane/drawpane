/**
 * Where a gradient lies on its layer. As in Figma, a gradient's handles are
 * in the layer's unit square (0,0 top left to 1,1 bottom right), and the
 * gradient is laid out there: a linear one's bands run across its handles in
 * that square, and a radial or angular one is a circle there, centred on
 * `from` and reaching `to`. On a layer that isn't square, that's a slant and
 * an ellipse on screen.
 */
import type { Paint } from "@drawpane/model";
import type { Matrix } from "./geometry";

export type GradientPaint = Extract<Paint, { stops: unknown }>;

/**
 * The gradient's own space onto the layer's units: the unit gradient there
 * (linear from x = 0 to 1, radial and angular around the origin with radius
 * 1, starting along x) lands where the paint's handles put it. Null when the
 * handles meet, or the layer has no size.
 */
export function gradientMatrix(paint: GradientPaint, w: number, h: number): Matrix | null {
  const dx = paint.to.x - paint.from.x;
  const dy = paint.to.y - paint.from.y;
  // Along the main handle, and along `width` when given (else a quarter turn clockwise, y down).
  const wx = paint.width ? paint.width.x - paint.from.x : -dy;
  const wy = paint.width ? paint.width.y - paint.from.y : dx;
  const m: Matrix = [dx * w, dy * h, wx * w, wy * h, paint.from.x * w, paint.from.y * h];
  return Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12 ? null : m;
}

/** The inverse of an affine matrix. */
function invert([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * The layer's box (0, 0, w, h), in the gradient's space: what to fill there to cover it.
 * With `reach`, the box grown by that much on every side (what a stroke or text paints past it).
 */
export function boxInGradientSpace(
  m: Matrix,
  w: number,
  h: number,
  reach = 0,
): { x: number; y: number; width: number; height: number } {
  const [a, b, c, d, e, f] = invert(m);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [-reach, -reach],
    [w + reach, -reach],
    [-reach, h + reach],
    [w + reach, h + reach],
  ] as const) {
    xs.push(a * x + c * y + e);
    ys.push(b * x + d * y + f);
  }
  const x0 = Math.min(...xs) - 1;
  const y0 = Math.min(...ys) - 1;
  return { x: x0, y: y0, width: Math.max(...xs) + 1 - x0, height: Math.max(...ys) + 1 - y0 };
}

/**
 * A linear gradient as a line in the layer's units, for where a transform
 * can't be used (strokes, text): the same bands, since a linear gradient's
 * value is an affine function of position either way. Null when the handles
 * meet.
 */
export function linearInPixels(
  paint: GradientPaint,
  w: number,
  h: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const dx = paint.to.x - paint.from.x;
  const dy = paint.to.y - paint.from.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12 || w <= 0 || h <= 0) return null;
  // The gradient's value rises by (a, b) per unit of x and y; a line along that, as long as 1/|(a, b)|.
  const a = dx / (w * len2);
  const b = dy / (h * len2);
  const k = a * a + b * b;
  const x0 = paint.from.x * w;
  const y0 = paint.from.y * h;
  return { x0, y0, x1: x0 + a / k, y1: y0 + b / k };
}

/**
 * A gradient as CSS for a w × h box, laid out as the canvas draws it (the
 * picker's preview and swatches, and code export). `color` writes one stop's
 * color, opacity and all. Null when the handles meet, as the canvas then
 * draws nothing.
 *
 * - Linear is exact: CSS spreads stops along a line through the box's centre
 *   whose length depends on its angle and the box's corners, so the angle
 *   and every stop's position are worked out for this box.
 * - Radial is exact: the unit square's circle is an ellipse on the box, and
 *   CSS's `ellipse x% y%` takes its percentages of the box's width and
 *   height, just as the unit square does. (`circle` takes no percentage:
 *   written that way, browsers drop the whole background.)
 * - Angular starts toward `to`, as drawn. CSS sweeps evenly round the
 *   centre, so on a box that isn't square its bands fall a little off the
 *   canvas's, which sweeps evenly in the unit square.
 */
export function cssGradient(
  paint: GradientPaint,
  w: number,
  h: number,
  color: (hex: string) => string,
): string | null {
  const stops = [...paint.stops].sort((a, b) => a.position - b.position);
  const list = (position: (p: number) => number) =>
    stops.map((s) => `${color(s.color)} ${num(position(s.position) * 100)}%`).join(", ");
  const at = `at ${num(paint.from.x * 100)}% ${num(paint.from.y * 100)}%`;
  if (paint.type === "linear") {
    const line = linearInPixels(paint, w, h);
    if (!line) return null;
    const vx = line.x1 - line.x0;
    const vy = line.y1 - line.y0;
    const length = Math.hypot(vx, vy);
    const ux = vx / length;
    const uy = vy / length;
    // CSS: 0deg points up and turns clockwise; its line runs through the centre, corner to corner.
    const angle = (Math.atan2(ux, -uy) * 180) / Math.PI;
    const span = Math.abs(w * ux) + Math.abs(h * uy);
    const centre = ((w / 2 - line.x0) * ux + (h / 2 - line.y0) * uy) / length;
    return `linear-gradient(${num(((angle % 360) + 360) % 360)}deg, ${list((t) => 0.5 + ((t - centre) * length) / span)})`;
  }
  const dx = paint.to.x - paint.from.x;
  const dy = paint.to.y - paint.from.y;
  if (paint.type === "diamond") {
    return diamondSvgCss(paint, stops, w, h, color);
  }
  if (paint.type === "radial") {
    const r = Math.hypot(dx, dy) * 100;
    if (r < 1e-6) return null;
    return `radial-gradient(ellipse ${num(r)}% ${num(r)}% ${at}, ${list((t) => t)})`;
  }
  if (Math.hypot(dx * w, dy * h) < 1e-9) return null;
  // Canvas conic gradients start at 3 o'clock, CSS ones at 12: a quarter turn apart.
  const start = (Math.atan2(dy * h, dx * w) * 180) / Math.PI + 90;
  return `conic-gradient(from ${num(((start % 360) + 360) % 360)}deg ${at}, ${list((t) => t)})`;
}

/**
 * Exact CSS `<image>` for a diamond gradient (`t = clamp(|u| + |v|, 0, 1)`): four quadrant
 * `<linearGradient>`s from `(0, 0)` to `(±0.5, ±0.5)` inside the gradient's affine transform,
 * encoded as an inline SVG data URL. Preserves the exact L1 diamond contour and second axis.
 */
function diamondSvgCss(
  paint: GradientPaint,
  stops: readonly GradientPaint["stops"][number][],
  w: number,
  h: number,
  color: (hex: string) => string,
): string | null {
  const scale = Math.max(w, h) < 10 ? 100 : 1;
  const vw = Math.max(w * scale, 0.01);
  const vh = Math.max(h * scale, 0.01);
  const m = gradientMatrix(paint, vw, vh);
  if (!m) return null;
  const box = boxInGradientSpace(m, vw, vh);
  const xMin = Math.min(0, box.x);
  const xMax = Math.max(0, box.x + box.width);
  const yMin = Math.min(0, box.y);
  const yMax = Math.max(0, box.y + box.height);
  const f = (n: number) => `${Math.round(n * 1e4) / 1e4}`;
  const stopTags = stops
    .map((s) => `<stop offset="${f(s.position)}" stop-color="${color(s.color)}"/>`)
    .join("");
  const defs = [
    `<linearGradient id="pp" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0.5" y2="0.5">${stopTags}</linearGradient>`,
    `<linearGradient id="np" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="-0.5" y2="0.5">${stopTags}</linearGradient>`,
    `<linearGradient id="nn" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="-0.5" y2="-0.5">${stopTags}</linearGradient>`,
    `<linearGradient id="pn" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0.5" y2="-0.5">${stopTags}</linearGradient>`,
  ].join("");
  const rects = [
    `<rect x="0" y="0" width="${f(xMax)}" height="${f(yMax)}" fill="url(#pp)" shape-rendering="crispEdges"/>`,
    `<rect x="${f(xMin)}" y="0" width="${f(-xMin)}" height="${f(yMax)}" fill="url(#np)" shape-rendering="crispEdges"/>`,
    `<rect x="${f(xMin)}" y="${f(yMin)}" width="${f(-xMin)}" height="${f(-yMin)}" fill="url(#nn)" shape-rendering="crispEdges"/>`,
    `<rect x="0" y="${f(yMin)}" width="${f(xMax)}" height="${f(-yMin)}" fill="url(#pn)" shape-rendering="crispEdges"/>`,
  ].join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(vw)} ${f(vh)}" preserveAspectRatio="none"><defs>${defs}</defs><g transform="matrix(${m.map(f).join(" ")})">${rects}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** At most two decimals, without trailing zeros. */
function num(n: number): string {
  return `${Math.round(n * 100) / 100}`;
}
