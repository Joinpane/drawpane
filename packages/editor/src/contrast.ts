/**
 * Text contrast, the WCAG 2 way: how a text layer's colour stands against
 * what's behind it, as a ratio and a level (AAA, AA, or not enough).
 *
 * The background is the stack of solid fills behind the text: its frames,
 * nearest first, composited down to the first opaque one, then the page's
 * background. When nothing opaque is behind it (the page follows the
 * viewer's theme), there's no single answer, so none is given.
 */
import { getProp, type Paint } from "@drawpane/model";
import type { Doc } from "./doc";

type Rgba = { r: number; g: number; b: number; a: number };

function parseHex(color: string): Rgba | null {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 16);
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
    a: m[2] ? Number.parseInt(m[2], 16) / 255 : 1,
  };
}

/** A paint's solid colour with its opacity folded into alpha, or null for gradients and images. */
function solid(paint: Paint): Rgba | null {
  if (paint.visible === false || paint.type !== "solid") return null;
  const c = parseHex(paint.color);
  return c ? { ...c, a: c.a * (paint.opacity ?? 1) } : null;
}

/** `top` over `bottom` (source-over). */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgba): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const hex = ({ r, g, b }: Rgba) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

export interface TextContrast {
  /** For example 4.6 (meaning 4.6:1), rounded to one decimal. */
  readonly ratio: number;
  readonly level: "AAA" | "AA" | "fail";
  /** The background it was measured against, as #rrggbb. */
  readonly background: string;
  /** Large text (24px, or 18.66px bold) needs less contrast. */
  readonly large: boolean;
}

/**
 * The contrast of a text layer against what's behind it, or null when that
 * can't be known (no solid fill on the text, or nothing opaque behind it).
 */
export function textContrast(doc: Doc, id: string): TextContrast | null {
  const node = doc.get(id);
  if (node?.type !== "text") return null;
  const fills = getProp(node.props, "fills");
  const text = fills.length === 0 ? parseHex("#000000") : fills.map(solid).find((c) => c);
  if (!text) return null;

  // Fills behind the text, nearest first, until one is opaque.
  const layers: Rgba[] = [];
  let opaque = false;
  for (const ancestor of doc.ancestors(id)) {
    const paints =
      ancestor.type === "page"
        ? ((): Paint[] => {
            const bg = getProp(ancestor.props, "backgroundColor");
            return bg ? [{ type: "solid", color: bg }] : [];
          })()
        : ancestor.type === "frame"
          ? getProp(ancestor.props, "fills")
          : [];
    // A layer's fills stack bottom to top; the topmost is nearest the text.
    for (const paint of [...paints].reverse()) {
      const c = solid(paint);
      if (!c) continue;
      layers.push(c);
      if (c.a >= 1) {
        opaque = true;
        break;
      }
    }
    if (opaque) break;
  }
  if (!opaque) return null;
  const background = layers.reduceRight<Rgba | null>(
    (below, layer) => (below ? over(layer, below) : layer),
    null,
  ) as Rgba;
  const color = over(text, background);
  const ratio = Math.round(contrastRatio(color, background) * 10) / 10;
  const size = getProp(node.props, "fontSize");
  const large = size >= 24 || (size >= 18.66 && getProp(node.props, "fontWeight") >= 700);
  const level = ratio >= (large ? 4.5 : 7) ? "AAA" : ratio >= (large ? 3 : 4.5) ? "AA" : "fail";
  return { ratio, level, background: hex(background), large };
}
