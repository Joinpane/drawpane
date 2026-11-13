/**
 * Text layout for single-style text nodes: font resolution, line breaking and
 * measurement. Rendering and auto-resize both use this, so what you see is
 * exactly what the file stores.
 */
import { getProp, type NodeRecord, type Props } from "@drawpane/model";

export interface TextMeasurer {
  /** Width of `text` in CSS pixels for a canvas `font` string. */
  width(font: string, text: string): number;
}

export interface TextLine {
  readonly text: string;
  readonly width: number;
  /** Baseline offset from the top of the text box. */
  readonly baseline: number;
}

export interface TextLayout {
  readonly font: string;
  readonly lines: readonly TextLine[];
  readonly lineHeight: number;
  readonly width: number;
  readonly height: number;
  readonly letterSpacing: number;
}

const FALLBACKS = '"Instrument Sans Variable", system-ui, sans-serif';

export function fontString(props: Props): string {
  const family = getProp(props, "fontFamily");
  const style = getProp(props, "fontStyle") === "italic" ? "italic " : "";
  const name = family.replace(/"/g, "");
  // Self-hosted variable fonts register as "<Family> Variable"; list both so either resolves.
  return `${style}${getProp(props, "fontWeight")} ${getProp(props, "fontSize")}px "${name}", "${name} Variable", ${FALLBACKS}`;
}

export function lineHeightPx(props: Props): number {
  const size = getProp(props, "fontSize");
  const lh = getProp(props, "lineHeight");
  if (lh.unit === "px") return lh.value;
  if (lh.unit === "percent") return (size * lh.value) / 100;
  return Math.round(size * 1.25 * 100) / 100;
}

export function letterSpacingPx(props: Props): number {
  const ls = getProp(props, "letterSpacing");
  return ls.unit === "px" ? ls.value : (getProp(props, "fontSize") * ls.value) / 100;
}

export function transformCase(text: string, props: Props): string {
  switch (getProp(props, "textCase")) {
    case "upper":
      return text.toUpperCase();
    case "lower":
      return text.toLowerCase();
    case "title":
      return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    default:
      return text;
  }
}

function measure(measurer: TextMeasurer, font: string, text: string, spacing: number): number {
  return measurer.width(font, text) + spacing * [...text].length;
}

/**
 * Breaks text into lines. With `maxWidth` null, only hard line breaks wrap
 * (auto-width text); otherwise words wrap at `maxWidth`, and a word longer
 * than a line breaks between characters.
 */
export function layoutText(
  node: NodeRecord,
  measurer: TextMeasurer,
  maxWidth: number | null,
): TextLayout {
  const props = node.props;
  const font = fontString(props);
  const size = getProp(props, "fontSize");
  const lineHeight = lineHeightPx(props);
  const spacing = letterSpacingPx(props);
  const text = transformCase(getProp(props, "characters"), props);
  // Baseline sits so the em box is centred in the line box, like CSS.
  const baselineOffset = (lineHeight - size) / 2 + size * 0.8;

  const lines: TextLine[] = [];
  const push = (t: string) => {
    lines.push({
      text: t,
      width: measure(measurer, font, t, spacing),
      baseline: lines.length * lineHeight + baselineOffset,
    });
  };

  for (const paragraph of text.split("\n")) {
    if (maxWidth === null || paragraph === "") {
      push(paragraph);
      continue;
    }
    const words = paragraph.split(/(\s+)/);
    let line = "";
    for (const word of words) {
      const candidate = line + word;
      if (line === "" || measure(measurer, font, candidate.trimEnd(), spacing) <= maxWidth) {
        line = candidate;
        continue;
      }
      push(line.trimEnd());
      line = word.trimStart();
      // Break words that don't fit on a line of their own.
      while (line !== "" && measure(measurer, font, line, spacing) > maxWidth) {
        let cut = line.length - 1;
        while (cut > 1 && measure(measurer, font, line.slice(0, cut), spacing) > maxWidth) cut--;
        push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    push(line.trimEnd());
  }

  const width = lines.reduce((m, l) => Math.max(m, l.width), 0);
  return {
    font,
    lines,
    lineHeight,
    width,
    height: lines.length * lineHeight,
    letterSpacing: spacing,
  };
}

/** The width and height a text node should have after its content or style changed. */
export function autoSize(
  node: NodeRecord,
  measurer: TextMeasurer,
): { width: number; height: number } | null {
  const mode = getProp(node.props, "textAutoResize");
  if (mode === "none") return null;
  if (mode === "width") {
    const layout = layoutText(node, measurer, null);
    return { width: Math.ceil(layout.width), height: layout.height };
  }
  const width = getProp(node.props, "width");
  const layout = layoutText(node, measurer, width);
  return { width, height: layout.height };
}

/** Measures with a canvas 2D context, caching widths per font. */
export class CanvasTextMeasurer implements TextMeasurer {
  readonly #ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  readonly #cache = new Map<string, number>();

  constructor() {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1)
        : document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas is not available");
    this.#ctx = ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  }

  width(font: string, text: string): number {
    const key = `${font}\u0000${text}`;
    let w = this.#cache.get(key);
    if (w === undefined) {
      this.#ctx.font = font;
      w = this.#ctx.measureText(text).width;
      if (this.#cache.size > 20_000) this.#cache.clear();
      this.#cache.set(key, w);
    }
    return w;
  }

  /** Call after web fonts load: earlier measurements used fallback fonts. */
  invalidate(): void {
    this.#cache.clear();
  }
}
