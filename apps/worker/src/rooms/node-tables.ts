/**
 * Tables of nodes in a room's SQLite besides its own `nodes`: a copy of the
 * file frozen at one revision (to write a version from while editing goes
 * on), a version read back from R2 (to restore), another file's nodes (a
 * branch or its main, to merge), an import arriving in parts. Each has the
 * columns of `nodes`, so rows move between them in SQL without passing
 * through JavaScript, and the room never holds a whole file in memory.
 *
 * Nothing here imports `cloudflare:workers`: the memory check
 * (`test-node/`) runs the same code in Node against node:sqlite.
 */
import {
  CHILD_TYPES,
  type DocReader,
  MAX_DEPTH,
  type NodeRecord,
  type NodeType,
  type Props,
  ROOT_ID,
  utf8Length,
} from "@drawpane/model";

/** A room's SQLite, and how it runs a storage transaction. */
export interface RoomSql {
  readonly sql: SqlStorage;
  transact<T>(fn: () => T): T;
}

export interface NodeRow extends Record<string, SqlStorageValue> {
  id: string;
  parent: string;
  key: string;
  type: string;
  props: string;
}

export const NODE_COLUMNS = "id, parent, key, type, props";

/** Rows read at a time when a table is paged through. */
export const PAGE_ROWS = 1_000;
/** At most about this many characters of properties in a page (see `tablePages`). */
export const PAGE_CHARS = 4 << 20;

/** Bound parameters SQLite takes in one statement here (Durable Objects allow 100). */
const MAX_PARAMS = 100;

/** Transient tables start with this, so a room can drop any a crash left behind. */
export const TEMP_PREFIX = "tmp_";

const NAME = /^[a-z][a-z0-9_]{0,62}$/;

export function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error(`bad table name ${name}`);
  return name;
}

/** A fresh name for a transient table. */
export function tempTable(what: string): string {
  return checkName(`${TEMP_PREFIX}${what}_${Date.now().toString(36)}_${randomSuffix()}`);
}

function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Makes an empty node table: `depth` (the level below the root, pages at 1,
 * filled by `fillDepths`) and indexes for walking it by parent and by level.
 */
export function createNodeTable(sql: SqlStorage, name: string): void {
  const t = checkName(name);
  sql.exec(`DROP TABLE IF EXISTS ${t}`);
  sql.exec(`CREATE TABLE ${t} (
    id TEXT PRIMARY KEY,
    parent TEXT NOT NULL,
    key TEXT NOT NULL,
    type TEXT NOT NULL,
    props TEXT NOT NULL,
    depth INTEGER
  ) STRICT`);
  sql.exec(`CREATE INDEX ${t}_parent ON ${t} (parent, key, id)`);
  sql.exec(`CREATE INDEX ${t}_depth ON ${t} (depth, id)`);
}

export function dropTable(sql: SqlStorage, name: string): void {
  sql.exec(`DROP TABLE IF EXISTS ${checkName(name)}`);
}

/** Transient tables left in this SQLite (by a crash, or an abandoned stream). */
export function tempTables(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, ?) = ?",
      TEMP_PREFIX.length,
      TEMP_PREFIX,
    )
    .toArray()
    .map((row) => row.name);
}

/** How long ago a transient table was made, from its name; 0 when it can't be told. */
export function tempTableAge(name: string, now = Date.now()): number {
  const made = Number.parseInt(name.split("_").at(-2) ?? "", 36);
  return Number.isFinite(made) ? now - made : 0;
}

/** Copies every node of `from` into `to` (made empty first), in SQL. */
export function copyNodes(sql: SqlStorage, from: string, to: string): void {
  createNodeTable(sql, to);
  sql.exec(
    `INSERT INTO ${checkName(to)} (${NODE_COLUMNS}) SELECT ${NODE_COLUMNS} FROM ${checkName(from)}`,
  );
}

