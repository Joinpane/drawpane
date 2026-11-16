import { MAX_OPS_PER_TRANSACTION, type Op } from "@drawpane/model";

/** About 1 MB of JSON per commit: one log row each, far below SQLite's 2 MB row cap. */
export const CHUNK_CHARS = 1_000_000;

/**
 * Operations worked out a few at a time (a restore, a merge), committed in
 * chunks of about CHUNK_CHARS of JSON as they fill, so a change to a whole
 * large file never sits in memory at once. `flush` commits what's waiting;
 * `creates` says whether something waiting makes a node, for a caller
 * asking whether a parent is there.
 */
export class OpChunks {
  readonly #commit: (ops: Op[]) => void;
  readonly #limit: number;
  #ops: Op[] = [];
  #chars = 0;
  /** Nodes created by operations not committed yet. */
  readonly #creating = new Set<string>();
  /** Operations taken so far. */
  count = 0;

  constructor(commit: (ops: Op[]) => void, limit = CHUNK_CHARS) {
    this.#commit = commit;
    this.#limit = limit;
  }

  push(op: Op): void {
    const length = JSON.stringify(op).length;
    if (
      this.#ops.length > 0 &&
      (this.#chars + length > this.#limit || this.#ops.length >= MAX_OPS_PER_TRANSACTION)
    )
      this.flush();
    this.#ops.push(op);
    if (op.op === "create") this.#creating.add(op.id);
    this.#chars += length;
    this.count++;
  }

  /** Whether an operation waiting to be committed creates `id`. */
  creates(id: string): boolean {
    return this.#creating.has(id);
  }

  flush(): void {
    if (this.#ops.length === 0) return;
    const ops = this.#ops;
    this.#ops = [];
    this.#chars = 0;
    this.#creating.clear();
    this.#commit(ops);
  }
}
