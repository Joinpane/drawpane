import {
  type ApplyOptions,
  applyTransaction,
  type CopySlot,
  collectSubtree,
  compact,
  MemoryStore,
  type NodeRecord,
  type Op,
  ROOT_ID,
} from "@drawpane/model";
import { CompactCopies } from "./compact-copies";

export interface DocChange {
  /** Nodes whose record changed, appeared or disappeared. */
  readonly ids: ReadonlySet<string>;
  /** Parents whose child list changed. */
  readonly parents: ReadonlySet<string>;
  /** True when a whole new snapshot replaced the document. */
  readonly reset: boolean;
}

type Listener = (change: DocChange) => void;

/** How many recent changes `changesSince` can replay, and how many ids they may hold in all. */
const LOG_CHANGES = 256;
const LOG_IDS = 2_000_000;

export interface DocOptions {
  /**
   * Keep copies compact (decision 0029): store instance roots and override
   * records, and present every copy layer as an ordinary node. Off unless
   * asked for, or `setCompactCopiesDefault(true)` was called.
   */
  readonly compactCopies?: boolean;
}

let compactByDefault = false;

/** Whether new documents keep copies compact (decision 0029's flag; off by default). */
export function setCompactCopiesDefault(on: boolean): void {
  compactByDefault = on;
}

export function compactCopiesDefault(): boolean {
  return compactByDefault;
}

/**
 * The editor's local copy of a file: a `MemoryStore` plus change
 * notifications. Every mutation goes through `apply` or `reset`, so views can
 * subscribe and re-render only what changed.
 *
 * With compact copies on, the store holds the stored form and every read
 * presents copy layers as ordinary nodes; `apply` takes and returns
 * operations on presented nodes (see compact-copies.ts).
 */
export class Doc {
  readonly compactCopies: boolean;
  #store = new MemoryStore();
  #compact: CompactCopies | null;
  readonly #listeners = new Set<Listener>();
  #version = 0;
  /** Changes collected while a batch is open; flushed as one notification. */
  #pending: { ids: Set<string>; parents: Set<string>; reset: boolean } | null = null;
  #batchDepth = 0;
  /** Recent changes, oldest first, each with the version it made (see `changesSince`). */
  readonly #log: Array<{ version: number; change: DocChange }> = [];
  #logIds = 0;

  #lastStored: readonly Op[] = [];
  #resetIds: ReadonlyMap<string, string> = new Map();

  constructor(options: DocOptions = {}) {
    this.compactCopies = options.compactCopies ?? compactByDefault;
    this.#compact = this.compactCopies ? new CompactCopies() : null;
  }

  get version(): number {
    return this.#version;
  }

  get size(): number {
    return this.#compact ? this.#compact.size : this.#store.size;
  }

  get(id: string): NodeRecord | undefined {
    return this.#compact ? this.#compact.view.get(id) : this.#store.get(id);
  }

  has(id: string): boolean {
    return this.#compact ? this.#compact.view.get(id) !== undefined : this.#store.has(id);
  }

  childIds(parent: string): readonly string[] {
    return this.#compact ? this.#compact.view.childIds(parent) : this.#store.childIds(parent);
  }

  pageIds(): readonly string[] {
    const store = this.#compact?.store ?? this.#store;
    return store.childIds(ROOT_ID).filter((id) => store.get(id)?.type === "page");
  }

  nodes(): IterableIterator<NodeRecord> {
    return this.#compact ? this.#compact.view.nodes() : this.#store.nodes();
  }

  /** Ancestors of `id`, nearest first, excluding the root. */
  ancestors(id: string): NodeRecord[] {
    const out: NodeRecord[] = [];
    let node = this.get(id);
    while (node && node.parent !== ROOT_ID) {
      const parent = this.get(node.parent);
      if (!parent) break;
      out.push(parent);
      node = parent;
    }
    return out;
  }

  /** Variable collections, in order. */
  collectionIds(): readonly string[] {
    const store = this.#compact?.store ?? this.#store;
    return store.childIds(ROOT_ID).filter((id) => store.get(id)?.type === "collection");
  }

  /** The page a node lives on. */
  pageOf(id: string): NodeRecord | undefined {
    let node = this.get(id);
    while (node && node.type !== "page") node = this.get(node.parent);
    return node;
  }

  // -------------------------------------------------------------------------
  // Compact copies (decision 0029). Each is empty, or the obvious answer, when they're off.

  /** Where a copy layer sits (its instance root, path and main layer), when copies are compact. */
  copySlot(id: string): CopySlot | undefined {
    return this.#compact?.view.slot(id);
  }

  /** The stored instance roots of a main (compact copies only). */
  instanceRoots(mainId: string): readonly string[] {
    return this.#compact?.instanceRoots(mainId) ?? [];
  }

  /** Whether an instance stores a value a layout reads, so its layout can differ from its main's. */
  layoutDiffers(rootId: string): boolean {
    return this.#compact?.layoutDiffers(rootId) ?? false;
  }

