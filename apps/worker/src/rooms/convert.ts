/**
 * Converting a room's file to compact copies (decision 0029, phase 4b), an
 * instance at a time, without holding the file and without stopping it
 * from being used.
 *
 * The file stays as it is (materialized, `nodes`) while it converts. What
 * the conversion decides goes into tables beside it, an instance at a time,
 * each in its own storage transaction, so a conversion cut short (the room
 * evicted, a deploy) resumes where it was:
 *
 * - `map`: each copy layer's old id → its derived id, and its instance;
 * - `rows`: what's stored differently: each converted instance's root and
 *   override records, and every layer of an instance left detached;
 * - `done`: the instances settled, converted or detached (and why);
 * - `deps`: the mains (and sets) each was built from;
 * - `roots`: the file's top-level instance roots, in the order they're done.
 *
 * Edits go on meanwhile, to the materialized file as ever. Each one marks
 * the instances it may have changed (`markDirty`, in the edit's own
 * storage transaction): the instance it's in, and every instance built from
 * a main it's in. Their rows are dropped and they're converted again. When
 * every top-level instance is settled, `applyConversion` replaces what
 * changed in one storage transaction: nobody sees the file half converted.
 *
 * The same code converts a table read from a snapshot (a version saved
 * before conversion, a branch's old base): `compactTable`.
 *
 * Nothing here imports `cloudflare:workers`, so the memory check runs it in
 * Node (test-node/).
 */
import {
  type ConvertedInstance,
  type ConvertReader,
  type ConvertSink,
  type DetachedInstance,
  holdsIds,
  InstanceConverter,
  type NodeRecord,
  ROOT_ID,
  renameHeldIds,
} from "@drawpane/model";
import {
  createNodeTable,
  fillDepths,
  NODE_COLUMNS,
  type NodeRow,
  type RoomSql,
  tempTable,
  toRecord,
  toRow,
} from "./node-tables";

/** The tables a conversion keeps its decisions in. */
export interface ConvertTables {
  readonly map: string;
  readonly rows: string;
  readonly done: string;
  readonly deps: string;
  readonly roots: string;
}

/** A room's own conversion: kept across requests until it's applied. */
export const LIVE_CONVERSION: ConvertTables = {
  map: "conv_map",
  rows: "conv_rows",
  done: "conv_done",
  deps: "conv_deps",
  roots: "conv_roots",
};

/** Instances left detached, and why: kept after the conversion, for whoever asks. */
export const COPIES_LOG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS copies_log (
    root TEXT PRIMARY KEY,
    why TEXT NOT NULL,
    at INTEGER NOT NULL
  ) STRICT;
