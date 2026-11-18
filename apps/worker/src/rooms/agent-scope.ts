/**
 * An agent run's scope, and what changed in it (decision 0033): checked
 * when its commit arrives after the file moved on past the revision it ran
 * on. The commit runs again when anyone's change since then touched a
 * layer in its scope; otherwise it lands.
 *
 * Everything is placed by its **top-level layer**: the layer it's in whose
 * parent is a page (for a layer on a page), or the record itself for one
 * whose parent is the root (a page, a variable collection, a text style).
 * The scope is a set of those, plus the pages whose list of top-level
 * layers the run depended on:
 *
 * - the top-level layers its runner read in (`AgentReads.units`), and
 *   those of the layers it changed, as stored now and where it puts them;
 * - a page's list when it put a top-level layer in, took one out or moved
 *   one, or read the list; then the page's top-level groups too, whose
 *   bounds come from what's inside them;
 * - closed over what the layers inside any of those use: mains (an
 *   instance's), text styles, variables and their aliases, with their own
 *   top-level layers, and so on.
 *
 * It doesn't depend on recording each read inside a top-level layer, so a
 * cache that skips a read (a scene's bounds, a copy's children, an
 * instance index) can't hide one. A change touches the top-level layers of
 * the layers it changes and puts things in, those of the mains, styles
 * and variables it points a layer at, and the page's list when the layer
 * changed is top-level. A layer deleted or moved away has left where it
 * was, which the stored rows no longer show: the room notes it as the
 * change applies (`placeAll` before it does) while a write call is under
 * way.
 *
 * Every step is bounded: more than AGENT_SCOPE_CAP ids, or more than
 * AGENT_SCOPE_SCAN layers looked through to close the scope, and the run
 * is taken to depend on the whole file.
 */
import { heldNodeIds, type Op, type Props, ROOT_ID } from "@drawpane/model";
import { AGENT_SCOPE_CAP, AGENT_SCOPE_SCAN, type AgentReads } from "../agent/runner-api";

/** Top-level layers, pages' lists, and ids themselves: a run's scope, or what changes touched. */
export interface Scope {
  readonly units: Set<string>;
  readonly lists: Set<string>;
  readonly ids: Set<string>;
}

/** Where a stored layer is: its top-level layer, and its own parent and type. */
export interface Place {
  readonly top: string;
  readonly parent: string;
  readonly type: string;
}

const emptyScope = (): Scope => ({ units: new Set(), lists: new Set(), ids: new Set() });

/**
 * Each stored layer of `ids` placed by its top-level layer, in one
 * recursive query up the parent chains. Ids not stored aren't in the map.
 */
export function placeAll(sql: SqlStorage, ids: Iterable<string>): Map<string, Place> {
  const wanted = [...new Set(ids)].filter((id) => id !== ROOT_ID);
  const out = new Map<string, Place>();
  if (wanted.length === 0) return out;
  const rows = sql
    .exec<{ start: string; top: string; type: string; parent: string }>(
      `WITH RECURSIVE up(start, id, parent) AS (
         SELECT id, id, parent FROM nodes WHERE id IN (SELECT value FROM json_each(?1))
         UNION ALL
         SELECT up.start, n.id, n.parent FROM up JOIN nodes n ON n.id = up.parent
         WHERE up.parent <> ?2
           AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id = up.parent AND p.type = 'page')
       )
       SELECT up.start AS start, up.id AS top, s.type AS type, s.parent AS parent
       FROM up JOIN nodes s ON s.id = up.start
       WHERE up.parent = ?2
          OR EXISTS (SELECT 1 FROM nodes p WHERE p.id = up.parent AND p.type = 'page')`,
      JSON.stringify(wanted),
      ROOT_ID,
    )
    .toArray();
  for (const row of rows) out.set(row.start, { top: row.top, parent: row.parent, type: row.type });
  return out;
}

