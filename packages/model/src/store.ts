import { ROOT_ID } from "./ids";
import type { NodeRecord } from "./ops";
import { compareSiblings } from "./order-key";
import type { PropName } from "./schema";

/**
 * Where nodes live. The editor keeps them in memory (`MemoryStore`); the
 * FileRoom keeps them in SQLite, one row per node. `applyOp` works against
 * either, synchronously.
 */
export interface NodeStore {
  get(id: string): NodeRecord | undefined;
  /** Child ids of `parent`, in sibling order. */
  childIds(parent: string): readonly string[];
  insert(node: NodeRecord): void;
  /** Sets a property, or removes it when `value` is undefined. */
  setProp(id: string, prop: PropName, value: unknown): void;
  move(id: string, parent: string, key: string): void;
  /** Removes one node. Callers remove descendants first. */
  remove(id: string): void;
}

/**
 * In-memory store with an ordered child index, kept sorted on every change so
 * reads never sort.
 */
export class MemoryStore implements NodeStore {
  readonly #nodes = new Map<string, NodeRecord>();
  readonly #children = new Map<string, string[]>();

  constructor(nodes: Iterable<NodeRecord> = []) {
    for (const node of nodes) this.#nodes.set(node.id, node);
    for (const node of this.#nodes.values()) this.#list(node.parent).push(node.id);
    for (const ids of this.#children.values()) ids.sort(this.#compareIds);
  }

  get size(): number {
    return this.#nodes.size;
  }

  get(id: string): NodeRecord | undefined {
    return this.#nodes.get(id);
  }

  has(id: string): boolean {
    return this.#nodes.has(id);
  }

  childIds(parent: string): readonly string[] {
    return this.#children.get(parent) ?? EMPTY;
  }

  pageIds(): readonly string[] {
    return this.childIds(ROOT_ID).filter((id) => this.get(id)?.type === "page");
  }

  nodes(): IterableIterator<NodeRecord> {
    return this.#nodes.values();
  }

  insert(node: NodeRecord): void {
    this.#nodes.set(node.id, node);
    this.#insertChild(node.parent, node);
  }

  setProp(id: string, prop: PropName, value: unknown): void {
    const node = this.#require(id);
    const props: Record<string, unknown> = { ...node.props };
    if (value === undefined) delete props[prop];
    else props[prop] = value;
    this.#nodes.set(id, { ...node, props });
  }

  move(id: string, parent: string, key: string): void {
    const node = this.#require(id);
    this.#removeChild(node.parent, id);
    const moved = { ...node, parent, key };
    this.#nodes.set(id, moved);
    this.#insertChild(parent, moved);
  }

  remove(id: string): void {
    const node = this.#nodes.get(id);
    if (!node) return;
    this.#removeChild(node.parent, id);
    this.#nodes.delete(id);
    this.#children.delete(id);
  }

  #require(id: string): NodeRecord {
    const node = this.#nodes.get(id);
    if (!node) throw new Error(`no node ${id}`);
    return node;
  }

  #list(parent: string): string[] {
    let list = this.#children.get(parent);
    if (!list) {
      list = [];
      this.#children.set(parent, list);
    }
    return list;
  }

  #compareIds = (a: string, b: string): number =>
    compareSiblings(this.#require(a), this.#require(b));

  #insertChild(parent: string, node: NodeRecord): void {
    const list = this.#list(parent);
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareSiblings(this.#require(list[mid] as string), node) < 0) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, node.id);
  }

  #removeChild(parent: string, id: string): void {
    const list = this.#children.get(parent);
    if (!list) return;
    const index = list.indexOf(id);
    if (index !== -1) list.splice(index, 1);
    if (list.length === 0) this.#children.delete(parent);
  }
}

const EMPTY: readonly string[] = Object.freeze([]);
