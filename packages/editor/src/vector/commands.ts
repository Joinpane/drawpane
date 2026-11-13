/**
 * Vector commands on the editor: flatten, booleans and anchor edits. Editor
 * methods delegate here so editor.ts stays a thin command surface.
 */
import {
  getProp,
  keyBetween,
  type NodeRecord,
  newId,
  type Op,
  type PropName,
  type Props,
  propAllowed,
  ROOT_ID,
} from "@drawpane/model";
import type { Editor } from "../editor";
import { invert, multiply } from "../geometry";
import { BOOLEAN_LABELS, type BooleanOp, type BooleanOperand } from "./boolean";
import { fitPath, transformPath } from "./bounds";
import { parsePathCached } from "./cache";
import { deleteAnchors, moveAnchors, toggleSmooth, validKeys } from "./edit";
import { fitToNode, round3, setPathOps } from "./node";
import { parseAnchorKey, type VectorPath } from "./path";
import { isConvertible, nodePath } from "./shapes";
import { parsePath, serializePath } from "./svg";

/** Look properties a boolean result takes from the bottom-most operand. */
const STYLE_PROPS: readonly PropName[] = [
  "fills",
  "strokes",
  "strokeWeight",
  "strokeAlign",
  "strokeCap",
  "strokeJoin",
  "strokeDashes",
  "effects",
  "opacity",
  "blendMode",
];

/** Ids in document z-order, bottom first. */
export function zOrdered(editor: Editor, ids: readonly string[]): string[] {
  const order = new Map<string, number>();
  let i = 0;
  const walk = (parent: string) => {
    for (const id of editor.doc.childIds(parent)) {
      order.set(id, i++);
      walk(id);
    }
  };
  walk(ROOT_ID);
  return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** Drops ids whose ancestor is also in the list. */
function topmost(editor: Editor, ids: readonly string[]): string[] {
  const set = new Set(ids);
  return ids.filter(
    (id) => editor.doc.has(id) && !editor.doc.ancestors(id).some((a) => set.has(a.id)),
  );
}

/** The current path of a path node in its local box. */
export function pathOf(editor: Editor, id: string): VectorPath | null {
  const node = editor.doc.get(id);
  if (node?.type !== "path") return null;
  return parsePathCached(getProp(node.props, "pathData"));
}

/** Replaces a path node's geometry (in its current local box), re-fitting its box. */
export function setPath(editor: Editor, id: string, path: VectorPath, label: string): boolean {
  const node = editor.doc.get(id);
  if (node?.type !== "path") return false;
  if (path.length === 0) {
    const ok = editor.commit([{ op: "delete", id }], label);
    if (ok) editor.select([]);
    return ok;
  }
  const ops = setPathOps(node, path);
  return ops.length === 0 ? true : editor.commit(ops, label);
}

// ---------------------------------------------------------------------------
// Vector edit mode

export function enterVectorEdit(editor: Editor, id: string): boolean {
  const node = editor.doc.get(id);
  if (!editor.canEdit || node?.type !== "path" || editor.scene.isLocked(id)) return false;
  editor.state.set({
    tool: "select",
    editingText: null,
    selection: [id],
    vectorEdit: { id, anchors: [] },
  });
  return true;
}

export function setAnchorSelection(editor: Editor, keys: readonly string[]): void {
  const v = editor.s.vectorEdit;
  if (!v) return;
  const same = keys.length === v.anchors.length && keys.every((k, i) => k === v.anchors[i]);
  if (!same) editor.state.set({ vectorEdit: { id: v.id, anchors: keys } });
}

export function deleteSelectedAnchors(editor: Editor): boolean {
  const v = editor.s.vectorEdit;
  const path = v && pathOf(editor, v.id);
  if (!v || !path || v.anchors.length === 0) return false;
  const next = deleteAnchors(path, new Set(v.anchors));
  const ok = setPath(editor, v.id, next, "Delete point");
  if (ok && editor.s.vectorEdit) setAnchorSelection(editor, []);
  return ok;
}

/** Moves the selected anchors by a page-space delta (arrow keys). */
export function nudgeAnchors(editor: Editor, dx: number, dy: number): boolean {
  const v = editor.s.vectorEdit;
  const path = v && pathOf(editor, v.id);
  if (!v || !path || v.anchors.length === 0) return false;
  // The delta in the node's local box: only the linear part of the inverse.
  const inv = invert(editor.scene.worldMatrix(v.id));
  const lx = inv[0] * dx + inv[2] * dy;
  const ly = inv[1] * dx + inv[3] * dy;
  return setPath(editor, v.id, moveAnchors(path, new Set(v.anchors), lx, ly), "Nudge points");
}

export function toggleAnchorSmooth(editor: Editor, key: string): boolean {
  const v = editor.s.vectorEdit;
  const path = v && pathOf(editor, v.id);
  const ref = parseAnchorKey(key);
  if (!v || !path || !ref) return false;
  return setPath(editor, v.id, toggleSmooth(path, ref), "Change point type");
}

/** Keeps vector edit state valid after undo, remote edits and selection changes. */
export function reconcileVectorEdit(editor: Editor): void {
  const v = editor.s.vectorEdit;
  if (!v) return;
  const { selection, tool } = editor.s;
  const node = editor.doc.get(v.id);
  if (
    node?.type !== "path" ||
    tool !== "select" ||
    selection.length !== 1 ||
    selection[0] !== v.id
  ) {
    editor.state.set({ vectorEdit: null });
    return;
  }
  const path = parsePathCached(getProp(node.props, "pathData"));
  const keys = validKeys(path, v.anchors);
  if (keys.length !== v.anchors.length)
    editor.state.set({ vectorEdit: { id: v.id, anchors: keys } });
}

// ---------------------------------------------------------------------------
// Flatten

/** Props a converted path keeps from the original layer. */
function pathProps(node: NodeRecord): Props {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(node.props)) {
    if (propAllowed("path", name as PropName)) out[name] = value;
  }
  return out as Props;
}

