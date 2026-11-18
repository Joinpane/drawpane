/**
 * Text layout: font resolution, line breaking and measurement, for plain and
 * rich text (see `rich-text.ts`). Rendering, export, auto-resize and the
 * in-place editor's caret all use this, so what you see is exactly what the
 * file stores.
 */
import {
  type FontFeatures,
  type FontVariations,
  getProp,
  type NodeRecord,
  type Paint,
  type Props,
} from "@drawpane/model";
import { MISSING_GLYPH_FAMILY } from "./missing-glyph-font";
import { type TextSpan, textSpans } from "./rich-text";

export interface TextMeasurer {
  /**
   * Width of `text` in CSS pixels for a canvas `font` string; with a feature
   * `run`, as shaped with its OpenType features when the measurer can (else
   * as the canvas has it).
   */
  width(font: string, text: string, run?: ShapingRun | null): number;
  /**
   * The glyphs for `text` with the run's OpenType features, or null when
   * they can't be shaped (no shaper, the font's bytes aren't at hand or are
   * still loading): the text then draws without them. See decision 0005.
   */
  shape?(text: string, run: ShapingRun): ShapedText | null;
  /**
   * The font's own ascent and descent in px (no leading), for a canvas `font`
   * string: what "auto" line height and the baseline come from, as in Figma.
   * Missing (or null) where fonts can't be measured; constants stand in.
   */
  metrics?(font: string): FontMetrics | null;
  /** Bumped whenever earlier widths stop being right (a web font arrived), so cached layouts go too. */
  readonly generation?: number;
  /**
   * The family text named `family` at `size` px is drawn in: itself, or what
   * a font alias stands in for it (decision 0036). Missing: itself.
   */
  family?(family: string, size: number): string;
  /**
   * Whether nothing here draws text named `family` at `size` px in this
   * weight and style, after font aliases: it would come out in a fallback
   * face (decision 0037). Missing: nothing is known to be missing.
   */
  missing?(family: string, size: number, weight: number, italic: boolean): boolean;
}

/**
 * Which family text is drawn in, where font aliases are known (decision
 * 0036): the browser's font registry, the Worker's team lookup. A measurer
 * that has one answers `family` from it.
 */
export interface FontResolver {
  /** The family text named `family` at `size` px is drawn in. */
  family(family: string, size: number): string;
  /**
   * Whether nothing here draws text named `family` at `size` px in this
   * weight and style, after aliases. Missing: nothing is known to be missing.
   */
  missing?(family: string, size: number, weight: number, italic: boolean): boolean;
  /** Families text named `family` may be drawn in besides itself (by size): what to load ahead. */
  standIns(family: string): readonly string[];
  /** Bumped when what families resolve to may have changed. */
  readonly generation: number;
}

/** The family text in `props` is drawn in, through the measurer's aliases when it has any. */
export function drawnFamily(props: Props, fonts?: Pick<TextMeasurer, "family"> | null): string {
  const family = getProp(props, "fontFamily");
  return fonts?.family?.(family, getProp(props, "fontSize")) ?? family;
}

/**
 * A run's face, OpenType features and variable axes: what shaping needs
 * besides the text. Only runs that set features or axes are shaped; the
 * rest are measured and drawn by the canvas.
 */
export interface ShapingRun {
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
  readonly size: number;
  /** OpenType features it turns on or off (decision 0005); may be empty when it sets axes. */
  readonly features: FontFeatures;
  /** Variable axes it sets (decision 0009); may be empty when it sets features. */
  readonly variations: FontVariations;
  /** Everything above as one string, for caches. */
  readonly key: string;
}

/** One glyph of shaped text. */
export interface ShapedGlyph {
  /** Its outline in font units (y up), null for one with none (a space). */
  readonly path: Path2D | null;
  /** The same outline as SVG path data ("" for none), for export. */
  readonly d: string;
  /** Where it's drawn from the run's start, in px: right, and up from the baseline. */
  readonly x: number;
  readonly y: number;
  /** The first character it came from (a UTF-16 index into the run's text). */
  readonly cluster: number;
}

export interface ShapedText {
  readonly glyphs: readonly ShapedGlyph[];
  /** The advance, in px, without letter spacing. */
  readonly width: number;
  /** Px per font unit. */
  readonly scale: number;
}

