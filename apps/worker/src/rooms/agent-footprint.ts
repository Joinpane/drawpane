/**
 * What an agent run depended on (decision 0033): checked when its commit
 * arrives after the file moved on past the revision it ran on, so a run
 * whose inputs someone changed meanwhile runs again instead of landing
 * on a file it wasn't made for.
 *
 * - The layers it changed, as agent undo checks them: a layer put inside
 *   one counts too (`writes`).
 * - What its runner read (`AgentReadSet`): the layers, the child lists and
 *   the instance lists the tool and its layout fix-ups looked at.
 * - Whatever the runner read or not: the old and new parents of every
 *   layer it changed, their ancestors, and the child lists of the auto
 *   layout frames among them, whose layout places it.
 * - Anything changed inside a layer it deletes (`underDeleted`, in SQL).
 *
 * Everything but the deletes is a set of ids, bounded by AGENT_READ_CAP
 * in all: past it, the run is taken to depend on the whole file, and any
 * change since its base revision makes it run again.
 */
import type { NodeRecord, Op } from "@drawpane/model";
import { AGENT_READ_CAP, type AgentReadSet } from "../agent/runner-api";

export interface Footprint {
  /** Layers it changed: a change to one, or a layer put inside one, overlaps. */
  readonly writes: ReadonlySet<string>;
  /** Layers it read: a change to one overlaps. */
  readonly reads: ReadonlySet<string>;
  /** Parents whose child list it read: a layer put in one overlaps (taken out, its id is in `reads`). */
  readonly lists: ReadonlySet<string>;
  /** Mains whose instances it listed: a new instance of one, or a copy swapped to it, overlaps. */
  readonly instances: ReadonlySet<string>;
  /** Layers it deletes, whole subtrees: a change below one overlaps (`underDeleted`). */
  readonly deletes: readonly string[];
}

/** How the footprint reads the room's file: its stored rows, at the revision the commit lands on. */
export interface FootprintStore {
  get(id: string): NodeRecord | undefined;
  childIds(parent: string): readonly string[];
}

/**
 * What a run of `ops` that read `reads` depended on; null when that's more
 * than AGENT_READ_CAP ids (or the runner said it read everything): it
 * depends on the whole file.
 */
export function footprint(
  store: FootprintStore,
  ops: readonly Op[],
  reads: AgentReadSet | undefined,
): Footprint | null {
  if (!reads) return null;
  const writes = new Set<string>();
  const made = new Map<string, string>();
  const deletes: string[] = [];
  for (const op of ops) {
    writes.add(op.id);
    if (op.op === "create") made.set(op.id, op.parent);
    if (op.op === "delete") deletes.push(op.id);
  }
  const read = new Set(reads.ids);
  const lists = new Set(reads.lists);
  const instances = new Set(reads.instances);
  const size = () => read.size + lists.size + instances.size;
  if (size() > AGENT_READ_CAP) return null;

  /** `id` and its ancestors as stored, nearest first; layers the run made are walked through. */
  const climbed = new Set<string>();
  const climb = (from: string | undefined): boolean => {
    let id = from;
    while (id !== undefined && !climbed.has(id)) {
      climbed.add(id);
      const parent = made.get(id);
      if (parent !== undefined) {
        id = parent;
        continue;
      }
      const node = store.get(id);
      if (!node) return true;
      read.add(id);
      // Its children are its layout's inputs: one put in or taken out moves the rest.
      if (autoLayout(node)) {
        lists.add(id);
        for (const child of store.childIds(id)) read.add(child);
      }
      if (size() > AGENT_READ_CAP) return false;
      id = node.parent;
    }
    return true;
  };
  for (const op of ops) {
    if (made.has(op.id) && op.op !== "move") {
      if (!climb(made.get(op.id))) return null;
      continue;
    }
    // Where it is now (its old parent, for a move), then where a move puts it.
    if (!climb(store.get(op.id)?.parent)) return null;
    if (op.op === "move" && !climb(op.parent)) return null;
  }
  return { writes, reads: read, lists, instances, deletes };
}

function autoLayout(node: NodeRecord): boolean {
  const mode = node.props.layoutMode;
  return typeof mode === "string" && mode !== "none";
}

/** Whether a logged operation, by anyone, changed something the footprint depended on. */
export function overlaps(op: Op, f: Footprint): boolean {
  if (f.writes.has(op.id) || f.reads.has(op.id)) return true;
  if (op.op === "create" || op.op === "move") {
    if (f.writes.has(op.parent) || f.lists.has(op.parent)) return true;
  }
  if (f.instances.size > 0) {
    if (op.op === "create" && typeof op.props.instanceOf === "string")
      return f.instances.has(op.props.instanceOf);
    if (op.op === "set" && op.prop === "instanceOf" && typeof op.value === "string")
      return f.instances.has(op.value);
  }
  return false;
}

/** The layers a logged operation changed or put something in: what a delete's subtree is checked for. */
export function touchedBy(op: Op): string[] {
  return op.op === "create" || op.op === "move" ? [op.id, op.parent] : [op.id];
}

/**
 * Whether any of `touched` is, as stored now, inside one of `roots` (or
 * is one): one recursive query up the parent chains, each layer visited
 * once however many share it.
 */
export function underDeleted(
  sql: SqlStorage,
  touched: ReadonlySet<string>,
  roots: readonly string[],
): boolean {
  if (touched.size === 0 || roots.length === 0) return false;
  const hit = sql
    .exec<{ hit: number }>(
      `WITH RECURSIVE up(id) AS (
         SELECT value FROM json_each(?1)
         UNION
         SELECT n.parent FROM nodes n JOIN up ON n.id = up.id
       )
       SELECT 1 AS hit FROM up WHERE id IN (SELECT value FROM json_each(?2)) LIMIT 1`,
      JSON.stringify([...touched]),
      JSON.stringify(roots),
    )
    .toArray();
  return hit.length > 0;
}
