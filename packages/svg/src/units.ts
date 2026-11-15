/**
 * SVG lengths in px: plain numbers and px, the absolute units (pt, pc, mm,
 * cm, in, Q), em and ex from the font size, and percentages of the viewport
 * along the axis the length runs on (the normalised diagonal for radii and
 * stroke widths), as the SVG spec resolves them.
 */

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Which way a length runs, for percentages. */
export type Axis = "x" | "y" | "other";

const ABSOLUTE: Readonly<Record<string, number>> = {
  "": 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};

const LENGTH = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z]*|%)\s*$/;

/** A length in px, or null when it isn't one. */
export function parseLength(
  text: string | null | undefined,
  axis: Axis,
  viewport: Viewport,
  fontSize = 16,
): number | null {
  if (text == null) return null;
  const m = LENGTH.exec(text);
  if (!m) return null;
  const n = Number.parseFloat(m[1] as string);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] as string).toLowerCase();
  if (unit === "%") {
    const base =
      axis === "x"
        ? viewport.width
        : axis === "y"
          ? viewport.height
          : Math.hypot(viewport.width, viewport.height) / Math.SQRT2;
    return (n / 100) * base;
  }
  if (unit === "em") return n * fontSize;
  if (unit === "ex") return n * fontSize * 0.5;
  if (unit === "rem") return n * 16;
  const k = ABSOLUTE[unit];
  return k === undefined ? null : n * k;
}

/** A plain number list (points, viewBox, dash arrays): commas or spaces. */
export function parseNumbers(text: string | null | undefined): number[] {
  if (!text) return [];
  const out: number[] = [];
  for (const t of text.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []) {
    const n = Number.parseFloat(t);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
