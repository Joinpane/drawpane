/**
 * An instance's component property values (decision 0035, item 3).
 *
 * One place holds a value: the record (`propValues`) of the instance that
 * isn't itself a copy (a top-level instance, or a nested one in a main),
 * keyed by property id, and for the nested instances in its copy by their
 * scope and property id (`propertyKey`). A layer a property drives shows the
 * record's value for its key, or its main layer's when there's none, as
 * it's read: compact copies present it so (`CopyView`), and materialized
 * sync writes it so, from the main and the record alone. Nothing holds it
 * as an override, so there's nothing to keep in step with anything.
 *
 * Editing a driven field by hand writes the record (`drivenEditOps`), a
 * reset removes the key, and each value is written on its own (a keyed
 * `set`, item 15), so two people's values of different properties never
 * undo each other's.
 */
import {
  type ComponentPropDef,
  type ComponentPropType,
  drivenShown,
  getProp,
  hasRecord,
  MAX_PROPERTY_SCOPE,
  MAX_PROPERTY_VALUES,
  MAX_PROPERTY_VALUES_CHARS,
  type NodeRecord,
  type Op,
  PropertyValue,
  type PropRefField,
  propertyKey,
  propertyValueChars,
  propertyValuesChars,
  sameValue,
  splitPropertyKey,
} from "@drawpane/model";
import { componentSetOf, isInstanceRoot, isMainComponent, swapInstanceOps } from "./components";
import type { Doc } from "./doc";
import { layerName } from "./names";

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

/**
 * The id of the layer a main holds itself that `id` copies (through copies
 * of copies): what a record key's scope names a nested instance by, the
 * same in either copy form. A layer that copies nothing is its own.
 */
export function ownLayerId(doc: Doc, id: string): string {
  let at = id;
  for (let i = 0; i < 256; i++) {
    const mirrors = getProp(doc.get(at)?.props ?? {}, "mirrors");
    if (!mirrors || !doc.has(mirrors)) return at;
    at = mirrors;
  }
  return at;
}

/** Where an instance's values are kept: the instance whose record holds them, and its scope there. */
export interface RecordPlace {
  /** The instance that isn't a copy, whose record (`propValues`) holds them. */
  readonly root: string;
  /** The nested instances from it down to this one (`ownLayerId` of each); empty for itself. */
  readonly scope: readonly string[];
}

/**
 * Where an instance's values are kept (decision 0035, item 3): its own
 * record when it isn't a copy; a nested instance in a copy, the record of
 * the instance it's ultimately in, under the scope that leads to it.
 * Undefined when it isn't an instance, or its scope is past the bound.
 */
export function recordPlace(doc: Doc, instanceId: string): RecordPlace | undefined {
  let at = doc.get(instanceId);
  if (!isInstanceRoot(at) || !at) return undefined;
  const scope: string[] = [];
  while (getProp(at.props, "mirrors") !== null) {
    scope.unshift(ownLayerId(doc, at.id));
    const above = ownerOf(doc, at.id);
    if (!above) return undefined;
    at = above;
  }
  if (scope.length > MAX_PROPERTY_SCOPE) return undefined;
  return { root: at.id, scope };
}

/** The record a place's instance keeps its values in. */
export function recordAt(doc: Doc, place: RecordPlace): PropertyValues {
  return getProp(doc.get(place.root)?.props ?? {}, "propValues") as PropertyValues;
}

