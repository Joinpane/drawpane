/**
 * Components and instances.
 *
 * Instances are materialized: an instance is a frame (`instanceOf` = main
 * component id) whose descendants are real nodes, each `mirrors`-linked to
 * the main component's node it copies. Renderer, layout and hit testing need
 * no special cases.
 *
 * The client that edits a main component writes the same change into every
 * instance in the same transaction (like auto layout), skipping properties an
 * instance overrode. Editing a layer inside an instance records an override.
 * Syncing is a pure function of the document, so every client agrees.
 *
 * With compact copies (decision 0029, `Doc.compactCopies`), copies aren't
 * written at all: the document presents them from their main, an edit to a
 * main is the main's own, and only the instances whose layout differs are
 * laid out again (`relayoutTargets`).
 */
import {
  applyPropertyValues,
  boundaryDrivenProps,
  constrainedValues,
  copyChildId,
  type DrivenField,
  getProp,
  isMainNode,
  isPropName,
  laidOutProps,
  migrateRecords,
  type NodeRecord,
  newId,
  type Op,
  type PropertyValue,
  type PropName,
  type PropRefField,
  type Props,
  propertyKey,
} from "@drawpane/model";
import { LAYOUT_NEUTRAL } from "./compact-copies";
import { type Doc, Doc as DocCtor } from "./doc";
import { gridImportOps } from "./layout";
import { layerName } from "./names";
import {
  clearValueOps,
  fieldValue,
  ownLayerId,
  recordAt,
  recordPlace,
  scopedValues,
  shownValues,
} from "./property-values";

/**
 * Never copied from a main component: they link instances or describe the
 * main itself (its variant values and its properties, decision 0035).
 */
const LINK_PROPS: ReadonlySet<string> = new Set([
  "isComponent",
  "componentDescription",
  "variantProps",
  "componentProps",
  // What one instance set (decision 0035): each copy holds its own.
  "propValues",
  "mirrors",
  "overrides",
]);

/**
 * Not synced onto an instance root: they describe where the instance sits in
 * its own parent, not what it looks like.
 */
const ROOT_LOCAL_PROPS: ReadonlySet<string> = new Set([
  "x",
  "y",
  "rotation",
  "flipX",
  "flipY",
  "lockAspect",
  "positioning",
  "constraintH",
  "constraintV",
  "instanceOf",
  // How it's used in the main around it (decision 0035): which properties drive it, and
  // whether it shows its own on that main's instances.
  "propRefs",
  "exposeProps",
]);

export function isMainComponent(node: NodeRecord | undefined): boolean {
  return node?.type === "frame" && getProp(node.props, "isComponent");
}

export function isInstanceRoot(node: NodeRecord | undefined): boolean {
  return node?.type === "frame" && getProp(node.props, "instanceOf") !== null;
}

/** The nearest instance root at or above `id`, if any. */
export function instanceRootOf(doc: Doc, id: string): NodeRecord | undefined {
  for (let node = doc.get(id); node && node.type !== "page"; node = doc.get(node.parent)) {
    if (isInstanceRoot(node)) return node;
  }
  return undefined;
}

/**
 * The instance a layer is ultimately part of: its outermost instance root (a
 * nested instance's copies follow through the instance it's in).
 */
export function outermostInstanceOf(doc: Doc, id: string): NodeRecord | undefined {
  let found: NodeRecord | undefined;
  for (let node = doc.get(id); node && node.type !== "page"; node = doc.get(node.parent)) {
    if (isInstanceRoot(node)) found = node;
    if (isMainComponent(node)) break;
  }
  return found;
}

/** The nearest main component at or above `id`, if any. */
export function componentOf(doc: Doc, id: string): NodeRecord | undefined {
  for (let node = doc.get(id); node && node.type !== "page"; node = doc.get(node.parent)) {
    if (isMainComponent(node)) return node;
  }
  return undefined;
}

/** True when `id` is a layer inside an instance (not the instance root itself). */
export function isInsideInstance(doc: Doc, id: string): boolean {
  const node = doc.get(id);
  if (!node) return false;
  const root = instanceRootOf(doc, node.parent);
  return root !== undefined;
}

/** Each main component's instances, and what each instance is of, as of `version`. */
interface InstanceIndex {
  version: number;
  readonly of: Map<string, string>;
  readonly instances: Map<string, Set<string>>;
  /** `instances` as lists, made when asked for and dropped when they change. */
  readonly lists: Map<string, readonly string[]>;
}

const indexCache = new WeakMap<Doc, InstanceIndex>();

const instanceOf = (node: NodeRecord | undefined) =>
  node?.type === "frame" ? getProp(node.props, "instanceOf") : null;

/**
 * The instances index, caught up with the document. It's read whole once,
 * then follows the document's change log (`changesSince`), so in a kit-sized
 * file an edit doesn't mean reading every layer again; it's read whole again
 * only when the log can't say what changed (a reset, or a long way behind).
 */
function instanceIndex(doc: Doc): InstanceIndex {
  const cached = indexCache.get(doc);
  if (cached) {
    if (cached.version === doc.version) return cached;
    const changes = doc.changesSince(cached.version);
    if (changes && !changes.some((c) => c.reset)) {
      for (const change of changes)
        for (const id of change.ids) {
          const now = instanceOf(doc.get(id));
          const was = cached.of.get(id) ?? null;
          if (now === was) continue;
          if (was !== null) {
            cached.instances.get(was)?.delete(id);
            cached.lists.delete(was);
            cached.of.delete(id);
          }
          if (now !== null) {
            let set = cached.instances.get(now);
            if (!set) {
              set = new Set();
              cached.instances.set(now, set);
            }
            set.add(id);
            cached.lists.delete(now);
            cached.of.set(id, now);
          }
        }
      cached.version = doc.version;
      return cached;
    }
  }
  const index: InstanceIndex = {
    version: doc.version,
    of: new Map(),
    instances: new Map(),
    lists: new Map(),
  };
  for (const node of doc.nodes()) {
    const of = instanceOf(node);
    if (!of) continue;
    index.of.set(node.id, of);
    let set = index.instances.get(of);
    if (!set) {
      set = new Set();
      index.instances.set(of, set);
    }
    set.add(node.id);
  }
  indexCache.set(doc, index);
  return index;
}

/** Instance ids of each main component, kept up to date with the document. */
export function instancesOf(doc: Doc, componentId: string): readonly string[] {
  const index = instanceIndex(doc);
  let list = index.lists.get(componentId);
  if (!list) {
    list = [...(index.instances.get(componentId) ?? [])];
    index.lists.set(componentId, list);
  }
  return list;
}

/**
 * The components an instance can swap to: every main component but its own,
 * and none that would put a component inside itself. Variants read
 * "Set / Variant", in the order they appear in the file.
 */
