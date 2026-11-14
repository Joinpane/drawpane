/**
 * The inbox: what each person should hear about, mounted under `/api`.
 *
 * Comment writes call the helpers below, which return statements to run in
 * the same batch as the write, so a notification never exists without its
 * comment (or the other way round):
 * - a mention notifies the person mentioned;
 * - a reply notifies everyone else already in the thread;
 * - resolving a thread notifies whoever started it.
 * Nobody hears about their own actions. A comment edited to mention someone
 * new notifies them once; a mention taken out takes its unread notification
 * with it, and reopening a thread takes back an unread "resolved".
 *
 * Listing shows only files the person can still open: on one of their
 * teams, and not in the trash.
 */
import { ID_PATTERN, newId } from "@drawpane/model";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/session";
import type { AppContext } from "../env";
import { readBody } from "./access";

export type NotificationKind = "mention" | "reply" | "resolved";

/** Items per page of the inbox. */
const PAGE = 30;
/** How much of a comment the inbox shows. */
const EXCERPT = 160;

const insert = (
  db: D1Database,
  n: {
    userId: string;
    kind: NotificationKind;
    fileId: string;
    threadId: string;
    commentId: string | null;
    actorId: string;
    now: number;
  },
) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO notifications (id, user_id, kind, file_id, thread_id, comment_id, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId(), n.userId, n.kind, n.fileId, n.threadId, n.commentId, n.actorId, n.now);

/**
 * A new comment, starting a thread or replying in one: the people it
 * mentions hear "mention", everyone else in the thread "reply".
 */
export async function commentNotifications(
  db: D1Database,
  c: {
    fileId: string;
    threadId: string;
    commentId: string;
    actorId: string;
    mentions: readonly string[];
    /** Whether the thread already existed: its people hear about a reply. */
    reply: boolean;
    now: number;
  },
): Promise<D1PreparedStatement[]> {
  const mentioned = new Set(c.mentions.filter((id) => id !== c.actorId));
  const statements = [...mentioned].map((userId) =>
    insert(db, { ...c, userId, kind: "mention", commentId: c.commentId }),
  );
  if (!c.reply) return statements;
  // Everyone already in the thread: who started it, and who wrote in it.
  const { results } = await db
    .prepare(
      `SELECT created_by AS id FROM comment_threads WHERE id = ?1 AND created_by IS NOT NULL
       UNION SELECT author_id FROM comments WHERE thread_id = ?1 AND author_id IS NOT NULL`,
    )
    .bind(c.threadId)
    .all<{ id: string }>();
  for (const { id } of results) {
    if (id === c.actorId || mentioned.has(id)) continue;
    statements.push(insert(db, { ...c, userId: id, kind: "reply", commentId: c.commentId }));
  }
  return statements;
}

/** A comment edited: newly mentioned people hear about it; a mention taken out is taken back if unread. */
export function editNotifications(
  db: D1Database,
  c: {
    fileId: string;
    threadId: string;
    commentId: string;
    actorId: string;
    mentions: readonly string[];
    now: number;
  },
): D1PreparedStatement[] {
  const mentioned = [...new Set(c.mentions)].filter((id) => id !== c.actorId);
  const keep = mentioned.length > 0 ? mentioned.map((_, i) => `?${i + 2}`).join(", ") : "''";
  return [
    db
      .prepare(
        `DELETE FROM notifications WHERE comment_id = ?1 AND kind = 'mention' AND read_at IS NULL
           AND user_id NOT IN (${keep})`,
      )
      .bind(c.commentId, ...mentioned),
    // Already notified (read or not): INSERT OR IGNORE leaves them be.
    ...mentioned.map((userId) => insert(db, { ...c, userId, kind: "mention" })),
  ];
}

/** A thread resolved (or reopened): its starter hears it was resolved, unless they did it. */
export function resolveNotifications(
  db: D1Database,
  t: {
    fileId: string;
    threadId: string;
    starterId: string | null;
    actorId: string;
    resolved: boolean;
    now: number;
  },
): D1PreparedStatement[] {
  if (!t.starterId) return [];
  // One "resolved" at a time: a newer one replaces an unread older one, and reopening takes it back.
  const clear = db
    .prepare(
      "DELETE FROM notifications WHERE thread_id = ? AND user_id = ? AND kind = 'resolved' AND read_at IS NULL",
    )
    .bind(t.threadId, t.starterId);
  if (!t.resolved || t.starterId === t.actorId) return [clear];
  return [clear, insert(db, { ...t, userId: t.starterId, kind: "resolved", commentId: null })];
}

