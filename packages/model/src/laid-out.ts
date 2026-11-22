/**
 * Which of a copy's values layout decides (decision 0035, item 7). Those are
 * never overrides: a copy laid out differently from its main holds other
 * values for them, and its next layout gives them again. Sync leaves them
 * alone, and the importers don't mark them overridden. A place or size
 * constraints give is laid out only while it's what they derive.
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
  if (
    copy.type === "text" &&
    !context.root &&
    !inFlow &&
    (parent?.type === "frame" || parent?.type === "group")
  ) {
    // Constraints that stretch or scale a text layer take that axis's size from it (decision
    // 0043): its main layer's auto-resize is laid out, and so is the one they give where its
    // frame differs in size from its main's (in a group, the group's constraints decide).
    const mode = getProp(copy.props, "textAutoResize");
    const own = getProp(source.props, "textAutoResize");
    const given =
      parent?.type === "group"
        ? sizedAxes(parent).size > 0
          ? textResizeWhenSized(own, sizedAxes(parent))
          : own
        : constrainedTextResize(copy, source, parent, parentSource);
    if (mode === own || mode === given) out.add("textAutoResize");
  }
  if (!context.root && !inFlow && parent && parentSource) {
    // A frame the copy resized moved and stretched its children by their constraints: a place or
    // size is laid out where it's what they derive from the main layer's. Anything else is a
    // person's change on top (review 8 of #187, B1), kept as an override.
    const derived = constrainedValues(copy, source, parent, parentSource);
    for (const [prop, want] of Object.entries(derived)) {
      const have = (copy.props as Record<string, unknown>)[prop];
      if (typeof have === "number" && Math.abs(have - want) <= EPSILON) out.add(prop);
    }
  }
  return out;
}

/** The axes a layer's constraints stretch or scale it on, so its frame's size sets its size. */
function sizedAxes(node: NodeRecord): Set<"h" | "v"> {
  const out = new Set<"h" | "v">();
  for (const [axis, prop] of [
    ["h", "constraintH"],
    ["v", "constraintV"],
  ] as const) {
    const c = getProp(node.props, prop);
    if (c === "stretch" || c === "scale") out.add(axis);
  }
  return out;
}

/**
 * A text layer's auto-resize once something else sizes it on `axes` (auto
 * layout's Fill or stretch, a constraint), as Figma has it: auto width
 * becomes auto height when its width is taken, and any auto size becomes
 * fixed when its height is (decision 0043).
 */
export function textResizeWhenSized(
  mode: "none" | "width" | "height",
  axes: ReadonlySet<"h" | "v">,
): "none" | "width" | "height" {
  if (axes.has("v") && mode !== "none") return "none";
  if (axes.has("h") && mode === "width") return "height";
  return mode;
}

/**
 * The auto-resize a copy text layer's constraints give it, from the main
 * layer it copies, where they size it (its frame differs in size from its
 * main's on an axis it stretches or scales on): undefined where they don't.
 */
export function constrainedTextResize(
  copy: NodeRecord,
  source: NodeRecord,
  parent: NodeRecord | undefined,
  parentSource: NodeRecord | undefined,
): "none" | "width" | "height" | undefined {
  if (copy.type !== "text") return undefined;
  const derived = constrainedValues(copy, source, parent, parentSource);
  const axes = new Set<"h" | "v">();
  if (derived.width !== undefined) axes.add("h");
  if (derived.height !== undefined) axes.add("v");
  if (axes.size === 0) return undefined;
  return textResizeWhenSized(getProp(source.props, "textAutoResize"), axes);
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
 * an axis pinned to the start (or a frame of the same size) gives none, and
 * an axis the layer's own auto layout hugs on gives no size.
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
    // A frame whose auto layout hugs on this axis is sized by that layout, not its constraints.
    const hugs =
      copy.type === "frame" &&
      getProp(copy.props, "layoutMode") !== "none" &&
      getProp(copy.props, axis.sizing) === "hug";
    if ((c === "stretch" || c === "scale") && !hugs) out[axis.size] = round2(span.size);
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