/** The ids a layer's properties point at that its look depends on: mains, styles, variables. */
function usedIds(props: Readonly<Props>): string[] {
  return heldNodeIds(props).others;
}

/**
 * The scope of a run of `ops` that read where `reads` says, as stored now;
 * null when it's the whole file (the runner couldn't place what it read,
 * or the scope is past its bounds).
 */
export function runScope(sql: SqlStorage, ops: readonly Op[], reads: AgentReads): Scope | null {
  if (!reads) return null;
  const scope = emptyScope();
  for (const id of reads.units) scope.units.add(id);
  for (const id of reads.lists) scope.lists.add(id);
  for (const id of reads.absent) scope.ids.add(id);
  const made = new Map<string, string>();
  for (const op of ops) if (op.op === "create") made.set(op.id, op.parent);
  /** A parent as stored: one the run made is where that one went, and so on up. */
  const storedParent = (parent: string) => {
    let at = parent;
    for (let n = 0; made.has(at) && n <= made.size; n++) at = made.get(at) as string;
    return at;
  };
  const changed = new Set<string>();
  const moved = new Set<string>();
  const parents = new Set<string>();
  const used = new Set<string>();
  for (const op of ops) {
    if (op.op === "create") parents.add(storedParent(op.parent));
    else {
      changed.add(op.id);
      scope.ids.add(op.id);
      if (op.op === "move" || op.op === "delete") moved.add(op.id);
      if (op.op === "move") parents.add(storedParent(op.parent));
    }
    for (const id of opUses(op)) if (!made.has(id)) used.add(id);
  }
  if (changed.size + parents.size + used.size > AGENT_SCOPE_CAP) return null;
  const placed = placeAll(sql, [...changed, ...parents, ...used]);
  for (const id of changed) {
    const at = placed.get(id);
    // Not stored any more: deleted since, which touches it (`scope.ids`).
    if (!at) continue;
    scope.units.add(at.top);
    // A top-level layer it moved or deleted: the page's list changes.
    if (at.top === id && moved.has(id)) scope.lists.add(at.parent);
  }
  for (const id of parents) {
    const at = placed.get(id);
    if (id === ROOT_ID || at?.type === "page") scope.lists.add(id);
    else if (at) scope.units.add(at.top);
  }
  for (const id of used) {
    const at = placed.get(id);
    if (at) scope.units.add(at.top);
  }
  return closeScope(sql, scope) ? scope : null;
}

/** The ids a create or set points a layer at (`usedIds`). */
function opUses(op: Op): string[] {
  if (op.op === "create") return usedIds(op.props);
  if (op.op === "set") return usedIds({ [op.prop]: op.value } as Props);
  return [];
}

/**
 * Closes `scope` in place: the top-level groups of the pages whose lists
 * it holds, and what the layers in its top-level layers use, with their
 * own top-level layers, until nothing new turns up. False when that's past
 * AGENT_SCOPE_SCAN layers looked through or AGENT_SCOPE_CAP ids.
 */