export function countRows(sql: SqlStorage, table: string): number {
  return sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${checkName(table)}`).one().n;
}

/** Inserts nodes, a statement per 20 rows; throws on an id already there. */
export function insertNodes(sql: SqlStorage, table: string, nodes: readonly NodeRecord[]): void {
  insertRows(sql, table, nodes.map(toRow));
}

/** A node as a row: its props as the JSON text stored. */
export function toRow(node: NodeRecord): NodeRow {
  return {
    id: node.id,
    parent: node.parent,
    key: node.key,
    type: node.type,
    props: JSON.stringify(node.props),
  };
}

/** Inserts rows, a statement per 20; throws on an id already there. */
export function insertRows(sql: SqlStorage, table: string, rows: readonly NodeRow[]): void {
  const t = checkName(table);
  const per = Math.floor(MAX_PARAMS / 5);
  for (let i = 0; i < rows.length; i += per) {
    const batch = rows.slice(i, i + per);
    const params: SqlStorageValue[] = [];
    for (const n of batch) params.push(n.id, n.parent, n.key, n.type, n.props);
    sql.exec(
      `INSERT INTO ${t} (${NODE_COLUMNS}) VALUES ${batch.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
      ...params,
    );
  }
}

export function toRecord(row: NodeRow): NodeRecord {
  return {
    id: row.id,
    parent: row.parent,
    key: row.key,
    type: row.type as NodeType,
    props: JSON.parse(row.props) as Props,
  };
}

/** A row as one line of a snapshot: the node's JSON, built without parsing its props. */
export function rowLine(row: NodeRow): string {
  return `{"id":${JSON.stringify(row.id)},"parent":${JSON.stringify(row.parent)},"key":${JSON.stringify(row.key)},"type":${JSON.stringify(row.type)},"props":${row.props}}`;
}

/**
 * How many bytes a row's line (`rowLine`) takes as UTF-8, counted from its
 * parts without building the line.
 */
export function rowLineBytes(row: NodeRow): number {
  // {"id":,"parent":,"key":,"type":,"props":} around the five values.
  const frame = 41;
  return (
    frame +
    utf8Length(JSON.stringify(row.id)) +
    utf8Length(JSON.stringify(row.parent)) +
    utf8Length(JSON.stringify(row.key)) +
    utf8Length(JSON.stringify(row.type)) +
    utf8Length(row.props)
  );
}

/**
 * Pages of an ordered query whose rows may be large, each at most `size`
 * rows and about `chars` characters (at least one row), as `tablePages`
 * bounds a page of one table: `sizes(after, size)` gives the keys and sizes
 * (in characters, measured in SQL) of the next rows after `after`, and
 * `rows(after, last)` reads those after `after` up to and including `last`.
 * So a page of rows joined with other tables' values (a restore's, a
 * merge's) stays small when its layers are large.
 */
export function* boundedPages<K, R>(
  start: K,
  sizes: (after: K, size: number) => ReadonlyArray<{ readonly key: K; readonly n: number }>,
  rows: (after: K, last: K) => R[],
  size = PAGE_ROWS,
  chars = PAGE_CHARS,
): Generator<R[]> {
  let after = start;
  for (;;) {
    const next = sizes(after, size);
    if (next.length === 0) return;
    let take = 0;
    let held = 0;
    while (take < next.length && (take === 0 || held + (next[take] as { n: number }).n <= chars))
      held += (next[take++] as { n: number }).n;
    const last = (next[take - 1] as { key: K }).key;
    yield rows(after, last);
    after = last;
    if (take === next.length && next.length < size) return;
  }
}

/** Rows a `sumPast` page sums at a time. */
const SUM_PAGE_ROWS = 2_000;

/**
 * `SUM(expr)` over a table's rows (`expr` of its columns, never negative),
 * read in pages in id order that stop once past `limit`: the exact sum
 * when it's at most `limit`, otherwise some sum past it. So asking whether
 * a large file fits a bound reads about as many rows as fit in it, not the
 * whole table.
 */
export function sumPast(sql: SqlStorage, table: string, expr: string, limit: number): number {
  const t = checkName(table);
  let total = 0;
  let after = "";
  for (;;) {
    const page = sql
      .exec<{ rows: number; total: number; last: string | null }>(
        `SELECT COUNT(*) AS rows, COALESCE(SUM(v), 0) AS total, MAX(id) AS last
           FROM (SELECT id, ${expr} AS v FROM ${t} WHERE id > ? ORDER BY id LIMIT ?)`,
        after,
        SUM_PAGE_ROWS,
      )
      .one();
    total += page.total;
    if (total > limit || page.rows < SUM_PAGE_ROWS || page.last === null) return total;
    after = page.last;
  }
}

