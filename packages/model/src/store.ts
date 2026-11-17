import { type BuildBudget, propBytes, storedBytes } from "./budget";
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
  /**
   * Removes a node and everything under it, without reading them: for a
   * store that can (SQLite), used when nobody needs what was deleted back.
   */
  removeTree?(id: string): void;
  /**
   * Whether anything lies more than `levels` levels below `id` (a child is
   * one level below), for a store that can tell without reading every node
   * (SQLite). See `deeperThan`.
   */
  deeperThan?(id: string, levels: number): boolean;
  /**
   * Whether a main contains an instance of itself through `id` (see
   * `instanceCycleAt`), for a store that can tell without reading values
   * (SQLite): what's checked can be a main of any size.
   */
  instanceCycle?(id: string, deep: boolean): boolean;
  /**
   * How many pages the file has, counting no further than `atMost`, for a
   * store that can tell without reading every page's id (SQLite: a file may
   * hold a million pages).
   */
  pagesUpTo?(atMost: number): number;
}

/**
 * Whether anything lies more than `levels` levels below `id`: a level at a
 * time, reading no further than `levels + 1` levels down.
 */
export function deeperThan(store: NodeStore, id: string, levels: number): boolean {
  if (store.deeperThan) return store.deeperThan(id, levels);
  let level: readonly string[] = [id];
  for (let depth = 0; level.length > 0; depth++) {
    if (depth > levels) return true;
    const next: string[] = [];
    for (const parent of level) for (const child of store.childIds(parent)) next.push(child);
    level = next;
  }
  return false;
}

export interface MemoryStoreOptions {
  /**
   * Counts what the store keeps (`storedBytes` a node) in this budget, as
   * it's kept: building the store refuses (`BuildTooLarge`) the node that
   * would take it past the limit, before keeping it; a change made to it
   * is counted whole (`BuildBudget.hold`), for its holder to check `over`.
   */
  readonly meter?: BuildBudget | null;
}

/**
 * In-memory store with an ordered child index, kept sorted on every change so
 * reads never sort.
 */
export class MemoryStore implements NodeStore {
  readonly #nodes = new Map<string, NodeRecord>();
  readonly #children = new Map<string, string[]>();
  readonly #meter: BuildBudget | null;

  constructor(nodes: Iterable<NodeRecord> = [], { meter = null }: MemoryStoreOptions = {}) {
    this.#meter = meter;
    if (meter)
      for (const node of nodes) {
        meter.charge(storedBytes(node));
        this.#nodes.set(node.id, node);
      }
    else for (const node of nodes) this.#nodes.set(node.id, node);
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
    const before = this.#nodes.get(node.id);
    if (this.#meter) {
      if (before) this.#meter.release(storedBytes(before));
      this.#meter.hold(storedBytes(node));
    }
    this.#nodes.set(node.id, node);
    this.#insertChild(node.parent, node);
  }

  setProp(id: string, prop: PropName, value: unknown): void {
    const node = this.#require(id);
    const props: Record<string, unknown> = { ...node.props };
    this.#count(propBytes(props[prop], value));
    if (value === undefined) delete props[prop];
    else props[prop] = value;
    this.#nodes.set(id, { ...node, props });
  }

  /** Replaces a node's properties at once (its place unchanged): for building a store, not for edits. */
  replaceProps(id: string, props: NodeRecord["props"]): void {
    const node = this.#require(id);
    const next = { ...node, props };
    if (this.#meter) this.#count(storedBytes(next) - storedBytes(node));
    this.#nodes.set(id, next);
  }

  move(id: string, parent: string, key: string): void {
    const node = this.#require(id);
    this.#removeChild(node.parent, id);
    const moved = { ...node, parent, key };
    this.#count(parent.length + key.length - node.parent.length - node.key.length);
    this.#nodes.set(id, moved);
    this.#insertChild(parent, moved);
  }

  remove(id: string): void {
    const node = this.#nodes.get(id);
    if (!node) return;
    this.#meter?.release(storedBytes(node));
    this.#removeChild(node.parent, id);
    this.#nodes.delete(id);
    this.#children.delete(id);
  }

  /** Counts a change in what's kept: held when it grows, given back when it shrinks. */
  #count(bytes: number): void {
    if (!this.#meter) return;
    if (bytes > 0) this.#meter.hold(bytes);
    else if (bytes < 0) this.#meter.release(-bytes);
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
