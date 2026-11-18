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

/** Every face the file's text and text styles are set in, most used first. */
export function fontUsage(doc: Doc): FontUse[] {
  const uses = new Map<
    string,
    { face: TextFace; layers: Set<string>; styles: Set<string>; sizes: Set<number> }
  >();
  const note = (face: TextFace, size: number, layer: string | null, style: string | null) => {
    const key = fontFaceKey(face);
    let use = uses.get(key);
    if (!use) {
      use = { face, layers: new Set(), styles: new Set(), sizes: new Set() };
      uses.set(key, use);
    }
    if (layer) use.layers.add(layer);
    if (style) use.styles.add(style);
    use.sizes.add(size);
  };
  for (const node of doc.nodes()) {
    if (node.type === "textStyle") {
      note(faceOf(node.props), getProp(node.props, "fontSize"), null, node.id);
      continue;
    }
    if (node.type !== "text") continue;
    const base = faceOf(node.props);
    const size = getProp(node.props, "fontSize");
    const runs = layerRuns(node);
    // The layer's own face shows wherever no run sets another (all of it, without runs).
    let covered = 0;
    for (const run of runs)
      if (setsFace(run) || run.fontSize !== undefined) covered += run.end - run.start;
    if (runs.length === 0 || covered < getProp(node.props, "characters").length)
      note(base, size, node.id, null);
    for (const run of runs) note(runFace(base, run), run.fontSize ?? size, node.id, null);
  }
  return [...uses.values()]
    .map(
      (u): FontUse => ({
        ...u.face,
        layers: [...u.layers],
        styles: [...u.styles],
        sizes: [...u.sizes].sort((a, b) => a - b),
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
