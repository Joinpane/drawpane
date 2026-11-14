/**
 * Team libraries (docs/decisions/0010-team-libraries.md).
 *
 * Publishing saves a named version of the file and records what it offers;
 * files on the team list the libraries they can use, and copy components
 * from a publish's version snapshot (`/files/:id/versions/:id/snapshot`,
 * readable by the whole team, as every team file is).
 */
import {
  type LibraryAsset,
  LibraryAssets,
  type LibraryPublish,
  newId,
  type VersionPerson,
} from "@drawpane/model";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/session";
import type { AppContext, Env } from "../env";
import { badRequest, notFound } from "../lib/http";
import { readBody, requireFileRole } from "./access";

/** Publishes listed per library, newest first. */
const HISTORY_LIMIT = 50;

interface PublishRow {
  id: string;
  file_id: string;
  file_name: string;
  version_id: string;
  revn: number;
  published_by: string | null;
  published_by_name: string | null;
  published_at: number;
  description: string | null;
  assets: string;
}

const SELECT = `SELECT p.id, p.file_id, f.name AS file_name, p.version_id, p.revn, p.published_by,
  u.name AS published_by_name, p.published_at, p.description, p.assets
  FROM library_publishes p
  JOIN files f ON f.id = p.file_id
  LEFT JOIN users u ON u.id = p.published_by`;

function toPublish(row: PublishRow): LibraryPublish {
  let assets: LibraryAsset[] = [];
  try {
    const parsed = LibraryAssets.safeParse(JSON.parse(row.assets));
    if (parsed.success) assets = parsed.data;
  } catch {
    // A row that doesn't parse offers nothing rather than failing the list.
  }
  const publishedBy: VersionPerson | null =
    row.published_by && row.published_by_name
      ? { id: row.published_by, name: row.published_by_name }
      : null;
  return {
    id: row.id,
    fileId: row.file_id,
    fileName: row.file_name,
    versionId: row.version_id,
    revn: row.revn,
    publishedAt: row.published_at,
    publishedBy,
    description: row.description,
    assets,
  };
}

function room(env: Env, fileId: string) {
  return env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
}

const Description = z
  .string()
  .trim()
  .max(2000, "Keep the description under 2,000 characters.")
  .transform((s) => (s === "" ? null : s));

export const libraries = new Hono<AppContext>()
  /**
   * Publishes the file as a library (editors): a named version of it now,
   * and what it offers, as the editor read it from the same document.
   */
  .post("/files/:fileId/library/publish", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    const body = await readBody(
      c,
      z.object({ description: Description.optional(), assets: LibraryAssets }),
    );
    if (body.assets.length === 0)
      throw badRequest("There's nothing to publish: make a component first.");
    const description = body.description ?? null;
    const firstLine = description?.split("\n")[0]?.slice(0, 100);
    const saved = await room(c.env, file.id).saveVersion(
      { userId: user.id, name: user.name },
      firstLine ? `Published: ${firstLine}` : "Published",
      description,
    );
    const id = newId();
    await c.env.DB.prepare(
      `INSERT INTO library_publishes (id, file_id, team_id, version_id, revn, published_by, published_at, description, assets)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        file.id,
        file.team_id,
        saved.id,
        saved.revn,
        user.id,
        Date.now(),
        description,
        JSON.stringify(body.assets),
      )
      .run();
    const row = await c.env.DB.prepare(`${SELECT} WHERE p.id = ?`).bind(id).first<PublishRow>();
    if (!row) throw notFound();
    return c.json({ publish: toPublish(row) }, 201);
  })

  /** A file's publishes as a library, newest first (anyone on the team). */
  .get("/files/:fileId/library", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "viewer");
    const { results } = await c.env.DB.prepare(
      `${SELECT} WHERE p.file_id = ? ORDER BY p.published_at DESC LIMIT ?`,
    )
      .bind(file.id, HISTORY_LIMIT)
      .all<PublishRow>();
    return c.json({ publishes: results.map(toPublish) });
  })

  /**
   * The libraries a file can use: the latest publish of every other library
   * on its team, by name (anyone on the team).
   */
  .get("/files/:fileId/libraries", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "viewer");
    const { results } = await c.env.DB.prepare(
      `${SELECT}
        WHERE p.team_id = ? AND p.file_id != ? AND f.deleted_at IS NULL
          AND p.published_at = (SELECT MAX(q.published_at) FROM library_publishes q WHERE q.file_id = p.file_id)
        ORDER BY f.name COLLATE NOCASE`,
    )
      .bind(file.team_id, file.id)
      .all<PublishRow>();
    return c.json({ libraries: results.map(toPublish) });
  });
