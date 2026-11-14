/**
 * Team fonts: typefaces a team uploads once and everyone on it can use.
 *
 * Each upload is one face (a weight and style of a family). The family,
 * style, weight and italic flag are read from the font's own tables, so a
 * file named "final-v2.otf" still lands under its real family. Bytes are
 * content-addressed in R2 (`fonts/team/<sha>`); the same face uploaded again
 * replaces the old one.
 *
 * Only the team's members can read its fonts: the stylesheet and files
 * check membership, like images do. Fonts never leave this server.
 */

import { brotliDecompressSync, inflateSync } from "node:zlib";
import {
  FONT_CSS_FORMAT,
  FONT_MAX_BYTES,
  FONT_MIME,
  FontError,
  type FontFormat,
  newId,
  readFontMeta,
  type TeamFontFace,
} from "@drawpane/model";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import type { AppContext } from "../env";
import { readCapped, sha256 } from "../lib/body";
import { badRequest, conflict, notFound, unsupportedMedia } from "../lib/http";
import { requireTeamRole } from "./access";

/** A team keeps at most this many faces. */
export const TEAM_FONT_LIMIT = 500;

const IMMUTABLE = "private, max-age=31536000, immutable";
const SHA = /^[0-9a-f]{64}$/;

export const teamFontKey = (sha: string) => `fonts/team/${sha}`;

const decompressors = {
  inflate: async (data: Uint8Array) => new Uint8Array(inflateSync(data)),
  brotli: async (data: Uint8Array) => new Uint8Array(brotliDecompressSync(data)),
};

interface FaceRow {
  id: string;
  family: string;
  style: string;
  weight: number;
  weight_max: number | null;
  italic: number;
  format: FontFormat;
  sha: string;
  bytes: number;
  license: string | null;
  restricted: number;
  uploaded_by_name: string | null;
  created_at: number;
}

const toFace = (row: FaceRow): TeamFontFace => ({
  id: row.id,
  family: row.family,
  style: row.style,
  weight: row.weight,
  weightMax: row.weight_max,
  italic: row.italic === 1,
  format: row.format,
  sha: row.sha,
  bytes: row.bytes,
  license: row.license,
  restricted: row.restricted === 1,
  uploadedBy: row.uploaded_by_name,
  createdAt: row.created_at,
});

const SELECT_FACES = `SELECT f.id, f.family, f.style, f.weight, f.weight_max, f.italic, f.format, f.sha,
         f.bytes, f.license, f.restricted, u.name AS uploaded_by_name, f.created_at
    FROM team_fonts f LEFT JOIN users u ON u.id = f.uploaded_by`;

async function faces(db: D1Database, teamId: string): Promise<TeamFontFace[]> {
  const { results } = await db
    .prepare(
      `${SELECT_FACES} WHERE f.team_id = ? ORDER BY f.family COLLATE NOCASE, f.italic, f.weight`,
    )
    .bind(teamId)
    .all<FaceRow>();
  return results.map(toFace);
}

/** A CSS string literal: quotes and backslashes escaped, nothing that ends the rule. */
const cssString = (text: string) =>
  `"${text.replace(/["\\]/g, "\\$&").replace(/[\n\r{}<>]/g, "")}"`;

/** The @font-face rules for a team's faces, pointing at this server. */
export function teamFontsCss(teamId: string, list: readonly TeamFontFace[]): string {
  return list
    .map(
      (f) => `@font-face {
  font-family: ${cssString(f.family)};
  font-style: ${f.italic ? "italic" : "normal"};
  font-weight: ${f.weightMax ? `${f.weight} ${f.weightMax}` : f.weight};
  font-display: swap;
  src: url(/api/teams/${teamId}/fonts/file/${f.sha}) format("${FONT_CSS_FORMAT[f.format]}");
}`,
    )
    .join("\n");
}

