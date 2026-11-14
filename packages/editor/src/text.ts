/**
 * Text layout: font resolution, line breaking and measurement, for plain and
 * rich text (see `rich-text.ts`). Rendering, export, auto-resize and the
 * in-place editor's caret all use this, so what you see is exactly what the
 * file stores.
 */
import { getProp, type NodeRecord, type Paint, type Props } from "@drawpane/model";
import { type TextSpan, textSpans } from "./rich-text";

export interface TextMeasurer {
  /** Width of `text` in CSS pixels for a canvas `font` string. */
  width(font: string, text: string): number;
  /** Bumped whenever earlier widths stop being right (a web font arrived), so cached layouts go too. */
  readonly generation?: number;
}

/** A stretch of a line in one style. */
export interface TextFragment {
  /** Where it comes from in `characters`: [start, end). */
  readonly start: number;
  readonly end: number;
  /** What's drawn (after the text case). */
  readonly text: string;
  /** From the line's start. */
  readonly x: number;
  readonly width: number;
  readonly font: string;
  readonly fontSize: number;
  readonly letterSpacing: number;
  readonly decoration: "none" | "underline" | "strikethrough";
  /** Its own fills, or null when it uses the layer's. */
  readonly fills: readonly Paint[] | null;
}

export interface TextLine {
  /** What's drawn, trailing spaces trimmed (after the text case). */
  readonly text: string;
  readonly width: number;
  /** Baseline offset from the top of the text box. */
  readonly baseline: number;
  /** The line box: its top and height. */
  readonly top: number;
  readonly height: number;
  /** Its characters: [start, end) without the trailing spaces it ends with. */
  readonly start: number;
  readonly end: number;
  /** Where the next line starts (after trailing spaces or the line break). */
  readonly next: number;
  readonly fragments: readonly TextFragment[];
}

export interface TextLayout {
  /** The layer's own font (rich text may use others; see each fragment). */
  readonly font: string;
  readonly lines: readonly TextLine[];
  /** The layer's own line height. */
  readonly lineHeight: number;
  readonly width: number;
  readonly height: number;
  /** The layer's own letter spacing. */
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

const WORD = /[\p{L}\p{N}_]/u;

/** `text.slice(a, b)` in its case; title case looks at the character before `a`. */
function caseSlice(text: string, a: number, b: number, props: Props): string {
  const slice = text.slice(a, b);
  const mode = getProp(props, "textCase");
  if (mode !== "title") return mode === "none" ? slice : transformCase(slice, props);
  let out = "";
  for (let i = a; i < b; i++) {
    const c = text[i] as string;
    out += /\p{L}/u.test(c) && (i === 0 || !WORD.test(text[i - 1] as string)) ? c.toUpperCase() : c;
  }
  return out;
}

/** How a span is drawn, worked out once per layout. */
interface SpanStyle {
  readonly span: TextSpan;
  readonly font: string;
  readonly size: number;
  readonly spacing: number;
  /** Half-leading plus ascent, and what's left below the baseline. */
  readonly ascent: number;
  readonly descent: number;
}

function spanStyles(node: NodeRecord): SpanStyle[] {
  return textSpans(node).map((span) => {
    const size = getProp(span.props, "fontSize");
    const lh = lineHeightPx(span.props);
    // The em box centred in the line box, like CSS.
    const ascent = (lh - size) / 2 + size * 0.8;
    return {
      span,
      font: fontString(span.props),
      size,
      spacing: letterSpacingPx(span.props),
      ascent,
      descent: lh - ascent,
    };
  });
}

/** Measures stretches of one layer's text across its styles. */
class RangeMeasure {
  constructor(
    readonly text: string,
    readonly styles: readonly SpanStyle[],
    readonly measurer: TextMeasurer,
  ) {}

