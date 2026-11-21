/**
 * The fonts a file uses, and swapping them across the whole file in one
 * change: what the missing fonts panel shows and does (decision 0036), as in
 * Figma's "Replace fonts".
 *
 * A face is a family, weight and style. Every text layer's own face counts,
 * and its runs' (a bold word, a phrase in another family); a layer counts
 * once for each face in it. Text styles count too, and swapping a face
 * rewrites the styles set in it, which their layers then follow. Copies
 * inside instances follow their mains unless they set the face themselves;
 * a team library's copies are left as the library published them.
 */
import { getProp, type NodeRecord, type Op, type Props, type TextRun } from "@drawpane/model";
import type { Doc } from "./doc";
import { isLibraryCopy } from "./libraries";
import { layerRuns, type TextFace } from "./rich-text";

/** A face the file uses, and where. */
export interface FontUse extends TextFace {
  /** Text layers set in it, each once (in its own face or a run's). */
  readonly layers: readonly string[];
  /** Text styles set in it. */
  readonly styles: readonly string[];
  /** The sizes it's set at, ascending: an alias may draw each in another family. */
  readonly sizes: readonly number[];
}

export const fontFaceKey = (f: TextFace): string =>
  `${f.family}\u0000${f.weight}\u0000${f.italic ? "i" : "n"}`;

const faceOf = (props: Props): TextFace => ({
  family: getProp(props, "fontFamily"),
  weight: getProp(props, "fontWeight"),
  italic: getProp(props, "fontStyle") === "italic",
});

/** A run's face: its own overrides over the layer's. */
const runFace = (base: TextFace, run: TextRun): TextFace => ({
  family: run.fontFamily ?? base.family,
  weight: run.fontWeight ?? base.weight,
  italic: run.fontStyle !== undefined ? run.fontStyle === "italic" : base.italic,
});

const setsFace = (run: TextRun) =>
  run.fontFamily !== undefined || run.fontWeight !== undefined || run.fontStyle !== undefined;

/** The faces one text layer or text style is set in, each with the sizes it's set at there. */
function facesOf(node: NodeRecord): Map<string, { face: TextFace; sizes: number[] }> | null {
  const out = new Map<string, { face: TextFace; sizes: number[] }>();
  const note = (face: TextFace, size: number) => {
    const key = fontFaceKey(face);
    const use = out.get(key);
    if (use) use.sizes.push(size);
    else out.set(key, { face, sizes: [size] });
  };
  if (node.type === "textStyle") {
    note(faceOf(node.props), getProp(node.props, "fontSize"));
    return out;
  }
  if (node.type !== "text") return null;
  const base = faceOf(node.props);
  const size = getProp(node.props, "fontSize");
  const runs = layerRuns(node);
  // The layer's own face shows wherever no run sets another (all of it, without runs).
  let covered = 0;
  for (const run of runs)
    if (setsFace(run) || run.fontSize !== undefined) covered += run.end - run.start;
  if (runs.length === 0 || covered < getProp(node.props, "characters").length) note(base, size);
  for (const run of runs) note(runFace(base, run), run.fontSize ?? size);
  return out;
}

interface Use {
  readonly face: TextFace;
  readonly layers: Set<string>;
  readonly styles: Set<string>;
  /** Each size, with how many layers and styles set it there. */
  readonly sizes: Map<number, number>;
}

/**
 * The faces a file uses, kept up with its changes: each change reads only
 * the layers it names (`Doc.changesSince`), not the whole file, so a
 * 500k-layer kit's font report stays cheap to keep. A reset, or more
 * changes than the document keeps, reads the file again.
 */
export class FontUsageIndex {
  readonly #doc: Doc;
  #version = -1;
  /** Each text layer's and text style's faces, by face key, with their sizes. */
  readonly #faces = new Map<string, Map<string, { face: TextFace; sizes: number[] }>>();
  readonly #uses = new Map<string, Use>();

  constructor(doc: Doc) {
    this.#doc = doc;
  }