export const teamFonts = new Hono<AppContext>()
  .get("/teams/:teamId/fonts", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    await requireTeamRole(c.env, user.id, teamId, "viewer");
    return c.json({ faces: await faces(c.env.DB, teamId) });
  })

  .post("/teams/:teamId/fonts", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    await requireTeamRole(c.env, user.id, teamId, "editor");
    const bytes = await readCapped(c.req.raw, FONT_MAX_BYTES, "Font files can be up to 15 MB.");
    let meta: Awaited<ReturnType<typeof readFontMeta>>;
    try {
      meta = await readFontMeta(bytes, decompressors);
    } catch (error) {
      if (error instanceof FontError)
        throw /isn't a font file/.test(error.message)
          ? unsupportedMedia(error.message)
          : badRequest(error.message);
      throw error;
    }
    const existing = await c.env.DB.prepare(
      `SELECT id FROM team_fonts
        WHERE team_id = ? AND family = ? AND weight = ? AND ifnull(weight_max, 0) = ? AND italic = ?`,
    )
      .bind(teamId, meta.family, meta.weight, meta.weightMax ?? 0, meta.italic ? 1 : 0)
      .first<{ id: string }>();
    if (!existing) {
      const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM team_fonts WHERE team_id = ?")
        .bind(teamId)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= TEAM_FONT_LIMIT)
        throw conflict(`A team can keep up to ${TEAM_FONT_LIMIT} font files. Remove some first.`);
    }
    const sha = await sha256(bytes);
    const key = teamFontKey(sha);
    if (!(await c.env.FILES.head(key))) {
      await c.env.FILES.put(key, bytes, {
        httpMetadata: { contentType: FONT_MIME[meta.format], cacheControl: IMMUTABLE },
        sha256: sha,
      });
    }
    const id = existing?.id ?? newId();
    const values = [
      meta.style,
      meta.format,
      sha,
      bytes.byteLength,
      meta.license,
      meta.restricted ? 1 : 0,
      user.id,
      Date.now(),
    ];
    if (existing) {
      // The same face again: keep its id (and so its place), take the new file.
      await c.env.DB.prepare(
        `UPDATE team_fonts SET style = ?, format = ?, sha = ?, bytes = ?, license = ?,
                restricted = ?, uploaded_by = ?, created_at = ? WHERE id = ?`,
      )
        .bind(...values, id)
        .run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO team_fonts (style, format, sha, bytes, license, restricted, uploaded_by,
                                 created_at, id, team_id, family, weight, weight_max, italic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(...values, id, teamId, meta.family, meta.weight, meta.weightMax, meta.italic ? 1 : 0)
        .run();
    }
    const row = await c.env.DB.prepare(`${SELECT_FACES} WHERE f.id = ?`).bind(id).first<FaceRow>();
    if (!row) throw notFound();
    return c.json({ face: toFace(row), replaced: !!existing }, existing ? 200 : 201);
  })

  .delete("/teams/:teamId/fonts/:fontId", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    await requireTeamRole(c.env, user.id, teamId, "editor");
    const row = await c.env.DB.prepare(
      "DELETE FROM team_fonts WHERE id = ? AND team_id = ? RETURNING sha",
    )
      .bind(c.req.param("fontId"), teamId)
      .first<{ sha: string }>();
    if (!row) throw notFound("That font was already removed.");
    // The bytes go once no team uses them.
    const still = await c.env.DB.prepare("SELECT 1 FROM team_fonts WHERE sha = ? LIMIT 1")
      .bind(row.sha)
      .first();
    if (!still) await c.env.FILES.delete(teamFontKey(row.sha));
    return c.json({ ok: true });
  })

  .get("/teams/:teamId/fonts.css", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    await requireTeamRole(c.env, user.id, teamId, "viewer");
    return c.body(teamFontsCss(teamId, await faces(c.env.DB, teamId)), 200, {
      "content-type": "text/css; charset=utf-8",
      // New uploads should show up on the next load.
      "cache-control": "private, no-cache",
    });
  })

  .get("/teams/:teamId/fonts/file/:sha", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    const sha = c.req.param("sha");
    if (!SHA.test(sha)) throw notFound();
    await requireTeamRole(c.env, user.id, teamId, "viewer");
    const row = await c.env.DB.prepare(
      "SELECT format FROM team_fonts WHERE team_id = ? AND sha = ? LIMIT 1",
    )
      .bind(teamId, sha)
      .first<{ format: FontFormat }>();
    if (!row) throw notFound();
    const object = await c.env.FILES.get(teamFontKey(sha));
    if (!object) throw notFound();
    return new Response(object.body, {
      headers: { "content-type": FONT_MIME[row.format], "cache-control": IMMUTABLE },
    });
  });
