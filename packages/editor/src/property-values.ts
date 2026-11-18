/**
 * An instance's component property values (decision 0035, item 3).
 *
 * An instance holds the values it set in `propValues`, by property id. Every
 * layer in its copy that references the id (`propRefs`), down to but not
 * inside nested instances, holds the value as an override of the field it
 * drives: that's what draws, and what compact records, the room and the
 * converter read. The record is what lasts when those layers change: a
 * variant switch, a layer named differently, a layer the main adds. The
 * functions here read the record, write it, and make the layers agree.
 *
 * Each value is written on its own (a `set` with a `key`, item 15): two
 * people setting different properties of one instance both keep theirs,
 * undo puts back one value, and a branch merges each value by itself.
 */
import {
  type ComponentPropDef,
  type ComponentPropType,
  getProp,
  MAX_PROPERTY_VALUES_CHARS,
  type NodeRecord,
  type Op,
  type PropertyValue,
  type PropRefField,
  propertyValueChars,
  propertyValuesChars,
  sameValue,
} from "@drawpane/model";
import { componentSetOf, isInstanceRoot, isMainComponent, overrideOps } from "./components";
import type { Doc } from "./doc";
import { layerName } from "./names";
import { textRunOps } from "./rich-text";
import { KEYS_BY_PROP, unbindOps } from "./variables";

/** The value of a layer each property type drives. */
export const FIELD_OF: Readonly<Partial<Record<ComponentPropType, PropRefField>>> = {
  boolean: "visible",
  text: "characters",
  instance: "instanceOf",
};

export type PropertyValues = Record<string, PropertyValue>;

/** Every property a main shows: its set's, then its own (ids once). */
export function definitionsOf(doc: Doc, mainId: string): ComponentPropDef[] {
  const main = doc.get(mainId);
  if (!isMainComponent(main) || !main) return [];
  const set = componentSetOf(doc, mainId);
  const out: ComponentPropDef[] = [];
  const seen = new Set<string>();
  for (const owner of set ? [set, main] : [main])
    for (const def of getProp(owner.props, "componentProps"))
      if (!seen.has(def.id)) {
        seen.add(def.id);
        out.push(def);
      }
  return out;
}

/** The definitions of the main an instance follows. */
export function instanceDefinitions(doc: Doc, instanceId: string): ComponentPropDef[] {
  const instance = doc.get(instanceId);
  const mainId =
    instance && isInstanceRoot(instance) ? getProp(instance.props, "instanceOf") : null;
  return mainId ? definitionsOf(doc, mainId) : [];
}

/** The key `drivenLayers` files a property's layers under. */
export const refKey = (propertyId: string, field: string) => `${propertyId}\u0000${field}`;

/**
 * The layers in an instance's copy that reference each property, by field:
 * at any depth, nested instances included, but not the layers inside them
 * (they reference their own main's properties). Kept while the document's
 * structure (`Doc.structure`) stays the same, so typing in a driven text
 * reads its few layers, not the instance's whole copy (decision 0035).
 * Callers don't change what it returns.
 */
export function drivenLayers(doc: Doc, instanceId: string): ReadonlyMap<string, readonly string[]> {
  let cache = DRIVEN.get(doc);
  if (!cache || cache.structure !== doc.structure) {
    cache = { structure: doc.structure, byOwner: new Map() };
    DRIVEN.set(doc, cache);
  }
  const known = cache.byOwner.get(instanceId);
  if (known) return known;
  const found = scanDriven(doc, instanceId);
  if (cache.byOwner.size >= DRIVEN_OWNERS) cache.byOwner.clear();
  cache.byOwner.set(instanceId, found);
  return found;
}

/** The instances `drivenLayers` keeps at most, per document, before it starts again. */
const DRIVEN_OWNERS = 4096;

const DRIVEN = new WeakMap<
  Doc,
  { structure: number; byOwner: Map<string, ReadonlyMap<string, readonly string[]>> }
>();

