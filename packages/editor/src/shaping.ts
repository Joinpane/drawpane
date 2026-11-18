/**
 * OpenType features and variable axes, shaped by HarfBuzz
 * (docs/decisions/0005-opentype-features.md, 0009-variable-fonts.md).
 *
 * The 2D canvas can't apply OpenType features or set a variable font's axes
 * (beyond weight), so text that sets any is shaped here: HarfBuzz
 * (WebAssembly, loaded the first time a file needs it) turns the text, its
 * font's bytes, the features and the axes into glyphs and positions, and the
 * renderer fills the glyphs' outlines. Text that sets neither never comes here.
 *
 * Text that sets axes is shaped from the family's variable file (a face
 * with `variable`), at one HarfBuzz font per point on the axes, sharing the
 * face.
 *
 * Shaping is synchronous once a face is ready, as drawing needs. Until then
 * `shape` answers null (the text draws without its features) and starts
 * loading; when the face is ready, listeners hear its family so the text is
 * measured and drawn again. A face whose bytes can't be had (a system or
 * local font) stays unavailable: the inspector says why.
 */
import type { FontFeatures } from "@drawpane/model";
import { type Face, type FontBytesLoader, faceKey } from "@drawpane/raster";
import { sharedFace } from "./harfbuzz-faces";
import type {
  FontMetrics,
  FontResolver,
  ShapedGlyph,
  ShapedText,
  ShapingRun,
  TextMeasurer,
} from "./text";

type HarfBuzz = typeof import("harfbuzzjs");
type HbFont = InstanceType<HarfBuzz["Font"]>;
type HbFace = InstanceType<HarfBuzz["Face"]>;

/**
 * A face text is set in, and the loader for its file: shared with the
 * headless renderer and anything else that reads font files (see
 * `@drawpane/raster`'s fonts.ts).
 */
export type ShapingFace = Face;
export type { FontBytesLoader };

/** One of a variable font's axes, as the font describes it. */
export interface FontAxis {
  readonly tag: string;
  /** The font's own name for it ("Grade"), or null when it has none. */
  readonly name: string | null;
  readonly min: number;
  readonly default: number;
  readonly max: number;
}

/** A feature a font offers, with its own name for it when it has one (stylistic sets usually do). */
export interface OfferedFeature {
  readonly tag: string;
  readonly name: string | null;
}

export type FaceStatus = "loading" | "ready" | "unavailable";

/** The face at one point on its axes. */
interface Instance {
  readonly font: HbFont;
  /** Outlines by glyph id, as path data and as a Path2D: they change along the axes. */
  readonly paths: Map<number, { readonly d: string; readonly path: Path2D | null }>;
}

interface ReadyFace {
  readonly hb: HarfBuzz;
  readonly face: HbFace;
  readonly upem: number;
  /** Its axes by tag (none for a static font). */
  readonly axes: Readonly<Record<string, { min: number; default: number; max: number }>>;
  /** The instances shaped from, by their point on the axes; the least recently used go first. */
  readonly instances: Map<string, Instance>;
}

type FaceEntry =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | ({ readonly status: "ready" } & ReadyFace);

/** Strong right-to-left characters: Hebrew, Arabic, Syriac, Thaana, NKo and their presentation forms. */
const RIGHT_TO_LEFT =
  /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]|[\u{10800}-\u{10fff}]|[\u{1e800}-\u{1efff}]/u;

/** The face a run is shaped from: the variable file when it sets axes. */
export function shapingFace(run: ShapingRun): ShapingFace {
  const variable = Object.keys(run.variations).length > 0;
  return variable
    ? { family: run.family, weight: run.weight, italic: run.italic, variable }
    : { family: run.family, weight: run.weight, italic: run.italic };
}

/** Points on the axes kept per face, at most: a file uses a few (optical size adds one per font size). */
const MAX_INSTANCES = 24;

/**
 * Where on a font's axes a run draws: its axes clamped to what the font
 * covers, its weight on the weight axis, and optical size following the
 * font size unless the run sets it (as CSS's `font-optical-sizing: auto`).
 * Axes the font lacks are left out.
 */
export function axisSettings(
  axes: Readonly<Record<string, { min: number; max: number }>>,
  run: Pick<ShapingRun, "weight" | "size" | "variations">,
): Record<string, number> {
  const out: Record<string, number> = {};
  const clamp = (tag: string, v: number) => {
    const axis = axes[tag];
    if (axis) out[tag] = Math.min(axis.max, Math.max(axis.min, v));
  };
  clamp("wght", run.weight);
  clamp("opsz", run.size);
  for (const [tag, value] of Object.entries(run.variations)) clamp(tag, value);
  return out;
}

/** Shaped runs kept, at most: a file's labels repeat, so most frames are all hits. */
const MAX_RUNS = 5000;

export interface ShaperOptions {
  /** HarfBuzz itself; by default the `harfbuzzjs` package, imported on first use. */
  readonly harfBuzz?: () => Promise<HarfBuzz>;
  /** An outline from SVG path data; by default `new Path2D(d)`. */
  readonly makePath?: (d: string) => Path2D | null;
}

