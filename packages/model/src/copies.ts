/**
 * Compact copies (decision 0029): a component's copies stored as their main
 * plus what's overridden, and presented as ordinary layers.
 *
 * **Stored form.** An instance root is a stored frame with `instanceOf`. It
 * stores its root-local properties (position, constraints), its `overrides`
 * and every other property whose value differs from its main's. The layers
 * inside it aren't stored: one that differs from the main layer it copies is
 * an **override record** (type `override`) under the instance root, holding
 * its `path`, the properties that differ, its `overrides` and `unset` (the
 * properties it has at their default where its main's layer has a value).
 * A value in a record whose property isn't in its `overrides` was decided by
 * layout (or another derived write), not by a person: it's "laid out", and
 * the next layout of that instance replaces it, or drops it once it equals
 * the main's again.
 *
 * **Ids.** A copy layer's id is `copyId(root, path)`: chained SHA-256, each
 * step `base62(sha256(parentId + "/" + element))`, 16 characters, starting
 * from the instance root's id. So a copy's id is `copyChildId(its parent's
 * id, its mirrors)`. Its record has the same id.
 *
 * **Paths.** A path is the ids of the main's layers the copy layer and its
 * ancestors copy, from the instance root down: each element is a layer's
 * `mirrors`. Through a nested instance, the path goes on with the ids of its
 * main's layers as that main presents them (themselves copy ids when the
 * nested instance is in the main), or a swapped-in main's. Ids that are
 * presented, not stored, keep a copy's id when what it copies becomes
 * stored layers with the same ids (detaching a nested instance in a main,
 * deleting a main whose instances keep their layers).
 *
 * `CopyView` presents a stored document (the editor's `Doc` uses it, and any
 * path that reads layers can); `compact` converts the materialized form
 * (every copy layer stored, `mirrors`-linked) to the stored form; `expand`
 * goes back.
 */
import { sameValue } from "./history";
import { ROOT_ID } from "./ids";
import type { NodeRecord } from "./ops";
import { keyBetween } from "./order-key";
import { getProp, isPropName, PROPS, type Props, propAllowed } from "./schema";
import { sha256 } from "./sha256";
import { MemoryStore } from "./store";

/** Never copied from a main's layer: they link copies, or describe the main itself. */
export const COPY_LINK_PROPS: ReadonlySet<string> = new Set([
  "isComponent",
  "componentDescription",
  "mirrors",
  "overrides",
  "unset",
  "path",
]);

/**
 * An instance root's own properties, never taken from its main: where it
 * sits in its parent, not what it looks like.
 */
