/**
 * Text drawn from the glyph outlines its file saved (decision 0037).
 *
 * A .fig keeps, for each text layer, the glyphs Figma laid it out in: their
 * outlines and where it put them. That's how Figma draws a font it doesn't
 * have, and so does Drawpane: a text layer whose font isn't here (after
 * font aliases) is drawn from them, as long as they're still what it looks
 * like, which its `glyphLayout.key` says: the fingerprint of its text and
 * typography when it was laid out. Edit the text (or its size, a run, its
 * alignment…) and it's laid out as usual, in a fallback face; give the
 * team the font and the font is used. The outlines stay in the file either
 * way, for whoever opens it without the font.
 *
 * The canvas, SVG export (and through it the headless renderer, PDF and
 * thumbnails) draw the same paths from here.
 */
import {
  GLYPH_UNITS,
  type GlyphLayout,
  getProp,
  glyphKey,
  type NodeRecord,
  type Paint,
  ROOT_ID,
} from "@drawpane/model";
import { type TextSpan, textSpans } from "./rich-text";
import { decorationBar, type TextMeasurer } from "./text";

/** What drawing needs of a document: its nodes. */
interface NodeSource {
  get(id: string): NodeRecord | undefined;
  childIds(parent: string): readonly string[];
  readonly version: number;
}

/** A file's saved glyph outlines, by id. */
export interface GlyphTable {
  /** Changes whenever an outline may have. */
  readonly version: number;
  get(id: string): string | undefined;
}

const EMPTY_TABLE: GlyphTable = { version: 0, get: () => undefined };

interface CachedTable {
  readonly docVersion: number;
  /** The glyph sets' props it was built from. */
  readonly sets: readonly object[];
  readonly table: GlyphTable;
}
const tables = new WeakMap<object, CachedTable>();
let tableVersion = 0;

/** The glyph outlines `doc` holds (in its `glyphSet` nodes), kept until they change. */
export function glyphTable(doc: NodeSource): GlyphTable {
  const hit = tables.get(doc);
  if (hit && hit.docVersion === doc.version) return hit.table;
  const sets: NodeRecord[] = [];
  for (const id of doc.childIds(ROOT_ID)) {
    const node = doc.get(id);
    if (node?.type === "glyphSet") sets.push(node);
  }
  if (hit && hit.sets.length === sets.length && hit.sets.every((p, i) => p === sets[i]?.props)) {
    tables.set(doc, { ...hit, docVersion: doc.version });
    return hit.table;
  }
  let table = EMPTY_TABLE;
  if (sets.length > 0) {
    const byId = new Map<string, string>();
    for (const set of sets)
      for (const [id, d] of Object.entries(getProp(set.props, "glyphOutlines"))) byId.set(id, d);
    table = { version: ++tableVersion, get: (id) => byId.get(id) };
  }
  tables.set(doc, { docVersion: doc.version, sets: sets.map((s) => s.props), table });
  return table;
}

/** A text layer's saved glyphs, ready to draw: where they go in its box, and their outlines. */
export interface SavedText {
  readonly layout: GlyphLayout;
  /** Each ref's outline. */
  readonly outlines: readonly string[];
  /** Where the box Figma laid it out in sits in the layer's box now. */
  readonly dx: number;
  readonly dy: number;
}

interface CachedSaved {
  readonly generation: number;
  readonly table: number;
  readonly measurer: TextMeasurer;
  readonly saved: SavedText | null;
}
const savedCache = new WeakMap<object, CachedSaved>();
const keys = new WeakMap<object, string>();

const SAME = 0.01;

/** Whether some of the layer's text is set in a face nothing here draws (after aliases). */
function faceMissing(spans: readonly TextSpan[], measurer: TextMeasurer): boolean {
  const missing = measurer.missing;
  if (!missing) return false;
  return spans.some((span) =>
    missing.call(
      measurer,
      getProp(span.props, "fontFamily"),
      getProp(span.props, "fontSize"),
      getProp(span.props, "fontWeight"),
      getProp(span.props, "fontStyle") === "italic",
    ),
  );
}

/**
 * The saved glyphs a text layer is drawn from, or null when it's laid out
 * as usual: it has none, its fonts are all here, or they're stale (its text
 * or typography changed, a glyph is gone from the file, or its box changed
 * so that its lines would wrap differently).
 */
export function savedText(
  node: NodeRecord,
  measurer: TextMeasurer,
  table: GlyphTable,
): SavedText | null {
  if (node.type !== "text") return null;
  const layout = getProp(node.props, "glyphLayout");
  if (!layout || !measurer.missing) return null;
  const generation = measurer.generation ?? 0;
  const hit = savedCache.get(node.props);
  if (
    hit &&
    hit.generation === generation &&
    hit.table === table.version &&
    hit.measurer === measurer
  )
    return hit.saved;
  const saved = compute(node, layout, measurer, table);
  savedCache.set(node.props, { generation, table: table.version, measurer, saved });
  return saved;
}

