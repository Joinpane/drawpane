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
  boundaryDrivenProps,
  constrainedValues,
  copyChildId,
  flowCopySizes,
  flowSized,
  getProp,
  hugsOn,
  isMainNode,
  isPropName,
  laidOutProps,
  measuresOn,
  type NodeRecord,
  newId,
  type Op,
  PLACED_INPUTS,
  type PropName,
  type Props,
  placedGeometry,
} from "@drawpane/model";
import { LAYOUT_NEUTRAL } from "./compact-copies";
import { type Doc, Doc as DocCtor } from "./doc";
import { gridImportOps } from "./layout";
import { layerName } from "./names";

/**
 * Never copied from a main component: they link instances or describe the
 * main itself (its variant values and its properties, decision 0035).
 */
const LINK_PROPS: ReadonlySet<string> = new Set([
  "isComponent",
  "componentDescription",
  "variantProps",
  "componentProps",
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
  const forbidden = cycleForbidden(doc, instance.parent);
  return listComponents(doc)
    .filter((c) => c.id !== current && !forbidden.has(c.id))
    .map((c) => {
      const set = componentSetOf(doc, c.id);
      const name = getProp(c.props, "name") || "Component";
      return {
        id: c.id,
        label: set ? `${getProp(set.props, "name") || "Set"} / ${name}` : name,
      };
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

/**
 * The components an instance placed under `parent` can't be of, as that
 * would make a component contain itself: every component above `parent`
 * (a main it's in, or what an instance it's in shows, since a nested
 * instance swapped there shows in it, so swapping the nested instance in
 * an instance of B to B would show B in B forever), and every component
 * holding one of those, itself or an instance of it, however deep. Read from the
 * instances of what's above, once, so asking about every component in a
 * large file (the swap menu) costs one walk.
 */
export function cycleForbidden(doc: Doc, parent: string): Set<string> {
  const out = new Set<string>();
  for (
    let node = doc.getUnresolved(parent);
    node && node.type !== "page";
    node = doc.getUnresolved(node.parent)
  ) {
    if (isMainComponent(node)) out.add(node.id);
    const of = node.type === "frame" ? getProp(node.props, "instanceOf") : null;
    if (of) out.add(of);
  }
  const queue = [...out];
  for (let i = 0; i < queue.length; i++) {
    const componentId = queue[i] as string;
    // Held by a main as itself (a component inside another), or as an instance of it.
    const roots = [
      componentId,
      ...(doc.compactCopies ? doc.instanceRoots(componentId) : instancesOf(doc, componentId)),
    ];
    for (const root of roots)
      for (
        let node = doc.getUnresolved(root);
        node && node.type !== "page";
        node = doc.getUnresolved(node.parent)
      )
        if (isMainComponent(node) && !out.has(node.id)) {
          out.add(node.id);
          queue.push(node.id);
        }
  }
  return out;
}

/** Would placing an instance of `componentId` under `parent` make a component contain itself? */
export function wouldCycle(doc: Doc, componentId: string, parent: string): boolean {
  return cycleForbidden(doc, parent).has(componentId);
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
  const forbidden = cycleForbidden(doc, parent);
  // Under no component, nothing it moves can end up inside itself.
  if (forbidden.size === 0) return true;
  for (const id of ids) {
    for (const componentId of instancedIn(doc, id)) if (forbidden.has(componentId)) return false;
    // A component moved in whose instances show one of those through a swap would show itself
    // inside itself there too (issue 311).
    for (const componentId of mainsIn(doc, id))
      for (const shown of swappedIn(doc, componentId)) if (forbidden.has(shown)) return false;
  }
  return true;
}

/** The main components a subtree holds, itself included. */
function mainsIn(doc: Doc, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length > 0) {
    const node = doc.getUnresolved(stack.pop() as string);
    if (!node) continue;
    if (isMainComponent(node)) out.push(node.id);
    stack.push(...doc.childIds(node.id));
  }
  return out;
}

/** The components a main's instances show through a nested instance swapped to them. */
function swappedIn(doc: Doc, componentId: string): Set<string> {
  const out = new Set<string>();
  for (const root of instancesOf(doc, componentId)) {
    const stack = [...doc.childIds(root)];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      const node = doc.get(id);
      if (!node) continue;
      stack.push(...doc.childIds(id));
      const shown = getProp(node.props, "instanceOf");
      const layer = doc.getUnresolved(getProp(node.props, "mirrors") ?? "");
      if (shown && layer && shown !== getProp(layer.props, "instanceOf")) out.add(shown);
    }
  }
  return out;
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

/** Sizes and places closer than this are the same (Figma saves them to a few decimals). */
const PLACE_EPSILON = 0.01;

/**
 * Operations that bring one instance in line with its main component:
 * properties (except overrides and root-local ones), missing layers, removed
 * layers and order. Returns [] when the main component is gone.
 *
 * A layer its constraints place in a copy frame of another size takes the
 * place they give it from its main layer's (`placedGeometry`), unless
 * `derive` is false: then what layout decides is only left alone, which is
 * how `pinInstances` reads a file as it was made.
 */
export function syncInstanceOps(
  doc: Doc,
  instanceId: string,
  { derive = true }: { readonly derive?: boolean } = {},
): Op[] {
  const instance = doc.getUnresolved(instanceId);
  const componentId =
    instance && instance.type === "frame" ? getProp(instance.props, "instanceOf") : null;
  const main = componentId ? doc.getUnresolved(componentId) : undefined;
  if (!instance || !main || !isMainComponent(main)) return [];

  // Each main node's copies in this instance. Two nested instances swapped to one component both
  // copy its layers, so a main node can have more than one: each frame takes its own.
  const copiesOf = new Map<string, NodeRecord[]>();
  const stray: NodeRecord[] = [];
  const walk = (id: string) => {
    for (const childId of doc.childIds(id)) {
      const child = doc.getUnresolved(childId);
      if (!child) continue;
      const mirrors = getProp(child.props, "mirrors");
      if (mirrors) copiesOf.set(mirrors, [...(copiesOf.get(mirrors) ?? []), child]);
      else stray.push(child);
      walk(childId);
    }
  };
  walk(instance.id);
  /** Copies already matched to a main node under their frame. */
  const used = new Set<string>();
  /** The copy of `mainId` for `parentId`: the one already there, else one elsewhere (moved). */
  const take = (mainId: string, parentId: string): NodeRecord | undefined => {
    const free = (copiesOf.get(mainId) ?? []).filter((c) => !used.has(c.id));
    const found = free.find((c) => c.parent === parentId) ?? free[0];
    if (found) used.add(found.id);
    return found;
  };

  const ops: Op[] = [];

  /**
   * What this sync sets so far, per node: a child is derived from its parent as it'll be. Not
   * without `derive`, whose operations say what differs rather than what's applied.
   */
  const pending = new Map<string, Record<string, unknown>>();
  /** Where this sync moves layers: a layer is derived in the parent it'll be in. */
  const movedTo = new Map<string, string>();
  const push = (op: Op) => {
    ops.push(op);
    if (op.op === "move") movedTo.set(op.id, op.parent);
    if (op.op !== "set") return;
    const props = pending.get(op.id) ?? {};
    props[op.prop] = op.value;
    pending.set(op.id, props);
  };
  const synced = (node: NodeRecord | undefined): NodeRecord | undefined => {
    const props = derive && node && pending.get(node.id);
    if (!props) return node;
    // A null set clears the field: it reads as its default once applied, or with compact
    // copies as its main's (an instance root's main, a copy layer's main layer).
    const linked = getProp(node.props, "instanceOf") ?? getProp(node.props, "mirrors");
    const main = doc.compactCopies && linked ? doc.getUnresolved(linked) : undefined;
    const next: Record<string, unknown> = { ...node.props };
    for (const [prop, value] of Object.entries(props)) {
      const now = value === null || value === undefined ? main?.props[prop as PropName] : value;
      if (now === undefined) delete next[prop];
      else next[prop] = now;
    }
    return { ...node, props: next as NodeRecord["props"] };
  };

  const syncProps = (
    from: NodeRecord,
    to: NodeRecord,
    isRoot: boolean,
    only?: (prop: string) => boolean,
  ) => {
    const overridden = new Set<string>(getProp(to.props, "overrides"));
    // The copy as this sync leaves it where it decides how it's placed and sized: its main
    // layer's constraints, positioning and sizing, unless it overrides them (a main made fixed
    // width gives its instances that width, though they hugged).
    // Not without `derive`, which reads what differs (an import's own Fill stays its own).
    const asSynced: Record<string, unknown> = {};
    if (derive)
      for (const prop of [
        "constraintH",
        "constraintV",
        "positioning",
        "sizingH",
        "sizingV",
        // Whether its text sizes itself, so whether its constraints size it.
        "textAutoResize",
      ] as const)
        if (!overridden.has(prop)) asSynced[prop] = from.props[prop];
    const nextProps: Record<string, unknown> = { ...to.props };
    for (const [prop, value] of Object.entries(asSynced))
      if (value === undefined) delete nextProps[prop];
      else nextProps[prop] = value;
    const next = { ...to, props: nextProps as NodeRecord["props"] };
    const parent = isRoot
      ? undefined
      : synced(doc.getUnresolved((derive && movedTo.get(to.id)) || to.parent));
    const parentSource = isRoot ? undefined : doc.getUnresolved(from.parent);
    // What layout decides (auto layout, hug and fill, auto-sized text, constraints in a resized
    // frame): the instance runs its own layout, so never copy those (decision 0035).
    const laidOut = laidOutProps(next, from, {
      root: isRoot,
      parent,
      parentSource,
    });
    // Where it sits and how big it is comes from the one derivation both formats use: what it
    // derives is written, what it keeps (its own layout's, or its own) is left as it is.
    const placed = derive && !isRoot ? placedGeometry(next, from, parent, parentSource) : undefined;
    const derived: Record<string, number> = { ...placed?.derived };
    for (const prop of Object.keys(placed?.kept ?? {})) overridden.add(prop);
    for (const prop of laidOut) if (!(prop in derived)) overridden.add(prop);
    // Glyphs saved with a file were laid out for each copy (decision 0037); a stale set is
    // never drawn, so the copy's own is kept rather than replaced by its main's.
    if (from.type === "text") overridden.add("glyphLayout");
    const keys = new Set([...Object.keys(from.props), ...Object.keys(to.props)]);
    for (const prop of keys) {
      if (!isPropName(prop) || LINK_PROPS.has(prop) || overridden.has(prop)) continue;
      if (isRoot && ROOT_LOCAL_PROPS.has(prop)) continue;
      if (only && !only(prop)) continue;
      const have = to.props[prop];
      if (prop in derived) {
        const want = derived[prop] as number;
        if (Math.abs(getProp(to.props, prop as "x") - want) > PLACE_EPSILON)
          push({ op: "set", id: to.id, prop, value: want });
        continue;
      }
      const want = from.props[prop];
      if (sameValue(want, have)) continue;
      push({
        op: "set",
        id: to.id,
        prop,
        value: want === undefined ? null : want,
      });
    }
    // A derived axis whose value the main layer doesn't hold (its default) is derived too.
    for (const [prop, want] of Object.entries(derived)) {
      if (keys.has(prop) || overridden.has(prop) || (only && !only(prop))) continue;
      if (Math.abs(getProp(to.props, prop as "x") - want) > PLACE_EPSILON)
        push({ op: "set", id: to.id, prop: prop as PropName, value: want });
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

  /** The main layers being visited, outermost first: one met again inside itself is a cycle. */
  const visiting = new Set<string>();
  const visit = (mainNode: NodeRecord, instanceParent: NodeRecord) => {
    // A swap can show a component inside one that holds it (issue 311); stop rather than recurse.
    if (visiting.has(mainNode.id)) return;
    visiting.add(mainNode.id);
    visitChildren(mainNode, instanceParent);
    visiting.delete(mainNode.id);
  };
  const visitChildren = (mainNode: NodeRecord, instanceParent: NodeRecord) => {
    for (const childId of doc.childIds(mainNode.id)) {
      const mainChild = doc.getUnresolved(childId);
      if (!mainChild) continue;
      const existing = take(mainChild.id, instanceParent.id);
      if (!existing || existing.type !== mainChild.type) {
        if (existing) ops.push({ op: "delete", id: existing.id });
        // Create the missing subtree under its counterpart parent.
        // Made where its frame differs from its main layer's: placed as its constraints say.
        const created = createMirror(
          doc,
          mainChild,
          instanceParent.id,
          ops,
          derive ? synced(instanceParent) : undefined,
        );
        used.add(created.id);
        continue;
      }
      if (existing.parent !== instanceParent.id || existing.key !== mainChild.key) {
        push({
          op: "move",
          id: existing.id,
          parent: instanceParent.id,
          key: mainChild.key,
        });
      }
      const swapped = swappedMain(existing, mainChild);
      if (swapped) {
        // Where it sits, and what the outer component's properties drive (its visibility, say),
        // are its main layer's; the rest is the swapped-in component's (decision 0035).
        const boundary = new Set([...ROOT_LOCAL_PROPS, ...boundaryDrivenProps(mainChild)]);
        syncProps(mainChild, existing, false, (prop) => boundary.has(prop));
        syncProps(swapped, existing, true, (prop) => !boundary.has(prop));
        nameAfterSet(existing, swapped.id);
      } else syncProps(mainChild, existing, false);
      visit(swapped ?? mainChild, existing);
    }
  };

  syncProps(main, instance, true);
  // Instances of a variant carry the set's name.
  nameAfterSet(instance, main.id);
  visit(main, instance);

  // Layers whose main counterpart is gone, or that none took (or that never had one), don't
  // belong in an instance.
  for (const copies of copiesOf.values())
    for (const node of copies)
      if (!used.has(node.id) && doc.has(node.id)) ops.push({ op: "delete", id: node.id });
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

/**
 * A copy of `mainNode` and its layers, made under `parent`. With `placeIn`
 * (the parent as it'll be), each layer is placed by its constraints in the
 * frame made for it, as its main layer would be in a frame of that size.
 */
function createMirror(
  doc: Doc,
  mainNode: NodeRecord,
  parent: string,
  ops: Op[],
  placeIn?: NodeRecord,
): NodeRecord {
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
  if (placeIn) {
    const parentMain = doc.getUnresolved(mainNode.parent);
    Object.assign(props, placedGeometry(record, mainNode, placeIn, parentMain)?.derived);
  }
  ops.push({ op: "create", ...record });
  for (const childId of doc.childIds(mainNode.id)) {
    const child = doc.getUnresolved(childId);
    if (child) createMirror(doc, child, id, ops, placeIn ? record : undefined);
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

/** A frame's own fields its layers' places and sizes read (`placedGeometry`, `flowCopySizes`). */
const FRAME_PLACING: ReadonlySet<string> = new Set(["layoutMode", "alignItems", "justifyItems"]);

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * What keeps a frame's layers as the auto layout it took away left them (a frame of an instance
 * whose own layout mode was taken away: an older file's edit, or an older client's). Each layer
 * the flow placed keeps its place, and a text its mode; a size that flow or its main layer's own
 * flow decided (Fill or Stretch), or that differs from what its main layer and constraints give,
 * is its own. Marked with their values, so compact copies store them, whatever the main's flow
 * does later. Layers in `skip` are left out (the edit sets them itself). `later` reads a main's
 * layer as an edit about to apply leaves it, so a size its flow decides only then is kept too.
 */
function leftFlowMarks(
  doc: Doc,
  frame: NodeRecord,
  view: (id: string) => NodeRecord | undefined,
  skip: ReadonlySet<string>,
  later: (node: NodeRecord) => NodeRecord = (node) => node,
): Op[] {
  const out: Op[] = [];
  const shown = doc.get(
    getProp(frame.props, "instanceOf") ?? getProp(frame.props, "mirrors") ?? "",
  );
  // The flow it left: its main's kind of flow, with its own alignment (its main's, unless it
  // overrides it), as it reads now and once the edit applies.
  const flowLeft = (main: NodeRecord | undefined) => {
    const mode = main ? getProp(main.props, "layoutMode") : "none";
    if (getProp(frame.props, "layoutMode") !== "none" || mode === "none" || !main) return frame;
    const alignItems = getProp(frame.props, "overrides").includes("alignItems")
      ? getProp(frame.props, "alignItems")
      : getProp(main.props, "alignItems");
    return { ...frame, props: { ...frame.props, layoutMode: mode, alignItems } } as NodeRecord;
  };
  const left = flowLeft(shown);
  const leftLater = flowLeft(shown && later(shown));
  // A copy's sizing and alignment are its main layer's, unless it overrides them.
  const SIZING = ["sizingH", "sizingV", "alignSelf", "rotation"] as const;
  const copyLater = (copy: NodeRecord, source: NodeRecord) => {
    const next = later(source);
    if (next === source) return copy;
    const own = getProp(copy.props, "overrides");
    const props = { ...copy.props } as Record<string, unknown>;
    for (const prop of SIZING) if (!own.includes(prop)) props[prop] = getProp(next.props, prop);
    return { ...copy, props: props as Props } as NodeRecord;
  };
  for (const child of doc.childIds(frame.id)) {
    if (skip.has(child)) continue;
    const copy = view(child);
    const source = copy ? doc.get(getProp(copy.props, "mirrors") ?? "") : undefined;
    if (!copy || !source) continue;
    const own = getProp(copy.props, "overrides");
    const bound = getProp(copy.props, "bindings") as Record<string, unknown>;
    // Where the flow put it: a layer out of the flow (absolute, or hidden) it didn't place.
    const placed =
      getProp(copy.props, "positioning") !== "absolute" && getProp(copy.props, "visible");
    const marks: PropName[] = placed
      ? (["x", "y"] as const).filter((prop) => !own.includes(prop) && !bound[prop])
      : [];
    // What its main layer and its constraints give it, with no flow: a size the flow gave it
    // otherwise is kept, and so is one a flow decided, though it's its main layer's now (compact
    // copies would show the main layer's once its own flow changes).
    const sourceParent = doc.get(source.parent);
    const plain = constrainedValues(copy, source, frame, sourceParent);
    for (const prop of ["width", "height"] as const) {
      const axis = prop === "width" ? "h" : "v";
      const want = plain[prop] ?? getProp(source.props, prop);
      if (
        !own.includes(prop) &&
        !bound[prop] &&
        !hugsOn(copy, axis) &&
        !measuresOn(copy, axis) &&
        (flowSized(copy, left, axis) ||
          flowSized(copyLater(copy, source), leftLater, axis) ||
          (!!sourceParent &&
            (flowSized(source, sourceParent, axis) ||
              flowSized(later(source), later(sourceParent), axis))) ||
          Math.abs(getProp(copy.props, prop) - want) > PLACE_EPSILON)
      )
        marks.push(prop);
    }
    // A text keeps the mode it has, the flow's or its main's (a main's flow can switch the main
    // layer's later, decision 0043).
    if (
      copy.type === "text" &&
      !own.includes("textAutoResize") &&
      (placed || getProp(copy.props, "textAutoResize") !== getProp(source.props, "textAutoResize"))
    )
      marks.push("textAutoResize");
    if (marks.length === 0) continue;
    for (const prop of marks)
      out.push({ op: "set", id: child, prop, value: getProp(copy.props, prop) } as Op);
    out.push({ op: "set", id: child, prop: "overrides", value: [...own, ...marks] });
  }
  return out;
}

/** What decides whether a flow sizes a layer, which a copy takes from what it copies. */
const INHERITED_FLOW = [
  "layoutMode",
  "alignItems",
  "sizingH",
  "sizingV",
  "alignSelf",
  "rotation",
] as const;

/** A frame of an instance that took its own auto layout away (its layout mode, an override). */
function leftItsFlow(node: NodeRecord | undefined): boolean {
  return (
    node?.type === "frame" &&
    getProp(node.props, "layoutMode") === "none" &&
    getProp(node.props, "overrides").includes("layoutMode") &&
    (!!getProp(node.props, "mirrors") || !!getProp(node.props, "instanceOf"))
  );
}

const leftFlowCache = new WeakMap<Doc, { version: number; readonly frames: Set<string> }>();

/**
 * The frames that took their auto layout away (`leftItsFlow`), caught up with the document as
 * the instances index is. Read whole from what's stored (compact copies' override records, not
 * every copy built), then from the change log, which names every layer an edit set.
 */
function leftFlowFrames(doc: Doc): ReadonlySet<string> {
  const cached = leftFlowCache.get(doc);
  if (cached) {
    if (cached.version === doc.version) return cached.frames;
    const changes = doc.changesSince(cached.version);
    if (changes && !changes.some((c) => c.reset)) {
      for (const change of changes)
        for (const id of change.ids) {
          if (leftItsFlow(doc.getUnresolved(id))) cached.frames.add(id);
          else cached.frames.delete(id);
        }
      cached.version = doc.version;
      return cached.frames;
    }
  }
  const frames = new Set<string>();
  for (const record of doc.stored())
    if (
      getProp(record.props, "overrides").includes("layoutMode") &&
      leftItsFlow(doc.getUnresolved(record.id))
    )
      frames.add(record.id);
  leftFlowCache.set(doc, { version: doc.version, frames });
  return frames;
}

/**
 * Marks, made before an edit applies, for the frames that took the auto layout of a frame it
 * changes (or of what's in it) away. A removal an older client made arrives without the marks
 * `leftFlowMarks` gives (the client receiving it lays nothing out), so the edit that would change
 * what that flow left, a change to the main's flow say, marks it while the flow it left is still
 * there to read.
 */
export function leftFlowKeepOps(doc: Doc, ops: readonly Op[]): Op[] {
  const left = leftFlowFrames(doc);
  if (left.size === 0) return [];
  // The frames the edit changes, or changes what's in.
  const touched = new Set<string>();
  for (const op of ops) {
    if (op.op === "create") {
      touched.add(op.parent);
      continue;
    }
    touched.add(op.id);
    const node = doc.getUnresolved(op.id);
    if (node) touched.add(node.parent);
    if (op.op === "move") touched.add(op.parent);
  }
  const skip = new Set(ops.map((op) => op.id));
  // A layer as the edit leaves it: what it sets on it, and what the layer takes from what it
  // copies or shows (its flow and sizing, where it doesn't override them), as that's left.
  const sets = new Map<string, Record<string, unknown>>();
  for (const op of ops)
    if (op.op === "set") sets.set(op.id, { ...sets.get(op.id), [op.prop]: op.value });
  const seen = new Map<string, NodeRecord>();
  const later = (node: NodeRecord, depth = 0): NodeRecord => {
    const known = seen.get(node.id);
    if (known) return known;
    let props: Record<string, unknown> | null = null;
    const from = doc.get(getProp(node.props, "mirrors") ?? getProp(node.props, "instanceOf") ?? "");
    if (from && depth < 32) {
      const next = later(from, depth + 1);
      if (next !== from) {
        const own = getProp(node.props, "overrides");
        props = { ...node.props };
        for (const prop of INHERITED_FLOW)
          if (!own.includes(prop)) props[prop] = getProp(next.props, prop);
      }
    }
    const changed = sets.get(node.id);
    if (changed) {
      props ??= { ...node.props };
      for (const [prop, value] of Object.entries(changed))
        if (value === null) delete props[prop];
        else props[prop] = value;
    }
    const out = props ? ({ ...node, props: props as Props } as NodeRecord) : node;
    seen.set(node.id, out);
    return out;
  };
  const out: Op[] = [];
  for (const id of left) {
    const frame = doc.get(id);
    if (!frame) continue;
    // The frame itself or what's in it, or what it shows and what that copies in turn: a flow it
    // left there, which the edit changes.
    const shown = doc.get(
      getProp(frame.props, "instanceOf") ?? getProp(frame.props, "mirrors") ?? "",
    );
    let reached = touched.has(id);
    for (let node: NodeRecord | undefined = shown, depth = 0; node && depth < 32; depth++) {
      if (touched.has(node.id)) {
        reached = true;
        break;
      }
      node = doc.get(getProp(node.props, "mirrors") ?? "");
    }
    if (reached) out.push(...leftFlowMarks(doc, frame, (c) => doc.get(c), skip, later));
  }
  return out;
}

/**
 * With compact copies, the places constraints give copy layers after `ops`
 * moved, resized or re-pinned layers in mains (decision 0035, item 7): a
 * copy frame of another size than its main's holds its children's places as
 * laid out values, so they're derived again from their main layers'
 * (`placedGeometry`), as materialized sync does. Only instances that
 * store a value a layout reads can differ in size, so only they're walked.
 */
export function copyConstraintOps(doc: Doc, ops: readonly Op[]): Op[] {
  // What changes where a copy is placed is what the derivation reads (`PLACED_INPUTS`).
  const placing = (op: Op) =>
    (op.op === "set" && PLACED_INPUTS.has(op.prop)) ||
    (op.op === "create" && Object.keys(op.props).some((prop) => PLACED_INPUTS.has(prop)));
  // A copy layer that changed one itself, in either format: placed again, with what's in it.
  const repinned = ops
    .filter(placing)
    .map((op) => op.id)
    .filter((id) => !!getProp(doc.get(id)?.props ?? {}, "mirrors"));
  // Where to start, from every reason below; then each of them and what's in them is placed,
  // parents first, so a layer is placed in its frame as this pass leaves it.
  const starts = [...repinned];
  // An instance whose own layout changed (given auto layout, say): its layers read it, so they're
  // placed again (a fixed size a constraint shrank is its main layer's once a flow holds it).
  for (const op of ops)
    if (
      op.op === "set" &&
      (FRAME_PLACING.has(op.prop) ||
        (op.prop === "unset" &&
          Array.isArray(op.value) &&
          op.value.some((prop) => FRAME_PLACING.has(String(prop)))))
    ) {
      const node = doc.get(op.id);
      if (node && !getProp(node.props, "mirrors") && getProp(node.props, "instanceOf"))
        starts.push(...doc.childIds(op.id));
    }
  // A swapped instance shows another main's layers: placed for the size the instance has (nested
  // ones too, whose layout difference their outer instance holds).
  if (doc.compactCopies)
    for (const op of ops)
      if (op.op === "set" && op.prop === "instanceOf") starts.push(...doc.childIds(op.id));
  // What changed how main layers are placed, or came into a main (made there, or moved in).
  const touched = doc.compactCopies
    ? ops.filter((op) => placing(op) || op.op === "create" || op.op === "move").map((op) => op.id)
    : [];
  const mains = touched.length > 0 ? affectedComponents(doc, touched) : new Set<string>();
  const queue = [...mains];
  for (let i = 0; i < queue.length; i++)
    for (const root of doc.instanceRoots(queue[i] as string))
      for (const outer of affectedComponents(doc, [root]))
        if (!mains.has(outer)) {
          mains.add(outer);
          queue.push(outer);
        }
  // An instance whose copies may sit otherwise than its main's layers: it stores a layout value,
  // or it's shown in another mode where a bound size makes it another size than its main.
  const sized = (root: string, main: string) => {
    const a = doc.get(root);
    const b = doc.get(main);
    return (
      !!a &&
      !!b &&
      (getProp(a.props, "width") !== getProp(b.props, "width") ||
        getProp(a.props, "height") !== getProp(b.props, "height"))
    );
  };
  const differs = (root: string, main: string) =>
    doc.layoutDiffers(root) || (doc.tokens.modesDiffer(root, main) && sized(root, main));
  const roots = new Set<string>();
  for (const main of mains)
    for (const root of doc.instanceRoots(main)) {
      if (roots.has(root) || !differs(root, main)) continue;
      roots.add(root);
      starts.push(...doc.childIds(root));
    }
  // An instance just made or moved (into another mode, say) is placed where it now is.
  if (doc.compactCopies)
    for (const op of ops) {
      if (op.op !== "move" && op.op !== "create") continue;
      const node = doc.get(op.id);
      const main =
        node && !getProp(node.props, "mirrors") ? getProp(node.props, "instanceOf") : null;
      if (main && !roots.has(op.id) && differs(op.id, main)) {
        roots.add(op.id);
        starts.push(...doc.childIds(op.id));
      }
    }
  if (starts.length === 0) return [];
  // Starts shallowest first (a start inside another comes with it), each walked parents first.
  const unique = [...new Set(starts)].filter((id) => doc.has(id));
  const depth = new Map(unique.map((id) => [id, doc.ancestors(id).length]));
  unique.sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0));
  const order: string[] = [];
  const seen = new Set<string>();
  for (const start of unique) {
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      stack.push(...doc.childIds(id));
    }
  }
  const out: Op[] = [];
  const pending = new Map<string, Record<string, unknown>>();
  const view = (id: string): NodeRecord | undefined => {
    const node = doc.get(id);
    const props = node && pending.get(id);
    return props ? { ...node, props: { ...node.props, ...props } as Props } : node;
  };
  // A frame of an instance that takes its own auto layout away (an older file's edit, or an older
  // client's) leaves its layers as the layout made them, as Figma does (`leftFlowMarks`).
  for (const op of ops) {
    if (op.op !== "set" || op.prop !== "layoutMode" || (op.value !== null && op.value !== "none"))
      continue;
    const frame = doc.get(op.id);
    if (!frame || (!getProp(frame.props, "mirrors") && !getProp(frame.props, "instanceOf")))
      continue;
    // Taken away, not reset: what it shows has a flow, or its own layout mode is an override.
    const shown = doc.get(
      getProp(frame.props, "instanceOf") ?? getProp(frame.props, "mirrors") ?? "",
    );
    if (
      !(shown && getProp(shown.props, "layoutMode") !== "none") &&
      !getProp(frame.props, "overrides").includes("layoutMode")
    )
      continue;
    for (const mark of leftFlowMarks(doc, frame, view, NO_IDS)) {
      out.push(mark);
      if (mark.op === "set")
        pending.set(mark.id, { ...pending.get(mark.id), [mark.prop]: mark.value });
    }
  }
  for (const id of order)
    for (const op of copyPlaceOps(doc, id, view)) {
      out.push(op);
      if (op.op === "set") pending.set(op.id, { ...pending.get(op.id), [op.prop]: op.value });
    }
  return out;
}

/** The writes that put a copy layer where `placedGeometry` places it, and give it its main's text mode. */
function copyPlaceOps(doc: Doc, id: string, view: (id: string) => NodeRecord | undefined): Op[] {
  const out: Op[] = [];
  const copy = view(id);
  if (!copy) return out;
  const sourceId = getProp(copy.props, "mirrors");
  const source = sourceId ? doc.get(sourceId) : undefined;
  if (!source) return out;
  const parent = view(copy.parent);
  const placed = placedGeometry(copy, source, parent, doc.get(source.parent));
  // In a flow, what's left is its own fixed size, its main layer's (a laid-out size it stored
  // before, say as Hug in another mode, no longer is one).
  const derived = placed
    ? placed.derived
    : flowCopySizes(copy, source, parent, doc.get(source.parent));
  // Compared as presented (a value it doesn't store reads as its default), so nothing it already
  // shows is written again.
  for (const [prop, want] of Object.entries(derived) as ["x" | "y" | "width" | "height", number][])
    if (Math.abs(getProp(copy.props, prop) - want) > PLACE_EPSILON)
      out.push({ op: "set", id, prop, value: want });
  // Placed freely, a copy text keeps its main layer's auto-resize (decision 0043): constraints
  // never switch it. In a flow, the flow's Fill and stretch decide it.
  const own = getProp(source.props, "textAutoResize");
  if (
    placed &&
    copy.type === "text" &&
    !getProp(copy.props, "overrides").includes("textAutoResize") &&
    getProp(copy.props, "textAutoResize") !== own
  )
    out.push({ op: "set", id, prop: "textAutoResize", value: own });
  return out;
}

/**
 * With compact copies, what to lay out again after `ops` changed `ids`.
 * Every copy that equals its main is laid out already (it is its main), so
 * only two kinds of instance need it:
 *
 * - one whose layout differs from its main's (it stores a value a layout
 *   reads: a text, a size, a hidden layer; or it shows another mode than
 *   its main, so bound values resolve otherwise), when its main's layout
 *   inside may have changed: frames place their children and affected
 *   texts measure themselves;
 * - one whose main changed size, so its parent's layout places it again.
 *
 * A main whose instances (inside it, as the icon in a button) changed size
 * changed inside too, with no operation of its own. Changes no layout reads
 * (a fill, a name, a child of a frame without auto layout) lay out nothing.
 */
export function relayoutTargets(
  doc: Doc,
  ids: Iterable<string>,
  ops: readonly Op[],
): { layout: string[]; text: string[] } {
  const layout: string[] = [];
  const text: string[] = [];
  if (!doc.compactCopies) return { layout, text };
  const changes = ops.filter((op) => {
    if (op.op !== "set") return true;
    // An overridden string can still display its main's bound value. Unbinding
    // can expose the copy's saved text, so treat a text binding edit as a layout edit.
    if (op.prop === "bindings") return doc.getUnresolved(op.id)?.type === "text";
    // Strokes take room in a layout only on a frame that includes them.
    if (op.prop === "strokes" || op.prop === "strokeAlign")
      return doc.getUnresolved(op.id)?.type === "frame";
    return op.prop !== "overrides" && !LAYOUT_NEUTRAL.has(op.prop);
  });
  if (changes.length === 0) return { layout, text };
  // Text overrides can insulate the entire copy from a text edit. A refit
  // with the browser's metrics would still rewrite those imported text boxes.
  // Run edits can change run bindings as well as their saved values.
  const charactersOnly = changes.every((op) => op.op === "set" && op.prop === "characters");
  const changedCharacters = charactersOnly ? new Set(changes.map((op) => op.id)) : null;
  // Only the main's characters changed (a binding edit isn't characters-only),
  // so a copy that overrides them shows the same text as before: its own, or
  // its binding's value, which this edit didn't touch.
  const inheritsTextChange = (id: string): boolean => {
    let overridden = false;
    for (let node = doc.getUnresolved(id); node?.type === "text"; ) {
      if (changedCharacters?.has(node.id)) return !overridden;
      overridden ||= getProp(node.props, "overrides").includes("characters");
      const source = getProp(node.props, "mirrors");
      node = source ? doc.getUnresolved(source) : undefined;
    }
    return false;
  };
  const isLayout = (node: NodeRecord | undefined) =>
    node?.type === "frame" && getProp(node.props, "layoutMode") !== "none";
  // In a layout here, or in one of its copies: an instance can give a copy of a plain frame
  // auto layout of its own (an override), so what's in that frame lays out there.
  const inLayout = (node: NodeRecord) => {
    let parent = doc.getUnresolved(node.parent);
    while (parent?.type === "group") parent = doc.getUnresolved(parent.parent);
    if (!parent || isLayout(parent)) return !!parent;
    for (const copy of doc.tokens.source().builtFrom([parent.id]))
      if (isLayout(doc.getUnresolved(copy))) return true;
    return false;
  };
  // A layout in one of its own copies: an instance can give a copy of a plain frame auto layout of
  // its own (an older file's edit), which reads what changed on its main layer (its alignment).
  const layoutInCopy = (node: NodeRecord) => {
    for (const copy of doc.tokens.source().builtFrom([node.id]))
      if (isLayout(doc.getUnresolved(copy))) return true;
    return false;
  };
  /** Mains whose layout inside may have changed. */
  const inner = new Set<string>();
  /** Mains whose root changed in a way its instances' parents read. */
  const sized = new Set<string>();
  for (const op of changes) {
    const node = op.op === "delete" ? undefined : doc.getUnresolved(op.id);
    if (!node) {
      // Gone: whatever held it may have changed.
      for (const id of affectedComponents(doc, ids)) inner.add(id);
      continue;
    }
    // Moved: the component it left changed too (a frame there lost a layer).
    if (op.op === "move") for (const id of affectedComponents(doc, ids)) inner.add(id);
    const around = affectedComponents(doc, [node.id]);
    if (around.size === 0) continue;
    const isRoot = isMainComponent(node);
    if (isRoot && op.op === "set" && ROOT_LOCAL_PROPS.has(op.prop)) continue;
    if (isRoot) sized.add(node.id);
    if (isRoot || node.type === "text" || isLayout(node) || inLayout(node) || layoutInCopy(node))
      for (const id of around) inner.add(id);
  }
  /** What changed in the mains: the layers their copies are laid out again around. */
  const seeds = new Set(ids);
  // A main holding instances of a resized main changed inside, however deep: around them.
  const queue = [...sized];
  for (let i = 0; i < queue.length; i++)
    for (const root of doc.instanceRoots(queue[i] as string)) {
      seeds.add(root);
      for (const outer of affectedComponents(doc, [root]))
        if (!inner.has(outer)) {
          inner.add(outer);
          queue.push(outer);
        }
    }
  // A main holding instances of one whose layout inside changed holds copies of the change: an
  // instance of it laid out otherwise (in another mode) lays them out too, however deep.
  const around = [...inner];
  for (let i = 0; i < around.length; i++)
    for (const root of doc.instanceRoots(around[i] as string))
      for (const outer of affectedComponents(doc, [root]))
        if (!inner.has(outer)) {
          inner.add(outer);
          around.push(outer);
        }
  // An auto layout frame that stretches in a flow brings what's in it to its line or track (layout's
  // contribution), so a change inside its main can resize it, and that flow, even where the main's
  // own box stays put (a main on the page, which Fill and stretch don't size): laid out again, as a
  // resized main's instances are.
  const stretchesInFlow = (root: string) => {
    const node = doc.getUnresolved(root);
    if (!node || !isLayout(node) || getProp(node.props, "positioning") === "absolute") return false;
    let parent = doc.getUnresolved(node.parent);
    while (parent?.type === "group") parent = doc.getUnresolved(parent.parent);
    if (!parent || !isLayout(parent)) return false;
    if (getProp(parent.props, "layoutMode") === "grid") return true;
    const sizes = [getProp(node.props, "sizingH"), getProp(node.props, "sizingV")];
    if (sizes.includes("fill")) return true;
    const self = getProp(node.props, "alignSelf");
    const align = self === "auto" ? getProp(parent.props, "alignItems") : self;
    return align === "stretch" && sizes.some((size) => size !== "hug");
  };
  const seen = new Set<string>();
  /** Instances laid out differently from their mains, whose layout inside may have changed. */
  const differing: string[] = [];
  for (const componentId of new Set([...inner, ...sized])) {
    for (const root of doc.instanceRoots(componentId)) {
      if (seen.has(root) || !doc.has(root)) continue;
      if (doc.ancestors(root).some((a) => a.id === componentId)) continue;
      // Laid out otherwise than its main: by what it stores, or by being shown in another mode
      // (whose layout values its main's changes don't carry: a main moved into Dark lays out
      // its own layers, and an instance in Light that stores nothing would show them so).
      const differs = doc.layoutDiffers(root) || doc.tokens.modesDiffer(root, componentId);
      if (differs && inner.has(componentId)) {
        seen.add(root);
        differing.push(root);
      } else if (sized.has(componentId) || (inner.has(componentId) && stretchesInFlow(root)))
        layout.push(root);
    }
  }
  if (differing.length === 0) return { layout, text };
  // In each, the copies of what changed (and the instance itself): laid out as it is
  // otherwise, the rest of it comes out the same. Built first, so every copy is found.
  for (const root of differing) doc.childIds(root);
  const copies = new Map<string, string[]>();
  for (const id of doc.tokens.source().builtFrom(seeds)) {
    const root = doc.copySlot(id)?.root;
    if (!root) continue;
    const list = copies.get(root);
    if (list) list.push(id);
    else copies.set(root, [id]);
  }
  for (const root of differing) {
    const changed = [root, ...(copies.get(root) ?? [])];
    const toMeasure = changedCharacters ? changed.filter(inheritsTextChange) : changed;
    if (toMeasure.length === 0) continue;
    for (const id of changed) layout.push(id);
    for (const id of toMeasure) text.push(id);
  }
  return { layout, text };
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
    if (!syncInstanceOps(doc, root.id, { derive: false }).some((op) => op.op !== "set")) continue;
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
    for (const op of syncInstanceOps(doc, root.id, { derive: false })) {
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
    return {
      ...node,
      props: { ...node.props, overrides: [...set].sort() as PropName[] },
    };
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
    // An instance's place and pinning are its own, unless it's nested in another instance: then
    // it's a copy layer like any other, and a person's move of it is an override.
    if (isRoot && ROOT_LOCAL_PROPS.has(op.prop) && !isInsideInstance(doc, op.id)) continue;
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
        ops.push({
          op: "set",
          id,
          prop: "overrides",
          value: Object.keys(values),
        });
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
  ops.push({
    op: "set",
    id: instanceId,
    prop: "instanceOf",
    value: componentId,
  });
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
