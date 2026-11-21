/**
 * OpenType features and variable axes, shaped by HarfBuzz
 * (docs/decisions/0005-opentype-features.md, 0009-variable-fonts.md).
 *
 * The 2D canvas can't apply OpenType features or set a variable font's axes
 * (beyond weight), so text that sets any is shaped here: HarfBuzz
 * (WebAssembly, loaded the first time a file needs it) turns the text, its
 * font's bytes, the features and the axes into glyphs and positions, and the
 * renderer fills the glyphs' outlines. The engine uses the shaper for plain
 * text as well.
 *
 * Text that sets axes is shaped from the family's variable file (a face
 * with `variable`), at one HarfBuzz font per point on the axes, sharing the
 * face.
 *
 * Shaping is synchronous once a face is ready, as drawing needs. Until then
 * `shape` answers null (the text draws without its features) and starts
 * loading; when the face is ready, listeners hear its family so the text is
 * measured and drawn again. A face without accessible bytes stays unavailable:
 * the inspector says why.
 *
 * A face's load has a deadline (`ShaperOptions.loadDeadlineMs`, 3 s by
 * default): one still loading then is unavailable, so its text isn't left
 * waiting for as long as the file is open. Its file may still come: if it
 * does, the face is ready then, and listeners hear it as they would have.
 * A face that failed or timed out is loaded again on `retry`.
 */
import { type FontFeatures, GLYPH_UNITS, scriptSlice } from "@drawpane/model";
import { type Face, type FontBytesLoader, faceKey } from "@drawpane/raster";
import { type ColorEmojiFont, colorEmojiFont, ENGINE_EMOJI_FACE } from "./color-emoji";
import { acquireFace, isHarfBuzzOutOfMemory, releaseFace } from "./harfbuzz-faces";
import { isPrivateUse, MISSING_GLYPH_FAMILY, missingGlyphFont } from "./missing-glyph-font";
import type {
  EngineText,
  FontMetrics,
  FontResolver,
  ShapedGlyph,
  ShapedText,
  ShapingRun,
  TextMeasurer,
} from "./text";
import { bidiText, type TextDirection } from "./text-bidi";
import { FALLBACK_FAMILY, type FontCoverage, fontRuns, lastResortText } from "./text-fallback";
import { transformPath } from "./vector/bounds";
import { parsePath, serializePath } from "./vector/svg";

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

interface ReadyFace extends FontCoverage {
  readonly hb: HarfBuzz;
  /** The file, held in `harfbuzz-faces` until `unload`. */
  readonly bytes: ArrayBuffer;
  readonly face: HbFace;
  readonly upem: number;
  /** Its axes by tag (none for a static font). */
  readonly axes: Readonly<Record<string, { min: number; default: number; max: number }>>;
  /** The instances shaped from, by their point on the axes; the least recently used go first. */
  readonly instances: Map<string, Instance>;
  readonly emoji: ColorEmojiFont | null;
}

type FaceEntry =
  | { readonly status: "loading" }
  /** `late`: its load passed the deadline, and its file may still come. */
  | { readonly status: "unavailable"; readonly late?: true }
  | ({ readonly status: "ready" } & ReadyFace);

/** How long a face may load before it's unavailable (its file may still come later). */
export const FACE_LOAD_DEADLINE_MS = 3000;

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

/** Set once HarfBuzz's outline callbacks failed to be made (in a Worker): see `#shape`. */
let outlinesUnavailable = false;

/** Shaped runs kept, at most: a file's labels repeat, so most frames are all hits. */
const MAX_RUNS = 5000;

