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
import {
  MEDIA_MAX_BYTES,
  type MediaPreviewSize,
  mediaProblem,
  orientedSize,
  parseMediaPreviewSize,
  type SniffedImage,
  sniffImage,
} from "@drawpane/model";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import type { AppContext } from "../env";
import { readCapped, sha256 } from "../lib/body";
import { badRequest, notFound, unsupportedMedia } from "../lib/http";
import { requireFileRole } from "./access";
import {
  type GeneratedPreview,
  generateMediaPreview,
  mediaPreviewKey,
  previewBucketFor,
  previewTiersFor,
} from "./media-preview";

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
export { mediaPreviewKey } from "./media-preview";

function etagMatches(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  return !!header && header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

/** Pre-generates and stores WebP previews for a newly uploaded original. Never throws. */
async function storeMediaPreviews(
  files: R2Bucket,
  sha: string,
  image: { readonly width: number; readonly height: number; readonly bytes: Uint8Array },
): Promise<void> {
  for (const size of previewTiersFor(image.width, image.height)) {
    const key = mediaPreviewKey(sha, size);
    try {
      const preview = generateMediaPreview(image, size);
      if (preview) {
        await putCachedPreview(files, key, preview);
      } else {
        await files.put(key, new Uint8Array(0), { customMetadata: { fallback: "1" } });
      }
    } catch {
      // Preview generation is best-effort: never fail an upload if encoding fails.
    }
  }
}

async function putCachedPreview(
  files: R2Bucket,
  key: string,
  preview: GeneratedPreview,
): Promise<void> {
  await files.put(key, preview.bytes, {
    httpMetadata: { contentType: "image/webp", cacheControl: IMMUTABLE },
    customMetadata: {
      naturalWidth: String(preview.naturalWidth),
      naturalHeight: String(preview.naturalHeight),
      width: String(preview.width),
      height: String(preview.height),
    },
  });
}

function previewHeaders(
  bucket: MediaPreviewSize,
  etag: string,
  cacheControl: string,
  naturalWidth: string,
  naturalHeight: string,
  contentType: string,
  extraHeaders?: Record<string, string>,
): Headers {
  return new Headers({
    "cache-control": cacheControl,
    etag,
    "content-type": contentType,
    "content-security-policy": MEDIA_CSP,
    "x-image-preview": String(bucket),
    "x-image-width": naturalWidth,
    "x-image-height": naturalHeight,
    ...(extraHeaders ?? {}),
  });
}

/**
 * Serves either the original image or a fixed-size WebP preview (`?w=256` or `?w=1024`).
 * Previews missing from R2 (pre-existing uploads) are generated lazily and cached in R2.
 * Falls back to serving the original whenever a preview cannot be produced.
 */
export async function serveMedia(
  request: Request,
  files: R2Bucket,
  row: {
    readonly sha: string;
    readonly mime: string;
    readonly width: number;
    readonly height: number;
  },
  requestedParam: string | undefined,
  options: { readonly cacheControl: string; readonly extraHeaders?: Record<string, string> },
): Promise<Response> {
  const origEtag = `"${row.sha}"`;
  const serveOriginal = async (prefetched?: Uint8Array): Promise<Response> => {
    const headers = new Headers({
      "cache-control": options.cacheControl,
      etag: origEtag,
      "content-type": row.mime,
      "content-security-policy": MEDIA_CSP,
      ...(options.extraHeaders ?? {}),
    });
    // PNG and GIF headers always reflect display orientation; JPEG/WebP may carry EXIF rotation.
    if (prefetched) {
      const natural = orientedSize(row, prefetched);
      headers.set("x-image-width", String(natural.width));
      headers.set("x-image-height", String(natural.height));
    } else if (row.mime === "image/png" || row.mime === "image/gif") {
      headers.set("x-image-width", String(row.width));
      headers.set("x-image-height", String(row.height));
    }
    if (etagMatches(request, origEtag)) return new Response(null, { status: 304, headers });
    if (prefetched) {
      headers.set("content-length", String(prefetched.byteLength));
      return new Response(prefetched, { headers });
    }
    const object = await files.get(mediaKey(row.sha));
    if (!object) throw notFound("That image is missing from storage. Upload it again.");
    headers.set("content-length", String(object.size));
    return new Response(object.body, { headers });
  };

  if (requestedParam === undefined) return serveOriginal();
  const requested = parseMediaPreviewSize(requestedParam);
  if (!requested) throw badRequest("Preview size must be 256 or 1024.");

  const bucket = previewBucketFor(row.width, row.height, requested);
  const previewEtag = `"${row.sha}-p${bucket}"`;
  if (etagMatches(request, previewEtag)) {
    const headers = new Headers({
      "cache-control": options.cacheControl,
      etag: previewEtag,
      "content-type": "image/webp",
      "content-security-policy": MEDIA_CSP,
      "x-image-preview": String(bucket),
      ...(options.extraHeaders ?? {}),
    });
    return new Response(null, { status: 304, headers });
  }

  const key = mediaPreviewKey(row.sha, bucket);
  const cached = await files.get(key);
  if (cached) {
    if (cached.size > 0) {
      const headers = previewHeaders(
        bucket,
        previewEtag,
        options.cacheControl,
        cached.customMetadata?.naturalWidth ?? String(row.width),
        cached.customMetadata?.naturalHeight ?? String(row.height),
        cached.httpMetadata?.contentType ?? "image/webp",
        options.extraHeaders,
      );
      headers.set("content-length", String(cached.size));
      return new Response(cached.body, { headers });
    }
    await cached.body.cancel();
    if (cached.customMetadata?.fallback === "1") return serveOriginal();
  }

  // Lazy generation for images uploaded before previews existed (no migration needed).
  const original = await files.get(mediaKey(row.sha));
  if (!original) throw notFound("That image is missing from storage. Upload it again.");
  const origBytes = new Uint8Array(await original.arrayBuffer());
  let preview: GeneratedPreview | null = null;
  let failed = false;
  try {
    preview = generateMediaPreview(
      { width: row.width, height: row.height, bytes: origBytes },
      bucket,
    );
  } catch {
    failed = true;
  }
  if (preview) {
    try {
      await putCachedPreview(files, key, preview);
    } catch {
      // Serving the freshly generated preview still succeeds if caching fails.
    }
    const headers = previewHeaders(
      bucket,
      previewEtag,
      options.cacheControl,
      String(preview.naturalWidth),
      String(preview.naturalHeight),
      "image/webp",
      options.extraHeaders,
    );
    headers.set("content-length", String(preview.bytes.byteLength));
    return new Response(preview.bytes, { headers });
  }
  if (!failed) {
    try {
      await files.put(key, new Uint8Array(0), { customMetadata: { fallback: "1" } });
    } catch {
      // Best-effort sentinel.
    }
  }
  return serveOriginal(origBytes);
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
      await storeMediaPreviews(c.env.FILES, sha, {
        width: image.width,
        height: image.height,
        bytes,
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
    return serveMedia(c.req.raw, c.env.FILES, row, c.req.query("w"), {
      cacheControl: IMMUTABLE,
    });
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
