import { copyId } from "./copies";
import { isValidId, ROOT_ID } from "./ids";
import type { CreateOp, DeleteOp, MoveOp, NodeRecord, Op, SetOp } from "./ops";
import { isValidOrderKey } from "./order-key";
import {
  CHILD_TYPES,
  isPropName,
  NODE_TYPES,
  type NodeType,
  PROPS,
  type PropName,
  propAllowed,
} from "./schema";
import { deeperThan, type NodeStore } from "./store";

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
  | "last_page"
  /** The change would undo or lose another that was made meanwhile: catch up, then make it again. */
  | "conflict";

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

/**
 * How many levels `id` is below the root (a page is 1), counted as far as
 * they go, and whether walking up from it reached `stop` (the layer being
 * moved: the destination is inside it). A parent missing ends the count; a
 * walk that comes back to a node it passed (a store holding a cycle) ends
 * it too, as `looped`, rather than going round for ever.
 */
function levelsAbove(
  store: NodeStore,
  id: string,
  stop?: string,
): { depth: number; reached: boolean; looped: boolean } {
  let depth = 0;
  const seen = new Set<string>();
  for (let current = id; current !== ROOT_ID; ) {
    if (current === stop) return { depth, reached: true, looped: false };
    if (seen.has(current)) return { depth, reached: false, looped: true };
    seen.add(current);
    const node = store.get(current);
    if (!node) break;
    current = node.parent;
    depth++;
  }
  return { depth, reached: false, looped: false };
}

const tooDeep = () =>
  new ModelError("too_deep", `Layers can't nest deeper than ${MAX_DEPTH} levels.`);

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

/**
 * Checks what a node is on its own (its id, order key and every property's
 * value) and returns it as it would be stored, nulls left out. Where it sits
 * (its parent, depth, cycles) is the store's to check. Throws `ModelError`.
 * An import checks each node with this as it arrives, before anything is
 * placed.
 */
export function checkNode(node: NodeRecord): NodeRecord {
  if (!isValidId(node.id)) throw new ModelError("invalid_id", `"${node.id}" isn't a valid id.`);
  if (!isValidOrderKey(node.key)) throw new ModelError("invalid_key", `Invalid order key.`);
  if (!(NODE_TYPES as readonly string[]).includes(node.type))
    throw new ModelError("invalid_parent", `There's no kind of layer called "${node.type}".`);
  const props: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(node.props)) {
    checkValue(node.type, prop, value);
    if (value !== null && value !== undefined) props[prop] = value;
  }
  return { id: node.id, type: node.type, parent: node.parent, key: node.key, props };
}