/** Converts rectangles, ellipses, lines and empty frames into equivalent paths, in place. */
export function flatten(editor: Editor, ids: readonly string[] = editor.s.selection): boolean {
  if (!editor.canEdit) return false;
  const ops: Op[] = [];
  const created: string[] = [];
  for (const id of topmost(editor, ids)) {
    const node = editor.doc.get(id);
    if (!node || editor.scene.isLocked(id)) continue;
    const hasChildren = editor.doc.childIds(id).length > 0;
    if (node.type === "path" || !isConvertible(node, hasChildren)) {
      if (node.type === "path") created.push(id);
      continue;
    }
    const local = nodePath(node);
    if (!local) continue;
    const fitted = fitToNode(node, local);
    const siblings = editor.doc.childIds(node.parent);
    const prev = siblings[siblings.indexOf(id) - 1];
    const newIdValue = newId();
    ops.push({ op: "delete", id });
    ops.push({
      op: "create",
      id: newIdValue,
      type: "path",
      parent: node.parent,
      key: keyBetween(prev ? (editor.doc.get(prev)?.key ?? null) : null, node.key),
      props: {
        ...pathProps(node),
        ...fitted,
        // Lines stroke along their centre; closed shapes keep their alignment.
        ...(node.type === "line" ? { strokeAlign: "center" } : {}),
      },
    });
    created.push(newIdValue);
  }
  if (ops.length === 0) {
    if (created.length === 0)
      editor.notify("Select a rectangle, ellipse, line or empty frame to flatten.");
    return false;
  }
  const ok = editor.commit(ops, "Flatten");
  if (ok) editor.select(created);
  return ok;
}

// ---------------------------------------------------------------------------
// Booleans

/** The shapes a boolean combines: convertible layers, with groups expanded to their contents. */
function operandLeaves(editor: Editor, id: string, out: NodeRecord[]): void {
  const node = editor.doc.get(id);
  if (!node || node.props.visible === false) return;
  if (node.type === "group") {
    for (const child of editor.doc.childIds(id)) operandLeaves(editor, child, out);
    return;
  }
  if (isConvertible(node, editor.doc.childIds(id).length > 0)) out.push(node);
}

