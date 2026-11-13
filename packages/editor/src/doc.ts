import {
  applyTransaction,
  collectSubtree,
  MemoryStore,
  type NodeRecord,
  type Op,
  ROOT_ID,
} from "@drawpane/model";

export interface DocChange {
  /** Nodes whose record changed, appeared or disappeared. */
  readonly ids: ReadonlySet<string>;
  /** Parents whose child list changed. */
  readonly parents: ReadonlySet<string>;
  /** True when a whole new snapshot replaced the document. */
  readonly reset: boolean;
}

type Listener = (change: DocChange) => void;

/**
 * The editor's local copy of a file: a `MemoryStore` plus change
 * notifications. Every mutation goes through `apply` or `reset`, so views can
 * subscribe and re-render only what changed.
 */
export class Doc {
  #store = new MemoryStore();
  readonly #listeners = new Set<Listener>();
  #version = 0;
  /** Changes collected while a batch is open; flushed as one notification. */
  #pending: { ids: Set<string>; parents: Set<string>; reset: boolean } | null = null;
  #batchDepth = 0;

  get version(): number {
    return this.#version;
  }

  get size(): number {
    return this.#store.size;
  }

  get(id: string): NodeRecord | undefined {
    return this.#store.get(id);
  }

  has(id: string): boolean {
    return this.#store.has(id);
  }

  childIds(parent: string): readonly string[] {
    return this.#store.childIds(parent);
  }

  pageIds(): readonly string[] {
    return this.#store.childIds(ROOT_ID).filter((id) => this.#store.get(id)?.type === "page");
  }

  nodes(): IterableIterator<NodeRecord> {
    return this.#store.nodes();
  }

  /** Ancestors of `id`, nearest first, excluding the root. */
  ancestors(id: string): NodeRecord[] {
    const out: NodeRecord[] = [];
    let node = this.#store.get(id);
    while (node && node.parent !== ROOT_ID) {
      const parent = this.#store.get(node.parent);
      if (!parent) break;
      out.push(parent);
      node = parent;
    }
    return out;
  }

  /** Variable collections, in order. */
  collectionIds(): readonly string[] {
    return this.#store.childIds(ROOT_ID).filter((id) => this.#store.get(id)?.type === "collection");
  }

  /** The page a node lives on. */
  pageOf(id: string): NodeRecord | undefined {
    let node = this.#store.get(id);
    while (node && node.type !== "page") node = this.#store.get(node.parent);
    return node;
  }

  /** Applies operations all-or-nothing and returns their inverse. */
  apply(ops: readonly Op[]): Op[] {
    const touched = this.#touched(ops);
    const inverse = applyTransaction(this.#store, ops);
    this.#record(touched.ids, touched.parents, false);
    return inverse;
  }

  /** Replaces the whole document, e.g. from a snapshot. */
  reset(nodes: Iterable<NodeRecord>): void {
    this.#store = new MemoryStore(nodes);
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
    for (const listener of this.#listeners) listener(change);
  }
}
