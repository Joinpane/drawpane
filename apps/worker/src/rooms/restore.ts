/**
 * Restoring a whole file to a version (decision 0026) without either in
 * memory: the version is read from R2 into a table beside the file's, and
 * the difference is worked out a page of rows at a time, the same way
 * `restoreOps` does it for the editor (`restoreNodeOps` is shared):
 * - the version's nodes top-down, level by level, each created or moved
 *   into place with its properties set (its parent is in place already, so
 *   a move never makes a cycle);
 * - then the topmost of the file's nodes the version doesn't have, deleted.
 */
import { NODE_TYPES, type NodeRecord, ROOT_ID, restoreNodeOps } from "@drawpane/model";
import {
  countRows,
  createNodeTable,
  fillDepths,
  insertNodes,
  type NodeRow,
  PAGE_ROWS,
  toRecord,
} from "./node-tables";
import type { OpChunks } from "./op-chunks";
import { type SnapshotSource, snapshotNodes } from "./snapshots";

/** A snapshot whose nodes don't hold together: nothing is done with it. */
export class SnapshotError extends Error {
  override name = "SnapshotError";
}

/**
 * Reads a snapshot into `table`, a batch at a time, then numbers its levels,
 * however deep (a file may hold layers deeper than an edit may make now).
 * Every node must be reachable from the root: one that isn't (inside
 * itself, under a parent the snapshot lacks) throws `SnapshotError`, since
 * treating it as absent would delete it from the file. Then nodes of a kind
 * this schema doesn't know are left out, with whatever they hold, as a
 * restore leaves them out.
 */
export async function loadSnapshot(
  sql: SqlStorage,
  table: string,
  source: SnapshotSource,
  transact: <T>(fn: () => T) => T,
): Promise<number> {
  createNodeTable(sql, table);
  for await (const batch of snapshotNodes(source))
    try {
      transact(() => insertNodes(sql, table, batch));
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new SnapshotError("A layer is in it twice.");
      throw error;
    }
  const total = countRows(sql, table);
  const { placed } = fillDepths(sql, table, Number.POSITIVE_INFINITY);
  if (placed < total) {
    const stray = sql
      .exec<{ id: string; parent: string }>(
        `SELECT id, parent FROM ${table} WHERE depth IS NULL ORDER BY id LIMIT 1`,
      )
      .one();
    throw new SnapshotError(
      `Its layer ${stray.id} isn't in the file: its parent ${stray.parent} is missing, or it's inside itself.`,
    );
  }
  return total - dropUnknownKinds(sql, table);
}

/** Leaves out nodes of kinds this schema doesn't know, and what's inside them. Returns how many. */
function dropUnknownKinds(sql: SqlStorage, table: string): number {
  const known = NODE_TYPES.map((t) => `'${t}'`).join(", ");
  const unknown = sql.exec(`SELECT 1 FROM ${table} WHERE type NOT IN (${known}) LIMIT 1`).toArray();
  if (unknown.length === 0) return 0;
  const deepest = sql.exec<{ d: number }>(`SELECT MAX(depth) AS d FROM ${table}`).one().d;
  sql.exec(`UPDATE ${table} SET depth = NULL WHERE type NOT IN (${known})`);
  // Top down, so each level's dropped parents are marked before their children.
  for (let depth = 2; depth <= deepest; depth++)
    sql.exec(
      `UPDATE ${table} SET depth = NULL
        WHERE depth = ? AND parent IN (SELECT id FROM ${table} WHERE depth IS NULL)`,
      depth,
    );
  const before = countRows(sql, table);
  sql.exec(`DELETE FROM ${table} WHERE depth IS NULL`);
  return before - countRows(sql, table);
}

interface JoinedRow extends NodeRow {
  depth: number;
  n_parent: string | null;
  n_key: string | null;
  n_type: string | null;
  n_props: string | null;
}

/**
 * Pushes the operations that turn the file (`nodes`) into the version in
 * `version` (loaded by `loadSnapshot`) into `out`, which commits them as it
 * fills. Returns how many values the current schema refused.
 */
export function restoreFromTable(sql: SqlStorage, version: string, out: OpChunks): number {
  const count = { dropped: 0 };
  let after: [number, string] = [0, ""];
  for (;;) {
    const rows = sql
      .exec<JoinedRow>(
        `SELECT v.id, v.parent, v.key, v.type, v.props, v.depth,
                n.parent AS n_parent, n.key AS n_key, n.type AS n_type, n.props AS n_props
           FROM ${version} v LEFT JOIN nodes n ON n.id = v.id
          WHERE v.depth IS NOT NULL AND (v.depth > ? OR (v.depth = ? AND v.id > ?))
          ORDER BY v.depth, v.id LIMIT ?`,
        after[0],
        after[0],
        after[1],
        PAGE_ROWS,
      )
      .toArray();
    if (rows.length === 0) break;
    // Level by level, so each node's parent is placed (by an earlier operation) before it.
    for (const row of rows) {
      after = [row.depth, row.id];
      // Unchanged, byte for byte: nothing to do, and nothing to parse.
      if (
        row.n_props === row.props &&
        row.n_parent === row.parent &&
        row.n_key === row.key &&
        row.n_type === row.type
      )
        continue;
      const now: NodeRecord | undefined =
        row.n_type === null
          ? undefined
          : toRecord({
              id: row.id,
              parent: row.n_parent as string,
              key: row.n_key as string,
              type: row.n_type,
              props: row.n_props as string,
            });
      const node = toRecord(row);
      const { place, sets } = restoreNodeOps(now, node, node.parent, node.key, count);
      if (place) out.push(place);
      for (const op of sets) out.push(op);
    }
    if (rows.length < PAGE_ROWS) break;
  }

  // The topmost of the file's nodes the version doesn't have; what's inside them goes with them.
  let last = "";
  for (;;) {
    const rows = sql
      .exec<{ id: string }>(
        `SELECT n.id FROM nodes n
          WHERE n.id > ?
            AND NOT EXISTS (SELECT 1 FROM ${version} v WHERE v.id = n.id AND v.depth IS NOT NULL)
            AND (n.parent = ? OR EXISTS (SELECT 1 FROM ${version} v WHERE v.id = n.parent AND v.depth IS NOT NULL))
          ORDER BY n.id LIMIT ?`,
        last,
        ROOT_ID,
        PAGE_ROWS,
      )
      .toArray();
    for (const row of rows) out.push({ op: "delete", id: row.id });
    if (rows.length < PAGE_ROWS) break;
    last = (rows[rows.length - 1] as { id: string }).id;
  }
  out.flush();
  return count.dropped;
}