export function swapTargets(
  doc: Doc,
  instanceId: string,
): { readonly id: string; readonly label: string }[] {
  const instance = doc.get(instanceId);
  const current = instance ? getProp(instance.props, "instanceOf") : null;
  if (!instance || current === null) return [];
  return listComponents(doc)
    .filter((c) => c.id !== current && !wouldCycle(doc, c.id, instance.parent))
    .map((c) => {
      const set = componentSetOf(doc, c.id);
      const name = getProp(c.props, "name") || "Component";
      return { id: c.id, label: set ? `${getProp(set.props, "name") || "Set"} / ${name}` : name };
    });
}

/** Every main component in the file, in document order. */
export function listComponents(doc: Doc): NodeRecord[] {
  const out: NodeRecord[] = [];
  const walk = (parent: string) => {
    for (const id of doc.childIds(parent)) {
      const node = doc.get(id);
      if (!node) continue;
      if (isMainComponent(node)) out.push(node);
      walk(id);
    }
  };
  for (const page of doc.pageIds()) walk(page);
  return out;
}

/** Would placing an instance of `componentId` under `parent` make a component contain itself? */
export function wouldCycle(doc: Doc, componentId: string, parent: string): boolean {
  const seen = new Set<string>();
  const containsInstanceOf = (rootId: string, target: string): boolean => {
    if (seen.has(rootId)) return false;
    seen.add(rootId);
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      const node = doc.get(id);
      if (!node) continue;
      const of = node.type === "frame" ? getProp(node.props, "instanceOf") : null;
      if (of === target) return true;
      if (of && containsInstanceOf(of, target)) return true;
      stack.push(...doc.childIds(id));
    }
    return false;
  };
  // Placing inside the component itself, or inside any component that the
  // placed component (transitively) contains.
  for (let node = doc.get(parent); node && node.type !== "page"; node = doc.get(node.parent)) {
    if (node.id === componentId) return true;
    if (isMainComponent(node) && containsInstanceOf(componentId, node.id)) return true;
  }
  return false;
}

/** The components a subtree holds instances of. */
function instancedIn(doc: Doc, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const node = doc.get(stack.pop() as string);
    if (!node) continue;
    const of = node.type === "frame" ? getProp(node.props, "instanceOf") : null;
    if (of) out.add(of);
    stack.push(...doc.childIds(node.id));
  }
  return out;
}

/**
 * Whether layers can go under `parent`: never into or out of an instance
 * (its layers come from its main component), and never so that a component
 * would hold an instance of itself, however deep. Moving, dropping and
 * pasting all ask.
 */
export function canMoveInto(doc: Doc, ids: readonly string[], parent: string): boolean {
  if (instanceRootOf(doc, parent)) return false;
  if (ids.some((id) => isInsideInstance(doc, id))) return false;
  for (const id of ids)
    for (const componentId of instancedIn(doc, id))
      if (wouldCycle(doc, componentId, parent)) return false;
  return true;
}

/**
 * Operations that create an instance of `componentId` under `parent`, with its
 * root's top-left at `origin` (in the parent's coordinate space).
 */
