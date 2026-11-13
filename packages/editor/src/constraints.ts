/**
 * Constraints: how a layer follows its frame when the frame is resized.
 *
 * Each layer pins each axis to the frame's start, end, centre, both edges
 * (stretch) or scales with it, like Figma and Penpot. They apply to children
 * a frame places freely: every child of a frame without auto layout, and the
 * absolutely positioned children of one with it. The fix-up runs inside the
 * commit, so resizing by handle, inspector, command bar or a preset all
 * follow it, and undo restores children with their frame in one step.
 */
import { getProp, type NodeRecord, type Op } from "@drawpane/model";
import type { Doc } from "./doc";
import { round2 } from "./geometry";

type Axis = "h" | "v";
type Constraint = "start" | "end" | "center" | "stretch" | "scale";

interface Resize {
  readonly id: string;
  readonly from: { readonly width: number; readonly height: number };
  readonly to: { readonly width: number; readonly height: number };
}

const AXIS = {
  h: { pos: "x", size: "width", constraint: "constraintH" },
  v: { pos: "y", size: "height", constraint: "constraintV" },
} as const;

/** Whether the frame places this child itself (auto layout) rather than leaving it where it is. */
function placedByLayout(frame: NodeRecord, child: NodeRecord): boolean {
  return (
    getProp(frame.props, "layoutMode") !== "none" &&
    getProp(child.props, "positioning") !== "absolute"
  );
}

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

/**
 * Fix-up operations that move and size the children of every frame `ops`
 * resizes, by their constraints, before `ops` are applied (the document still
 * has the old sizes). Children the same batch already positions or sizes on an
 * axis keep what the batch says, which keeps undo and multi-layer resizes exact.
 */
export function constraintOps(doc: Doc, ops: readonly Op[]): Op[] {
  const explicit = new Map<string, Set<string>>();
  const created = new Set<string>();
  const sizes = new Map<string, { width?: number; height?: number }>();
  for (const op of ops) {
    if (op.op === "create") created.add(op.id);
    if (op.op !== "set") continue;
    const props = explicit.get(op.id) ?? new Set<string>();
    explicit.set(op.id, props);
    props.add(op.prop);
    if ((op.prop === "width" || op.prop === "height") && typeof op.value === "number") {
      const entry = sizes.get(op.id) ?? {};
      entry[op.prop] = op.value;
      sizes.set(op.id, entry);
    }
  }

  const work: Resize[] = [];
  for (const [id, size] of sizes) {
    const node = doc.get(id);
    if (node?.type !== "frame" || created.has(id)) continue;
    const from = { width: getProp(node.props, "width"), height: getProp(node.props, "height") };
    const to = { width: size.width ?? from.width, height: size.height ?? from.height };
    if (from.width !== to.width || from.height !== to.height) work.push({ id, from, to });
  }
  if (work.length === 0) return [];

  /** Pending values, so a node moved twice (nested frames) composes. */
  const next = new Map<string, Map<"x" | "y" | "width" | "height", number>>();
  const read = (node: NodeRecord, prop: "x" | "y" | "width" | "height"): number =>
    next.get(node.id)?.get(prop) ?? getProp(node.props, prop);
  const write = (node: NodeRecord, prop: "x" | "y" | "width" | "height", value: number) => {
    const props = next.get(node.id) ?? new Map<"x" | "y" | "width" | "height", number>();
    next.set(node.id, props);
    props.set(prop, round2(value));
  };
  const keeps = (id: string, axis: Axis) => {
    const props = explicit.get(id);
    return !!props && (props.has(AXIS[axis].pos) || props.has(AXIS[axis].size));
  };

  for (let i = 0; i < work.length; i++) {
    const resize = work[i] as Resize;
    const frame = doc.get(resize.id);
    if (!frame) continue;
    for (const childId of doc.childIds(frame.id)) {
      const child = doc.get(childId);
      if (!child || created.has(childId) || placedByLayout(frame, child)) continue;
      const before = { width: read(child, "width"), height: read(child, "height") };
      for (const axis of ["h", "v"] as const) {
        const { pos, size, constraint } = AXIS[axis];
        const from = resize.from[size];
        const to = resize.to[size];
        if (from === to || keeps(childId, axis)) continue;
        const c = getProp(child.props, constraint);
        if (c === "start") continue;
        if (child.type === "group") constrainGroup(doc, child, axis, c, from, to, read, write);
        else {
          const span = constrainSpan(c, read(child, pos), read(child, size), from, to);
          write(child, pos, span.pos);
          write(child, size, span.size);
        }
      }
      // A nested frame that changed size passes the change on to its own children.
      if (child.type === "frame") {
        const after = { width: read(child, "width"), height: read(child, "height") };
        if (after.width !== before.width || after.height !== before.height)
          work.push({ id: child.id, from: before, to: after });
      }
    }
  }

  const out: Op[] = [];
  for (const [id, props] of next) {
    const node = doc.get(id);
    if (!node) continue;
    for (const [prop, value] of props) {
      if (value !== round2(getProp(node.props, prop))) out.push({ op: "set", id, prop, value });
    }
  }
  return out;
}

/** The layers a group's geometry is made of, in its frame's space (nested frames count as one). */
function groupMembers(doc: Doc, group: NodeRecord): NodeRecord[] {
  const out: NodeRecord[] = [];
  const walk = (id: string) => {
    for (const childId of doc.childIds(id)) {
      const child = doc.get(childId);
      if (!child) continue;
      if (child.type === "group") walk(childId);
      else out.push(child);
    }
  };
  walk(group.id);
  return out;
}

/**
 * Groups have no geometry of their own: pinning moves every member together,
 * and stretching or scaling scales them inside the group's bounds.
 */
function constrainGroup(
  doc: Doc,
  group: NodeRecord,
  axis: Axis,
  c: Constraint,
  from: number,
  to: number,
  read: (node: NodeRecord, prop: "x" | "y" | "width" | "height") => number,
  write: (node: NodeRecord, prop: "x" | "y" | "width" | "height", value: number) => void,
): void {
  const { pos, size } = AXIS[axis];
  const members = groupMembers(doc, group);
  if (members.length === 0) return;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const m of members) {
    start = Math.min(start, read(m, pos));
    end = Math.max(end, read(m, pos) + read(m, size));
  }
  const span = constrainSpan(c, start, end - start, from, to);
  const k = end - start > 0 ? span.size / (end - start) : 1;
  for (const m of members) {
    write(m, pos, span.pos + (read(m, pos) - start) * k);
    if (k !== 1) write(m, size, read(m, size) * k);
  }
}