function scanDriven(doc: Doc, instanceId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const stack = [...doc.childIds(instanceId)].reverse();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = doc.get(id);
    if (!node) continue;
    for (const [field, propertyId] of Object.entries(getProp(node.props, "propRefs"))) {
      if (!propertyId) continue;
      const key = refKey(propertyId, field);
      const list = out.get(key);
      if (list) list.push(id);
      else out.set(key, [id]);
    }
    if (isInstanceRoot(node)) continue;
    const kids = doc.childIds(id);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as string);
  }
  return out;
}

/**
 * The instance whose properties a layer's references name: the nearest
 * instance root above it, when it's inside one (a layer of a main, outside
 * its nested instances, has none: it holds the main's defaults).
 */
export function ownerOf(doc: Doc, id: string): NodeRecord | undefined {
  const node = doc.get(id);
  if (!node) return undefined;
  for (let n = doc.get(node.parent); n && n.type !== "page"; n = doc.get(n.parent)) {
    if (isInstanceRoot(n)) return n;
    if (isMainComponent(n)) return undefined;
  }
  return undefined;
}

/** A layer's value for the field a property drives, as a record holds it. */
export function fieldValue(node: NodeRecord, field: PropRefField): PropertyValue | null {
  if (field === "visible") return getProp(node.props, "visible");
  if (field === "characters") return getProp(node.props, "characters");
  if (field === "instanceOf") {
    const of = getProp(node.props, "instanceOf");
    return of ? { instance: of } : null;
  }
  return null;
}

/** Whether a value suits a field (a record can outlive a definition whose type changed). */
function fits(field: PropRefField, value: PropertyValue): boolean {
  if (field === "visible") return typeof value === "boolean";
  if (field === "characters") return typeof value === "string";
  if (field === "instanceOf") return typeof value === "object" && value !== null;
  return false;
}

/** A row's value (a boolean, a text, a component id) as a record holds it. */
export function toRecordValue(
  type: ComponentPropType,
  value: boolean | string,
): PropertyValue | null {
  if (type === "boolean") return typeof value === "boolean" ? value : null;
  if (type === "text") return typeof value === "string" ? value : null;
  if (type === "instance") return typeof value === "string" ? { instance: value } : null;
  return null;
}

/** A record's value as a row shows it. */
export function fromRecordValue(value: PropertyValue): boolean | string {
  return typeof value === "object" ? value.instance : value;
}

/**
 * The values an instance has set: its record, and, for a property it has
 * no value for, the value a driven layer holds as an override (files from
 * before records, and imports, keep values there; so does a value too long
 * for the record). Writing this back is how an instance's values get a
 * record (decision 0035: "existing files").
 */
export function effectiveValues(doc: Doc, instanceId: string): PropertyValues {
  const instance = doc.get(instanceId);
  if (!instance) return {};
  return { ...getProp(instance.props, "propValues"), ...legacyValues(doc, instanceId) };
}

/**
 * The values an instance holds only on its layers (see `effectiveValues`):
 * for each property its record has no value for, the first driven layer
 * that holds it as an override, in layer order. Definitions' order.
 */
export function legacyValues(doc: Doc, instanceId: string): PropertyValues {
  const instance = doc.get(instanceId);
  if (!instance) return {};
  const record = getProp(instance.props, "propValues");
  const out: PropertyValues = {};
  const defs = instanceDefinitions(doc, instanceId);
  if (defs.length === 0) return out;
  const refs = drivenLayers(doc, instanceId);
  for (const def of defs) {
    if (def.id in record) continue;
    const field = FIELD_OF[def.type];
    if (!field) continue;
    for (const id of refs.get(refKey(def.id, field)) ?? []) {
      const node = doc.get(id);
      if (!node || !getProp(node.props, "overrides").includes(field)) continue;
      const value = fieldValue(node, field);
      if (value !== null) out[def.id] = value;
      break;
    }
  }
  return out;
}

/**
 * The operations that write `values` into an instance's record, a value at
 * a time (`null` removes one): only those that change it, only for
 * properties its main (or set) defines, and only while the record stays
 * within `MAX_PROPERTY_VALUES_CHARS`. A value that doesn't fit isn't
 * recorded (one the record held for it goes, so the record never says
 * otherwise than the layers): its layers hold it, as before records. A
 * value whose definition is gone (dormant) is dropped as the record is
 * written (decision 0035, item 3). In `values`' order, so adopting a
 * file's values takes the first ones first.
 */
