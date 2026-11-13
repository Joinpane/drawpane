/**
 * Prototype links: anyone with the link can play a file's prototype, without
 * an account.
 *
 * A link's token is `<id>.<mac>`: a random id and an HMAC of it under
 * SESSION_SECRET. Only the id is stored, so a database copy alone opens
 * nothing, and members can still see the link because the Worker re-derives
 * it. A file has at most one live link; resetting revokes it and makes a new
 * one, which breaks every copy of the old URL at once.
 *
 * Guests only read: the room hands them document changes and nothing about
 * the people in the file (see FileRoom), and images are served through the
 * link, limited to the file's team.
 */
import { Hono } from "hono";
import { publicOrigins } from "../auth/passkeys";
import { requireUser } from "../auth/session";
import type { AppContext, Env } from "../env";
import { bytesToBase64Url, randomToken } from "../lib/crypto";
import { notFound } from "../lib/http";
import { type FileRow, requireFileRole } from "./access";
import { mediaKey } from "./media";

const encoder = new TextEncoder();
const TOKEN = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})$/;
const SHA = /^[0-9a-f]{64}$/;
const MEDIA_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

async function mac(secret: string, id: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`share-link:${id}`));
  // 128 bits of the MAC is plenty for a capability URL and keeps links short.
  return bytesToBase64Url(new Uint8Array(signature).slice(0, 16));
}

/** Compares two strings in time that doesn't depend on where they differ. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function shareToken(secret: string, id: string): Promise<string> {
  return `${id}.${await mac(secret, id)}`;
}

export interface SharedFile {
  readonly linkId: string;
  readonly file: FileRow;
}

/** The file a live link opens, or null for a malformed, forged, revoked or deleted one. */
export async function resolveShareToken(env: Env, token: string): Promise<SharedFile | null> {
  const match = TOKEN.exec(token);
  if (!match) return null;
  const [, id, given] = match as unknown as [string, string, string];
  if (!same(await mac(env.SESSION_SECRET, id), given)) return null;
  const row = await env.DB.prepare(
    `SELECT f.id, f.project_id, f.team_id, f.name, f.created_at, f.updated_at, f.deleted_at, f.thumbnail_at
       FROM share_links s JOIN files f ON f.id = s.file_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND f.deleted_at IS NULL`,
  )
    .bind(id)
    .first<FileRow>();
  return row ? { linkId: id, file: row } : null;
}

async function liveLink(env: Env, fileId: string) {
  return env.DB.prepare(
    `SELECT id, created_at FROM share_links
      WHERE file_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(fileId)
    .first<{ id: string; created_at: number }>();
}

export const share = new Hono<AppContext>()
  /** The file's prototype link, for anyone on the team. */
  .get("/files/:fileId/share", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "viewer");
    const link = await liveLink(c.env, file.id);
    if (!link) return c.json({ link: null });
    const token = await shareToken(c.env.SESSION_SECRET, link.id);
    return c.json({
      link: {
        url: new URL(`/p/${token}`, publicOrigins(c)[0]).toString(),
        createdAt: link.created_at,
      },
    });
  })

  /** Turns the link on (editors). Returns the live link if there already is one. */
  .post("/files/:fileId/share", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    let link = await liveLink(c.env, file.id);
    let status: 200 | 201 = 200;
    if (!link) {
      link = { id: randomToken(12), created_at: Date.now() };
      await c.env.DB.prepare(
        "INSERT INTO share_links (id, file_id, created_by, created_at) VALUES (?, ?, ?, ?)",
      )
        .bind(link.id, file.id, user.id, link.created_at)
        .run();
      status = 201;
    }
    const token = await shareToken(c.env.SESSION_SECRET, link.id);
    return c.json(
      {
        link: {
          url: new URL(`/p/${token}`, publicOrigins(c)[0]).toString(),
          createdAt: link.created_at,
        },
      },
      status,
    );
  })

  /** Turns the link off (editors). Every copy of it stops working. */
  .delete("/files/:fileId/share", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    await c.env.DB.prepare(
      "UPDATE share_links SET revoked_at = ? WHERE file_id = ? AND revoked_at IS NULL",
    )
      .bind(Date.now(), file.id)
      .run();
    // Anyone playing it now is shown the door too, not just new visitors.
    await c.env.FILE_ROOM.get(c.env.FILE_ROOM.idFromName(file.id)).closeGuests();
    return c.json({ ok: true });
  })

  /** What a link opens. Public. */
  .get("/share/:token", async (c) => {
    const shared = await resolveShareToken(c.env, c.req.param("token"));
    if (!shared) throw notFound("This prototype link was turned off, or it never existed.");
    return c.json({ file: { id: shared.file.id, name: shared.file.name } });
  })

  /** An image in a shared file. Public, limited to images the file's team owns. */
  .get("/share/:token/media/:sha", async (c) => {
    const shared = await resolveShareToken(c.env, c.req.param("token"));
    const sha = c.req.param("sha");
    if (!shared || !SHA.test(sha)) throw notFound();
    const row = await c.env.DB.prepare(
      "SELECT sha, mime FROM media WHERE sha = ? AND team_id = ? LIMIT 1",
    )
      .bind(sha, shared.file.team_id)
      .first<{ sha: string; mime: string }>();
    if (!row) throw notFound();
    const etag = `"${row.sha}"`;
    // Short-lived: turning the link off should stop images loading soon after.
    const headers = new Headers({
      "cache-control": "private, max-age=300",
      etag,
      "content-type": row.mime,
      "content-security-policy": MEDIA_CSP,
      "referrer-policy": "no-referrer",
    });
    const object = await c.env.FILES.get(mediaKey(row.sha));
    if (!object) throw notFound();
    headers.set("content-length", String(object.size));
    return new Response(object.body, { headers });
  });