/** An instance's own values (its record's, under its scope), by property id. */
export function instanceValues(doc: Doc, instanceId: string): PropertyValues {
  const place = recordPlace(doc, instanceId);
  if (!place) return {};
  const record = recordAt(doc, place);
  if (place.scope.length === 0) {
    const out: PropertyValues = {};
    for (const [key, value] of Object.entries(record)) if (!key.includes("/")) out[key] = value;
    return out;
  }
  const prefix = `${place.scope.join("/")}/`;
  const out: PropertyValues = {};
  for (const [key, value] of Object.entries(record))
    if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
      out[key.slice(prefix.length)] = value;
  return out;
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
 * The keyed sets that write `values` (by key; `null` removes one) into a
 * record, only those that change it. Null when the record they leave would
 * be past its bounds (`MAX_PROPERTY_VALUES`, `MAX_PROPERTY_VALUES_CHARS`) or
 * a value isn't one: the record is the only place a value is, so one that
 * doesn't fit isn't set.
 */
export function recordWriteOps(
  doc: Doc,
  rootId: string,
  values: Readonly<Record<string, PropertyValue | null>>,
): Op[] | null {
  const node = doc.get(rootId);
  if (!node) return null;
  const record = getProp(node.props, "propValues") as PropertyValues;
  const next: Record<string, unknown> = { ...record };
  const out: Op[] = [];
  for (const [key, value] of Object.entries(values)) {
    const had = record[key];
    if (value === null) {
      if (had === undefined) continue;
      delete next[key];
      out.push({ op: "set", id: rootId, prop: "propValues", key, value: null });
      continue;
    }
    if (!PropertyValue.safeParse(value).success) return null;
    next[key] = value;
    if (had !== undefined && sameValue(had, value)) continue;
    out.push({ op: "set", id: rootId, prop: "propValues", key, value });
  }
  if (out.length === 0) return out;
  if (Object.keys(next).length > MAX_PROPERTY_VALUES) return null;
  if (propertyValuesChars(next) > MAX_PROPERTY_VALUES_CHARS) return null;
  return out;
}

/**
 * The keyed sets that set an instance's values (by property id; `null`
 * puts one back to its main's), in the record of the instance it's in.
 * Null when they don't fit (`recordWriteOps`), or it has no place.
 */
export function valueOps(
  doc: Doc,
  instanceId: string,
  values: Readonly<Record<string, PropertyValue | null>>,
): Op[] | null {
  const place = recordPlace(doc, instanceId);
  if (!place) return null;
  const keyed: Record<string, PropertyValue | null> = {};
  for (const [id, value] of Object.entries(values)) keyed[propertyKey(place.scope, id)] = value;
  return recordWriteOps(doc, place.root, keyed);
}

/**
 * What makes an instance's first record (decision 0035, item 3), before an
 * edit gives it its first value: a record that exists decides every key, so
 * an instance from before records (materialized, its values on its layers)
 * has every value its layers show that differs from its main layer's folded
 * into it, once; with none, the record is made empty. Keyed sets, committed
 * on their own (never undone with the edit), for each instance root `ops`
 * write a value of that has no record.
 */
export function firstRecordOps(doc: Doc, ops: readonly Op[]): Op[] {
  const out: Op[] = [];
  const seen = new Set<string>();
  for (const op of ops) {
    if (op.op !== "set" || op.prop !== "propValues" || op.key === undefined) continue;
    if (seen.has(op.id)) continue;
    seen.add(op.id);
    const root = doc.get(op.id);
    if (!root || !isInstanceRoot(root) || hasRecord(root.props)) continue;
    if (getProp(root.props, "mirrors") !== null) continue;
    const values = doc.compactCopies ? {} : legacyValues(doc, op.id);
    const entries = Object.entries(values);
    if (entries.length === 0)
      out.push({ op: "set", id: op.id, prop: "propValues", key: op.key, value: null });
    for (const [key, value] of entries)
      out.push({ op: "set", id: op.id, prop: "propValues", key, value });
  }
  return out;
}

/**
 * The values an instance from before records holds on the layers its
 * properties drive (its nested instances' included, under their scope): each
 * key's first layer, in layer order, that shows another value than its main
 * layer's. Within the record's bounds.
 */
function legacyValues(doc: Doc, rootId: string): PropertyValues {
  const out: PropertyValues = {};
  const stack = [...doc.childIds(rootId)].reverse();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = doc.get(id);
    if (!node) continue;
    const kids = doc.childIds(id);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as string);
    const source = doc.get(getProp(node.props, "mirrors") ?? "");
    const refs = getProp(node.props, "propRefs") as Record<string, string | undefined>;
    if (!source) continue;
    const owner = ownerOf(doc, id);
    const place = owner ? recordPlace(doc, owner.id) : undefined;
    if (!owner || !place || place.root !== rootId) continue;
    const defs = instanceDefinitions(doc, owner.id);
    for (const field of ["visible", "characters", "instanceOf"] as const) {
      const propertyId = refs[field];
      const def = propertyId ? defs.find((d) => d.id === propertyId) : undefined;
      if (!propertyId || !def || FIELD_OF[def.type] !== field) continue;
      const key = propertyKey(place.scope, propertyId);
      const value = fieldValue(node, field);
      if (key in out || value === null || sameValue(value, fieldValue(source, field))) continue;
      const next = { ...out, [key]: value };
      if (Object.keys(next).length > MAX_PROPERTY_VALUES) continue;
      if (propertyValuesChars(next) > MAX_PROPERTY_VALUES_CHARS) continue;
      out[key] = value;
    }
  }
  return out;
}