  /** The index of the style at character `i` (the last style for the end). */
  styleAt(i: number): number {
    const { styles } = this;
    if (styles.length === 1) return 0;
    let lo = 0;
    let hi = styles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((styles[mid] as SpanStyle).span.start <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The advance of [a, b): glyphs plus letter spacing. */
  width(a: number, b: number): number {
    if (b <= a) return 0;
    let total = 0;
    for (let k = this.styleAt(a); k < this.styles.length; k++) {
      const s = this.styles[k] as SpanStyle;
      if (s.span.start >= b) break;
      const x = Math.max(a, s.span.start);
      const y = Math.min(b, s.span.end);
      if (y <= x) continue;
      const drawn = caseSlice(this.text, x, y, s.span.props);
      total += this.measurer.width(s.font, drawn) + s.spacing * [...drawn].length;
    }
    return total;
  }
}

interface CachedLayout {
  readonly measurer: TextMeasurer;
  readonly generation: number;
  readonly maxWidth: number | null;
  readonly layout: TextLayout;
}
/**
 * Layouts by the props they were made from. A node's props object is
 * replaced on every change, so a hit is always current; the canvas draws
 * every text layer every frame, and this makes all but the first free.
 */
const layoutCache = new WeakMap<object, CachedLayout>();

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
  const generation = measurer.generation ?? 0;
  const hit = layoutCache.get(node.props);
  if (
    hit &&
    hit.measurer === measurer &&
    hit.generation === generation &&
    hit.maxWidth === maxWidth
  )
    return hit.layout;
  const layout = computeLayout(node, measurer, maxWidth);
  layoutCache.set(node.props, { measurer, generation, maxWidth, layout });
  return layout;
}

function computeLayout(
  node: NodeRecord,
  measurer: TextMeasurer,
  maxWidth: number | null,
): TextLayout {
  const props = node.props;
  const text = getProp(props, "characters");
  const styles = spanStyles(node);
  const m = new RangeMeasure(text, styles, measurer);
  const breaks: Array<{ start: number; end: number; next: number }> = [];

  const trimEnd = (a: number, b: number) => {
    while (b > a && /\s/.test(text[b - 1] as string)) b--;
    return b;
  };
  let paragraph = 0;
  while (paragraph <= text.length) {
    const nl = text.indexOf("\n", paragraph);
    const pEnd = nl === -1 ? text.length : nl;
    const after = nl === -1 ? text.length + 1 : nl + 1;
    if (maxWidth === null || pEnd === paragraph) {
      breaks.push({ start: paragraph, end: trimEnd(paragraph, pEnd), next: after });
    } else {
      let start = paragraph;
      let end = paragraph;
      // The line's width so far, as the sum of its words' and spaces' widths:
      // each is measured once (and repeats across a file, so the measurer's
      // cache answers most), instead of measuring the growing line each time.
      let lineWidth = 0;
      const tokens = /\s+|\S+/g;
      tokens.lastIndex = 0;
      const slice = text.slice(paragraph, pEnd);
      for (let match = tokens.exec(slice); match; match = tokens.exec(slice)) {
        const a = paragraph + match.index;
        const b = a + match[0].length;
        const space = /\s/.test(match[0]);
        const tokenWidth = m.width(a, b);
        // Spaces never push a line over: trailing spaces don't count.
        if (end === start || space || lineWidth + tokenWidth <= maxWidth) {
          end = b;
          lineWidth += tokenWidth;
          continue;
        }
        breaks.push({ start, end: trimEnd(start, end), next: a });
        // A line never starts with the spaces that ended the one before.
        start = space ? b : a;
        end = b;
        lineWidth = space ? 0 : tokenWidth;
        // Break words that don't fit on a line of their own.
        if (lineWidth > maxWidth) {
          while (end > start && m.width(start, end) > maxWidth) {
            let cut = end - 1;
            while (cut > start + 1 && m.width(start, cut) > maxWidth) cut--;
            if (cut > start + 1 && isLow(text.charCodeAt(cut))) cut--;
            breaks.push({ start, end: cut, next: cut });
            start = cut;
          }
          lineWidth = m.width(start, end);
        }
      }
      breaks.push({ start, end: trimEnd(start, end), next: after });
    }
    paragraph = after;
  }

  const lines: TextLine[] = [];
  let top = 0;
  for (const br of breaks) {
    // The styles on this line (an empty line takes the style at its start).
    const first = m.styleAt(br.start);
    const last = br.end > br.start ? m.styleAt(br.end - 1) : first;
    let ascent = 0;
    let descent = 0;
    const fragments: TextFragment[] = [];
    let x = 0;
    for (let k = first; k <= last; k++) {
      const s = styles[k] as SpanStyle;
      ascent = Math.max(ascent, s.ascent);
      descent = Math.max(descent, s.descent);
      const a = Math.max(br.start, s.span.start);
      const b = Math.min(br.end, s.span.end);
      if (b <= a) continue;
      const width = m.width(a, b);
      const fills = s.span.own.fills;
      fragments.push({
        start: a,
        end: b,
        text: caseSlice(text, a, b, s.span.props),
        x,
        width,
        font: s.font,
        fontSize: s.size,
        letterSpacing: s.spacing,
        decoration: getProp(s.span.props, "textDecoration"),
        fills: fills ?? null,
      });
      x += width;
    }
    const height = ascent + descent;
    lines.push({
      text: fragments.map((f) => f.text).join(""),
      width: x,
      baseline: top + ascent,
      top,
      height,
      start: br.start,
      end: br.end,
      next: Math.min(br.next, text.length + 1),
      fragments,
    });
    top += height;
  }

  const width = lines.reduce((w, l) => Math.max(w, l.width), 0);
  return {
    font: fontString(props),
    lines,
    lineHeight: lineHeightPx(props),
    width,
    height: top,
    letterSpacing: letterSpacingPx(props),
  };
}

const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Where a line starts in a box `width` wide, for the layer's alignment. */
export function lineOffset(line: TextLine, width: number, props: Props): number {
  const align = getProp(props, "textAlign");
  return align === "center" ? (width - line.width) / 2 : align === "right" ? width - line.width : 0;
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

/** Lays a text node out at its current box, the way the canvas draws it. */
export function layoutTextNode(node: NodeRecord, measurer: TextMeasurer): TextLayout {
  const mode = getProp(node.props, "textAutoResize");
  return layoutText(node, measurer, mode === "width" ? null : getProp(node.props, "width"));
}

// ---------------------------------------------------------------------------
// Caret and selection, in the text box's coordinates (for the in-place editor)

export interface CaretBox {
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

/** Where the layer's vertical alignment puts the text block. */
export function textBlockOffset(node: NodeRecord, layout: TextLayout): number {
  const height = getProp(node.props, "height");
  const v = getProp(node.props, "textAlignVertical");
  return v === "middle"
    ? (height - layout.height) / 2
    : v === "bottom"
      ? height - layout.height
      : 0;
}

/** The line a caret at `index` is on: the last one starting at or before it. */
export function lineOf(layout: TextLayout, index: number): number {
  let k = 0;
  for (let i = 0; i < layout.lines.length; i++)
    if ((layout.lines[i] as TextLine).start <= index) k = i;
  return k;
}

function measureFor(node: NodeRecord, measurer: TextMeasurer): RangeMeasure {
  return new RangeMeasure(getProp(node.props, "characters"), spanStyles(node), measurer);
}

/** The caret before character `index`. */
export function caretBox(
  node: NodeRecord,
  layout: TextLayout,
  measurer: TextMeasurer,
  index: number,
): CaretBox {
  const line = layout.lines[lineOf(layout, index)] as TextLine;
  const width = getProp(node.props, "width");
  const x =
    lineOffset(line, width, node.props) +
    measureFor(node, measurer).width(line.start, Math.max(line.start, index));
  return { x, y: line.top + textBlockOffset(node, layout), height: line.height };
}

/** The caret index nearest a point in the text box. */
export function indexAtPoint(
  node: NodeRecord,
  layout: TextLayout,
  measurer: TextMeasurer,
  px: number,
  py: number,
): number {
  const y = py - textBlockOffset(node, layout);
  let k = layout.lines.length - 1;
  for (let i = 0; i < layout.lines.length; i++) {
    const l = layout.lines[i] as TextLine;
    if (y < l.top + l.height) {
      k = i;
      break;
    }
  }
  return indexOnLine(node, layout, measurer, k, px);
}

/** The caret index on line `k` nearest `px` (for clicks and ↑ ↓). */
export function indexOnLine(
  node: NodeRecord,
  layout: TextLayout,
  measurer: TextMeasurer,
  k: number,
  px: number,
): number {
  const line = layout.lines[Math.max(0, Math.min(k, layout.lines.length - 1))] as TextLine;
  const m = measureFor(node, measurer);
  const x = px - lineOffset(line, getProp(node.props, "width"), node.props);
  // The widest the caret can go on this line: its end, or the line break.
  let lo = line.start;
  let hi = line.end;
  if (x <= 0) return lo;
  if (x >= m.width(line.start, hi)) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (m.width(line.start, mid) <= x) lo = mid;
    else hi = mid;
  }
  const left = m.width(line.start, lo);
  const right = m.width(line.start, hi);
  let at = x - left < right - x ? lo : hi;
  if (isLow(getProp(node.props, "characters").charCodeAt(at))) at--;
  return at;
}

/** The highlight for a selection [a, b): one box per line it covers. */
export function selectionBoxes(
  node: NodeRecord,
  layout: TextLayout,
  measurer: TextMeasurer,
  a: number,
  b: number,
): Array<{ x: number; y: number; width: number; height: number }> {
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  if (start === end) return [];
  const m = measureFor(node, measurer);
  const width = getProp(node.props, "width");
  const dy = textBlockOffset(node, layout);
  const out: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const line of layout.lines) {
    if (line.next <= start || line.start >= end) continue;
    if (line.start > end) break;
    const from = Math.max(start, line.start);
    const to = Math.min(end, line.end);
    const x0 = lineOffset(line, width, node.props);
    const x1 = x0 + m.width(line.start, from);
    let x2 = x0 + m.width(line.start, Math.max(from, to));
    // A selection running on past the line shows its line break or spaces.
    if (end > line.end && line.next <= end) x2 += Math.max(4, line.height * 0.25);
    out.push({ x: x1, y: line.top + dy, width: Math.max(0, x2 - x1), height: line.height });
  }
  return out;
}

/** Measures with a canvas 2D context, caching widths per font. */
export class CanvasTextMeasurer implements TextMeasurer {
  readonly #ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  readonly #cache = new Map<string, number>();
  #generation = 0;

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

  get generation(): number {
    return this.#generation;
  }

  /** Call after web fonts load: earlier measurements used fallback fonts. */
  invalidate(): void {
    this.#cache.clear();
    this.#generation++;
  }
}
