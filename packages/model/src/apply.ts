import { isValidId, ROOT_ID } from "./ids";
import type { CreateOp, DeleteOp, MoveOp, NodeRecord, Op, SetOp } from "./ops";
import { isValidOrderKey } from "./order-key";
import {
  CHILD_TYPES,
  isPropName,
  type NodeType,
  PROPS,
  type PropName,
  propAllowed,
} from "./schema";
import type { NodeStore } from "./store";

export type ModelErrorCode =
  | "not_found"
  | "already_exists"
  | "invalid_id"
  | "invalid_key"
  | "invalid_parent"
  | "cycle"
  | "too_deep"
  | "invalid_prop"
  | "invalid_value"
  | "last_page";

export class ModelError extends Error {
  override name = "ModelError";
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    /** Index of the failing operation within its transaction, when known. */
    readonly opIndex?: number,
  ) {
    super(message);
  }
}

/** Deepest nesting we allow. Real files rarely pass 30. */
export const MAX_DEPTH = 128;

function parentType(store: NodeStore, parent: string): NodeType | "root" | undefined {
  if (parent === ROOT_ID) return "root";
  return store.get(parent)?.type;
}

function requireNode(store: NodeStore, id: string): NodeRecord {
  const node = store.get(id);
  if (!node) throw new ModelError("not_found", `Node ${id} doesn't exist.`);
  return node;
}

function checkParent(store: NodeStore, parent: string, childType: NodeType): void {
  const type = parentType(store, parent);
  if (type === undefined) throw new ModelError("not_found", `Parent ${parent} doesn't exist.`);
  if (!CHILD_TYPES[type].includes(childType)) {
    throw new ModelError("invalid_parent", `A ${type} can't contain a ${childType}.`);
  }
}

function depthOf(store: NodeStore, id: string): number {
  let depth = 0;
  let current = id;
  while (current !== ROOT_ID) {
    const node = store.get(current);
    if (!node) break;
    current = node.parent;
    if (++depth > MAX_DEPTH) break;
  }
  return depth;
}

function checkValue(type: NodeType, prop: string, value: unknown): asserts prop is PropName {
  if (!isPropName(prop)) throw new ModelError("invalid_prop", `Unknown property "${prop}".`);
  if (!propAllowed(type, prop)) {
    throw new ModelError("invalid_prop", `A ${type} has no "${prop}" property.`);
  }
  if (value === null) return;
  const result = PROPS[prop].schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ModelError("invalid_value", `"${prop}" ${issue?.message ?? "is invalid"}.`);
  }
}

function applyCreate(store: NodeStore, op: CreateOp): Op[] {
  if (!isValidId(op.id)) throw new ModelError("invalid_id", `"${op.id}" isn't a valid id.`);
  if (store.get(op.id)) throw new ModelError("already_exists", `Node ${op.id} already exists.`);
  if (!isValidOrderKey(op.key)) throw new ModelError("invalid_key", `Invalid order key.`);
  checkParent(store, op.parent, op.type);
  if (op.parent !== ROOT_ID && depthOf(store, op.parent) >= MAX_DEPTH) {
    throw new ModelError("too_deep", `Layers can't nest deeper than ${MAX_DEPTH} levels.`);
  }
  const props: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(op.props)) {
    checkValue(op.type, prop, value);
    if (value !== null && value !== undefined) props[prop] = value;
  }
  store.insert({ id: op.id, type: op.type, parent: op.parent, key: op.key, props });
  return [{ op: "delete", id: op.id }];
}

/** Every node under `id`, parents before children. */
export function collectSubtree(store: NodeStore, id: string): NodeRecord[] {
  const root = store.get(id);
  if (!root) return [];
  const out: NodeRecord[] = [root];
  for (let i = 0; i < out.length; i++) {
    for (const child of store.childIds((out[i] as NodeRecord).id)) {
      const node = store.get(child);
      if (node) out.push(node);
    }
  }
  return out;
}

function applyDelete(store: NodeStore, op: DeleteOp, force: boolean): Op[] {
  const node = requireNode(store, op.id);
  const pages = () => store.childIds(ROOT_ID).filter((id) => store.get(id)?.type === "page").length;
  if (!force && node.type === "page" && pages() <= 1) {
    throw new ModelError("last_page", "A file needs at least one page.");
  }
  const subtree = collectSubtree(store, op.id);
  for (let i = subtree.length - 1; i >= 0; i--) store.remove((subtree[i] as NodeRecord).id);
  return subtree.map(
    (n): CreateOp => ({
      op: "create",
      id: n.id,
      type: n.type,
      parent: n.parent,
      key: n.key,
      props: n.props,
    }),
  );
}

function applySet(store: NodeStore, op: SetOp): Op[] {
  const node = requireNode(store, op.id);
  checkValue(node.type, op.prop, op.value);
  const previous = node.props[op.prop];
  store.setProp(op.id, op.prop, op.value === null ? undefined : op.value);
  return [{ op: "set", id: op.id, prop: op.prop, value: previous === undefined ? null : previous }];
}

function applyMove(store: NodeStore, op: MoveOp): Op[] {
  const node = requireNode(store, op.id);
  if (!isValidOrderKey(op.key)) throw new ModelError("invalid_key", `Invalid order key.`);
  checkParent(store, op.parent, node.type);
  // Walk up from the new parent: meeting the node itself means a cycle.
  let depth = 1;
  for (let current = op.parent; current !== ROOT_ID; ) {
    if (current === op.id) {
      throw new ModelError("cycle", "A layer can't be moved inside itself.");
    }
    const ancestor = store.get(current);
    if (!ancestor) break;
    current = ancestor.parent;
    if (++depth > MAX_DEPTH) {
      throw new ModelError("too_deep", `Layers can't nest deeper than ${MAX_DEPTH} levels.`);
    }
  }
  const inverse: MoveOp = { op: "move", id: op.id, parent: node.parent, key: node.key };
  store.move(op.id, op.parent, op.key);
  return [inverse];
}

/**
 * Validates and applies one operation. Returns the operations that undo it,
 * in the order they must run. Throws `ModelError` and leaves the store
 * untouched when the operation is invalid.
 */
export function applyOp(store: NodeStore, op: Op): Op[] {
  return apply(store, op, false);
}

function apply(store: NodeStore, op: Op, force: boolean): Op[] {
  switch (op.op) {
    case "create":
      return applyCreate(store, op);
    case "delete":
      return applyDelete(store, op, force);
    case "set":
      return applySet(store, op);
    case "move":
      return applyMove(store, op);
  }
}

export interface ApplyOptions {
  /**
   * Undo already-applied operations when a later one fails. Turn off when the
   * store rolls back by itself (a SQLite transaction).
   */
  readonly rollback?: boolean;
}

/**
 * Applies operations all-or-nothing. Returns the operations that undo the
 * whole transaction. On failure, throws a `ModelError` carrying `opIndex`.
 */
export function applyTransaction(
  store: NodeStore,
  ops: readonly Op[],
  { rollback = true }: ApplyOptions = {},
): Op[] {
  const undo: Op[][] = [];
  for (let i = 0; i < ops.length; i++) {
    try {
      undo.push(applyOp(store, ops[i] as Op));
    } catch (error) {
      if (rollback) {
        for (let j = undo.length - 1; j >= 0; j--) {
          // Rolling back may delete the only page a failed transaction created.
          for (const inverse of undo[j] as Op[]) apply(store, inverse, true);
        }
      }
      if (error instanceof ModelError) throw new ModelError(error.code, error.message, i);
      throw error;
    }
  }
  return undo.reverse().flat();
}
