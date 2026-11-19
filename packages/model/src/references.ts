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
 * The `set mirrors` operations that make every copy reference under the
 * nodes `ops` relinked (and the layers they made) copy a child of what its
 * parent copies, worked out on the file they left (`reader`), parents
 * before children: a fix one level down reads the level above as fixed.
 * Empty when there's nothing to fix.
 */
export function referenceFixes(reader: ReferenceReader, ops: readonly Op[]): Op[] {
  const ids = relinkedBy(ops);
  if (ids.size === 0) return [];
  // What each node copies, with the fixes so far.
  const fixed = new Map<string, string>();
  const mirrorsOf = (node: NodeRecord): string | null => {
    const own = fixed.get(node.id) ?? node.props.mirrors;
    return typeof own === "string" ? own : null;
  };
  const origin = (id: string): string => {
    let at = id;
    for (let i = 0; i < MAX_CHAIN; i++) {
      const node = reader.get(at);
      const next = node ? mirrorsOf(node) : null;
      if (!next || !reader.get(next)) return at;
      at = next;
    }
    return at;
  };
  /** What a node's children copy: its main layer, its main, or the component it's swapped to. */
  const copyTarget = (node: NodeRecord): string | null => {
    const mirrors = mirrorsOf(node);
    const instanceOf =
      node.type === "frame" && typeof node.props.instanceOf === "string"
        ? node.props.instanceOf
        : null;
    if (instanceOf && (!mirrors || reader.get(mirrors)?.props.instanceOf !== instanceOf))
      return instanceOf;
    return mirrors;
  };
  // Walked from the topmost: one under another that's walked is reached from it, after its parent.
  const roots = [...ids].filter((id) => {
    for (let at = reader.get(id), i = 0; at && i < MAX_CHAIN; i++) {
      at = reader.get(at.parent);
      if (at && ids.has(at.id)) return false;
    }
    return true;
  });
  const out: Op[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = reader.get(id);
    if (!node) continue;
    const mirrors = mirrorsOf(node);
    const parent = mirrors ? reader.get(node.parent) : undefined;
    const target = parent ? copyTarget(parent) : null;
    if (mirrors && target && reader.get(mirrors)?.parent !== target) {
      const from = origin(mirrors);
      const match = reader.childIds(target).find((child) => origin(child) === from);
      if (match && match !== mirrors) {
        fixed.set(id, match);
        out.push({ op: "set", id, prop: "mirrors", value: match });
      }
    }
    for (const child of reader.childIds(id)) queue.push(child);
  }
  return out;
}
