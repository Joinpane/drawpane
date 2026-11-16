/**
 * An import arriving in parts (decision 0026). Each part's nodes are checked
 * on their own as they come (id, order key, every property) and kept in a
 * table beside the file's; the commit checks how they fit together (every
 * parent there and allowed to hold its child, no node inside itself, no
 * deeper than MAX_DEPTH) in SQL, then fills the file from the table in one
 * storage transaction. Until then the file is as it was.
 */
import { checkNode, MAX_DEPTH, ModelError, type NodeRecord, ROOT_ID } from "@drawpane/model";
import {
  allowedChildrenSql,
  countRows,
  createNodeTable,
  fillDepths,
  insertNodes,
  type RoomSql,
} from "./node-tables";

/** Where an import waits for its commit. One at a time per room. */
export const IMPORT_TABLE = "import_nodes";

export function beginStaging(sql: SqlStorage, table = IMPORT_TABLE): void {
  createNodeTable(sql, table);
}

/**
 * Checks a part's nodes and adds them to the staged import, all or none.
 * Returns how many the import holds now. Throws `ModelError`.
 */
export function stageNodes(
  room: RoomSql,
  nodes: readonly NodeRecord[],
  table = IMPORT_TABLE,
): number {
  const checked: NodeRecord[] = [];
  const seen = new Set<string>();
  for (const [i, node] of nodes.entries()) {
    try {
      checked.push(checkNode(node));
    } catch (error) {
      if (error instanceof ModelError) throw new ModelError(error.code, error.message, i);
      throw error;
    }
    if (seen.has(node.id))
      throw new ModelError("already_exists", `Node ${node.id} is in the import twice.`, i);
    seen.add(node.id);
  }
  return room.transact(() => {
    for (let i = 0; i < checked.length; i += 90) {
      const ids = checked.slice(i, i + 90).map((n) => n.id);
      const there = room.sql
        .exec<{ id: string }>(
          `SELECT id FROM ${table} WHERE id IN (${ids.map(() => "?").join(", ")}) LIMIT 1`,
          ...ids,
        )
        .toArray()[0];
      if (there) throw new ModelError("already_exists", `Node ${there.id} is in the import twice.`);
    }
    insertNodes(room.sql, table, checked);
    return countRows(room.sql, table);
  });
}

/**
 * Checks how the staged nodes fit together, and with the file's own nodes
 * (`live`), in SQL. Throws `ModelError` naming the first node that doesn't.
 */
export function checkStaged(sql: SqlStorage, table = IMPORT_TABLE, live = "nodes"): void {
  const page = sql
    .exec(`SELECT 1 FROM ${table} WHERE parent = ? AND type = 'page' LIMIT 1`, ROOT_ID)
    .toArray();
  if (page.length === 0) throw new ModelError("not_found", "There's nothing to import.");

  const clash = sql
    .exec<{ id: string }>(`SELECT s.id FROM ${table} s JOIN ${live} n ON n.id = s.id LIMIT 1`)
    .toArray()[0];
  if (clash) throw new ModelError("already_exists", `Node ${clash.id} already exists.`);

  const orphan = sql
    .exec<{ parent: string }>(
      `SELECT s.parent FROM ${table} s
        WHERE s.parent != ? AND NOT EXISTS (SELECT 1 FROM ${table} p WHERE p.id = s.parent) LIMIT 1`,
      ROOT_ID,
    )
    .toArray()[0];
  if (orphan) throw new ModelError("not_found", `Parent ${orphan.parent} doesn't exist.`);

  const misplaced = sql
    .exec<{ child: string; parent: string }>(
      `WITH ${allowedChildrenSql()}
       SELECT s.type AS child, COALESCE(p.type, 'root') AS parent
         FROM ${table} s LEFT JOIN ${table} p ON p.id = s.parent
        WHERE NOT EXISTS (
          SELECT 1 FROM allowed a WHERE a.parent = COALESCE(p.type, 'root') AND a.child = s.type
        ) LIMIT 1`,
    )
    .toArray()[0];
  if (misplaced)
    throw new ModelError(
      "invalid_parent",
      `A ${misplaced.parent} can't contain a ${misplaced.child}.`,
    );

  const { placed, tooDeep } = fillDepths(sql, table);
  if (placed < countRows(sql, table)) {
    if (tooDeep)
      throw new ModelError("too_deep", `Layers can't nest deeper than ${MAX_DEPTH} levels.`);
    const looped = sql
      .exec<{ id: string }>(`SELECT id FROM ${table} WHERE depth IS NULL LIMIT 1`)
      .toArray()[0];
    throw new ModelError("cycle", `Layer ${looped?.id ?? ""} is inside itself.`);
  }
}

/**
 * Moves the staged nodes into the file's `nodes` and removes the starting
 * page, in SQL. Call inside the storage transaction that records the
 * change, after `checkStaged`.
 */
export function fillFromStaged(sql: SqlStorage, seedId: string, table = IMPORT_TABLE): void {
  sql.exec(
    `INSERT INTO nodes (id, parent, key, type, props) SELECT id, parent, key, type, props FROM ${table}`,
  );
  sql.exec("DELETE FROM nodes WHERE id = ?", seedId);
}
