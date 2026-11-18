/**
 * The call ledger (decision 0021): every agent call a FileRoom ran, by
 * session and call id, with its result, the revision it committed and the
 * operations that undo it. It lives in the room's SQLite, written in the
 * same storage transaction as the call's commit, so it survives the room
 * sleeping and never disagrees with the document.
 *
 * It makes calls exactly-once: a call id seen before answers with the
 * recorded result instead of running again, whichever engine asks (an open
 * editor that went away halfway can ask whether its call committed). And it
 * is the session's undo history: undo and redo step over that session's own
 * calls, never anyone else's.
 */
import type { Op } from "@drawpane/model";
import { boundedPages } from "./node-tables";

/** Calls are kept this long: a repeated id within it answers as recorded, and undo reaches back as far. */
export const CALL_RETENTION_MS = 24 * 60 * 60_000;

export const CALL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_calls (
    session_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- The tool, or 'undo' and 'redo' for those.
    tool TEXT NOT NULL,
    -- The tool's title, as its change is labelled ("Render layers from JSX").
    label TEXT NOT NULL,
    -- The revision its change was last applied at; null when it changed nothing.
    revn INTEGER,
    result TEXT NOT NULL,
    -- What it changed, and what undoes that (a tool's calls only).
    ops TEXT,
    inverse TEXT,
    -- 'done', 'undone' (redo brings it back) or 'dropped' (a later call ended its redo).
    state TEXT NOT NULL,
    -- The revision its last undo landed at.
    undone_revn INTEGER,
    at INTEGER NOT NULL,
    PRIMARY KEY (session_id, call_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS agent_calls_at ON agent_calls (at);
`;

/** What the ledger says about a call. */
export interface RecordedCall {
  readonly sessionId: string;
  readonly callId: string;
  readonly tool: string;
  readonly label: string;
  readonly revn: number | null;
  readonly result: unknown;
}

/** A call on a session's undo or redo stack. */
export interface StepCall extends RecordedCall {
  readonly revn: number;
  readonly ops: Op[];
  readonly inverse: Op[];
  readonly undoneRevn: number | null;
}

type Row = {
  session_id: string;
  call_id: string;
  tool: string;
  label: string;
  revn: number | null;
  result: string;
  ops: string | null;
  inverse: string | null;
  undone_revn: number | null;
};

const recorded = (row: Row): RecordedCall => ({
  sessionId: row.session_id,
  callId: row.call_id,
  tool: row.tool,
  label: row.label,
  revn: row.revn,
  result: JSON.parse(row.result) as unknown,
});

const step = (row: Row): StepCall => ({
  ...recorded(row),
  revn: row.revn as number,
  ops: JSON.parse(row.ops ?? "[]") as Op[],
  inverse: JSON.parse(row.inverse ?? "[]") as Op[],
  undoneRevn: row.undone_revn,
});

/** The layers a call changed (made, set, moved or deleted). */
export function changedIds(...lists: ReadonlyArray<readonly Op[]>): Set<string> {
  const ids = new Set<string>();
  for (const ops of lists) for (const op of ops) ids.add(op.id);
  return ids;
}

/**
 * Of `ids`, those someone else's operations changed, or put a layer inside
 * (which undoing a call could take away with it).
 */
export function overlap(theirs: readonly Op[], ids: ReadonlySet<string>): string[] {
  const hit = new Set<string>();
  for (const op of theirs) {
    if (ids.has(op.id)) hit.add(op.id);
    if ((op.op === "create" || op.op === "move") && ids.has(op.parent)) hit.add(op.parent);
  }
  return [...hit];
}

/**
 * The first logged transaction after `since`, by anyone but `sessionId`
 * (by anyone at all when it's null), whose operations overlap `ids`: who,
 * and which.
 */
export function firstOverlap(
  sql: SqlStorage,
  since: number,
  sessionId: string | null,
  ids: ReadonlySet<string>,
): { userId: string; ids: string[] } | null {
  for (const row of loggedSince(sql, since, sessionId)) {
    const hit = overlap(row.ops, ids);
    if (hit.length > 0) return { userId: row.userId, ids: hit };
  }
  return null;
}

/**
 * The logged transactions after `since`, oldest first, by anyone but
 * `sessionId` (by anyone at all when it's null). The log keeps 10,000
 * transactions of up to a message each (typing in a text of 200,000
 * characters logs all of them every keystroke), so it's read a page bounded
 * by characters at a time, and a caller that stops early reads no further.
 */
export function* loggedSince(
  sql: SqlStorage,
  since: number,
  sessionId: string | null,
): Generator<{ userId: string; ops: Op[] }> {
  // Null leaves nobody out: `session_id IS NOT ?` with null is true of every row.
  const except = sessionId;
  const pages = boundedPages<number, { user_id: string; ops: string }>(
    since,
    (after, size) =>
      sql
        .exec<{ revn: number; n: number }>(
          "SELECT revn, LENGTH(ops) AS n FROM log WHERE revn > ? AND session_id IS NOT ? ORDER BY revn LIMIT ?",
          after,
          except,
          size,
        )
        .toArray()
        .map((row) => ({ key: row.revn, n: row.n })),
    (after, last) =>
      sql
        .exec<{ user_id: string; ops: string }>(
          "SELECT user_id, ops FROM log WHERE revn > ? AND revn <= ? AND session_id IS NOT ? ORDER BY revn",
          after,
          last,
          except,
        )
        .toArray(),
  );
  for (const rows of pages)
    for (const row of rows) yield { userId: row.user_id, ops: JSON.parse(row.ops) as Op[] };
}

export class CallLedger {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  /** The call, if this session made it. */
  get(sessionId: string, callId: string): RecordedCall | null {
    const row = this.#sql
      .exec<Row>(
        "SELECT * FROM agent_calls WHERE session_id = ? AND call_id = ? AND at > ?",
        sessionId,
        callId,
        Date.now() - CALL_RETENTION_MS,
      )
      .toArray()[0];
    return row ? recorded(row) : null;
  }

  /**
   * Records a call. Call inside the storage transaction that commits it. A
   * tool's call that changed something (it has `ops`) ends the session's redo.
   */
  recordCall(
    call: { sessionId: string; callId: string; userId: string; tool: string; label: string },
    revn: number | null,
    result: unknown,
    ops: readonly Op[] | null,
    inverse: readonly Op[] | null,
  ): void {
    if (revn !== null && ops !== null)
      this.#sql.exec(
        "UPDATE agent_calls SET state = 'dropped' WHERE session_id = ? AND state = 'undone'",
        call.sessionId,
      );
    this.#sql.exec(
      `INSERT INTO agent_calls (session_id, call_id, user_id, tool, label, revn, result, ops, inverse, state, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', ?)`,
      call.sessionId,
      call.callId,
      call.userId,
      call.tool,
      call.label,
      revn,
      JSON.stringify(result ?? null),
      ops ? JSON.stringify(ops) : null,
      inverse ? JSON.stringify(inverse) : null,
      Date.now(),
    );
  }

  /** The session's latest call that undo would take back, if any. */
  lastDone(sessionId: string): StepCall | null {
    const row = this.#sql
      .exec<Row>(
        `SELECT * FROM agent_calls WHERE session_id = ? AND state = 'done' AND revn IS NOT NULL
           AND ops IS NOT NULL AND at > ? ORDER BY revn DESC LIMIT 1`,
        sessionId,
        Date.now() - CALL_RETENTION_MS,
      )
      .toArray()[0];
    return row ? step(row) : null;
  }

  /** The session's call that redo would bring back, if any: the one undone last. */
  lastUndone(sessionId: string): StepCall | null {
    const row = this.#sql
      .exec<Row>(
        `SELECT * FROM agent_calls WHERE session_id = ? AND state = 'undone' AND at > ?
          ORDER BY undone_revn DESC LIMIT 1`,
        sessionId,
        Date.now() - CALL_RETENTION_MS,
      )
      .toArray()[0];
    return row ? step(row) : null;
  }

  /** Marks a call undone at `revn`; `redo` is what brings it back. */
  markUndone(call: StepCall, revn: number, redo: readonly Op[]): void {
    this.#sql.exec(
      `UPDATE agent_calls SET state = 'undone', undone_revn = ?, ops = ?
        WHERE session_id = ? AND call_id = ?`,
      revn,
      JSON.stringify(redo),
      call.sessionId,
      call.callId,
    );
  }

  /** Marks a call redone at `revn`; `inverse` undoes it again. */
  markRedone(call: StepCall, revn: number, inverse: readonly Op[]): void {
    this.#sql.exec(
      `UPDATE agent_calls SET state = 'done', revn = ?, inverse = ?
        WHERE session_id = ? AND call_id = ?`,
      revn,
      JSON.stringify(inverse),
      call.sessionId,
      call.callId,
    );
  }

  /** Forgets calls past retention. */
  sweep(now = Date.now()): void {
    this.#sql.exec("DELETE FROM agent_calls WHERE at <= ?", now - CALL_RETENTION_MS);
  }
}
