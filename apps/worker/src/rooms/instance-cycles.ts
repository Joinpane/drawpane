/**
 * Whether a main contains an instance of itself (decision 0029), answered
 * in SQL: what's followed is which mains each main names (an instance's
 * `instanceOf`, a record's swap), never a layer's values, so a main of any
 * size is checked without reading it into memory. The model's
 * `instanceCycleAt` asks this through `SqlNodeStore.instanceCycle`; the room
 * checks a transaction's nodes with it once everything has applied, and a
 * compact import's mains before it lands.
 */
import { ModelError } from "@drawpane/model";

/** `alias` is a live main: a frame that's a component. */
const isMain = (alias: string) =>
  `${alias}.type = 'frame' AND json_extract(${alias}.props, '$.isComponent')`;

/**
 * The main a node `s` names, read only from frames and records (a text's
 * values aren't parsed at all), joined as `m` when it's a live main other
 * than the node itself.
 */
const namedMain = (table: string) =>
  `JOIN ${table} m ON m.id = CASE WHEN s.type IN ('frame', 'override')
                                 THEN json_extract(s.props, '$.instanceOf') END
   WHERE m.id != s.id AND ${isMain("m")}`;

/**
 * Whether a main contains an instance of itself through `id`, in `table`:
 * one of the mains `id` is in (itself included) is reached from the mains
 * named at `id` (or anywhere under it, `deep`), followed through every
 * layer of each main reached. False for a node that isn't there.
 */
export function instanceCycleIn(
  sql: SqlStorage,
  table: string,
  id: string,
  deep: boolean,
): boolean {
  // The mains around it: as many as it has levels above it, ids only.
  const around = sql
    .exec<{ id: string }>(
      `WITH RECURSIVE up(id, parent) AS (
         SELECT id, parent FROM ${table} WHERE id = ?
         UNION
         SELECT n.id, n.parent FROM ${table} n JOIN up ON n.id = up.parent
       )
       SELECT n.id FROM up JOIN ${table} n ON n.id = up.id WHERE ${isMain("n")}`,
      id,
    )
    .toArray()
    .map((row) => row.id);
  if (around.length === 0) return false;
  // Walked in SQLite (UNION keeps each node once, so a loop held from before ends too).
  return (
    sql
      .exec(
        `WITH RECURSIVE
           sub(id) AS (
             SELECT ?
             UNION
             SELECT n.id FROM ${table} n JOIN sub ON n.parent = sub.id WHERE ?
           ),
           walk(id) AS (
             SELECT m.id FROM sub JOIN ${table} s ON s.id = sub.id ${namedMain(table)}
             UNION
             SELECT n.id FROM ${table} n JOIN walk ON n.parent = walk.id
             UNION
             SELECT m.id FROM walk JOIN ${table} s ON s.id = walk.id ${namedMain(table)}
           )
         SELECT 1 FROM walk WHERE id IN (SELECT value FROM json_each(?)) LIMIT 1`,
        id,
        deep ? 1 : 0,
        JSON.stringify(around),
      )
      .toArray().length > 0
  );
}

/**
 * A main in `table` that contains an instance of itself, or null: each main
 * holding an instance (or a swapping record) anywhere under it is checked
 * in turn, a page of ids at a time.
 */
export function cyclicMainIn(sql: SqlStorage, table: string): string | null {
  let after = "";
  for (;;) {
    const mains = sql
      .exec<{ id: string }>(
        `SELECT n.id FROM ${table} n WHERE n.id > ? AND ${isMain("n")} ORDER BY n.id LIMIT 200`,
        after,
      )
      .toArray()
      .map((row) => row.id);
    for (const main of mains) if (instanceCycleIn(sql, table, main, true)) return main;
    if (mains.length < 200) return null;
    after = mains[mains.length - 1] as string;
  }
}

/** What a component containing its own instance is refused with, on every path. */
export const CYCLE_MESSAGE =
  "A component can't contain an instance of itself, directly or through other components.";

/**
 * The nodes a storage transaction's operations may have made a main contain
 * itself through (the model's `cycleCandidate`), kept in SQL so a restore of
 * any size holds none of them in memory, and checked once its last chunk has
 * applied: a restore passes through such a state on the way (it creates the
 * version's layers before deleting the file's), and only the end counts.
 */
export const CYCLE_CHECK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cycle_check (
    id TEXT PRIMARY KEY,
    deep INTEGER NOT NULL
  ) STRICT;
`;

export class CycleCheck {
  readonly #sql: SqlStorage;

  /** Call inside the storage transaction, before anything applies. */
  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec("DELETE FROM cycle_check");
  }

  /** For `applyTransaction`'s `cycles`. */
  add = (id: string, deep: boolean): void => {
    this.#sql.exec(
      `INSERT INTO cycle_check (id, deep) VALUES (?, ?)
       ON CONFLICT (id) DO UPDATE SET deep = max(deep, excluded.deep)`,
      id,
      deep ? 1 : 0,
    );
  };

  /** Throws `ModelError` ("cycle") when what applied leaves a main containing itself. */
  check(): void {
    let after = "";
    try {
      for (;;) {
        const rows = this.#sql
          .exec<{ id: string; deep: number }>(
            "SELECT id, deep FROM cycle_check WHERE id > ? ORDER BY id LIMIT 500",
            after,
          )
          .toArray();
        for (const row of rows)
          if (instanceCycleIn(this.#sql, "nodes", row.id, row.deep === 1))
            throw new ModelError("cycle", CYCLE_MESSAGE);
        if (rows.length < 500) return;
        after = (rows[rows.length - 1] as { id: string }).id;
      }
    } finally {
      this.#sql.exec("DELETE FROM cycle_check");
    }
  }
}
