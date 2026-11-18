/**
 * Decision 0034's one-step migration (the model's `legacyTokenOps`), over a
 * room's SQLite: a file stored before it is migrated when its room loads it
 * (logged, so everyone catching up gets it), and a version or a branch's side
 * saved before it is migrated in the table it's read into, before anything
 * is compared or restored from it.
 *
 * Only the rows it can concern are read (variables, collections, and nodes
 * that bind anything), a row at a time; what it holds is the file's
 * variables and the bindings of layers bound to opacity.
 */
import { legacyTokenOps, type NodeRecord, type Op } from "@drawpane/model";
import { type NodeRow, toRecord, toRow } from "./node-tables";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The rows of `table` the migration reads. */
function* candidates(sql: SqlStorage, table: string): Generator<NodeRecord> {
  if (!NAME.test(table)) throw new Error(`bad table name ${table}`);
  for (const row of sql.exec<NodeRow>(
    `SELECT id, parent, key, type, props FROM ${table}
     WHERE type IN ('variable', 'collection') OR props LIKE '%"bindings"%'`,
  ))
    yield toRecord(row);
}

/** The operations migrating the nodes in `table` (a file stored at token version 0). */
export function legacyTableOps(sql: SqlStorage, table: string): Op[] {
  return legacyTokenOps(candidates(sql, table));
}

/**
 * Migrates a node table read aside (a version, a branch's base) in place,
 * its `depth` column kept. Returns how many rows it changed or added.
 */
export function migrateTable(sql: SqlStorage, table: string): number {
  const ops = legacyTableOps(sql, table);
  for (const op of ops) {
    if (op.op === "set") {
      const row = sql
        .exec<{ props: string }>(`SELECT props FROM ${table} WHERE id = ?`, op.id)
        .toArray()[0];
      if (!row) continue;
      const props = JSON.parse(row.props) as Record<string, unknown>;
      if (op.value === null) delete props[op.prop];
      else props[op.prop] = op.value;
      sql.exec(`UPDATE ${table} SET props = ? WHERE id = ?`, JSON.stringify(props), op.id);
    } else if (op.op === "create") {
      const row = toRow({
        id: op.id,
        type: op.type,
        parent: op.parent,
        key: op.key,
        props: op.props,
      });
      sql.exec(
        `INSERT OR IGNORE INTO ${table} (id, parent, key, type, props, depth)
         VALUES (?, ?, ?, ?, ?, (SELECT depth + 1 FROM ${table} WHERE id = ?))`,
        row.id,
        row.parent,
        row.key,
        row.type,
        row.props,
        row.parent,
      );
    }
  }
  return ops.length;
}
