/**
 * Pending edits across a change of the file's form (decision 0029): the
 * room converted it to compact copies, or a rollback put it back
 * materialized, while this client held edits it hadn't sent. Ids those
 * edits hold in values (a reading order, a prototype link, a flow's start)
 * may name copy layers, whose ids change with the form. They're found in
 * the new form as the converter renames them: a copy is the layer under
 * its parent (found the same way) that copies what it copies (its
 * `mirrors`, found the same way), which is how the converter matches a
 * materialized copy to its derived id, both ways. An edit holding an id
 * that can't be found is dropped, as the room refuses it from a client in
 * the old form (`#fromOldForm` in file-room.ts), and never sent stale.
 */
import { heldNodeIds, type NodeRecord, type Op, type Props, renameHeldIds } from "@drawpane/model";
import type { Doc } from "./doc";

/** What the document in the old form said of a layer an edit names. */
interface Before {
  readonly parent: string;
  readonly mirrors: string | null;
}

/** The ids held in an operation's values: a create's properties, or the value a set gives. */
function heldBy(op: Op): ReturnType<typeof heldNodeIds> | null {
  if (op.op === "create") return heldNodeIds(op.props);
  if (op.op === "set" && op.value !== null && op.value !== undefined)
    return heldNodeIds({ [op.prop]: op.value } as Props);
  return null;
}

export class FormChange {
  /** Layers the edits name, and what they're copies of, as the old form had them (null: absent). */
  readonly #before = new Map<string, Before | null>();
  /** Ids found in the new form (null: not found). */
  readonly #found = new Map<string, string | null>();

  /** Reads what `edits` name from `doc`, still in the old form. */
  constructor(doc: Doc, edits: Iterable<readonly Op[]>) {
    for (const ops of edits)
      for (const op of ops) {
        const held = heldBy(op);
        if (!held) continue;
        for (const id of [...held.layers, ...held.others]) this.#read(doc, id);
      }
  }

  #read(doc: Doc, id: string): void {
    const stack = [id];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      if (this.#before.has(at)) continue;
      const node: NodeRecord | undefined = doc.get(at);
      const mirrors = node?.props.mirrors;
      const before = node
        ? { parent: node.parent, mirrors: typeof mirrors === "string" ? mirrors : null }
        : null;
      this.#before.set(at, before);
      // A copy is found through its parent and what it copies.
      if (before?.mirrors) stack.push(before.parent, before.mirrors);
    }
  }

  /** `id` in `doc`, in the new form: itself when it's there, else its copy's new id; null when neither. */
  #find(doc: Doc, id: string, seen = new Set<string>()): string | null {
    if (doc.has(id)) return id;
    const known = this.#found.get(id);
    if (known !== undefined) return known;
    const before = this.#before.get(id);
    let found: string | null = null;
    if (before?.mirrors && !seen.has(id)) {
      seen.add(id);
      const parent = this.#find(doc, before.parent, seen);
      const source = this.#find(doc, before.mirrors, seen);
      if (parent !== null && source !== null)
        found =
          doc.childIds(parent).find((child) => doc.get(child)?.props.mirrors === source) ?? null;
    }
    this.#found.set(id, found);
    return found;
  }

  /**
   * `ops` as they apply to `doc` in the new form (earlier pending edits
   * applied): layer ids they hold found there, or null when one can't be,
   * or an id held for something else (a style, a variable, a main) isn't
   * there. Ids an earlier operation of theirs creates are theirs.
   */
  remap(doc: Doc, ops: readonly Op[]): Op[] | null {
    const made = new Set<string>();
    const exists = (id: string) => made.has(id) || doc.has(id);
    const out: Op[] = [];
    for (const op of ops) {
      const held = heldBy(op);
      if (op.op === "create") made.add(op.id);
      if (!held || (held.layers.length === 0 && held.others.length === 0)) {
        out.push(op);
        continue;
      }
      if (held.others.some((id) => !exists(id))) return null;
      const renamed = new Map<string, string>();
      for (const id of held.layers) {
        if (exists(id)) continue;
        const to = this.#find(doc, id);
        if (to === null) return null;
        renamed.set(id, to);
      }
      if (renamed.size === 0) {
        out.push(op);
        continue;
      }
      const rename = (id: string) => renamed.get(id);
      if (op.op === "create") {
        out.push({ ...op, props: renameHeldIds(op.props, rename) ?? op.props });
      } else if (op.op === "set") {
        const value = renameHeldIds({ [op.prop]: op.value } as Props, rename);
        out.push(
          value ? ({ ...op, value: (value as Record<string, unknown>)[op.prop] } as Op) : op,
        );
      }
    }
    return out;
  }
}
