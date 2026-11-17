/**
 * Which of a copy's values layout decides (decision 0035, item 7). Those are
 * never overrides: a copy laid out differently from its main holds other
 * values for them, and its next layout gives them again. Sync leaves them
 * alone, and the importers don't mark them overridden.
 */
import type { NodeRecord } from "./ops";
import { getProp } from "./schema";

/** Where a copy sits: the copy's parent, and the parent of the main layer it copies. */
export interface LaidOutContext {
  /** An instance root (or a nested instance swapped for another main, laid out as one). */
  readonly root: boolean;
  /** The copy's parent, as presented. */
  readonly parent?: NodeRecord | undefined;
  /** The parent of the main layer the copy copies. */
  readonly parentSource?: NodeRecord | undefined;
}

const AXES = [
  { sizing: "sizingH", size: "width", pos: "x", constraint: "constraintH" },
  { sizing: "sizingV", size: "height", pos: "y", constraint: "constraintV" },
] as const;

/** Sizes closer than this are the same (Figma saves sizes to a few decimals). */
const EPSILON = 0.01;

/** The properties of `copy` that layout decides, given `source`, the main layer it copies. */
export function laidOutProps(
  copy: NodeRecord,
  source: NodeRecord,
  context: LaidOutContext,
): Set<string> {
  const out = new Set<string>();
  const { parent, parentSource } = context;
  if (context.root) {
    // Where an instance sits is its own; so is filling its parent, which is how it sits there.
    out.add("x");
    out.add("y");
    for (const axis of AXES)
      if (
        getProp(copy.props, axis.sizing) === "fill" ||
        getProp(source.props, axis.sizing) === "fill"
      ) {
        out.add(axis.sizing);
        out.add(axis.size);
      }
  }
  const inFlow =
    !context.root &&
    parent?.type === "frame" &&
    getProp(parent.props, "layoutMode") !== "none" &&
    getProp(copy.props, "positioning") === "auto";
  if (inFlow) {
    // Auto layout places its children, and sizes the ones that hug or fill.
    out.add("x");
    out.add("y");
    for (const axis of AXES)
      if (
        getProp(source.props, axis.sizing) !== "fixed" ||
        getProp(copy.props, axis.sizing) !== "fixed"
      )
        out.add(axis.size);
  }
  for (const axis of AXES)
    if (getProp(source.props, axis.sizing) === "hug" || getProp(copy.props, axis.sizing) === "hug")
      out.add(axis.size);
  if (copy.type === "text") {
    // Auto-sized text measures itself in the copy.
    for (const resize of [
      getProp(source.props, "textAutoResize"),
      getProp(copy.props, "textAutoResize"),
    ]) {
      if (resize === "width") out.add("width");
      if (resize !== "none") out.add("height");
    }
  }
  if (!context.root && !inFlow && parent && parentSource) {
    // A frame the copy resized moved and stretched its children by their constraints.
    for (const axis of AXES) {
      const grown =
        Math.abs(getProp(parent.props, axis.size) - getProp(parentSource.props, axis.size)) >
        EPSILON;
      if (!grown) continue;
      const constraint = getProp(copy.props, axis.constraint);
      if (constraint === "end" || constraint === "center") out.add(axis.pos);
      if (constraint === "stretch" || constraint === "scale") {
        out.add(axis.pos);
        out.add(axis.size);
      }
    }
  }
  return out;
}
