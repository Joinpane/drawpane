/**
 * Tabs from before component property records (protocol 2, decision 0035),
 * for the room (apps/worker's file room) and its stand-ins in tests.
 *
 * A tab already open runs the code it loaded, which can't be changed: it
 * knows no `propRefs`, `propValues`, `componentProps` or `exposeProps`, its
 * model refuses an operation that names one, and it would read a keyed set
 * of one value (`key`) as the whole map. Closing it with a reload would lose
 * the edits it holds unsent (they're kept in memory only), so the room keeps
 * it as an editor until it reloads by itself (its update banner waits for
 * its edits to be confirmed, decision 0035):
 *
 * - What it's sent leaves those properties out (`forProtocol2Ops`,
 *   `forProtocol2Nodes`). It may show a property's old value for a while.
 * - What it sends is taken as what it means (`fromProtocol2`): a field a
 *   component property drives, set by hand on a copy layer, is the
 *   property's value, written in the record of the instance it's kept in.
 *   With materialized copies its own instance sync also writes driven
 *   fields, back to the main's value, which a person's edit never is: those
 *   are left out, as the record decides them. A person's edit is marked an
 *   override (its tab marks every edit inside an instance so); sync never
 *   writes a field that's marked.
 */
import type { CopiesFormat } from "./convert";
import type { CopyView, DrivenField } from "./copies";
import type { NodeRecord, Op } from "./ops";
import { type ComponentPropDef, type PropertyValue, propertyKey } from "./schema";

/** Properties a protocol 2 tab doesn't know. */
export const PROTOCOL3_PROPS: ReadonlySet<string> = new Set([
  "componentProps",
  "propRefs",
  "propValues",
  "exposeProps",
]);

/** Fields a component property drives (decision 0035, item 2). */
const DRIVEN: ReadonlySet<string> = new Set(["visible", "characters", "instanceOf"]);

/** The field each property type drives. */
const FIELD_OF: Readonly<Record<string, string>> = {
  boolean: "visible",
  text: "characters",
  instance: "instanceOf",
};

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

/** What `fromProtocol2` reads: the room's nodes, and with compact copies its copy layers as presented. */
export interface Protocol2Reader {
  /** A stored node. */
  get(id: string): NodeRecord | undefined;
  /**
   * With compact copies: the fields of the copy layer `id` (a record's id
   * is its layer's) a property drives, each with its key in its instance
   * root's record, and the layer's main layer as presented.
   */
  driven?(
    id: string,
    root: string,
  ): { fields: readonly (readonly [string, string])[]; source?: NodeRecord };
}

/**
 * `Protocol2Reader.driven` from a `CopyView` of the stored nodes: the copy
 * layer `id` in the instance `root` (an override record's id is its layer's),
 * built (the instance, then the nested instances in it, until it's found),
 * its driven fields and its main layer. None when there's no such layer.
 */
export function copyDriven(
  view: CopyView,
  root: string,
  id: string,
): { fields: readonly DrivenField[]; source?: NodeRecord } {
  let layer = view.get(id);
  if (!layer) {
    const stack = [...view.childIds(root)];
    for (let at = stack.pop(); at !== undefined && !layer; at = stack.pop()) {
      if (at === id) layer = view.get(id);
      else stack.push(...view.childIds(at));
    }
  }
  if (!layer) return { fields: [] };
  const mirrors = layer.props.mirrors;
  const source = typeof mirrors === "string" ? view.get(mirrors) : undefined;
  return { fields: view.drivenFields(id), ...(source ? { source } : {}) };
}

/** A driven field's value as a record keeps it, from what a tab set (`null`: its default). */
function recordValue(
  field: string,
  value: unknown,
  source: NodeRecord | undefined,
): PropertyValue | null {
  if (field === "visible") return value !== false;
  if (field === "characters") return typeof value === "string" ? value : "";
  // A swap back to the main layer's component is its main's value: no record of it.
  if (typeof value !== "string") return null;
  return source?.props.instanceOf === value ? null : { instance: value };
}

const keyedSet = (root: string, key: string, value: PropertyValue | null): Op => ({
  op: "set",
  id: root,
  prop: "propValues",
  key,
  value,
});

/**
 * A protocol 2 tab's operations as they apply now: each edit of a field a
 * component property drives written as the property's value, in its
 * instance's record (see the top). Everything else as it is.
 */