export function closeScope(sql: SqlStorage, scope: Scope): boolean {
  const pages = [...scope.lists].filter((id) => id !== ROOT_ID);
  if (pages.length > 0) {
    const groups = sql
      .exec<{ id: string }>(
        "SELECT id FROM nodes WHERE parent IN (SELECT value FROM json_each(?1)) AND type = 'group' LIMIT ?2",
        JSON.stringify(pages),
        AGENT_SCOPE_CAP + 1,
      )
      .toArray();
    for (const { id } of groups) scope.units.add(id);
  }
  const looked = new Set<string>();
  let budget = AGENT_SCOPE_SCAN;
  for (;;) {
    if (scope.units.size + scope.lists.size + scope.ids.size > AGENT_SCOPE_CAP) return false;
    const frontier = [...scope.units].filter((id) => !looked.has(id));
    if (frontier.length === 0) return true;
    for (const id of frontier) looked.add(id);
    // Every layer inside them (a page is only its record here), and the properties of
    // those that point at something.
    const row = sql
      .exec<{ n: number; refs: string | null }>(
        `WITH RECURSIVE down(id) AS (
           SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?1)) AND type <> 'page'
           UNION
           SELECT n.id FROM nodes n JOIN down ON n.parent = down.id
           LIMIT ?2
         )
         SELECT COUNT(*) AS n,
           json_group_array(json(n.props)) FILTER (WHERE
             instr(n.props, '"instanceOf"') OR instr(n.props, '"mirrors"')
             OR instr(n.props, '"textStyle"') OR instr(n.props, '"bindings"')
             OR instr(n.props, '"variableModes"') OR instr(n.props, '"alias"')) AS refs
         FROM down JOIN nodes n ON n.id = down.id`,
        JSON.stringify(frontier),
        budget,
      )
      .one();
    if (row.n >= budget) return false;
    budget -= row.n;
    const used = new Set<string>();
    for (const props of JSON.parse(row.refs ?? "[]") as Props[])
      for (const id of usedIds(props)) used.add(id);
    if (used.size > AGENT_SCOPE_CAP) return false;
    for (const at of placeAll(sql, used).values()) scope.units.add(at.top);
  }
}

/**
 * What `ops` touched, as stored now: the top-level layers of the layers
 * they changed, put something in, or pointed at; the lists of the pages
 * they put a layer in or changed a top-level layer of; and the ids they
 * changed. Null past AGENT_SCOPE_CAP ids. A layer deleted or moved away
 * isn't placed where it was here (`leftBy` notes that as it applies).
 */
export function touchedBy(sql: SqlStorage, ops: Iterable<Op>): Scope | null {
  const touched = emptyScope();
  const parents = new Set<string>();
  const used = new Set<string>();
  for (const op of ops) {
    touched.ids.add(op.id);
    if (op.op === "create" || op.op === "move") parents.add(op.parent);
    for (const id of opUses(op)) used.add(id);
    if (touched.ids.size + parents.size + used.size > AGENT_SCOPE_CAP) return null;
  }
  const placed = placeAll(sql, [...touched.ids, ...parents, ...used]);
  for (const id of touched.ids) {
    const at = placed.get(id);
    if (!at) continue;
    touched.units.add(at.top);
    if (at.top === id) touched.lists.add(at.parent);
  }
  for (const id of parents) {
    const at = placed.get(id);
    if (id === ROOT_ID || at?.type === "page") touched.lists.add(id);
    else if (at) touched.units.add(at.top);
  }
  for (const id of used) {
    const at = placed.get(id);
    if (at) touched.units.add(at.top);
  }
  return touched;
}

/**
 * Where the layers `ops` delete or move away are before they apply: their
 * top-level layers, and the page's list for a top-level one. Null when
 * that can't be said in bounds, or a page is deleted (everything on it
 * goes): then it touches everything. Empty when they delete or move
 * nothing.
 */
export function leftBy(sql: SqlStorage, ops: readonly Op[]): Scope | null {
  const leaving = new Set<string>();
  for (const op of ops) if (op.op === "delete" || op.op === "move") leaving.add(op.id);
  const left = emptyScope();
  if (leaving.size === 0) return left;
  if (leaving.size > AGENT_SCOPE_CAP) return null;
  for (const [id, at] of placeAll(sql, leaving)) {
    if (at.type === "page") return null;
    left.units.add(at.top);
    if (at.top === id) left.lists.add(at.parent);
  }
  return left;
}

/** Whether what changed (`touched`) touches a run's `scope`. */
export function touches(touched: Scope, scope: Scope): boolean {
  const meets = (a: Set<string>, b: Set<string>) => {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const id of small) if (large.has(id)) return true;
    return false;
  };
  return (
    meets(touched.units, scope.units) ||
    meets(touched.lists, scope.lists) ||
    meets(touched.ids, scope.ids)
  );
}