export function recordOps(
  doc: Doc,
  instanceId: string,
  values: Readonly<Record<string, PropertyValue | null>>,
): Op[] {
  const node = doc.get(instanceId);
  if (!node) return [];
  const record = getProp(node.props, "propValues");
  const defined = new Set(instanceDefinitions(doc, instanceId).map((d) => d.id));
  const out: Op[] = [];
  const remove = (key: string) => {
    out.push({ op: "set", id: instanceId, prop: "propValues", key, value: null });
  };
  let chars = propertyValuesChars(record);
  for (const key of Object.keys(record))
    if (!defined.has(key)) {
      remove(key);
      chars -= propertyValueChars(key, record[key]);
    }
  for (const [key, value] of Object.entries(values)) {
    if (!defined.has(key)) continue;
    const had = record[key];
    if (value === null) {
      if (had !== undefined) {
        remove(key);
        chars -= propertyValueChars(key, had);
      }
      continue;
    }
    if (had !== undefined && sameValue(had, value)) continue;
    const next = chars - (had === undefined ? 0 : propertyValueChars(key, had));
    if (next + propertyValueChars(key, value) > MAX_PROPERTY_VALUES_CHARS) {
      if (had !== undefined) {
        remove(key);
        chars = next;
      }
      continue;
    }
    out.push({ op: "set", id: instanceId, prop: "propValues", key, value });
    chars = next + propertyValueChars(key, value);
  }
  return out;
}

/** `values` less the keys `drop` has. */
export function withoutKeys(values: PropertyValues, drop: Readonly<object>): PropertyValues {
  const out: PropertyValues = {};
  for (const [key, value] of Object.entries(values)) if (!(key in drop)) out[key] = value;
  return out;
}

export interface Application {
  /** Values to set on driven layers (visibility, text), each marked overridden. */
  readonly ops: Op[];
  /** Nested instances a swap property's value swaps (structural: the editor swaps them). */
  readonly swaps: Array<{ readonly id: string; readonly component: string }>;
  /** Nested instances that already are the chosen component, to mark swapped. */
  readonly swapMarks: string[];
}

/**
 * What makes an instance's driven layers hold its values: every layer that
 * references a property it has a value for, and doesn't hold it as an
 * override, takes it. Layers of properties it has no value for are left.
 */
export function applicationOf(doc: Doc, instanceId: string, values: PropertyValues): Application {
  const out: Application = { ops: [], swaps: [], swapMarks: [] };
  if (Object.keys(values).length === 0) return out;
  const defs = instanceDefinitions(doc, instanceId);
  const refs = drivenLayers(doc, instanceId);
  for (const def of defs) {
    const value = values[def.id];
    const field = FIELD_OF[def.type];
    if (value === undefined || !field || !fits(field, value)) continue;
    for (const id of refs.get(refKey(def.id, field)) ?? []) {
      const node = doc.get(id);
      if (!node) continue;
      const marked = getProp(node.props, "overrides").includes(field);
      if (field === "instanceOf") {
        const want = (value as { instance: string }).instance;
        if (getProp(node.props, "instanceOf") !== want) out.swaps.push({ id, component: want });
        else if (!marked && getProp(node.props, "mirrors") !== null) out.swapMarks.push(id);
        continue;
      }
      if (field === "slot") continue;
      const have = fieldValue(node, field);
      if (marked && have === value) continue;
      // Set even when equal, so it's marked: the instance's value, not the main's, from now on.
      out.ops.push({
        op: "set",
        id,
        prop: field,
        value: field === "visible" ? (value ? null : false) : value,
      });
    }
  }
  return out;
}

/**
 * Operations as a person's edit records them, for a batch committed without
 * the editor's own marking (derived writes): the overrides they make, the
 * variable bindings they detach, text runs kept to the new text, and the
 * swap marks given.
 */
