/**
 * Text measured by HarfBuzz the way the browser's canvas measures it, for
 * the headless editor (docs/decisions/0021-agent-tools.md): a Worker has no
 * canvas, and a layout an agent makes there has to be the one a person sees
 * when they open the file.
 *
 * The canvas measurer (`CanvasTextMeasurer`) reads widths at the font's own
 * advances, kerned, and ascent and descent from the font's tables. Here:
 *
 * - Widths shape the text with HarfBuzz's default features (kerning and
 *   ligatures on, as the canvas with `fontKerning: "normal"`), in the file
 *   the browser draws that face from, at the weight CSS picks for it. Fonts
 *   are scaled to 1/64 of a font unit, so nothing is rounded to pixels, as
 *   the canvas measures at 1000 px. On a weight axis, advances are whole
 *   font units in both (HarfBuzz and Chromium round the axis's deltas).
 * - Characters the face lacks go to the next family in the font string, as
 *   the browser's font fallback does, ending at Instrument Sans (the
 *   editor's fallback family). Past that the browser uses a system font a
 *   Worker can't know: those characters are estimated (see `estimate`) and
 *   the family is reported.
 * - A file the browser loads as unicode-range subsets (Google's fonts, the
 *   app's own) is shaped a subset at a time, as the browser has it: no
 *   kerning between "Ł" (Latin Extended) and "ó" (Latin).
 * - Runs that set OpenType features or variable axes go through the same
 *   `Shaper` the browser uses for them, so they agree by construction.
 * - Ascent and descent are chosen as Chromium (Skia on FreeType) chooses
 *   them: OS/2 typo metrics when the font sets USE_TYPO_METRICS, else hhea,
 *   else typo, else win, with MVAR's deltas. Cap height is the top of "H".
 *   Both are rounded as the canvas measurer reads them (`verticalMetrics`,
 *   `capHeightEm`).
 *
 * Measuring is synchronous, as the editor's is: `load` the faces a document
 * needs first (`measuredFaces` lists them). A face with no file is measured
 * in the fallback family, or estimated, never thrown on; `approximations`
 * says which families were, so a caller can report it. Font bytes come
 * through a loader, so this file stays free of any platform.
 */
import type { NodeRecord } from "@drawpane/model";
import { getProp } from "@drawpane/model";
import { textSpans } from "./rich-text";
import { type FontBytesLoader, Shaper, type ShapingFace, shapingFace } from "./shaping";
import {
  capHeightEm,
  type FontMetrics,
  type ShapedText,
  type ShapingRun,
  shapingRun,
  type TextMeasurer,
} from "./text";

type HarfBuzz = typeof import("harfbuzzjs");
type HbFont = InstanceType<HarfBuzz["Font"]>;
type HbFace = InstanceType<HarfBuzz["Face"]>;

/** A face to measure in: as the canvas draws it, or as the shaper shapes it. */
export interface MeasuredFace extends ShapingFace {
  /**
   * The file the browser's canvas draws this face from, rather than the one
   * the shaper reads: for a variable family its variable file, at the weight
   * CSS picks among the family's weights; else its static file nearest the
   * face. Without it, the face is the shaper's (see `ShapingFace`).
   */
  readonly canvas?: boolean;
}

/** A face's font file (TrueType or OpenType), and the weight it's drawn at. */
export interface FontFile {
  readonly bytes: ArrayBuffer;
  /**
   * For a file with a weight axis, where on it the face is drawn: the weight
   * CSS matched (a family offering 400 and 700 draws 450 at 400). The face's
   * own weight when unset.
   */
  readonly weight?: number;
  /**
   * The unicode-range subsets the browser loads the file as, in its
   * stylesheet's order, each a list of [first, last] code points. Google's
   * stylesheets (and the app's own fonts) split a family into Latin, Latin
   * Extended, Cyrillic and so on, each its own file: characters in
   * different subsets aren't kerned or joined across, and a character in
   * none comes from the next family. Where subsets overlap the last listed
   * wins, as in CSS. Unset for a file loaded whole.
   */
  readonly subsets?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
}

