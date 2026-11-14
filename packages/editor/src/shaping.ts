/**
 * OpenType features, shaped by HarfBuzz (docs/decisions/0005-opentype-features.md).
 *
 * The 2D canvas can't apply OpenType features, so text that sets any is
 * shaped here: HarfBuzz (WebAssembly, loaded the first time a file uses
 * features) turns the text, its font's bytes and the features into glyphs
 * and positions, and the renderer fills the glyphs' outlines. Text without
 * features never comes here.
 *
 * Shaping is synchronous once a face is ready, as drawing needs. Until then
 * `shape` answers null (the text draws without its features) and starts
 * loading; when the face is ready, listeners hear its family so the text is
 * measured and drawn again. A face whose bytes can't be had (a system or
 * local font) stays unavailable: the inspector says why.
 */
import type { FontFeatures } from "@drawpane/model";
import type { FeatureRun, ShapedGlyph, ShapedText, TextMeasurer } from "./text";

type HarfBuzz = typeof import("harfbuzzjs");
type HbFont = InstanceType<HarfBuzz["Font"]>;
type HbFace = InstanceType<HarfBuzz["Face"]>;

/** A face text is set in. */
export interface ShapingFace {
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
}

/** The bytes of a face's font file (TrueType or OpenType), or null when there are none to have. */
export type FontBytesLoader = (face: ShapingFace) => Promise<ArrayBuffer | null>;

/** A feature a font offers, with its own name for it when it has one (stylistic sets usually do). */
export interface OfferedFeature {
  readonly tag: string;
  readonly name: string | null;
}

export type FaceStatus = "loading" | "ready" | "unavailable";

interface ReadyFace {
  readonly hb: HarfBuzz;
  readonly face: HbFace;
  readonly font: HbFont;
  readonly upem: number;
  /** Outlines by glyph id, as path data and as a Path2D. */
  readonly paths: Map<number, { readonly d: string; readonly path: Path2D | null }>;
}

type FaceEntry =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | ({ readonly status: "ready" } & ReadyFace);

const faceKey = (f: ShapingFace) => `${f.family}\u0000${f.weight}\u0000${f.italic}`;

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
  readonly #runs = new Map<string, ShapedText>();
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

  /** `text` with the run's features, or null while its face loads or when it can't be shaped. */
  shape(text: string, run: FeatureRun): ShapedText | null {
    const key = `${run.key}\u0000${text}`;
    const hit = this.#runs.get(key);
    if (hit) return hit;
    const entry = this.#entry(run);
    if (entry.status !== "ready") return null;
    const shaped = this.#shape(entry, text, run.size, run.features);
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
    const hbFace = new hb.Face(new hb.Blob(bytes));
    const font = new hb.Font(hbFace);
    // A variable font draws the weight asked for (a static one ignores this).
    const axes = hbFace.getAxisInfos();
    if (axes.wght) {
      const { min, max } = axes.wght;
      font.setVariations([new hb.Variation("wght", Math.min(max, Math.max(min, face.weight)))]);
    }
    return { hb, face: hbFace, font, upem: hbFace.upem || 1000, paths: new Map() };
  }

  #shape(entry: ReadyFace, text: string, size: number, features: FontFeatures): ShapedText {
    const { hb, font, upem, paths } = entry;
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
    return { glyphs, width: pen * scale, scale };
  }
}

/**
 * Measures with the canvas, and with the shaper for runs that set OpenType
 * features (their widths are the shaped glyphs', so what's laid out is what's
 * drawn). While a run's face loads, it measures as the canvas has it.
 */
export class ShapingMeasurer implements TextMeasurer {
  constructor(
    readonly base: TextMeasurer & { invalidate(): void },
    readonly shaper: Shaper,
  ) {}

  width(font: string, text: string, run?: FeatureRun | null): number {
    const shaped = run ? this.shaper.shape(text, run) : null;
    return shaped ? shaped.width : this.base.width(font, text);
  }

  shape(text: string, run: FeatureRun): ShapedText | null {
    return this.shaper.shape(text, run);
  }

  get generation(): number {
    return (this.base.generation ?? 0) + this.shaper.generation;
  }

  /** Call after web fonts load: earlier measurements used fallback fonts. */
  invalidate(): void {
    this.base.invalidate();
  }
}