/** A run's settings as a stable string: sorted tags, so the same settings share a cache entry. */
function settingsKey(
  map: Readonly<Record<string, number | boolean>>,
  tags: readonly string[],
): string {
  return tags.map((t) => `${t}=${Number(map[t])}`).join(",");
}

/**
 * A span's shaping run, or null when it sets no features or axes (the fast
 * path: the canvas draws it). Its family is the one it's drawn in (`fonts`'s
 * aliases).
 */
export function shapingRun(
  props: Props,
  fonts?: Pick<TextMeasurer, "family"> | null,
): ShapingRun | null {
  const features = getProp(props, "fontFeatures");
  const variations = getProp(props, "fontVariations");
  const featureTags = Object.keys(features).sort();
  const axisTags = Object.keys(variations).sort();
  if (featureTags.length === 0 && axisTags.length === 0) return null;
  const family = drawnFamily(props, fonts);
  const weight = getProp(props, "fontWeight");
  const italic = getProp(props, "fontStyle") === "italic";
  const size = getProp(props, "fontSize");
  return {
    family,
    weight,
    italic,
    size,
    features,
    variations,
    key: `${family}|${weight}|${italic ? "i" : "n"}|${size}|${settingsKey(features, featureTags)}|${settingsKey(variations, axisTags)}`,
  };
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
  /** Its OpenType features and variable axes, when it sets any: drawn from shaped glyphs. */
  readonly run: ShapingRun | null;
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
  /** How far its text starts in from the box's left (a list's indent), before alignment. */
  readonly indent: number;
  /** A list item's bullet or number, on its paragraph's first line. */
  readonly marker: TextMarker | null;
  /** Its line height: the tallest of its characters'. Its baseline is this far below the last. */
  readonly step: number;
  /** How far its tallest capitals rise above its baseline (for vertical trim). */
  readonly cap: number;
}

/** A list item's bullet or number: drawn left of the text, at `x` from where the text starts. */
export interface TextMarker {
  readonly text: string;
  readonly x: number;
  readonly width: number;
  readonly font: string;
  readonly fontSize: number;
  readonly fills: readonly Paint[] | null;
  readonly run: ShapingRun | null;
}

/** A list level's indent, in its first character's font size (Figma's, measured). */
export const LIST_INDENT_EM = 1.5;
/** The gap between a number and its item's text, in the same (measured: 0.375 at 16 and 28 px). */
export const LIST_NUMBER_GAP_EM = 0.375;

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

/**
 * After a text's own family: the missing-glyph box for private-use
 * characters its font lacks (SF Symbols in a font without them, decision
 * 0036), then the editor's fallback. The box font covers nothing else, so
 * every other character falls through to the fallback as before.
 */
const FALLBACKS = `"${MISSING_GLYPH_FAMILY}", "Instrument Sans Variable", system-ui, sans-serif`;

