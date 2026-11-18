/**
 * Saved glyph outlines (decision 0037): text whose font isn't here drawn as
 * the app that laid it out (Figma) placed its glyphs.
 *
 * - A file's glyphs are shared: each outline once, in `glyphSet` nodes at
 *   the root, by id (a hash of the outline).
 * - A text layer's `glyphLayout` places them, and holds `key`, the
 *   fingerprint of the text and typography they were laid out from. While
 *   the layer's own fingerprint is that key, they're what it looks like;
 *   once anything in it changes (its characters, a run, its size), they
 *   aren't, and are never drawn again.
 * - Both are bounded: per set, per layer and per file (the constants here
 *   and in schema.ts), so a very large file stays within what a room holds.
 */
import { hash64, stableJson } from "./libraries";
import type { NodeRecord } from "./ops";
import {
  GLYPH_SET_CHARS,
  GLYPH_SET_GLYPHS,
  GLYPH_UNITS,
  type GlyphLayout,
  getProp,
  LAYER_GLYPHS,
  type PropName,
  type Props,
} from "./schema";

/** At most this many distinct glyphs in one file. */
export const FILE_GLYPHS = 16_384;
/** At most this many characters of glyph outlines in one file (in sets of GLYPH_SET_CHARS). */
export const FILE_GLYPH_CHARS = 8_000_000;
/** At most this many glyphs placed across one file's text layers. */
export const FILE_GLYPH_PLACEMENTS = 2_000_000;

/** What a layer's glyphs depend on, besides runs: change one and the saved layout is stale. */
export const GLYPH_KEY_PROPS = [
  "characters",
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "textAlignVertical",
  "textAutoResize",
  "textCase",
  "textDecoration",
  "fontFeatures",
  "fontVariations",
  "leadingTrim",
  "paragraphSpacing",
  "listSpacing",
  "listType",
  "listLevel",
  "maxLines",
] as const satisfies readonly PropName[];

/**
 * A layer's runs as they shape its glyphs: clipped to its characters,
 * without fills (a colour doesn't move a glyph), the empty ones dropped and
 * touching ones that style alike merged, so equal styling gives one form.
 */
function runsForm(props: Props): Array<[number, number, string]> {
  const length = getProp(props, "characters").length;
  const runs = [...getProp(props, "textRuns")].sort((a, b) => a.start - b.start);
  const out: Array<[number, number, string]> = [];
  for (const run of runs) {
    const start = Math.max(0, run.start);
    const end = Math.min(length, run.end);
    if (end <= start) continue;
    const { start: _s, end: _e, fills: _f, ...style } = run;
    if (Object.keys(style).length === 0) continue;
    const form = stableJson(style);
    const last = out[out.length - 1];
    if (last && last[1] === start && last[2] === form) last[1] = end;
    else out.push([start, end, form]);
  }
  return out;
}

/** The fingerprint of what a text layer's glyphs are laid out from: 16 hex digits. */
export function glyphKey(props: Props): string {
  const values = GLYPH_KEY_PROPS.map((name) => getProp(props, name));
  return hash64(stableJson([values, runsForm(props)]));
}

/** A saved outline's id: 16 hex digits of its hash. */
export const glyphId = (outline: string): string => hash64(outline);

/** One glyph as the app that laid the text out placed it. */
export interface SavedGlyph {
  /** Its outline, in GLYPH_UNITS per em, y up (`commandsToGlyph`). */
  readonly d: string;
  /** Its origin on the baseline, in the layer's px. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** Its first character (UTF-16 index). */
  readonly char: number;
  /** Its advance in px, when known. */
  readonly advance?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * A file's glyph table as it's put together: each outline once, until the
 * file's bounds. `layout` places a layer's glyphs; `sets` are the nodes that
 * hold the outlines.
 */
export class GlyphTableBuilder {
  readonly #ids = new Map<string, string>();
  readonly #outlines = new Map<string, string>();
  #chars = 0;
  #placed = 0;
  /** Layers whose glyphs weren't kept: past a bound, or not all outlined. */
  skipped = 0;

  /** Glyphs placed so far. */
  get placed(): number {
    return this.#placed;
  }

  /** Distinct glyphs so far. */
  get size(): number {
    return this.#outlines.size;
  }