export interface BooleanPlan {
  readonly roots: readonly string[];
  readonly leaves: readonly NodeRecord[];
  readonly parent: string;
  readonly operands: readonly BooleanOperand[];
}

/** Works out what a boolean on the current selection would combine, or null when it can't run. */
export function planBoolean(editor: Editor, ids: readonly string[]): BooleanPlan | null {
  const roots = zOrdered(editor, topmost(editor, ids)).filter((id) => !editor.scene.isLocked(id));
  const leaves: NodeRecord[] = [];
  for (const id of roots) operandLeaves(editor, id, leaves);
  const top = editor.doc.get(roots.at(-1) ?? "");
  if (leaves.length < 2 || !top) return null;
  const parent = top.parent;
  const space = editor.scene.spaceMatrix(editor.scene.spaceOwner(parent));
  const toParent = invert(space);
  const operands = leaves.map((leaf): BooleanOperand => {
    const local = nodePath(leaf) ?? [];
    const m = multiply(toParent, editor.scene.worldMatrix(leaf.id));
    return {
      d: serializePath(transformPath(local, m)),
      fillRule: leaf.type === "path" ? getProp(leaf.props, "windingRule") : "nonzero",
    };
  });
  return { roots, leaves, parent, operands };
}

export function canBoolean(editor: Editor): boolean {
  return editor.canEdit && planBoolean(editor, editor.s.selection) !== null;
}

/**
 * Combines the selected shapes into one path. The result keeps the bottom
 * layer's look, takes its name from the operation, and replaces the operands
 * just above the top one. One undo step.
 */
export async function booleanSelection(editor: Editor, op: BooleanOp): Promise<boolean> {
  if (!editor.canEdit) return false;
  const plan = planBoolean(editor, editor.s.selection);
  if (!plan) {
    editor.notify("Select two or more shapes to combine.");
    return false;
  }
  let engine: Awaited<ReturnType<Editor["booleanEngine"]>>;
  try {
    engine = await editor.booleanEngine();
  } catch {
    editor.notify("Couldn't load the shape engine. Check your connection and try again.");
    return false;
  }
  // The file may have changed while the engine loaded: re-plan from the live document.
  const live = planBoolean(editor, plan.roots);
  if (!live || live.roots.length !== plan.roots.length) {
    editor.notify("Those shapes changed while combining. Select them and try again.");
    return false;
  }
  let result: { d: string; fillRule: "nonzero" | "evenodd" };
  try {
    result = engine.combine(live.operands, op);
  } catch {
    editor.notify("Couldn't combine those shapes.");
    return false;
  }
  const { path, bounds } = fitPath(parsePath(result.d));
  if (path.length === 0 || (bounds.width === 0 && bounds.height === 0)) {
    editor.notify("Nothing is left: those shapes don't overlap.");
    return false;
  }
  const bottom = live.leaves[0] as NodeRecord;
  const top = editor.doc.get(live.roots.at(-1) as string) as NodeRecord;
  const siblings = editor.doc.childIds(live.parent);
  const next = siblings[siblings.indexOf(top.id) + 1];
  const style: Record<string, unknown> = {};
  for (const prop of STYLE_PROPS) {
    const value = bottom.props[prop];
    if (value !== undefined) style[prop] = value;
  }
  // Closed paths honour stroke alignment like any shape; a line strokes along its centre.
  if (bottom.type === "line") style.strokeAlign = "center";
  const id = newId();
  const ops: Op[] = [
    {
      op: "create",
      id,
      type: "path",
      parent: live.parent,
      key: keyBetween(top.key, next ? (editor.doc.get(next)?.key ?? null) : null),
      props: {
        ...style,
        name: BOOLEAN_LABELS[op],
        pathData: serializePath(path),
        windingRule: result.fillRule,
        x: round3(bounds.x),
        y: round3(bounds.y),
        width: round3(bounds.width),
        height: round3(bounds.height),
      },
    },
    ...live.roots.map((root): Op => ({ op: "delete", id: root })),
  ];
  const ok = editor.commit(ops, BOOLEAN_LABELS[op]);
  if (ok) editor.select([id]);
  return ok;
}
