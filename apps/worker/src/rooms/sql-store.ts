import {
  type BuildBudget,
  ENTRY_BYTES,
  type NodeRecord,
  type NodeStore,
  type NodeType,
  nodeBytes,
  type PropName,
  type Props,
} from "@drawpane/model";
import { checkIds, idsRoom } from "./convert";
import { instanceCycleIn } from "./instance-cycles";

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
 * The FileRoom's node store: one SQLite row per node. A transaction touches
 * only the rows it changes, so memory and write cost track the size of an
 * edit, not the size of the file.
 *
 * A small read cache avoids re-parsing a node's JSON several times while one
 * transaction validates and applies it. Writes go straight to SQLite and keep
 * the cache in step. Call `clearCache()` after a transaction rolls back.
 */
export class SqlNodeStore implements NodeStore {
  readonly #sql: SqlStorage;
  readonly #cache = new Map<string, NodeRecord | null>();
  #budget: BuildBudget | null = null;
  /** What the cache was charged since it last emptied. */
  #held = 0;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  clearCache(): void {
    this.#cache.clear();
    this.#budget?.release(this.#held);
    this.#held = 0;
  }

  /**
   * Charges every row parsed into the cache to `budget` (null: none), until
   * the cache empties: for reads that build copies from it (main-removal.ts),
   * so what it keeps counts against what they may hold. Empties the cache.
   */
  meter(budget: BuildBudget | null): void {
    this.clearCache();
    this.#budget = budget;
  }

  get(id: string): NodeRecord | undefined {
    const cached = this.#cache.get(id);
    if (cached !== undefined) return cached ?? undefined;
    const row = this.#sql
      .exec<NodeRow>("SELECT id, parent, key, type, props FROM nodes WHERE id = ?", id)
      .toArray()[0];
    const node = row ? toRecord(row) : null;
    if (this.#budget) {
      const cost = ENTRY_BYTES + (node ? nodeBytes(node) : 0);
      this.#budget.charge(cost);
      this.#held += cost;
    }
    this.#cache.set(id, node);
    return node ?? undefined;
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
    this.#sql.exec(
      "INSERT INTO nodes (id, parent, key, type, props) VALUES (?, ?, ?, ?, ?)",
      node.id,
      node.parent,
      node.key,
      node.type,
      JSON.stringify(node.props),
    );
    this.#cache.set(node.id, node);
  }

  setProp(id: string, prop: PropName, value: unknown): void {
    const node = this.get(id);
    if (!node) throw new Error(`no node ${id}`);
    const props: Record<string, unknown> = { ...node.props };
    if (value === undefined) delete props[prop];
    else props[prop] = value;
    this.#sql.exec("UPDATE nodes SET props = ? WHERE id = ?", JSON.stringify(props), id);
    this.#cache.set(id, { ...node, props });
  }

  move(id: string, parent: string, key: string): void {
    const node = this.get(id);
    if (!node) throw new Error(`no node ${id}`);
    this.#sql.exec("UPDATE nodes SET parent = ?, key = ? WHERE id = ?", parent, key, id);
    this.#cache.set(id, { ...node, parent, key });
  }

  remove(id: string): void {
    this.#sql.exec("DELETE FROM nodes WHERE id = ?", id);
    this.#cache.set(id, null);
  }

  /** Removes a node and everything under it in one statement, without reading them. */
  removeTree(id: string): void {
    this.#sql.exec(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent = sub.id)
       DELETE FROM nodes WHERE id IN (SELECT id FROM sub)`,
      id,
    );
    // Whatever was cached under it is gone too.
    this.#cache.clear();
    this.#cache.set(id, null);
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

  count(): number {
    return this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM nodes").one().n;
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