export const ROOT_LOCAL_PROPS: ReadonlySet<string> = new Set([
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

/** The order key every override record has: records aren't layers, so their order means nothing. */
export const OVERRIDE_KEY = keyBetween(null, null);

// ---------------------------------------------------------------------------
// Ids

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 16 base-62 digits from SHA-256 of `text`: bytes under 248 map to digits without bias. */
function digest62(text: string): string {
  let out = "";
  for (const byte of sha256(text)) {
    if (byte >= 248) continue;
    out += ALPHABET.charAt(byte % 62);
    if (out.length === 16) return out;
  }
  // Fewer than 16 of 32 bytes under 248: about once in 10^19 hashes.
  return digest62(`${text}#`);
}

/** The id of the copy layer one step below `parentId` (an instance root or a copy layer). */
export function copyChildId(parentId: string, element: string): string {
  return digest62(`${parentId}/${element}`);
}

/** The id of the copy layer at `path` in the instance rooted at `rootId`. */
export function copyId(rootId: string, path: readonly string[]): string {
  let id = rootId;
  for (const element of path) id = copyChildId(id, element);
  return id;
}

// ---------------------------------------------------------------------------
// Presenting the stored form

/** What the view reads: the stored form, in a `MemoryStore`, the room's SQLite, or a snapshot. */
export interface StoredReader {
  get(id: string): NodeRecord | undefined;
  childIds(parent: string): readonly string[];
  nodes(): Iterable<NodeRecord>;
}

/** Where a copy layer sits: which instance, which path, which main layer it copies. */
export interface CopySlot {
  readonly id: string;
  /** The stored instance root it's part of. */
  readonly root: string;
  readonly path: readonly string[];
  /** The presented id of the main's layer it copies (its `mirrors`). */
  readonly source: string;
  readonly parent: string;
  readonly key: string;
}

interface Built {
  readonly main: string;
  readonly slots: string[];
  readonly kids: Map<string, readonly string[]>;
}

const EMPTY: readonly string[] = Object.freeze([]);

export function isMainNode(node: NodeRecord | undefined): node is NodeRecord {
  return node?.type === "frame" && getProp(node.props, "isComponent");
}

function isSetNode(node: NodeRecord | undefined): boolean {
  return node?.type === "frame" && getProp(node.props, "isComponentSet");
}

/** A record's (or root's) values over a base: what the copy is. */
function merge(props: Record<string, unknown>, own: Props, type: NodeRecord["type"]): void {
  for (const [prop, value] of Object.entries(own)) {
    if (prop === "path" || prop === "unset") continue;
    // A value that doesn't apply to the layer's type (after a swap, say) is kept, unused.
    if (!isPropName(prop) || !propAllowed(type, prop)) continue;
    props[prop] = value;
  }
  const unset = own.unset;
  if (unset) for (const prop of unset) delete props[prop];
}

/**
 * A stored document as the editor sees it: every copy layer built from its
 * main and its override record, on demand, and cached. Built copies are
 * dropped with `forget` when what they're built from changes.
 */
export class CopyView {
  readonly #store: StoredReader;
  readonly #slots = new Map<string, CopySlot>();
  readonly #built = new Map<string, Built>();
  readonly #nodes = new Map<string, NodeRecord>();
  /** Presented id → the presented ids built from it (copy layers, and instance roots of a main). */
  readonly #copiesOf = new Map<string, Set<string>>();
  /** Copy layers swapped to another main → that main (also a source of theirs). */
  readonly #swapped = new Map<string, string>();
  readonly #building = new Set<string>();
  readonly #presenting = new Set<string>();
  #complete = false;

  constructor(store: StoredReader) {
    this.#store = store;
  }

  /** The main a stored instance root follows, or undefined when it doesn't follow one. */
  mainOf(node: NodeRecord | undefined): NodeRecord | undefined {
    if (node?.type !== "frame") return undefined;
    const id = node.props.instanceOf;
    if (!id || id === node.id) return undefined;
    const main = this.#store.get(id);
    return isMainNode(main) ? main : undefined;
  }

  /** The slot of a copy layer, or undefined for anything stored. */
  slot(id: string): CopySlot | undefined {
    const slot = this.#slots.get(id);
    if (slot || this.#complete) return slot;
    if (this.#store.get(id) && this.#store.get(id)?.type !== "override") return undefined;
    this.buildAll();
    return this.#slots.get(id);
  }

  /** Built slots, without building anything (for the editor's notifications). */
  knownSlot(id: string): CopySlot | undefined {
    return this.#slots.get(id);
  }

  /** The override record a copy layer has, if any. */
  record(slot: CopySlot): NodeRecord | undefined {
    const record = this.#store.get(slot.id);
    return record?.type === "override" && record.parent === slot.root ? record : undefined;
  }

  get(id: string): NodeRecord | undefined {
    const cached = this.#nodes.get(id);
    if (cached) return cached;
    const stored = this.#store.get(id);
    if (stored && stored.type !== "override") {
      const main = this.mainOf(stored);
      if (!main) return stored;
      const node = this.#presentRoot(stored, main);
      this.#nodes.set(id, node);
      return node;
    }
    const slot = this.slot(id);
    if (!slot) return undefined;
    const node = this.#presentSlot(slot);
    if (node) this.#nodes.set(id, node);
    return node;
  }

  childIds(id: string): readonly string[] {
    const slot = this.#slots.get(id);
    if (slot) return this.#ensureBuilt(slot.root)?.kids.get(id) ?? EMPTY;
    const stored = this.#store.get(id);
    if (stored && stored.type !== "override") {
      if (this.mainOf(stored)) return this.#ensureBuilt(id)?.kids.get(id) ?? EMPTY;
      if (stored.type === "frame" && stored.props.instanceOf)
        // An instance whose main is gone shows what it stores, records aside.
        return this.#store.childIds(id).filter((c) => this.#store.get(c)?.type !== "override");
      return this.#store.childIds(id);
    }
    if (id !== ROOT_ID && this.slot(id)) return this.childIds(id);
    return this.#store.childIds(id);
  }

  /** What a copy layer (or an instance root) is before its own values: its main's, as copied. */
  base(id: string): { type: NodeRecord["type"]; props: Record<string, unknown> } | undefined {
    const slot = this.slot(id);
    if (slot) {
      const source = this.get(slot.source);
      if (!source) return undefined;
      return { type: source.type, props: this.#slotBase(slot, source) };
    }
    const stored = this.#store.get(id);
    const main = this.mainOf(stored);
    if (!stored || !main) return undefined;
    return { type: stored.type, props: this.#rootBase(main) };
  }

  /** What an instance of `mainId` is before its own values (for one about to be made). */
  rootBase(mainId: string): Record<string, unknown> | undefined {
    const main = this.#store.get(mainId);
    return isMainNode(main) ? this.#rootBase(main) : undefined;
  }

  /** Every node as presented: stored ones (instance roots built) and every copy layer. */
  *nodes(): IterableIterator<NodeRecord> {
    this.buildAll();
    for (const node of this.#store.nodes()) {
      if (node.type === "override") continue;
      yield this.get(node.id) as NodeRecord;
    }
    for (const id of [...this.#slots.keys()]) {
      const node = this.get(id);
      if (node) yield node;
    }
  }

  /** Copy layers built so far. */
  get slotCount(): number {
    return this.#slots.size;
  }

  /** Builds every instance, so every copy layer's id is known. */
  buildAll(): void {
    if (this.#complete) return;
    for (const node of this.#store.nodes()) if (this.mainOf(node)) this.#ensureBuilt(node.id);
    this.#complete = true;
  }

  /**
   * Drops what was built from changed data. `changed` names presented nodes
   * whose own values changed (a stored layer, an instance root, a record);
   * `structural` names presented nodes whose children may have changed (a
   * main's layer gained or lost one, a copy was swapped, an instance root
   * was made, unlinked or relinked). Copies of either, however nested, go too;
   * instances whose structure changed are built again at once. Returns the
   * presented ids and parents that changed, for change notifications.
   */
  forget(
    changed: Iterable<string>,
    structural: Iterable<string> = EMPTY,
  ): { ids: Set<string>; parents: Set<string> } {
    const ids = new Set<string>();
    const parents = new Set<string>();
    const queue = [...changed];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      if (ids.has(id)) continue;
      ids.add(id);
      this.#nodes.delete(id);
      const copies = this.#copiesOf.get(id);
      if (copies) for (const copy of copies) queue.push(copy);
    }
    const roots = new Set<string>();
    const seen = new Set<string>();
    const pending = [...structural];
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const slot = this.#slots.get(id);
      if (slot) roots.add(slot.root);
      else if (this.#built.has(id) || this.mainOf(this.#store.get(id))) roots.add(id);
      const copies = this.#copiesOf.get(id);
      if (copies) for (const copy of copies) pending.push(copy);
    }
    if (roots.size === 0) return { ids, parents };
    // Take every affected instance apart first, then build them again: one may be built from another.
    const reuse = new Map<string, Map<string, string>>();
    for (const root of roots) reuse.set(root, this.#unbuild(root, ids, parents));
    for (const root of roots) {
      ids.add(root);
      parents.add(root);
      this.#nodes.delete(root);
      const built = this.#ensureBuilt(root, reuse.get(root));
      if (!built) continue;
      for (const id of built.slots) ids.add(id);
      for (const parent of built.kids.keys()) parents.add(parent);
    }
    return { ids, parents };
  }

  /** Drops everything cached (after a rollback, say). */
  clear(): void {
    this.#slots.clear();
    this.#built.clear();
    this.#nodes.clear();
    this.#copiesOf.clear();
    this.#swapped.clear();
    this.#complete = false;
  }

  #unbuild(rootId: string, ids: Set<string>, parents: Set<string>): Map<string, string> {
    const reuse = new Map<string, string>();
    const old = this.#built.get(rootId);
    if (!old) return reuse;
    for (const id of old.slots) {
      const slot = this.#slots.get(id);
      if (!slot || slot.root !== rootId) continue;
      reuse.set(`${slot.parent}/${slot.path[slot.path.length - 1]}`, id);
      this.#slots.delete(id);
      this.#unlink(slot.source, id);
      const swapped = this.#swapped.get(id);
      if (swapped) {
        this.#unlink(swapped, id);
        this.#swapped.delete(id);
      }
      this.#nodes.delete(id);
      ids.add(id);
    }
    for (const parent of old.kids.keys()) parents.add(parent);
    this.#built.delete(rootId);
    this.#unlink(old.main, rootId);
    return reuse;
  }

  #link(source: string, id: string): void {
    const set = this.#copiesOf.get(source);
    if (set) set.add(id);
    else this.#copiesOf.set(source, new Set([id]));
  }

  #unlink(source: string, id: string): void {
    const set = this.#copiesOf.get(source);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.#copiesOf.delete(source);
  }

  #rootBase(main: NodeRecord): Record<string, unknown> {
    const source = this.#presenting.has(main.id) ? main : (this.get(main.id) ?? main);
    const props: Record<string, unknown> = {};
    for (const [prop, value] of Object.entries(source.props))
      if (!COPY_LINK_PROPS.has(prop) && !ROOT_LOCAL_PROPS.has(prop)) props[prop] = value;
    // An instance of a variant is named after its set ("Button"), like Figma.
    const set = this.#store.get(main.parent);
    if (isSetNode(set) && set) {
      const name = getProp(set.props, "name");
      if (name) props.name = name;
      else delete props.name;
    }
    return props;
  }

  #presentRoot(root: NodeRecord, main: NodeRecord): NodeRecord {
    if (this.#presenting.has(root.id)) return root;
    this.#presenting.add(root.id);
    try {
      const props = this.#rootBase(main);
      merge(props, root.props, root.type);
      this.#link(main.id, root.id);
      return { id: root.id, type: root.type, parent: root.parent, key: root.key, props };
    } finally {
      this.#presenting.delete(root.id);
    }
  }

  #presentSlot(slot: CopySlot): NodeRecord | undefined {
    const source = this.get(slot.source);
    if (!source) return undefined;
    const props = this.#slotBase(slot, source);
    const record = this.record(slot);
    if (record) merge(props, record.props, source.type);
    return { id: slot.id, type: source.type, parent: slot.parent, key: slot.key, props };
  }

  /** The main a copy layer's record swaps it to, when that's another live main. */
  #swappedMain(slot: CopySlot, source: NodeRecord): NodeRecord | undefined {
    if (source.type !== "frame") return undefined;
    const record = this.record(slot);
    const own = record ? swappedTo(record.props) : undefined;
    if (!own || own === getProp(source.props, "instanceOf")) return undefined;
    const main = this.#store.get(own);
    return isMainNode(main) ? main : undefined;
  }

  /**
   * A copy layer before its own values: its source's, as copied. A nested
   * instance swapped for another main is that main's instance, placed where
   * its source is: its root-local values from the source, the rest the
   * main's, as an instance root has them.
   */
  #slotBase(slot: CopySlot, source: NodeRecord): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    const swapped = this.#swappedMain(slot, source);
    if (swapped) {
      for (const prop of ROOT_LOCAL_PROPS) {
        const value = (source.props as Record<string, unknown>)[prop];
        if (value !== undefined && prop !== "instanceOf") props[prop] = value;
      }
      Object.assign(props, this.#rootBase(swapped));
    } else
      for (const [prop, value] of Object.entries(source.props))
        if (!COPY_LINK_PROPS.has(prop)) props[prop] = value;
    props.mirrors = source.id;
    return props;
  }

  #ensureBuilt(rootId: string, reuse?: Map<string, string>): Built | undefined {
    const done = this.#built.get(rootId);
    if (done) return done;
    const root = this.#store.get(rootId);
    const main = this.mainOf(root);
    // A main that (through its copies) contains this instance: built without layers.
    if (!main || this.#building.has(rootId)) return undefined;
    this.#building.add(rootId);
    try {
      const built: Built = { main: main.id, slots: [], kids: new Map() };
      const kids: string[] = [];
      for (const child of this.childIds(main.id))
        this.#addSlot(built, rootId, rootId, EMPTY, child, kids, reuse);
      built.kids.set(rootId, kids);
      this.#built.set(rootId, built);
      this.#link(main.id, rootId);
      return built;
    } finally {
      this.#building.delete(rootId);
    }
  }

  #addSlot(
    built: Built,
    root: string,
    parent: string,
    parentPath: readonly string[],
    sourceId: string,
    siblings: string[],
    reuse: Map<string, string> | undefined,
  ): void {
    const source = this.get(sourceId);
    if (!source) return;
    const element = sourceId;
    const id = reuse?.get(`${parent}/${element}`) ?? copyChildId(parent, element);
    // Two paths with one id (about 95 bits: never in practice) or an id a stored layer has: refused.
    const stored = this.#store.get(id);
    if (this.#slots.has(id) || (stored && stored.type !== "override")) return;
    const path = [...parentPath, element];
    const slot: CopySlot = { id, root, path, source: sourceId, parent, key: source.key };
    this.#slots.set(id, slot);
    built.slots.push(id);
    siblings.push(id);
    this.#link(sourceId, id);
    // Its layers are its source's, or a swapped-in main's (which it then copies too).
    const swapped = this.#swappedMain(slot, source)?.id;
    if (swapped) {
      this.#swapped.set(id, swapped);
      this.#link(swapped, id);
    }
    const from = swapped ?? sourceId;
    const kids: string[] = [];
    for (const child of this.childIds(from))
      this.#addSlot(built, root, id, path, child, kids, reuse);
    built.kids.set(id, kids);
  }
}

/** The main a record swaps its copy to: a value, null when it unsets it, undefined when it doesn't say. */
function swappedTo(props: Props): string | null | undefined {
  if (props.instanceOf !== undefined) return props.instanceOf;
  return props.unset?.includes("instanceOf") ? null : undefined;
}

// ---------------------------------------------------------------------------
// Values: what a copy keeps of its own

function defaultValue(prop: string): unknown {
  return isPropName(prop) ? PROPS[prop].default : undefined;
}

/** Equal as properties: a missing value equals its default. */
export function samePropValue(prop: string, a: unknown, b: unknown): boolean {
  if (a === undefined) return b === undefined || sameValue(b, defaultValue(prop));
  if (b === undefined) return sameValue(a, defaultValue(prop));
  return sameValue(a, b);
}

/**
 * What a copy layer (or instance root) stores over `base` to be `own`: every
 * value that differs, every overridden value (so it stays put when the main
 * changes), and `unset` for values it lacks that the base has. Null when it
 * stores nothing. `keepMirrors` is for instance roots, whose `mirrors` is
 * their own.
 */
export function ownValues(
  base: Readonly<Record<string, unknown>>,
  own: Readonly<Record<string, unknown>>,
  keepMirrors = false,
): Record<string, unknown> | null {
  const overridden = new Set((own.overrides as readonly string[] | undefined) ?? []);
  const out: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const prop of new Set([...Object.keys(base), ...Object.keys(own)])) {
    if (prop === "path" || prop === "unset" || (prop === "mirrors" && !keepMirrors)) continue;
    const want = own[prop];
    if (prop === "overrides") {
      if (Array.isArray(want) && want.length > 0) out.overrides = want;
      continue;
    }
    const pinned = overridden.has(prop);
    // Exactly the same: a value set to its default is kept as set (the editor compares values).
    if (!pinned && (want === undefined ? base[prop] === undefined : sameValue(want, base[prop])))
      continue;
    if (want === undefined) {
      // A pinned absence still has to be said, or the main's value would show through later.
      if (base[prop] !== undefined || pinned) unset.push(prop);
      continue;
    }
    out[prop] = want;
  }
  if (unset.length > 0) out.unset = unset.sort();
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Converting

export interface CompactResult {
  /** The stored form. */
  readonly nodes: NodeRecord[];
  /** Each copy layer's id in the input → its derived id. Ids not listed stay as they were. */
  readonly ids: ReadonlyMap<string, string>;
  /**
   * Instances whose layers don't match their main's (other layers, another
   * order), detached as `pinInstances` would: they keep every layer, unlinked.
   */
  readonly detached: readonly string[];
}

interface Indexed {
  readonly byId: Map<string, NodeRecord>;
  readonly children: Map<string, NodeRecord[]>;
}

function index(nodes: readonly NodeRecord[]): Indexed {
  const byId = new Map<string, NodeRecord>();
  const children = new Map<string, NodeRecord[]>();
  for (const node of nodes) {
    byId.set(node.id, node);
    const list = children.get(node.parent);
    if (list) list.push(node);
    else children.set(node.parent, [node]);
  }
  return { byId, children };
}

function unlinked(node: NodeRecord): NodeRecord {
  const props: Record<string, unknown> = { ...node.props };
  delete props.instanceOf;
  delete props.mirrors;
  delete props.overrides;
  delete props.unset;
  return { ...node, props: props as Props };
}

/**
 * The stored form of a document in the materialized form: copy layers equal
 * to what they'd be built as are dropped, the rest become override records
 * with derived ids. The input is taken as materialized, except an instance
 * that has override records and no layers, which is kept as it is.
 */
export function compact(input: readonly NodeRecord[]): CompactResult {
  const d = index(input);
  const isLive = (node: NodeRecord | undefined): node is NodeRecord =>
    node?.type === "frame" &&
    !!node.props.instanceOf &&
    node.props.instanceOf !== node.id &&
    isMainNode(d.byId.get(node.props.instanceOf));

  // Instance roots not inside another instance, and the copy layers inside them.
  const roots: NodeRecord[] = [];
  const inside = new Set<string>();
  const rootsInMain = new Map<string, string[]>();
  const walk = (parent: string, mains: readonly string[], inCopy: boolean) => {
    for (const node of d.children.get(parent) ?? []) {
      if (node.type === "override") continue;
      if (inCopy) {
        inside.add(node.id);
        walk(node.id, mains, true);
        continue;
      }
      const live = isLive(node);
      if (live) {
        roots.push(node);
        for (const main of mains) {
          const list = rootsInMain.get(main);
          if (list) list.push(node.id);
          else rootsInMain.set(main, [node.id]);
        }
      }
      walk(node.id, isMainNode(node) ? [...mains, node.id] : mains, live);
    }
  };
  walk(ROOT_ID, [], false);

  const store = new MemoryStore(input.filter((node) => !inside.has(node.id)));
  const view = new CopyView(store);
  const ids = new Map<string, string>();
  const detached: string[] = [];
  const state = new Map<string, "doing" | "done">();
  const ready = new Set<string>();

  const prepare = (mainId: string) => {
    if (ready.has(mainId)) return;
    ready.add(mainId);
    const main = d.byId.get(mainId);
    if (main && isLive(main)) process(main);
    for (const id of rootsInMain.get(mainId) ?? []) process(d.byId.get(id) as NodeRecord);
  };

  const setProps = (id: string, props: Readonly<Record<string, unknown>>) =>
    store.replaceProps(id, props as Props);

  const subtree = (id: string): NodeRecord[] => {
    const out: NodeRecord[] = [];
    const stack = [...(d.children.get(id) ?? [])];
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (node.type === "override") continue;
      out.push(node);
      stack.push(...(d.children.get(node.id) ?? []));
    }
    return out;
  };

  function process(root: NodeRecord): void {
    const at = state.get(root.id);
    if (at === "done") return;
    if (at === "doing") return; // A main that contains its own instance: left as it is.
    state.set(root.id, "doing");
    const mainId = root.props.instanceOf as string;
    prepare(mainId);
    const layers = subtree(root.id);
    for (const node of layers) {
      const of = node.type === "frame" ? node.props.instanceOf : undefined;
      if (of && of !== mainId && isMainNode(d.byId.get(of))) prepare(of);
    }
    const written: string[] = [];
    const originalProps = root.props;
    /** Another structure than its main's (`why` says how, for a debugger). */
    const fail = (_why: string) => false;
    const ok = (() => {
      // Records and no layers: already stored compact.
      if (layers.length === 0 && (d.children.get(root.id) ?? []).length > 0) return true;
      const base = view.base(root.id);
      if (!base) return false;
      setProps(root.id, ownValues(base.props, root.props, true) ?? {});
      view.forget([root.id], [root.id]);
      const match = (dParent: string, presented: string): boolean => {
        const dKids = (d.children.get(dParent) ?? []).filter((n) => n.type !== "override");
        const kids = view.childIds(presented);
        if (dKids.length !== kids.length)
          return fail(`${dKids.length} layers under ${dParent}, ${kids.length} built`);
        const bySource = new Map<string, string>();
        for (const id of kids) bySource.set((view.slot(id) as CopySlot).source, id);
        for (const node of dKids) {
          const mirrors = node.props.mirrors;
          if (!mirrors) return fail(`${node.id} copies nothing`);
          const slotId = bySource.get(ids.get(mirrors) ?? mirrors);
          if (!slotId) return fail(`no copy of ${mirrors} under ${presented}`);
          bySource.delete(ids.get(mirrors) ?? mirrors);
          const slot = view.slot(slotId) as CopySlot;
          const base = view.base(slotId);
          if (!base || base.type !== node.type || slot.key !== node.key)
            return fail(`${node.id} isn't its main layer's type or place`);
          ids.set(node.id, slotId);
          const write = (own: Record<string, unknown> | null, structural: boolean) => {
            if (store.get(slotId)) store.remove(slotId);
            if (own)
              store.insert({
                id: slotId,
                type: "override",
                parent: root.id,
                key: OVERRIDE_KEY,
                props: { path: [...slot.path], ...own } as Props,
              });
            view.forget([slotId], structural ? [slotId] : EMPTY);
          };
          const own = ownValues(base.props, node.props);
          if (own) {
            written.push(slotId);
            const swaps = node.type === "frame" && swappedTo(own as Props) !== undefined;
            write(own, swaps);
            // Swapped: its base is the other main's now, so what it keeps is what differs from that.
            if (swaps) write(ownValues((view.base(slotId) ?? base).props, node.props), true);
          }
          if (!match(node.id, slotId)) return false;
        }
        return true;
      };
      return match(root.id, root.id);
    })();
    if (!ok) {
      // Another structure than its main's: detached, every layer kept.
      for (const id of written) store.remove(id);
      for (const node of layers) ids.delete(node.id);
      setProps(root.id, unlinked({ ...root, props: originalProps }).props);
      for (const node of layers) store.insert(unlinked(node));
      view.clear();
      detached.push(root.id);
    }
    state.set(root.id, "done");
  }

  for (const root of roots) process(root);
  return { nodes: [...store.nodes()], ids, detached };
}

/** The materialized form of a stored document: every copy layer built. */
export function expand(nodes: Iterable<NodeRecord>): NodeRecord[] {
  return [...new CopyView(new MemoryStore(nodes)).nodes()];
}

/** `nodes` with ids (their own, parents' and `mirrors`) renamed by `ids`. */
export function renameIds(
  nodes: Iterable<NodeRecord>,
  ids: ReadonlyMap<string, string>,
): NodeRecord[] {
  const out: NodeRecord[] = [];
  for (const node of nodes) {
    const mirrors = node.props.mirrors;
    out.push({
      ...node,
      id: ids.get(node.id) ?? node.id,
      parent: ids.get(node.parent) ?? node.parent,
      props:
        mirrors && ids.has(mirrors)
          ? { ...node.props, mirrors: ids.get(mirrors) as string }
          : node.props,
    });
  }
  return out;
}

/**
 * The first way two documents differ, as a sentence naming the node and the
 * property, or null when they're the same (a missing property equals its
 * default). For the equivalence tests and the fuzzer.
 */
export function firstDifference(
  expected: Iterable<NodeRecord>,
  actual: Iterable<NodeRecord>,
): string | null {
  const want = new Map<string, NodeRecord>();
  for (const node of expected) want.set(node.id, node);
  const have = new Map<string, NodeRecord>();
  for (const node of actual) have.set(node.id, node);
  const describe = (node: NodeRecord) =>
    `${node.type} ${node.id}${node.props.name ? ` "${node.props.name}"` : ""}`;
  for (const [id, a] of want) {
    const b = have.get(id);
    if (!b) return `missing ${describe(a)} (under ${a.parent})`;
    if (a.type !== b.type) return `${describe(a)}: type ${b.type}, expected ${a.type}`;
    if (a.parent !== b.parent) return `${describe(a)}: parent ${b.parent}, expected ${a.parent}`;
    if (a.key !== b.key) return `${describe(a)}: key ${b.key}, expected ${a.key}`;
    const ap = a.props as Record<string, unknown>;
    const bp = b.props as Record<string, unknown>;
    for (const prop of new Set([...Object.keys(ap), ...Object.keys(bp)]))
      if (!samePropValue(prop, ap[prop], bp[prop]))
        return `${describe(a)}: ${prop} is ${JSON.stringify(bp[prop])}, expected ${JSON.stringify(ap[prop])}`;
  }
  for (const [id, b] of have)
    if (!want.has(id)) return `unexpected ${describe(b)} (under ${b.parent})`;
  return null;
}
