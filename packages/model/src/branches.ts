/**
 * Branches (docs/decisions/0012-branches.md): what a branch changed since it
 * was made, what of that conflicts with main, and the operations that bring
 * chosen changes into main.
 *
 * Three snapshots of the same file: the base (main when the branch was
 * made), the branch now, and main now. A change is the branch's difference
 * from the base; it conflicts where main has a different difference of its
 * own. Comparing snapshots, not replaying logs, means undos, restores and
 * collaborators on either side all net out.
 */
import { ROOT_ID } from "./ids";
import type { DocReader } from "./libraries";
import { stableJson } from "./libraries";
import type { NodeRecord, Op } from "./ops";
import type { PropName } from "./schema";

/** Where a node sits: its parent and its order key there. */
export const POSITION = "position" as const;

export type BranchChange =
  | {
      readonly kind: "added";
      readonly id: string;
      /** Main deleted where it goes: it can't be merged as is. */
      readonly conflict: "parent-gone" | null;
    }
  | {
      readonly kind: "removed";
      readonly id: string;
      /** Main changed it since: deleting would lose that. */
      readonly conflict: "changed-on-main" | null;
    }
  | {
      readonly kind: "changed";
      readonly id: string;
      /** A property, or `position` for a move. */
      readonly field: PropName | typeof POSITION;
      readonly base: unknown;
      readonly branch: unknown;
      /** What main has now; `undefined` when main deleted the node. */
      readonly main: unknown;
      /** Main changed the same field to something else, or deleted the node. */
      readonly conflict: boolean;
    };

/** All the nodes in a reader, parents before children. */
function allNodes(doc: DocReader, roots: readonly string[]): NodeRecord[] {
  const out: NodeRecord[] = [];
  const visit = (id: string) => {
    const node = doc.get(id);
    if (!node) return;
    out.push(node);
    for (const child of doc.childIds(id)) visit(child);
  };
  for (const id of roots) visit(id);
  return out;
}

/** What a node is everywhere: its props plus its position, as comparable values. */
function fields(node: NodeRecord): Map<string, unknown> {
  const out = new Map<string, unknown>(Object.entries(node.props));
  out.set(POSITION, { parent: node.parent, key: node.key });
  return out;
}

const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** What the branch changed since the base, and where main disagrees. */
export function branchChanges(base: DocReader, branch: DocReader, main: DocReader): BranchChange[] {
  const baseNodes = new Map(allNodes(base, base.childIds(ROOT_ID)).map((n) => [n.id, n]));
  const branchNodes = allNodes(branch, branch.childIds(ROOT_ID));
  const branchIds = new Set(branchNodes.map((n) => n.id));
  const changes: BranchChange[] = [];

  for (const node of branchNodes) {
    const was = baseNodes.get(node.id);
    const now = main.get(node.id);
    if (!was) {
      // Added on the branch: its parent must be there in main (or come with it).
      const parentThere =
        node.parent === ROOT_ID ||
        main.get(node.parent) !== undefined ||
        !baseNodes.has(node.parent);
      changes.push({ kind: "added", id: node.id, conflict: parentThere ? null : "parent-gone" });
      continue;
    }
    const before = fields(was);
    const after = fields(node);
    const onMain = now ? fields(now) : null;
    for (const field of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(field);
      const a = after.get(field);
      if (same(a, b)) continue;
      const m = onMain ? onMain.get(field) : undefined;
      const conflict = onMain === null || (!same(m, b) && !same(m, a));
      changes.push({
        kind: "changed",
        id: node.id,
        field: field as PropName | typeof POSITION,
        base: b,
        branch: a,
        main: m,
        conflict,
      });
    }
  }
  for (const [id, was] of baseNodes) {
    if (branchIds.has(id)) continue;
    // Deleted on the branch: only the top of what was deleted, its children go with it.
    if (baseNodes.has(was.parent) && !branchIds.has(was.parent)) continue;
    const now = main.get(id);
    if (!now) continue;
    const mainEdited = allNodes(main, [id]).some((n) => {
      const before = baseNodes.get(n.id);
      // Maps don't serialise: compare their entries.
      return !before || !same(Object.fromEntries(fields(before)), Object.fromEntries(fields(n)));
    });
    changes.push({ kind: "removed", id, conflict: mainEdited ? "changed-on-main" : null });
  }
  return changes;
}

/** Which side a conflicting change takes. */
export type Resolution = "branch" | "main";

/**
 * Operations that bring `chosen` changes into main: added nodes (parents
 * first, from the branch), changed fields, then removals. A conflict goes
 * the branch's way only when resolved so; an added node whose parent is
 * gone from main, or isn't coming, is left out.
 */
export function mergeOps(
  main: DocReader,
  branch: DocReader,
  changes: readonly BranchChange[],
  resolutions: ReadonlyMap<string, Resolution> = new Map(),
): Op[] {
  const ops: Op[] = [];
  const keyOf = (c: BranchChange) => (c.kind === "changed" ? `${c.id}:${c.field}` : c.id);
  const take = (c: BranchChange) => !c.conflict || resolutions.get(keyOf(c)) === "branch";

  // Added: parents before children, each only if its parent is (or will be) there.
  const added = new Set(changes.filter((c) => c.kind === "added" && take(c)).map((c) => c.id));
  const placed = new Set<string>();
  const place = (id: string) => {
    if (placed.has(id)) return true;
    const node = branch.get(id);
    if (!node) return false;
    const parentReady =
      node.parent === ROOT_ID ||
      (added.has(node.parent) ? place(node.parent) : main.get(node.parent) !== undefined);
    if (!parentReady) return false;
    placed.add(id);
    ops.push({
      op: "create",
      id,
      type: node.type,
      parent: node.parent,
      key: node.key,
      props: node.props,
    });
    return true;
  };
  for (const id of added) place(id);

  for (const c of changes) {
    if (c.kind !== "changed" || !take(c) || !main.get(c.id)) continue;
    if (c.field === POSITION) {
      const to = c.branch as { parent: string; key: string };
      if (to.parent === ROOT_ID || main.get(to.parent) || placed.has(to.parent))
        ops.push({ op: "move", id: c.id, parent: to.parent, key: to.key });
    } else
      ops.push({
        op: "set",
        id: c.id,
        prop: c.field,
        value: c.branch === undefined ? null : c.branch,
      });
  }

  for (const c of changes)
    if (c.kind === "removed" && take(c)) ops.push({ op: "delete", id: c.id });
  return ops;
}

/** A change's key in `resolutions`. */
export function changeKey(change: BranchChange): string {
  return change.kind === "changed" ? `${change.id}:${change.field}` : change.id;
}

/** Someone named in a branch's record; null once they've left the instance. */
export interface BranchPerson {
  readonly id: string;
  readonly name: string;
}

/** A branch as the API lists it. */
export interface BranchInfo {
  /** The branch's own file. */
  readonly id: string;
  readonly name: string;
  /** The file it branches. */
  readonly mainId: string;
  /** Main's revision when the branch was made. */
  readonly baseRevn: number;
  readonly createdAt: number;
  /** When the branch was last edited. */
  readonly updatedAt: number;
  readonly createdBy: BranchPerson | null;
  readonly thumbnailAt: number | null;
  /** Null while it's open; once merged, read-only history. */
  readonly merged: {
    readonly at: number;
    readonly by: BranchPerson | null;
    /** Main's revision the merge landed at. */
    readonly revn: number | null;
    /** How many changes it took. */
    readonly changes: number | null;
  } | null;
}
