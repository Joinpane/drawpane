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
 *
 * Everything here reads layers unresolved (`Doc.getUnresolved`): a copy
 * copies its main's own values and bindings, and resolves them where it is
 * (decision 0034), rather than taking the values they resolve to in the main.
 */
import {
  copyChildId,
  getProp,
  isMainNode,
  isPropName,
  type NodeRecord,
  newId,
  type Op,
  type PropName,
  type Props,
} from "@drawpane/model";
import { LAYOUT_NEUTRAL } from "./compact-copies";
import { type Doc, Doc as DocCtor } from "./doc";
import { gridImportOps } from "./layout";
import { layerName } from "./names";

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
  "lockAspect",
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
  for (
    let node = doc.getUnresolved(id);
    node && node.type !== "page";
    node = doc.getUnresolved(node.parent)
  ) {
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
  for (
    let node = doc.getUnresolved(id);
    node && node.type !== "page";
    node = doc.getUnresolved(node.parent)
  ) {
    if (isInstanceRoot(node)) found = node;
    if (isMainComponent(node)) break;
  }
  return found;
}

/** The nearest main component at or above `id`, if any. */
export function componentOf(doc: Doc, id: string): NodeRecord | undefined {
  for (
    let node = doc.getUnresolved(id);
    node && node.type !== "page";
    node = doc.getUnresolved(node.parent)
  ) {
    if (isMainComponent(node)) return node;
  }
  return undefined;
}

