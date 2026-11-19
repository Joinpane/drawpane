/**
 * Dashed strokes as Figma draws them: each segment of the outline (a
 * straight edge, a rounded or smoothed corner, a quarter of an ellipse) gets a whole
 * number of the dash pattern, stretched or squeezed to fit, with a dash
 * centred on each end. So dashes meet every corner the same way, instead of
 * wherever a continuous pattern happens to fall.
 */
import { boxPieces } from "./corners";

/** A piece of an outline, in the layer's units, with its length. */
export type OutlineSegment =
  | {
      readonly kind: "line";
      readonly x0: number;
      readonly y0: number;
      readonly x1: number;
      readonly y1: number;
      readonly length: number;
    }
  | {
      /** Part of an ellipse (a circle when rx = ry), clockwise from `start` to `end` (radians, y down). */
      readonly kind: "arc";
      readonly cx: number;
      readonly cy: number;
      readonly rx: number;
      readonly ry: number;
      readonly start: number;
      readonly end: number;
      readonly length: number;
    }
  | {
      /** A box's corner, as corners.ts draws it: its start point, then six numbers per cubic. */
      readonly kind: "cubic";
      readonly pts: readonly number[];
      readonly length: number;
    };

/** The length of an elliptical arc, by Simpson's rule (exact enough for laying out dashes). */
function arcLength(rx: number, ry: number, start: number, end: number): number {
  const n = 32;
  const step = (end - start) / n;
  const speed = (t: number) => Math.hypot(rx * Math.sin(t), ry * Math.cos(t));
  let sum = speed(start) + speed(end);
  for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * speed(start + i * step);
  return (sum * step) / 3;
}

const arc = (
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  start: number,
  end: number,
): OutlineSegment => ({
  kind: "arc",
  cx,
  cy,
  rx,
  ry,
  start,
  end,
  length: arcLength(rx, ry, start, end),
});

/**
 * A box's outline, clockwise from the top left: its edges, and its corners
 * where they're rounded (radii top left, top right, bottom right, bottom
 * left, with `smoothing`), each corner as corners.ts draws it.
 */
export function boxOutline(
  w: number,
  h: number,
  radii: readonly [number, number, number, number],
  smoothing = 0,
): OutlineSegment[] {
  return boxPieces(w, h, radii, smoothing);
}

/** An ellipse filling the box: four quarters, from its rightmost point, clockwise. */
export function ellipseOutline(w: number, h: number): OutlineSegment[] {
  const q = Math.PI / 2;
  return [0, 1, 2, 3]
    .map((i) => arc(w / 2, h / 2, w / 2, h / 2, i * q, (i + 1) * q))
    .filter((s) => s.length > 1e-6);
}

/**
 * The dash pattern for a segment `length` long: a whole number of the
 * pattern (at least one), scaled to fit, and the offset that centres a
 * dash on the segment's start (and so, its end).
 */
export function fitDashes(
  length: number,
  pattern: readonly number[],
): { dashes: number[]; offset: number } {
  // An odd pattern repeats twice over, as a canvas's line dash does.
  const full = pattern.length % 2 ? [...pattern, ...pattern] : [...pattern];
  const period = full.reduce((a, b) => a + b, 0);
  if (period <= 0 || length <= 0) return { dashes: full, offset: 0 };
  const repeats = Math.max(1, Math.round(length / period));
  const scale = length / (repeats * period);
  const dashes = full.map((d) => d * scale);
  return { dashes, offset: (dashes[0] as number) / 2 };
}