export function fromProtocol2(
  reader: Protocol2Reader,
  copies: CopiesFormat,
  ops: readonly Op[],
): Op[] {
  return copies === "compact" ? fromCompact(reader, ops) : fromMaterialized(reader, ops);
}

function fromCompact(reader: Protocol2Reader, ops: readonly Op[]): Op[] {
  const out: Op[] = [];
  const made = new Set<string>();
  // An override record a tab writes is its copy layer's: the fields a property drives there go
  // to its instance root's record (`CopyView` never reads them from a copy layer's record).
  const drivenOf = (id: string, parent: string) => {
    if (!reader.driven || made.has(parent)) return null;
    const { fields, source } = reader.driven(id, parent);
    return fields.length > 0 ? { keys: new Map(fields.map(([f, k]) => [f, k])), source } : null;
  };
  // Records these operations make, by id: their instance roots.
  const records = new Map<string, string>();
  const rootOf = (id: string) => {
    const stored = reader.get(id);
    return records.get(id) ?? (stored?.type === "override" ? stored.parent : undefined);
  };
  for (const op of ops) {
    if (op.op === "create" && op.type === "override") {
      records.set(op.id, op.parent);
      const driven = drivenOf(op.id, op.parent);
      if (!driven) {
        out.push(op);
        continue;
      }
      const props: Record<string, unknown> = { ...op.props };
      const values: Op[] = [];
      for (const [field, key] of driven.keys) {
        if (field in props) {
          values.push(keyedSet(op.parent, key, recordValue(field, props[field], driven.source)));
          delete props[field];
        }
        const unset = props.unset;
        if (Array.isArray(unset) && unset.includes(field)) {
          values.push(keyedSet(op.parent, key, recordValue(field, null, driven.source)));
          props.unset = unset.filter((f) => f !== field);
        }
        const marks = props.overrides;
        if (Array.isArray(marks)) props.overrides = marks.filter((f) => f !== field);
      }
      for (const list of ["unset", "overrides"])
        if (Array.isArray(props[list]) && (props[list] as unknown[]).length === 0)
          delete props[list];
      out.push({ ...op, props: props as NodeRecord["props"] }, ...values);
      continue;
    }
    if (op.op === "create") made.add(op.id);
    const root = op.op === "set" && op.key === undefined ? rootOf(op.id) : undefined;
    if (op.op !== "set" || root === undefined) {
      out.push(op);
      continue;
    }
    const driven = drivenOf(op.id, root);
    const key = driven?.keys.get(op.prop);
    if (driven && key !== undefined) {
      out.push(keyedSet(root, key, recordValue(op.prop, op.value, driven.source)));
      continue;
    }
    if (driven && (op.prop === "overrides" || op.prop === "unset") && Array.isArray(op.value)) {
      const kept = (op.value as string[]).filter((f) => !driven.keys.has(f));
      if (op.prop === "unset")
        for (const field of op.value as string[]) {
          const k = driven.keys.get(field);
          if (k !== undefined) out.push(keyedSet(root, k, recordValue(field, null, driven.source)));
        }
      out.push({ ...op, value: kept.length > 0 ? kept : null });
      continue;
    }
    out.push(op);
  }
  return out;
}

function fromMaterialized(stored: Protocol2Reader, ops: readonly Op[]): Op[] {
  // Fields its tab marks overridden in these operations: a person's edits (see the top).
  const marked = new Map<string, Set<string>>();
  for (const op of ops)
    if (op.op === "set" && op.prop === "overrides" && Array.isArray(op.value))
      marked.set(op.id, new Set(op.value as string[]));
  // Layers these operations make, read as if made already.
  const made = new Map<string, NodeRecord>();
  const reader: Protocol2Reader = { get: (id) => made.get(id) ?? stored.get(id) };
  const out: Op[] = [];
  for (const op of ops) {
    if (op.op === "create") {
      const created = withReferences(reader, op);
      made.set(op.id, created);
      out.push(created.props === op.props ? op : { ...op, props: created.props });
      continue;
    }
    if (op.op !== "set" || !DRIVEN.has(op.prop) || op.key !== undefined) {
      out.push(op);
      continue;
    }
    const node = reader.get(op.id);
    const place = node ? drivenPlace(reader, node, op.prop) : null;
    if (!node || !place) {
      out.push(op);
      continue;
    }
    const marks =
      marked.get(op.id) ?? new Set((node.props.overrides as string[] | undefined) ?? []);
    // Its tab's instance sync writing what it thinks the main gives: the record decides.
    if (!marks.has(op.prop)) continue;
    const source = node.props.mirrors ? reader.get(node.props.mirrors as string) : undefined;
    out.push(op, keyedSet(place.root, place.key, recordValue(op.prop, op.value, source)));
  }
  return out;
}