  /**
   * The saved layout of a text layer with `props` (its final values), or
   * null when it has no glyphs or keeping them would pass a bound.
   */
  layout(props: Props, glyphs: readonly SavedGlyph[]): GlyphLayout | null {
    if (glyphs.length === 0) return null;
    if (glyphs.length > LAYER_GLYPHS || this.#placed + glyphs.length > FILE_GLYPH_PLACEMENTS) {
      this.skipped++;
      return null;
    }
    // Outlines new to the table, and whether they fit.
    const fresh = new Map<string, string>();
    let chars = 0;
    for (const g of glyphs) {
      if (g.d.length > 64_000) {
        this.skipped++;
        return null;
      }
      if (this.#ids.has(g.d) || fresh.has(g.d)) continue;
      const id = glyphId(g.d);
      // A hash shared by two outlines: the layer keeps none rather than draw the wrong one.
      const known = this.#outlines.get(id);
      if (known !== undefined && known !== g.d) {
        this.skipped++;
        return null;
      }
      fresh.set(g.d, id);
      chars += g.d.length;
    }
    if (this.#outlines.size + fresh.size > FILE_GLYPHS || this.#chars + chars > FILE_GLYPH_CHARS) {
      this.skipped++;
      return null;
    }
    for (const [d, id] of fresh) {
      this.#ids.set(d, id);
      this.#outlines.set(id, d);
    }
    this.#chars += chars;
    this.#placed += glyphs.length;

    const refs: string[] = [];
    const refIndex = new Map<string, number>();
    const g: number[] = [];
    const size = (glyphs[0] as SavedGlyph).size;
    const sizes: number[] = [];
    const chars_: number[] = [];
    const advances: number[] = [];
    let ownSizes = false;
    let ownChars = false;
    let allAdvances = true;
    glyphs.forEach((glyph, i) => {
      const id = this.#ids.get(glyph.d) as string;
      let ref = refIndex.get(id);
      if (ref === undefined) {
        ref = refs.length;
        refs.push(id);
        refIndex.set(id, ref);
      }
      g.push(ref, round2(glyph.x), round2(glyph.y));
      sizes.push(round3(glyph.size));
      if (glyph.size !== size) ownSizes = true;
      chars_.push(glyph.char);
      if (glyph.char !== i) ownChars = true;
      if (glyph.advance === undefined || !Number.isFinite(glyph.advance)) allAdvances = false;
      else advances.push(round2(glyph.advance));
    });
    const decorated =
      getProp(props, "textDecoration") !== "none" ||
      getProp(props, "textRuns").some((r) => r.textDecoration && r.textDecoration !== "none");
    return {
      key: glyphKey(props),
      w: round3(getProp(props, "width")),
      h: round3(getProp(props, "height")),
      refs,
      g,
      size: round3(size),
      ...(ownSizes ? { s: sizes } : {}),
      ...(ownChars ? { c: chars_ } : {}),
      ...(decorated && allAdvances ? { a: advances } : {}),
    };
  }

  /**
   * The nodes holding the table, under the root: as few as the per-set
   * bounds allow, their ids from their first glyph's, ordered by `keys`.
   */
  sets(keys: (count: number) => readonly string[]): NodeRecord[] {
    const groups: Array<Record<string, string>> = [];
    let current: Record<string, string> = {};
    let count = 0;
    let chars = 0;
    for (const [id, d] of this.#outlines) {
      if (count + 1 > GLYPH_SET_GLYPHS || chars + d.length > GLYPH_SET_CHARS) {
        groups.push(current);
        current = {};
        count = 0;
        chars = 0;
      }
      current[id] = d;
      count++;
      chars += d.length;
    }
    if (count > 0) groups.push(current);
    const orderKeys = keys(groups.length);
    return groups.map(
      (outlines, i) =>
        ({
          id: `glyphs${Object.keys(outlines)[0]}`,
          type: "glyphSet",
          parent: "root",
          key: orderKeys[i] as string,
          props: { name: "Glyphs", glyphOutlines: outlines },
        }) as NodeRecord,
    );
  }
}

/** Formats a coordinate of a saved outline: thousandths of an em, to a tenth. */
export function glyphNumber(v: number): string {
  const n = Math.round(v * GLYPH_UNITS * 10) / 10;
  return Object.is(n, -0) ? "0" : String(n);
}
