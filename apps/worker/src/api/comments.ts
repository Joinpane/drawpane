/**
 * Comments API, mounted under `/api`. Threads and replies live in D1. After
 * every write the Worker asks the file's room to relay the change, so
 * everyone in the file sees it at once.
 *
 * Permissions: anyone who can open the file can read, start threads, reply
 * (which reopens a resolved thread), resolve and reopen (commenting is collaboration, not editing). Only a
 * message's author can edit it. Authors can delete their own messages and
 * threads; team owners can delete anything.
 */
import {
  CommentEdit,
  type CommentEvent,
  type CommentMessage,
  type CommentPerson,
  type CommentThread,
  CommentThreadPatch,
  NewCommentReply,
  NewCommentThread,
  newId,
} from "@drawpane/model";
import { type Context, Hono } from "hono";
import { requireUser } from "../auth/session";
import type { AppContext, Env, Role, User } from "../env";
import { badRequest, conflict, forbidden, notFound } from "../lib/http";
import { type FileRow, readBody, requireFileRole } from "./access";

/** Threads returned by one list call. Files with more are rare; the oldest drop off. */
const LIST_LIMIT = 500;

type Status = "open" | "resolved" | "all";

interface ThreadRow {
  id: string;
  file_id: string;
  page_id: string;
  x: number;
  y: number;
  node_id: string | null;
  node_x: number | null;
  node_y: number | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: number;
  edited_at: number | null;
}

interface MentionRow {
  comment_id: string;
  user_id: string;
  name: string;
}

const THREAD_COLUMNS = `t.id, t.file_id, t.page_id, t.x, t.y, t.node_id, t.node_x, t.node_y,
  t.created_by, cu.name AS created_by_name, t.created_at, t.updated_at,
  t.resolved_at, t.resolved_by, ru.name AS resolved_by_name`;
const THREAD_FROM = `comment_threads t
  LEFT JOIN users cu ON cu.id = t.created_by
  LEFT JOIN users ru ON ru.id = t.resolved_by`;

const person = (id: string | null, name: string | null): CommentPerson | null =>
  id && name !== null ? { id, name } : null;

