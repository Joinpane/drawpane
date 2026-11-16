/**
 * Converting a room's file to compact copies (decision 0029, phase 4b), an
 * instance at a time, without holding the file and without stopping it
 * from being used.
 *
 * The file stays as it is (materialized, `nodes`) while it converts. What
 * the conversion decides goes into tables beside it, an instance at a time,
 * a batch of instances to a storage transaction, so a conversion cut short
 * (the room evicted, a deploy) resumes where it was:
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
 * a main it's in. Their rows are dropped and they're converted again. An
 * instance deleted (or unlinked) before its turn is settled as gone. When a
 * fresh listing of the file's instances finds every one settled
 * (`StepResult.done`), `applyConversion` replaces what changed in one
 * storage transaction, after listing them once more in it and refusing if
 * any instance of a live main would still store layers: nobody sees the
 * file half converted.
 *
 * A step is bounded by the work it does (rows read and written), not by
 * the clock: on Cloudflare, `Date.now()` doesn't move while code runs
 * without I/O. An instance is held whole while it converts, so one larger
 * than `MAX_INSTANCE_LAYERS`, `MAX_INSTANCE_BUILT` or `MAX_INSTANCE_BYTES`,
 * counted in SQL before any of it is read, stops the conversion (the file
 * stays materialized and working) rather than run out of memory.
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
  type InstanceSize,
  ModelError,
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

/**
 * About how much work a step of a room's conversion does: rows read and
 * written. About a second and a half in Node for kit-shaped files (the
 * memory check), whatever the clock says.
 */
export const CONVERT_STEP_WORK = 60_000;

/** The most layers an instance may have to convert: it's held whole (and built) while it does. */
export const MAX_INSTANCE_LAYERS = 5_000;

/**
 * The most layers building an instance may create to convert it: what its
 * main presents, nested instances counted as built (an instance of a main
 * of a hundred layers counts a hundred, however few it stores), plus what
 * any main it's swapped to presents. Counted in SQL before any of it is
 * read. Building it holds every one, and a mismatch is found only once it's
 * built: an empty instance of a main of 200,000 empty rectangles ran a
 * 128 MB heap out, where no catch runs to mark the conversion failed.
 */
export const MAX_INSTANCE_BUILT = 10_000;

/**
 * What each node read and each layer built is charged in
 * `MAX_INSTANCE_BYTES`, on top of its values: a layer of empty values costs
 * two bytes stored but several hundred in the heap (its record, its copy's
 * slot, path and cached node, and their entries in the view's maps). The
 * memory check measured about 700 bytes a layer near a 64 MB heap's limit;
 * the bound below leaves room for that.
 */
export const LAYER_BYTES = 256;

/**
 * The most an instance may cost to convert: the bytes of values (UTF-8, as
 * SQLite stores them) of its own layers and those of every main it's built
 * from (its main, the mains of instances inside it, theirs, with their
 * layers), plus `LAYER_BYTES` for every node read and every layer built,
 * worked out in SQL before any of it is read. One larger stops the
 * conversion (the file stays materialized and working): it would be held
 * whole, and built, in a Durable Object's 128 MB. The memory check
 * (test-node/convert-memory.test.ts) converts instances at this size, wide
 * and deep, within a 64 MB heap.
 */
export const MAX_INSTANCE_BYTES = 8 * 1024 * 1024;

/**
 * About how many bytes of values a step reads (at least one instance a
 * step): with `CONVERT_STEP_WORK`, what bounds what a step holds, however
 * large the file's layers are.
 */
export const CONVERT_STEP_BYTES = 8 * 1024 * 1024;

/** The bounds on one instance that conversion (and the room's check of a removed main) holds. */
export const INSTANCE_LIMITS = {
  maxInstanceLayers: MAX_INSTANCE_LAYERS,
  maxInstanceBuilt: MAX_INSTANCE_BUILT,
  maxInstanceBytes: MAX_INSTANCE_BYTES,
  layerBytes: LAYER_BYTES,
} as const;

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
 * How many layers a node presents under it, worked out in SQL without
 * building any: a stored layer counts one, and an instance counts what its
 * main presents (and, for a copy swapped to another main, what that main
 * presents too: an upper bound, for limits, not exact bookkeeping). Keeps
 * what it worked out per node; make one per read of the file.
 */
