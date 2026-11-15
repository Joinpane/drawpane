/**
 * Agent sessions (decision 0021): an agent writes inside a session, started
 * on a file with a write token. A live session writes to the file itself; a
 * branch session makes a branch (decision 0012) and writes only there, so
 * main is never touched until a person merges it.
 *
 * A session belongs to the person and the token that started it. Every call
 * checks again that the person can still edit the session's file, exactly
 * as the API does, so a removal or a merged branch stops it at once.
 */
import { newId } from "@drawpane/model";
import { requireFileRole } from "../api/access";
import { makeBranch } from "../api/branches";
import type { Env, User } from "../env";
import { HttpError } from "../lib/http";

export type SessionMode = "live" | "branch";

export interface AgentSession {
  readonly id: string;
  readonly name: string;
  readonly mode: SessionMode;
  /** The file it was started on. */
  readonly fileId: string;
  /** Where it writes: the file itself when live, its branch otherwise. */
  readonly targetId: string;
  readonly createdAt: number;
  readonly endedAt: number | null;
}

/** Who's asking: the person and the token they asked with. */
export interface Caller {
  readonly user: User;
  readonly tokenId: string;
}

/** Why a session can't be used or started, worded for the model. */
export class SessionError extends Error {
  override readonly name = "SessionError";
}

/** Last use is recorded at most this often. */
const LAST_USED_GRANULARITY = 60_000;

interface SessionRow {
  id: string;
  user_id: string;
  token_id: string | null;
  file_id: string;
  target_id: string;
  mode: SessionMode;
  name: string;
  created_at: number;
  last_used_at: number;
  ended_at: number | null;
}

const toSession = (row: SessionRow): AgentSession => ({
  id: row.id,
  name: row.name,
  mode: row.mode,
  fileId: row.file_id,
  targetId: row.target_id,
  createdAt: row.created_at,
  endedAt: row.ended_at,
});

/** "Claude, for Ana": the agent's name and the first name of the person it works for. */
export function sessionName(agent: string, person: string): string {
  const first = person.trim().split(/\s+/)[0] || person;
  return `${agent.trim() || "Agent"}, for ${first}`;
}

/** The file, checked: the person can edit it, and it isn't in trash. */
async function editableFile(env: Env, userId: string, fileId: string) {
  try {
    const { file } = await requireFileRole(env, userId, fileId, "editor");
    if (file.deleted_at !== null)
      throw new SessionError("That file is in trash. Restore it before working on it.");
    return file;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.status === 403) {
      const merged = await env.DB.prepare(
        "SELECT 1 AS merged FROM branches WHERE file_id = ? AND merged_at IS NOT NULL",
      )
        .bind(fileId)
        .first<{ merged: number }>();
      throw new SessionError(
        merged
          ? `${fileId} is a branch that was merged: it's read-only history now. Start a new session.`
          : `You can view ${fileId} but not edit it, so an agent can't either. Ask its team for edit access.`,
      );
    }
    throw new SessionError(`No file ${fileId} that you can open. Use list_files to find one.`);
  }
}

/**
 * Starts a session on a file the person can edit: live, writing to it, or
 * on a new branch of it.
 */
export async function startSession(
  env: Env,
  caller: Caller,
  options: { fileId: string; mode: SessionMode; agent?: string; branchName?: string },
): Promise<AgentSession> {
  const file = await editableFile(env, caller.user.id, options.fileId);
  const name = sessionName(options.agent ?? "Agent", caller.user.name);
  let targetId = file.id;
  if (options.mode === "branch") {
    if (file.branch_of)
      throw new SessionError(
        `${file.id} is a branch. Start a live session to work on it, or a branch session on its main file, ${file.branch_of}.`,
      );
    try {
      const branch = await makeBranch(env, caller.user, file, options.branchName?.trim() || name);
      targetId = branch.id;
    } catch (error) {
      if (error instanceof HttpError) throw new SessionError(error.message);
      throw error;
    }
  }
  const now = Date.now();
  const row: SessionRow = {
    id: newId(),
    user_id: caller.user.id,
    token_id: caller.tokenId,
    file_id: file.id,
    target_id: targetId,
    mode: options.mode,
    name,
    created_at: now,
    last_used_at: now,
    ended_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO agent_sessions (id, user_id, token_id, file_id, target_id, mode, name, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.user_id,
      row.token_id,
      row.file_id,
      row.target_id,
      row.mode,
      row.name,
      row.created_at,
      row.last_used_at,
    )
    .run();
  return toSession(row);
}

async function ownSession(env: Env, caller: Caller, sessionId: string): Promise<SessionRow> {
  const row = await env.DB.prepare("SELECT * FROM agent_sessions WHERE id = ? AND user_id = ?")
    .bind(sessionId, caller.user.id)
    .first<SessionRow>();
  // Another token's session is as unknown as one that doesn't exist.
  if (!row || row.token_id !== caller.tokenId)
    throw new SessionError(`No session ${sessionId}. Start one with start_session.`);
  return row;
}

/**
 * A session the caller can write with now: theirs, from this token, not
 * ended, and its file one they can still edit (a merged branch can't be).
 */
export async function requireSession(
  env: Env,
  caller: Caller,
  sessionId: string,
): Promise<AgentSession> {
  const row = await ownSession(env, caller, sessionId);
  if (row.ended_at !== null)
    throw new SessionError(`Session ${sessionId} has ended. Start a new one with start_session.`);
  await editableFile(env, caller.user.id, row.target_id);
  const now = Date.now();
  if (now - row.last_used_at > LAST_USED_GRANULARITY)
    await env.DB.prepare("UPDATE agent_sessions SET last_used_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run();
  return toSession(row);
}

/** Ends a session: it takes no more calls. Ending one that has ended already is fine. */
export async function endSession(
  env: Env,
  caller: Caller,
  sessionId: string,
): Promise<AgentSession> {
  const row = await ownSession(env, caller, sessionId);
  const endedAt = row.ended_at ?? Date.now();
  if (row.ended_at === null)
    await env.DB.prepare("UPDATE agent_sessions SET ended_at = ? WHERE id = ?")
      .bind(endedAt, row.id)
      .run();
  return toSession({ ...row, ended_at: endedAt });
}
