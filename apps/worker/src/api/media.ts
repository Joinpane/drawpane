/**
 * Images and thumbnails.
 *
 * Images are content-addressed: the bytes live in R2 at `media/<sha256>`, so
 * uploading the same image twice, from any file or team, stores it once. The
 * `media` table records which teams may read each image, and reading one
 * requires being on such a team. Thumbnails live at `files/<id>/thumbnail`
 * and follow the file's own access rules.
 *
 * Formats are recognised by magic bytes (see `sniffImage`), never by the
 * Content-Type a client sends.
 *
 * TODO(svg): SVG uploads are refused until they can be sanitized. An SVG can
 * carry scripts, external references and CSS, and serving one from this
 * origin would let it run with the user's session.
 */
import { MEDIA_MAX_BYTES, mediaProblem, type SniffedImage, sniffImage } from "@drawpane/model";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import type { AppContext } from "../env";
import { readCapped, sha256 } from "../lib/body";
import { badRequest, notFound, unsupportedMedia } from "../lib/http";
import { requireFileRole } from "./access";

/** Thumbnails are at most this many bytes. */
export const THUMBNAIL_MAX_BYTES = 1024 * 1024;
/** And at most this many pixels on a side (the editor renders 640 × 480). */
const THUMBNAIL_MAX_SIDE = 2048;

const IMMUTABLE = "private, max-age=31536000, immutable";
const SHA = /^[0-9a-f]{64}$/;
/** Served images are never documents: no scripts, no subresources, even if opened directly. */
const MEDIA_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

export interface MediaInfo {
  readonly sha: string;
  readonly mime: SniffedImage["mime"];
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export const mediaKey = (sha: string) => `media/${sha}`;
export const thumbnailKey = (fileId: string) => `files/${fileId}/thumbnail`;

function etagMatches(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  return !!header && header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

export const media = new Hono<AppContext>()
  .post("/files/:fileId/media", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    const bytes = await readCapped(
      c.req.raw,
      MEDIA_MAX_BYTES,
      mediaProblem(MEDIA_MAX_BYTES + 1, null) ?? "",
    );
    const image = sniffImage(bytes);
    const problem = mediaProblem(bytes.byteLength, image);
    if (!image) throw unsupportedMedia(problem ?? "Unsupported image.");
    if (problem) throw badRequest(problem);
    const sha = await sha256(bytes);
    const key = mediaKey(sha);
    // Content-addressed: if the bytes are already stored, only the team's access row is new.
    if (!(await c.env.FILES.head(key))) {
      await c.env.FILES.put(key, bytes, {
        httpMetadata: { contentType: image.mime, cacheControl: IMMUTABLE },
        sha256: sha,
      });
    }
    const result = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO media (sha, team_id, mime, width, height, bytes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        sha,
        file.team_id,
        image.mime,
        image.width,
        image.height,
        bytes.byteLength,
        user.id,
        Date.now(),
      )
      .run();
    const info: MediaInfo = {
      sha,
      mime: image.mime,
      width: image.width,
      height: image.height,
      bytes: bytes.byteLength,
    };
    return c.json(info, result.meta.changes > 0 ? 201 : 200);
  })

  .get("/media/:sha/info", async (c) => {
    const user = requireUser(c);
    const row = await readableMedia(c.env.DB, user.id, c.req.param("sha"));
    return c.json(row);
  })

  .get("/media/:sha", async (c) => {
    const user = requireUser(c);
    const row = await readableMedia(c.env.DB, user.id, c.req.param("sha"));
    const etag = `"${row.sha}"`;
    const headers = new Headers({
      "cache-control": IMMUTABLE,
      etag,
      "content-type": row.mime,
      "content-security-policy": MEDIA_CSP,
    });
    if (etagMatches(c.req.raw, etag)) return new Response(null, { status: 304, headers });
    const object = await c.env.FILES.get(mediaKey(row.sha));
    if (!object) throw notFound("That image is missing from storage. Upload it again.");
    headers.set("content-length", String(object.size));
    return new Response(object.body, { headers });
  })

  .put("/files/:fileId/thumbnail", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "image/webp" && type !== "image/png")
      throw unsupportedMedia("Send the thumbnail as WebP or PNG.");
    const bytes = await readCapped(
      c.req.raw,
      THUMBNAIL_MAX_BYTES,
      "Thumbnails can be up to 1 MB. Render it smaller and try again.",
    );
    const image = sniffImage(bytes);
    if (!image || image.mime !== type)
      throw unsupportedMedia("That isn't the WebP or PNG image its type says. Render it again.");
    if (image.width > THUMBNAIL_MAX_SIDE || image.height > THUMBNAIL_MAX_SIDE)
      throw badRequest("Thumbnails can be up to 2,048 px on a side. Render it smaller.");
    await c.env.FILES.put(thumbnailKey(file.id), bytes, { httpMetadata: { contentType: type } });
    // Strictly increasing, so two saves in the same millisecond still bust caches.
    const thumbnailAt = Math.max(Date.now(), (file.thumbnail_at ?? 0) + 1);
    await c.env.DB.prepare("UPDATE files SET thumbnail_at = ? WHERE id = ?")
      .bind(thumbnailAt, file.id)
      .run();
    return c.json({ thumbnailAt });
  })

  .get("/files/:fileId/thumbnail", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "viewer");
    if (!file.thumbnail_at) throw notFound("This file has no thumbnail yet.");
    const etag = `"t${file.thumbnail_at}"`;
    // A URL that names the version (`?v=`) never changes; the bare URL always revalidates.
    const versioned = c.req.query("v") === String(file.thumbnail_at);
    const headers = new Headers({
      "cache-control": versioned ? IMMUTABLE : "private, no-cache",
      etag,
      "content-security-policy": MEDIA_CSP,
    });
    if (etagMatches(c.req.raw, etag)) return new Response(null, { status: 304, headers });
    const object = await c.env.FILES.get(thumbnailKey(file.id));
    if (!object) throw notFound("This file has no thumbnail yet.");
    headers.set("content-type", object.httpMetadata?.contentType ?? "image/png");
    headers.set("content-length", String(object.size));
    return new Response(object.body, { headers });
  })

  .delete("/files/:fileId/thumbnail", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    await c.env.FILES.delete(thumbnailKey(file.id));
    await c.env.DB.prepare("UPDATE files SET thumbnail_at = NULL WHERE id = ?").bind(file.id).run();
    return c.json({ ok: true });
  });

/** The image's record if the user is on a team that owns it; 404 otherwise, so hashes don't leak. */
async function readableMedia(db: D1Database, userId: string, sha: string): Promise<MediaInfo> {
  if (!SHA.test(sha)) throw notFound();
  const row = await db
    .prepare(
      `SELECT m.sha, m.mime, m.width, m.height, m.bytes FROM media m
         JOIN team_members t ON t.team_id = m.team_id AND t.user_id = ?
        WHERE m.sha = ? LIMIT 1`,
    )
    .bind(userId, sha)
    .first<MediaInfo>();
  if (!row) throw notFound();
  return row;
}