/** A canvas font string for `props`, in the family it's drawn in (`fonts`'s aliases, when given). */
export function fontString(props: Props, fonts?: Pick<TextMeasurer, "family"> | null): string {
  const style = getProp(props, "fontStyle") === "italic" ? "italic " : "";
  const name = drawnFamily(props, fonts).replace(/"/g, "");
  // Self-hosted variable fonts register as "<Family> Variable"; list both so either resolves.
  return `${style}${getProp(props, "fontWeight")} ${getProp(props, "fontSize")}px "${name}", "${name} Variable", ${FALLBACKS}`;
}

export interface FontMetrics {
  readonly ascent: number;
  readonly descent: number;
  /** How far capitals rise above the baseline, when known. */
  readonly capHeight?: number;
}

/**
 * A cap height in em from the top of "H" as Chromium's canvas reads it at
 * 1000 px. Skia measures glyph bounds for text over 256 px at 64 px, in
 * whole pixels rounded out, so the reading is the cap height rounded up to a
 * 64th of an em: the cap height is somewhere in the 64th below it. Its
 * middle is the best guess. The top would be up to a 64th too tall (Inter's
 * 0.7275 read as 0.7344: 17.63 px at 24 px, where Figma trims to 17.46,
 * which then draws a pixel low once baselines are rounded); the middle
 * (0.7266) is at most half a 64th out either way.
 */
export function capHeightEm(reading: number): number {
  return reading - 1 / 128;
}

/** Where fonts can't be measured: a typical ascent, descent and cap height, in em. */
const FALLBACK_ASCENT = 0.8;
const FALLBACK_CAP = 0.7;
const FALLBACK_LINE = 1.25;

/**
 * A line's height in px. "Auto" is the font's own height, ascent plus
 * descent, rounded to whole pixels (as in Figma), when the measurer knows
 * the font's metrics.
 */
export function lineHeightPx(props: Props, measurer?: TextMeasurer | null): number {
  const size = getProp(props, "fontSize");
  const lh = getProp(props, "lineHeight");
  if (lh.unit === "px") return lh.value;
  if (lh.unit === "percent") return (size * lh.value) / 100;
  const m = measurer?.metrics?.(fontString(props, measurer));
  // Figma rounds a font's own height to whole pixels (19.36 → 19 for 16 px Inter).
  return m
    ? Math.max(1, Math.round(m.ascent + m.descent))
    : Math.round(size * FALLBACK_LINE * 100) / 100;
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

/** Hyphens and dashes a word may break after (hyphen-minus, hyphen, en and em dash). */
const HYPHENS: ReadonlySet<string> = new Set(["-", "\u2010", "\u2013", "\u2014"]);

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
  readonly run: ShapingRun | null;
  /** Half-leading plus ascent, and what's left below the baseline. */
  readonly ascent: number;
  readonly descent: number;
  /** Its line height, in px. */
  readonly lineHeight: number;
  /** Its font's cap height, in px. */
  readonly cap: number;
}

function spanStyles(node: NodeRecord, measurer: TextMeasurer): SpanStyle[] {
  return textSpans(node).map((span) => {
    const size = getProp(span.props, "fontSize");
    const font = fontString(span.props, measurer);
    const lh = lineHeightPx(span.props, measurer);
    // The font's own height centred in the line box, its baseline an ascent below that, as in
    // Figma and CSS. Without the font's metrics, a typical ascent stands in.
    const m = measurer.metrics?.(font) ?? { ascent: size * FALLBACK_ASCENT, descent: size * 0.2 };
    const ascent = (lh - (m.ascent + m.descent)) / 2 + m.ascent;
    return {
      span,
      font,
      size,
      spacing: letterSpacingPx(span.props),
      run: shapingRun(span.props, measurer),
      ascent,
      descent: lh - ascent,
      lineHeight: lh,
      cap: m.capHeight ?? size * FALLBACK_CAP,
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
      total += this.measurer.width(s.font, drawn, s.run) + s.spacing * [...drawn].length;
    }
    return total;
  }
}

interface CachedLayout {
  readonly measurer: TextMeasurer;
  readonly generation: number;
  readonly maxWidth: number | null;
  readonly whole: boolean;
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
  options: LayoutOptions = {},
): TextLayout {
  const generation = measurer.generation ?? 0;
  const whole = options.whole ?? false;
  const hit = layoutCache.get(node.props);
  if (
    hit &&
    hit.measurer === measurer &&
    hit.generation === generation &&
    hit.maxWidth === maxWidth &&
    hit.whole === whole
  )
    return hit.layout;
  const layout = computeLayout(node, measurer, maxWidth, whole);
  layoutCache.set(node.props, { measurer, generation, maxWidth, whole, layout });
  return layout;
}

export interface LayoutOptions {
  /** Every line, even past `maxLines`: while the text is being edited, all of it shows. */
  readonly whole?: boolean;
}

function computeLayout(
  node: NodeRecord,
  measurer: TextMeasurer,
  maxWidth: number | null,
  whole: boolean,
): TextLayout {
  const props = node.props;
  const text = getProp(props, "characters");
  const styles = spanStyles(node, measurer);
  const m = new RangeMeasure(text, styles, measurer);
  /**
   * `para`: the line ends a paragraph that another follows (paragraph spacing goes after it).
   * `indent`: its paragraph's list indent; `marker`: the bullet or number its first line has.
   */
  type Break = {
    start: number;
    end: number;
    next: number;
    para?: boolean;
    indent?: number;
    marker?: string | null;
    /** Whether its paragraph is a list item. */
    list?: boolean;
  };
  const breaks: Break[] = [];
  // Numbered lists count per level; a paragraph out of the list starts them over.
  const counters: number[] = [];

  const trimEnd = (a: number, b: number) => {
    while (b > a && /\s/.test(text[b - 1] as string)) b--;
    return b;
  };
  let paragraph = 0;
  while (paragraph <= text.length) {
    const nl = text.indexOf("\n", paragraph);
    const pEnd = nl === -1 ? text.length : nl;
    const after = nl === -1 ? text.length + 1 : nl + 1;
    const para = nl !== -1;
    // A list item: indented a level at a time, its first line marked (decision 0017).
    const first = styles[m.styleAt(paragraph)] as SpanStyle;
    const listType = getProp(first.span.props, "listType");
    const level = listType === "none" ? 0 : getProp(first.span.props, "listLevel");
    const indent = listType === "none" ? 0 : (level + 1) * LIST_INDENT_EM * first.size;
    let marker: string | null = null;
    if (listType === "none") counters.length = 0;
    else {
      counters.length = level + 1;
      counters[level] = listType === "number" ? (counters[level] ?? 0) + 1 : 0;
      marker = listType === "number" ? `${counters[level]}.` : "•";
    }
    const room = maxWidth === null ? null : Math.max(1, maxWidth - indent);
    /**
     * Where a word may break after one of its hyphens, as line breaking does
     * (Unicode's line breaking rules, as Figma breaks): the last place in
     * text[a, b) after a hyphen or dash, not at the word's start and not
     * before a digit (so "-1" and "2024-11" stay whole), that leaves at most
     * `width` before it; -1 when there's none.
     */
    const hyphenBreak = (a: number, b: number, width: number): number => {
      for (let p = b - 1; p > a + 1; p--) {
        if (!HYPHENS.has(text[p - 1] as string) || /[\d\s]/.test(text[p] as string)) continue;
        if (m.width(a, p) <= width) return p;
      }
      return -1;
    };
    const lines = breaks.length;
    if (room === null || pEnd === paragraph) {
      breaks.push({ start: paragraph, end: trimEnd(paragraph, pEnd), next: after, para });
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
        const fits = space || lineWidth + tokenWidth <= room;
        if (fits || (end === start && hyphenBreak(a, b, room) === -1)) {
          end = b;
          lineWidth += tokenWidth;
          continue;
        }
        // A hyphenated word breaks after a hyphen when its start fits, as in Figma.
        const cut = hyphenBreak(a, b, room - lineWidth);
        if (cut !== -1) {
          breaks.push({ start, end: cut, next: cut });
          start = cut;
          end = b;
          lineWidth = m.width(cut, b);
        } else {
          breaks.push({ start, end: trimEnd(start, end), next: a });
          // A line never starts with the spaces that ended the one before.
          start = space ? b : a;
          end = b;
          lineWidth = space ? 0 : tokenWidth;
        }
        // Break words that don't fit on a line of their own.
        if (lineWidth > room) {
          while (end > start && m.width(start, end) > room) {
            let cut = end - 1;
            while (cut > start + 1 && m.width(start, cut) > room) cut--;
            if (cut > start + 1 && isLow(text.charCodeAt(cut))) cut--;
            // One character wider than the line is left: it's the line (cutting before it would never end).
            if (cut <= start) break;
            breaks.push({ start, end: cut, next: cut });
            start = cut;
          }
          lineWidth = m.width(start, end);
        }
      }
      breaks.push({ start, end: trimEnd(start, end), next: after, para });
    }
    for (let k = lines; k < breaks.length; k++) {
      const br = breaks[k] as Break;
      br.indent = indent;
      br.marker = k === lines ? marker : null;
      br.list = listType !== "none";
    }
    paragraph = after;
  }

  const fragmentOf = (
    s: SpanStyle,
    a: number,
    b: number,
    shown: string,
    x: number,
    width: number,
  ): TextFragment => ({
    start: a,
    end: b,
    text: shown,
    x,
    width,
    font: s.font,
    fontSize: s.size,
    letterSpacing: s.spacing,
    decoration: getProp(s.span.props, "textDecoration"),
    fills: s.span.own.fills ?? null,
    run: s.run,
  });

  /**
   * The last line shown of truncated text: as much of it as fits with "…"
   * after it (in the style of the last character kept), within `maxWidth`.
   */
  const ellipsize = (br: Break, top: number): TextLine => {
    const room = maxWidth === null ? Number.POSITIVE_INFINITY : maxWidth - (br.indent ?? 0);
    const dots = (at: number) => {
      const s = styles[m.styleAt(Math.max(br.start, at - 1))] as SpanStyle;
      return { s, width: measurer.width(s.font, "…", s.run) + s.spacing };
    };
    // As much of the rest of the paragraph as fits before the dots, as Figma truncates: not just
    // what the line break left on this line (a word broken after a hyphen would end it early).
    const nl = text.indexOf("\n", br.start);
    const paraEnd = nl === -1 ? text.length : nl;
    const fits = (at: number) => m.width(br.start, at) + dots(at).width <= room;
    let lo = br.start;
    let hi = Math.max(br.end, paraEnd);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    let cut = lo;
    if (cut > br.start && isLow(text.charCodeAt(cut))) cut--;
    // No dangling space before the dots.
    while (cut > br.start && /\s/.test(text[cut - 1] as string)) cut--;
    const line = makeLine({ ...br, end: cut }, top);
    const { s, width } = dots(cut);
    const fragment = fragmentOf(s, cut, cut, "…", line.width, width);
    return {
      ...line,
      text: `${line.text}…`,
      width: line.width + width,
      baseline: line.fragments.length > 0 ? line.baseline : top + s.ascent,
      height: Math.max(line.height, s.ascent + s.descent),
      fragments: [...line.fragments, fragment],
    };
  };

  /** A list item's marker, in the style of its paragraph's first character. */
  const markerOf = (text: string, at: number): TextMarker => {
    const s = styles[m.styleAt(at)] as SpanStyle;
    const width = measurer.width(s.font, text, s.run);
    // A bullet centred in the last level's indent; a number ending a little before the text.
    const x =
      text === "•"
        ? -(LIST_INDENT_EM / 2) * s.size - width / 2
        : -LIST_NUMBER_GAP_EM * s.size - width;
    return {
      text,
      x,
      width,
      font: s.font,
      fontSize: s.size,
      fills: s.span.own.fills ?? null,
      run: s.run,
    };
  };

  /** A line's fragments and box for the characters [start, end), its top at `top`. */
  const makeLine = (br: Break, top: number): TextLine => {
    // The styles on this line (an empty line takes the style at its start).
    const first = m.styleAt(br.start);
    const last = br.end > br.start ? m.styleAt(br.end - 1) : first;
    let ascent = 0;
    let descent = 0;
    let step = 0;
    let cap = 0;
    const fragments: TextFragment[] = [];
    let x = 0;
    for (let k = first; k <= last; k++) {
      const s = styles[k] as SpanStyle;
      ascent = Math.max(ascent, s.ascent);
      descent = Math.max(descent, s.descent);
      step = Math.max(step, s.lineHeight);
      cap = Math.max(cap, s.cap);
      const a = Math.max(br.start, s.span.start);
      const b = Math.min(br.end, s.span.end);
      if (b <= a) continue;
      const width = m.width(a, b);
      fragments.push(fragmentOf(s, a, b, caseSlice(text, a, b, s.span.props), x, width));
      x += width;
    }
    return {
      text: fragments.map((f) => f.text).join(""),
      width: x,
      baseline: top + ascent,
      top,
      height: ascent + descent,
      start: br.start,
      end: br.end,
      next: Math.min(br.next, text.length + 1),
      fragments,
      indent: br.indent ?? 0,
      marker: br.marker ? markerOf(br.marker, br.start) : null,
      step,
      cap,
    };
  };

  const spacing = getProp(props, "paragraphSpacing");
  const listSpacing = getProp(props, "listSpacing");
  const maxLines = whole ? null : getProp(props, "maxLines");
  const kept = maxLines !== null && breaks.length > maxLines ? breaks.slice(0, maxLines) : breaks;
  // Lines stack baseline to baseline, each its own line height below the last (as in Figma:
  // a taller line pushes itself down, not the line after it); the first sits centred in its own.
  const lines: TextLine[] = [];
  let after = 0;
  for (const [i, br] of kept.entries()) {
    let built = makeLine(br, 0);
    // The last line shown ends in "…" when lines are cut off after it, or when it's too wide
    // for the box itself (a word longer than the line).
    const last = i === kept.length - 1;
    const overflows = maxWidth !== null && built.indent + built.width > maxWidth + 0.01;
    if (last && maxLines !== null && (kept !== breaks || overflows)) built = ellipsize(br, 0);
    const prev = lines[lines.length - 1];
    const baseline = prev ? prev.baseline + after + built.step : built.baseline;
    lines.push({ ...built, top: baseline - built.baseline, baseline });
    // Space after a paragraph, not after the last line shown: between two items of a list,
    // the list's spacing; anywhere else, the paragraph spacing (as in Figma).
    const next = kept[i + 1];
    after = br.para && next ? (br.list && next.list ? listSpacing : spacing) : 0;
  }
  const trimmed = trim(lines, getProp(props, "leadingTrim"));
  const last = trimmed.lines[trimmed.lines.length - 1];
  const width = lines.reduce((w, l) => Math.max(w, l.indent + l.width), 0);
  return {
    font: fontString(props, measurer),
    lines: trimmed.lines,
    lineHeight: lineHeightPx(props, measurer),
    width,
    height: trimmed.height ?? (last ? last.top + last.height : 0),
    letterSpacing: letterSpacingPx(props),
  };
}

/**
 * Vertical trim, as Figma's "cap height to baseline": the box starts at the
 * first line's cap height and ends at the last line's baseline, so what's
 * above the capitals and below the baseline (descenders, half the leading)
 * hangs outside it. The lines keep their spacing; they move up by the trim.
 */
function trim(
  lines: TextLine[],
  mode: "none" | "cap-height",
): { lines: TextLine[]; height: number | null } {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (mode !== "cap-height" || !first || !last) return { lines, height: null };
  const by = first.baseline - first.cap;
  return {
    lines:
      by === 0 ? lines : lines.map((l) => ({ ...l, top: l.top - by, baseline: l.baseline - by })),
    height: last.baseline - by,
  };
}

const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Where a line's text starts in a box `width` wide: past its list indent, then aligned. */
export function lineOffset(line: TextLine, width: number, props: Props): number {
  const align = getProp(props, "textAlign");
  const room = width - line.indent;
  return (
    line.indent +
    (align === "center" ? (room - line.width) / 2 : align === "right" ? room - line.width : 0)
  );
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
export function layoutTextNode(
  node: NodeRecord,
  measurer: TextMeasurer,
  options: LayoutOptions = {},
): TextLayout {
  const mode = getProp(node.props, "textAutoResize");
  return layoutText(
    node,
    measurer,
    mode === "width" ? null : getProp(node.props, "width"),
    options,
  );
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

/**
 * Where a line's glyphs (and their underline or strikethrough) are drawn:
 * its baseline, after the block's vertical offset `dy`, rounded to a whole
 * unit from the top of the text box. Figma lays text out unrounded (the
 * baselines it saves for Inter 16/24 sit at 17.82) but draws each line's
 * glyphs on a whole unit (at 18, at any zoom or export scale), so text is
 * placed up to half a unit from where its layout says. The layout itself
 * (line boxes, carets, selections, sizes) stays unrounded, as Figma's does.
 */
export function drawnBaseline(line: TextLine, dy: number): number {
  return Math.round(line.baseline + dy);
}

/**
 * An underline's or strikethrough's bar, for a run at `fontSize` drawn on
 * `baseline` (`drawnBaseline`): its top and height, in the text box's units.
 * As Figma draws them, measured on its renders:
 *
 * - An underline's top is a fifth of the size below the drawn baseline, and
 *   it's a fifteenth of the size thick, at every size from 12 to 20 px and
 *   at every fraction the baseline rounds by. That isn't the font's own
 *   underline (Inter's post table puts its top at 0.170 em and makes it
 *   0.068 em thick), so it's taken as Figma's own rule, for every font.
 * - A strikethrough is where Inter's OS/2 table puts it: its top 671/2048 em
 *   above the baseline, 140/2048 em thick. Nothing struck in another font
 *   has been measured; every font draws it there, so the canvas (which
 *   can't read a font's tables) and the headless renderer agree.
 *
 * Neither is snapped to a pixel: Figma's bars are antialiased across rows.
 */
export function decorationBar(
  decoration: "underline" | "strikethrough",
  baseline: number,
  fontSize: number,
): { readonly y: number; readonly height: number } {
  return decoration === "underline"
    ? { y: baseline + fontSize / 5, height: fontSize / 15 }
    : { y: baseline - (fontSize * 671) / 2048, height: (fontSize * 140) / 2048 };
}

/** The line a caret at `index` is on: the last one starting at or before it. */
export function lineOf(layout: TextLayout, index: number): number {
  let k = 0;
  for (let i = 0; i < layout.lines.length; i++)
    if ((layout.lines[i] as TextLine).start <= index) k = i;
  return k;
}

function measureFor(node: NodeRecord, measurer: TextMeasurer): RangeMeasure {
  return new RangeMeasure(getProp(node.props, "characters"), spanStyles(node, measurer), measurer);
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
  readonly #metrics = new Map<string, FontMetrics | null>();
  #generation = 0;

  constructor() {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1)
        : document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas is not available");
    this.#ctx = ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    // Always kerned, as Figma sets type, and as the renderer draws it ("auto" lets the browser skip it).
    this.#ctx.fontKerning = "normal";
    // At the font's own advances, as the renderer draws them (see `typeset` there).
    if ("textRendering" in this.#ctx)
      (this.#ctx as { textRendering: string }).textRendering = "geometricPrecision";
  }

  width(font: string, text: string, _run?: ShapingRun | null): number {
    const key = `${font}\u0000${text}`;
    let w = this.#cache.get(key);
    if (w === undefined) {
      // Where glyphs aren't positioned to fractions of a pixel (Linux, say), the browser
      // rounds each advance at the size it measures, which adds up along a line: measured
      // at 1000 px and scaled, the advances are the font's own, as Figma lays type out.
      const size = /(\d+(?:\.\d+)?)px/.exec(font);
      const px = size ? Number(size[1]) : 0;
      if (size && px > 0 && px < 1000) {
        this.#ctx.font = font.replace(size[0], "1000px");
        w = (this.#ctx.measureText(text).width * px) / 1000;
      } else {
        this.#ctx.font = font;
        w = this.#ctx.measureText(text).width;
      }
      if (this.#cache.size > 20_000) this.#cache.clear();
      this.#cache.set(key, w);
    }
    return w;
  }

  metrics(font: string): FontMetrics | null {
    // Browsers round a font's ascent and descent to whole pixels, so they're
    // read at 1000 px and scaled to the size asked for, exact to 0.1%.
    const size = /(\d+(?:\.\d+)?)px/.exec(font);
    if (!size) return null;
    const px = Number(size[1]);
    const key = font.replace(size[0], "1000px");
    let em = this.#metrics.get(key);
    if (em === undefined) {
      this.#ctx.font = key;
      const t = this.#ctx.measureText("");
      // The font's ascent and descent (as the browser reads them from its tables), not the glyphs'.
      // Its cap height, as the top of a flat capital: "H" rises to it in every Latin face.
      const h = this.#ctx.measureText("H").actualBoundingBoxAscent;
      em =
        typeof t.fontBoundingBoxAscent === "number" && t.fontBoundingBoxAscent > 0
          ? {
              ascent: t.fontBoundingBoxAscent / 1000,
              descent: t.fontBoundingBoxDescent / 1000,
              ...(h > 0 ? { capHeight: capHeightEm(h / 1000) } : {}),
            }
          : null;
      this.#metrics.set(key, em);
    }
    return em
      ? {
          ascent: em.ascent * px,
          descent: em.descent * px,
          ...(em.capHeight !== undefined ? { capHeight: em.capHeight * px } : {}),
        }
      : null;
  }

  get generation(): number {
    return this.#generation;
  }

  /** Call after web fonts load: earlier measurements used fallback fonts. */
  invalidate(): void {
    this.#cache.clear();
    this.#metrics.clear();
    this.#generation++;
  }
}