export function asEditOps(doc: Doc, ops: readonly Op[], swapMarks: readonly string[] = []): Op[] {
  const all = [...ops, ...unbindOps(doc, ops), ...textRunOps(doc, ops)];
  const marks = overrideOps(doc, all);
  for (const id of swapMarks) {
    const index = marks.findIndex((o) => o.op === "set" && o.id === id);
    const current =
      index === -1
        ? getProp(doc.get(id)?.props ?? {}, "overrides")
        : ((marks[index] as { value: string[] }).value ?? []);
    if (current.includes("instanceOf")) continue;
    const op: Op = { op: "set", id, prop: "overrides", value: [...current, "instanceOf"].sort() };
    if (index === -1) marks.push(op);
    else marks[index] = op;
  }
  return [...all, ...marks];
}

/**
 * A person's edit of a field a property drives, inside an instance (typing
 * in the label, hiding the icon), is an edit of the property (decision
 * 0035, item 3): the instance's record takes the value, and so does every
 * other layer the property drives there, each marked as the instance's
 * own (and its variable detached) even where it holds the value already:
 * equal now isn't following the main later. An instance's first record
 * takes the values its layers hold from before records too, so a later
 * change to its layers can't lose them. Returns those extra operations.
 *
 * Reads only the layers the property drives (`drivenLayers` keeps them),
 * not the instance's copy, so it's cheap per keystroke.
 */
export function propertyFollowOps(doc: Doc, ops: readonly Op[]): Op[] {
  const writesRecord = new Set<string>();
  const pending = new Set<string>();
  for (const op of ops)
    if (op.op === "set") {
      if (op.prop === "propValues") writesRecord.add(op.id);
      if (op.prop === "visible" || op.prop === "characters") pending.add(refKey(op.id, op.prop));
    }
  // Per instance: the values edited, and those its layers held from before records.
  const records = new Map<string, { edited: PropertyValues; adopted: PropertyValues }>();
  const out: Op[] = [];
  for (const op of ops) {
    if (op.op !== "set" || (op.prop !== "visible" && op.prop !== "characters")) continue;
    const node = doc.get(op.id);
    if (!node || getProp(node.props, "mirrors") === null) continue;
    const propertyId = getProp(node.props, "propRefs")[op.prop];
    if (!propertyId) continue;
    const owner = ownerOf(doc, op.id);
    if (!owner || writesRecord.has(owner.id)) continue;
    const def = instanceDefinitions(doc, owner.id).find((d) => d.id === propertyId);
    if (!def || FIELD_OF[def.type] !== op.prop) continue;
    const value: PropertyValue =
      op.prop === "visible" ? op.value !== false : typeof op.value === "string" ? op.value : "";
    let record = records.get(owner.id);
    if (!record) {
      // What the instance holds only on its layers is recorded with it (the first write).
      record = { edited: {}, adopted: legacyValues(doc, owner.id) };
      records.set(owner.id, record);
    }
    record.edited[propertyId] = value;
    const keys = KEYS_BY_PROP.get(op.prop) ?? [];
    for (const id of drivenLayers(doc, owner.id).get(refKey(propertyId, op.prop)) ?? []) {
      if (pending.has(refKey(id, op.prop))) continue;
      pending.add(refKey(id, op.prop));
      const other = doc.get(id);
      if (!other) continue;
      const pinned =
        getProp(other.props, "overrides").includes(op.prop) &&
        fieldValue(other, op.prop) === value &&
        !keys.some((k) => getProp(other.props, "bindings")[k]);
      if (!pinned) out.push({ op: "set", id, prop: op.prop, value: op.value });
    }
  }
  // The edited values first, so the record takes them before those it adopts if not all fit.
  for (const [id, { edited, adopted }] of records)
    out.push(...recordOps(doc, id, { ...edited, ...withoutKeys(adopted, edited) }));
  return out;
}

/**
 * The instances whose driven layers may have changed in `ops`, and that
 * have values to give them: a layer made (by sync, a swap, or in a main
 * whose compact copies present it at once) or newly referencing a property.
 */