interface Row {
  id: string;
  kind: NotificationKind;
  created_at: number;
  read_at: number | null;
  file_id: string;
  file_name: string;
  thread_id: string;
  resolved_at: number | null;
  actor_id: string | null;
  actor_name: string | null;
  body: string | null;
}

/** Notifications someone can still act on: their files, on their teams, out of the trash. */
const VISIBLE = `notifications n
  JOIN files f ON f.id = n.file_id AND f.deleted_at IS NULL
  JOIN team_members tm ON tm.team_id = f.team_id AND tm.user_id = n.user_id`;

const unreadCount = (db: D1Database, userId: string) =>
  db
    .prepare(`SELECT COUNT(*) AS n FROM ${VISIBLE} WHERE n.user_id = ? AND n.read_at IS NULL`)
    .bind(userId)
    .first<{ n: number }>()
    .then((row) => row?.n ?? 0);

const excerpt = (body: string | null) => {
  if (body === null) return "";
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1).trimEnd()}…` : flat;
};

const MarkRead = z
  .object({
    ids: z.array(z.string().regex(ID_PATTERN)).max(200).optional(),
    threadId: z.string().regex(ID_PATTERN).optional(),
    all: z.literal(true).optional(),
  })
  .refine((b) => [b.ids, b.threadId, b.all].filter((v) => v !== undefined).length === 1, {
    message: "Say which to mark read: ids, a threadId, or all.",
  });

export const notifications = new Hono<AppContext>()
  .get("/notifications", async (c) => {
    const user = requireUser(c);
    const unreadOnly = c.req.query("filter") === "unread";
    // The cursor is the last item's time and id, so items in the same millisecond aren't skipped.
    const cursor = /^(\d+)_([0-9A-Za-z_-]{1,64})$/.exec(c.req.query("before") ?? "");
    const where = ["n.user_id = ?1"];
    if (unreadOnly) where.push("n.read_at IS NULL");
    if (cursor) where.push("(n.created_at < ?2 OR (n.created_at = ?2 AND n.id < ?3))");
    const { results } = await c.env.DB.prepare(
      `SELECT n.id, n.kind, n.created_at, n.read_at, n.file_id, f.name AS file_name, n.thread_id,
              t.resolved_at, a.id AS actor_id, a.name AS actor_name,
              COALESCE(c.body, (SELECT fc.body FROM comments fc WHERE fc.thread_id = n.thread_id
                                 ORDER BY fc.created_at, fc.id LIMIT 1)) AS body
         FROM ${VISIBLE}
         JOIN comment_threads t ON t.id = n.thread_id
         LEFT JOIN comments c ON c.id = n.comment_id
         LEFT JOIN users a ON a.id = n.actor_id
        WHERE ${where.join(" AND ")}
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT ${PAGE + 1}`,
    )
      .bind(user.id, ...(cursor ? [Number(cursor[1]), cursor[2]] : []))
      .all<Row>();
    const page = results.slice(0, PAGE);
    return c.json({
      items: page.map((r) => ({
        id: r.id,
        kind: r.kind,
        createdAt: r.created_at,
        readAt: r.read_at,
        file: { id: r.file_id, name: r.file_name },
        threadId: r.thread_id,
        resolved: r.resolved_at !== null,
        actor: r.actor_id && r.actor_name !== null ? { id: r.actor_id, name: r.actor_name } : null,
        excerpt: excerpt(r.body),
      })),
      // Where the next page starts, when there is one.
      before: (() => {
        const last = page.at(-1);
        return results.length > PAGE && last ? `${last.created_at}_${last.id}` : null;
      })(),
      unread: await unreadCount(c.env.DB, user.id),
    });
  })

  .get("/notifications/unread", async (c) => {
    const user = requireUser(c);
    return c.json({ unread: await unreadCount(c.env.DB, user.id) });
  })

  .post("/notifications/read", async (c) => {
    const user = requireUser(c);
    const body = await readBody(c, MarkRead);
    const now = Date.now();
    const db = c.env.DB;
    const base = "UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND read_at IS NULL";
    if (body.all) await db.prepare(base).bind(now, user.id).run();
    else if (body.threadId)
      await db.prepare(`${base} AND thread_id = ?3`).bind(now, user.id, body.threadId).run();
    else if (body.ids && body.ids.length > 0)
      await db
        .prepare(`${base} AND id IN (${body.ids.map((_, i) => `?${i + 3}`).join(", ")})`)
        .bind(now, user.id, ...body.ids)
        .run();
    return c.json({ unread: await unreadCount(db, user.id) });
  });
