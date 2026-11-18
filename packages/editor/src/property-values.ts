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
 */
import {
  type ComponentPropDef,
  type ComponentPropType,
  getProp,
  MAX_PROPERTY_VALUES,
  type NodeRecord,
  type Op,
  type PropertyValue,
  type PropRefField,
} from "@drawpane/model";
import { componentSetOf, isInstanceRoot, isMainComponent, overrideOps } from "./components";
import type { Doc } from "./doc";
import { textRunOps } from "./rich-text";
import { unbindOps } from "./variables";

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
 * (they reference their own main's properties).
 */
export function drivenLayers(doc: Doc, instanceId: string): Map<string, string[]> {
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
 * before records, and imports, keep values there). Writing this back is how
 * an instance's values get a record (decision 0035: "existing files").
 */
export function effectiveValues(doc: Doc, instanceId: string): PropertyValues {
  const instance = doc.get(instanceId);
  if (!instance) return {};
  const out: PropertyValues = { ...getProp(instance.props, "propValues") };
  const defs = instanceDefinitions(doc, instanceId);
  if (defs.length === 0) return out;
  const refs = drivenLayers(doc, instanceId);
  for (const def of defs) {
    if (def.id in out) continue;
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
 * `values` with only the keys the instance's main (or its set) defines, at
 * most `MAX_PROPERTY_VALUES`: a switch or a write drops the rest.
 */
export function prunedValues(doc: Doc, instanceId: string, values: PropertyValues): PropertyValues {
  const defined = new Set(instanceDefinitions(doc, instanceId).map((d) => d.id));
  const out: PropertyValues = {};
  let n = 0;
  for (const [id, value] of Object.entries(values)) {
    if (!defined.has(id) || n >= MAX_PROPERTY_VALUES) continue;
    out[id] = value;
    n++;
  }
  return out;
}

/** The operation that writes an instance's record (none when it already holds `values`). */
export function recordOp(doc: Doc, instanceId: string, values: PropertyValues): Op[] {
  const node = doc.get(instanceId);
  if (!node) return [];
  const before = getProp(node.props, "propValues");
  if (JSON.stringify(before) === JSON.stringify(values)) return [];
  return [
    {
      op: "set",
      id: instanceId,
      prop: "propValues",
      value: Object.keys(values).length > 0 ? values : null,
    },
  ];
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
 * other layer the property drives there. Returns those extra operations.
 */
export function propertyFollowOps(doc: Doc, ops: readonly Op[]): Op[] {
  const writesRecord = new Set<string>();
  const pending = new Set<string>();
  for (const op of ops)
    if (op.op === "set") {
      if (op.prop === "propValues") writesRecord.add(op.id);
      if (op.prop === "visible" || op.prop === "characters") pending.add(refKey(op.id, op.prop));
    }
  const records = new Map<string, PropertyValues>();
  const refsOf = new Map<string, Map<string, string[]>>();
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
    const record = records.get(owner.id) ?? { ...getProp(owner.props, "propValues") };
    record[propertyId] = value;
    records.set(owner.id, record);
    let refs = refsOf.get(owner.id);
    if (!refs) {
      refs = drivenLayers(doc, owner.id);
      refsOf.set(owner.id, refs);
    }
    for (const id of refs.get(refKey(propertyId, op.prop)) ?? []) {
      if (pending.has(refKey(id, op.prop))) continue;
      pending.add(refKey(id, op.prop));
      const other = doc.get(id);
      if (!other || fieldValue(other, op.prop) === value) continue;
      out.push({ op: "set", id, prop: op.prop, value: op.value });
    }
  }
  for (const [id, record] of records) out.push(...recordOp(doc, id, prunedValues(doc, id, record)));
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
