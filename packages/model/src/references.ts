/**
 * Copy references a transaction left pointing outside what their parent
 * copies, and the operations that fix them (review 8 of #209).
 *
 * Each layer under an instance copies a child of what its parent copies
 * (`copyTarget`): the parent's main layer for a copy, the main for an
 * instance root following one, the component it's swapped to for a swapped
 * nested instance. A layer whose reference isn't one of those children
 * (a rebuild made before a teammate's detach and delivered after it, or one
 * undone after it) is to point at the child whose copy chain ends at the
 * same main layer (`origin`) as its reference's: through to the inner
 * component after a detach, back to the outer copy when the detach is
 * undone. A layer no child matches is left (conversion then says why).
 *
 * This only reads. The room works the fixes out from what a transaction it
 * accepted leaves, and commits them as a transaction of its own, logged and
 * sent to everyone, the client that made the change included: so a tab on
 * older code, a replay of the log and a snapshot all hold the same
 * references, and nothing changes the file that isn't an operation. Clients
 * never fix references themselves.
 */
import type { NodeRecord, Op } from "./ops";

/** What the fixes read: the file a transaction left. */
export interface ReferenceReader {
  get(id: string): NodeRecord | undefined;
  childIds(id: string): readonly string[];
}

/** How deep a chain of parents, or of copies, is followed before giving up. */
const MAX_CHAIN = 256;

/** The nodes whose copy references `ops` may have left stale: layers made with one, nodes relinked. */
export function relinkedBy(ops: readonly Op[]): Set<string> {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.op === "create" && typeof op.props.mirrors === "string") out.add(op.id);
    if (op.op === "set" && (op.prop === "mirrors" || op.prop === "instanceOf")) out.add(op.id);
  }
  return out;
}

/**
 * How much reading one pass may do (`referenceFixesWithin`): a read of a
 * node or of a node's children, and each layer it queues, count one. A
 * commit that relinks a whole 500k-layer file stays within a room's time
 * and memory: past this, the fixes found so far are committed and the rest
 * are left (see `referenceFixesWithin`).
 */
export const REFERENCE_FIX_BUDGET = 200_000;

/** What a pass found, and whether it walked everything it had to. */
export interface ReferenceFixes {
  /** The fixes, parents before children; each is whole (its parent's fix, if any, comes first). */
  readonly ops: Op[];
  /** False when it stopped at its budget, with layers left unchecked. */
  readonly complete: boolean;
}

/**
 * The `set mirrors` operations that make every copy reference under the
 * nodes `ops` relinked (and the layers they made) copy a child of what its
 * parent copies, worked out on the file they left (`reader`), parents
 * before children: a fix one level down reads the level above as fixed.
 * Empty when there's nothing to fix. Within the default budget
 * (`REFERENCE_FIX_BUDGET`); `referenceFixesWithin` says when it stopped.
 */
export function referenceFixes(reader: ReferenceReader, ops: readonly Op[]): Op[] {
  return referenceFixesWithin(reader, ops).ops;
}

/**
 * `referenceFixes`, reading at most `budget` (see `REFERENCE_FIX_BUDGET`).
 * Linear in what it walks: each target's children are read once and
 * indexed by origin, and each origin is worked out once (a fix points a
 * layer at another of the same origin, so fixing never changes one).
 *
 * Past the budget it stops between layers and returns the fixes found so
 * far, each whole, with `complete` false. The room commits those; the
 * layers left keep their references until a later change relinks them (and
 * its pass reaches them), and conversion to compact copies keeps a layer
 * whose reference doesn't match as the copy at its place, so nothing is
 * lost meanwhile.
 */
export function referenceFixesWithin(
  reader: ReferenceReader,
  ops: readonly Op[],
  budget: number = REFERENCE_FIX_BUDGET,
): ReferenceFixes {
  const ids = relinkedBy(ops);
  if (ids.size === 0) return { ops: [], complete: true };
  let work = 0;
  const get = (id: string) => {
    work++;
    return reader.get(id);
  };
  const childIds = (id: string) => {
    work++;
    return reader.childIds(id);
  };
  // What each node copies, with the fixes so far.
  const fixed = new Map<string, string>();
  const mirrorsOf = (node: NodeRecord): string | null => {
    const own = fixed.get(node.id) ?? node.props.mirrors;
    return typeof own === "string" ? own : null;
  };
  const origins = new Map<string, string>();
  const origin = (id: string): string => {
    const known = origins.get(id);
    if (known !== undefined) return known;
    const path: string[] = [];
    let at = id;
    for (let i = 0; i < MAX_CHAIN; i++) {
      const cached = origins.get(at);
      if (cached !== undefined) {
        at = cached;
        break;
      }
      path.push(at);
      const node = get(at);
      const next = node ? mirrorsOf(node) : null;
      if (!next || !get(next)) break;
      at = next;
    }
    for (const step of path) origins.set(step, at);
    return at;
  };
  /** A target's children by origin, the first in order for each: read once per target. */
  const byOrigin = new Map<string, Map<string, string>>();
  const childOfOrigin = (target: string, from: string): string | undefined => {
    let index = byOrigin.get(target);
    if (!index) {
      index = new Map();
      for (const child of childIds(target)) {
        const o = origin(child);
        if (!index.has(o)) index.set(o, child);
      }
      byOrigin.set(target, index);
    }
    return index.get(from);
  };
  /** What a node's children copy: its main layer, its main, or the component it's swapped to. */
  const copyTarget = (node: NodeRecord): string | null => {
    const mirrors = mirrorsOf(node);
    const instanceOf =
      node.type === "frame" && typeof node.props.instanceOf === "string"
        ? node.props.instanceOf
        : null;
    if (instanceOf && (!mirrors || get(mirrors)?.props.instanceOf !== instanceOf))
      return instanceOf;
    return mirrors;
  };
  // Walked from the topmost: one under another that's walked is reached from it, after its parent.
  const roots = [...ids].filter((id) => {
    for (let at = get(id), i = 0; at && i < MAX_CHAIN; i++) {
      at = get(at.parent);
      if (at && ids.has(at.id)) return false;
    }
    return true;
  });
  const out: Op[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  /** What a parent's children copy, worked out once per parent. */
  const targets = new Map<string, string | null>();
  for (let i = 0; i < queue.length; i++) {
    if (work >= budget) return { ops: out, complete: false };
    const id = queue[i] as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = get(id);
    if (!node) continue;
    const mirrors = mirrorsOf(node);
    let target: string | null = null;
    if (mirrors) {
      if (targets.has(node.parent)) target = targets.get(node.parent) ?? null;
      else {
        const parent = get(node.parent);
        target = parent ? copyTarget(parent) : null;
        targets.set(node.parent, target);
      }
    }
    if (mirrors && target && get(mirrors)?.parent !== target) {
      const match = childOfOrigin(target, origin(mirrors));
      if (match && match !== mirrors) {
        fixed.set(id, match);
        out.push({ op: "set", id, prop: "mirrors", value: match });
      }
    }
    const kids = childIds(id);
    work += kids.length;
    for (const child of kids) queue.push(child);
  }
  return { ops: out, complete: true };
}