function compute(
  node: NodeRecord,
  layout: GlyphLayout,
  measurer: TextMeasurer,
  table: GlyphTable,
): SavedText | null {
  const props = node.props;
  if (!faceMissing(textSpans(node), measurer)) return null;
  let key = keys.get(props);
  if (key === undefined) {
    key = glyphKey(props);
    keys.set(props, key);
  }
  if (key !== layout.key) return null;
  // The box: text that doesn't wrap keeps its lines whatever its width, placed by its
  // alignment; text that wraps was laid out for its width alone.
  const width = getProp(props, "width");
  const height = getProp(props, "height");
  let dx = 0;
  if (Math.abs(width - layout.w) > SAME) {
    if (getProp(props, "textAutoResize") !== "width") return null;
    const align = getProp(props, "textAlign");
    dx = align === "center" ? (width - layout.w) / 2 : align === "right" ? width - layout.w : 0;
  }
  let dy = 0;
  if (Math.abs(height - layout.h) > SAME) {
    const v = getProp(props, "textAlignVertical");
    dy = v === "middle" ? (height - layout.h) / 2 : v === "bottom" ? height - layout.h : 0;
  }
  const outlines: string[] = [];
  for (const ref of layout.refs) {
    const d = table.get(ref);
    if (d === undefined) return null;
    outlines.push(d);
  }
  return { layout, outlines, dx, dy };
}

/** A share of a layer's saved glyphs drawn in the same paints, as one path in its box. */
export interface SavedGlyphGroup {
  /** Its own fills (a run's), or null for the layer's. */
  readonly fills: readonly Paint[] | null;
  /** Its glyphs as SVG path data, in the layer's px. */
  readonly d: string;
  /** Underline and strikethrough bars, in the layer's px. */
  readonly bars: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
}

/** Groups by what they were made from (a layer's props make one SavedText). */
const groupsCache = new WeakMap<SavedText, SavedGlyphGroup[]>();

const num = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

/** An outline placed: scaled by `k` (px per unit), flipped up, its origin at (x, y). */
function placed(d: string, k: number, x: number, y: number, into: string[]): void {
  const re = /([MLQCZ])([^MLQCZ]*)/g;
  for (let m = re.exec(d); m !== null; m = re.exec(d)) {
    const letter = m[1] as string;
    const args = (m[2] as string).trim();
    if (!args) {
      into.push(letter);
      continue;
    }
    const values = args.split(" ");
    const out: string[] = [];
    for (let i = 0; i + 1 < values.length; i += 2)
      out.push(num(x + Number(values[i]) * k), num(y - Number(values[i + 1]) * k));
    into.push(letter + out.join(" "));
  }
}

/**
 * A layer's saved glyphs as paths, one for each set of paints they're drawn
 * in (the layer's, and each run's own), with their decorations. Baselines
 * fall on whole px from the box's top, as Figma draws them (see
 * `drawnBaseline`).
 */
export function savedGlyphGroups(saved: SavedText, node: NodeRecord): SavedGlyphGroup[] {
  const hit = groupsCache.get(saved);
  if (hit) return hit;
  const { layout, outlines, dx, dy } = saved;
  const spans = textSpans(node);
  const spanAt = (i: number) => {
    let lo = 0;
    let hi = spans.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((spans[mid] as TextSpan).start <= i) lo = mid;
      else hi = mid - 1;
    }
    return spans[lo] as TextSpan;
  };
  const groups = new Map<
    readonly Paint[] | null,
    { parts: string[]; bars: Array<{ x: number; y: number; w: number; h: number }> }
  >();
  const count = layout.g.length / 3;
  for (let i = 0; i < count; i++) {
    const d = outlines[layout.g[i * 3] as number] as string;
    const x = (layout.g[i * 3 + 1] as number) + dx;
    const y = Math.round((layout.g[i * 3 + 2] as number) + dy);
    const size = layout.s?.[i] ?? layout.size;
    const span = spanAt(layout.c?.[i] ?? i);
    const fills = span.own.fills ?? null;
    let group = groups.get(fills);
    if (!group) {
      group = { parts: [], bars: [] };
      groups.set(fills, group);
    }
    if (d) placed(d, size / GLYPH_UNITS, x, y, group.parts);
    const decoration = getProp(span.props, "textDecoration");
    const advance = layout.a?.[i];
    if (decoration !== "none" && advance !== undefined && advance > 0) {
      const bar = decorationBar(decoration, y, size);
      const last = group.bars[group.bars.length - 1];
      if (last && Math.abs(last.x + last.w - x) < SAME && last.y === bar.y && last.h === bar.height)
        last.w += advance;
      else group.bars.push({ x, y: bar.y, w: advance, h: bar.height });
    }
  }
  const out = [...groups].map(([fills, g]) => ({ fills, d: g.parts.join(""), bars: g.bars }));
  groupsCache.set(saved, out);
  return out;
}