/** The file for a face, or null when there's none to have (a system or local font). */
export type FaceFileLoader = (face: MeasuredFace) => Promise<ArrayBuffer | FontFile | null>;

/** Something measured without its own font: which family, and why. */
export interface Approximation {
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
  /**
   * `face`: the family's file couldn't be had, so it was measured in the
   * fallback family (or estimated). `glyphs`: some characters are in none
   * of the files at hand (CJK, say, which the browser takes from a system
   * font), so their widths are estimated.
   */
  readonly reason: "face" | "glyphs";
}

/** A canvas font string's parts: `italic 600 16px "Inter", "Inter Variable", system-ui`. */
export interface ParsedFont {
  readonly italic: boolean;
  readonly weight: number;
  readonly size: number;
  /** Its families in order, without generic ones, quotes or the self-hosted "Variable" alias. */
  readonly families: readonly string[];
}

const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

const FONT = /^\s*((?:[a-z0-9-]+\s+)*?)(\d+(?:\.\d+)?)px(?:\s*\/\s*\S+)?\s+(.+)$/i;

/** Reads a canvas font string, or null when it isn't one (no size in px). */
export function parseFont(font: string): ParsedFont | null {
  const m = FONT.exec(font);
  if (!m) return null;
  let italic = false;
  let weight = 400;
  for (const token of (m[1] ?? "").trim().split(/\s+/)) {
    if (token === "italic" || token === "oblique") italic = true;
    else if (token === "bold") weight = 700;
    else if (/^\d+$/.test(token)) weight = Number(token);
  }
  const families: string[] = [];
  for (const [, dq, sq, bare] of (m[3] ?? "").matchAll(
    /\s*(?:"([^"]*)"|'([^']*)'|([^,]+))\s*,?/g,
  )) {
    const raw = (dq ?? sq ?? bare ?? "").trim();
    if (!raw || GENERIC.has(raw.toLowerCase())) continue;
    // Self-hosted variable fonts register as "<Family> Variable".
    const name = raw.replace(/ Variable$/, "");
    if (!families.includes(name)) families.push(name);
  }
  return { italic, weight, size: Number(m[2]), families };
}

/**
 * The faces a document's text is measured in: each text layer's family,
 * weight and style (its runs' too), as the canvas draws them, and the
 * shaper's faces for runs that set OpenType features or variable axes.
 */
export function measuredFaces(nodes: Iterable<NodeRecord>): MeasuredFace[] {
  const out = new Map<string, MeasuredFace>();
  const add = (face: MeasuredFace) => out.set(measuredKey(face), face);
  for (const node of nodes) {
    if (node.type !== "text") continue;
    for (const span of textSpans(node)) {
      add({
        family: getProp(span.props, "fontFamily"),
        weight: getProp(span.props, "fontWeight"),
        italic: getProp(span.props, "fontStyle") === "italic",
        canvas: true,
      });
      const run = shapingRun(span.props);
      if (run) add(shapingFace(run));
    }
  }
  return [...out.values()];
}

const measuredKey = (f: MeasuredFace) =>
  `${f.canvas ? "canvas" : f.variable ? "variable" : "static"}\u0000${f.family}\u0000${f.weight}\u0000${f.italic}`;

/** Fonts are scaled to this many positions per font unit, so advances keep their fractions. */
const PRECISION = 64;

/** A face ready to measure in: its font at its weight, and what it covers. */
interface CanvasFace {
  readonly hb: HarfBuzz;
  readonly font: HbFont;
  /** Positions per em: the font's units per em times PRECISION. */
  readonly em: number;
  readonly unicodes: ReadonlySet<number>;
  /** The subset a character is drawn from (see `FontFile.subsets`): 0 for a whole file, -1 for none. */
  readonly subset: (cp: number) => number;
  /** Ascent, descent and cap height, in em. */
  readonly metrics: {
    readonly ascent: number;
    readonly descent: number;
    readonly cap: number | null;
  };
}

type CanvasEntry =
  | { readonly status: "loading"; readonly done: Promise<void> }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly face: CanvasFace };