export function instantiateOps(
  doc: Doc,
  componentId: string,
  parent: string,
  key: string,
  origin: { x: number; y: number },
): { ops: Op[]; rootId: string } | null {
  const main = doc.get(componentId);
  if (!isMainComponent(main) || !main) return null;
  const ops: Op[] = [];
  const rootId = newId();
  const visit = (
    node: NodeRecord,
    copyId: string,
    copyParent: string,
    copyKey: string,
    isRoot: boolean,
  ) => {
    const props: Record<string, unknown> = {};
    for (const [prop, value] of Object.entries(node.props)) {
      if (LINK_PROPS.has(prop)) continue;
      props[prop] = value;
    }
    if (isRoot) {
      props.instanceOf = componentId;
      // Its record, empty: an instance always keeps one (decision 0035, item 3).
      props.propValues = {};
      // An instance of a variant is named after its set ("Button"), like Figma.
      const set = componentSetOf(doc, componentId);
      if (set) props.name = getProp(set.props, "name");
      props.x = origin.x;
      props.y = origin.y;
      delete props.positioning;
      delete props.constraintH;
      delete props.constraintV;
    } else {
      props.mirrors = node.id;
    }
    ops.push({
      op: "create",
      id: copyId,
      type: node.type,
      parent: copyParent,
      key: copyKey,
      props: props as Props,
    });
    // Compact copies: the root is all there is to write; its layers come from the main.
    if (doc.compactCopies) return;
    for (const childId of doc.childIds(node.id)) {
      const child = doc.get(childId);
      if (child) visit(child, newId(), copyId, child.key, false);
    }
  };
  visit(main, rootId, parent, key, true);
  return { ops, rootId };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Sizes and places closer than this are the same (Figma saves them to a few decimals). */
const PLACE_EPSILON = 0.01;

/**
 * Operations that bring one instance in line with its main component:
 * properties (except overrides and root-local ones), missing layers, removed
 * layers and order. Returns [] when the main component is gone.
 *
 * A layer its constraints place in a copy frame of another size takes the
 * place they give it from its main layer's (`constrainedValues`), unless
 * `derive` is false: then what layout decides is only left alone, which is
 * how `pinInstances` reads a file as it was made.
 *
 * A field a component property drives takes the value the record of the
 * instance it's ultimately in keeps for it, or its main layer's when it
 * keeps none, never a value of its own (decision 0035, item 3); a nested
 * instance a swap property drives is an instance of the component the
 * record chose. A pure function of the main, the record and the copy's
 * other overrides, so every client syncing it writes the same. With
 * `properties`, only what the record decides is synced, and which layers
 * the copy has: driven fields, what's inside a nested instance whose
 * chosen component changes, layers made, moved or removed; not other
 * values of the layers it keeps (what layout gave them stays).
 */
export function syncInstanceOps(
  doc: Doc,
  instanceId: string,
  {
    derive = true,
    properties = false,
  }: { readonly derive?: boolean; readonly properties?: boolean } = {},
): Op[] {
  const instance = doc.get(instanceId);
  const componentId =
    instance && instance.type === "frame" ? getProp(instance.props, "instanceOf") : null;
  const main = componentId ? doc.get(componentId) : undefined;
  if (!instance || !main || !isMainComponent(main)) return [];
  // The record its values are in, and where it is in that record (decision 0035).
  const place = recordPlace(doc, instanceId);
  const record = place ? recordAt(doc, place) : {};

  // Map each main node id to its counterpart in this instance.
  const counterpart = new Map<string, NodeRecord>([[main.id, instance]]);
  const stray: NodeRecord[] = [];
  const walk = (id: string) => {
    for (const childId of doc.childIds(id)) {
      const child = doc.get(childId);
      if (!child) continue;
      const mirrors = getProp(child.props, "mirrors");
      if (mirrors && !counterpart.has(mirrors)) counterpart.set(mirrors, child);
      else stray.push(child);
      walk(childId);
    }
  };
  walk(instance.id);

  const ops: Op[] = [];
  const mainIds = new Set<string>();
  /** With `properties`: fields synced per layer, and layers synced whole (a swap rebuilt). */
  const drivenProps = new Map<string, Set<string>>();
  const whole = new Set<string>();

  /** A copy's driven fields and record keys: its own references when it unlinked them, else its main layer's. */
  const refsOf = (from: NodeRecord, to: NodeRecord | null) =>
    to && getProp(to.props, "overrides").includes("propRefs")
      ? getProp(to.props, "propRefs")
      : getProp(from.props, "propRefs");
  const fieldsOf = (from: NodeRecord, to: NodeRecord | null, scope: readonly string[]) => {
    const out: DrivenField[] = [];
    for (const [field, id] of Object.entries(refsOf(from, to)))
      if (id && field !== "slot") out.push([field as PropRefField, propertyKey(scope, id)]);
    return out;
  };

  const syncProps = (
    from: NodeRecord,
    to: NodeRecord,
    isRoot: boolean,
    only?: (prop: string) => boolean,
    fields: readonly DrivenField[] = [],
  ) => {
    const overridden = new Set<string>(getProp(to.props, "overrides"));
    // What layout decides (auto layout, hug and fill, auto-sized text, constraints in a resized
    // frame): the instance runs its own layout, so never copy those (decision 0035).
    const laidOut = laidOutProps(to, from, {
      root: isRoot,
      parent: isRoot ? undefined : doc.get(to.parent),
      parentSource: isRoot ? undefined : doc.get(from.parent),
    });
    // What constraints decide is derived from the main layer's place, not left as it was.
    const derived: Record<string, number> =
      derive && !isRoot
        ? constrainedValues(to, from, doc.get(to.parent), doc.get(from.parent))
        : {};
    for (const prop of laidOut) if (!(prop in derived)) overridden.add(prop);
    // Glyphs saved with a file were laid out for each copy (decision 0037); a stale set is never
    // drawn, so the copy's own is kept rather than replaced by its main's.
    if (from.type === "text") overridden.add("glyphLayout");
    // Driven fields are the record's, or the main layer's: never an override (decision 0035).
    const source: Record<string, unknown> = { ...from.props };
    const drives = new Set<string>();
    for (const [field] of fields)
      if (field !== "instanceOf") {
        drives.add(field);
        overridden.delete(field);
        if (field === "characters") drives.add("bindings");
      }
    if (fields.length > 0) applyPropertyValues(source, fields, record);
    if (properties && drives.size > 0) drivenProps.set(to.id, drives);
    const keys = new Set([...Object.keys(source), ...Object.keys(to.props)]);
    for (const prop of keys) {
      if (!isPropName(prop) || LINK_PROPS.has(prop) || overridden.has(prop)) continue;
      if (isRoot && ROOT_LOCAL_PROPS.has(prop)) continue;
      if (only && !only(prop) && !drives.has(prop)) continue;
      const have = to.props[prop];
      if (prop in derived) {
        const want = derived[prop] as number;
        if (typeof have !== "number" || Math.abs(have - want) > PLACE_EPSILON)
          ops.push({ op: "set", id: to.id, prop, value: want });
        continue;
      }
      const want = source[prop];
      if (sameValue(want, have)) continue;
      ops.push({ op: "set", id: to.id, prop, value: want === undefined ? null : want });
    }
    // A derived axis whose value the main layer doesn't hold (its default) is derived too.
    for (const [prop, want] of Object.entries(derived)) {
      if (keys.has(prop) || overridden.has(prop) || (only && !only(prop))) continue;
      ops.push({ op: "set", id: to.id, prop: prop as PropName, value: want });
    }
  };

  /** An instance root's name: its main's, or its set's for a variant, unless overridden. */
  const nameAfterSet = (root: NodeRecord, mainId: string) => {
    const set = componentSetOf(doc, mainId);
    if (!set || getProp(root.props, "overrides").includes("name")) return;
    const wanted = getProp(set.props, "name");
    const index = ops.findIndex((o) => o.op === "set" && o.id === root.id && o.prop === "name");
    if (index !== -1) ops.splice(index, 1);
    if (getProp(root.props, "name") !== wanted)
      ops.push({ op: "set", id: root.id, prop: "name", value: wanted });
  };

  /**
   * A nested instance swapped for another component: an instance of that
   * component placed where its main layer is, so it follows that
   * component, not the main layer. One a swap property drives is swapped as
   * the record says (`fields`); one none drives, when its `instanceOf` is
   * overridden.
   */
  const swappedMain = (
    copy: NodeRecord,
    mainLayer: NodeRecord,
    fields: readonly DrivenField[],
  ): NodeRecord | undefined => {
    const driven = fields.find(([field]) => field === "instanceOf");
    let own: string | null;
    if (driven) {
      const value = record[driven[1]];
      own = value && typeof value === "object" ? value.instance : null;
    } else {
      own = getProp(copy.props, "instanceOf");
      if (!getProp(copy.props, "overrides").includes("instanceOf")) return undefined;
    }
    if (!own || own === getProp(mainLayer.props, "instanceOf")) return undefined;
    const swapped = doc.get(own);
    return isMainNode(swapped) ? swapped : undefined;
  };

  const create = (mainChild: NodeRecord, parent: string, scope: readonly string[]) =>
    createMirror(doc, mainChild, parent, ops, { record, scope });

  const visit = (mainNode: NodeRecord, instanceParent: NodeRecord, scope: readonly string[]) => {
    for (const childId of doc.childIds(mainNode.id)) {
      const mainChild = doc.get(childId);
      if (!mainChild) continue;
      mainIds.add(mainChild.id);
      const existing = counterpart.get(mainChild.id);
      if (!existing || existing.type !== mainChild.type) {
        if (existing) ops.push({ op: "delete", id: existing.id });
        // Create the missing subtree under its counterpart parent.
        const created = create(mainChild, instanceParent.id, scope);
        counterpart.set(mainChild.id, created);
        continue;
      }
      if (existing.parent !== instanceParent.id || existing.key !== mainChild.key) {
        ops.push({ op: "move", id: existing.id, parent: instanceParent.id, key: mainChild.key });
      }
      const fields = fieldsOf(mainChild, existing, scope);
      const swapped = swappedMain(existing, mainChild, fields);
      const byProperty = fields.some(([field]) => field === "instanceOf");
      if (byProperty) {
        // Which component it is: the record's choice, or its main layer's.
        const want = swapped?.id ?? getProp(mainChild.props, "instanceOf");
        if (getProp(existing.props, "instanceOf") !== want) {
          ops.push({ op: "set", id: existing.id, prop: "instanceOf", value: want });
          if (properties) whole.add(existing.id);
        }
        const marks = getProp(existing.props, "overrides");
        if (marks.includes("instanceOf"))
          ops.push({
            op: "set",
            id: existing.id,
            prop: "overrides",
            value: marks.length > 1 ? marks.filter((m) => m !== "instanceOf") : null,
          });
      }
      const inner =
        swapped || getProp(mainChild.props, "instanceOf") !== null
          ? [...scope, ownLayerId(doc, mainChild.id)]
          : scope;
      if (swapped) {
        // Where it sits, and what the outer component's properties drive (its visibility, say),
        // are its main layer's; the rest is the swapped-in component's (decision 0035).
        const boundary = new Set([...ROOT_LOCAL_PROPS, ...boundaryDrivenProps(mainChild)]);
        boundary.delete("instanceOf");
        syncProps(mainChild, existing, false, (prop) => boundary.has(prop), fields);
        syncProps(swapped, existing, true, (prop) => !boundary.has(prop));
        nameAfterSet(existing, swapped.id);
      } else
        syncProps(
          mainChild,
          existing,
          false,
          byProperty ? (prop) => prop !== "instanceOf" : undefined,
          fields,
        );
      visit(swapped ?? mainChild, existing, inner);
    }
  };

  syncProps(main, instance, true);
  // Instances of a variant carry the set's name.
  nameAfterSet(instance, main.id);
  visit(main, instance, place?.scope ?? []);

  // Layers whose main counterpart is gone (or that never had one) don't belong in an instance.
  for (const [mainId, node] of counterpart) {
    if (mainId !== main.id && !mainIds.has(mainId) && doc.has(node.id))
      ops.push({ op: "delete", id: node.id });
  }
  for (const node of stray) {
    if (doc.has(node.id) && !ops.some((o) => o.op === "delete" && o.id === node.id)) {
      // Only delete strays whose ancestors aren't already being deleted.
      if (
        !doc.ancestors(node.id).some((a) => ops.some((o) => o.op === "delete" && o.id === a.id))
      ) {
        ops.push({ op: "delete", id: node.id });
      }
    }
  }
  let out = ops;
  if (properties) {
    // What the record decides: driven fields, and a nested instance swapped another way whole.
    // And which layers the copy has, as its main has them (a layer made, moved or removed by a
    // teammate's edit made without seeing this one's): never other values (laid out ones).
    const inside = (id: string) => whole.has(id) || doc.ancestors(id).some((a) => whole.has(a.id));
    const made = new Set<string>();
    out = ops.filter((op) => {
      if (op.op !== "set") {
        if (op.op === "create") made.add(op.id);
        return true;
      }
      if (made.has(op.id)) return true;
      if (drivenProps.get(op.id)?.has(op.prop)) return true;
      if ((op.prop === "instanceOf" || op.prop === "overrides") && whole.has(op.id)) return true;
      return inside(op.id) && op.id !== instanceId;
    });
  }
  // Compact copies have their main's structure by construction (a swap rebuilds it): only
  // values are synced.
  if (doc.compactCopies) return out.filter((op) => op.op === "set");
  return dedupeDeletes(doc, out);
}

/**
 * The copy of `mainNode` (and what's in it) under `parent`: its main's
 * values, driven fields as `values`' record says (decision 0035).
 */
function createMirror(
  doc: Doc,
  mainNode: NodeRecord,
  parent: string,
  ops: Op[],
  values: {
    readonly record: Readonly<Record<string, PropertyValue>>;
    readonly scope: readonly string[];
  } | null = null,
): NodeRecord {
  const id = newId();
  const props: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(mainNode.props))
    if (!LINK_PROPS.has(prop)) props[prop] = value;
  props.mirrors = mainNode.id;
  let from = mainNode;
  if (values) {
    const fields: DrivenField[] = [];
    for (const [field, ref] of Object.entries(getProp(mainNode.props, "propRefs")))
      if (ref && field !== "slot")
        fields.push([field as PropRefField, propertyKey(values.scope, ref)]);
    applyPropertyValues(props, fields, values.record);
    // Swapped by a property: an instance of what the record chose, its layers that main's.
    const swap = fields.find(([field]) => field === "instanceOf");
    const chosen = swap ? values.record[swap[1]] : undefined;
    const swapped = chosen && typeof chosen === "object" ? doc.get(chosen.instance) : undefined;
    if (swapped && isMainNode(swapped) && swapped.id !== props.instanceOf) {
      props.instanceOf = swapped.id;
      from = swapped;
    }
  }
  const record: NodeRecord = {
    id,
    type: mainNode.type,
    parent,
    key: mainNode.key,
    props: props as Props,
  };
  ops.push({ op: "create", ...record });
  const inner =
    values && (from !== mainNode || getProp(mainNode.props, "instanceOf") !== null)
      ? { record: values.record, scope: [...values.scope, ownLayerId(doc, mainNode.id)] }
      : values;
  for (const childId of doc.childIds(from.id)) {
    const child = doc.get(childId);
    if (child) createMirror(doc, child, id, ops, inner);
  }
  return record;
}