export function ownersToApply(
  doc: Doc,
  ops: readonly Op[],
  instancesOfMains: (ids: readonly string[]) => Iterable<string>,
): string[] {
  const out = new Set<string>();
  const inMains: string[] = [];
  const consider = (id: string | undefined) => {
    const node = id ? doc.get(id) : undefined;
    if (node && Object.keys(getProp(node.props, "propValues")).length > 0) out.add(node.id);
  };
  for (const op of ops) {
    const relevant =
      op.op === "create" ||
      (op.op === "set" && (op.prop === "propRefs" || op.prop === "instanceOf"));
    if (!relevant || !doc.has(op.id)) continue;
    if (op.op === "set" && op.prop === "instanceOf") consider(op.id);
    const owner = ownerOf(doc, op.id);
    if (owner) consider(owner.id);
    // In a main: only a layer that references a property can need a value from its instances.
    else if (op.op === "set" ? op.prop === "propRefs" : op.op === "create" && !!op.props.propRefs)
      inMains.push(op.id);
  }
  if (inMains.length > 0) for (const id of instancesOfMains(inMains)) consider(id);
  return [...out];
}

/** A nested instance's values, from before its outer instance switched (see `nestedValues`). */
export interface NestedValues {
  /** Its layer names' path from the instance it's in. */
  readonly path: string;
  /** The component it was an instance of. */
  readonly component: string | null;
  readonly values: PropertyValues;
  /** The nested instances in it, in turn. */
  readonly nested: readonly NestedValues[];
}

/** The nested instances directly in an instance's copy (not inside other nested ones), in layer order. */
export function nestedInstances(
  doc: Doc,
  instanceId: string,
): Array<{ id: string; path: string; component: string | null }> {
  const out: Array<{ id: string; path: string; component: string | null }> = [];
  const visit = (parent: string, path: string) => {
    for (const id of doc.childIds(parent)) {
      const node = doc.get(id);
      if (!node) continue;
      const at = path ? `${path}/${layerName(node)}` : layerName(node);
      if (isInstanceRoot(node)) {
        out.push({ id, path: at, component: getProp(node.props, "instanceOf") });
        continue;
      }
      visit(id, at);
    }
  };
  visit(instanceId, "");
  return out;
}

/**
 * What the nested instances in an instance's copy set, at every depth, to
 * carry across a switch of the instance (decision 0035, item 3): the
 * switch rebuilds its copy, and with it every nested instance's record.
 * Only those that set something.
 */
export function nestedValues(doc: Doc, instanceId: string, depth = 0): NestedValues[] {
  if (depth > 32) return [];
  const out: NestedValues[] = [];
  for (const { id, path, component } of nestedInstances(doc, instanceId)) {
    const values = effectiveValues(doc, id);
    const nested = nestedValues(doc, id, depth + 1);
    if (Object.keys(values).length > 0 || nested.length > 0)
      out.push({ path, component, values, nested });
  }
  return out;
}

/**
 * Which nested instance after a switch takes which one's values from
 * before, as Figma matches them: the same component at the same layer
 * path; then the same component, in layer order; then the same path (a
 * component swapped meanwhile, whose values go by property id where the
 * new one defines them). Each is matched at most once.
 */
export function matchNested(
  before: readonly NestedValues[],
  after: ReadonlyArray<{ id: string; path: string; component: string | null }>,
): Array<{ id: string; from: NestedValues }> {
  const used = new Set<NestedValues>();
  const taken = new Set<string>();
  const out: Array<{ id: string; from: NestedValues }> = [];
  const pass = (fits: (old: NestedValues, now: (typeof after)[number]) => boolean) => {
    for (const now of after) {
      if (taken.has(now.id)) continue;
      const old = before.find((b) => !used.has(b) && fits(b, now));
      if (!old) continue;
      used.add(old);
      taken.add(now.id);
      out.push({ id: now.id, from: old });
    }
  };
  pass((old, now) => old.component === now.component && old.path === now.path);
  pass((old, now) => old.component !== null && old.component === now.component);
  pass((old, now) => old.path === now.path);
  return out;
}
