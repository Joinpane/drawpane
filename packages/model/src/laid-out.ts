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

/** Whether a frame's own auto layout sizes it on an axis (it hugs there), so constraints only place it. */
export function hugsOn(node: NodeRecord, axis: "h" | "v"): boolean {
  return (
    node.type === "frame" &&
    getProp(node.props, "layoutMode") !== "none" &&
    getProp(node.props, axis === "h" ? "sizingH" : "sizingV") === "hug"
  );
}

/**
 * Whether a text layer sizes itself on an axis: auto width on both, auto
 * height on its height. In an instance, Figma's constraints place such a
 * copy but never size it there, and never switch its mode (decision 0043).
 */
export function measuresOn(node: NodeRecord, axis: "h" | "v"): boolean {
  if (node.type !== "text") return false;
  const mode = getProp(node.props, "textAutoResize");
  return mode === "width" || (mode === "height" && axis === "v");
}

/**
 * Where a span pinned by `c` starts when it keeps its size (its own auto
 * layout hugs it) and its frame goes from `from` to `to`, as Figma places it:
 * stretched, it's centred in the span stretching would give it (past its
 * margins, moved by half the change plus its size); scaled, its centre
 * scales.
 */
export function constrainHugged(
  c: Constraint,
  pos: number,
  size: number,
  from: number,
  to: number,
): number {
  const delta = to - from;
  switch (c) {
    case "start":
      return pos;
    case "end":
      return pos + delta;
    case "center":
      return pos + delta / 2;
    case "stretch":
      // Past its margins (no span left), Figma keeps it where it was at exactly zero room and
      // moves it by half the change plus its size beyond that.
      return size + delta > 0 ? pos + delta / 2 : size + delta === 0 ? pos : pos + delta / 2 + size;
    case "scale":
      return from <= 0 ? pos : (pos + size / 2) * (to / from) - size / 2;
  }
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
 * an axis the layer sizes itself on (its auto layout hugs, or its text
 * measures itself) gives a place but no size.
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
    const pos = getProp(source.props, axis.pos);
    const size = getProp(source.props, axis.size);
    const a = axis.size === "width" ? "h" : "v";
    // A frame whose auto layout hugs on this axis keeps its size, placed as Figma places it.
    if (hugsOn(copy, a)) {
      out[axis.pos] = round2(constrainHugged(c, pos, size, from, to));
      continue;
    }
    const span = constrainSpan(c, pos, size, from, to);
    out[axis.pos] = round2(span.pos);
    // Text that sizes itself on this axis keeps doing so.
    if ((c === "stretch" || c === "scale") && !measuresOn(copy, a))
      out[axis.size] = round2(span.size);
  }
  return out;
}

type Box = "x" | "y" | "width" | "height";

/**
 * Why a copy keeps a value of its own instead of the one derived from its
 * main layer: its own layout decides it ("layout": it hugs, its text
 * measures itself, it's bound to a variable), or it's the copy's own
 * ("own": overridden, a swapped instance's size, a layer whose frame took
 * its auto layout away). An own value still follows its constraints from
 * where it is when its frame resizes; a laid-out one isn't touched.
 */
export type Kept = "layout" | "own";

/** A copy layer's placed geometry: what's derived from its main layer, and what it keeps. */
export interface Placed {
  readonly derived: Partial<Record<Box, number>>;
  readonly kept: Partial<Record<Box, Kept>>;
}

/**
 * Everything `placedGeometry` reads, on a copy, its main layer and their
 * frames. A change to any of these can move or resize a copy, so this is
 * what decides when copies are placed again (not a list kept by hand).
 */
export const PLACED_INPUTS: ReadonlySet<string> = new Set([
  "x",
  "y",
  "width",
  "height",
  "constraintH",
  "constraintV",
  "sizingH",
  "sizingV",
  "layoutMode",
  "positioning",
  "textAutoResize",
  "instanceOf",
  "overrides",
  "bindings",
]);

/**
 * Where a copy layer sits and how big it is, from the main layer it copies
 * (decisions 0035, item 7, and 0043): the one derivation both copy formats
 * use. Materialized sync writes it, compact copies store it where their
 * frame differs from its main's, the constraint pass places copies by it,
 * and the edit-layout oracle checks both formats against it.
 *
 * Placed freely in a frame, each of its place and size is either derived
 * (its constraints' value where its frame differs in size from its main's,
 * its main layer's otherwise) or kept (`Kept`). Undefined where nothing
 * here places it: an instance root, a layer in a group or outside a frame,
 * or one its frame's auto layout places.
 */
export function placedGeometry(
  copy: NodeRecord,
  source: NodeRecord,
  parent: NodeRecord | undefined,
  parentSource: NodeRecord | undefined,
): Placed | undefined {
  if (!parent || !parentSource || parent.type !== "frame" || copy.type === "group")
    return undefined;
  if (getProp(copy.props, "instanceOf") && !getProp(copy.props, "mirrors")) return undefined;
  const absolute = getProp(copy.props, "positioning") === "absolute";
  if (getProp(parent.props, "layoutMode") !== "none" && !absolute) return undefined;
  const constrained = constrainedValues(copy, source, parent, parentSource);
  const overrides = getProp(copy.props, "overrides");
  const bound = getProp(copy.props, "bindings") as Record<string, unknown>;
  // Placed by its own choice: made absolute (or not) unlike its main layer, or in a frame that took
  // its auto layout away, which leaves its layers where the layout put them (Figma).
  const ownPlace =
    getProp(copy.props, "positioning") !== getProp(source.props, "positioning") ||
    (!absolute &&
      (getProp(parentSource.props, "layoutMode") !== "none" ||
        getProp(parent.props, "overrides").includes("layoutMode")));
  // A nested instance swapped for another component is that component's size.
  const shown = getProp(copy.props, "instanceOf");
  const swapped = !!shown && shown !== getProp(source.props, "instanceOf");
  const derived: Partial<Record<Box, number>> = {};
  const kept: Partial<Record<Box, Kept>> = {};
  for (const axis of AXES) {
    const a = axis.size === "width" ? "h" : "v";
    if (bound[axis.pos]) kept[axis.pos] = "layout";
    else if (overrides.includes(axis.pos) || ownPlace) kept[axis.pos] = "own";
    else derived[axis.pos] = constrained[axis.pos] ?? getProp(source.props, axis.pos);
    if (bound[axis.size] || hugsOn(copy, a) || measuresOn(copy, a)) kept[axis.size] = "layout";
    else if (
      overrides.includes(axis.size) ||
      overrides.includes(axis.sizing) ||
      swapped ||
      ownPlace
    )
      kept[axis.size] = "own";
    else derived[axis.size] = constrained[axis.size] ?? getProp(source.props, axis.size);
  }
  return { derived, kept };
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