/** Drops deletes of nodes whose ancestor is also deleted (the subtree goes with it). */
function dedupeDeletes(doc: Doc, ops: Op[]): Op[] {
  const deleted = new Set(ops.filter((o) => o.op === "delete").map((o) => o.id));
  return ops.filter(
    (o) => o.op !== "delete" || !doc.ancestors(o.id).some((a) => deleted.has(a.id)),
  );
}

/** Main components whose look may have changed when `ids` changed. */
export function affectedComponents(doc: Doc, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  // Every main component around the layer, not just the nearest: an edit
  // inside a component nested in another reaches the outer one's instances too.
  for (const id of ids)
    for (let node = doc.get(id); node && node.type !== "page"; node = doc.get(node.parent))
      if (isMainComponent(node)) out.add(node.id);
  return out;
}

/** Sync operations for every instance of the components `ids` touched. */
export function propagationOps(doc: Doc, ids: Iterable<string>): Op[] {
  // Compact copies follow their mains without being written (decision 0029).
  if (doc.compactCopies) return [];
  const ops: Op[] = [];
  const synced = new Set<string>();
  for (const componentId of affectedComponents(doc, ids)) {
    for (const instanceId of instancesOf(doc, componentId)) {
      // An instance inside its own component would recurse; wouldCycle prevents creating one.
      if (doc.ancestors(instanceId).some((a) => a.id === componentId)) continue;
      // A nested instance inside another instance mirrors the outer component's
      // copy, so it follows that copy (through the outer sync), not its main directly;
      // one swapped for this component follows it, through its outer instance's sync.
      const props = doc.get(instanceId)?.props ?? {};
      let root = instanceId;
      if (getProp(props, "mirrors") !== null) {
        if (!getProp(props, "overrides").includes("instanceOf")) continue;
        root = outermostInstanceOf(doc, instanceId)?.id ?? instanceId;
      }
      if (synced.has(root)) continue;
      synced.add(root);
      ops.push(...syncInstanceOps(doc, root));
    }
  }
  return ops;
}

