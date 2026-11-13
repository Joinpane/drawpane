/**
 * Version history: the saved versions of a file, their snapshots, naming and
 * restoring.
 *
 * Versions are written by the file's FileRoom (see `saveVersion` and the
 * autosave alarm there); this API lists them from D1, streams a version's
 * snapshot from R2 for previewing, and asks the room to save or restore.
 * Restoring layers (not the whole file) happens in the editor as an ordinary,
 * undoable edit, so it has no endpoint.
 */
import {
  type EditSummary,
  EMPTY_SUMMARY,
  ID_PATTERN,
  type VersionInfo,
  type VersionPerson,
  type VersionReason,
} from "@drawpane/model";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/session";
import type { AppContext, Env } from "../env";
import { conflict, notFound } from "../lib/http";
import { snapshotKey } from "../rooms/snapshots";
import { readBody, requireFileRole } from "./access";

/** Plenty for 30 days of autosaves plus every named version. */
const LIST_LIMIT = 2000;

const VersionName = z
  .string()
  .trim()
  .min(1, "Give the version a name.")
  .max(120, "Keep version names under 120 characters.");
const Description = z
  .string()
  .trim()
  .max(2000, "Keep descriptions under 2,000 characters.")
  .transform((s) => (s === "" ? null : s));

interface VersionRow {
  id: string;
  revn: number;
  reason: VersionReason;
  name: string | null;
  description: string | null;
  restored_id: string | null;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  authors: string;
  summary: string;
  size: number;
}

const COLUMNS =
  "id, revn, reason, name, description, restored_id, created_by, created_at, started_at, authors, summary, size";

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Turns rows into API versions, resolving every person mentioned in one query. */
async function toVersions(env: Env, rows: readonly VersionRow[]): Promise<VersionInfo[]> {
  const authorIds = rows.map((row) => parseJson<string[]>(row.authors, []));
  const ids = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (row.created_by) ids.add(row.created_by);
    for (const id of authorIds[i] ?? []) ids.add(id);
  }
  const people = new Map<string, VersionPerson>();
  const list = [...ids];
  // D1 caps bound parameters per statement; ask in chunks.
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT id, name FROM users WHERE id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<VersionPerson>();
    for (const person of results) people.set(person.id, { id: person.id, name: person.name });
  }
  return rows.map((row, i) => ({
    id: row.id,
    revn: row.revn,
    reason: row.reason,
    name: row.name,
    description: row.description,
    restoredId: row.restored_id,
    createdBy: row.created_by ? (people.get(row.created_by) ?? null) : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    authors: (authorIds[i] ?? []).flatMap((id) => {
      const person = people.get(id);
      return person ? [person] : [];
    }),
    summary: parseJson<EditSummary>(row.summary, EMPTY_SUMMARY),
    size: row.size,
  }));
}

async function versionRow(env: Env, fileId: string, versionId: string): Promise<VersionRow> {
  if (!ID_PATTERN.test(versionId)) throw notFound("That version doesn't exist.");
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM versions WHERE id = ? AND file_id = ?`)
    .bind(versionId, fileId)
    .first<VersionRow>();
  if (!row) throw notFound("That version doesn't exist, or it expired.");
  return row;
}

function room(env: Env, fileId: string) {
  return env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
}

export const versions = new Hono<AppContext>()
  /** Every saved version, newest first. Anyone on the team. */
  .get("/files/:fileId/versions", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "viewer");
    const { results } = await c.env.DB.prepare(
      `SELECT ${COLUMNS} FROM versions WHERE file_id = ? ORDER BY revn DESC LIMIT ?`,
    )
      .bind(file.id, LIST_LIMIT)
      .all<VersionRow>();
    return c.json({ versions: await toVersions(c.env, results) });
  })

  /** Saves the file as it is now under a name (editors). */
  .post("/files/:fileId/versions", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    const body = await readBody(
      c,
      z.object({ name: VersionName, description: Description.optional() }),
    );
    const saved = await room(c.env, file.id).saveVersion(
      { userId: user.id, name: user.name },
      body.name,
      body.description ?? null,
    );
    const [version] = await toVersions(c.env, [await versionRow(c.env, file.id, saved.id)]);
    return c.json({ version }, 201);
  })

  /** Names, renames or un-names a version (editors). An unnamed version expires with the autosaves. */
  .patch("/files/:fileId/versions/:versionId", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    const row = await versionRow(c.env, file.id, c.req.param("versionId"));
    const body = await readBody(
      c,
      z.object({
        name: VersionName.nullable().optional(),
        description: Description.nullable().optional(),
      }),
    );
    const name = body.name === undefined ? row.name : body.name;
    const description =
      name === null ? null : body.description === undefined ? row.description : body.description;
    await c.env.DB.prepare(
      "UPDATE versions SET name = ?, description = ?, created_by = CASE WHEN ? IS NULL THEN created_by ELSE COALESCE(created_by, ?) END WHERE id = ?",
    )
      .bind(name, description, name, user.id, row.id)
      .run();
    const [version] = await toVersions(c.env, [await versionRow(c.env, file.id, row.id)]);
    return c.json({ version });
  })

  /**
   * A version's snapshot, for previewing it. Snapshots never change, so the
   * browser may keep it. Stored gzipped and sent as is.
   */
  .get("/files/:fileId/versions/:versionId/snapshot", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "viewer");
    const row = await versionRow(c.env, file.id, c.req.param("versionId"));
    const object = await c.env.FILES.get(snapshotKey(file.id, row.revn));
    if (!object) throw notFound("That version's snapshot is missing.");
    return new Response(object.body, {
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(object.size),
        "cache-control": "private, max-age=31536000, immutable",
        etag: `"${row.id}"`,
      },
      // The body is gzip already: don't compress it again.
      encodeBody: "manual",
    });
  })

  /** Restores the whole file to a version (editors). The state before it is saved first. */
  .post("/files/:fileId/versions/:versionId/restore", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    const row = await versionRow(c.env, file.id, c.req.param("versionId"));
    const body = await readBody(
      c,
      z.object({ sessionId: z.string().regex(ID_PATTERN).nullable().optional() }),
    );
    const result = await room(c.env, file.id).restoreVersion(
      { userId: user.id, name: user.name },
      { id: row.id, name: row.name, at: row.created_at, revn: row.revn },
      body.sessionId ?? null,
    );
    if (!result.ok) throw conflict("That version's snapshot is missing, so it can't be restored.");
    const { ok: _, ...change } = result;
    return c.json(change);
  });