/**
 * What each field a property drives on a copy layer shows, where its link
 * ends or changes form (detach, unlink), as conversion reads it
 * (`drivenShown`, so the three agree): its instance's record's value; its
 * main layer's for a key a record that exists doesn't keep (a reset); the
 * layer's own when the instance keeps no record (from before records). A
 * materialized layer showing another was written before the record's last
 * change. `staged` is the record as operations before these leave it.
 */
export function shownValues(
  doc: Doc,
  node: NodeRecord,
  staged?: Readonly<Record<string, unknown>>,
): Array<{ field: "visible" | "characters" | "instanceOf"; value: PropertyValue }> {
  const owner = ownerOf(doc, node.id);
  const place = owner ? recordPlace(doc, owner.id) : undefined;
  const rootNode = place ? doc.get(place.root) : undefined;
  if (!owner || !place || !rootNode) return [];
  const root = staged ? { ...rootNode.props, propValues: staged } : rootNode.props;
  const refs = getProp(node.props, "propRefs") as Record<string, string | undefined>;
  const defs = instanceDefinitions(doc, owner.id);
  const main = doc.get(getProp(node.props, "mirrors") ?? "")?.props;
  const out: Array<{ field: "visible" | "characters" | "instanceOf"; value: PropertyValue }> = [];
  for (const field of ["visible", "characters", "instanceOf"] as const) {
    const propertyId = refs[field];
    const def = propertyId ? defs.find((d) => d.id === propertyId) : undefined;
    if (!propertyId || !def || FIELD_OF[def.type] !== field) continue;
    const key = propertyKey(place.scope, propertyId);
    const value = drivenShown(field, key, root, node.props, main);
    if (value !== null) out.push({ field, value });
  }
  return out;
}

/**
 * Edits of fields a property drives, inside an instance (typing in the
 * label, hiding the icon, swapping a nested instance by hand), as what they
 * are: edits of the property (decision 0035, item 3). Each such `set` on a
 * copy layer becomes a keyed set of the record its value lives in, and every
 * layer the property drives shows it; other operations are kept as they
 * are, in order. A driven field never holds a value of its own. Each is read
 * against the references the operations before it leave: a layer unlinked
 * and then edited in one transaction gets the edit as its own value, and the
 * property's other layers keep theirs.
 */
