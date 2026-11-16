/**
 * Branch merges and updates from main (decision 0012) in SQL, a page of rows
 * at a time (decision 0026). Three files: the base (`base`), the side whose
 * changes come in (`other`: the branch when merging, main when updating),
 * and the room's own nodes (`nodes`: main when merging, the branch when
 * updating). The comparison per node is the model's (`addedChange`,
 * `changedFields`, `editedSince`), so this agrees with `branchChanges` and
 * `mergeOps`, which the editor's review uses.
 *
 * `planThreeWay` counts the changes and the conflicts nobody decided, and
 * notes which deletions go ahead; `applyThreeWay` then pushes the
 * operations in the order `mergeOps` gives them: added nodes parents
 * first, changed fields (parents first, so a move never makes a cycle),
 * then deletions.
 */
import {
  addedChange,
  type BranchChange,
  changedFields,
  changeKey,
  editedSince,
  type NodeRecord,
  POSITION,
  type PropName,
  type Resolution,
  ROOT_ID,
} from "@drawpane/model";
import { type NodeRow, PAGE_ROWS, toRecord } from "./node-tables";
import type { OpChunks } from "./op-chunks";

export interface ThreeWayTables {
  /** The nodes both sides started from. */
  readonly base: string;
  /** The side whose changes come in, its levels numbered (see `fillDepths`). */
  readonly other: string;
  /** Where `planThreeWay` notes the deletions that go ahead (made by it). */
  readonly removals: string;
}

export interface ThreeWayChoices {
  /** Each conflict's side, by change key; a conflict without one isn't taken. */
  readonly resolutions: ReadonlyMap<string, Resolution>;
  /** Changes left out, by change key. */
  readonly skip: ReadonlySet<string>;
}

export interface ThreeWayPlan {
  /** Changes, less those skipped. */
  readonly changes: number;
  /** Of those, how many conflict. */
  readonly conflicts: number;
  /** Conflicts without a resolution. */
  readonly undecided: number;
}

interface Joined extends NodeRow {
  depth: number | null;
  b_id: string | null;
  b_parent: string | null;
  b_key: string | null;
  b_type: string | null;
  b_props: string | null;
  n_id: string | null;
  n_parent: string | null;
  n_key: string | null;
  n_type: string | null;
  n_props: string | null;
  parent_live: number;
  parent_base: number;
}

const JOINED = (t: ThreeWayTables) => `
  SELECT o.id, o.parent, o.key, o.type, o.props, o.depth,
         b.id AS b_id, b.parent AS b_parent, b.key AS b_key, b.type AS b_type, b.props AS b_props,
         n.id AS n_id, n.parent AS n_parent, n.key AS n_key, n.type AS n_type, n.props AS n_props,
         EXISTS (SELECT 1 FROM nodes p WHERE p.id = o.parent) AS parent_live,
         EXISTS (SELECT 1 FROM ${t.base} p WHERE p.id = o.parent) AS parent_base
    FROM ${t.other} o
    LEFT JOIN ${t.base} b ON b.id = o.id
    LEFT JOIN nodes n ON n.id = o.id`;

function sideOf(row: Joined, prefix: "b" | "n"): NodeRecord | undefined {
  const r = row as unknown as Record<string, string | null>;
  if (r[`${prefix}_id`] === null) return undefined;
  return toRecord({
    id: row.id,
    parent: r[`${prefix}_parent`] as string,
    key: r[`${prefix}_key`] as string,
    type: r[`${prefix}_type`] as string,
    props: r[`${prefix}_props`] as string,
  });
}

/** The same in base and on the other side, byte for byte: not a change, and not worth parsing. */
const untouched = (row: Joined) =>
  row.b_id !== null &&
  row.b_props === row.props &&
  row.b_parent === row.parent &&
  row.b_key === row.key &&
  row.b_type === row.type;

/** The changes one node of the other side makes. */
function changesOf(row: Joined): BranchChange[] {
  const node = toRecord(row);
  const was = sideOf(row, "b");
  if (!was) return [addedChange(node, row.parent_live === 1, row.parent_base === 1)];
  return changedFields(was, node, sideOf(row, "n"));
}

/** Pages of the other side joined with base and the room's nodes, in id order. */
function* byId(sql: SqlStorage, t: ThreeWayTables): Generator<Joined[]> {
  let after = "";
  for (;;) {
    const rows = sql
      .exec<Joined>(`${JOINED(t)} WHERE o.id > ? ORDER BY o.id LIMIT ?`, after, PAGE_ROWS)
      .toArray();
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < PAGE_ROWS) return;
    after = (rows[rows.length - 1] as Joined).id;
  }
}

/** Pages of the other side's nodes under the root, level by level (parents first). */
function* byLevel(sql: SqlStorage, t: ThreeWayTables, where: string): Generator<Joined[]> {
  let after: [number, string] = [0, ""];
  for (;;) {
    const rows = sql
      .exec<Joined>(
        `${JOINED(t)} WHERE o.depth IS NOT NULL AND ${where}
            AND (o.depth > ? OR (o.depth = ? AND o.id > ?))
          ORDER BY o.depth, o.id LIMIT ?`,
        after[0],
        after[0],
        after[1],
        PAGE_ROWS,
      )
      .toArray();
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < PAGE_ROWS) return;
    const last = rows[rows.length - 1] as Joined;
    after = [last.depth as number, last.id];
  }
}

/**
 * Counts the changes and conflicts, and notes in `t.removals` the
 * deletions that go ahead. Reads; changes nothing in the file.
 */