`;

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
function checked(t: ConvertTables): ConvertTables {
  for (const name of Object.values(t)) if (!NAME.test(name)) throw new Error(`bad table ${name}`);
  return t;
}

/** Makes the tables (when they aren't there already). */
export function createConvertTables(sql: SqlStorage, t: ConvertTables): void {
  checked(t);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${t.map} (
    old TEXT PRIMARY KEY, new TEXT NOT NULL, root TEXT NOT NULL) STRICT`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${t.map}_root ON ${t.map} (root)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${t.rows} (
    id TEXT PRIMARY KEY, parent TEXT NOT NULL, key TEXT NOT NULL, type TEXT NOT NULL,
    props TEXT NOT NULL, root TEXT NOT NULL) STRICT`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${t.rows}_parent ON ${t.rows} (parent, key, id)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${t.rows}_root ON ${t.rows} (root)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${t.done} (
    root TEXT PRIMARY KEY, status TEXT NOT NULL, why TEXT, at INTEGER NOT NULL) STRICT`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${t.deps} (
    dep TEXT NOT NULL, root TEXT NOT NULL, PRIMARY KEY (dep, root)) STRICT, WITHOUT ROWID`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${t.deps}_root ON ${t.deps} (root)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${t.roots} (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL) STRICT`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${t.roots}_seq ON ${t.roots} (seq)`);
}

export function dropConvertTables(sql: SqlStorage, t: ConvertTables): void {
  for (const name of Object.values(checked(t))) sql.exec(`DROP TABLE IF EXISTS ${name}`);
}

/** Whether a conversion's tables are there (one under way, or applied and not yet tidied). */
export function hasConvertTables(sql: SqlStorage, t: ConvertTables): boolean {
  return (
    sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", checked(t).done)
      .toArray().length > 0
  );
}

/** A node in `n` is a live instance root: a frame whose `instanceOf` is a main. */
const liveSql = (src: string, n: string) =>
  `(${n}.type = 'frame' AND json_extract(${n}.props, '$.instanceOf') IS NOT NULL
    AND json_extract(${n}.props, '$.instanceOf') != ${n}.id
    AND EXISTS (SELECT 1 FROM ${src} m WHERE m.id = json_extract(${n}.props, '$.instanceOf')
                AND m.type = 'frame' AND json_extract(m.props, '$.isComponent') = 1))`;

/**
 * Top-level instance roots under `from` (not inside another instance), in
 * SQL: walked down from `from`, never into an instance.
 */
function rootsUnderSql(src: string): string {
  return `WITH RECURSIVE sub(id, live) AS (
      SELECT n.id, ${liveSql(src, "n")} FROM ${src} n WHERE n.parent = ? AND n.type != 'override'
      UNION ALL
      SELECT n.id, ${liveSql(src, "n")} FROM ${src} n JOIN sub ON n.parent = sub.id
       WHERE sub.live = 0 AND n.type != 'override'
    ) SELECT id FROM sub WHERE live = 1`;
}

/**
 * How many layers a file stored with compact copies presents (copy layers
 * counted as built), worked out in SQL without building any: each instance
 * presents what its main does. Swapped nested instances count as their
 * source's. For limits (the agent tools'), not exact bookkeeping.
 */
export function presentedCount(sql: SqlStorage, src = "nodes"): number {
  const stored = sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${src} WHERE type != 'override'`)
    .one().n;
  const memo = new Map<string, number>();
  const inside = (mainId: string, guard: Set<string>): number => {
    const known = memo.get(mainId);
    if (known !== undefined) return known;
    if (guard.has(mainId)) return 0;
    guard.add(mainId);
    const walk = `WITH RECURSIVE sub(id, live) AS (
        SELECT n.id, ${liveSql(src, "n")} FROM ${src} n WHERE n.parent = ? AND n.type != 'override'
        UNION ALL
        SELECT n.id, ${liveSql(src, "n")} FROM ${src} n JOIN sub ON n.parent = sub.id
         WHERE sub.live = 0 AND n.type != 'override'
      )`;
    let n = sql.exec<{ n: number }>(`${walk} SELECT COUNT(*) AS n FROM sub`, mainId).one().n;
    for (const row of sql
      .exec<{ of: string; n: number }>(
        `${walk} SELECT json_extract(s.props, '$.instanceOf') AS of, COUNT(*) AS n
           FROM sub JOIN ${src} s ON s.id = sub.id WHERE sub.live = 1 GROUP BY of`,
        mainId,
      )
      .toArray())
      n += row.n * inside(row.of, guard);
    guard.delete(mainId);
    memo.set(mainId, n);
    return n;
  };
  let total = stored;
  for (const row of sql
    .exec<{ of: string; n: number }>(
      `SELECT json_extract(n.props, '$.instanceOf') AS of, COUNT(*) AS n FROM ${src} n
        WHERE ${liveSql(src, "n")} GROUP BY of`,
    )
    .toArray())
    total += row.n * inside(row.of, new Set());
  return total;
}