/** True when `id` is a layer inside an instance (not the instance root itself). */
export function isInsideInstance(doc: Doc, id: string): boolean {
  const node = doc.getUnresolved(id);
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
  const instance = doc.getUnresolved(instanceId);
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
      const node = doc.getUnresolved(id);
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
      const node = doc.getUnresolved(id);
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
  for (
    let node = doc.getUnresolved(parent);
    node && node.type !== "page";
    node = doc.getUnresolved(node.parent)
  ) {
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
    const node = doc.getUnresolved(stack.pop() as string);
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
  const main = doc.getUnresolved(componentId);
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
      const child = doc.getUnresolved(childId);
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
  const instance = doc.getUnresolved(instanceId);
  const componentId =
    instance && instance.type === "frame" ? getProp(instance.props, "instanceOf") : null;
  const main = componentId ? doc.getUnresolved(componentId) : undefined;
  if (!instance || !main || !isMainComponent(main)) return [];

  // Map each main node id to its counterpart in this instance.
  const counterpart = new Map<string, NodeRecord>([[main.id, instance]]);
  const stray: NodeRecord[] = [];
  const walk = (id: string) => {
    for (const childId of doc.childIds(id)) {
      const child = doc.getUnresolved(childId);
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

  const syncProps = (
    from: NodeRecord,
    to: NodeRecord,
    isRoot: boolean,
    only?: (prop: string) => boolean,
  ) => {
    const overridden = new Set(getProp(to.props, "overrides"));
    // Auto layout decides where its children go and how big Hug and Fill
    // children are; the instance runs its own layout, so never copy those.
    const parent = isRoot ? undefined : doc.getUnresolved(to.parent);
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
      if (only && !only(prop)) continue;
      const want = from.props[prop];
      const have = to.props[prop];
      if (sameValue(want, have)) continue;
      ops.push({ op: "set", id: to.id, prop, value: want === undefined ? null : want });
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
   * A nested instance swapped for another component (its `instanceOf`
   * overridden): an instance of that component placed where its main layer
   * is, so it follows that component, not the main layer.
   */
  const swappedMain = (copy: NodeRecord, mainLayer: NodeRecord): NodeRecord | undefined => {
    const own = getProp(copy.props, "instanceOf");
    if (!own || own === getProp(mainLayer.props, "instanceOf")) return undefined;
    if (!getProp(copy.props, "overrides").includes("instanceOf")) return undefined;
    const swapped = doc.getUnresolved(own);
    return isMainNode(swapped) ? swapped : undefined;
  };

  const visit = (mainNode: NodeRecord, instanceParent: NodeRecord) => {
    for (const childId of doc.childIds(mainNode.id)) {
      const mainChild = doc.getUnresolved(childId);
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
      const swapped = swappedMain(existing, mainChild);
      if (swapped) {
        syncProps(mainChild, existing, false, (prop) => ROOT_LOCAL_PROPS.has(prop));
        syncProps(swapped, existing, true);
        nameAfterSet(existing, swapped.id);
      } else syncProps(mainChild, existing, false);
      visit(swapped ?? mainChild, existing);
    }
  };

  syncProps(main, instance, true);
  // Instances of a variant carry the set's name.
  nameAfterSet(instance, main.id);
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
  // Compact copies have their main's structure by construction (a swap rebuilds it): only
  // values are synced.
  if (doc.compactCopies) return ops.filter((op) => op.op === "set");
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
    const child = doc.getUnresolved(childId);
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
  // Every main component around the layer, not just the nearest: an edit
  // inside a component nested in another reaches the outer one's instances too.
  for (const id of ids)
    for (
      let node = doc.getUnresolved(id);
      node && node.type !== "page";
      node = doc.getUnresolved(node.parent)
    )
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
      const props = doc.getUnresolved(instanceId)?.props ?? {};
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
    let parent = doc.getUnresolved(node.parent);
    while (parent?.type === "group") parent = doc.getUnresolved(parent.parent);
    return isLayout(parent);
  };
  /** Mains whose layout inside may have changed. */
  const inner = new Set<string>();
  /** Mains whose root changed in a way its instances' parents read. */
  const sized = new Set<string>();
  for (const op of ops) {
    if (!reads(op)) continue;
    const node = op.op === "delete" ? undefined : doc.getUnresolved(op.id);
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
  const nodes = withSets(input, gridImportOps(doc));
  if (nodes !== input) doc.reset(nodes);
  const unlinked = new Set<string>();
  let detached = 0;
  for (const root of roots(doc)) {
    if (!syncInstanceOps(doc, root.id).some((op) => op.op !== "set")) continue;
    detached++;
    const queue = [root.id];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      // An instance inside it that copies nothing (what it put in a slot) is an instance root of
      // its own, kept or unlinked as it is.
      const node = doc.getUnresolved(id);
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
      const props: Record<string, unknown> = { ...node.props };
      delete props.instanceOf;
      delete props.mirrors;
      delete props.overrides;
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
    for (const op of syncInstanceOps(doc, root.id)) {
      if (op.op !== "set" || LINK_PROPS.has(op.prop)) continue;
      let set = marks.get(op.id);
      if (!set) {
        set = new Set(getProp(doc.getUnresolved(op.id)?.props ?? {}, "overrides"));
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
  for (const op of ops) {
    if (op.op !== "set" || LINK_PROPS.has(op.prop)) continue;
    const node = doc.getUnresolved(op.id);
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
    const node = doc.getUnresolved(id);
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
    const node = doc.getUnresolved(id);
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
    const node = doc.getUnresolved(id);
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
    const node = doc.getUnresolved(id);
    if (!node) continue;
    const overridden = getProp(node.props, "overrides");
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
      const child = doc.getUnresolved(childId);
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
  const component = doc.getUnresolved(componentId);
  const parent = component ? doc.getUnresolved(component.parent) : undefined;
  return isMainComponent(component) && isComponentSet(parent) ? parent : undefined;
}

/** The variants (main components) in a component set, in order. */
export function variantsOf(doc: Doc, setId: string): NodeRecord[] {
  return doc
    .childIds(setId)
    .map((id) => doc.getUnresolved(id))
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
  for (
    let node = doc.getUnresolved(id);
    node && node.id !== rootId;
    node = doc.getUnresolved(node.parent)
  ) {
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
  const instance = doc.getUnresolved(instanceId);
  const target = doc.getUnresolved(componentId);
  if (!instance || !isInstanceRoot(instance) || !target || !isMainComponent(target)) return [];
  if (doc.compactCopies) return swapCompactOps(doc, instance, target);

  // Overridden values by name path (the root keeps its own overrides as-is).
  const carried = new Map<string, Record<string, unknown>>();
  const stack = [...doc.childIds(instanceId)];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = doc.getUnresolved(id);
    if (!node) continue;
    const overridden = getProp(node.props, "overrides");
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
    const child = doc.getUnresolved(childId);
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