const GEOMETRY: ReadonlySet<string> = new Set([
  "x",
  "y",
  "width",
  "height",
  "constraintH",
  "constraintV",
  "layoutMode",
  "positioning",
]);

/**
 * With compact copies, the places constraints give copy layers after `ops`
 * moved, resized or re-pinned layers in mains (decision 0035, item 7): a
 * copy frame of another size than its main's holds its children's places as
 * laid out values, so they're derived again from their main layers'
 * (`constrainedValues`), as materialized sync does. Only instances that
 * store a value a layout reads can differ in size, so only they're walked.
 */
export function copyConstraintOps(doc: Doc, ops: readonly Op[]): Op[] {
  if (!doc.compactCopies) return [];
  const touched = ops.filter((op) => op.op === "set" && GEOMETRY.has(op.prop)).map((op) => op.id);
  if (touched.length === 0) return [];
  const mains = affectedComponents(doc, touched);
  if (mains.size === 0) return [];
  const queue = [...mains];
  for (let i = 0; i < queue.length; i++)
    for (const root of doc.instanceRoots(queue[i] as string))
      for (const outer of affectedComponents(doc, [root]))
        if (!mains.has(outer)) {
          mains.add(outer);
          queue.push(outer);
        }
  const out: Op[] = [];
  const seen = new Set<string>();
  for (const main of mains)
    for (const root of doc.instanceRoots(main)) {
      if (seen.has(root) || !doc.layoutDiffers(root)) continue;
      seen.add(root);
      const stack = [...doc.childIds(root)];
      while (stack.length > 0) {
        const id = stack.pop() as string;
        const copy = doc.get(id);
        if (!copy) continue;
        stack.push(...doc.childIds(id));
        const sourceId = getProp(copy.props, "mirrors");
        const source = sourceId ? doc.get(sourceId) : undefined;
        if (!source) continue;
        const derived = constrainedValues(
          copy,
          source,
          doc.get(copy.parent),
          doc.get(source.parent),
        );
        const overridden = getProp(copy.props, "overrides");
        for (const [prop, want] of Object.entries(derived)) {
          if (overridden.includes(prop as PropName)) continue;
          const have = (copy.props as Record<string, unknown>)[prop];
          if (typeof have !== "number" || Math.abs(have - want) > PLACE_EPSILON)
            out.push({ op: "set", id, prop: prop as PropName, value: want });
        }
      }
    }
  return out;
}

/**
 * With compact copies, what to lay out again after `ops` changed `ids`.
 * Every copy that equals its main is laid out already (it is its main), so
 * only two kinds of instance need it:
 *
 * - one whose layout differs from its main's (it stores a value a layout
 *   reads: a text, a size, a hidden layer), when its main's layout inside
 *   may have changed: every layer of it, so texts measure themselves and
 *   frames place their children;
 * - one whose main changed size, so its parent's layout places it again.
 *
 * A main whose instances (inside it, as the icon in a button) changed size
 * changed inside too, with no operation of its own. Changes no layout reads
 * (a fill, a name, a child of a frame without auto layout) lay out nothing.
 */
export function relayoutTargets(doc: Doc, ids: Iterable<string>, ops: readonly Op[]): string[] {
  if (!doc.compactCopies) return [];
  const reads = (op: Op) => op.op !== "set" || !LAYOUT_NEUTRAL.has(op.prop);
  if (!ops.some(reads)) return [];
  const isLayout = (node: NodeRecord | undefined) =>
    node?.type === "frame" && getProp(node.props, "layoutMode") !== "none";
  const inLayout = (node: NodeRecord) => {
    let parent = doc.get(node.parent);
    while (parent?.type === "group") parent = doc.get(parent.parent);
    return isLayout(parent);
  };
  /** Mains whose layout inside may have changed. */
  const inner = new Set<string>();
  /** Mains whose root changed in a way its instances' parents read. */
  const sized = new Set<string>();
  for (const op of ops) {
    if (!reads(op)) continue;
    const node = op.op === "delete" ? undefined : doc.get(op.id);
    if (!node) {
      // Gone: whatever held it may have changed.
      for (const id of affectedComponents(doc, ids)) inner.add(id);
      continue;
    }
    const around = affectedComponents(doc, [node.id]);
    if (around.size === 0) continue;
    const isRoot = isMainComponent(node);
    if (isRoot && op.op === "set" && ROOT_LOCAL_PROPS.has(op.prop)) continue;
    if (isRoot) sized.add(node.id);
    if (isRoot || node.type === "text" || isLayout(node) || inLayout(node))
      for (const id of around) inner.add(id);
  }
  // A main holding instances of a resized main changed inside, however deep.
  const queue = [...sized];
  for (let i = 0; i < queue.length; i++)
    for (const root of doc.instanceRoots(queue[i] as string))
      for (const outer of affectedComponents(doc, [root]))
        if (!inner.has(outer)) {
          inner.add(outer);
          queue.push(outer);
        }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const componentId of new Set([...inner, ...sized])) {
    for (const root of doc.instanceRoots(componentId)) {
      if (seen.has(root) || !doc.has(root)) continue;
      if (doc.ancestors(root).some((a) => a.id === componentId)) continue;
      if (doc.layoutDiffers(root) && inner.has(componentId)) {
        seen.add(root);
        const all = [root];
        for (let i = 0; i < all.length; i++) {
          const id = all[i] as string;
          out.push(id);
          all.push(...doc.childIds(id));
        }
      } else if (sized.has(componentId)) out.push(root);
    }
  }
  return out;
}

/**
 * Instances as they are, kept: for files made elsewhere (Penpot, Figma),
 * whose copies differ from their mains in ways Drawpane's sync would undo.
 *
 * - Properties: a copy resized, its layers placed by constraints or its own
 *   auto layout, a text wrapping differently, none of it recorded as an
 *   override there. Each property syncing would change is marked
 *   overridden instead, so the copy keeps it and still follows its main's
 *   other changes.
 * - Structure: a copy whose layers can't be matched to its main's (one the
 *   main doesn't have, a missing one, another order, a reference to a layer
 *   the main no longer has). Sync would rebuild it from the main, so it's
 *   detached instead: it keeps every layer as it is, without the link. An
 *   instance in it that copies nothing (what it put in a slot) stays one,
 *   kept or detached on its own; copies of it in that main's instances
 *   copy a plain layer from then on, so they aren't instances either.
 *
 * Either way the file opens looking as it did where it was made.
 *
 * Grids are laid out first (`gridImportOps`): their saved items can lag the
 * layout the grid shows where it was made. A copy whose grid then differs
 * from its main's is kept as it is like any other.
 */
