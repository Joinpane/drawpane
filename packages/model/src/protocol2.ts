/**
 * Tabs from before component property records (protocol 2, decision 0035),
 * for the room (apps/worker's file room) and its stand-ins in tests.
 *
 * A tab already open runs the code it loaded, which can't be changed: it
 * knows no `propRefs`, `propValues`, `componentProps` or `exposeProps`, its
 * model refuses an operation that names one, and it would read a keyed set
 * of one value (`key`) as the whole map. It can't keep what it doesn't see
 * over what it does to an instance (a delete and its undo, a detach, a
 * duplicate), so after this change it's no longer an editor:
 *
 * - It's welcomed as a viewer, so it makes no edit from then on, and its
 *   update banner reloads it once nothing is waiting to be saved. Closing it
 *   to reload at once would lose the edits it holds unsent (kept in memory
 *   only), so it isn't.
 * - Of what it held unsent, a transaction is applied when every operation in
 *   it is safe (`protocol2Refusal`), and refused whole otherwise, with a
 *   message it shows: that change wasn't saved, and is to be made again
 *   after reloading. Nothing is ever applied in part.
 * - What it's sent leaves those properties out (`forProtocol2Ops`,
 *   `forProtocol2Nodes`), as it views the file until it reloads.
 */
import type { NodeRecord, Op } from "./ops";

/** Properties a protocol 2 tab doesn't know. */
export const PROTOCOL3_PROPS: ReadonlySet<string> = new Set([
  "componentProps",
  "propRefs",
  "propValues",
  "exposeProps",
]);

/** Props without those a protocol 2 tab doesn't know; the same object when there are none. */
function knownProps<P extends Readonly<Record<string, unknown>>>(props: P): P {
  let out: Record<string, unknown> | null = null;
  for (const prop of PROTOCOL3_PROPS)
    if (prop in props) {
      out ??= { ...props };
      delete out[prop];
    }
  return (out ?? props) as P;
}

/** Operations as a protocol 2 tab can apply them: those properties' sets left out, and their values. */
export function forProtocol2Ops(ops: readonly Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    if (op.op === "set" && (PROTOCOL3_PROPS.has(op.prop) || op.key !== undefined)) continue;
    if (op.op === "create") out.push({ ...op, props: knownProps(op.props) });
    else out.push(op);
  }
  return out;
}

/** Nodes as a protocol 2 tab can hold them. */
export function forProtocol2Nodes(nodes: readonly NodeRecord[]): NodeRecord[] {
  return nodes.map((node) => {
    const props = knownProps(node.props);
    return props === node.props ? node : { ...node, props };
  });
}

/** What `protocol2Refusal` reads: the room's nodes as stored. */
export interface Protocol2Reader {
  /** A stored node. */
  get(id: string): NodeRecord | undefined;
  /**
   * Whether anything in `id`'s subtree, itself included, is linked
   * (`linkedNode`): an instance, a layer of one, a main, a component set,
   * an override record, or a node holding a property's fields.
   */
  holdsLinked(id: string): boolean;
  /** Those of `ids` the file had once (named by an operation it keeps): a create of one puts it back. */
  hadOnce(ids: readonly string[]): ReadonlySet<string>;
}

/** What a protocol 2 tab is told of a change it held that the room can't take. */
export const PROTOCOL2_REFUSAL =
  "Drawpane was updated while this change was waiting to be saved, so it wasn't saved. Reload the page, then make it again.";

/** Fields that link a node to a main, or make it one: never a protocol 2 tab's to write. */
const LINK_FIELDS: ReadonlySet<string> = new Set([
  "instanceOf",
  "mirrors",
  "isComponent",
  "isComponentSet",
  "overrides",
  "unset",
  "path",
  "variantProps",
  ...PROTOCOL3_PROPS,
]);

/**
 * Whether a node is linked: an instance root, a copy layer, a main or a
 * component set, an override record, or one holding a property's fields.
 * What a protocol 2 tab can't change without losing what it doesn't see.
 */
export function linkedNode(node: NodeRecord): boolean {
  if (node.type === "override") return true;
  const props = node.props as Record<string, unknown>;
  for (const field of LINK_FIELDS)
    if (props[field] !== undefined && props[field] !== null && props[field] !== false) {
      // A list of marks or unset fields left empty says nothing.
      if (Array.isArray(props[field]) && (props[field] as unknown[]).length === 0) continue;
      return true;
    }
  return false;
}

/**
 * Why a protocol 2 tab's transaction can't be applied, or null when every
 * operation in it is safe: none touches a linked node (`linkedNode`) or one
 * inside one, sets a linking field, deletes or moves a subtree holding one,
 * or creates one; and no create puts back a node the file had (its undo of
 * a delete, which can't bring back what it doesn't see). Its creates are
 * read as made, so a layer it adds may be filled in, in the same edit.
 */
export function protocol2Refusal(reader: Protocol2Reader, ops: readonly Op[]): string | null {
  const made = new Map<string, NodeRecord>();
  const get = (id: string) => made.get(id) ?? reader.get(id);
  // Whether `id`, or anything above it, is linked.
  const inLinked = (id: string): boolean => {
    for (let at = get(id), i = 0; at && i < 1024; at = get(at.parent), i++)
      if (linkedNode(at)) return true;
    return false;
  };
  const creates = ops.filter((op) => op.op === "create").map((op) => op.id);
  const had = creates.length > 0 ? reader.hadOnce(creates) : new Set<string>();
  for (const op of ops) {
    if (op.op === "create") {
      const created: NodeRecord = {
        id: op.id,
        type: op.type,
        parent: op.parent,
        key: op.key,
        props: op.props,
      };
      if (linkedNode(created) || inLinked(op.parent) || had.has(op.id)) return PROTOCOL2_REFUSAL;
      made.set(op.id, created);
      continue;
    }
    if (!get(op.id) || inLinked(op.id)) return PROTOCOL2_REFUSAL;
    if (op.op === "set") {
      if (op.key !== undefined || LINK_FIELDS.has(op.prop)) return PROTOCOL2_REFUSAL;
      continue;
    }
    // A delete or a move takes what's inside along.
    if (!made.has(op.id) && reader.holdsLinked(op.id)) return PROTOCOL2_REFUSAL;
    if (op.op === "move" && inLinked(op.parent)) return PROTOCOL2_REFUSAL;
  }
  return null;
}