export class Shaper {
  readonly #loadBytes: FontBytesLoader;
  readonly #loadHarfBuzz: () => Promise<HarfBuzz>;
  readonly #makePath: (d: string) => Path2D | null;
  #harfBuzz: Promise<HarfBuzz> | null = null;
  readonly #faces = new Map<string, FaceEntry>();
  /** Shaped runs, and null for runs that can't be shaped faithfully (see #shape). */
  readonly #runs = new Map<string, ShapedText | null>();
  readonly #listeners = new Set<(family: string) => void>();
  #generation = 0;

  constructor(loadBytes: FontBytesLoader, options: ShaperOptions = {}) {
    this.#loadBytes = loadBytes;
    this.#loadHarfBuzz = options.harfBuzz ?? (() => import("harfbuzzjs"));
    this.#makePath =
      options.makePath ?? ((d) => (typeof Path2D === "undefined" ? null : new Path2D(d)));
  }

  /** Bumped each time a face becomes ready (or turns out not to be): earlier layouts are stale. */
  get generation(): number {
    return this.#generation;
  }

  /** Hears the family of each face that became ready or unavailable. */
  subscribe(listener: (family: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  status(face: ShapingFace): FaceStatus {
    return this.#faces.get(faceKey(face))?.status ?? "loading";
  }

  /**
   * Tries an unavailable face again (its file failed to load, say): the next
   * shape or load starts over.
   */
  retry(face: ShapingFace): void {
    if (this.#faces.get(faceKey(face))?.status === "unavailable") this.#faces.delete(faceKey(face));
  }

  /** Waits for a face: ready, or unavailable. */
  async load(face: ShapingFace): Promise<FaceStatus> {
    const entry = this.#entry(face);
    if (entry.status !== "loading") return entry.status;
    await new Promise<void>((resolve) => {
      const off = this.subscribe(() => {
        if (this.status(face) !== "loading") {
          off();
          resolve();
        }
      });
    });
    return this.status(face);
  }

  /** `text` with the run's features and axes, or null while its face loads or when it can't be shaped. */
  shape(text: string, run: ShapingRun): ShapedText | null {
    const key = `${run.key}\u0000${text}`;
    const hit = this.#runs.get(key);
    if (hit !== undefined) return hit;
    const entry = this.#entry(shapingFace(run));
    if (entry.status !== "ready") return null;
    // HarfBuzz shapes one direction and script at a time, without bidi or font
    // fallback: right-to-left text, and characters the font lacks, keep the
    // canvas's drawing (without their features) rather than come out reversed
    // or as boxes.
    const shaped = RIGHT_TO_LEFT.test(text)
      ? null
      : this.#shape(entry, this.#instance(entry, run), text, run.size, run.features);
    if (this.#runs.size >= MAX_RUNS) this.#runs.clear();
    this.#runs.set(key, shaped);
    return shaped;
  }

  /** The features a face's font offers (substitutions and positioning), or null when it can't be read. */
  async offered(face: ShapingFace): Promise<OfferedFeature[] | null> {
    if ((await this.load(face)) !== "ready") return null;
    const entry = this.#faces.get(faceKey(face));
    if (entry?.status !== "ready") return null;
    const out = new Map<string, string | null>();
    for (const table of ["GSUB", "GPOS"] as const) {
      const tags = entry.face.getTableFeatureTags(table);
      for (const [index, tag] of tags.entries()) {
        if (out.get(tag)) continue;
        // Stylistic sets and character variants can carry their own names ("Single-storey a").
        const ids = entry.face.getFeatureNameIds(table, index);
        const name = ids?.uiLabelNameId
          ? entry.face.getName(ids.uiLabelNameId, "en") || null
          : null;
        out.set(tag, name ?? out.get(tag) ?? null);
      }
    }
    return [...out]
      .map(([tag, name]) => ({ tag, name }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }

  /**
   * A variable face's axes, as the font names them, without those it hides
   * or that the text sets another way (italic is the style); null when the
   * family's variable file can't be read, empty when the font has no axes.
   */
  async axes(face: Omit<ShapingFace, "variable">): Promise<FontAxis[] | null> {
    const variable = { ...face, variable: true };
    if ((await this.load(variable)) !== "ready") return null;
    const entry = this.#faces.get(faceKey(variable));
    if (entry?.status !== "ready") return null;
    const HIDDEN = 1;
    return Object.values(entry.face.getAxisInfos())
      .filter((axis) => (axis.flags & HIDDEN) === 0 && axis.tag !== "ital")
      .sort((a, b) => a.axisIndex - b.axisIndex)
      .map((axis) => ({
        tag: axis.tag,
        name: (axis.nameId ? entry.face.getName(axis.nameId, "en") : "") || null,
        min: axis.min,
        default: axis.default,
        max: axis.max,
      }));
  }

  /** The face at the run's point on its axes, made on first use. */
  #instance(entry: ReadyFace, run: ShapingRun): Instance {
    const settings = axisSettings(entry.axes, run);
    const key = Object.keys(settings)
      .sort()
      .map((tag) => `${tag}=${settings[tag]}`)
      .join(",");
    const kept = entry.instances.get(key);
    if (kept) {
      entry.instances.delete(key);
      entry.instances.set(key, kept);
      return kept;
    }
    const font = new entry.hb.Font(entry.face);
    const variations = Object.entries(settings).map(([tag, v]) => new entry.hb.Variation(tag, v));
    if (variations.length > 0) font.setVariations(variations);
    const instance: Instance = { font, paths: new Map() };
    entry.instances.set(key, instance);
    // Dropped fonts are freed by harfbuzzjs once collected.
    for (const old of entry.instances.keys()) {
      if (entry.instances.size <= MAX_INSTANCES) break;
      entry.instances.delete(old);
    }
    return instance;
  }

  #entry(face: ShapingFace): FaceEntry {
    const key = faceKey(face);
    let entry = this.#faces.get(key);
    if (!entry) {
      entry = { status: "loading" };
      this.#faces.set(key, entry);
      void this.#open(face).then(
        (ready) =>
          this.#settle(face, ready ? { status: "ready", ...ready } : { status: "unavailable" }),
        () => this.#settle(face, { status: "unavailable" }),
      );
    }
    return entry;
  }

  #settle(face: ShapingFace, entry: FaceEntry): void {
    this.#faces.set(faceKey(face), entry);
    this.#generation++;
    for (const listener of [...this.#listeners]) listener(face.family);
  }

  async #open(face: ShapingFace): Promise<ReadyFace | null> {
    this.#harfBuzz ??= this.#loadHarfBuzz().catch((error: unknown) => {
      this.#harfBuzz = null;
      throw error;
    });
    const [hb, bytes] = await Promise.all([this.#harfBuzz, this.#loadBytes(face)]);
    if (!bytes) return null;
    const hbFace = sharedFace(hb, bytes).face;
    const axes: Record<string, { min: number; default: number; max: number }> = {};
    for (const [tag, axis] of Object.entries(hbFace.getAxisInfos()))
      axes[tag] = { min: axis.min, default: axis.default, max: axis.max };
    return { hb, face: hbFace, upem: hbFace.upem || 1000, axes, instances: new Map() };
  }

  #shape(
    entry: ReadyFace,
    instance: Instance,
    text: string,
    size: number,
    features: FontFeatures,
  ): ShapedText | null {
    const { hb, upem } = entry;
    const { font, paths } = instance;
    const buffer = new hb.Buffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    hb.shape(
      font,
      buffer,
      Object.entries(features).map(([tag, on]) => new hb.Feature(tag, on ? 1 : 0)),
    );
    const infos = buffer.getGlyphInfos();
    const positions = buffer.getGlyphPositions();
    const scale = size / upem;
    const glyphs: ShapedGlyph[] = [];
    let pen = 0;
    let rise = 0;
    for (const [i, info] of infos.entries()) {
      const p = positions[i];
      if (!p) continue;
      const id = info.codepoint;
      let outline = paths.get(id);
      if (!outline) {
        const d = font.glyphToPath(id);
        outline = { d, path: d ? this.#makePath(d) : null };
        paths.set(id, outline);
      }
      glyphs.push({
        path: outline.path,
        d: outline.d,
        x: (pen + p.xOffset) * scale,
        y: (rise + p.yOffset) * scale,
        cluster: info.cluster,
      });
      pen += p.xAdvance;
      rise += p.yAdvance;
    }
    // A character the font lacks shapes to glyph 0 (a box).
    if (infos.some((info) => info.codepoint === 0)) return null;
    return { glyphs, width: pen * scale, scale };
  }
}

/**
 * Measures with the canvas, and with the shaper for runs that set OpenType
 * features or variable axes (their widths are the shaped glyphs', so what's
 * laid out is what's drawn). While a run's face loads, it measures as the
 * canvas has it.
 */
export class ShapingMeasurer implements TextMeasurer {
  constructor(
    readonly base: TextMeasurer & { invalidate(): void },
    readonly shaper: Shaper,
    /** Font aliases (decision 0036): which family text is drawn in. */
    readonly fonts: FontResolver | null = null,
  ) {}

  family(family: string, size: number): string {
    return this.fonts ? this.fonts.family(family, size) : family;
  }

  missing(family: string, size: number, weight: number, italic: boolean): boolean {
    return this.fonts?.missing?.(family, size, weight, italic) ?? false;
  }

  width(font: string, text: string, run?: ShapingRun | null): number {
    const shaped = run ? this.shaper.shape(text, run) : null;
    return shaped ? shaped.width : this.base.width(font, text);
  }

  shape(text: string, run: ShapingRun): ShapedText | null {
    return this.shaper.shape(text, run);
  }

  metrics(font: string): FontMetrics | null {
    return this.base.metrics?.(font) ?? null;
  }

  get generation(): number {
    return (this.base.generation ?? 0) + this.shaper.generation + (this.fonts?.generation ?? 0);
  }

  /** Call after web fonts load: earlier measurements used fallback fonts. */
  invalidate(): void {
    this.base.invalidate();
  }
}