export interface HarfBuzzMeasurerOptions {
  /** HarfBuzz itself; by default the `harfbuzzjs` package, imported on first use. */
  readonly harfBuzz?: () => Promise<HarfBuzz>;
  /** The family the editor falls back to (`fontString`'s fallbacks): Instrument Sans. */
  readonly fallbackFamily?: string;
  /** An outline from SVG path data, for shaped runs; by default none (a Worker has no Path2D). */
  readonly makePath?: (d: string) => Path2D | null;
}

const approximationKey = (a: Approximation) =>
  `${a.reason}\u0000${a.family}\u0000${a.weight}\u0000${a.italic}`;

/** A width or metrics, and what was approximated taking them. */
interface Cached<T> {
  readonly value: T;
  readonly approximations: readonly Approximation[];
}

/** Widths (and metrics) kept, at most, before the cache starts over. */
const MAX_WIDTHS = 20_000;

export class HarfBuzzMeasurer implements TextMeasurer {
  /** Runs with OpenType features or variable axes, shaped as the browser shapes them. */
  readonly shaper: Shaper;
  readonly fallbackFamily: string;
  readonly #loadFile: FaceFileLoader;
  readonly #loadHarfBuzz: () => Promise<HarfBuzz>;
  #harfBuzz: Promise<HarfBuzz> | null = null;
  readonly #faces = new Map<string, CanvasEntry>();
  /** Widths and metrics taken, with what was approximated taking them (noted again on each use). */
  readonly #widths = new Map<string, Cached<number>>();
  readonly #metrics = new Map<string, Cached<FontMetrics | null>>();
  readonly #approximations = new Map<string, Approximation>();
  /** Where approximations go as a width or metrics are taken. */
  #noting: Approximation[] | null = null;
  #generation = 0;
  /** The generation the caches were filled at. */
  #filledAt = 0;

  constructor(loadFile: FaceFileLoader, options: HarfBuzzMeasurerOptions = {}) {
    this.#loadFile = loadFile;
    this.#loadHarfBuzz = options.harfBuzz ?? (() => import("harfbuzzjs"));
    this.fallbackFamily = options.fallbackFamily ?? "Instrument Sans";
    const bytesOnly: FontBytesLoader = async (face) => {
      const file = await loadFile(face);
      return file === null || file instanceof ArrayBuffer ? file : file.bytes;
    };
    this.shaper = new Shaper(bytesOnly, {
      harfBuzz: () => this.#hb(),
      makePath: options.makePath ?? (() => null),
    });
  }

  /** Bumped each time a face becomes ready (or turns out not to be): earlier layouts are stale. */
  get generation(): number {
    return this.#generation + this.shaper.generation;
  }