export function drivenEditOps(doc: Doc, ops: readonly Op[]): Op[] {
  let out: Op[] | null = null;
  const planned = new Map<string, Record<string, unknown>>();
  const refs = new Map<string, Record<string, string | undefined>>();
  ops.forEach((op, i) => {
    const kept = unlinkedValues(doc, op, refs, planned);
    if (op.op === "set" && op.prop === "propRefs" && op.key === undefined)
      refs.set(op.id, (op.value ?? {}) as Record<string, string | undefined>);
    // A layer no longer a copy (detached): no property drives it.
    if (op.op === "set" && op.prop === "mirrors" && !op.value) refs.set(op.id, {});
    if (kept.length > 0) {
      // Unlinked from a property, a layer keeps what it showed, as its own.
      if (!out) out = ops.slice(0, i);
      out.push(op, ...kept);
      return;
    }
    const write = drivenWrite(doc, op, planned, refs);
    if (write === undefined) {
      out?.push(op);
      return;
    }
    if (!out) out = ops.slice(0, i);
    if (write) out.push(write);
  });
  return out ?? (ops as Op[]);
}

/**
 * A copy layer's references set so a property no longer drives a field
 * (unlinked): the sets that keep that field as it shows now, the layer's
 * own value from then on. None for anything else.
 */
function unlinkedValues(
  doc: Doc,
  op: Op,
  refs: ReadonlyMap<string, Record<string, string | undefined>>,
  planned: ReadonlyMap<string, Record<string, unknown>>,
): Op[] {
  if (op.op !== "set" || op.prop !== "propRefs" || op.key !== undefined) return [];
  const node = doc.get(op.id);
  if (!node || getProp(node.props, "mirrors") === null) return [];
  const before =
    refs.get(op.id) ?? (getProp(node.props, "propRefs") as Record<string, string | undefined>);
  const after = (op.value ?? {}) as Record<string, string | undefined>;
  const out: Op[] = [];
  // What it shows (`shownValues`), as the operations before this leave its record: a
  // materialized layer written before the record's last change can lag, and the record wins.
  const owner = ownerOf(doc, op.id);
  const place = owner ? recordPlace(doc, owner.id) : undefined;
  const staged = place ? planned.get(place.root) : undefined;
  for (const { field, value } of shownValues(doc, node, staged)) {
    if (!before[field] || after[field]) continue;
    if (field !== "instanceOf") {
      out.push({ op: "set", id: op.id, prop: field, value });
      continue;
    }
    // A swap kept as its own: an instance of the component it shows.
    const shown = typeof value === "object" ? value.instance : null;
    if (!shown) continue;
    if (doc.compactCopies) out.push({ op: "set", id: op.id, prop: "instanceOf", value: shown });
    else if (shown !== getProp(node.props, "instanceOf"))
      out.push(...swapInstanceOps(doc, op.id, shown));
  }
  return out;
}

/** The record write a driven edit is; undefined when it isn't one, null when it changes nothing. */
function drivenWrite(
  doc: Doc,
  op: Op,
  planned: Map<string, Record<string, unknown>>,
  refs: ReadonlyMap<string, Record<string, string | undefined>>,
): Op | null | undefined {
  if (op.op !== "set") return undefined;
  const field = op.prop;
  if (field !== "visible" && field !== "characters" && field !== "instanceOf") return undefined;
  const node = doc.get(op.id);
  if (!node || getProp(node.props, "mirrors") === null) return undefined;
  const propertyId = (refs.get(op.id) ?? getProp(node.props, "propRefs"))[field];
  if (!propertyId) return undefined;
  const owner = ownerOf(doc, op.id);
  if (!owner) return undefined;
  const def = instanceDefinitions(doc, owner.id).find((d) => d.id === propertyId);
  if (!def || FIELD_OF[def.type] !== field) return undefined;
  const place = recordPlace(doc, owner.id);
  if (!place) return undefined;
  const key = propertyKey(place.scope, propertyId);
  let value: PropertyValue | null;
  if (field === "visible") value = op.value !== false;
  else if (field === "characters") value = typeof op.value === "string" ? op.value : "";
  else value = typeof op.value === "string" ? { instance: op.value } : null;
  // Swapping back to the main layer's component is its main's value: no record of it.
  if (field === "instanceOf" && typeof value === "object" && value !== null) {
    const source = doc.get(getProp(node.props, "mirrors") as string);
    if (source && getProp(source.props, "instanceOf") === value.instance) value = null;
  }
  const record = planned.get(place.root) ?? {
    ...getProp(doc.get(place.root)?.props ?? {}, "propValues"),
  };
  planned.set(place.root, record);
  const had = record[key];
  if (value === null ? had === undefined : had !== undefined && sameValue(had, value)) return null;
  if (value === null) delete record[key];
  else record[key] = value;
  return { op: "set", id: place.root, prop: "propValues", key, value };
}