export interface ShaperOptions {
  /** HarfBuzz itself; by default the `harfbuzzjs` package, imported on first use. */
  readonly harfBuzz?: () => Promise<HarfBuzz>;
  /** An outline from SVG path data; by default `new Path2D(d)`. */
  readonly makePath?: (d: string) => Path2D | null;
  /** How long a face may load before it's unavailable: `FACE_LOAD_DEADLINE_MS` by default. */
  readonly loadDeadlineMs?: number;
  /** An outline face for a platform font whose bytes the browser cannot share. */
  readonly substitute?: (face: ShapingFace) => ShapingFace | null;
  /** Browser font name for the bundled outline, independent of a team font of the same name. */
  readonly fallbackFamily?: string;
  /** Bundled faces stay provisional on slow loads and retry I/O failures at these intervals. */
  readonly bundledRetryMs?: readonly number[];
  /** Prepared outline subsets that can cover characters after Instrument Sans. */
  readonly fallbackFaces?: (text: string, run: ShapingRun) => readonly ShapingFace[];
}

export class Shaper {
  readonly #loadBytes: FontBytesLoader;
  readonly #loadHarfBuzz: () => Promise<HarfBuzz>;
  readonly #makePath: (d: string) => Path2D | null;
  readonly #deadline: number;
  readonly #bundledRetryMs: readonly number[];
  readonly #fallbackFamily: string;
  readonly #fallbackFaces: (text: string, run: ShapingRun) => readonly ShapingFace[];
  readonly #faceRevisions = new Map<string, number>();
  readonly #substitute: (face: ShapingFace) => ShapingFace | null;
  #harfBuzz: Promise<HarfBuzz> | null = null;
  readonly #faces = new Map<string, FaceEntry>();
  /** Shaped runs, and null for runs that can't be shaped faithfully (see #shape). */
  readonly #runs = new Map<string, ShapedText | null>();
  readonly #engineRuns = new Map<string, { result: EngineText; revision: number }>();
  readonly #normalized = new Map<string, string>();
  readonly #listeners = new Set<(family: string) => void>();
  #generation = 0;

  constructor(loadBytes: FontBytesLoader, options: ShaperOptions = {}) {
    this.#loadBytes = loadBytes;
    this.#loadHarfBuzz = options.harfBuzz ?? (() => import("harfbuzzjs"));
    this.#deadline = options.loadDeadlineMs ?? FACE_LOAD_DEADLINE_MS;
    this.#bundledRetryMs = options.bundledRetryMs ?? [];
    this.#fallbackFamily = options.fallbackFamily ?? FALLBACK_FAMILY;
    this.#fallbackFaces = options.fallbackFaces ?? (() => []);
    this.#substitute = options.substitute ?? (() => null);
    this.#makePath =
      options.makePath ?? ((d) => (typeof Path2D === "undefined" ? null : new Path2D(d)));
  }

  /** Bumped each time a face becomes ready (or turns out not to be): earlier layouts are stale. */
  get generation(): number {
    return this.#generation;
  }

  faceRevision(key: string): number {
    return this.#faceRevisions.get(key) ?? 0;
  }

  /** Start both bundled fallback families as soon as an engine view opens. */
  preloadFallback(): void {
    this.#entry({ family: MISSING_GLYPH_FAMILY, weight: 400, italic: false });
    for (const italic of [false, true])
      this.#entry({ family: this.#fallbackFamily, weight: 400, italic, variable: true });
  }

  async prepareColorEmoji(): Promise<void> {
    await this.load(ENGINE_EMOJI_FACE);
  }