export function pinInstances(input: readonly NodeRecord[]): {
  nodes: NodeRecord[];
  /** Properties marked overridden. */
  pinned: number;
  /** Copies detached because their structure differs from their main's. */
  detached: number;
} {
  const roots = (doc: Doc) =>
    [...doc.nodes()].filter(
      (node) => isInstanceRoot(node) && getProp(node.props, "mirrors") === null,
    );

  // Copies sync can't keep as they are lose their link, everything inside them too.
  // Read as materialized: this is about the file as it was made.
  let doc = new DocCtor({ compactCopies: false });
  doc.reset(input);
  let nodes = withSets(input, gridImportOps(doc));
  if (nodes !== input) doc.reset(nodes);
  // What instances set for their properties goes in their records first, the one place a value is
  // kept (decision 0035, item 3), so a nested instance a swap property swapped is that, not a
  // structure sync would rebuild; a layer showing another value than its property's is unlinked.
  // Every instance gets a record, empty when it set nothing (`migrateRecords`).
  const folded = migrateRecords(nodes).nodes;
  if (folded !== nodes) {
    nodes = folded;
    doc.reset(nodes);
  }
  const unlinked = new Set<string>();
  let detached = 0;
  for (const root of roots(doc)) {
    if (!syncInstanceOps(doc, root.id, { derive: false }).some((op) => op.op !== "set")) continue;
    detached++;
    const queue = [root.id];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      // An instance inside it that copies nothing (what it put in a slot) is an instance root of
      // its own, kept or unlinked as it is.
      const node = doc.get(id);
      if (id !== root.id && isInstanceRoot(node) && getProp(node?.props ?? {}, "mirrors") === null)
        continue;
      unlinked.add(id);
      queue.push(...doc.childIds(id));
    }
  }
  // A copy of a nested instance unlinked in its main copies a plain layer now, so it isn't an
  // instance either (nor copies of it, in mains holding that main), unless it was swapped for
  // another component: then it still is one.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const plain = new Map<string, boolean>();
  const copiesPlain = (id: string): boolean => {
    const known = plain.get(id);
    if (known !== undefined) return known;
    plain.set(id, false);
    const node = byId.get(id);
    const mirrors = node ? getProp(node.props, "mirrors") : null;
    const is =
      !!node &&
      !!mirrors &&
      !unlinked.has(id) &&
      getProp(node.props, "instanceOf") !== null &&
      !getProp(node.props, "overrides").includes("instanceOf") &&
      (unlinked.has(mirrors) || copiesPlain(mirrors));
    plain.set(id, is);
    return is;
  };
  let out: NodeRecord[] = nodes.map((node) => {
    if (unlinked.has(node.id)) {
      // A plain layer now: what it shows is its own, a record of values its instance set too.
      const props: Record<string, unknown> = { ...node.props };
      delete props.instanceOf;
      delete props.mirrors;
      delete props.overrides;
      delete props.propValues;
      return { ...node, props: props as Props };
    }
    if (!copiesPlain(node.id)) return node;
    const props: Record<string, unknown> = { ...node.props };
    delete props.instanceOf;
    return { ...node, props: props as Props };
  });

  // What syncing would still change on the rest is theirs: overridden.
  doc = new DocCtor({ compactCopies: false });
  doc.reset(out);
  const marks = new Map<string, Set<string>>();
  for (const root of roots(doc)) {
    for (const op of syncInstanceOps(doc, root.id, { derive: false })) {
      if (op.op !== "set" || LINK_PROPS.has(op.prop)) continue;
      let set = marks.get(op.id);
      if (!set) {
        set = new Set(getProp(doc.get(op.id)?.props ?? {}, "overrides"));
        marks.set(op.id, set);
      }
      set.add(op.prop);
    }
  }
  let pinned = 0;
  out = out.map((node) => {
    const set = marks.get(node.id);
    if (!set) return node;
    pinned += set.size - getProp(node.props, "overrides").length;
    return { ...node, props: { ...node.props, overrides: [...set].sort() as PropName[] } };
  });
  return { nodes: out, pinned, detached };
}

/** `nodes` with `patches`' properties (undefined: removed); the same array when there are none. */
function _withPatches(
  nodes: readonly NodeRecord[],
  patches: ReadonlyMap<string, Record<string, unknown>>,
): readonly NodeRecord[] {
  if (patches.size === 0) return nodes;
  return nodes.map((node) => {
    const patch = patches.get(node.id);
    if (!patch) return node;
    const props: Record<string, unknown> = { ...node.props, ...patch };
    for (const [prop, value] of Object.entries(patch)) if (value === undefined) delete props[prop];
    return { ...node, props: props as Props };
  });
}

/** `nodes` with `set` operations applied (the same array when there are none). */
function withSets(nodes: readonly NodeRecord[], ops: readonly Op[]): readonly NodeRecord[] {
  const sets = new Map<string, Record<string, unknown>>();
  for (const op of ops) {
    if (op.op !== "set") continue;
    const props = sets.get(op.id) ?? {};
    props[op.prop] = op.value;
    sets.set(op.id, props);
  }
  if (sets.size === 0) return nodes;
  return nodes.map((node) => {
    const props = sets.get(node.id);
    return props ? { ...node, props: { ...node.props, ...props } as Props } : node;
  });
}

/**
 * Overrides to record for a user's edit: every `set` of a synced property on a
 * layer inside an instance (or on the instance root) marks that property.
 */
export function overrideOps(doc: Doc, ops: readonly Op[]): Op[] {
  const marks = new Map<string, Set<string>>();
  // A layer the operations unlink from its main (detached) has nothing to be an override of.
  const leaving = new Set<string>();
  for (const op of ops)
    if (op.op === "set" && (op.prop === "mirrors" || op.prop === "instanceOf") && !op.value)
      leaving.add(op.id);
  for (const op of ops) {
    if (op.op !== "set" || LINK_PROPS.has(op.prop) || leaving.has(op.id)) continue;
    const node = doc.get(op.id);
    if (!node) continue;
    const isRoot = isInstanceRoot(node);
    const inInstance =
      isRoot || (getProp(node.props, "mirrors") !== null && isInsideInstance(doc, op.id));
    if (!inInstance) continue;
    if (isRoot && ROOT_LOCAL_PROPS.has(op.prop)) continue;
    let set = marks.get(op.id);
    if (!set) {
      set = new Set(getProp(node.props, "overrides"));
      marks.set(op.id, set);
    }
    set.add(op.prop);
  }
  const out: Op[] = [];
  for (const [id, set] of marks) {
    const node = doc.get(id);
    const before = node ? getProp(node.props, "overrides") : [];
    const after = [...set].sort();
    if (!sameValue([...before].sort(), after))
      out.push({ op: "set", id, prop: "overrides", value: after });
  }
  return out;
}

/** Clears every override in an instance; syncing then restores the main component's look. */
export function resetOverridesOps(doc: Doc, instanceId: string): Op[] {
  const ops: Op[] = [];
  const stack = [instanceId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = doc.get(id);
    if (!node) continue;
    if (getProp(node.props, "overrides").length > 0)
      ops.push({ op: "set", id, prop: "overrides", value: null });
    // Nested instances keep their own overrides relative to their own main.
    if (id !== instanceId && isInstanceRoot(node)) continue;
    stack.push(...doc.childIds(id));
  }
  return ops;
}

