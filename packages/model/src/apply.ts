import { copyId } from "./copies";
import { isValidId, ROOT_ID } from "./ids";
import type { CreateOp, DeleteOp, MoveOp, NodeRecord, Op, SetOp } from "./ops";
import { isValidOrderKey } from "./order-key";
import {
  CHILD_TYPES,
  isPropName,
  KEYED_PROPS,
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
  const existing = store.get(op.id);
  if (existing) {
    // An override record made where a teammate just made one (decision 0029): its id is the
    // copy layer's, derived alike everywhere, so it's that layer's values, set (decision 0035).
    if (op.type === "override" && existing.type === "override" && existing.parent === op.parent)
      return mergeRecord(store, existing, op);
    throw new ModelError("already_exists", `Node ${op.id} already exists.`);
  }
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

/**
 * A create of an override record that exists: its path the same (the id says
 * so), merged field by field, so two people's first changes to one copy layer,
 * each writing the record from a file without the other's, both stay:
 * - a field the create gives a value or lists in `unset` is the creator's (the
 *   last writer's, as sets are): its value set, or its value removed and the
 *   field unset;
 * - a field the create doesn't mention keeps what the record has;
 * - `unset` is both lists, less the fields the create gives a value;
 * - `overrides`, which marks fields, is both lists.
 * Every client, the room, stored replay and a branch merge apply it here.
 * Undone value by value.
 */
export function mergeRecordProps(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const given = new Set<string>();
  for (const [prop, value] of Object.entries(incoming)) {
    if (prop === "path" || prop === "unset" || prop === "overrides") continue;
    if (value === null || value === undefined) continue;
    merged[prop] = value;
    given.add(prop);
  }
  const cleared = strings(incoming.unset);
  for (const prop of cleared) if (!given.has(prop)) delete merged[prop];
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  const unset = union(
    strings(existing.unset).filter((prop) => !given.has(prop)),
    cleared.filter((prop) => !given.has(prop)),
  );
  if (unset.length) merged.unset = unset;
  else delete merged.unset;
  const overrides = union(strings(existing.overrides), strings(incoming.overrides));
  if (overrides.length) merged.overrides = overrides;
  else delete merged.overrides;
  return merged;
}

function mergeRecord(store: NodeStore, existing: NodeRecord, op: CreateOp): Op[] {
  const path = op.props.path;
  if (!Array.isArray(path) || JSON.stringify(path) !== JSON.stringify(existing.props.path))
    throw new ModelError("already_exists", `Node ${op.id} already exists.`);
  const before = existing.props as Record<string, unknown>;
  const after = mergeRecordProps(before, op.props as Record<string, unknown>);
  const undo: Op[] = [];
  for (const prop of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (prop === "path") continue;
    const previous = before[prop];
    const next = after[prop];
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    checkValue("override", prop, next ?? null);
    store.setProp(op.id, prop, next);
    undo.push({ op: "set", id: op.id, prop, value: previous === undefined ? null : previous });
  }
  return undo.reverse();
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
  const pages = () =>
    store.pagesUpTo
      ? store.pagesUpTo(2)
      : store.childIds(ROOT_ID).filter((id) => store.get(id)?.type === "page").length;
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

/**
 * The map a keyed set (`op.key`) leaves on `node`, checked: the entry set,
 * or removed when `op.value` is null; null when the map is left empty.
 */
export function keyedResult(node: NodeRecord, op: SetOp): Record<string, unknown> | null {
  const spec = KEYED_PROPS.get(op.prop);
  if (!spec) throw new ModelError("invalid_prop", `"${op.prop}" has no entries to set one of.`);
  const key = op.key as string;
  if (!spec.key.safeParse(key).success)
    throw new ModelError("invalid_value", `"${op.prop}" can't have an entry "${key}".`);
  if (op.value !== null && !spec.value.safeParse(op.value).success)
    throw new ModelError("invalid_value", `"${op.prop}.${key}" is invalid.`);
  const before = node.props[op.prop] as Record<string, unknown> | undefined;
  const next: Record<string, unknown> = { ...(before ?? {}) };
  if (op.value === null) delete next[key];
  else next[key] = op.value;
  return Object.keys(next).length > 0 ? next : null;
}

function applySet(store: NodeStore, op: SetOp): Op[] {
  const node = requireNode(store, op.id);
  if (op.key !== undefined) {
    // One entry of a map: checked, and undone, on its own (decision 0035, item 15). What
    // bounds the map whole (how many entries, how much text in all) is checked on what the
    // transaction leaves (`checkKeyedMaps`): one entry may grow before another shrinks.
    const next = keyedResult(node, op);
    if (!isPropName(op.prop) || !propAllowed(node.type, op.prop))
      throw new ModelError("invalid_prop", `A ${node.type} has no "${op.prop}" property.`);
    const previous = (node.props[op.prop] as Record<string, unknown> | undefined)?.[op.key];
    store.setProp(op.id, op.prop, next === null ? undefined : next);
    return [{ op: "set", id: op.id, prop: op.prop, key: op.key, value: previous ?? null }];
  }
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
 * What an operation may have made a main contain: the node it touched, and
 * whether what's under it counts too (it moved, or became a main). Null for
 * an operation that can't make a main contain itself.
 */
export function cycleCandidate(op: Op): { id: string; deep: boolean } | null {
  if (op.op === "create")
    return op.type === "frame" || op.type === "override" ? { id: op.id, deep: false } : null;
  if (op.op === "move") return { id: op.id, deep: true };
  if (op.op === "set" && (op.prop === "instanceOf" || op.prop === "isComponent") && op.value)
    return { id: op.id, deep: op.prop === "isComponent" };
  return null;
}

/**
 * Whether a main contains an instance of itself through `id`, as the store
 * is now: one of the mains `id` is in is reached from the mains named at
 * `id` (or anywhere under it when `deep`), followed through what each main
 * contains. A store that can answer without reading values (SQLite) does;
 * otherwise only what's around `id` is read.
 */
export function instanceCycleAt(store: NodeStore, id: string, deep: boolean): boolean {
  if (store.instanceCycle) return store.instanceCycle(id, deep);
  const node = store.get(id);
  if (!node) return false;
  // A record's swap puts its main's layers in the instance it belongs to.
  const around = mainsAround(store, node.type === "override" ? node.parent : id);
  if (around.size === 0) return false;
  // The node itself counts: a main that's an instance is made of its own main's layers.
  const named = mainsNamed(store, id, deep);
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

const cycleError = (opIndex?: number) =>
  new ModelError(
    "cycle",
    "A component can't contain an instance of itself, directly or through other components.",
    opIndex,
  );

/**
 * Validates and applies one operation. Returns the operations that undo it,
 * in the order they must run. Throws `ModelError` and leaves the store
 * untouched when the operation is invalid. A keyed set's map is checked
 * whole by the caller, on what its transaction leaves (`checkKeyedMaps`).
 */
export function applyOp(
  store: NodeStore,
  op: Op,
  { held = false, cycles = !held }: ApplyOptions = {},
): Op[] {
  const undo = apply(store, op, false, true, held);
  const candidate = cycles === false ? null : cycleCandidate(op);
  if (!candidate) return undo;
  if (typeof cycles === "object") cycles.add(candidate.id, candidate.deep);
  else if (instanceCycleAt(store, candidate.id, candidate.deep)) {
    // Taken back before saying so: an operation that's refused changes nothing.
    takeBack(store, [undo]);
    throw cycleError();
  }
  return undo;
}

function apply(store: NodeStore, op: Op, force: boolean, inverse: boolean, held: boolean): Op[] {
  switch (op.op) {
    case "create":
      return applyCreate(store, op, held);
    case "delete":
      return applyDelete(store, op, force, inverse);
    case "set":
      return applySet(store, op);
    case "move":
      return applyMove(store, op, held);
  }
}

/**
 * Checks the maps keyed sets wrote (`touched`: their node ids and
 * properties, the operation's index each) whole, as their schema bounds
 * them: what a transaction's keyed sets leave. Throws `ModelError` naming
 * the last operation that wrote the first map out of bounds.
 */
export function checkKeyedMaps(store: NodeStore, touched: ReadonlyMap<string, number>): void {
  for (const [at, index] of touched) {
    const split = at.indexOf("\u0000");
    const id = at.slice(0, split);
    const prop = at.slice(split + 1);
    const node = store.get(id);
    if (!node) continue;
    try {
      checkValue(node.type, prop, (node.props as Record<string, unknown>)[prop] ?? null);
    } catch (error) {
      if (error instanceof ModelError) throw new ModelError(error.code, error.message, index);
      throw error;
    }
  }
}

/** Where `checkKeyedMaps` files a keyed set: its node and property. */
export function keyedMapOf(op: Op): string | null {
  return op.op === "set" && op.key !== undefined ? `${op.id}\u0000${op.prop}` : null;
}

/** Undoes applied operations, last first: always allowed, however deep, never checked for cycles. */
function takeBack(store: NodeStore, undo: readonly (readonly Op[])[]): void {
  for (let j = undo.length - 1; j >= 0; j--)
    for (const back of undo[j] as Op[]) apply(store, back, true, true, true);
}

/**
 * Where the nodes a transaction's operations may have made a main contain
 * itself through go, for a caller that checks them itself once more has
 * applied (`instanceCycleAt`): a room committing a restore or a merge in
 * chunks checks them all once, when the last has applied.
 */
export interface CycleCandidates {
  add(id: string, deep: boolean): void;
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
   * Refuse a transaction that would leave a main containing an instance of
   * itself, directly or through other mains (its layers would contain
   * themselves without end). Checked once every operation has applied, on
   * what they leave: an operation may pass through such a state on the way
   * (a restore creates a version's layers before it deletes the file's), as
   * long as the end isn't one. On by default, off for `held` operations:
   * they put back what was there (a client's rebase follows the room, which
   * checks). The room checks every transaction it commits, held or not,
   * passing `CycleCandidates` to check its chunks together. A transaction's
   * own rollback never checks.
   */
  readonly cycles?: boolean | CycleCandidates;
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
  // Each node an operation may have made a main contain itself through, and the last operation
  // that touched it: checked on what the transaction leaves.
  const check = cycles === true ? new Map<string, { deep: boolean; index: number }>() : null;
  const sink = typeof cycles === "object" ? cycles : null;
  const keyed = new Map<string, number>();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Op;
    try {
      const back = apply(store, op, false, keep, held);
      if (keep) undo.push(back);
      const map = keyedMapOf(op);
      if (map !== null) keyed.set(map, i);
    } catch (error) {
      // Rolling back may delete the only page a failed transaction created, and puts back
      // what the transaction removed however deep it was.
      if (rollback) takeBack(store, undo);
      if (error instanceof ModelError) throw new ModelError(error.code, error.message, i);
      throw error;
    }
    const candidate = check || sink ? cycleCandidate(op) : null;
    if (!candidate) continue;
    if (sink) sink.add(candidate.id, candidate.deep);
    else if (check) {
      const deep = candidate.deep || (check.get(candidate.id)?.deep ?? false);
      check.delete(candidate.id);
      check.set(candidate.id, { deep, index: i });
    }
  }
  if (keyed.size > 0)
    try {
      checkKeyedMaps(store, keyed);
    } catch (error) {
      if (rollback) takeBack(store, undo);
      throw error;
    }
  if (check)
    for (const [id, { deep, index }] of check)
      if (instanceCycleAt(store, id, deep)) {
        if (rollback) takeBack(store, undo);
        throw cycleError(index);
      }
  return undo.reverse().flat();
}
