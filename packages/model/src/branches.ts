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
import type { CreateOp, NodeRecord, Op } from "./ops";
import { KEYED_PROPS, type PropName } from "./schema";

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
      /**
       * For a map a change sets entries of (`KEYED_PROPS`: an instance's
       * component property values), the entry: each is its own change, so
       * changes to different entries never conflict (decision 0035).
       */
      readonly key?: string;
      readonly base: unknown;
      readonly branch: unknown;
      /** What main has now; `undefined` when main deleted the node. */
      readonly main: unknown;
      /** Main changed the same field to something else, or deleted the node. */
      readonly conflict: boolean;
      /**
       * One field of an override record both sides made from a base without
       * it (decision 0035): `base` is undefined, an unset field is `null`.
       * The fields taken come in as one create, merged into main's record.
       */
      readonly record?: true;
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

/**
 * What the branch changed in one node it kept from the base: a change per
 * field that differs, conflicting where main (`now`, undefined when main
 * deleted it) changed the same field to something else.
 */
export function changedFields(
  was: NodeRecord,
  node: NodeRecord,
  now: NodeRecord | undefined,
): BranchChange[] {
  const changes: BranchChange[] = [];
  const before = fields(was);
  const after = fields(node);
  const onMain = now ? fields(now) : null;
  for (const field of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(field);
    const a = after.get(field);
    if (same(a, b)) continue;
    const m = onMain ? onMain.get(field) : undefined;
    if (KEYED_PROPS.has(field as PropName)) {
      // A map that exists differs from none (an instance's record decides every key once it
      // exists, decision 0035): one side making or removing it changes it whole, conflicting
      // where main did otherwise. Maps on both sides are compared entry by entry.
      if (present(b) !== present(a)) {
        changes.push({
          kind: "changed",
          id: node.id,
          field: field as PropName,
          base: b,
          branch: a,
          main: m,
          conflict: onMain === null || (!same(m, b) && !same(m, a)),
        });
        continue;
      }
      changes.push(...changedEntries(node.id, field as PropName, b, a, m, onMain === null));
      continue;
    }
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
  return changes;
}

/** Whether a map is there at all (an empty one is). */
const present = (value: unknown) => value !== undefined && value !== null;

/** A map's entries, as `changedFields` compares them (none: an empty map). */
const entries = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** The changes to a keyed map's entries: one per entry that differs, as `changedFields` makes them. */
function changedEntries(
  id: string,
  field: PropName,
  base: unknown,
  branch: unknown,
  main: unknown,
  mainDeleted: boolean,
): BranchChange[] {
  const b = entries(base);
  const a = entries(branch);
  const m = entries(main);
  const out: BranchChange[] = [];
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (same(a[key], b[key])) continue;
    const conflict = mainDeleted || (!same(m[key], b[key]) && !same(m[key], a[key]));
    out.push({
      kind: "changed",
      id,
      field,
      key,
      base: b[key],
      branch: a[key],
      main: mainDeleted ? undefined : m[key],
      conflict,
    });
  }
  return out;
}

/**
 * A node the branch added: it conflicts when its parent was in the base
 * (so isn't coming with it) and main has deleted it since.
 */
export function addedChange(
  node: NodeRecord,
  parentOnMain: boolean,
  parentInBase: boolean,
): BranchChange {
  const parentThere = node.parent === ROOT_ID || parentOnMain || !parentInBase;
  return { kind: "added", id: node.id, conflict: parentThere ? null : "parent-gone" };
}

/**
 * Whether `node`, which the branch added, is an override record main made
 * too since the base: the same copy layer's (its id derives from its
 * instance and path, so both sides name it alike).
 */
function bothMadeRecord(node: NodeRecord, now: NodeRecord | undefined): now is NodeRecord {
  return (
    node.type === "override" &&
    now?.type === "override" &&
    now.parent === node.parent &&
    same(node.props.path, now.props.path)
  );
}

/** Bookkeeping in an override record, not fields of the layer. */
const RECORD_MARKS = new Set(["path", "unset", "overrides"]);

/** An override record's fields: each value it sets, and `null` for each it unsets. */
function recordFields(record: NodeRecord): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [field, value] of Object.entries(record.props))
    if (!RECORD_MARKS.has(field) && value !== undefined && value !== null) out.set(field, value);
  const unset = record.props.unset;
  if (Array.isArray(unset))
    for (const field of unset)
      if (typeof field === "string" && !out.has(field)) out.set(field, null);
  return out;
}

/**
 * The changes a node the branch added makes. Most are one `added` change
 * (`addedChange`). An override record main made too (`now`) is the
 * branch's fields from an empty base, each its own change: one main gave
 * another value (or unset) conflicts, one main left alone doesn't, and one
 * both made alike isn't a change.
 */