export class PresentedCounter {
  readonly #sql: SqlStorage;
  readonly #src: string;
  readonly #memo = new Map<string, number>();
  /** Queries run, and rows they went through, about: what it cost. */
  queries = 0;

  constructor(sql: SqlStorage, src = "nodes") {
    this.#sql = sql;
    this.#src = src;
  }

  /** The main a live instance node follows, or null when it follows none. */
  mainOf(id: string): string | null {
    const src = this.#src;
    this.queries++;
    return (
      this.#sql
        .exec<{ of: string }>(
          `SELECT json_extract(n.props, '$.instanceOf') AS of FROM ${src} n WHERE n.id = ? AND ${liveSql(src, "n")}`,
          id,
        )
        .toArray()[0]?.of ?? null
    );
  }

  /** The mains the override records under `id` swap their copies to, with how many swap to each. */
  #swapsUnder(id: string): Array<{ of: string; n: number }> {
    this.queries++;
    return this.#sql
      .exec<{ of: string; n: number }>(
        `SELECT json_extract(props, '$.instanceOf') AS of, COUNT(*) AS n FROM ${this.#src}
          WHERE parent = ? AND type = 'override' AND json_extract(props, '$.instanceOf') IS NOT NULL
          GROUP BY of`,
        id,
      )
      .toArray();
  }

  /** The layers `id` presents under it (itself not counted). */
  under(id: string, guard: Set<string> = new Set()): number {
    const known = this.#memo.get(id);
    if (known !== undefined) return known;
    // A main that (through its copies) contains its own instance: built without layers.
    if (guard.has(id)) return 0;
    guard.add(id);
    const src = this.#src;
    let n = 0;
    const main = this.mainOf(id);
    if (main !== null) {
      // An instance presents its main's layers, built (whatever it stores).
      n = this.under(main, guard);
      for (const swap of this.#swapsUnder(id)) n += swap.n * this.under(swap.of, guard);
    } else {
      const walk = `WITH RECURSIVE sub(id, live) AS (
          SELECT n.id, ${liveSql(src, "n")} FROM ${src} n WHERE n.parent = ? AND n.type != 'override'
          UNION ALL
          SELECT n.id, ${liveSql(src, "n")} FROM ${src} n JOIN sub ON n.parent = sub.id
           WHERE sub.live = 0 AND n.type != 'override'
        )`;
      n = this.#sql.exec<{ n: number }>(`${walk} SELECT COUNT(*) AS n FROM sub`, id).one().n;
      this.queries += 3 + Math.ceil(n / 4);
      for (const row of this.#sql
        .exec<{ of: string; n: number }>(
          `${walk} SELECT json_extract(s.props, '$.instanceOf') AS of, COUNT(*) AS n
             FROM sub CROSS JOIN ${src} s ON s.id = sub.id WHERE sub.live = 1 GROUP BY of`,
          id,
        )
        .toArray())
        n += row.n * this.under(row.of, guard);
      // Copies inside those instances swapped to other mains present those mains' layers too.
      for (const row of this.#sql
        .exec<{ of: string; n: number }>(
          `${walk} SELECT json_extract(r.props, '$.instanceOf') AS of, COUNT(*) AS n
             FROM sub CROSS JOIN ${src} r ON r.parent = sub.id
            WHERE sub.live = 1 AND r.type = 'override'
              AND json_extract(r.props, '$.instanceOf') IS NOT NULL
            GROUP BY of`,
          id,
        )
        .toArray())
        n += row.n * this.under(row.of, guard);
    }
    guard.delete(id);
    this.#memo.set(id, n);
    return n;
  }

  /**
   * What building `rootId` (an instance, or a frame whose main is gone)
   * holds, counted before any of it is read (see `InstanceSize`).
   */
  sizeOf(rootId: string): InstanceSize {
    const src = this.#src;
    // Its stored nodes, and the mains any of them names (a nested instance, a swapped copy).
    const own = this.#sql
      .exec<{ n: number; mains: string }>(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM ${src} WHERE parent = ?
           UNION ALL SELECT n.id FROM ${src} n JOIN sub ON n.parent = sub.id
         ) SELECT COUNT(*) AS n,
                  json_group_array(DISTINCT json_extract(s.props, '$.instanceOf')) AS mains
             FROM sub CROSS JOIN ${src} s ON s.id = sub.id`,
        rootId,
      )
      .one();
    // Everything building it reads: its layers, the main of any instance among them (its own
    // root first) or of any copy swapped, and each main's layers, and so on; each node once.
    const reach = this.#sql
      .exec<{ n: number; bytes: number | null }>(
        `WITH RECURSIVE reach(id) AS (
           SELECT ?
           UNION SELECT n.id FROM ${src} n JOIN reach r ON n.parent = r.id
           UNION SELECT json_extract(f.props, '$.instanceOf') FROM ${src} f JOIN reach r ON f.id = r.id
                  WHERE f.type IN ('frame', 'override') AND json_extract(f.props, '$.instanceOf') IS NOT NULL
         ) SELECT COUNT(*) AS n, SUM(LENGTH(CAST(s.props AS BLOB))) AS bytes
             FROM reach JOIN ${src} s ON s.id = reach.id`,
        rootId,
      )
      .one();
    this.queries += 2 + Math.ceil((own.n + reach.n) / 4);
    let built = this.under(rootId);
    const main = this.mainOf(rootId);
    // Its layers' mains, built over what they copy: counted again (an upper bound).
    for (const of of JSON.parse(own.mains) as Array<string | null>)
      if (of && of !== main && of !== rootId) built += this.under(of);
    return { layers: own.n, built, reached: reach.n, bytes: reach.bytes ?? 0 };
  }
}

/**
 * How many layers a file stored with compact copies presents (copy layers
 * counted as built), worked out in SQL without building any: each instance
 * presents what its main does. A swapped nested instance counts its
 * source's and its swapped-in main's (an upper bound). For limits (the
 * agent tools'), not exact bookkeeping.
 */
export function presentedCount(sql: SqlStorage, src = "nodes"): number {
  const stored = sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${src} WHERE type != 'override'`)
    .one().n;
  const counter = new PresentedCounter(sql, src);
  let total = stored;
  for (const row of sql
    .exec<{ of: string; n: number }>(
      `SELECT json_extract(n.props, '$.instanceOf') AS of, COUNT(*) AS n FROM ${src} n
        WHERE ${liveSql(src, "n")} GROUP BY of
       UNION ALL
       SELECT json_extract(props, '$.instanceOf') AS of, COUNT(*) AS n FROM ${src}
        WHERE type = 'override' AND json_extract(props, '$.instanceOf') IS NOT NULL GROUP BY of`,
    )
    .toArray())
    total += row.n * counter.under(row.of);
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
  #counter: PresentedCounter | null = null;
  convertedCount = 0;
  detachedCount = 0;
  /** Rows read and written so far: what bounds a step. */
  work = 0;
  /** Bytes of values read so far: what bounds a step too. */
  bytes = 0;

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
    // Written by the conversion, else stored and not a copy layer it renamed.
    const row = this.#sql
      .exec<NodeRow>(
        `SELECT ${NODE_COLUMNS} FROM ${t.rows} WHERE id = ?1
         UNION ALL
         SELECT ${NODE_COLUMNS} FROM ${this.#src} s WHERE id = ?1
           AND NOT EXISTS (SELECT 1 FROM ${t.map} m WHERE m.old = ?1)
           AND NOT EXISTS (SELECT 1 FROM ${t.rows} r WHERE r.id = ?1)
         LIMIT 1`,
        id,
      )
      .toArray()[0];
    this.work++;
    if (row) this.bytes += row.props.length;
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
    this.work += 1 + ids.length;
    this.#kids.set(parent, ids);
    return ids;
  }

  sizeOf(rootId: string): InstanceSize {
    // Counted afresh each step: edits between steps change what mains present.
    this.#counter ??= new PresentedCounter(this.#sql, this.#src);
    const before = this.#counter.queries;
    const size = this.#counter.sizeOf(rootId);
    this.work += this.#counter.queries - before;
    return size;
  }

  layersUnder(rootId: string): readonly NodeRecord[] {
    const layers = this.#sql
      .exec<NodeRow>(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM ${this.#src} WHERE parent = ?
           UNION ALL SELECT n.id FROM ${this.#src} n JOIN sub ON n.parent = sub.id
         ) SELECT ${NODE_COLUMNS} FROM ${this.#src} WHERE id IN (SELECT id FROM sub)`,
        rootId,
      )
      .toArray()
      .map((row) => {
        this.bytes += row.props.length;
        return toRecord(row);
      });
    this.work += 1 + layers.length;
    return layers;
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
    this.work += 1 + ids.length;
    this.#inside.set(mainId, ids);
    return ids;
  }

  settled(rootId: string): boolean {
    const cached = this.#settled.get(rootId);
    if (cached !== undefined) return cached;
    const done =
      this.#sql.exec(`SELECT 1 FROM ${this.#t.done} WHERE root = ?`, rootId).toArray().length > 0;
    this.work++;
    this.#settled.set(rootId, done);
    return done;
  }

  converted({ root, records, ids, deps }: ConvertedInstance): void {
    const t = this.#t;
    {
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
    }
    this.#nodes.set(root.id, root);
    for (const record of records) this.#nodes.set(record.id, record);
    for (const [from, to] of ids) {
      this.#renames.set(from, to);
      // Its old row is hidden now, unless its id is its derived one (a record, or nothing).
      if (from !== to) this.#nodes.set(from, null);
      else this.#nodes.delete(from);
      this.#nodes.delete(to);
    }
    // Child lists that changed: the instance's own (records in, layers out), and its layers'.
    this.#kids.delete(root.id);
    for (const from of ids.keys()) this.#kids.delete(from);
    this.#settled.set(root.id, true);
    this.convertedCount++;
    this.work += 1 + records.length + ids.size;
  }

  detached({ root, layers, why, deps }: DetachedInstance): void {
    this.#putRows([root, ...layers], root.id);
    this.#settle(root.id, "detached", why, deps);
    this.#nodes.set(root.id, root);
    for (const layer of layers) this.#nodes.set(layer.id, layer);
    this.#settled.set(root.id, true);
    this.detachedCount++;
    this.work += 1 + layers.length;
    console.warn(`compact copies: instance ${root.id} left detached: ${why}`);
  }

  /** Instances settled in this run, converted or detached. */
  get settledCount(): number {
    return this.convertedCount + this.detachedCount;
  }

  /**
   * A listed root that's no longer an instance to convert (deleted, unlinked,
   * its main gone): settled as gone. Made again (an undo), its edit marks it
   * to convert again, and a fresh listing lists it.
   */
  gone(rootId: string): void {
    this.#settle(rootId, "gone", null, []);
    this.#settled.set(rootId, true);
    this.work++;
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
  /** Listed top-level instances not settled yet. */
  readonly left: number;
  /**
   * Whether the conversion can be applied: this step listed the file's
   * instances afresh and every one is settled. (`left` is 0 also when the
   * budget ran out right after the last listed one: an instance made since
   * isn't listed yet.)
   */
  readonly done: boolean;
}

/**
 * Converts instances until about `budget` rows have been read and written
 * (at least one instance a step, each batch in its own storage
 * transaction), then says what's left. When nothing listed is left, the
 * file's instances are listed afresh (edits may have made new ones); only a
 * step that did so and found nothing is `done`.
 */
export function convertStep(
  room: RoomSql,
  src: string,
  t: ConvertTables,
  budget: number = CONVERT_STEP_WORK,
  {
    maxInstanceLayers = MAX_INSTANCE_LAYERS,
    maxInstanceBuilt = MAX_INSTANCE_BUILT,
    maxInstanceBytes = MAX_INSTANCE_BYTES,
    layerBytes = LAYER_BYTES,
    stepBytes = CONVERT_STEP_BYTES,
  }: {
    readonly maxInstanceLayers?: number;
    readonly maxInstanceBuilt?: number;
    readonly maxInstanceBytes?: number;
    readonly layerBytes?: number;
    readonly stepBytes?: number;
  } = {},
): StepResult {
  const sql = room.sql;
  createConvertTables(sql, t);
  if (sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t.roots}`).one().n === 0)
    listRoots(sql, src, t);
  const conversion = new SqlConversion(room, src, t);
  const converter = new InstanceConverter(conversion, conversion, {
    maxInstanceLayers,
    maxInstanceBuilt,
    maxInstanceBytes,
    layerBytes,
    // At least one instance a step; then none that would take it past its budget, in rows or
    // in bytes.
    stop: (size) =>
      conversion.settledCount > 0 &&
      (conversion.work + size.layers > budget || conversion.bytes + size.bytes > stepBytes),
  });
  const pending = () =>
    sql
      .exec<{ id: string }>(
        `SELECT id FROM ${t.roots} r WHERE NOT EXISTS (SELECT 1 FROM ${t.done} d WHERE d.root = r.id)
          ORDER BY seq LIMIT 200`,
      )
      .toArray()
      .map((row) => row.id);
  let relisted = false;
  let stopped = false;
  for (;;) {
    let batch = pending();
    if (batch.length === 0) {
      if (relisted) break;
      listRoots(sql, src, t);
      relisted = true;
      batch = pending();
      if (batch.length === 0) break;
    }
    // A batch's decisions are kept together: one cut short is converted again.
    room.transact(() => {
      for (const id of batch) {
        converter.settle(id);
        if (converter.stopped) {
          stopped = true;
          return;
        }
        // Deleted, unlinked or put inside another instance since it was listed.
        if (!conversion.settled(id)) conversion.gone(id);
        if (converter.cached > 200_000) converter.clear();
        if (
          (conversion.work > budget || conversion.bytes > stepBytes) &&
          conversion.settledCount > 0
        ) {
          stopped = true;
          return;
        }
      }
    });
    if (stopped) break;
  }
  const left = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${t.roots} r WHERE NOT EXISTS (SELECT 1 FROM ${t.done} d WHERE d.root = r.id)`,
    )
    .one().n;
  return {
    converted: conversion.convertedCount,
    detached: conversion.detachedCount,
    left,
    done: relisted && !stopped && left === 0,
  };
}

/**
 * Lists the file's instances afresh and says whether every one is settled:
 * what applying waits for. Call in the storage transaction that applies,
 * so nothing made since the last step is left materialized.
 */
export function readyToApply(sql: SqlStorage, src: string, t: ConvertTables): boolean {
  listRoots(sql, src, t);
  return (
    sql
      .exec(
        `SELECT 1 FROM ${t.roots} r WHERE NOT EXISTS (SELECT 1 FROM ${t.done} d WHERE d.root = r.id) LIMIT 1`,
      )
      .toArray().length === 0
  );
}

/**
 * An instance root of a live main that still stores layers in `src`, or
 * null: what a file stored compact must never have (its layers come from
 * its main), checked after a conversion is applied and of what an import
 * brings.
 */
export function strayInstance(sql: SqlStorage, src: string): string | null {
  return (
    sql
      .exec<{ id: string }>(
        `SELECT r.id FROM ${src} r
          WHERE ${liveSql(src, "r")}
            AND EXISTS (SELECT 1 FROM ${src} c WHERE c.parent = r.id AND c.type != 'override')
          LIMIT 1`,
      )
      .toArray()[0]?.id ?? null
  );
}

/** Applying would leave an instance materialized: refused (and rolled back), to try again. */
export class NotAllConverted extends Error {
  constructor(readonly rootId: string) {
    super(`instance ${rootId} would still store its layers`);
  }
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
  // Ids held anywhere (a reading order, a prototype link, a flow), override records and what the
  // conversion wrote included: an instance can name another's copies, converted after it, whose
  // ids weren't known yet. Renaming twice changes nothing (no derived id is an old one).
  let after = "";
  for (;;) {
    const rows = sql
      .exec<NodeRow>(
        `SELECT ${NODE_COLUMNS} FROM ${src}
          WHERE id > ?
            AND (props LIKE '%"readingOrder"%' OR props LIKE '%"reactions"%' OR props LIKE '%"flows"%')
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
  // Nothing may be left materialized: an instance no step converted (one made meanwhile, say).
  const stray = strayInstance(sql, src);
  if (stray !== null) throw new NotAllConverted(stray);
  const detached = sql
    .exec<{ root: string; why: string }>(
      `SELECT root, why FROM ${t.done} WHERE status = 'detached' ORDER BY root`,
    )
    .toArray();
  return { removed, records, detached };
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
    // In steps, as a room converts, so what's held stays bounded; all of them now.
    for (;;) {
      const step = convertStep(room, table, t);
      if (step.done) break;
    }
    let applied: Applied;
    try {
      applied = room.transact(() => applyConversion(room.sql, table, t));
    } catch (error) {
      if (error instanceof NotAllConverted)
        throw new ModelError(
          "invalid_value",
          `Its component copies couldn't be converted: ${error.message}.`,
        );
      throw error;
    }
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