/** Whether the file has any instance at all (a frame with `instanceOf`). */
export function hasInstances(sql: SqlStorage, src = "nodes"): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM ${src} WHERE type = 'frame' AND json_extract(props, '$.instanceOf') IS NOT NULL LIMIT 1`,
      )
      .toArray().length > 0
  );
}

/** How many entries the reader's caches keep before starting again. */
const CACHE_LIMIT = 50_000;

/**
 * The file as converted so far, read from SQLite (`src` and the
 * conversion's tables), and where the converter's decisions are written.
 */
class SqlConversion implements ConvertReader, ConvertSink {
  readonly #room: RoomSql;
  readonly #src: string;
  readonly #t: ConvertTables;
  readonly #nodes = new Map<string, NodeRecord | null>();
  readonly #kids = new Map<string, readonly string[]>();
  readonly #renames = new Map<string, string | null>();
  readonly #settled = new Map<string, boolean>();
  readonly #inside = new Map<string, readonly string[]>();
  convertedCount = 0;
  detachedCount = 0;

  constructor(room: RoomSql, src: string, t: ConvertTables) {
    this.#room = room;
    this.#src = src;
    this.#t = t;
  }

  get #sql(): SqlStorage {
    return this.#room.sql;
  }

  #trim(): void {
    if (this.#nodes.size > CACHE_LIMIT) this.#nodes.clear();
    if (this.#kids.size > CACHE_LIMIT) this.#kids.clear();
    if (this.#renames.size > CACHE_LIMIT) this.#renames.clear();
    if (this.#settled.size > CACHE_LIMIT) this.#settled.clear();
  }

  get(id: string): NodeRecord | undefined {
    const cached = this.#nodes.get(id);
    if (cached !== undefined) return cached ?? undefined;
    this.#trim();
    const t = this.#t;
    const row =
      this.#sql
        .exec<NodeRow>(`SELECT ${NODE_COLUMNS} FROM ${t.rows} WHERE id = ?`, id)
        .toArray()[0] ??
      (this.#sql.exec(`SELECT 1 FROM ${t.map} WHERE old = ?`, id).toArray().length > 0
        ? undefined
        : this.#sql
            .exec<NodeRow>(`SELECT ${NODE_COLUMNS} FROM ${this.#src} WHERE id = ?`, id)
            .toArray()[0]);
    const node = row ? toRecord(row) : null;
    this.#nodes.set(id, node);
    return node ?? undefined;
  }

  childIds(parent: string): readonly string[] {
    const cached = this.#kids.get(parent);
    if (cached) return cached;
    this.#trim();
    const t = this.#t;
    const ids = this.#sql
      .exec<{ id: string }>(
        `SELECT id, key FROM ${this.#src} s WHERE parent = ?1
            AND NOT EXISTS (SELECT 1 FROM ${t.map} m WHERE m.old = s.id)
         UNION SELECT id, key FROM ${t.rows} WHERE parent = ?1
         ORDER BY key, id`,
        parent,
      )
      .toArray()
      .map((row) => row.id);
    this.#kids.set(parent, ids);
    return ids;
  }

  layersUnder(rootId: string): readonly NodeRecord[] {
    return this.#sql
      .exec<NodeRow>(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM ${this.#src} WHERE parent = ?
           UNION ALL SELECT n.id FROM ${this.#src} n JOIN sub ON n.parent = sub.id
         ) SELECT ${NODE_COLUMNS} FROM ${this.#src} WHERE id IN (SELECT id FROM sub)`,
        rootId,
      )
      .toArray()
      .map(toRecord);
  }

  renamed(id: string): string | undefined {
    const cached = this.#renames.get(id);
    if (cached !== undefined) return cached ?? undefined;
    const to =
      this.#sql
        .exec<{ new: string }>(`SELECT new FROM ${this.#t.map} WHERE old = ?`, id)
        .toArray()[0]?.new ?? null;
    this.#renames.set(id, to);
    return to ?? undefined;
  }

  rootsInside(mainId: string): readonly string[] {
    const cached = this.#inside.get(mainId);
    if (cached) return cached;
    const ids = this.#sql
      .exec<{ id: string }>(rootsUnderSql(this.#src), mainId)
      .toArray()
      .map((row) => row.id);
    this.#inside.set(mainId, ids);
    return ids;
  }

  settled(rootId: string): boolean {
    const cached = this.#settled.get(rootId);
    if (cached !== undefined) return cached;
    const done =
      this.#sql.exec(`SELECT 1 FROM ${this.#t.done} WHERE root = ?`, rootId).toArray().length > 0;
    this.#settled.set(rootId, done);
    return done;
  }

  converted({ root, records, ids, deps }: ConvertedInstance): void {
    const t = this.#t;
    this.#room.transact(() => {
      const pairs = [...ids];
      for (let i = 0; i < pairs.length; i += 30) {
        const batch = pairs.slice(i, i + 30);
        this.#sql.exec(
          `INSERT OR REPLACE INTO ${t.map} (old, new, root) VALUES ${batch.map(() => "(?, ?, ?)").join(", ")}`,
          ...batch.flatMap(([from, to]) => [from, to, root.id]),
        );
      }
      this.#putRows([root, ...records], root.id);
      this.#settle(root.id, "converted", null, deps);
    });
    this.#nodes.set(root.id, root);
    for (const record of records) this.#nodes.set(record.id, record);
    for (const [from, to] of ids) {
      this.#renames.set(from, to);
      // Its old row is hidden now, unless its id is its derived one (a record, or nothing).
      if (from !== to) this.#nodes.set(from, null);
      else this.#nodes.delete(from);
      this.#nodes.delete(to);
    }
    this.#kids.clear();
    this.#settled.set(root.id, true);
    this.convertedCount++;
  }

  detached({ root, layers, why, deps }: DetachedInstance): void {
    this.#room.transact(() => {
      this.#putRows([root, ...layers], root.id);
      this.#settle(root.id, "detached", why, deps);
    });
    this.#nodes.set(root.id, root);
    for (const layer of layers) this.#nodes.set(layer.id, layer);
    this.#settled.set(root.id, true);
    this.detachedCount++;
    console.warn(`compact copies: instance ${root.id} left detached: ${why}`);
  }

  #putRows(nodes: readonly NodeRecord[], rootId: string): void {
    for (let i = 0; i < nodes.length; i += 15) {
      const batch = nodes.slice(i, i + 15).map(toRow);
      this.#sql.exec(
        `INSERT OR REPLACE INTO ${this.#t.rows} (id, parent, key, type, props, root) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
        ...batch.flatMap((r) => [r.id, r.parent, r.key, r.type, r.props, rootId]),
      );
    }
  }

  #settle(rootId: string, status: string, why: string | null, deps: readonly string[]): void {
    const t = this.#t;
    this.#sql.exec(
      `INSERT OR REPLACE INTO ${t.done} (root, status, why, at) VALUES (?, ?, ?, ?)`,
      rootId,
      status,
      why,
      Date.now(),
    );
    for (const dep of deps)
      this.#sql.exec(`INSERT OR IGNORE INTO ${t.deps} (dep, root) VALUES (?, ?)`, dep, rootId);
  }
}

/** Forgets what was decided for an instance: it's converted again. */
function unsettle(sql: SqlStorage, t: ConvertTables, rootId: string): void {
  sql.exec(`DELETE FROM ${t.map} WHERE root = ?`, rootId);
  sql.exec(`DELETE FROM ${t.rows} WHERE root = ?`, rootId);
  sql.exec(`DELETE FROM ${t.done} WHERE root = ?`, rootId);
  sql.exec(`DELETE FROM ${t.deps} WHERE root = ?`, rootId);
}

/** Lists the file's top-level instance roots afresh, keeping the order of those listed before. */
function listRoots(sql: SqlStorage, src: string, t: ConvertTables): void {
  const next =
    (sql.exec<{ n: number | null }>(`SELECT MAX(seq) AS n FROM ${t.roots}`).one().n ?? 0) + 1;
  const now = tempTable("cvroots");
  try {
    sql.exec(`CREATE TABLE ${now} (id TEXT PRIMARY KEY) STRICT`);
    sql.exec(`INSERT OR IGNORE INTO ${now} (id) ${rootsUnderSql(src)}`, ROOT_ID);
    sql.exec(`DELETE FROM ${t.roots} WHERE id NOT IN (SELECT id FROM ${now})`);
    sql.exec(
      `INSERT OR IGNORE INTO ${t.roots} (id, seq) SELECT id, ? + ROW_NUMBER() OVER (ORDER BY id) FROM ${now}`,
      next,
    );
  } finally {
    sql.exec(`DROP TABLE IF EXISTS ${now}`);
  }
  // What was decided for an instance that's no longer one (unlinked, deleted, moved inside
  // another) is forgotten: its rows would put back what isn't there.
  for (const { root } of sql
    .exec<{ root: string }>(
      `SELECT root FROM ${t.done} WHERE root NOT IN (SELECT id FROM ${t.roots})`,
    )
    .toArray())
    unsettle(sql, t, root);
}

export interface StepResult {
  /** Instances settled in this step. */
  readonly converted: number;
  readonly detached: number;
  /** Top-level instances not settled yet; 0 means the conversion can be applied. */
  readonly left: number;
}

/**
 * Converts instances until `budgetMs` has passed (each in its own storage
 * transaction), then says how many are left. When none are, the file's
 * roots are listed afresh (edits may have made new ones) before saying so.
 */
export function convertStep(
  room: RoomSql,
  src: string,
  t: ConvertTables,
  budgetMs: number,
  now: () => number = Date.now,
): StepResult {
  const sql = room.sql;
  createConvertTables(sql, t);
  const started = now();
  if (sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t.roots}`).one().n === 0)
    listRoots(sql, src, t);
  const conversion = new SqlConversion(room, src, t);
  const converter = new InstanceConverter(conversion, conversion);
  const pending = () =>
    sql
      .exec<{ id: string }>(
        `SELECT id FROM ${t.roots} r WHERE NOT EXISTS (SELECT 1 FROM ${t.done} d WHERE d.root = r.id)
          ORDER BY seq LIMIT 200`,
      )
      .toArray()
      .map((row) => row.id);
  let relisted = false;
  for (;;) {
    let batch = pending();
    if (batch.length === 0 && !relisted) {
      listRoots(sql, src, t);
      relisted = true;
      batch = pending();
    }
    if (batch.length === 0) break;
    for (const id of batch) {
      converter.settle(id);
      if (converter.cached > 200_000) converter.clear();
      if (now() - started > budgetMs) break;
    }
    if (now() - started > budgetMs) break;
  }
  const left = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${t.roots} r WHERE NOT EXISTS (SELECT 1 FROM ${t.done} d WHERE d.root = r.id)`,
    )
    .one().n;
  return { converted: conversion.convertedCount, detached: conversion.detachedCount, left };
}

/**
 * Marks for converting again the instances an edit to `ids` may have
 * changed: an instance any of them is in, and every instance built from a
 * main (or set) any of them is in. Call inside the edit's storage
 * transaction, before and after it applies (so deleted and created layers
 * are both found).
 */
export function markDirty(
  sql: SqlStorage,
  src: string,
  t: ConvertTables,
  ids: Iterable<string>,
): number {
  const seen = new Set<string>();
  const roots = new Set<string>();
  const mains = new Set<string>();
  for (const start of ids) {
    let at: string | null = start;
    while (at !== null && at !== ROOT_ID && !seen.has(at)) {
      seen.add(at);
      const row: { parent: string; of: string | null } | undefined = sql
        .exec<{ parent: string; of: string | null; main: number | null; isset: number | null }>(
          `SELECT parent, json_extract(props, '$.instanceOf') AS of,
                  json_extract(props, '$.isComponent') AS main,
                  json_extract(props, '$.isComponentSet') AS isset
             FROM ${src} WHERE id = ?`,
          at,
        )
        .toArray()[0];
      // Gone (deleted, or a record id): what depends on it by id still counts.
      mains.add(at);
      if (!row) break;
      if (row.of !== null) roots.add(at);
      at = row.parent;
    }
  }
  const undo = new Set<string>();
  for (const root of roots)
    if (sql.exec(`SELECT 1 FROM ${t.done} WHERE root = ?`, root).toArray().length > 0)
      undo.add(root);
  for (const dep of mains)
    for (const { root } of sql
      .exec<{ root: string }>(`SELECT root FROM ${t.deps} WHERE dep = ?`, dep)
      .toArray())
      undo.add(root);
  for (const root of undo) unsettle(sql, t, root);
  return undo.size;
}

export interface Applied {
  /** Layers no longer stored (copies that equal their main's, or are records now). */
  readonly removed: number;
  readonly records: number;
  readonly detached: Array<{ root: string; why: string }>;
}

/**
 * Replaces what the conversion decided in `src`: the copy layers go, the
 * rewritten roots, records and detached layers come in, and ids other
 * layers hold are renamed. Run inside one storage transaction, once
 * `convertStep` has nothing left. Returns what changed.
 */
export function applyConversion(sql: SqlStorage, src: string, t: ConvertTables): Applied {
  const removed = sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t.map} WHERE old != new`)
    .one().n;
  const records = sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t.rows} WHERE type = 'override'`)
    .one().n;
  sql.exec(`DELETE FROM ${src} WHERE id IN (SELECT old FROM ${t.map})`);
  sql.exec(`INSERT OR REPLACE INTO ${src} (${NODE_COLUMNS}) SELECT ${NODE_COLUMNS} FROM ${t.rows}`);
  // Ids held outside the converted instances (a reading order, a prototype link, a flow).
  let after = "";
  for (;;) {
    const rows = sql
      .exec<NodeRow>(
        `SELECT ${NODE_COLUMNS} FROM ${src}
          WHERE id > ? AND type != 'override'
            AND (props LIKE '%"readingOrder"%' OR props LIKE '%"reactions"%' OR props LIKE '%"flows"%')
            AND NOT EXISTS (SELECT 1 FROM ${t.rows} r WHERE r.id = ${src}.id)
          ORDER BY id LIMIT 500`,
        after,
      )
      .toArray();
    for (const row of rows) {
      const node = toRecord(row);
      if (!holdsIds(node.props)) continue;
      const renamed = renameHeldIds(
        node.props,
        (id) =>
          sql.exec<{ new: string }>(`SELECT new FROM ${t.map} WHERE old = ?`, id).toArray()[0]?.new,
      );
      if (renamed)
        sql.exec(`UPDATE ${src} SET props = ? WHERE id = ?`, JSON.stringify(renamed), node.id);
    }
    if (rows.length < 500) break;
    after = (rows[rows.length - 1] as NodeRow).id;
  }
  const detached = sql
    .exec<{ root: string; why: string }>(
      `SELECT root, why FROM ${t.done} WHERE status = 'detached' ORDER BY root`,
    )
    .toArray();
  return { removed, records, detached };
}

/** A copy layer's derived id, from an applied conversion's map (comment pins). */
export function renamedIn(
  sql: SqlStorage,
  t: ConvertTables,
  ids: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 90) {
    const batch = ids.slice(i, i + 90);
    for (const row of sql
      .exec<{ old: string; new: string }>(
        `SELECT old, new FROM ${t.map} WHERE old IN (${batch.map(() => "?").join(", ")})`,
        ...batch,
      )
      .toArray())
      out.set(row.old, row.new);
  }
  return out;
}

/**
 * Converts a node table nobody edits (a snapshot read back: a version, a
 * branch's base, another file's nodes) in place, all of it now, and
 * numbers its levels again. Returns what changed.
 */
export function compactTable(room: RoomSql, table: string): Applied {
  const id = tempTable("cv").slice(4);
  const t: ConvertTables = {
    map: `tmp_cvmap_${id}`,
    rows: `tmp_cvrows_${id}`,
    done: `tmp_cvdone_${id}`,
    deps: `tmp_cvdeps_${id}`,
    roots: `tmp_cvroots_${id}`,
  };
  try {
    createConvertTables(room.sql, t);
    for (;;) {
      const step = convertStep(room, table, t, Number.POSITIVE_INFINITY);
      if (step.left === 0) break;
    }
    const applied = room.transact(() => applyConversion(room.sql, table, t));
    fillDepths(room.sql, table, Number.POSITIVE_INFINITY);
    return applied;
  } finally {
    dropConvertTables(room.sql, t);
  }
}

/** A fresh node table holding `nodes` (tests). */
export function tableOf(sql: SqlStorage, name: string, nodes: readonly NodeRecord[]): void {
  createNodeTable(sql, name);
  for (const node of nodes) {
    const r = toRow(node);
    sql.exec(
      `INSERT INTO ${name} (${NODE_COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
      r.id,
      r.parent,
      r.key,
      r.type,
      r.props,
    );
  }
}
