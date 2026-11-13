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
 */
import {
  getProp,
  isPropName,
  type NodeRecord,
  newId,
  type Op,
  type PropName,
  type Props,
} from "@drawpane/model";
import type { Doc } from "./doc";

/** Never copied from a main component: they link instances or describe the main itself. */
const LINK_PROPS: ReadonlySet<string> = new Set([
  "isComponent",
  "componentDescription",
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
  "positioning",
  "constraintH",
  "constraintV",
  "instanceOf",
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

const indexCache = new WeakMap<Doc, { version: number; instances: Map<string, string[]> }>();

/** Instance ids of each main component, cached per document version. */
export function instancesOf(doc: Doc, componentId: string): readonly string[] {
  let cached = indexCache.get(doc);
  if (!cached || cached.version !== doc.version) {
    const instances = new Map<string, string[]>();
    for (const node of doc.nodes()) {
      const of = node.type === "frame" ? getProp(node.props, "instanceOf") : null;
      if (!of) continue;
      let list = instances.get(of);
      if (!list) {
        list = [];
        instances.set(of, list);
      }
      list.push(node.id);
    }
    cached = { version: doc.version, instances };
    indexCache.set(doc, cached);
  }
  return cached.instances.get(componentId) ?? [];
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

/**
 * Operations that bring one instance in line with its main component:
 * properties (except overrides and root-local ones), missing layers, removed
 * layers and order. Returns [] when the main component is gone.
 */
export function syncInstanceOps(doc: Doc, instanceId: string): Op[] {
  const instance = doc.get(instanceId);
  const componentId =
    instance && instance.type === "frame" ? getProp(instance.props, "instanceOf") : null;
  const main = componentId ? doc.get(componentId) : undefined;
  if (!instance || !main || !isMainComponent(main)) return [];

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

  const syncProps = (from: NodeRecord, to: NodeRecord, isRoot: boolean) => {
    const overridden = new Set(getProp(to.props, "overrides"));
    // Auto layout decides where its children go and how big Hug and Fill
    // children are; the instance runs its own layout, so never copy those.
    const parent = isRoot ? undefined : doc.get(to.parent);
    if (
      parent?.type === "frame" &&
      getProp(parent.props, "layoutMode") !== "none" &&
      getProp(to.props, "positioning") === "auto"
    ) {
      overridden.add("x");
      overridden.add("y");
      if (getProp(from.props, "sizingH") !== "fixed") overridden.add("width");
      if (getProp(from.props, "sizingV") !== "fixed") overridden.add("height");
    }
    if (getProp(from.props, "sizingH") === "hug") overridden.add("width");
    if (getProp(from.props, "sizingV") === "hug") overridden.add("height");
    if (from.type === "text") {
      // Auto-sized text measures itself in the instance.
      const resize = getProp(from.props, "textAutoResize");
      if (resize === "width") overridden.add("width");
      if (resize !== "none") overridden.add("height");
    }
    const keys = new Set([...Object.keys(from.props), ...Object.keys(to.props)]);
    for (const prop of keys) {
      if (!isPropName(prop) || LINK_PROPS.has(prop) || overridden.has(prop)) continue;
      if (isRoot && ROOT_LOCAL_PROPS.has(prop)) continue;
      const want = from.props[prop];
      const have = to.props[prop];
      if (sameValue(want, have)) continue;
      ops.push({ op: "set", id: to.id, prop, value: want === undefined ? null : want });
    }
  };

  const visit = (mainNode: NodeRecord, instanceParent: NodeRecord) => {
    for (const childId of doc.childIds(mainNode.id)) {
      const mainChild = doc.get(childId);
      if (!mainChild) continue;
      mainIds.add(mainChild.id);
      const existing = counterpart.get(mainChild.id);
      if (!existing || existing.type !== mainChild.type) {
        if (existing) ops.push({ op: "delete", id: existing.id });
        // Create the missing subtree under its counterpart parent.
        const created = createMirror(doc, mainChild, instanceParent.id, ops);
        counterpart.set(mainChild.id, created);
        continue;
      }
      if (existing.parent !== instanceParent.id || existing.key !== mainChild.key) {
        ops.push({ op: "move", id: existing.id, parent: instanceParent.id, key: mainChild.key });
      }
      syncProps(mainChild, existing, false);
      visit(mainChild, existing);
    }
  };

  syncProps(main, instance, true);
  visit(main, instance);

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
  return dedupeDeletes(doc, ops);
}

function createMirror(doc: Doc, mainNode: NodeRecord, parent: string, ops: Op[]): NodeRecord {
  const id = newId();
  const props: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(mainNode.props))
    if (!LINK_PROPS.has(prop)) props[prop] = value;
  props.mirrors = mainNode.id;
  const record: NodeRecord = {
    id,
    type: mainNode.type,
    parent,
    key: mainNode.key,
    props: props as Props,
  };
  ops.push({ op: "create", ...record });
  for (const childId of doc.childIds(mainNode.id)) {
    const child = doc.get(childId);
    if (child) createMirror(doc, child, id, ops);
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
  for (const id of ids) {
    const component = componentOf(doc, id);
    if (component) out.add(component.id);
  }
  return out;
}

/** Sync operations for every instance of the components `ids` touched. */
export function propagationOps(doc: Doc, ids: Iterable<string>): Op[] {
  const ops: Op[] = [];
  for (const componentId of affectedComponents(doc, ids)) {
    for (const instanceId of instancesOf(doc, componentId)) {
      // An instance inside its own component would recurse; wouldCycle prevents creating one.
      if (doc.ancestors(instanceId).some((a) => a.id === componentId)) continue;
      // A nested instance inside another instance mirrors the outer component's
      // copy, so it follows that copy (through the outer sync), not its main directly.
      if (getProp(doc.get(instanceId)?.props ?? {}, "mirrors") !== null) continue;
      ops.push(...syncInstanceOps(doc, instanceId));
    }
  }
  return ops;
}

/**
 * Overrides to record for a user's edit: every `set` of a synced property on a
 * layer inside an instance (or on the instance root) marks that property.
 */
export function overrideOps(doc: Doc, ops: readonly Op[]): Op[] {
  const marks = new Map<string, Set<string>>();
  for (const op of ops) {
    if (op.op !== "set" || LINK_PROPS.has(op.prop)) continue;
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

/** Turns an instance into a plain frame: no link to the main component, nothing synced. */
export function detachOps(doc: Doc, instanceId: string): Op[] {
  const ops: Op[] = [{ op: "set", id: instanceId, prop: "instanceOf", value: null }];
  const stack = [...doc.childIds(instanceId)];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = doc.get(id);
    if (!node) continue;
    if (isInstanceRoot(node)) {
      // Nested instances stay instances of their own components.
      if (getProp(node.props, "mirrors")) ops.push({ op: "set", id, prop: "mirrors", value: null });
      if (getProp(node.props, "overrides").length > 0)
        ops.push({ op: "set", id, prop: "overrides", value: null });
      continue;
    }
    if (getProp(node.props, "mirrors")) ops.push({ op: "set", id, prop: "mirrors", value: null });
    if (getProp(node.props, "overrides").length > 0)
      ops.push({ op: "set", id, prop: "overrides", value: null });
    stack.push(...doc.childIds(id));
  }
  return ops;
}

/** Properties of a node that differ from its main counterpart because of an override. */
export function overriddenProps(node: NodeRecord): readonly PropName[] {
  return getProp(node.props, "overrides").filter(isPropName);
}