export function planThreeWay(
  sql: SqlStorage,
  t: ThreeWayTables,
  choices: ThreeWayChoices,
): ThreeWayPlan {
  let changes = 0;
  let conflicts = 0;
  let undecided = 0;
  const count = (change: BranchChange) => {
    const key = changeKey(change);
    if (choices.skip.has(key)) return false;
    changes++;
    if (change.conflict) {
      conflicts++;
      if (!choices.resolutions.has(key)) undecided++;
    }
    return !change.conflict || choices.resolutions.get(key) === "branch";
  };

  // Only nodes under the root count, as `branchChanges` walks from it.
  for (const rows of byId(sql, t))
    for (const row of rows) {
      if (row.depth === null || untouched(row)) continue;
      for (const change of changesOf(row)) count(change);
    }

  // Deleted on the other side: the top of each deletion, where the room still has it.
  sql.exec(`DROP TABLE IF EXISTS ${t.removals}`);
  sql.exec(`CREATE TABLE ${t.removals} (id TEXT PRIMARY KEY) STRICT`);
  let last = "";
  for (;;) {
    const ids = sql
      .exec<{ id: string }>(
        `SELECT b.id FROM ${t.base} b
          WHERE b.id > ?
            AND NOT EXISTS (SELECT 1 FROM ${t.other} o WHERE o.id = b.id)
            AND (NOT EXISTS (SELECT 1 FROM ${t.base} p WHERE p.id = b.parent)
                 OR EXISTS (SELECT 1 FROM ${t.other} o WHERE o.id = b.parent))
            AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = b.id)
          ORDER BY b.id LIMIT ?`,
        last,
        PAGE_ROWS,
      )
      .toArray();
    for (const { id } of ids) {
      const edited = editedInRoom(sql, t.base, id);
      const take = count({ kind: "removed", id, conflict: edited ? "changed-on-main" : null });
      if (take) sql.exec(`INSERT INTO ${t.removals} (id) VALUES (?)`, id);
    }
    if (ids.length < PAGE_ROWS) break;
    last = (ids[ids.length - 1] as { id: string }).id;
  }
  return { changes, conflicts, undecided };
}

/** Whether the room changed anything in `id`'s subtree since the base (or added to it). */
function editedInRoom(sql: SqlStorage, base: string, id: string): boolean {
  const cursor = sql.exec<
    NodeRow & {
      b_id: string | null;
      b_parent: string | null;
      b_key: string | null;
      b_props: string | null;
      b_type: string | null;
    }
  >(
    `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent = sub.id)
     SELECT n.id, n.parent, n.key, n.type, n.props,
            b.id AS b_id, b.parent AS b_parent, b.key AS b_key, b.type AS b_type, b.props AS b_props
       FROM sub JOIN nodes n ON n.id = sub.id LEFT JOIN ${base} b ON b.id = n.id`,
    id,
  );
  for (const row of cursor) {
    if (row.b_id === null) return true;
    if (
      row.b_props === row.props &&
      row.b_parent === row.parent &&
      row.b_key === row.key &&
      row.b_type === row.type
    )
      continue;
    const was = toRecord({
      id: row.id,
      parent: row.b_parent as string,
      key: row.b_key as string,
      type: row.b_type as string,
      props: row.b_props as string,
    });
    if (editedSince(was, toRecord(row))) return true;
  }
  return false;
}

/**
 * Pushes the operations that take the planned changes into the room's
 * nodes into `out`, which commits as it fills. Call `planThreeWay` first,
 * with the same choices, with nothing committed in between.
 */
export function applyThreeWay(
  sql: SqlStorage,
  t: ThreeWayTables,
  choices: ThreeWayChoices,
  out: OpChunks,
): void {
  const take = (change: BranchChange) => {
    const key = changeKey(change);
    return (
      !choices.skip.has(key) && (!change.conflict || choices.resolutions.get(key) === "branch")
    );
  };
  // There now, or made by an operation waiting to be committed.
  const live = (id: string) =>
    id === ROOT_ID ||
    out.creates(id) ||
    sql.exec(`SELECT 1 FROM nodes WHERE id = ?`, id).toArray().length > 0;

  // Added, parents first (a level at a time): each only where its parent is there or came in.
  for (const rows of byLevel(sql, t, `NOT EXISTS (SELECT 1 FROM ${t.base} x WHERE x.id = o.id)`))
    for (const row of rows) {
      const change = addedChange(toRecord(row), row.parent_live === 1, row.parent_base === 1);
      if (!take(change) || !live(row.parent)) continue;
      out.push({
        op: "create",
        id: row.id,
        type: row.type as NodeRecord["type"],
        parent: row.parent,
        key: row.key,
        props: JSON.parse(row.props) as NodeRecord["props"],
      });
    }

  // Changed fields, parents first.
  for (const rows of byLevel(sql, t, `EXISTS (SELECT 1 FROM ${t.base} x WHERE x.id = o.id)`))
    for (const row of rows) {
      if (untouched(row) || row.n_id === null) continue;
      for (const change of changesOf(row)) {
        if (change.kind !== "changed" || !take(change)) continue;
        if (change.field === POSITION) {
          const to = change.branch as { parent: string; key: string };
          // A parent that only came in with this merge was created above.
          if (live(to.parent))
            out.push({ op: "move", id: change.id, parent: to.parent, key: to.key });
        } else
          out.push({
            op: "set",
            id: change.id,
            prop: change.field as PropName,
            value: change.branch === undefined ? null : change.branch,
          });
      }
    }

  // Deleted, as planned.
  let last = "";
  for (;;) {
    const ids = sql
      .exec<{ id: string }>(
        `SELECT id FROM ${t.removals} WHERE id > ? ORDER BY id LIMIT ?`,
        last,
        PAGE_ROWS,
      )
      .toArray();
    for (const { id } of ids) out.push({ op: "delete", id });
    if (ids.length < PAGE_ROWS) break;
    last = (ids[ids.length - 1] as { id: string }).id;
  }
  out.flush();
}
