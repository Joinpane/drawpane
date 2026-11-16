/**
 * An import arriving in parts (decision 0026). Each part's nodes are checked
 * on their own as they come (id, order key, every property) and kept in a
 * table beside the file's, with a running count of nodes and bytes held to
 * the import's limits; the commit checks how they fit together (every
 * parent there and allowed to hold its child, no node inside itself, no
 * deeper than MAX_DEPTH) and the limits again, in SQL, then fills the file
 * from the table in one storage transaction. Until then the file is as it
 * was.
 */
import {
  checkNode,
  copyId,
  MAX_DEPTH,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_NODES,
  ModelError,
  type NodeRecord,
  ROOT_ID,
} from "@drawpane/model";
import {
  allowedChildrenSql,
  countRows,
  createNodeTable,
  dropTable,
  fillDepths,
  insertRows,
  type NodeRow,
  type RoomSql,
  rowLineBytes,
  toRow,
} from "./node-tables";

/** Where an import waits for its commit. One at a time per room. */
export const IMPORT_TABLE = "import_nodes";

/** What one import may bring: nodes, and bytes of their JSON, in all its parts together. */
export interface ImportLimits {
  readonly nodes: number;
  readonly bytes: number;
}

export const IMPORT_LIMITS: ImportLimits = { nodes: MAX_IMPORT_NODES, bytes: MAX_IMPORT_BYTES };

/**
 * Override records (decision 0029) come only into a file that stores
 * compact copies: one stored materialized can't take them.
 */
export const NO_COMPACT_COPIES = "This file doesn't store compact copies.";

/** The running totals of a staged import, beside its table. */
const sizeTable = (table: string) => `${table}_size`;

export function beginStaging(sql: SqlStorage, table = IMPORT_TABLE): void {
  createNodeTable(sql, table);
  const size = sizeTable(table);
  sql.exec(`DROP TABLE IF EXISTS ${size}`);
  sql.exec(`CREATE TABLE ${size} (nodes INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT`);
  sql.exec(`INSERT INTO ${size} (nodes, bytes) VALUES (0, 0)`);
}

/** Throws a staged import away. */
export function dropStaging(sql: SqlStorage, table = IMPORT_TABLE): void {
  dropTable(sql, table);
  dropTable(sql, sizeTable(table));
}

function stagedSize(sql: SqlStorage, table: string): { nodes: number; bytes: number } {
  return (
    sql
      .exec<{ nodes: number; bytes: number }>(`SELECT nodes, bytes FROM ${sizeTable(table)}`)
      .toArray()[0] ?? { nodes: countRows(sql, table), bytes: 0 }
  );
}

function checkLimits(size: { nodes: number; bytes: number }, limits: ImportLimits): void {
  if (size.nodes > limits.nodes)
    throw new ModelError(
      "invalid_value",
      `An import can bring at most ${limits.nodes.toLocaleString("en")} layers.`,
    );
  if (size.bytes > limits.bytes)
    throw new ModelError(
      "invalid_value",
      `An import can bring at most ${Math.max(1, Math.round(limits.bytes / (1024 * 1024)))} MB of layers.`,
    );
}

/**
 * Checks a part's nodes and adds them to the staged import, all or none:
 * a part that would take the import past `limits` is refused and nothing of
 * it kept. Returns how many nodes the import holds now. Throws `ModelError`.
 */