/** Every row of a table, PAGE_ROWS at a time in id order. Each page is read when asked for. */
export function* tablePages(
  sql: SqlStorage,
  table: string,
  size = PAGE_ROWS,
  chars = PAGE_CHARS,
): Generator<NodeRow[]> {
  const t = checkName(table);
  let after = "";
  for (;;) {
    // How many of the next rows fit in `chars` of properties, measured in SQL (their lengths, not
    // their properties), so a page of large layers ends early (a text layer may hold 200,000
    // characters). Every cursor is read to its end: one left open keeps its table locked.
    const sizes = sql
      .exec<{ id: string; n: number }>(
        `SELECT id, LENGTH(props) AS n FROM ${t} WHERE id > ? ORDER BY id LIMIT ?`,
        after,
        size,
      )
      .toArray();
    if (sizes.length === 0) return;
    let take = 0;
    let held = 0;
    while (take < sizes.length && (take === 0 || held + (sizes[take] as { n: number }).n <= chars))
      held += (sizes[take++] as { n: number }).n;
    const last = (sizes[take - 1] as { id: string }).id;
    const rows = sql
      .exec<NodeRow>(
        `SELECT ${NODE_COLUMNS} FROM ${t} WHERE id > ? AND id <= ? ORDER BY id`,
        after,
        last,
      )
      .toArray();
    yield rows;
    after = last;
    if (take === sizes.length && sizes.length < size) return;
  }
}

/**
 * Sets each node's `depth`, level by level from the root (pages are 1), in
 * SQL, as far as `maxDepth` (MAX_DEPTH unless given; `Infinity` numbers
 * every level there is). Nodes left without one aren't under the root:
 * inside themselves, under a parent that isn't there, or too deep. Returns
 * how many got one, and whether some were too deep.
 */