  /** What was measured without its own font since the last `clearApproximations`. */
  get approximations(): readonly Approximation[] {
    return [...this.#approximations.values()];
  }

  clearApproximations(): void {
    this.#approximations.clear();
  }

  /** Whether a face is ready to measure in, still loading, or has no file. */
  status(face: MeasuredFace): "loading" | "ready" | "unavailable" {
    if (!face.canvas) return this.shaper.status(face);
    return this.#faces.get(measuredKey(face))?.status ?? "loading";
  }

  /**
   * Loads faces (and the fallback family at their weights and styles), and
   * answers those that have no file: their text is measured approximately.
   */
  async load(
    faces: Iterable<MeasuredFace>,
  ): Promise<{ readonly missing: readonly MeasuredFace[] }> {
    const list = [...faces];
    const all = new Map<string, MeasuredFace>();
    for (const face of list) {
      all.set(measuredKey(face), face);
      if (face.canvas) {
        const fallback = { ...face, family: this.fallbackFamily };
        all.set(measuredKey(fallback), fallback);
      }
    }
    await Promise.all(
      [...all.values()].map((face) =>
        face.canvas ? this.#load(face) : this.shaper.load(face).then(() => undefined),
      ),
    );
    return { missing: list.filter((face) => this.status(face) !== "ready") };
  }

  width(font: string, text: string, run?: ShapingRun | null): number {
    // As ShapingMeasurer: shaped when the run's face is at hand, else as the canvas has it.
    if (run) {
      const shaped = this.shaper.shape(text, run);
      if (shaped) return shaped.width;
      if (this.shaper.status(shapingFace(run)) === "loading") this.#approximate(run, "face");
    }
    this.#fresh();
    return this.#cached(this.#widths, `${font}\u0000${text}`, () => {
      const parsed = parseFont(font);
      return parsed ? this.#measure(parsed, text) : 0;
    });
  }

  shape(text: string, run: ShapingRun): ShapedText | null {
    return this.shaper.shape(text, run);
  }

  metrics(font: string): FontMetrics | null {
    this.#fresh();
    return this.#cached(this.#metrics, font, () => {
      const parsed = parseFont(font);
      const face = parsed ? this.#faceFor(parsed) : null;
      return parsed && face
        ? {
            ascent: face.metrics.ascent * parsed.size,
            descent: face.metrics.descent * parsed.size,
            ...(face.metrics.cap !== null ? { capHeight: face.metrics.cap * parsed.size } : {}),
          }
        : null;
    });
  }

  /** A value from `cache`, or taken and kept; either way its approximations are noted. */
  #cached<T>(cache: Map<string, Cached<T>>, key: string, take: () => T): T {
    let hit = cache.get(key);
    if (!hit) {
      this.#noting = [];
      try {
        hit = { value: take(), approximations: this.#noting };
      } finally {
        this.#noting = null;
      }
      if (cache.size >= MAX_WIDTHS) cache.clear();
      cache.set(key, hit);
    }
    for (const a of hit.approximations) this.#approximate(a, a.reason);
    return hit.value;
  }

  /** Drops cached widths and metrics when a face has loaded since they were taken. */
  #fresh(): void {
    if (this.#filledAt === this.#generation) return;
    this.#filledAt = this.#generation;
    this.#widths.clear();
    this.#metrics.clear();
  }

  /** The first of the font's families that's ready, noting when that isn't its own. */
  #faceFor(parsed: ParsedFont): CanvasFace | null {
    const chain = this.#chain(parsed);
    const first = chain.find((face) => face !== null) ?? null;
    if (first !== chain[0])
      this.#approximate({ ...parsed, family: parsed.families[0] ?? "" }, "face");
    return first;
  }

  /** The font's families as faces, then the fallback family; null where one isn't ready. */
  #chain(parsed: ParsedFont): Array<CanvasFace | null> {
    const families = parsed.families.includes(this.fallbackFamily)
      ? parsed.families
      : [...parsed.families, this.fallbackFamily];
    return families.map((family) => {
      const face = { family, weight: parsed.weight, italic: parsed.italic, canvas: true };
      const entry = this.#entry(face);
      return entry.status === "ready" ? entry.face : null;
    });
  }

  #measure(parsed: ParsedFont, text: string): number {
    const chain = this.#chain(parsed);
    if (chain[0] === null)
      this.#approximate({ ...parsed, family: parsed.families[0] ?? "" }, "face");
    let total = 0;
    for (const piece of pieces(text, chain)) {
      const face = piece.face === -1 ? null : chain[piece.face];
      if (face) total += (advance(face, piece.text) / face.em) * parsed.size;
      else {
        total += estimate(piece.text) * parsed.size;
        this.#approximate({ ...parsed, family: parsed.families[0] ?? "" }, "glyphs");
      }
    }
    return total;
  }

  #approximate(
    face: { family: string; weight: number; italic: boolean },
    reason: Approximation["reason"],
  ): void {
    const approximation = { family: face.family, weight: face.weight, italic: face.italic, reason };
    const key = approximationKey(approximation);
    if (this.#noting && !this.#noting.some((a) => approximationKey(a) === key))
      this.#noting.push(approximation);
    if (!this.#approximations.has(key)) this.#approximations.set(key, approximation);
  }

  #hb(): Promise<HarfBuzz> {
    this.#harfBuzz ??= this.#loadHarfBuzz().catch((error: unknown) => {
      this.#harfBuzz = null;
      throw error;
    });
    return this.#harfBuzz;
  }

  /** A face's entry, starting to load it the first time it's asked for. */
  #entry(face: MeasuredFace): CanvasEntry {
    const key = measuredKey(face);
    let entry = this.#faces.get(key);
    if (!entry) {
      const done = this.#open(face).then(
        (ready) =>
          this.#settle(key, ready ? { status: "ready", face: ready } : { status: "unavailable" }),
        () => this.#settle(key, { status: "unavailable" }),
      );
      entry = { status: "loading", done };
      this.#faces.set(key, entry);
    }
    return entry;
  }

  async #load(face: MeasuredFace): Promise<void> {
    const entry = this.#entry(face);
    if (entry.status === "loading") await entry.done;
  }

  #settle(key: string, entry: CanvasEntry): void {
    this.#faces.set(key, entry);
    this.#generation++;
  }

  async #open(face: MeasuredFace): Promise<CanvasFace | null> {
    const [hb, file] = await Promise.all([this.#hb(), this.#loadFile(face)]);
    if (!file) return null;
    const { bytes, weight, subsets } = file instanceof ArrayBuffer ? { bytes: file } : file;
    const hbFace = new hb.Face(new hb.Blob(bytes));
    const upem = hbFace.upem || 1000;
    const font = new hb.Font(hbFace);
    // Only the weight is set: Google serves browsers its variable files with other axes at their defaults.
    const wght = hbFace.getAxisInfos().wght;
    if (wght)
      font.setVariations([
        new hb.Variation("wght", Math.min(wght.max, Math.max(wght.min, weight ?? face.weight))),
      ]);
    font.setScale(upem * PRECISION, upem * PRECISION);
    return {
      hb,
      font,
      em: upem * PRECISION,
      unicodes: new Set(hbFace.collectUnicodes()),
      subset: subsets ? subsetOf(subsets) : () => 0,
      metrics: verticalMetrics(hb, hbFace, font, upem),
    };
  }
}