  colorEmoji(text: string, size: number): ShapedText | null {
    const entry = this.#entry(ENGINE_EMOJI_FACE);
    if (entry.status !== "ready" || !entry.emoji) return null;
    const run = { size, weight: 400, variations: {} };
    try {
      return entry.emoji.shape(entry.hb, this.#instance(entry, run).font, text, size);
    } catch (error) {
      if (isHarfBuzzOutOfMemory(error)) return null;
      throw error;
    }
  }

  /** Hears the family of each face that became ready or unavailable. */
  subscribe(listener: (family: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Whether a face has started loading (it may be ready or unavailable since). */
  started(face: ShapingFace): boolean {
    return this.#faces.has(faceKey(face));
  }

  status(face: ShapingFace): FaceStatus {
    return this.#faces.get(faceKey(face))?.status ?? "loading";
  }

  loading(run: ShapingRun): string | null {
    const face = shapingFace(run);
    return this.status(face) === "loading" ? faceKey(face) : null;
  }

  /** A face's status by its key (`faceKey`): loading until it's ready or unavailable. */
  statusOf(key: string): FaceStatus {
    return this.#faces.get(key)?.status ?? "loading";
  }

  /**
   * Tries an unavailable face again (its file failed to load, say): the next
   * shape or load starts over.
   */
  retry(face: ShapingFace): void {
    if (this.#faces.get(faceKey(face))?.status === "unavailable") {
      this.#faces.delete(faceKey(face));
      this.#engineRuns.clear();
    }
  }

  /** A newly granted local-font permission can make earlier misses readable. */
  retryUnavailable(families: ReadonlySet<string>): void {
    for (const [key, entry] of this.#faces) {
      if (entry.status === "unavailable" && families.has(key.split("\u0000")[0] ?? "")) {
        this.#faces.delete(key);
        this.#faceRevisions.set(key, ++this.#generation);
      }
    }
  }

  /** Widths in the browser can change independently of the outline file. */
  invalidateMeasurements(families: ReadonlySet<string>): void {
    const revision = ++this.#generation;
    for (const family of families) this.#faceRevisions.set(`font:${family}`, revision);
  }

  /**
   * Lets go of a ready face, freeing its fonts (and its file, when nothing
   * else holds it): the measurer's load that made it ran out of memory. The
   * next shape or load starts over.
   */
  unload(face: ShapingFace): void {
    const key = faceKey(face);
    const entry = this.#faces.get(key);
    if (entry?.status !== "ready") return;
    this.#faces.delete(key);
    for (const { font } of entry.instances.values()) font.destroy();
    entry.instances.clear();
    releaseFace(entry.hb, entry.bytes);
    this.#runs.clear();
    this.#engineRuns.clear();
    this.#faceRevisions.set(key, ++this.#generation);
  }

  /** Waits for a face: ready, or unavailable. */
  async load(face: ShapingFace): Promise<FaceStatus> {
    const entry = this.#entry(face);
    if (entry.status !== "loading") return entry.status;
    return this.waitForFace(faceKey(face));
  }

  /** Waits for a face already requested by the display-list builder. */
  async waitForFace(key: string): Promise<FaceStatus> {
    const entry = this.#faces.get(key);
    if (!entry) return "unavailable";
    if (entry.status !== "loading") return entry.status;
    await new Promise<void>((resolve) => {
      const off = this.subscribe(() => {
        if (this.#faces.get(key)?.status !== "loading") {
          off();
          resolve();
        }
      });
    });
    return this.#faces.get(key)?.status ?? "unavailable";
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
    const shaped = !run.direction && bidiText(text) ? null : this.#tryShape(entry, run, text);
    if (this.#runs.size >= MAX_RUNS) this.#runs.clear();
    this.#runs.set(key, shaped);
    return shaped;
  }

  /** Canvas fallback advances may change when a web font arrives. */
  invalidateFallbackWidths(): void {
    this.#engineRuns.clear();
  }

  /** The canvas's fallback order, with a bundled outline wherever no face can draw a glyph. */
  shapeForEngine(text: string, run: ShapingRun, measure?: (text: string) => number): EngineText {
    const key = `${run.key}\u0000${run.cjkRegion ?? ""}\u0000${text}`;
    const hit = this.#engineRuns.get(key);
    if (hit?.result.dependencies?.every((face) => this.faceRevision(face) <= hit.revision))
      return hit.result;
    const dependencies = new Set<string>();
    const result: EngineText = {
      ...this.#shapeForEngine(text, run, dependencies, measure),
      dependencies: [...dependencies],
    };
    if (!("waiting" in result)) {
      if (this.#engineRuns.size >= MAX_RUNS) this.#engineRuns.clear();
      this.#engineRuns.set(key, { result, revision: this.#generation });
    }
    return result;
  }

  #shapeForEngine(
    text: string,
    run: ShapingRun,
    dependencies: Set<string>,
    measure?: (text: string) => number,
  ): EngineText {
    const entryFor = (face: ShapingFace) => {
      dependencies.add(faceKey(face));
      return this.#entry(face);
    };
    const wanted = shapingFace(run);
    dependencies.add(`font:${wanted.family}`);
    const entry = entryFor(wanted);
    if (entry.status === "loading") return { waiting: faceKey(wanted) };
    const own = entry.status === "ready" ? entry : null;
    const exact = own ? this.shape(text, run) : null;
    if (exact && exact.outlines !== false) {
      const styled = Object.keys(run.features).length > 0 || wanted.variable;
      const width = styled ? exact.width : (measure?.(text) ?? exact.width);
      return { shaped: this.#fit(exact, width, run.direction), fallback: false };
    }

    // When the feature shaper cannot draw a whole run, the canvas draws it
    // with default features and axes. Apply those defaults to each face here.
    const plain = { ...run, features: {}, variations: {} };
    const primaryFace = shapingFace(plain);
    const primary = wanted.variable ? entryFor(primaryFace) : entry;
    if (primary.status === "loading") return { waiting: faceKey(primaryFace) };
    const primaryReady = primary.status === "ready" ? primary : null;
    const boxFace = { family: MISSING_GLYPH_FAMILY, weight: 400, italic: false };
    const fallbackFace = {
      family: this.#fallbackFamily,
      weight: run.weight,
      italic: run.italic,
      variable: true,
    };
    const boxCoverage = { unicodes: { has: isPrivateUse } };
    const first = fontRuns(text, [primaryReady, boxCoverage], run.direction);
    const boxEntry = first.some((piece) => piece.face === 1) ? entryFor(boxFace) : null;
    const needsFallback = first.some((piece) => piece.face === -1);
    if (needsFallback) dependencies.add(`font:${FALLBACK_FAMILY}`);
    const substituteFace = needsFallback && !primaryReady ? this.#substitute(primaryFace) : null;
    const substituteEntry = substituteFace ? entryFor(substituteFace) : null;
    const fallbackEntry = needsFallback ? entryFor(fallbackFace) : null;
    if (boxEntry?.status === "loading") return { waiting: faceKey(boxFace) };
    if (substituteFace && substituteEntry?.status === "loading")
      return { waiting: faceKey(substituteFace) };
    if (fallbackEntry?.status === "loading") return { waiting: faceKey(fallbackFace) };
    const boxReady = boxEntry?.status === "ready" ? boxEntry : null;
    const substitute = substituteEntry?.status === "ready" ? substituteEntry : null;
    const fallbackReady = fallbackEntry?.status === "ready" ? fallbackEntry : null;
    const coverage = [primaryReady, boxCoverage, substitute, fallbackReady];
    const scriptText = fontRuns(text, coverage, run.direction)
      .filter((piece) => piece.face < 0)
      .map((piece) => piece.text)
      .join("");
    const scripts = scriptText ? this.#fallbackFaces(scriptText, run) : [];
    const scriptEntries = scripts.map(entryFor);
    for (const [index, entry] of scriptEntries.entries()) {
      if (entry.status === "loading") return { waiting: faceKey(scripts[index] as ShapingFace) };
    }
    const outlines = scriptEntries.map((entry) => (entry.status === "ready" ? entry : null));
    const faces = [primaryReady, boxReady, substitute, fallbackReady, ...outlines];
    const pieces = fontRuns(text, [...coverage, ...outlines], run.direction);
    const glyphs: ShapedGlyph[] = [];
    const scale = run.size / GLYPH_UNITS;
    let width = 0;
    for (const piece of pieces) {
      const face = faces[piece.face];
      const shaped = face
        ? this.#tryShape(face, { ...plain, direction: piece.direction }, piece.text)
        : null;
      const before = measure?.(text.slice(0, piece.start)) ?? 0;
      const measurePiece = measure
        ? (prefix: string) => Math.max(0, measure(text.slice(0, piece.start) + prefix) - before)
        : undefined;
      const advance = measurePiece?.(piece.text);
      const drawn =
        shaped && shaped.outlines !== false
          ? shaped
          : lastResortText(piece.text, run.size, measurePiece, piece.direction);
      const fitted = this.#fit(drawn, advance ?? drawn.width, piece.direction, scale);
      for (const glyph of fitted.glyphs) {
        glyphs.push({
          ...glyph,
          x: glyph.x + width,
          cluster: glyph.cluster + piece.start,
        });
      }
      width += fitted.width;
    }
    return { shaped: { glyphs, width, scale }, fallback: true };
  }

  /** Anchor the visual run at its measured reading edge and keep its internal spacing. */
  #fit(
    shaped: ShapedText,
    width: number,
    direction?: TextDirection,
    scale = shaped.scale,
  ): ShapedText {
    const offset = direction === "rtl" ? width - shaped.width : 0;
    const units = shaped.scale / scale;
    const normalize = Math.abs(units - 1) >= 1e-9;
    if (!normalize && offset === 0) return width === shaped.width ? shaped : { ...shaped, width };
    return {
      width,
      scale,
      glyphs: shaped.glyphs.map((glyph) => ({
        ...glyph,
        x: glyph.x + offset,
        ...(normalize ? { path: null, d: this.#normalize(glyph.d, units) } : {}),
      })),
    };
  }

  /** One scale per engine fill lets outlines from different faces overlap as one shape. */
  #normalize(d: string, units: number): string {
    if (!d) return d;
    const key = `${units}|${d}`;
    let normalized = this.#normalized.get(key);
    if (normalized === undefined) {
      normalized = serializePath(transformPath(parsePath(d), [units, 0, 0, units, 0, 0]));
      if (this.#normalized.size >= MAX_RUNS) this.#normalized.clear();
      this.#normalized.set(key, normalized);
    }
    return normalized;
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
  #instance(entry: ReadyFace, run: Pick<ShapingRun, "weight" | "size" | "variations">): Instance {
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
    // Dropped fonts are freed now, not once collected: HarfBuzz's memory is capped.
    for (const [old, dropped] of entry.instances) {
      if (entry.instances.size <= MAX_INSTANCES) break;
      entry.instances.delete(old);
      dropped.font.destroy();
    }
    return instance;
  }

  #entry(face: ShapingFace, attempt = 0): FaceEntry {
    const key = faceKey(face);
    let entry = this.#faces.get(key);
    if (!entry) {
      const loading: FaceEntry = { status: "loading" };
      entry = loading;
      this.#faces.set(key, loading);
      // Past the deadline the face is unavailable, marked late: its file, if it comes after
      // all, still makes it ready (unless it was retried or unloaded meanwhile).
      const late: FaceEntry = { status: "unavailable", late: true };
      const bundled =
        face.family === MISSING_GLYPH_FAMILY ||
        (face.family === this.#fallbackFamily && face.variable && this.#bundledRetryMs.length > 0);
      const timer = bundled
        ? undefined
        : setTimeout(() => {
            if (this.#faces.get(key) === loading) this.#settle(face, late);
          }, this.#deadline);
      const done = (ready: ReadyFace | null) => {
        clearTimeout(timer);
        const now = this.#faces.get(key);
        if (!ready && now === loading && bundled && this.#bundledRetryMs.length > 0) {
          const delay = this.#bundledRetryMs[Math.min(attempt, this.#bundledRetryMs.length - 1)];
          setTimeout(() => {
            if (this.#faces.get(key) !== loading) return;
            this.#faces.delete(key);
            this.#entry(face, attempt + 1);
          }, delay);
          return;
        }
        if (now === loading)
          this.#settle(face, ready ? { status: "ready", ...ready } : { status: "unavailable" });
        else if (now === late && ready) this.#settle(face, { status: "ready", ...ready });
        else if (ready) releaseFace(ready.hb, ready.bytes);
      };
      void this.#open(face).then(done, () => done(null));
    }
    return entry;
  }

  #settle(face: ShapingFace, entry: FaceEntry): void {
    const key = faceKey(face);
    this.#faces.set(key, entry);
    this.#faceRevisions.set(key, ++this.#generation);
    for (const listener of [...this.#listeners]) listener(face.family);
  }

  async #open(face: ShapingFace): Promise<ReadyFace | null> {
    this.#harfBuzz ??= this.#loadHarfBuzz().catch((error: unknown) => {
      this.#harfBuzz = null;
      throw error;
    });
    const box = face.family === MISSING_GLYPH_FAMILY;
    const [hb, bytes] = await Promise.all([
      this.#harfBuzz,
      box ? missingGlyphFont() : this.#loadBytes(face),
    ]);
    if (!bytes) return null;
    // Held for as long as the shaper lives: its fonts are made from it as runs need them.
    const shared = acquireFace(hb, bytes);
    const hbFace = shared.face;
    const subset = face.subset === undefined ? null : scriptSlice(face.family, face.subset);
    try {
      const axes: Record<string, { min: number; default: number; max: number }> = {};
      for (const [tag, axis] of Object.entries(hbFace.getAxisInfos()))
        axes[tag] = { min: axis.min, default: axis.default, max: axis.max };
      return {
        hb,
        bytes,
        face: hbFace,
        upem: hbFace.upem || GLYPH_UNITS,
        axes,
        instances: new Map(),
        emoji:
          face.family === ENGINE_EMOJI_FACE.family ? await colorEmojiFont(bytes, hbFace) : null,
        get unicodes() {
          if (box) return { has: isPrivateUse };
          return subset && subset !== "all"
            ? {
                has: (cp: number) =>
                  cp >= subset.start && cp <= subset.end && shared.unicodes.has(cp),
              }
            : shared.unicodes;
        },
      };
    } catch (error) {
      releaseFace(hb, bytes);
      throw error;
    }
  }

  #tryShape(face: ReadyFace, run: ShapingRun, text: string): ShapedText | null {
    try {
      return this.#shape(
        face,
        this.#instance(face, run),
        text,
        run.size,
        run.features,
        run.direction,
      );
    } catch (error) {
      if (isHarfBuzzOutOfMemory(error)) return null;
      throw error;
    }
  }

  #shape(
    entry: ReadyFace,
    instance: Instance,
    text: string,
    size: number,
    features: FontFeatures,
    direction?: TextDirection,
  ): ShapedText | null {
    const { hb, upem } = entry;
    const { font, paths } = instance;
    // Freed here, not when collected: HarfBuzz's memory is capped, and a long text takes a lot of it.
    const buffer = new hb.Buffer();
    let infos: ReturnType<typeof buffer.getGlyphInfos>;
    let positions: ReturnType<typeof buffer.getGlyphPositions>;
    try {
      buffer.addText(text);
      buffer.guessSegmentProperties();
      if (direction) buffer.setDirection(direction === "rtl" ? hb.Direction.RTL : hb.Direction.LTR);
      hb.shape(
        font,
        buffer,
        Object.entries(features).map(([tag, on]) => new hb.Feature(tag, on ? 1 : 0)),
      );
      infos = buffer.getGlyphInfos();
      positions = buffer.getGlyphPositions();
    } finally {
      buffer.destroy();
    }
    const scale = size / upem;
    const glyphs: ShapedGlyph[] = [];
    let pen = 0;
    let rise = 0;
    for (const [i, info] of infos.entries()) {
      const p = positions[i];
      if (!p) continue;
      const id = info.codepoint;
      let outline = paths.get(id);
      if (!outline && !outlinesUnavailable) {
        let d = "";
        try {
          d = font.glyphToPath(id);
        } catch {
          // HarfBuzz's draw callbacks are made with `addFunction`, which compiles WebAssembly at
          // run time: a Worker forbids it. The callbacks it half made then draw nothing, so from
          // here on no outline from this HarfBuzz can be trusted.
          outlinesUnavailable = true;
        }
        if (!outlinesUnavailable) {
          outline = { d, path: d ? this.#makePath(d) : null };
          paths.set(id, outline);
        }
      }
      glyphs.push({
        path: outline?.path ?? null,
        d: outline?.d ?? "",
        x: (pen + p.xOffset) * scale,
        y: (rise + p.yOffset) * scale,
        cluster: info.cluster,
      });
      pen += p.xAdvance;
      rise += p.yAdvance;
    }
    // A character the font lacks shapes to glyph 0 (a box).
    if (infos.some((info) => info.codepoint === 0)) return null;
    return outlinesUnavailable
      ? { glyphs, width: pen * scale, scale, outlines: false }
      : { glyphs, width: pen * scale, scale };
  }
}

/**
 * Measures with the canvas, and with the shaper for runs that set OpenType
 * features or variable axes (their widths are the shaped glyphs', so what's
 * laid out is what's drawn). While a run's face loads, it measures as the
 * canvas has it.
 */
export class ShapingMeasurer implements TextMeasurer {
  #engineText = false;

  constructor(
    readonly base: TextMeasurer & { invalidate(bumpGeneration?: boolean): void },
    readonly shaper: Shaper,
    /** Font aliases (decision 0036): which family text is drawn in. */
    readonly fonts: FontResolver | null = null,
    readonly scriptLocale = "",
  ) {}

  get engineText(): boolean {
    return this.#engineText;
  }

  setEngineText(enabled: boolean): void {
    if (this.#engineText === enabled) return;
    this.#engineText = enabled;
    this.base.invalidate();
  }

  family(family: string, size: number): string {
    return this.fonts ? this.fonts.family(family, size) : family;
  }

  missing(family: string, size: number, weight: number, italic: boolean): boolean {
    return this.fonts?.missing?.(family, size, weight, italic) ?? false;
  }

  width(font: string, text: string, run?: ShapingRun | null, direction?: TextDirection): number {
    const shaped = run ? this.shaper.shape(text, run) : null;
    return shaped ? shaped.width : this.base.width(font, text, null, direction);
  }

  shape(text: string, run: ShapingRun): ShapedText | null {
    return this.shaper.shape(text, run);
  }

  colorEmoji(text: string, size: number): ShapedText | null {
    return this.shaper.colorEmoji(text, size);
  }

  prepareColorEmoji(): Promise<void> {
    return this.shaper.prepareColorEmoji();
  }

  shapeForEngine(text: string, run: ShapingRun, font: string): EngineText {
    return this.shaper.shapeForEngine(text, run, (piece) =>
      this.base.width(font, piece, null, run.direction),
    );
  }

  loading(run: ShapingRun): string | null {
    return this.shaper.loading(run);
  }

  faceRevision(key: string): number {
    return this.shaper.faceRevision(key);
  }

  faceStatus(key: string): FaceStatus {
    return this.shaper.statusOf(key);
  }

  get faceGeneration(): number {
    return this.shaper.generation;
  }

  metrics(font: string): FontMetrics | null {
    return this.base.metrics?.(font) ?? null;
  }

  get generation(): number {
    return (this.base.generation ?? 0) + this.shaper.generation + (this.fonts?.generation ?? 0);
  }

  /** Call after web fonts load: earlier measurements used fallback fonts. */
  invalidate(families?: ReadonlySet<string>): void {
    if (families) {
      this.shaper.invalidateMeasurements(families);
      this.base.invalidate(false);
    } else {
      this.shaper.invalidateFallbackWidths();
      this.base.invalidate();
    }
  }
}