export function stageNodes(
  room: RoomSql,
  nodes: readonly NodeRecord[],
  table = IMPORT_TABLE,
  limits: ImportLimits = IMPORT_LIMITS,
  /** `records`: override records may come (a file that stores compact copies). */
  { records = false }: { readonly records?: boolean } = {},
): number {
  const rows: NodeRow[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const [i, node] of nodes.entries()) {
    let checked: NodeRecord;
    try {
      checked = checkNode(node);
    } catch (error) {
      if (error instanceof ModelError) throw new ModelError(error.code, error.message, i);
      throw error;
    }
    if (checked.type === "override" && !records)
      throw new ModelError("invalid_parent", NO_COMPACT_COPIES, i);
    if (seen.has(node.id))
      throw new ModelError("already_exists", `Node ${node.id} is in the import twice.`, i);
    seen.add(node.id);
    const row = toRow(checked);
    // Counted as the node's line of JSON in UTF-8 bytes, as the browser counts what it sends.
    bytes += rowLineBytes(row);
    rows.push(row);
  }
  return room.transact(() => {
    const before = stagedSize(room.sql, table);
    const after = { nodes: before.nodes + rows.length, bytes: before.bytes + bytes };
    // Throwing rolls the part back: a refused part leaves nothing staged.
    checkLimits(after, limits);
    for (let i = 0; i < rows.length; i += 90) {
      const ids = rows.slice(i, i + 90).map((n) => n.id);
      const there = room.sql
        .exec<{ id: string }>(
          `SELECT id FROM ${table} WHERE id IN (${ids.map(() => "?").join(", ")}) LIMIT 1`,
          ...ids,
        )
        .toArray()[0];
      if (there) throw new ModelError("already_exists", `Node ${there.id} is in the import twice.`);
    }
    insertRows(room.sql, table, rows);
    room.sql.exec(`UPDATE ${sizeTable(table)} SET nodes = ?, bytes = ?`, after.nodes, after.bytes);
    return after.nodes;
  });
}

export interface CheckOptions {
  /** The file's own nodes, which the import mustn't clash with. */
  readonly live?: string;
  readonly limits?: ImportLimits;
  /**
   * How deep layers may nest (MAX_DEPTH). A copy of a file this server
   * already holds (a branch, a duplicate) takes any depth: a file may hold
   * layers deeper than an edit may make now (see `applyMove`).
   */
  readonly maxDepth?: number;
  /** Override records may come (into a file that stores compact copies), checked as edits are. */
  readonly records?: boolean;
}

/**
 * Checks the staged import as a whole: its limits, and how its nodes fit
 * together and with the file's own nodes, in SQL. Throws `ModelError`
 * naming the first node that doesn't.
 */
export function checkStaged(
  sql: SqlStorage,
  table = IMPORT_TABLE,
  {
    live = "nodes",
    limits = IMPORT_LIMITS,
    maxDepth = MAX_DEPTH,
    records = false,
  }: CheckOptions = {},
): void {
  const total = countRows(sql, table);
  checkLimits({ nodes: total, bytes: stagedSize(sql, table).bytes }, limits);

  if (records) checkRecords(sql, table);
  else {
    const override = sql.exec(`SELECT 1 FROM ${table} WHERE type = 'override' LIMIT 1`).toArray();
    if (override.length > 0) throw new ModelError("invalid_parent", NO_COMPACT_COPIES);
  }

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

  const { placed, tooDeep } = fillDepths(sql, table, maxDepth);
  if (placed < total) {
    if (tooDeep)
      throw new ModelError("too_deep", `Layers can't nest deeper than ${MAX_DEPTH} levels.`);
    const looped = sql
      .exec<{ id: string }>(`SELECT id FROM ${table} WHERE depth IS NULL LIMIT 1`)
      .toArray()[0];
    throw new ModelError("cycle", `Layer ${looped?.id ?? ""} is inside itself.`);
  }
}

/**
 * Checks each override record as an edit's would be (decision 0029): under
 * an instance root, and with the id its path derives. A page of records at
 * a time.
 */
function checkRecords(sql: SqlStorage, table: string): void {
  let after = "";
  for (;;) {
    const rows = sql
      .exec<{
        id: string;
        parent: string;
        path: string | null;
        of: string | null;
        type: string | null;
      }>(
        `SELECT s.id, s.parent, json_extract(s.props, '$.path') AS path,
                json_extract(p.props, '$.instanceOf') AS of, p.type AS type
           FROM ${table} s LEFT JOIN ${table} p ON p.id = s.parent
          WHERE s.type = 'override' AND s.id > ? ORDER BY s.id LIMIT 500`,
        after,
      )
      .toArray();
    for (const row of rows) {
      if (row.type !== "frame" || row.of === null)
        throw new ModelError("invalid_parent", "An override record belongs under an instance.");
      const path = row.path === null ? null : (JSON.parse(row.path) as unknown);
      if (
        !Array.isArray(path) ||
        path.length === 0 ||
        copyId(row.parent, path as string[]) !== row.id
      )
        throw new ModelError("invalid_id", `"${row.id}" isn't the id of the layer its path names.`);
    }
    if (rows.length < 500) return;
    after = (rows[rows.length - 1] as { id: string }).id;
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
