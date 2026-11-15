/**
 * The kit store (docs/decisions/0022-kit-store.md), on the server's side.
 *
 * The store lists kits from a registry (an `index.json`, by default
 * Joinpane/drawpane-kits). The page can only reach this origin (its
 * Content-Security-Policy says `connect-src 'self'`), so the Worker fetches
 * the registry's index, its covers and its kit files for it, and only URLs
 * the configured index lists: this is no open proxy. A kit's file streams
 * through as it downloads and is never stored or cached here; the browser
 * checks it against the index's hash before importing it.
 *
 * `KIT_REGISTRY` points at another index, or `off` turns the store off.
 *
 * Which kits a team added (the store's "Added" badge) is kept in `team_kits`.
 */
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/session";
import type { AppContext, Env } from "../env";
import { badRequest, HttpError, notFound, tooLarge } from "../lib/http";
import { readBody, requireTeamRole } from "./access";

export const DEFAULT_KIT_REGISTRY =
  "https://raw.githubusercontent.com/Joinpane/drawpane-kits/main/index.json";
/** An index is metadata: a few hundred kits fit in well under this. */
const INDEX_MAX_BYTES = 8 * 1024 * 1024;
/** Penpot's largest exports are a few hundred MB; the importer's own limits apply after. */
export const KIT_FILE_MAX_BYTES = 300 * 1024 * 1024;
const COVER_MAX_BYTES = 8 * 1024 * 1024;
/** How long this isolate trusts an index it read (the registry refreshes daily). */
const INDEX_TTL_MS = 10 * 60 * 1000;

/** The registry's index URL, or null when the store is off. */
export function registryUrl(env: Pick<Env, "KIT_REGISTRY">): URL | null {
  const value = env.KIT_REGISTRY?.trim();
  if (value === "off") return null;
  try {
    const url = new URL(value || DEFAULT_KIT_REGISTRY);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

interface IndexKit {
  readonly id: string;
  readonly cover: string | null;
  readonly file: { readonly url: string } | null;
}

/** Just what the Worker needs from an index: each kit's id, cover and file URL. The page validates the rest. */
const IndexShape = z.object({
  kits: z.array(
    z.object({
      id: z.string().min(1).max(200),
      cover: z.string().max(2000).nullable().optional(),
      file: z
        .object({ url: z.string().min(1).max(2000) })
        .nullable()
        .optional(),
    }),
  ),
});

let cached: { url: string; at: number; text: string; kits: Map<string, IndexKit> } | null = null;

/** Forgets the index this isolate read (tests). */
export function forgetKitIndex(): void {
  cached = null;
}

/** Reads a response body, refusing it past `max` bytes. */
async function readText(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw tooLarge("The kit index is too large.");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooLarge("The kit index is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const unavailable = (message = "The kit store can't be reached right now. Try again soon.") =>
  new HttpError(502, "internal", message);

/** The configured index: its text as served, and its kits by id. */
export async function readIndex(registry: URL) {
  const now = Date.now();
  if (cached && cached.url === registry.href && now - cached.at < INDEX_TTL_MS) return cached;
  let response: Response;
  try {
    response = await fetch(registry.href, { headers: { accept: "application/json" } });
  } catch {
    throw unavailable();
  }
  if (!response.ok) throw unavailable();
  const text = await readText(response, INDEX_MAX_BYTES);
  let parsed: z.infer<typeof IndexShape>;
  try {
    parsed = IndexShape.parse(JSON.parse(text));
  } catch {
    throw unavailable("The kit store's list isn't in a format this server reads.");
  }
  const kits = new Map<string, IndexKit>();
  for (const kit of parsed.kits)
    if (!kits.has(kit.id))
      kits.set(kit.id, { id: kit.id, cover: kit.cover ?? null, file: kit.file ?? null });
  cached = { url: registry.href, at: now, text, kits };
  return cached;
}

/** A URL the index gives, resolved against the index's own (http or https only). */
export function resolveListed(registry: URL, value: string): URL | null {
  try {
    const url = new URL(value, registry);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Passes a body through, failing the stream once it passes `max` bytes. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max) controller.error(new Error("The kit's file is too large."));
        else controller.enqueue(chunk);
      },
    }),
  );
}

