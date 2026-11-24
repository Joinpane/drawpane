/**
 * Images and thumbnails.
 *
 * Images are content-addressed: the bytes live in R2 at `media/<sha256>`, so
 * uploading the same image twice, from any file or team, stores it once. The
 * `media` table records which teams may read each image, and reading one
 * requires being on such a team. Thumbnails live at `files/<id>/thumbnail`
 * and follow the file's own access rules.
 *
 * Previews are generated in the browser (never decoded or encoded in the
 * Worker) and stored separately in R2 at `media/previews/v<ver>/<sha>/<size>`.
 * Uploading an original and inserting its D1 row never depend on previews.
 * Requests for `?w=256` or `?w=1024` stream the stored preview when present,
 * and otherwise stream the original directly with `X-Image-Preview-Missing: 1`
 * so the first editor client viewing an older image can backfill previews.
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
  MEDIA_PREVIEW_TYPES,
  MEDIA_PREVIEW_VERSION,
  type MediaPreviewSize,
  type MediaPreviewType,
  mediaPreviewBucketFor,
  mediaPreviewKey,
  mediaPreviewMatchesOriginal,
  mediaPreviewMaxBytes,
  mediaProblem,
  parseMediaPreviewSize,
  type SniffedImage,
  sniffImage,
} from "@drawpane/model";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import type { AppContext, Role } from "../env";
import { readCapped, sha256 } from "../lib/body";
import { badRequest, forbidden, notFound, unsupportedMedia } from "../lib/http";
import { atLeast, requireFileRole } from "./access";

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
export { mediaPreviewKey } from "@drawpane/model";

function etagMatches(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  return !!header && header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

function parsePositiveIntHeader(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) return Number.NaN;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : Number.NaN;
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
 * Serves either the original image or a client-generated fixed-size preview (`?w=256` or `?w=1024`).
 * Never decodes or buffers images in the Worker: if a requested preview is not stored yet,
 * streams the original directly with `X-Image-Preview-Missing: 1` and `private, no-cache`.
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
  const serveOriginal = async (fallbackMissingPreview = false): Promise<Response> => {
    const headers = new Headers({
      "cache-control": fallbackMissingPreview ? "private, no-cache" : options.cacheControl,
      etag: origEtag,
      "content-type": row.mime,
      "content-security-policy": MEDIA_CSP,
      ...(fallbackMissingPreview ? { "x-image-preview-missing": "1" } : {}),
      ...(options.extraHeaders ?? {}),
    });
    // PNG and GIF headers always reflect display orientation; JPEG/WebP may carry EXIF rotation.
    if (row.mime === "image/png" || row.mime === "image/gif") {
      headers.set("x-image-width", String(row.width));
      headers.set("x-image-height", String(row.height));
    }
    if (etagMatches(request, origEtag)) return new Response(null, { status: 304, headers });
    const object = await files.get(mediaKey(row.sha));
    if (!object) throw notFound("That image is missing from storage. Upload it again.");
    headers.set("content-length", String(object.size));
    return new Response(object.body, { headers });
  };

  if (requestedParam === undefined) return serveOriginal(false);
  const requested = parseMediaPreviewSize(requestedParam);
  if (!requested) throw badRequest("Preview size must be 256 or 1024.");

  const bucket = mediaPreviewBucketFor(row.width, row.height, requested);
  const previewEtag = `"${row.sha}-v${MEDIA_PREVIEW_VERSION}-p${bucket}"`;
  const key = mediaPreviewKey(row.sha, bucket);
  const cached = await files.get(key);
  if (cached && cached.size > 0) {
    const contentType = cached.httpMetadata?.contentType ?? "image/webp";
    const headers = previewHeaders(
      bucket,
      previewEtag,
      options.cacheControl,
      cached.customMetadata?.naturalWidth ?? String(row.width),
      cached.customMetadata?.naturalHeight ?? String(row.height),
      contentType,
      options.extraHeaders,
    );
    if (etagMatches(request, previewEtag)) {
      await cached.body.cancel();
      return new Response(null, { status: 304, headers });
    }
    headers.set("content-length", String(cached.size));
    return new Response(cached.body, { headers });
  }
  if (cached) await cached.body.cancel();
  return serveOriginal(true);
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

  /** Stores a validated client-generated preview for an existing image, deduplicated by content hash. */
  .put("/media/:sha/previews/:size", async (c) => {
    const user = requireUser(c);
    const row = await editableMedia(c.env.DB, user.id, c.req.param("sha"));
    const size = parseMediaPreviewSize(c.req.param("size"));
    if (!size) throw badRequest("Preview size must be 256 or 1024.");
    const bucket = mediaPreviewBucketFor(row.width, row.height, size);
    if (bucket !== size) {
      throw badRequest(`Preview size ${size} is not needed for this image.`);
    }
    const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (!type || !(MEDIA_PREVIEW_TYPES as readonly string[]).includes(type)) {
      throw unsupportedMedia("Send the preview as WebP, JPEG or PNG.");
    }
    const maxBytes = mediaPreviewMaxBytes(size);
    const bytes = await readCapped(
      c.req.raw,
      maxBytes,
      `Previews of size ${size} can be up to ${Math.round(maxBytes / 1024)} KB.`,
    );
    if (bytes.byteLength >= row.bytes) {
      throw badRequest("Preview must be smaller than the original image.");
    }
    const sniffed = sniffImage(bytes);
    if (!sniffed || sniffed.mime !== (type as MediaPreviewType)) {
      throw unsupportedMedia("That isn't the WebP, JPEG or PNG image its content type says.");
    }

    // Validate optional declared preview dimensions and natural dimensions against sniffed/original.
    const declaredPreviewW = parsePositiveIntHeader(c.req.header("x-preview-width"));
    const declaredPreviewH = parsePositiveIntHeader(c.req.header("x-preview-height"));
    if (declaredPreviewW !== null || declaredPreviewH !== null) {
      if (
        declaredPreviewW === null ||
        declaredPreviewH === null ||
        !Number.isFinite(declaredPreviewW) ||
        !Number.isFinite(declaredPreviewH) ||
        declaredPreviewW > size ||
        declaredPreviewH > size ||
        declaredPreviewW !== sniffed.width ||
        declaredPreviewH !== sniffed.height
      ) {
        throw badRequest("Declared preview dimensions must match the image and fit the tier.");
      }
    }

    const match = mediaPreviewMatchesOriginal(row, sniffed, size);
    if (!match.ok) {
      throw badRequest("Preview dimensions must fit the tier and match the original image.");
    }

    const naturalWidth = match.swapped ? row.height : row.width;
    const naturalHeight = match.swapped ? row.width : row.height;
    const declaredNaturalW = parsePositiveIntHeader(c.req.header("x-image-width"));
    const declaredNaturalH = parsePositiveIntHeader(c.req.header("x-image-height"));
    if (declaredNaturalW !== null || declaredNaturalH !== null) {
      if (declaredNaturalW !== naturalWidth || declaredNaturalH !== naturalHeight) {
        throw badRequest("Declared image dimensions must match the original image.");
      }
    }

    const key = mediaPreviewKey(row.sha, size);
    if (await c.env.FILES.head(key)) {
      return c.json({ ok: true, cached: true }, 200);
    }
    await c.env.FILES.put(key, bytes, {
      httpMetadata: { contentType: sniffed.mime, cacheControl: IMMUTABLE },
      customMetadata: {
        naturalWidth: String(naturalWidth),
        naturalHeight: String(naturalHeight),
        width: String(sniffed.width),
        height: String(sniffed.height),
        version: String(MEDIA_PREVIEW_VERSION),
      },
    });
    return c.json({ ok: true, cached: false }, 201);
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
    if (etagMatches(requestFrom(c), etag)) return new Response(null, { status: 304, headers });
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

function requestFrom(c: { req: { raw: Request } }): Request {
  return c.req.raw;
}

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

/** The image's record if the user is an editor/owner on a team that owns it; 404 if not on any team, 403 if viewer only. */
async function editableMedia(db: D1Database, userId: string, sha: string): Promise<MediaInfo> {
  if (!SHA.test(sha)) throw notFound();
  const { results } = await db
    .prepare(
      `SELECT m.sha, m.mime, m.width, m.height, m.bytes, t.role FROM media m
         JOIN team_members t ON t.team_id = m.team_id AND t.user_id = ?
        WHERE m.sha = ?`,
    )
    .bind(userId, sha)
    .all<MediaInfo & { role: Role }>();
  if (results.length === 0) throw notFound();
  const editable = results.find((r) => atLeast(r.role, "editor"));
  if (!editable) throw forbidden();
  const { role: _role, ...info } = editable;
  return info;
}
