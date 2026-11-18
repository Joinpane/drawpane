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

/** How a layer follows its frame on one axis (Figma's and Penpot's constraints). */
export type Constraint = "start" | "end" | "center" | "stretch" | "scale";

/** The new start and size of a span pinned by `c` when its frame grows from `from` to `to`. */
export function constrainSpan(
  c: Constraint,
  pos: number,
  size: number,
  from: number,
  to: number,
): { pos: number; size: number } {
  const delta = to - from;
  switch (c) {
    case "start":
      return { pos, size };
    case "end":
      return { pos: pos + delta, size };
    case "center":
      return { pos: pos + delta / 2, size };
    case "stretch":
      // Keep both margins; a frame smaller than the margins leaves the layer at zero size.
      return { pos, size: Math.max(0, size + delta) };
    case "scale": {
      if (from <= 0) return { pos, size };
      const k = to / from;
      return { pos: pos * k, size: size * k };
    }
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The place and size a copy layer's constraints give it, derived from the
 * main layer it copies (decision 0035, item 7): where a copy frame without
 * auto layout differs in size from its main's, a child pinned to the end or
 * centre, stretched or scaled sits where its main layer does, moved by the
 * difference. Only the values that differ from the main layer's are given;
 * an axis pinned to the start (or a frame of the same size) gives none.
 */
export function constrainedValues(
  copy: NodeRecord,
  source: NodeRecord,
  parent: NodeRecord | undefined,
  parentSource: NodeRecord | undefined,
): Partial<Record<"x" | "y" | "width" | "height", number>> {
  const out: Partial<Record<"x" | "y" | "width" | "height", number>> = {};
  if (!parent || !parentSource || parent.type !== "frame" || copy.type === "group") return out;
  // Auto layout places its children itself.
  if (
    getProp(parent.props, "layoutMode") !== "none" &&
    getProp(copy.props, "positioning") !== "absolute"
  )
    return out;
  for (const axis of AXES) {
    const from = getProp(parentSource.props, axis.size);
    const to = getProp(parent.props, axis.size);
    if (Math.abs(to - from) <= EPSILON) continue;
    const c = getProp(copy.props, axis.constraint) as Constraint;
    if (c === "start") continue;
    const span = constrainSpan(
      c,
      getProp(source.props, axis.pos),
      getProp(source.props, axis.size),
      from,
      to,
    );
    out[axis.pos] = round2(span.pos);
    if (c === "stretch" || c === "scale") out[axis.size] = round2(span.size);
  }
  return out;
}

/**
 * What a nested instance swapped for another component keeps from the main
 * layer it copies, rather than taking the swapped-in component's (decision
 * 0035, item 3): the fields the outer component's properties drive (its
 * visibility, say), but not which component it is, which is the swap.
 */
export function boundaryDrivenProps(source: NodeRecord): string[] {
  const out: string[] = [];
  for (const [field, id] of Object.entries(getProp(source.props, "propRefs")))
    if (id && field !== "instanceOf" && field !== "slot") out.push(field);
  return out;
}