/** The advance of `text` in one face, in its positions (`em` per em). */
function advance(face: CanvasFace, text: string): number {
  const { hb, font } = face;
  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.guessSegmentProperties();
  hb.shape(font, buffer);
  let pen = 0;
  for (const p of buffer.getGlyphPositions()) pen += p.xAdvance;
  return pen;
}

/** Strong right-to-left characters (as shaping.ts has them). */
const RIGHT_TO_LEFT =
  /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]|[\u{10800}-\u{10fff}]|[\u{1e800}-\u{1efff}]/u;
/** Characters that belong with the one before: marks, joiners and variation selectors. */
const ATTACHED = /\p{M}|\u200c|\u200d|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]/u;
const LETTER = /\p{L}/u;

/** Which of a file's subsets draws each character: the last listing it, as CSS has it, or -1. */
function subsetOf(
  subsets: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
): (cp: number) => number {
  const seen = new Map<number, number>();
  return (cp) => {
    let hit = seen.get(cp);
    if (hit === undefined) {
      hit = -1;
      for (let i = subsets.length - 1; i >= 0 && hit === -1; i--)
        if ((subsets[i] ?? []).some(([a, b]) => cp >= a && cp <= b)) hit = i;
      seen.set(cp, hit);
    }
    return hit;
  };
}

/**
 * `text` split where the file drawing it changes (the first face in `chain`
 * that has each character, -1 for none, and its subset there) or its
 * direction does, as the browser splits text into runs before shaping each.
 */
function pieces(
  text: string,
  chain: ReadonlyArray<CanvasFace | null>,
): Array<{ text: string; face: number }> {
  const out: Array<{ text: string; face: number; subset: number; rtl: boolean | null }> = [];
  for (const char of text) {
    const last = out[out.length - 1];
    if (last && ATTACHED.test(char)) {
      last.text += char;
      continue;
    }
    const cp = char.codePointAt(0) as number;
    let subset = -1;
    const face = chain.findIndex((f) => {
      if (!f?.unicodes.has(cp)) return false;
      subset = f.subset(cp);
      return subset !== -1;
    });
    const rtl = RIGHT_TO_LEFT.test(char) ? true : LETTER.test(char) ? false : null;
    if (
      last &&
      last.face === face &&
      last.subset === subset &&
      (rtl === null || last.rtl === null || last.rtl === rtl)
    ) {
      last.text += char;
      last.rtl ??= rtl;
    } else out.push({ text: char, face, subset, rtl });
  }
  return out;
}