async function listed(env: Env, kitId: string) {
  const registry = registryUrl(env);
  if (!registry) throw notFound("The kit store is turned off on this server.");
  const { kits } = await readIndex(registry);
  const kit = kits.get(kitId);
  if (!kit) throw notFound("That kit isn't in the store any more.");
  return { registry, kit };
}

const AddedBody = z.object({
  kitId: z.string().min(1).max(200),
  fileId: z.string().min(1).max(64),
});

export const kits = new Hono<AppContext>()
  /**
   * The store's list, as the registry serves it (the page validates it), or
   * `enabled: false` when the store is off on this server.
   */
  .get("/kits", async (c) => {
    requireUser(c);
    const registry = registryUrl(c.env);
    if (!registry) return c.json({ enabled: false });
    const { text } = await readIndex(registry);
    return c.body(
      `{"enabled":true,"registry":${JSON.stringify(registry.href)},"index":${text}}`,
      200,
      {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-cache",
      },
    );
  })

  /** A kit's cover image, from where the index says it is. */
  .get("/kits/:kitId/cover", async (c) => {
    requireUser(c);
    const { registry, kit } = await listed(c.env, c.req.param("kitId"));
    const url = kit.cover ? resolveListed(registry, kit.cover) : null;
    if (!url) throw notFound("This kit has no cover.");
    let response: Response;
    try {
      response = await fetch(url.href);
    } catch {
      throw unavailable();
    }
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body) throw notFound("The kit's cover can't be reached.");
    if (!/^image\/(png|jpeg|webp|gif|avif)\b/.test(type))
      throw notFound("The kit's cover isn't an image.");
    return new Response(capped(response.body, COVER_MAX_BYTES), {
      headers: {
        "content-type": type,
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
      },
    });
  })

  /**
   * A kit's file, streamed from where the index says it's hosted, never kept
   * here (`no-store`, and fetched without the cache).
   */
  .get("/kits/:kitId/file", async (c) => {
    requireUser(c);
    const { registry, kit } = await listed(c.env, c.req.param("kitId"));
    const url = kit.file ? resolveListed(registry, kit.file.url) : null;
    if (!url) throw notFound("This kit has no file to add.");
    let response: Response;
    try {
      response = await fetch(url.href, { cache: "no-store" });
    } catch {
      throw unavailable("The kit's file can't be reached right now. Try again soon.");
    }
    if (!response.ok || !response.body)
      throw new HttpError(
        502,
        "internal",
        "The kit's file can't be downloaded from where it's hosted.",
      );
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > KIT_FILE_MAX_BYTES)
      throw tooLarge("This kit's file is too large to add.");
    return new Response(capped(response.body, KIT_FILE_MAX_BYTES), {
      headers: {
        "content-type": "application/octet-stream",
        ...(Number.isFinite(declared) && declared > 0
          ? { "content-length": String(declared) }
          : {}),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  })

  /** The kits a team has added, with the files they became (anyone on the team). */
  .get("/teams/:teamId/kits", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    await requireTeamRole(c.env, user.id, teamId, "viewer");
    const { results } = await c.env.DB.prepare(
      `SELECT k.kit_id AS kitId, k.file_id AS fileId, k.added_at AS addedAt
         FROM team_kits k JOIN files f ON f.id = k.file_id
        WHERE k.team_id = ? AND f.deleted_at IS NULL
        ORDER BY k.added_at DESC`,
    )
      .bind(teamId)
      .all<{ kitId: string; fileId: string; addedAt: number }>();
    return c.json({ added: results });
  })

  /** Records that a kit was added as a file of the team (editors). */
  .post("/teams/:teamId/kits", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    await requireTeamRole(c.env, user.id, teamId, "editor");
    const body = await readBody(c, AddedBody);
    const file = await c.env.DB.prepare(
      "SELECT id FROM files WHERE id = ? AND team_id = ? AND deleted_at IS NULL",
    )
      .bind(body.fileId, teamId)
      .first<{ id: string }>();
    if (!file) throw badRequest("That file isn't on this team.");
    const addedAt = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO team_kits (team_id, kit_id, file_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (team_id, kit_id, file_id) DO UPDATE SET added_at = excluded.added_at`,
    )
      .bind(teamId, body.kitId, file.id, user.id, addedAt)
      .run();
    return c.json({ added: { kitId: body.kitId, fileId: file.id, addedAt } }, 201);
  });
