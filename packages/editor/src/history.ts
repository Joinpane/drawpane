/**
 * Undo and redo for your own edits only, like every multiplayer editor: undo
 * never reverts a teammate's work. Each entry holds the operations that undo
 * it. A gesture (a drag, a scrub) is one entry however many commits it made.
 */
import { ModelError, type Op } from "@drawpane/model";

export interface HistoryEntry {
  readonly label: string;
  /** Operations that undo the entry, in the order they must run. */
  readonly undo: readonly Op[];
  /** Selection to restore after undo or redo. */
  readonly selection: readonly string[];
}

export type Commit = (ops: readonly Op[]) => Op[];

const LIMIT = 500;

export class History {
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  /**
   * The group being recorded. `marks` holds, for each nested group inside
   * it, how much undo there was when it began, so a nested preview can be
   * discarded without touching what the outer group did.
   */
  #open: { label: string; undo: Op[][]; selection: readonly string[]; marks: number[] } | null =
    null;
  readonly #listeners = new Set<() => void>();

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }
  get canRedo(): boolean {
    return this.#redo.length > 0;
  }
  /** Whether a group (a gesture) is being recorded. */
  get grouping(): boolean {
    return this.#open !== null;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  /** Starts grouping commits into one entry. Calls nest; the outermost `end` closes it. */
  begin(label: string, selection: readonly string[]): void {
    if (this.#open) {
      this.#open.marks.push(this.#open.undo.length);
      return;
    }
    this.#open = { label, undo: [], selection, marks: [] };
  }

  end(): void {
    const open = this.#open;
    if (!open) return;
    if (open.marks.length > 0) {
      open.marks.pop();
      return;
    }
    this.#open = null;
    if (open.undo.length === 0) return;
    this.#push({ label: open.label, undo: open.undo.reverse().flat(), selection: open.selection });
  }

  /**
   * Closes the innermost open group and reverts what it did, leaving no undo
   * or redo entry: a preview you backed out of. An outer group stays open
   * with what it did before (fonts previewed while typing, say). Returns
   * false when no group is open.
   */
  discard(commit: Commit): boolean {
    const open = this.#open;
    if (!open) return false;
    const mark = open.marks.pop();
    const from = mark ?? 0;
    const undone = open.undo.splice(from).reverse().flat();
    if (mark === undefined) this.#open = null;
    if (undone.length > 0) applyBestEffort(commit, undone);
    return true;
  }

  /** Records the inverse of a commit, either into the open group or as its own entry. */
  record(label: string, inverse: readonly Op[], selection: readonly string[]): void {
    if (inverse.length === 0) return;
    if (this.#open) {
      this.#open.undo.push([...inverse]);
      return;
    }
    this.#push({ label, undo: inverse, selection });
  }

  #push(entry: HistoryEntry): void {
    this.#undo.push(entry);
    if (this.#undo.length > LIMIT) this.#undo.shift();
    this.#redo = [];
    this.#changed();
  }

  /** Undoes the latest entry. Returns the selection to restore, or null when there is nothing to undo. */
  undo(commit: Commit, selection: readonly string[]): readonly string[] | null {
    return this.#step(this.#undo, this.#redo, commit, selection);
  }

  redo(commit: Commit, selection: readonly string[]): readonly string[] | null {
    return this.#step(this.#redo, this.#undo, commit, selection);
  }

  clear(): void {
    this.#undo = [];
    this.#redo = [];
    this.#changed();
  }

  #step(from: HistoryEntry[], to: HistoryEntry[], commit: Commit, selection: readonly string[]) {
    for (;;) {
      const entry = from.pop();
      if (!entry) return null;
      const inverse = applyBestEffort(commit, entry.undo);
      if (inverse === null) continue; // Nothing of it applies any more (a teammate deleted it): skip.
      to.push({ label: entry.label, undo: inverse, selection });
      this.#changed();
      return entry.selection;
    }
  }
}

/**
 * Applies operations as one commit; when that fails because teammates changed
 * the file, keeps only the operations that still apply. Returns the inverse,
 * or null when nothing applied.
 */
export function applyBestEffort(commit: Commit, ops: readonly Op[]): Op[] | null {
  try {
    return commit(ops);
  } catch (error) {
    if (!(error instanceof ModelError)) throw error;
  }
  const inverses: Op[][] = [];
  for (const op of ops) {
    try {
      inverses.push(commit([op]));
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
    }
  }
  return inverses.length === 0 ? null : inverses.reverse().flat();
}
