import type { NodeRecord, NodeStore, NodeType, PropName, Props } from "@drawpane/model";

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

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  clearCache(): void {
    this.#cache.clear();
  }

  get(id: string): NodeRecord | undefined {
    const cached = this.#cache.get(id);
    if (cached !== undefined) return cached ?? undefined;
    const row = this.#sql
      .exec<NodeRow>("SELECT id, parent, key, type, props FROM nodes WHERE id = ?", id)
      .toArray()[0];
    const node = row ? toRecord(row) : null;
    this.#cache.set(id, node);
    return node ?? undefined;
  }

  childIds(parent: string): readonly string[] {
    // SQLite compares TEXT bytewise, which matches the order keys' ASCII order.
    return this.#sql
      .exec<{ id: string }>("SELECT id FROM nodes WHERE parent = ? ORDER BY key, id", parent)
      .toArray()
      .map((row) => row.id);
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