export function addedChanges(
  node: NodeRecord,
  now: NodeRecord | undefined,
  parentOnMain: boolean,
  parentInBase: boolean,
): BranchChange[] {
  if (!bothMadeRecord(node, now)) return [addedChange(node, parentOnMain, parentInBase)];
  const onMain = recordFields(now);
  const changes: BranchChange[] = [];
  for (const [field, value] of recordFields(node)) {
    const m = onMain.get(field);
    // (An unset field is null, which `same` takes for a missing one.)
    if (m !== undefined && same(value, m)) continue;
    changes.push({
      kind: "changed",
      id: node.id,
      field: field as PropName,
      base: undefined,
      branch: value,
      main: m,
      conflict: m !== undefined,
      record: true,
    });
  }
  return changes;
}

/**
 * The create that brings the `taken` fields of an override record both
 * sides made into main's, which it merges into (`applyCreate`): each taken
 * field's value or unset, and the branch's marks on them. Null when none.
 */
export function recordOp(node: NodeRecord, taken: ReadonlySet<string>): CreateOp | null {
  if (taken.size === 0) return null;
  const props: Record<string, unknown> = { path: node.props.path };
  const unset: string[] = [];
  const fields = recordFields(node);
  for (const field of taken) {
    const value = fields.get(field);
    if (value === null) unset.push(field);
    else if (value !== undefined) props[field] = value;
  }
  if (unset.length) props.unset = unset;
  const marks = Array.isArray(node.props.overrides)
    ? node.props.overrides.filter((field) => taken.has(field))
    : [];
  if (marks.length) props.overrides = marks;
  return {
    op: "create",
    id: node.id,
    type: node.type,
    parent: node.parent,
    key: node.key,
    props: props as NodeRecord["props"],
  };
}

/** Whether main changed a node since the base (`was` undefined: main added it). */
export function editedSince(was: NodeRecord | undefined, now: NodeRecord): boolean {
  // Maps don't serialise: compare their entries.
  return !was || !same(Object.fromEntries(fields(was)), Object.fromEntries(fields(now)));
}

/** What the branch changed since the base, and where main disagrees. */
export function branchChanges(base: DocReader, branch: DocReader, main: DocReader): BranchChange[] {
  const baseNodes = new Map(allNodes(base, base.childIds(ROOT_ID)).map((n) => [n.id, n]));
  const branchNodes = allNodes(branch, branch.childIds(ROOT_ID));
  const branchIds = new Set(branchNodes.map((n) => n.id));
  const changes: BranchChange[] = [];

  for (const node of branchNodes) {
    const was = baseNodes.get(node.id);
    if (!was) {
      // Added on the branch: its parent must be there in main (or come with it).
      changes.push(
        ...addedChanges(
          node,
          main.get(node.id),
          main.get(node.parent) !== undefined,
          baseNodes.has(node.parent),
        ),
      );
      continue;
    }
    changes.push(...changedFields(was, node, main.get(node.id)));
  }
  for (const [id, was] of baseNodes) {
    if (branchIds.has(id)) continue;
    // Deleted on the branch: only the top of what was deleted, its children go with it.
    if (baseNodes.has(was.parent) && !branchIds.has(was.parent)) continue;
    const now = main.get(id);
    if (!now) continue;
    const mainEdited = allNodes(main, [id]).some((n) => editedSince(baseNodes.get(n.id), n));
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
  const take = (c: BranchChange) => !c.conflict || resolutions.get(changeKey(c)) === "branch";

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

  // Override records both sides made: the fields taken, merged into main's by one create each.
  const records = new Map<string, Set<string>>();
  for (const c of changes) {
    if (c.kind !== "changed" || !take(c) || !main.get(c.id)) continue;
    if (c.record) {
      const taken = records.get(c.id) ?? new Set<string>();
      taken.add(c.field);
      records.set(c.id, taken);
      continue;
    }
    if (c.field === POSITION) {
      const to = c.branch as { parent: string; key: string };
      if (to.parent === ROOT_ID || main.get(to.parent) || placed.has(to.parent))
        ops.push({ op: "move", id: c.id, parent: to.parent, key: to.key });
    } else ops.push(changeOp(c));
  }
  for (const [id, taken] of records) {
    const node = branch.get(id);
    const op = node && recordOp(node, taken);
    if (op) ops.push(op);
  }

  for (const c of changes)
    if (c.kind === "removed" && take(c)) ops.push({ op: "delete", id: c.id });
  return ops;
}

/** A change's key in `resolutions`: `id`, `id:field`, or `id:field:entry` for a map's entry. */
export function changeKey(change: BranchChange): string {
  if (change.kind !== "changed") return change.id;
  return change.key === undefined
    ? `${change.id}:${change.field}`
    : `${change.id}:${change.field}:${change.key}`;
}

/** The operation that takes a changed property (or one entry of a map) to the branch's value. */
export function changeOp(change: Extract<BranchChange, { kind: "changed" }>): Op {
  const value = change.branch === undefined ? null : change.branch;
  const prop = change.field as PropName;
  return change.key === undefined
    ? { op: "set", id: change.id, prop, value }
    : { op: "set", id: change.id, prop, key: change.key, value };
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