export function fillDepths(
  sql: SqlStorage,
  table: string,
  maxDepth = MAX_DEPTH,
): { placed: number; tooDeep: boolean } {
  const t = checkName(table);
  sql.exec(`UPDATE ${t} SET depth = NULL WHERE depth IS NOT NULL`);
  sql.exec(`UPDATE ${t} SET depth = 1 WHERE parent = ?`, ROOT_ID);
  let deepest = 1;
  // rowsWritten counts index entries too: it says whether a level had any, not how many.
  for (let depth = 1; depth < maxDepth; depth++) {
    const written = sql.exec(
      `UPDATE ${t} SET depth = ? WHERE depth IS NULL AND parent IN (SELECT id FROM ${t} WHERE depth = ?)`,
      depth + 1,
      depth,
    ).rowsWritten;
    if (written === 0) break;
    deepest = depth + 1;
  }
  const placed = sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE depth IS NOT NULL`)
    .one().n;
  const deeper =
    deepest >= maxDepth &&
    sql
      .exec(
        `SELECT 1 FROM ${t} WHERE depth IS NULL AND parent IN (SELECT id FROM ${t} WHERE depth = ?) LIMIT 1`,
        deepest,
      )
      .toArray().length > 0;
  return { placed, tooDeep: deeper };
}

/** Which kinds of node each kind may hold, as a SQL table expression to join against. */
export function allowedChildrenSql(): string {
  const pairs: string[] = [];
  for (const [parent, children] of Object.entries(CHILD_TYPES))
    for (const child of children) pairs.push(`('${parent}', '${child}')`);
  return `allowed (parent, child) AS (VALUES ${pairs.join(", ")})`;
}

/**
 * A `DocReader` over a node table, for code that walks a document (a
 * library's manifest, the MCP tools): it reads rows as they're asked for and
 * keeps at most `limit` of them (and `budget` bytes of their properties'
 * JSON as V8 holds it: a byte a character, two past Latin-1), so a walk over
 * a large file stays small.
 *
 * Children are read a page at a time (`children`, `childNodes`), and what a
 * page keeps while the walk is elsewhere is its ids, not its rows: a
 * depth-first walk suspends one page per level on the way down, and a page
 * of rows at every level of a deep file with wide levels is most of the
 * file. Each node's properties are read when it's visited (a page's rows
 * are kept in the reader's bounded cache as they're read, so a visit
 * usually finds its node there). `childIds` reads ids only, for the few
 * callers that want a list.
 */
export class TableReader implements DocReader {
  readonly #sql: SqlStorage;
  readonly #table: string;
  readonly #limit: number;
  readonly #budget: number;
  readonly #nodes = new Map<string, { node: NodeRecord | null; size: number }>();
  #held = 0;

  constructor(sql: SqlStorage, table: string, limit = 10_000, budget = 8 * 1024 * 1024) {
    this.#sql = sql;
    this.#table = checkName(table);
    this.#limit = limit;
    this.#budget = budget;
  }

  get(id: string): NodeRecord | undefined {
    const cached = this.#nodes.get(id);
    if (cached !== undefined) return cached.node ?? undefined;
    const row = this.#sql
      .exec<NodeRow>(`SELECT ${NODE_COLUMNS} FROM ${this.#table} WHERE id = ?`, id)
      .toArray()[0];
    if (!row) {
      this.#remember(id, null, 0);
      return undefined;
    }
    return this.#keep(row);
  }

  /** Every child id of `parent`, in order, without their properties. */
  childIds(parent: string): readonly string[] {
    if (this.#holdsNothing(parent)) return [];
    return this.#sql
      .exec<{ id: string }>(
        `SELECT id FROM ${this.#table} WHERE parent = ? ORDER BY key, id`,
        parent,
      )
      .toArray()
      .map((row) => row.id);
  }

  /** How many children `parent` has. */
  childCount(parent: string): number {
    if (this.#holdsNothing(parent)) return 0;
    return this.#sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.#table} WHERE parent = ?`, parent)
      .one().n;
  }

  /** `parent`'s children in order, each read (or found in the cache) as it's reached. */
  *childNodes(parent: string, size = PAGE_ROWS): Generator<NodeRecord> {
    for (const id of this.children(parent, size)) {
      const node = this.get(id);
      // One deleted since its page was read is passed over.
      if (node) yield node;
    }
  }

  /**
   * `parent`'s child ids in order, a page at a time as they're asked for.
   * Between pages it holds the page's ids and where the next one starts,
   * never its rows: those go to the bounded cache as they're read.
   */
  *children(parent: string, size = PAGE_ROWS): Generator<string> {
    if (this.#holdsNothing(parent)) return;
    let after: readonly [string, string] | null = null;
    for (;;) {
      const page = this.#childPage(parent, after, size);
      yield* page.ids;
      if (page.ids.length < size || !page.last) return;
      after = page.last;
    }
  }

  /**
   * A page of `parent`'s children after `after` (a key and id): their ids,
   * and the last one's key and id, where the next page starts. Their rows
   * go to the cache, and the cursor is read to the end, so nothing of it
   * stays open while the walk goes elsewhere.
   */
  #childPage(
    parent: string,
    after: readonly [string, string] | null,
    size: number,
  ): { ids: string[]; last: readonly [string, string] | null } {
    const cursor = after
      ? this.#sql.exec<NodeRow>(
          `SELECT ${NODE_COLUMNS} FROM ${this.#table}
            WHERE parent = ? AND (key, id) > (?, ?)
            ORDER BY key, id LIMIT ?`,
          parent,
          after[0],
          after[1],
          size,
        )
      : this.#sql.exec<NodeRow>(
          `SELECT ${NODE_COLUMNS} FROM ${this.#table} WHERE parent = ? ORDER BY key, id LIMIT ?`,
          parent,
          size,
        );
    const ids: string[] = [];
    let last: readonly [string, string] | null = null;
    for (const row of cursor) {
      ids.push(row.id);
      last = [row.key, row.id];
      this.#keep(row);
    }
    return { ids, last };
  }

  /** Parses a row and keeps it in the cache; returns the node. */
  #keep(row: NodeRow): NodeRecord {
    const cached = this.#nodes.get(row.id);
    if (cached?.node) return cached.node;
    const node = toRecord(row);
    this.#remember(row.id, node, heldChars(row.props));
    return node;
  }

  /** Kinds that hold nothing are answered without asking. */
  #holdsNothing(parent: string): boolean {
    const node = parent === ROOT_ID ? null : this.#nodes.get(parent)?.node;
    return !!node && (CHILD_TYPES[node.type] ?? []).length === 0;
  }

  /**
   * Page ids in file order, read PAGE_ROWS at a time as they're asked for:
   * nothing limits how many pages a file has (a legal import may hold a
   * million), so they're never all read at once.
   */
  *pageIds(): Generator<string> {
    const t = this.#table;
    let after: { key: string; id: string } | null = null;
    for (;;) {
      const rows: Array<{ id: string; key: string }> = (
        after
          ? this.#sql.exec<{ id: string; key: string }>(
              `SELECT id, key FROM ${t} WHERE parent = ? AND type = 'page'
                 AND (key > ? OR (key = ? AND id > ?)) ORDER BY key, id LIMIT ?`,
              ROOT_ID,
              after.key,
              after.key,
              after.id,
              PAGE_ROWS,
            )
          : this.#sql.exec<{ id: string; key: string }>(
              `SELECT id, key FROM ${t} WHERE parent = ? AND type = 'page' ORDER BY key, id LIMIT ?`,
              ROOT_ID,
              PAGE_ROWS,
            )
      ).toArray();
      for (const row of rows) yield row.id;
      const last = rows[rows.length - 1];
      if (!last || rows.length < PAGE_ROWS) return;
      after = { key: last.key, id: last.id };
    }
  }

  /** How many pages the file has, counted in SQL. */
  pageCount(): number {
    return this.#sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${this.#table} WHERE parent = ? AND type = 'page'`,
        ROOT_ID,
      )
      .one().n;
  }

  /**
   * What the file offers as components, on its pages, in file order (see
   * `libraryAssets`): each main, or the set it's a variant of, found by
   * query rather than by walking every layer. They're counted in SQL first,
   * and past `max` read a page of ids at a time only until `max + 1` are
   * found on a page, so a file of 40,000 components is refused holding a
   * page of ids, never their rows (each may hold a long description).
   */
  componentAssets(max: number): string[] {
    const t = this.#table;
    const assets = `SELECT DISTINCT CASE
        WHEN p.type = 'frame' AND json_extract(p.props, '$.isComponentSet') = 1 THEN p.id
        ELSE m.id END AS id
      FROM ${t} m LEFT JOIN ${t} p ON p.id = m.parent
      WHERE m.type = 'frame' AND json_extract(m.props, '$.isComponent') = 1`;
    const placed: Array<{ id: string; path: string[] }> = [];
    /** Keeps those of `ids` on a page; true once past `max`. */
    const place = (ids: readonly string[]): boolean => {
      for (const id of ids) {
        const node = this.get(id);
        const path = node ? this.#pathOnPage(node) : null;
        if (!path) continue;
        placed.push({ id, path });
        if (placed.length > max) return true;
      }
      return false;
    };
    const count = this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM (${assets})`).one().n;
    if (count <= max) {
      place(
        this.#sql
          .exec<{ id: string }>(assets)
          .toArray()
          .map((row) => row.id),
      );
    } else {
      // More than may be offered, unless some aren't on a page: found a page at a time.
      let after = "";
      for (;;) {
        const ids = this.#sql
          .exec<{ id: string }>(
            `SELECT id FROM (${assets}) WHERE id > ? ORDER BY id LIMIT ?`,
            after,
            PAGE_ROWS,
          )
          .toArray()
          .map((row) => row.id);
        if (place(ids)) return placed.map((p) => p.id);
        if (ids.length < PAGE_ROWS) break;
        after = ids[ids.length - 1] as string;
      }
    }
    placed.sort((a, b) => comparePaths(a.path, b.path));
    return placed.map((p) => p.id);
  }

  /**
   * Where a node sits from its page down, as sortable steps; null when it
   * isn't on a page. Walked up as far as it goes (a file may hold layers
   * deeper than an edit may make now), stopping if it comes round again.
   */
  #pathOnPage(node: NodeRecord): string[] | null {
    const path: string[] = [];
    const seen = new Set<string>();
    for (let current: NodeRecord | undefined = node; current; current = this.get(current.parent)) {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      path.push(`${current.key}\u0000${current.id}`);
      if (current.type === "page") return current.parent === ROOT_ID ? path.reverse() : null;
    }
    return null;
  }

  /**
   * Keeps a row, letting the oldest go (first in, first out) past the
   * limit on rows or on characters of properties held.
   */
  #remember(id: string, node: NodeRecord | null, size: number): void {
    const before = this.#nodes.get(id);
    if (before) {
      this.#held -= before.size;
      this.#nodes.delete(id);
    }
    this.#nodes.set(id, { node, size });
    this.#held += size;
    while (this.#nodes.size > 1 && (this.#nodes.size > this.#limit || this.#held > this.#budget)) {
      const [oldest, entry] = this.#nodes.entries().next().value as [string, { size: number }];
      this.#nodes.delete(oldest);
      this.#held -= entry.size;
    }
  }
}

/** A character past Latin-1: V8 keeps such a string two bytes a character. */
const WIDE = /[\u0100-\uffff]/;

/** What V8 holds for a string, about: a byte a character, two past Latin-1. */
function heldChars(text: string): number {
  return WIDE.test(text) ? 2 * text.length : text.length;
}

/** Tree order: a parent before its children, siblings by key then id. */
function comparePaths(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