/** Loads threads with their messages and mentions in three queries. */
async function loadThreads(
  db: D1Database,
  fileId: string,
  options: { threadId?: string; status?: Status } = {},
): Promise<CommentThread[]> {
  const where = ["t.file_id = ?1"];
  if (options.threadId) where.push("t.id = ?2");
  if (options.status === "open") where.push("t.resolved_at IS NULL");
  if (options.status === "resolved") where.push("t.resolved_at IS NOT NULL");
  const filter = where.join(" AND ");
  const binds = options.threadId ? [fileId, options.threadId] : [fileId];
  const threadIds = `SELECT t.id FROM comment_threads t WHERE ${filter} ORDER BY t.updated_at DESC LIMIT ${LIST_LIMIT}`;

  const [threads, messages, mentions] = await db.batch<ThreadRow | MessageRow | MentionRow>([
    db
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM ${THREAD_FROM} WHERE ${filter}
          ORDER BY t.updated_at DESC LIMIT ${LIST_LIMIT}`,
      )
      .bind(...binds),
    db
      .prepare(
        `SELECT c.id, c.thread_id, c.author_id, u.name AS author_name, c.body, c.created_at, c.edited_at
           FROM comments c LEFT JOIN users u ON u.id = c.author_id
          WHERE c.thread_id IN (${threadIds})
          ORDER BY c.created_at, c.id`,
      )
      .bind(...binds),
    db
      .prepare(
        `SELECT m.comment_id, m.user_id, u.name FROM comment_mentions m
           JOIN users u ON u.id = m.user_id
           JOIN comments c ON c.id = m.comment_id
          WHERE c.thread_id IN (${threadIds})
          ORDER BY m.created_at, u.name`,
      )
      .bind(...binds),
  ]);

  const mentionsBy = new Map<string, CommentPerson[]>();
  for (const row of (mentions?.results ?? []) as MentionRow[]) {
    const list = mentionsBy.get(row.comment_id) ?? [];
    list.push({ id: row.user_id, name: row.name });
    mentionsBy.set(row.comment_id, list);
  }
  const messagesBy = new Map<string, CommentMessage[]>();
  for (const row of (messages?.results ?? []) as MessageRow[]) {
    const list = messagesBy.get(row.thread_id) ?? [];
    list.push({
      id: row.id,
      author: person(row.author_id, row.author_name),
      body: row.body,
      mentions: mentionsBy.get(row.id) ?? [],
      createdAt: row.created_at,
      editedAt: row.edited_at,
    });
    messagesBy.set(row.thread_id, list);
  }
  return ((threads?.results ?? []) as ThreadRow[]).map((row) => ({
    id: row.id,
    fileId: row.file_id,
    pageId: row.page_id,
    anchor: {
      x: row.x,
      y: row.y,
      nodeId: row.node_id,
      offset:
        row.node_id !== null && row.node_x !== null && row.node_y !== null
          ? { x: row.node_x, y: row.node_y }
          : null,
    },
    author: person(row.created_by, row.created_by_name),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolvedBy: person(row.resolved_by, row.resolved_by_name),
    messages: messagesBy.get(row.id) ?? [],
  }));
}

async function loadThread(db: D1Database, fileId: string, threadId: string) {
  const [thread] = await loadThreads(db, fileId, { threadId });
  if (!thread) throw notFound("That comment was deleted. Refresh the comments list.");
  return thread;
}

/** File access for a comment write: the file must be live, and the caller at least a viewer. */
async function fileForWrite(c: Context<AppContext>, user: User) {
  const access = await requireFileRole(c.env, user.id, c.req.param("fileId") ?? "", "viewer");
  if (access.file.deleted_at !== null)
    throw conflict("This file is in the trash. Restore it to comment.");
  return access;
}

/** Checks that everyone mentioned is on the file's team; returns the ids without duplicates. */
async function validMentions(db: D1Database, file: FileRow, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return unique;
  const placeholders = unique.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await db
    .prepare(`SELECT user_id FROM team_members WHERE team_id = ?1 AND user_id IN (${placeholders})`)
    .bind(file.team_id, ...unique)
    .all<{ user_id: string }>();
  if (results.length !== unique.length)
    throw badRequest("Someone you mentioned isn't on this team. Pick people from the list.");
  return unique;
}

function mentionInserts(
  db: D1Database,
  commentId: string,
  fileId: string,
  ids: readonly string[],
  now: number,
) {
  return ids.map((userId) =>
    db
      .prepare(
        "INSERT INTO comment_mentions (comment_id, user_id, file_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(commentId, userId, fileId, now),
  );
}

/** Tells everyone in the file. A failed relay never fails the write; clients refetch on reconnect. */
async function relay(env: Env, fileId: string, event: CommentEvent): Promise<void> {
  try {
    await env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId)).broadcastComments(event);
  } catch (error) {
    console.error("comment relay failed", error);
  }
}

interface MessageAccess {
  id: string;
  thread_id: string;
  author_id: string | null;
  first_id: string;
  thread_author: string | null;
}

async function messageFor(db: D1Database, fileId: string, threadId: string, commentId: string) {
  const row = await db
    .prepare(
      `SELECT c.id, c.thread_id, c.author_id, t.created_by AS thread_author,
              (SELECT f.id FROM comments f WHERE f.thread_id = t.id ORDER BY f.created_at, f.id LIMIT 1) AS first_id
         FROM comments c JOIN comment_threads t ON t.id = c.thread_id
        WHERE c.id = ? AND t.id = ? AND t.file_id = ?`,
    )
    .bind(commentId, threadId, fileId)
    .first<MessageAccess>();
  if (!row) throw notFound("That comment was deleted. Refresh the comments list.");
  return row;
}

async function deleteThread(c: Context<AppContext>, fileId: string, threadId: string) {
  await c.env.DB.prepare("DELETE FROM comment_threads WHERE id = ? AND file_id = ?")
    .bind(threadId, fileId)
    .run();
  await relay(c.env, fileId, { kind: "deleted", threadId });
}

const canDelete = (role: Role, userId: string, authorId: string | null) =>
  role === "owner" || (authorId !== null && authorId === userId);

export const comments = new Hono<AppContext>()
  .get("/files/:fileId/comments", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "viewer");
    const raw = c.req.query("status") ?? "all";
    if (raw !== "open" && raw !== "resolved" && raw !== "all")
      throw badRequest("Filter by status open, resolved or all.");
    return c.json({ threads: await loadThreads(c.env.DB, file.id, { status: raw }) });
  })

  .get("/files/:fileId/mentions", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "viewer");
    const { results } = await c.env.DB.prepare(
      `SELECT u.id, u.name FROM team_members m JOIN users u ON u.id = m.user_id
        WHERE m.team_id = ? ORDER BY u.name COLLATE NOCASE`,
    )
      .bind(file.team_id)
      .all<CommentPerson>();
    return c.json({ people: results });
  })

  .post("/files/:fileId/comments", async (c) => {
    const user = requireUser(c);
    const { file } = await fileForWrite(c, user);
    const body = await readBody(c, NewCommentThread);
    const mentions = await validMentions(c.env.DB, file, body.mentions);
    const threadId = newId();
    const commentId = newId();
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO comment_threads (id, file_id, page_id, x, y, node_id, node_x, node_y, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        threadId,
        file.id,
        body.pageId,
        body.x,
        body.y,
        body.nodeId,
        body.offset?.x ?? null,
        body.offset?.y ?? null,
        user.id,
        now,
        now,
      ),
      c.env.DB.prepare(
        "INSERT INTO comments (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(commentId, threadId, user.id, body.body, now),
      ...mentionInserts(c.env.DB, commentId, file.id, mentions, now),
    ]);
    const thread = await loadThread(c.env.DB, file.id, threadId);
    await relay(c.env, file.id, { kind: "thread", thread });
    return c.json({ thread }, 201);
  })

  .post("/files/:fileId/comments/:threadId/replies", async (c) => {
    const user = requireUser(c);
    const { file } = await fileForWrite(c, user);
    const threadId = c.req.param("threadId");
    const body = await readBody(c, NewCommentReply);
    const exists = await c.env.DB.prepare(
      "SELECT id FROM comment_threads WHERE id = ? AND file_id = ?",
    )
      .bind(threadId, file.id)
      .first();
    if (!exists) throw notFound("That thread was deleted. Start a new comment instead.");
    const mentions = await validMentions(c.env.DB, file, body.mentions);
    const commentId = newId();
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO comments (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(commentId, threadId, user.id, body.body, now),
      // A reply means the conversation is active again, so it reopens a resolved thread.
      c.env.DB.prepare(
        "UPDATE comment_threads SET updated_at = ?, resolved_at = NULL, resolved_by = NULL WHERE id = ?",
      ).bind(now, threadId),
      ...mentionInserts(c.env.DB, commentId, file.id, mentions, now),
    ]);
    const thread = await loadThread(c.env.DB, file.id, threadId);
    await relay(c.env, file.id, { kind: "thread", thread });
    return c.json({ thread }, 201);
  })

  .patch("/files/:fileId/comments/:threadId", async (c) => {
    const user = requireUser(c);
    const { file, role } = await fileForWrite(c, user);
    const threadId = c.req.param("threadId");
    const { resolved, anchor } = await readBody(c, CommentThreadPatch);
    const row = await c.env.DB.prepare(
      "SELECT created_by FROM comment_threads WHERE id = ? AND file_id = ?",
    )
      .bind(threadId, file.id)
      .first<{ created_by: string | null }>();
    if (!row) throw notFound("That comment was deleted. Refresh the comments list.");
    // Anyone who can comment can resolve; moving someone else's pin takes edit access.
    if (anchor && role === "viewer" && row.created_by !== user.id)
      throw forbidden("Only the person who started this thread, or an editor, can move it.");
    const now = Date.now();
    const writes: D1PreparedStatement[] = [];
    if (resolved !== undefined) {
      writes.push(
        c.env.DB.prepare(
          `UPDATE comment_threads SET resolved_at = ?, resolved_by = ?, updated_at = ?
            WHERE id = ? AND file_id = ?`,
        ).bind(resolved ? now : null, resolved ? user.id : null, now, threadId, file.id),
      );
    }
    if (anchor) {
      // Moving a pin isn't activity: it leaves updated_at (and list order) alone.
      writes.push(
        c.env.DB.prepare(
          `UPDATE comment_threads SET x = ?, y = ?, node_id = ?, node_x = ?, node_y = ?
            WHERE id = ? AND file_id = ?`,
        ).bind(
          anchor.x,
          anchor.y,
          anchor.nodeId,
          anchor.offset?.x ?? null,
          anchor.offset?.y ?? null,
          threadId,
          file.id,
        ),
      );
    }
    await c.env.DB.batch(writes);
    const thread = await loadThread(c.env.DB, file.id, threadId);
    await relay(c.env, file.id, { kind: "thread", thread });
    return c.json({ thread });
  })

  .delete("/files/:fileId/comments/:threadId", async (c) => {
    const user = requireUser(c);
    const { file, role } = await fileForWrite(c, user);
    const threadId = c.req.param("threadId");
    const row = await c.env.DB.prepare(
      "SELECT created_by FROM comment_threads WHERE id = ? AND file_id = ?",
    )
      .bind(threadId, file.id)
      .first<{ created_by: string | null }>();
    if (!row) throw notFound("That comment was already deleted.");
    if (!canDelete(role, user.id, row.created_by))
      throw forbidden("Only the person who started this thread, or a team owner, can delete it.");
    await deleteThread(c, file.id, threadId);
    return c.json({ ok: true });
  })

  .patch("/files/:fileId/comments/:threadId/messages/:commentId", async (c) => {
    const user = requireUser(c);
    const { file } = await fileForWrite(c, user);
    const { threadId, commentId } = c.req.param();
    const message = await messageFor(c.env.DB, file.id, threadId, commentId);
    if (message.author_id !== user.id) throw forbidden("You can only edit your own comments.");
    const body = await readBody(c, CommentEdit);
    const mentions = await validMentions(c.env.DB, file, body.mentions);
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?").bind(
        body.body,
        now,
        commentId,
      ),
      c.env.DB.prepare("UPDATE comment_threads SET updated_at = ? WHERE id = ?").bind(
        now,
        threadId,
      ),
      c.env.DB.prepare("DELETE FROM comment_mentions WHERE comment_id = ?").bind(commentId),
      ...mentionInserts(c.env.DB, commentId, file.id, mentions, now),
    ]);
    const thread = await loadThread(c.env.DB, file.id, threadId);
    await relay(c.env, file.id, { kind: "thread", thread });
    return c.json({ thread });
  })

  .delete("/files/:fileId/comments/:threadId/messages/:commentId", async (c) => {
    const user = requireUser(c);
    const { file, role } = await fileForWrite(c, user);
    const { threadId, commentId } = c.req.param();
    const message = await messageFor(c.env.DB, file.id, threadId, commentId);
    if (message.first_id === message.id) {
      // The first message is the thread: deleting it deletes the replies too.
      if (!canDelete(role, user.id, message.thread_author ?? message.author_id))
        throw forbidden("Only the person who started this thread, or a team owner, can delete it.");
      await deleteThread(c, file.id, threadId);
      return c.json({ ok: true, threadDeleted: true });
    }
    if (!canDelete(role, user.id, message.author_id))
      throw forbidden("You can only delete your own comments.");
    await c.env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(commentId).run();
    const thread = await loadThread(c.env.DB, file.id, threadId);
    await relay(c.env, file.id, { kind: "thread", thread });
    return c.json({ ok: true, threadDeleted: false, thread });
  });