function applyCreate(store: NodeStore, op: CreateOp, held: boolean): Op[] {
  if (!isValidId(op.id)) throw new ModelError("invalid_id", `"${op.id}" isn't a valid id.`);
  if (store.get(op.id)) throw new ModelError("already_exists", `Node ${op.id} already exists.`);
  if (!isValidOrderKey(op.key)) throw new ModelError("invalid_key", `Invalid order key.`);
  checkParent(store, op.parent, op.type);
  if (op.type === "override") checkRecord(store, op);
  if (op.parent !== ROOT_ID) {
    const above = levelsAbove(store, op.parent);
    if (above.looped) throw new ModelError("cycle", `Layer ${op.parent} is inside itself.`);
    // A new layer is as deep as it goes: past the limit only when it puts back what was held.
    if (!held && above.depth + 1 > MAX_DEPTH) throw tooDeep();
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

function applyDelete(store: NodeStore, op: DeleteOp, force: boolean, inverse: boolean): Op[] {
  const node = requireNode(store, op.id);
  const pages = () => store.childIds(ROOT_ID).filter((id) => store.get(id)?.type === "page").length;
  if (!force && node.type === "page" && pages() <= 1) {
    throw new ModelError("last_page", "A file needs at least one page.");
  }
  // Nothing to undo with: a store that can drops the whole subtree without reading it.
  if (!inverse && store.removeTree) {
    store.removeTree(op.id);
    return [];
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

/**
 * An override record (decision 0029) sits under an instance root, and its id
 * is the one its path derives, so every client names the copy layer alike.
 */
function checkRecord(store: NodeStore, op: CreateOp): void {
  const parent = store.get(op.parent);
  if (parent?.type !== "frame" || !parent.props.instanceOf) {
    throw new ModelError("invalid_parent", "An override record belongs under an instance.");
  }
  const path = op.props.path;
  if (!Array.isArray(path) || path.length === 0) {
    throw new ModelError("invalid_value", `An override record needs a "path".`);
  }
  if (op.id !== copyId(op.parent, path)) {
    throw new ModelError("invalid_id", `"${op.id}" isn't the id of the layer its path names.`);
  }
}

function applySet(store: NodeStore, op: SetOp): Op[] {
  const node = requireNode(store, op.id);
  checkValue(node.type, op.prop, op.value);
  if (op.prop === "path") {
    throw new ModelError("invalid_prop", "An override record's path doesn't change.");
  }
  if (
    op.prop === "instanceOf" &&
    op.value === null &&
    store.childIds(op.id).some((id) => store.get(id)?.type === "override")
  ) {
    throw new ModelError("invalid_value", "An instance with override records stays an instance.");
  }
  const previous = node.props[op.prop];
  store.setProp(op.id, op.prop, op.value === null ? undefined : op.value);
  return [{ op: "set", id: op.id, prop: op.prop, value: previous === undefined ? null : previous }];
}

function applyMove(store: NodeStore, op: MoveOp, held: boolean): Op[] {
  const node = requireNode(store, op.id);
  if (node.type === "override") {
    throw new ModelError("invalid_parent", "An override record stays with its instance.");
  }
  if (!isValidOrderKey(op.key)) throw new ModelError("invalid_key", `Invalid order key.`);
  checkParent(store, op.parent, node.type);
  // Walk up from the new parent: meeting the node itself means a cycle.
  const above = levelsAbove(store, op.parent, op.id);
  if (above.reached) throw new ModelError("cycle", "A layer can't be moved inside itself.");
  if (above.looped) throw new ModelError("cycle", `Layer ${op.parent} is inside itself.`);
  // What's inside it moves down as far as it does: a move may not take the deepest layer it
  // carries past the limit. One that doesn't take it deeper is always allowed, so a file
  // holding layers past the limit (moves didn't use to check this) can still be tidied.
  const depth = above.depth + 1;
  if (
    !held &&
    depth > levelsAbove(store, op.id).depth &&
    (depth > MAX_DEPTH || deeperThan(store, op.id, MAX_DEPTH - depth))
  )
    throw tooDeep();
  const inverse: MoveOp = { op: "move", id: op.id, parent: node.parent, key: node.key };
  store.move(op.id, op.parent, op.key);
  return [inverse];
}

// ---------------------------------------------------------------------------
// Instances inside their own main

/** A frame's live main: the component it's an instance of (a record's swap counts too). */
function liveMainOf(store: NodeStore, node: NodeRecord): string | null {
  let of: unknown;
  if (node.type === "frame") of = node.props.instanceOf;
  else if (node.type === "override") of = node.props.instanceOf;
  if (typeof of !== "string" || of === node.id) return null;
  const main = store.get(of);
  return main?.type === "frame" && main.props.isComponent ? of : null;
}

/** The mains `id` is, or is inside. */
function mainsAround(store: NodeStore, id: string): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  for (let at = id; at !== ROOT_ID && !seen.has(at); ) {
    seen.add(at);
    const node = store.get(at);
    if (!node) break;
    if (node.type === "frame" && node.props.isComponent) out.add(at);
    at = node.parent;
  }
  return out;
}

/** The mains named by instances (and records' swaps) at `id`, or anywhere under it when `deep`. */
function mainsNamed(store: NodeStore, id: string, deep: boolean): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    const node = store.get(at);
    if (!node) continue;
    const of = liveMainOf(store, node);
    if (of) out.add(of);
    if (deep) for (const child of store.childIds(at)) stack.push(child);
  }
  return out;
}

/**
 * Whether, after `op` applied, a main contains an instance of itself,
 * directly or through other mains (an instance's layers are its main's, so
 * that main would contain itself without end). Only what `op` changed is
 * looked at: the mains around the node it touched, and the mains named
 * at or under it.
 */
function makesInstanceCycle(store: NodeStore, op: Op): boolean {
  let deep: boolean;
  if (op.op === "create") {
    if (op.type !== "frame" && op.type !== "override") return false;
    deep = false;
  } else if (op.op === "move") deep = true;
  else if (op.op === "set" && (op.prop === "instanceOf" || op.prop === "isComponent")) {
    if (!op.value) return false;
    deep = op.prop === "isComponent";
  } else return false;
  const node = store.get(op.id);
  if (!node) return false;
  // A record's swap puts its main's layers in the instance it belongs to.
  const around = mainsAround(store, node.type === "override" ? node.parent : op.id);
  if (around.size === 0) return false;
  // The node itself counts: a main that's an instance is made of its own main's layers.
  const named = mainsNamed(store, op.id, deep);
  if (named.size === 0) return false;
  const contained = new Map<string, Set<string>>();
  const containedIn = (main: string): Set<string> => {
    let out = contained.get(main);
    if (!out) {
      out = mainsNamed(store, main, true);
      contained.set(main, out);
    }
    return out;
  };
  const seen = new Set<string>();
  const stack = [...named];
  for (let main = stack.pop(); main !== undefined; main = stack.pop()) {
    if (around.has(main)) return true;
    if (seen.has(main)) continue;
    seen.add(main);
    for (const next of containedIn(main)) stack.push(next);
  }
  return false;
}

/**
 * Validates and applies one operation. Returns the operations that undo it,
 * in the order they must run. Throws `ModelError` and leaves the store
 * untouched when the operation is invalid.
 */
export function applyOp(
  store: NodeStore,
  op: Op,
  { held = false, cycles = !held }: ApplyOptions = {},
): Op[] {
  return apply(store, op, false, true, held, cycles);
}

function apply(
  store: NodeStore,
  op: Op,
  force: boolean,
  inverse: boolean,
  held: boolean,
  cycles: boolean,
): Op[] {
  let undo: Op[];
  switch (op.op) {
    case "create":
      undo = applyCreate(store, op, held);
      break;
    case "delete":
      return applyDelete(store, op, force, inverse);
    case "set":
      undo = applySet(store, op);
      break;
    case "move":
      undo = applyMove(store, op, held);
      break;
  }
  if (cycles && makesInstanceCycle(store, op)) {
    // Taken back before saying so: an operation that's refused changes nothing.
    for (const back of undo) apply(store, back, true, true, true, false);
    throw new ModelError(
      "cycle",
      "A component can't contain an instance of itself, directly or through other components.",
    );
  }
  return undo;
}

export interface ApplyOptions {
  /**
   * Undo already-applied operations when a later one fails. Turn off when the
   * store rolls back by itself (a SQLite transaction).
   */
  readonly rollback?: boolean;
  /**
   * Work out the operations that undo it (the default). Without them, a
   * delete doesn't read what it deletes, so deleting a page of 100,000
   * layers costs no memory; only with `rollback` off.
   */
  readonly inverse?: boolean;
  /**
   * The operations put back layers the document (or a file the server
   * holds) already had: a rebase undoing unacknowledged edits, a change the
   * room already accepted, a restore, a merge, an update from main. They
   * may stand as deep as they stood, so nothing is refused for depth;
   * everything else is checked as ever. An edit (an undo by the user too)
   * leaves this off: it may not make anything deeper than MAX_DEPTH unless
   * it was already that deep (decision 0026). A transaction's own rollback
   * is always applied this way.
   */
  readonly held?: boolean;
  /**
   * Refuse an operation that would make a main contain an instance of
   * itself, directly or through other mains (its layers would contain
   * themselves without end). On by default, off for `held` operations: they
   * put back what was there (a client's rebase follows the room, which
   * checks). The room checks every transaction it commits, held or not.
   * A transaction's own rollback never checks.
   */
  readonly cycles?: boolean;
}

/**
 * Applies operations all-or-nothing. Returns the operations that undo the
 * whole transaction. On failure, throws a `ModelError` carrying `opIndex`.
 */
export function applyTransaction(
  store: NodeStore,
  ops: readonly Op[],
  { rollback = true, inverse = true, held = false, cycles = !held }: ApplyOptions = {},
): Op[] {
  const undo: Op[][] = [];
  const keep = inverse || rollback;
  for (let i = 0; i < ops.length; i++) {
    try {
      const back = apply(store, ops[i] as Op, false, keep, held, cycles);
      if (keep) undo.push(back);
    } catch (error) {
      if (rollback) {
        for (let j = undo.length - 1; j >= 0; j--) {
          // Rolling back may delete the only page a failed transaction created, and puts back
          // what the transaction removed however deep it was.
          for (const back of undo[j] as Op[]) apply(store, back, true, true, true, false);
        }
      }
      if (error instanceof ModelError) throw new ModelError(error.code, error.message, i);
      throw error;
    }
  }
  return undo.reverse().flat();
}
