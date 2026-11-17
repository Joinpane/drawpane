import {
  type BuildBudget,
  ENTRY_BYTES,
  type NodeRecord,
  type NodeStore,
  type NodeType,
  nodeBytes,
  type PropName,
  type Props,
  ROOT_ID,
} from "@drawpane/model";
import { checkIds, idsRoom } from "./convert";
import { instanceCycleIn } from "./instance-cycles";
import { tablePages } from "./node-tables";

interface NodeRow extends Record<string, SqlStorageValue> {
  id: string;
  parent: string;
  key: string;
  type: string;
  props: string;
}

export const NODE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    parent TEXT NOT NULL,
    key TEXT NOT NULL,
    type TEXT NOT NULL,
    props TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS nodes_children ON nodes (parent, key, id);
`;

function toRecord(row: NodeRow): NodeRecord {
  return {
    id: row.id,
    parent: row.parent,
    key: row.key,
    type: row.type as NodeType,
    props: JSON.parse(row.props) as Props,
  };
}

/**
 * What the read cache keeps at most, in estimated heap bytes: about two
 * bytes a character of a row's JSON (V8 holds text past Latin-1 two bytes
 * a character), plus a slot. A transaction reads every node it touches, and
 * a text layer may hold 200,000 characters: a drag of 400 of them would
 * otherwise keep 400 such rows until the chunk applied.
 */
export const STORE_CACHE_BYTES = 8 << 20;

/** What a cached node is counted as: its JSON, two bytes a character, and a slot. */
function weightOf(chars: number): number {
  return ENTRY_BYTES + 2 * chars;
}

interface Cached {
  readonly node: NodeRecord | null;
  /** Counted against STORE_CACHE_BYTES. */
  readonly weight: number;
  /** Charged to the meter's budget when it was read (0 when not metered). */
  readonly charged: number;
}

/**
 * The FileRoom's node store: one SQLite row per node. A transaction touches
 * only the rows it changes, so memory and write cost track the size of an
 * edit, not the size of the file.
 *
 * A small read cache avoids re-parsing a node's JSON several times while one
 * transaction validates and applies it. Writes go straight to SQLite and keep
 * the cache in step, so letting a node go is always safe: it's read again
 * when next asked for. The cache keeps at most STORE_CACHE_BYTES, letting the
 * least recently used go first. Call `clearCache()` after a transaction
 * rolls back.
 */
export class SqlNodeStore implements NodeStore {
  readonly #sql: SqlStorage;
  readonly #cache = new Map<string, Cached>();
  readonly #maxBytes: number;
  /** What the cache holds, counted as `Cached.weight`. */
  #bytes = 0;
  #budget: BuildBudget | null = null;

  constructor(sql: SqlStorage, maxBytes = STORE_CACHE_BYTES) {
    this.#sql = sql;
    this.#maxBytes = maxBytes;
  }

  clearCache(): void {
    let charged = 0;
    for (const entry of this.#cache.values()) charged += entry.charged;
    this.#cache.clear();
    this.#bytes = 0;
    if (charged > 0) this.#budget?.release(charged);
  }

  /**
   * Charges every row parsed into the cache to `budget` (null: none), until
   * it's let go of: for reads that build copies from it (main-removal.ts),
   * so what it keeps counts against what they may hold. Empties the cache.
   */
  meter(budget: BuildBudget | null): void {
    this.clearCache();
    this.#budget = budget;
  }

  get(id: string): NodeRecord | undefined {
    const cached = this.#cache.get(id);
    if (cached !== undefined) {
      // Used again: the last to let go.
      this.#cache.delete(id);
      this.#cache.set(id, cached);
      return cached.node ?? undefined;
    }
    const row = this.#sql
      .exec<NodeRow>("SELECT id, parent, key, type, props FROM nodes WHERE id = ?", id)
      .toArray()[0];
    const node = row ? toRecord(row) : null;
    let charged = 0;
    if (this.#budget) {
      charged = ENTRY_BYTES + (node ? nodeBytes(node) : 0);
      this.#budget.charge(charged);
    }
    this.#keep(id, node, row ? row.props.length : 0, charged);
    return node ?? undefined;
  }

  /** Keeps `node` as `id`'s, then lets the least recently used go past the bound. */
  #keep(id: string, node: NodeRecord | null, chars: number, charged = 0): void {
    const before = this.#cache.get(id);
    if (before) {
      this.#cache.delete(id);
      this.#bytes -= before.weight;
      // What was charged for it is let go with it once it leaves the cache.
      charged += before.charged;
    }
    const weight = weightOf(chars);
    this.#cache.set(id, { node, weight, charged });
    this.#bytes += weight;
    while (this.#bytes > this.#maxBytes && this.#cache.size > 1) {
      const [oldest, entry] = this.#cache.entries().next().value as [string, Cached];
      this.#cache.delete(oldest);
      this.#bytes -= entry.weight;
      if (entry.charged > 0) this.#budget?.release(entry.charged);
    }
  }

  childIds(parent: string): readonly string[] {
    // SQLite compares TEXT bytewise, which matches the order keys' ASCII order.
    if (!this.#budget)
      return this.#sql
        .exec<{ id: string }>("SELECT id FROM nodes WHERE parent = ? ORDER BY key, id", parent)
        .toArray()
        .map((row) => row.id);
    // Metered (copies built from it): no more than the budget has room for, refused before
    // they're read (a main's layer with more children than a build could hold).
    const room = idsRoom(this.#budget);
    const ids = this.#sql
      .exec<{ id: string }>(
        "SELECT id FROM nodes WHERE parent = ? ORDER BY key, id LIMIT ?",
        parent,
        room + 1,
      )
      .toArray()
      .map((row) => row.id);
    checkIds(this.#budget, room, ids.length);
    return ids;
  }

  insert(node: NodeRecord): void {
    const json = JSON.stringify(node.props);
    this.#sql.exec(
      "INSERT INTO nodes (id, parent, key, type, props) VALUES (?, ?, ?, ?, ?)",
      node.id,
      node.parent,
      node.key,
      node.type,
      json,
    );
    this.#keep(node.id, node, json.length);
  }

  setProp(id: string, prop: PropName, value: unknown): void {
    const node = this.get(id);
    if (!node) throw new Error(`no node ${id}`);
    const props: Record<string, unknown> = { ...node.props };
    if (value === undefined) delete props[prop];
    else props[prop] = value;
    const json = JSON.stringify(props);
    this.#sql.exec("UPDATE nodes SET props = ? WHERE id = ?", json, id);
    this.#keep(id, { ...node, props }, json.length);
  }

  move(id: string, parent: string, key: string): void {
    const node = this.get(id);
    if (!node) throw new Error(`no node ${id}`);
    this.#sql.exec("UPDATE nodes SET parent = ?, key = ? WHERE id = ?", parent, key, id);
    const kept = this.#cache.get(id);
    // `get` just kept it, so it's there unless it alone is past the bound.
    this.#keep(id, { ...node, parent, key }, kept ? (kept.weight - ENTRY_BYTES) / 2 : 0);
  }

  remove(id: string): void {
    this.#sql.exec("DELETE FROM nodes WHERE id = ?", id);
    this.#keep(id, null, 0);
  }

  /** Removes a node and everything under it in one statement, without reading them. */
  removeTree(id: string): void {
    this.#sql.exec(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent = sub.id)
       DELETE FROM nodes WHERE id IN (SELECT id FROM sub)`,
      id,
    );
    // Whatever was cached under it is gone too.
    this.clearCache();
    this.#keep(id, null, 0);
  }

  /** Whether anything lies more than `levels` levels below `id`, in one statement. */
  deeperThan(id: string, levels: number): boolean {
    // The node itself is 0 levels below: past a negative count already.
    if (levels < 0) return true;
    return (
      this.#sql
        .exec(
          `WITH RECURSIVE sub(id, level) AS (
             SELECT id, 1 FROM nodes WHERE parent = ?
             UNION ALL
             SELECT n.id, sub.level + 1 FROM nodes n JOIN sub ON n.parent = sub.id WHERE sub.level <= ?
           )
           SELECT 1 FROM sub WHERE level > ? LIMIT 1`,
          id,
          levels,
          levels,
        )
        .toArray().length > 0
    );
  }

  /** Whether a main contains an instance of itself through `id`, in SQL: no values are read. */
  instanceCycle(id: string, deep: boolean): boolean {
    return instanceCycleIn(this.#sql, "nodes", id, deep);
  }

  /** How many pages there are, counted in SQL no further than `atMost`. */
  pagesUpTo(atMost: number): number {
    return this.#sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM (SELECT 1 FROM nodes WHERE parent = ? AND type = 'page' LIMIT ?)",
        ROOT_ID,
        atMost,
      )
      .one().n;
  }

  count(): number {
    return this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM nodes").one().n;
  }

  /**
   * Every node, in id order, read a page at a time with each page bounded by
   * its characters (`tablePages`): what's held at once of the file's JSON is
   * a page of it, and a page's rows are let go of as the next is read. For
   * building something from the whole file that counts what it keeps (the
   * headless editor).
   */
  *records(): Generator<NodeRecord> {
    for (const rows of tablePages(this.#sql, "nodes")) {
      const page = rows as NodeRow[];
      for (let i = 0; i < page.length; i++) {
        yield toRecord(page[i] as NodeRow);
        // Its JSON isn't needed once parsed.
        page[i] = undefined as unknown as NodeRow;
      }
    }
  }

  /** All nodes in pages of `size`, for snapshots. */
  *pages(size: number): Generator<NodeRecord[]> {
    let after = "";
    for (;;) {
      const rows = this.#sql
        .exec<NodeRow>(
          "SELECT id, parent, key, type, props FROM nodes WHERE id > ? ORDER BY id LIMIT ?",
          after,
          size,
        )
        .toArray();
      if (rows.length === 0) return;
      yield rows.map(toRecord);
      after = (rows[rows.length - 1] as NodeRow).id;
      if (rows.length < size) return;
    }
  }
}