/**
 * The instances whose record `ops` write (any `propValues` set): with
 * materialized copies, whose driven layers sync then writes the values.
 */
export function recordsWritten(ops: readonly Op[]): string[] {
  const out = new Set<string>();
  for (const op of ops) if (op.op === "set" && op.prop === "propValues") out.add(op.id);
  return [...out];
}

/**
 * With compact copies, the copy layers whose driven values `ops` changed
 * (keyed sets of a record): for what follows from their new values, a
 * text's size and the layout around it.
 */
export function recordTargets(doc: Doc, ops: readonly Op[]): string[] {
  if (!doc.compactCopies) return [];
  const out: string[] = [];
  for (const op of ops) {
    if (op.op !== "set" || op.prop !== "propValues") continue;
    if (op.key !== undefined) out.push(...doc.drivenBy(op.id, op.key));
    else out.push(...doc.drivenByAll(op.id));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Across a switch: nested instances' values go to the nested instances that match

/** A nested instance in an instance's copy, as a switch matches it (see `nestedTree`). */
export interface NestedInstance {
  /** Its presented id. */
  readonly id: string;
  /** What a record key's scope names it by (`ownLayerId`). */
  readonly own: string;
  /** The component it's an instance of. */
  readonly component: string | null;
  /** Its layer names' path from the instance it's in. */
  readonly path: string;
  /** The nested instances in it, in turn. */
  readonly nested: readonly NestedInstance[];
}

/**
 * Every nested instance in an instance's copy, at every depth, in layer
 * order: what a switch matches (decision 0035, item 3). All of them, those
 * that set nothing too, so an unchanged one keeps its match (review 3).
 */
export function nestedTree(doc: Doc, instanceId: string, depth = 0): NestedInstance[] {
  if (depth > MAX_PROPERTY_SCOPE) return [];
  const out: NestedInstance[] = [];
  const visit = (parent: string, path: string) => {
    for (const id of doc.childIds(parent)) {
      const node = doc.get(id);
      if (!node) continue;
      const at = path ? `${path}/${layerName(node)}` : layerName(node);
      if (isInstanceRoot(node)) {
        out.push({
          id,
          own: ownLayerId(doc, id),
          component: getProp(node.props, "instanceOf"),
          path: at,
          nested: nestedTree(doc, id, depth + 1),
        });
        continue;
      }
      visit(id, at);
    }
  };
  visit(instanceId, "");
  return out;
}

/**
 * Which nested instance after a switch takes which one's values from
 * before, as Figma matches them: the same component at the same layer
 * path; then the same component, in layer order; then the same path (a
 * component swapped meanwhile). Each is matched at most once, every
 * sibling taking part, so one that set nothing keeps its own match.
 */
export function matchNested(
  before: readonly NestedInstance[],
  after: readonly NestedInstance[],
): Array<{ readonly from: NestedInstance; readonly to: NestedInstance }> {
  const used = new Set<NestedInstance>();
  const taken = new Set<NestedInstance>();
  const out: Array<{ from: NestedInstance; to: NestedInstance }> = [];
  const pass = (fits: (old: NestedInstance, now: NestedInstance) => boolean) => {
    for (const now of after) {
      if (taken.has(now)) continue;
      const old = before.find((b) => !used.has(b) && fits(b, now));
      if (!old) continue;
      used.add(old);
      taken.add(now);
      out.push({ from: old, to: now });
    }
  };
  pass((old, now) => old.component === now.component && old.path === now.path);
  pass((old, now) => old.component !== null && old.component === now.component);
  pass((old, now) => old.path === now.path);
  return out;
}

/**
 * The record writes that carry an instance's values across a switch of it
 * (`before`: its nested instances then; it has switched since): its own
 * values stay where the component it's now an instance of defines them;
 * its nested instances' go to the ones that match (`matchNested`), through
 * every level, and go when none does. Other keys of the record are left.
 */
export function carryOps(doc: Doc, instanceId: string, before: readonly NestedInstance[]): Op[] {
  const place = recordPlace(doc, instanceId);
  if (!place) return [];
  const record = recordAt(doc, place);
  const base = place.scope;
  const after = nestedTree(doc, instanceId);
  const defined = (instance: string) =>
    new Set(instanceDefinitions(doc, instance).map((d) => d.id));
  const writes: Record<string, PropertyValue | null> = {};
  /** Where a value under `scope` (relative to the switched instance) goes; null when nowhere. */
  const translate = (scope: readonly string[], property: string): string[] | null => {
    let olds: readonly NestedInstance[] = before;
    let news: readonly NestedInstance[] = after;
    const to: string[] = [];
    let into: string = instanceId;
    for (let i = 0; i < scope.length; i++) {
      const old = olds.find((n) => n.own === scope[i]);
      if (!old) return null;
      const match = matchNested(olds, news).find((m) => m.from === old)?.to;
      if (!match) return null;
      to.push(match.own);
      into = match.id;
      // The same component inside: the rest of the way is the same layers.
      if (old.component === match.component) {
        to.push(...scope.slice(i + 1));
        return to;
      }
      olds = old.nested;
      news = match.nested;
    }
    return defined(into).has(property) ? to : null;
  };
  const own = defined(instanceId);
  for (const [key, value] of Object.entries(record)) {
    const { scope, property } = splitPropertyKey(key);
    if (scope.length < base.length || base.some((id, i) => scope[i] !== id)) continue;
    const below = scope.slice(base.length);
    if (below.length === 0) {
      if (!own.has(property)) writes[key] = null;
      continue;
    }
    const to = translate(below, property);
    const next = to ? propertyKey([...base, ...to], property) : null;
    if (next === key) continue;
    writes[key] = null;
    if (next) writes[next] = value;
  }
  // Removals first, so a value moving where another was isn't removed after it's set.
  const ordered: Record<string, PropertyValue | null> = {};
  for (const [key, value] of Object.entries(writes)) if (value === null) ordered[key] = null;
  for (const [key, value] of Object.entries(writes)) if (value !== null) ordered[key] = value;
  return recordWriteOps(doc, place.root, ordered) ?? [];
}

/**
 * The keyed sets that clear an instance's values, its nested instances'
 * included (Reset all, decision 0035): every key of its record under its
 * scope.
 */
export function clearValueOps(doc: Doc, instanceId: string): Op[] {
  const place = recordPlace(doc, instanceId);
  if (!place) return [];
  const prefix = place.scope.length > 0 ? `${place.scope.join("/")}/` : "";
  return Object.keys(recordAt(doc, place))
    .filter((key) => key.startsWith(prefix))
    .map((key): Op => ({ op: "set", id: place.root, prop: "propValues", key, value: null }));
}

/**
 * The record a nested instance takes when it stops being a copy (its outer
 * instance detached, materialized copies: compact ones do this as they're
 * stored): the outer record's values under its scope, the scope taken off.
 */
export function scopedValues(
  record: Readonly<Record<string, PropertyValue>>,
  own: string,
): PropertyValues | null {
  const out: PropertyValues = {};
  const prefix = `${own}/`;
  for (const [key, value] of Object.entries(record))
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  return Object.keys(out).length > 0 ? out : null;
}

/** The size a record's value takes (for a refusal's message). */
export function valueSize(key: string, value: PropertyValue): number {
  return propertyValueChars(key, value);
}