/**
 * Clears every change in an instance, those in its nested instances
 * included, as Figma's "Reset all changes" does. Syncing then restores its
 * main's look.
 */
export function resetAllOverridesOps(doc: Doc, instanceId: string): Op[] {
  const ops: Op[] = [];
  const stack = [instanceId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = doc.get(id);
    if (!node) continue;
    if (getProp(node.props, "overrides").length > 0)
      ops.push({ op: "set", id, prop: "overrides", value: null });
    stack.push(...doc.childIds(id));
  }
  // Its property values, and its nested instances', go too (decision 0035), each on its own.
  ops.push(...clearValueOps(doc, instanceId));
  return ops;
}

/** The operations that remove every value an instance's record holds, a value at a time. */
export function clearRecordOps(node: NodeRecord): Op[] {
  return Object.keys(getProp(node.props, "propValues")).map(
    (key): Op => ({ op: "set", id: node.id, prop: "propValues", key, value: null }),
  );
}

/**
 * Turns an instance into a plain frame: no link to the main component,
 * nothing synced. Its layers keep the values they show, its property
 * values' included (decision 0035); its nested instances stay instances of
 * their own components, each with the values its record held for them.
 */
export function detachOps(doc: Doc, instanceId: string): Op[] {
  const ops: Op[] = [{ op: "set", id: instanceId, prop: "instanceOf", value: null }];
  const instance = doc.get(instanceId);
  const record = instance ? getProp(instance.props, "propValues") : {};
  // A frame has no properties to set: what they set stays on its layers.
  const nested: Op[] = [];
  if (instance) ops.push(...clearRecordOps(instance));
  const stack = [...doc.childIds(instanceId)];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = doc.get(id);
    if (!node) continue;
    const unlinked = getProp(node.props, "mirrors") !== null;
    if (unlinked) ops.push({ op: "set", id, prop: "mirrors", value: null });
    if (getProp(node.props, "overrides").length > 0)
      ops.push({ op: "set", id, prop: "overrides", value: null });
    // A layer keeps what its property's value shows (`shownValues`), which with materialized
    // copies a layer written before the record's last change can lag (compact copies present it).
    const shown = unlinked && !doc.compactCopies ? shownOps(doc, node) : { ops: [], swap: null };
    ops.push(...shown.ops);
    if (isInstanceRoot(node)) {
      // Nested instances stay instances of their own components, with every value they show
      // (compact copies give them theirs as they're stored on their own). One a swap the record
      // chose left stale is made an instance of that component (`shownOps`), its layers its.
      const values = doc.compactCopies ? null : nestedValues(doc, record, node, shown.swap);
      if (values)
        for (const [key, value] of Object.entries(values))
          nested.push({ op: "set", id, prop: "propValues", key, value });
      if (!doc.compactCopies && !shown.swap) ops.push(...ownComponentOps(doc, id));
      continue;
    }
    stack.push(...doc.childIds(id));
  }
  return [...ops, ...nested];
}

/**
 * A nested instance in a materialized copy, about to stand on its own
 * (detached around it): its layers copy its main's copy layers, which copy
 * its own component's. They copy its component's then, one step down, as
 * an instance's layers do, so it follows its component and converts.
 */
function ownComponentOps(doc: Doc, instanceId: string): Op[] {
  const ops: Op[] = [];
  const stack = [...doc.childIds(instanceId)];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = doc.get(id);
    if (!node) continue;
    const mirrors = getProp(node.props, "mirrors");
    const through = mirrors ? getProp(doc.get(mirrors)?.props ?? {}, "mirrors") : null;
    if (through && doc.has(through)) ops.push({ op: "set", id, prop: "mirrors", value: through });
    stack.push(...doc.childIds(id));
  }
  return ops;
}

/**
 * The values a nested instance in a copy shows, as a record of its own for
 * when it's no longer in one (detached): those the outer instance's record
 * keeps under its scope, over those its main layer's own record holds (the
 * values the main around it set, which it shows where the outer record has
 * none), while it's an instance of the same component as that layer. Null
 * when there are none.
 */
export function nestedValues(
  doc: Doc,
  outer: Readonly<Record<string, PropertyValue>>,
  node: NodeRecord,
  /** The component it's made an instance of instead, when a swap is handed on. */
  swap: string | null = null,
): Record<string, PropertyValue> | null {
  const own = ownLayerId(doc, node.id);
  const source = own === node.id ? undefined : doc.get(own);
  const inherited =
    source && getProp(source.props, "instanceOf") === (swap ?? getProp(node.props, "instanceOf"))
      ? getProp(source.props, "propValues")
      : {};
  const values = { ...inherited, ...(scopedValues(outer, own) ?? {}) };
  return Object.keys(values).length > 0 ? values : null;
}

/**
 * What a materialized copy layer about to be detached keeps of the fields a
 * property drives: each as it shows (`shownValues`), set where the layer
 * holds another (written before the record's last change: the record
 * wins); a nested instance a stale swap left is swapped to the component
 * shown (`swap`), its layers that component's.
 */
function shownOps(doc: Doc, node: NodeRecord): { ops: Op[]; swap: string | null } {
  const ops: Op[] = [];
  let swap: string | null = null;
  for (const { field, value } of shownValues(doc, node)) {
    if (field === "instanceOf") {
      const to = typeof value === "object" ? value.instance : null;
      if (!to || to === getProp(node.props, "instanceOf")) continue;
      // Its layers become that component's; it's no longer a copy, so no swap mark.
      ops.push(
        ...swapInstanceOps(doc, node.id, to).filter(
          (op) => !(op.op === "set" && op.id === node.id && op.prop === "overrides"),
        ),
      );
      swap = to;
      continue;
    }
    if (sameValue(fieldValue(node, field), value)) continue;
    ops.push({ op: "set", id: node.id, prop: field, value: value as boolean | string });
  }
  return { ops, swap };
}

/** Properties of a node that differ from its main counterpart because of an override. */
export function overriddenProps(node: NodeRecord): readonly PropName[] {
  return getProp(node.props, "overrides").filter(isPropName);
}

/** For a nested instance (inside another), marks `instanceOf` overridden. */
function nestedSwapMark(instance: NodeRecord): Op[] {
  if (getProp(instance.props, "mirrors") === null) return [];
  const marks = new Set(getProp(instance.props, "overrides"));
  if (marks.has("instanceOf")) return [];
  marks.add("instanceOf");
  return [{ op: "set", id: instance.id, prop: "overrides", value: [...marks].sort() }];
}

/**
 * A swap with compact copies: `instanceOf` set, the new main's layers
 * presented at once with ids derived from it, and the carried overrides set
 * on them. A nested instance marks `instanceOf` overridden, so its outer
 * instance keeps it swapped.
 */