  /** The stored form: what a room would store. Materialized when copies aren't compact. */
  stored(): NodeRecord[] {
    return [...(this.#compact?.store ?? this.#store).nodes()];
  }

  /** How the latest `reset` renamed copy layers (materialized id → derived id); empty when it didn't. */
  get resetIds(): ReadonlyMap<string, string> {
    return this.#resetIds;
  }

  /** The operations as stored by the latest `apply`. */
  get lastStoredOps(): readonly Op[] {
    return this.#lastStored;
  }

  /**
   * Applies operations all-or-nothing and returns their inverse. `held`:
   * they put back what the document held (a rebase, a change the room
   * already accepted), so nothing is refused for depth.
   */
  apply(ops: readonly Op[], options: ApplyOptions = {}): Op[] {
    if (this.#compact) {
      const applied = this.#compact.apply(ops, options);
      this.#lastStored = applied.stored;
      this.#record(new Set(applied.ids), new Set(applied.parents), false);
      return applied.inverse;
    }
    const touched = this.#touched(ops);
    const inverse = applyTransaction(this.#store, ops, { held: options.held ?? false });
    this.#lastStored = ops;
    this.#record(touched.ids, touched.parents, false);
    return inverse;
  }

  /** Applies operations on the stored form as they are (compact copies; the same as `apply` otherwise). */
  applyStored(ops: readonly Op[], options: ApplyOptions = {}): Op[] {
    if (!this.#compact) return this.apply(ops, options);
    const applied = this.#compact.applyStored(ops, options);
    this.#lastStored = applied.stored;
    this.#record(new Set(applied.ids), new Set(applied.parents), false);
    return applied.inverse;
  }

  /** Replaces the whole document, e.g. from a snapshot (in the materialized form). */
  reset(nodes: Iterable<NodeRecord>): void {
    if (this.compactCopies) {
      const converted = compact([...nodes]);
      this.#compact = new CompactCopies(converted.nodes);
      this.#resetIds = converted.ids;
    } else {
      this.#store = new MemoryStore(nodes);
      this.#resetIds = new Map();
    }
    this.#record(new Set(), new Set(), true);
  }

  /** Replaces the whole document with one already in the stored form (compact copies). */
  resetStored(nodes: Iterable<NodeRecord>): void {
    if (this.compactCopies) this.#compact = new CompactCopies(nodes);
    else this.#store = new MemoryStore(nodes);
    this.#record(new Set(), new Set(), true);
  }

  /** Groups several `apply` calls into one change notification. */
  batch<T>(fn: () => T): T {
    this.#batchDepth++;
    try {
      return fn();
    } finally {
      this.#batchDepth--;
      if (this.#batchDepth === 0) this.#flush();
    }
  }

  /**
   * The changes that brought the document from `version` to now, oldest
   * first, for views that catch up when they next look instead of
   * listening (the scene's caches). Null when they're no longer kept: start
   * afresh then.
   */
  changesSince(version: number): readonly DocChange[] | null {
    if (version === this.#version) return [];
    if (version > this.#version) return null;
    const first = this.#log[0];
    if (!first || first.version > version + 1) return null;
    const out: DocChange[] = [];
    for (const entry of this.#log) if (entry.version > version) out.push(entry.change);
    return out;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #touched(ops: readonly Op[]): { ids: Set<string>; parents: Set<string> } {
    const ids = new Set<string>();
    const parents = new Set<string>();
    for (const op of ops) {
      ids.add(op.id);
      switch (op.op) {
        case "create":
          parents.add(op.parent);
          break;
        case "delete": {
          const node = this.#store.get(op.id);
          if (node) parents.add(node.parent);
          for (const n of collectSubtree(this.#store, op.id)) ids.add(n.id);
          break;
        }
        case "move": {
          const node = this.#store.get(op.id);
          if (node) parents.add(node.parent);
          parents.add(op.parent);
          break;
        }
        case "set":
          break;
      }
    }
    return { ids, parents };
  }

  #record(ids: Set<string>, parents: Set<string>, reset: boolean): void {
    if (!this.#pending) this.#pending = { ids: new Set(), parents: new Set(), reset: false };
    for (const id of ids) this.#pending.ids.add(id);
    for (const id of parents) this.#pending.parents.add(id);
    this.#pending.reset ||= reset;
    if (this.#batchDepth === 0) this.#flush();
  }

  #flush(): void {
    const change = this.#pending;
    if (!change) return;
    this.#pending = null;
    this.#version++;
    this.#log.push({ version: this.#version, change });
    this.#logIds += change.ids.size + change.parents.size;
    while (this.#log.length > LOG_CHANGES || (this.#log.length > 1 && this.#logIds > LOG_IDS)) {
      const dropped = this.#log.shift();
      if (dropped) this.#logIds -= dropped.change.ids.size + dropped.change.parents.size;
    }
    for (const listener of this.#listeners) listener(change);
  }
}