  /** Every face the file's text and text styles are set in, most used first (see `fontUsage`). */
  usage(): FontUse[] {
    this.#sync();
    return [...this.#uses.values()]
      .filter((u) => u.layers.size > 0 || u.styles.size > 0)
      .map(
        (u): FontUse => ({
          ...u.face,
          layers: [...u.layers],
          styles: [...u.styles],
          sizes: [...u.sizes.keys()].sort((a, b) => a - b),
        }),
      )
      .sort(
        (a, b) =>
          b.layers.length - a.layers.length ||
          a.family.localeCompare(b.family) ||
          a.weight - b.weight ||
          Number(a.italic) - Number(b.italic),
      );
  }

  #sync(): void {
    const version = this.#doc.version;
    if (version === this.#version) return;
    const changes = this.#version < 0 ? null : this.#doc.changesSince(this.#version);
    if (!changes || changes.some((c) => c.reset)) {
      this.#faces.clear();
      this.#uses.clear();
      for (const node of this.#doc.nodes()) this.#add(node);
    } else {
      const ids = new Set<string>();
      for (const change of changes) for (const id of change.ids) ids.add(id);
      for (const id of ids) {
        this.#remove(id);
        const node = this.#doc.get(id);
        if (node) this.#add(node);
      }
    }
    this.#version = version;
  }

  #add(node: NodeRecord): void {
    const faces = facesOf(node);
    if (!faces) return;
    this.#faces.set(node.id, faces);
    const style = node.type === "textStyle";
    for (const [key, { face, sizes }] of faces) {
      let use = this.#uses.get(key);
      if (!use) {
        use = { face, layers: new Set(), styles: new Set(), sizes: new Map() };
        this.#uses.set(key, use);
      }
      (style ? use.styles : use.layers).add(node.id);
      for (const size of sizes) use.sizes.set(size, (use.sizes.get(size) ?? 0) + 1);
    }
  }

  #remove(id: string): void {
    const faces = this.#faces.get(id);
    if (!faces) return;
    this.#faces.delete(id);
    for (const [key, { sizes }] of faces) {
      const use = this.#uses.get(key);
      if (!use) continue;
      use.layers.delete(id);
      use.styles.delete(id);
      for (const size of sizes) {
        const left = (use.sizes.get(size) ?? 0) - 1;
        if (left > 0) use.sizes.set(size, left);
        else use.sizes.delete(size);
      }
      if (use.layers.size === 0 && use.styles.size === 0) this.#uses.delete(key);
    }
  }
}

/** Every face the file's text and text styles are set in, most used first. */
export function fontUsage(doc: Doc): FontUse[] {
  return new FontUsageIndex(doc).usage();
}

/** Replacements by the face they replace (`fontFaceKey`). */
export type FontReplacements = ReadonlyMap<string, TextFace>;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The writes that set a face on a layer or style (defaults stored as absent). */
function faceOps(id: string, from: TextFace, to: TextFace): Op[] {
  const ops: Op[] = [];
  if (to.family !== from.family) ops.push({ op: "set", id, prop: "fontFamily", value: to.family });
  if (to.weight !== from.weight)
    ops.push({ op: "set", id, prop: "fontWeight", value: to.weight === 400 ? null : to.weight });
  if (to.italic !== from.italic)
    ops.push({ op: "set", id, prop: "fontStyle", value: to.italic ? "italic" : null });
  return ops;
}

/**
 * The writes that swap faces across the file: text styles, then layers'
 * own faces and their runs'. Commit them as one change (one undo step).
 */
export function replaceFontOps(doc: Doc, replacements: FontReplacements): Op[] {
  if (replacements.size === 0) return [];
  const swap = (face: TextFace) => replacements.get(fontFaceKey(face)) ?? null;
  const ops: Op[] = [];
  const restyled = new Set<string>();
  for (const node of doc.nodes()) {
    if (node.type !== "textStyle" || isLibraryCopy(doc, node.id)) continue;
    const face = faceOf(node.props);
    const to = swap(face);
    if (!to) continue;
    ops.push(...faceOps(node.id, face, to));
    restyled.add(node.id);
  }
  for (const node of doc.nodes()) {
    if (node.type !== "text" || isLibraryCopy(doc, node.id)) continue;
    if (followsMain(doc, node)) continue;
    const base = faceOf(node.props);
    const style = getProp(node.props, "textStyle");
    // A layer following a restyled style follows it there (and keeps following).
    const to = style && restyled.has(style) ? null : swap(base);
    if (to) ops.push(...faceOps(node.id, base, to));
    const newBase = to ?? (style && restyled.has(style) ? (swap(base) ?? base) : base);
    const runs = getProp(node.props, "textRuns");
    if (runs.length === 0) continue;
    let changed = false;
    const next = runs.map((run) => {
      if (!setsFace(run)) return run;
      const face = runFace(base, run);
      const into = swap(face) ?? face;
      // What the run must say for its text to be in `into`, over the layer's new face.
      const out: TextRun = { ...run };
      delete (out as { fontFamily?: string }).fontFamily;
      delete (out as { fontWeight?: number }).fontWeight;
      delete (out as { fontStyle?: string }).fontStyle;
      const written = {
        ...out,
        ...(into.family !== newBase.family ? { fontFamily: into.family } : {}),
        ...(into.weight !== newBase.weight ? { fontWeight: into.weight } : {}),
        ...(into.italic !== newBase.italic
          ? { fontStyle: into.italic ? ("italic" as const) : ("normal" as const) }
          : {}),
      } as TextRun;
      if (!same(written, run)) changed = true;
      return written;
    });
    if (changed) ops.push({ op: "set", id: node.id, prop: "textRuns", value: next });
  }
  return ops;
}

/** A copy inside an instance whose type is its main's: rewriting the main rewrites it. */
function followsMain(doc: Doc, node: NodeRecord): boolean {
  const mirrors = getProp(node.props, "mirrors");
  if (!mirrors) return false;
  const main = doc.get(mirrors);
  if (main?.type !== "text") return false;
  return (["fontFamily", "fontWeight", "fontStyle", "textRuns"] as const).every((p) =>
    same(getProp(node.props, p), getProp(main.props, p)),
  );
}