function swapCompactOps(doc: Doc, instance: NodeRecord, target: NodeRecord): Op[] {
  const carried = new Map<string, Record<string, unknown>>();
  const stack = [...doc.childIds(instance.id)];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = doc.get(id);
    if (!node) continue;
    // Fields a property drives go by property id, through the instance's record (decision 0035).
    const driven = getProp(node.props, "propRefs") as Record<string, string | undefined>;
    const overridden = getProp(node.props, "overrides").filter((prop) => !driven[prop]);
    if (overridden.length > 0) {
      const values: Record<string, unknown> = {};
      for (const prop of overridden)
        values[prop] = (node.props as Record<string, unknown>)[prop] ?? null;
      carried.set(namePath(doc, instance.id, id), values);
    }
    stack.push(...doc.childIds(id));
  }
  const ops: Op[] = [{ op: "set", id: instance.id, prop: "instanceOf", value: target.id }];
  ops.push(...nestedSwapMark(instance));
  const walk = (mainParent: string, copyParent: string, path: string) => {
    for (const childId of doc.childIds(mainParent)) {
      const child = doc.get(childId);
      if (!child) continue;
      const id = copyChildId(copyParent, childId);
      const name = getProp(child.props, "name") || child.type;
      const at = path ? `${path}/${name}` : name;
      const values = carried.get(at);
      if (values) {
        for (const [prop, value] of Object.entries(values))
          if (isPropName(prop)) ops.push({ op: "set", id, prop, value });
        ops.push({ op: "set", id, prop: "overrides", value: Object.keys(values) });
      }
      walk(childId, id, at);
    }
  };
  walk(target.id, instance.id, "");
  return ops;
}

// ---------------------------------------------------------------------------
// Variants

export function isComponentSet(node: NodeRecord | undefined): boolean {
  return node?.type === "frame" && getProp(node.props, "isComponentSet");
}

/** The component set a main component belongs to, if it is a variant. */
export function componentSetOf(doc: Doc, componentId: string): NodeRecord | undefined {
  const component = doc.get(componentId);
  const parent = component ? doc.get(component.parent) : undefined;
  return isMainComponent(component) && isComponentSet(parent) ? parent : undefined;
}

/** The variants (main components) in a component set, in order. */
export function variantsOf(doc: Doc, setId: string): NodeRecord[] {
  return doc
    .childIds(setId)
    .map((id) => doc.get(id))
    .filter((n): n is NodeRecord => !!n && isMainComponent(n));
}

/** A set's properties in first-seen order, with every value in use. */
export function variantProperties(
  doc: Doc,
  setId: string,
): Array<{ name: string; values: string[] }> {
  const order: string[] = [];
  const values = new Map<string, string[]>();
  for (const variant of variantsOf(doc, setId)) {
    for (const [name, value] of Object.entries(getProp(variant.props, "variantProps"))) {
      if (!values.has(name)) {
        order.push(name);
        values.set(name, []);
      }
      const list = values.get(name) as string[];
      if (!list.includes(value)) list.push(value);
    }
  }
  return order.map((name) => ({ name, values: values.get(name) ?? [] }));
}

/**
 * The variant whose properties match `wanted` best: all of them if one does,
 * else the most in common, preferring the earliest variant on ties.
 */
export function findVariant(
  doc: Doc,
  setId: string,
  wanted: Readonly<Record<string, string>>,
): NodeRecord | undefined {
  let best: NodeRecord | undefined;
  let bestScore = -1;
  for (const variant of variantsOf(doc, setId)) {
    const props = getProp(variant.props, "variantProps");
    const score = Object.entries(wanted).filter(([k, v]) => props[k] === v).length;
    if (score > bestScore) {
      best = variant;
      bestScore = score;
    }
  }
  return best;
}

/** Path of layer names from an instance root down to `id` ("Content/Title"), for matching across variants. */
function namePath(doc: Doc, rootId: string, id: string): string {
  const parts: string[] = [];
  for (let node = doc.get(id); node && node.id !== rootId; node = doc.get(node.parent)) {
    parts.unshift(layerName(node));
  }
  return parts.join("/");
}

/**
 * Swaps an instance to another main component (a sibling variant, usually),
 * keeping its id, position and the overrides on layers whose name path
 * matches in the new component, like Figma.
 */
export function swapInstanceOps(doc: Doc, instanceId: string, componentId: string): Op[] {
  const instance = doc.get(instanceId);
  const target = doc.get(componentId);
  if (!instance || !isInstanceRoot(instance) || !target || !isMainComponent(target)) return [];
  if (doc.compactCopies) return swapCompactOps(doc, instance, target);

  // Overridden values by name path (the root keeps its own overrides as-is).
  const carried = new Map<string, Record<string, unknown>>();
  const stack = [...doc.childIds(instanceId)];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = doc.get(id);
    if (!node) continue;
    // Fields a property drives go by property id, through the instance's record (decision 0035).
    const driven = getProp(node.props, "propRefs") as Record<string, string | undefined>;
    const overridden = getProp(node.props, "overrides").filter((prop) => !driven[prop]);
    if (overridden.length > 0) {
      const values: Record<string, unknown> = {};
      for (const prop of overridden)
        values[prop] = (node.props as Record<string, unknown>)[prop] ?? null;
      carried.set(namePath(doc, instanceId, id), values);
    }
    stack.push(...doc.childIds(id));
  }

  const ops: Op[] = doc.childIds(instanceId).map((id): Op => ({ op: "delete", id }));
  ops.push({ op: "set", id: instanceId, prop: "instanceOf", value: componentId });
  // A nested instance keeps the swap: its outer instance's sync leaves `instanceOf` alone.
  ops.push(...nestedSwapMark(instance));
  const created: Op[] = [];
  for (const childId of doc.childIds(componentId)) {
    const child = doc.get(childId);
    if (child) createMirror(doc, child, instanceId, created);
  }
  // Re-apply carried overrides onto the new layers with the same name path.
  const pathOf = new Map<string, string>();
  const createdById = new Map(created.filter((o) => o.op === "create").map((o) => [o.id, o]));
  for (const op of created) {
    if (op.op !== "create") continue;
    const parentPath = op.parent === instanceId ? "" : (pathOf.get(op.parent) ?? "");
    const name = (op.props.name as string | undefined) || op.type;
    const path = parentPath ? `${parentPath}/${name}` : name;
    pathOf.set(op.id, path);
    const values = carried.get(path);
    if (!values) continue;
    const props = { ...op.props } as Record<string, unknown>;
    for (const [prop, value] of Object.entries(values)) {
      if (value === null) delete props[prop];
      else props[prop] = value;
    }
    props.overrides = Object.keys(values);
    createdById.set(op.id, { ...op, props: props as Props });
  }
  for (const op of created) ops.push(op.op === "create" ? (createdById.get(op.id) as Op) : op);
  return ops;
}