/** Wide characters: CJK, Hangul, kana, fullwidth forms and emoji, a full em in any font. */
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f000}-\u{1faff}]|[\u{20000}-\u{3fffd}]|\p{Extended_Pictographic}/u;

/**
 * An estimate, in em, for characters none of the files has: wide ones a
 * full em, Arabic and Hebrew letters 0.4 (joined, they run narrow), the
 * rest 0.55.
 */
function estimate(text: string): number {
  let em = 0;
  for (const char of text) {
    if (ATTACHED.test(char)) continue;
    em += WIDE.test(char) ? 1 : RIGHT_TO_LEFT.test(char) ? 0.4 : 0.55;
  }
  return em;
}

/**
 * A face's ascent, descent and cap height in em, as Chromium reads them
 * (Skia's FreeType backend): OS/2 typo metrics when the font sets
 * USE_TYPO_METRICS; else hhea's, unless both are zero, then typo's, then
 * win's (FreeType's order); plus MVAR's deltas at the face's weight.
 */
function verticalMetrics(
  hb: HarfBuzz,
  face: HbFace,
  font: HbFont,
  upem: number,
): CanvasFace["metrics"] {
  const os2 = view(face.referenceTable("OS/2"));
  const hhea = view(face.referenceTable("hhea"));
  const i16 = (v: DataView | null, at: number) =>
    v && v.byteLength >= at + 2 ? v.getInt16(at) : 0;
  const u16 = (v: DataView | null, at: number) =>
    v && v.byteLength >= at + 2 ? v.getUint16(at) : 0;
  const hasOs2 = os2 !== null && u16(os2, 0) !== 0xffff;
  const typo = { ascent: i16(os2, 68), descent: -i16(os2, 70) };
  const useTypo = hasOs2 && (u16(os2, 62) & (1 << 7)) !== 0;
  let ascent: number;
  let descent: number;
  let tags = [hb.MetricsTag.HORIZONTAL_ASCENDER, hb.MetricsTag.HORIZONTAL_DESCENDER] as const;
  if (useTypo) ({ ascent, descent } = typo);
  else if (i16(hhea, 4) || i16(hhea, 6)) {
    ascent = i16(hhea, 4);
    descent = -i16(hhea, 6);
  } else if (hasOs2 && (typo.ascent || typo.descent)) ({ ascent, descent } = typo);
  else {
    ascent = u16(os2, 74);
    descent = u16(os2, 76);
    tags = [hb.MetricsTag.HORIZONTAL_CLIPPING_ASCENT, hb.MetricsTag.HORIZONTAL_CLIPPING_DESCENT];
  }
  ascent += font.getMetricVariation(tags[0]);
  // A descender is negative, a win descent positive; either way the delta moves the line down.
  descent +=
    (tags[1] === hb.MetricsTag.HORIZONTAL_DESCENDER ? -1 : 1) * font.getMetricVariation(tags[1]);
  const h = font.nominalGlyph("H".codePointAt(0) as number);
  const extents = h ? font.glyphExtents(h) : undefined;
  const top = extents ? extents.yBearing / (upem * PRECISION) : 0;
  return {
    // The canvas measurer reads these at 1000 px, where Blink rounds them to whole pixels.
    // (On Linux it then moves a pixel from ascent to descent when descent rounded down;
    // other platforms don't, so neither does this. Their sum, the line height, is the same.)
    ascent: Math.round((ascent / upem) * 1000) / 1000,
    descent: Math.round((descent / upem) * 1000) / 1000,
    // Skia measures glyph bounds for text over 256 px at 64 px, in whole pixels rounded
    // out, so the canvas reads the top of "H" at 1000 px in 64ths of an em (`capHeightEm`).
    cap: top > 0 ? capHeightEm(Math.ceil(top * CANONICAL - 1e-9) / CANONICAL) : null,
  };
}

/** The size Skia measures large text at (its canonical size for paths), in px. */
const CANONICAL = 64;

function view(bytes: Uint8Array | undefined): DataView | null {
  return bytes && bytes.byteLength > 0
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : null;
}