/**
 * A copy layer a protocol 2 tab makes (syncing an instance, switching its
 * variant) as the room keeps it: with its main layer's property references,
 * which its tab doesn't know, and the fields they drive showing what its
 * instance's record holds. Anything else as it is.
 */
function withReferences(reader: Protocol2Reader, op: Extract<Op, { op: "create" }>): NodeRecord {
  const node: NodeRecord = {
    id: op.id,
    type: op.type,
    parent: op.parent,
    key: op.key,
    props: op.props,
  };
  const mirrors = op.props.mirrors;
  const refs = typeof mirrors === "string" ? reader.get(mirrors)?.props.propRefs : undefined;
  if (!refs || Object.keys(refs).length === 0 || op.props.propRefs !== undefined) return node;
  const props: Record<string, unknown> = { ...op.props, propRefs: refs };
  const linked: NodeRecord = { ...node, props: props as NodeRecord["props"] };
  for (const field of ["visible", "characters"]) {
    const place = drivenPlace(reader, linked, field);
    if (!place) continue;
    const record = (reader.get(place.root)?.props.propValues ?? {}) as Record<string, unknown>;
    const value = record[place.key];
    if (field === "visible" ? typeof value === "boolean" : typeof value === "string")
      props[field] = value;
  }
  return linked;
}

const isInstanceRoot = (node: NodeRecord | undefined): boolean =>
  node?.type === "frame" && typeof node.props.instanceOf === "string";
const isMain = (node: NodeRecord | undefined) =>
  node?.type === "frame" && node.props.isComponent === true;

/**
 * Where the value of a field a property drives on a stored copy layer is
 * kept: its instance's record root and key there (as the editor's
 * `recordPlace` finds them). Null when no property drives it.
 */
function drivenPlace(
  reader: Protocol2Reader,
  node: NodeRecord,
  field: string,
): { root: string; key: string } | null {
  if (!node.props.mirrors) return null;
  const refs = (node.props.propRefs ?? {}) as Record<string, string | undefined>;
  const propertyId = refs[field];
  if (!propertyId) return null;
  const owner = ownerOf(reader, node);
  if (!owner) return null;
  const def = definitionsOf(reader, owner.props.instanceOf as string).find(
    (d) => d.id === propertyId,
  );
  if (!def || FIELD_OF[def.type] !== field) return null;
  const scope: string[] = [];
  let at: NodeRecord | undefined = owner;
  for (let i = 0; at?.props.mirrors && i < 256; i++) {
    scope.unshift(ownLayerId(reader, at.id));
    at = ownerOf(reader, at);
  }
  if (!at || at.props.mirrors) return null;
  return { root: at.id, key: propertyKey(scope, propertyId) };
}

/** The nearest instance root above a layer, unless a main comes first. */
function ownerOf(reader: Protocol2Reader, node: NodeRecord): NodeRecord | undefined {
  for (let n = reader.get(node.parent), i = 0; n && n.type !== "page" && i < 1024; i++) {
    if (isInstanceRoot(n)) return n;
    if (isMain(n)) return undefined;
    n = reader.get(n.parent);
  }
  return undefined;
}

/** The layer a main holds itself that `id` copies, through copies of copies. */
function ownLayerId(reader: Protocol2Reader, id: string): string {
  let at = id;
  for (let i = 0; i < 256; i++) {
    const mirrors = reader.get(at)?.props.mirrors;
    if (typeof mirrors !== "string" || !reader.get(mirrors)) return at;
    at = mirrors;
  }
  return at;
}

/** A main's properties: its set's, then its own. */
function definitionsOf(reader: Protocol2Reader, mainId: string): ComponentPropDef[] {
  const main = reader.get(mainId);
  if (!isMain(main) || !main) return [];
  const parent = reader.get(main.parent);
  const set = parent?.type === "frame" && parent.props.isComponentSet === true ? parent : null;
  return [set, main].flatMap((owner) => (owner?.props.componentProps ?? []) as ComponentPropDef[]);
}
