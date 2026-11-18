/**
 * Every instance keeps a record (decision 0035, item 3), in the room's
 * tables: what an instance from before records held on its layers is folded
 * into one with the model's `foldRecord` (every value kept, or its layer
 * unlinked), before anyone reads it. A node table coming in whole (an
 * import, a version to restore, a branch's base and nodes to merge) is
 * folded in place here; the room's own nodes migrate when it loads, as
 * logged transactions everyone follows (file-room.ts).
 */
import { foldRecord, type NodeRecord } from "@drawpane/model";
import { checkName, PAGE_ROWS, TableReader } from "./node-tables";

/** SQL: an instance root that isn't a copy and keeps no record (`needsRecord`). */
export const NEEDS_RECORD = `type = 'frame'
  AND json_extract(props, '$.instanceOf') IS NOT NULL
  AND json_extract(props, '$.mirrors') IS NULL
  AND json_type(props, '$.propValues') IS NULL`;

/** Up to `limit` instances in `table` that need a record. */
export function needingRecords(sql: SqlStorage, table: string, limit: number): string[] {
  return sql
    .exec<{ id: string }>(
      `SELECT id FROM ${checkName(table)} WHERE ${NEEDS_RECORD} ORDER BY id LIMIT ?`,
      limit,
    )
    .toArray()
    .map((row) => row.id);
}

/**
 * Folds every instance from before records in `table` into its record, in
 * place, a page of instances at a time: each one's record written, and the
 * layers it unlinks or unmarks. Returns how many.
 */
export function migrateTable(sql: SqlStorage, table: string): number {
  let migrated = 0;
  for (;;) {
    const ids = needingRecords(sql, table, PAGE_ROWS);
    if (ids.length === 0) return migrated;
    // Read afresh each page: what the last one wrote is read as written.
    const reader = new TableReader(sql, table);
    const writes = new Map<string, NodeRecord>();
    const read = (id: string) => writes.get(id) ?? reader.get(id);
    for (const id of ids) {
      const root = read(id);
      if (!root) continue;
      const fold = foldRecord({ get: read, childIds: (p) => reader.childIds(p) }, id);
      writes.set(id, { ...root, props: { ...root.props, propValues: fold.record } });
      for (const [layerId, patch] of fold.patches) {
        const layer = read(layerId);
        if (!layer) continue;
        const props: Record<string, unknown> = { ...layer.props };
        for (const [prop, value] of Object.entries(patch)) {
          if (value === undefined) delete props[prop];
          else props[prop] = value;
        }
        writes.set(layerId, { ...layer, props: props as NodeRecord["props"] });
      }
      migrated++;
    }
    for (const node of writes.values())
      sql.exec(
        `UPDATE ${checkName(table)} SET props = ? WHERE id = ?`,
        JSON.stringify(node.props),
        node.id,
      );
  }
}
