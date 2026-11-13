import { newId } from "@drawpane/model";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/session";
import type { AppContext, Role } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { badRequest, conflict, notFound } from "../lib/http";
import { type FileRow, readBody, requireFileRole, requireTeamRole, toFile } from "./access";

const Name = z.string().trim().min(1, "Enter a name.").max(120, "Keep names under 120 characters.");
const RoleSchema = z.enum(["owner", "editor", "viewer"]);
const INVITE_DAYS = 7;

export const api = new Hono<AppContext>()
  .get("/session", async (c) => {
    const user = c.get("user");
    const needsSetup = user
      ? false
      : ((await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n ??
          0) === 0;
    return c.json({ user, needsSetup });
  })

  // Teams -------------------------------------------------------------------
  .get("/teams", async (c) => {
    const user = requireUser(c);
    const { results } = await c.env.DB.prepare(
      `SELECT t.id, t.name, m.role FROM teams t JOIN team_members m ON m.team_id = t.id
        WHERE m.user_id = ? ORDER BY t.created_at`,
    )
      .bind(user.id)
      .all<{ id: string; name: string; role: Role }>();
    return c.json({ teams: results });
  })

  .patch("/teams/:teamId", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    await requireTeamRole(c.env, user.id, teamId, "owner");
    const { name } = await readBody(c, z.object({ name: Name }));
    await c.env.DB.prepare("UPDATE teams SET name = ? WHERE id = ?").bind(name, teamId).run();
    return c.json({ ok: true });
  })

  .get("/teams/:teamId/members", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    await requireTeamRole(c.env, user.id, teamId, "viewer");
    const { results } = await c.env.DB.prepare(
      `SELECT u.id, u.name, u.email, m.role, m.created_at AS joinedAt
         FROM team_members m JOIN users u ON u.id = m.user_id
        WHERE m.team_id = ? ORDER BY m.created_at`,
    )
      .bind(teamId)
      .all();
    return c.json({ members: results });
  })

  .patch("/teams/:teamId/members/:userId", async (c) => {
    const user = requireUser(c);
    const { teamId, userId } = c.req.param();
    await requireTeamRole(c.env, user.id, teamId, "owner");
    const { role } = await readBody(c, z.object({ role: RoleSchema }));
    if (userId === user.id && role !== "owner") {
      const owners = await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner'",
      )
        .bind(teamId)
        .first<{ n: number }>();
      if ((owners?.n ?? 0) <= 1)
        throw conflict("A team needs at least one owner. Make someone else an owner first.");
    }
    const result = await c.env.DB.prepare(
      "UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?",
    )
      .bind(role, teamId, userId)
      .run();
    if (result.meta.changes === 0) throw notFound("That person isn't on this team.");
    return c.json({ ok: true });
  })

  .delete("/teams/:teamId/members/:userId", async (c) => {
    const user = requireUser(c);
    const { teamId, userId } = c.req.param();
    if (userId !== user.id) await requireTeamRole(c.env, user.id, teamId, "owner");
    const target = await c.env.DB.prepare(
      "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?",
    )
      .bind(teamId, userId)
      .first<{ role: Role }>();
    if (!target) throw notFound("That person isn't on this team.");
    if (target.role === "owner") {
      const owners = await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner'",
      )
        .bind(teamId)
        .first<{ n: number }>();
      if ((owners?.n ?? 0) <= 1)
        throw conflict("A team needs at least one owner. Make someone else an owner first.");
    }
    await c.env.DB.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
      .bind(teamId, userId)
      .run();
    return c.json({ ok: true });
  })

  // Invites -----------------------------------------------------------------
  .post("/teams/:teamId/invites", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    await requireTeamRole(c.env, user.id, teamId, "owner");
    const { role } = await readBody(c, z.object({ role: RoleSchema.default("editor") }));
    const token = randomToken();
    const expiresAt = Date.now() + INVITE_DAYS * 86_400_000;
    await c.env.DB.prepare(
      "INSERT INTO invites (id, team_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(await sha256Hex(token), teamId, role, user.id, Date.now(), expiresAt)
      .run();
    const url = new URL(`/invite/${token}`, c.req.url).toString();
    return c.json({ token, url, role, expiresAt }, 201);
  })

  .get("/invites/:token", async (c) => {
    const row = await c.env.DB.prepare(
      `SELECT t.name AS teamName, i.role, i.expires_at AS expiresAt FROM invites i JOIN teams t ON t.id = i.team_id
        WHERE i.id = ? AND i.used_at IS NULL AND i.expires_at > ?`,
    )
      .bind(await sha256Hex(c.req.param("token")), Date.now())
      .first();
    if (!row) throw notFound("That invite has expired or was already used. Ask for a new link.");
    return c.json(row);
  })

  .post("/invites/:token/accept", async (c) => {
    const user = requireUser(c);
    const id = await sha256Hex(c.req.param("token"));
    const now = Date.now();
    const invite = await c.env.DB.prepare(
      "SELECT team_id, role FROM invites WHERE id = ? AND used_at IS NULL AND expires_at > ?",
    )
      .bind(id, now)
      .first<{ team_id: string; role: Role }>();
    if (!invite) throw notFound("That invite has expired or was already used. Ask for a new link.");
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL",
      ).bind(now, user.id, id),
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      ).bind(invite.team_id, user.id, invite.role, now),
    ]);
    return c.json({ teamId: invite.team_id });
  })

  // Projects ----------------------------------------------------------------
  .get("/teams/:teamId/projects", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    await requireTeamRole(c.env, user.id, teamId, "viewer");
    const { results } = await c.env.DB.prepare(
      `SELECT p.id, p.team_id AS teamId, p.name, p.created_at AS createdAt, p.updated_at AS updatedAt,
              (SELECT COUNT(*) FROM files f WHERE f.project_id = p.id AND f.deleted_at IS NULL) AS fileCount
         FROM projects p WHERE p.team_id = ? ORDER BY p.created_at`,
    )
      .bind(teamId)
      .all();
    return c.json({ projects: results });
  })

  .post("/teams/:teamId/projects", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    await requireTeamRole(c.env, user.id, teamId, "editor");
    const { name } = await readBody(c, z.object({ name: Name }));
    const id = newId();
    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO projects (id, team_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, teamId, name, now, now)
      .run();
    return c.json(
      { project: { id, teamId, name, createdAt: now, updatedAt: now, fileCount: 0 } },
      201,
    );
  })

  .patch("/projects/:projectId", async (c) => {
    const user = requireUser(c);
    const project = await projectTeam(c.env.DB, c.req.param("projectId"));
    await requireTeamRole(c.env, user.id, project.team_id, "editor");
    const { name } = await readBody(c, z.object({ name: Name }));
    await c.env.DB.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
      .bind(name, Date.now(), project.id)
      .run();
    return c.json({ ok: true });
  })

  .delete("/projects/:projectId", async (c) => {
    const user = requireUser(c);
    const project = await projectTeam(c.env.DB, c.req.param("projectId"));
    await requireTeamRole(c.env, user.id, project.team_id, "owner");
    const live = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM files WHERE project_id = ? AND deleted_at IS NULL",
    )
      .bind(project.id)
      .first<{ n: number }>();
    if ((live?.n ?? 0) > 0) throw conflict("Move or delete this project's files first.");
    await c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(project.id).run();
    return c.json({ ok: true });
  })

  // Files -------------------------------------------------------------------
  .get("/teams/:teamId/files", async (c) => {
    const user = requireUser(c);
    const teamId = c.req.param("teamId");
    await requireTeamRole(c.env, user.id, teamId, "viewer");
    const trash = c.req.query("view") === "trash";
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM files WHERE team_id = ? AND deleted_at IS ${trash ? "NOT NULL" : "NULL"}
        ORDER BY updated_at DESC LIMIT 200`,
    )
      .bind(teamId)
      .all<FileRow>();
    return c.json({ files: results.map(toFile) });
  })

  .get("/projects/:projectId/files", async (c) => {
    const user = requireUser(c);
    const project = await projectTeam(c.env.DB, c.req.param("projectId"));
    await requireTeamRole(c.env, user.id, project.team_id, "viewer");
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM files WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC",
    )
      .bind(project.id)
      .all<FileRow>();
    return c.json({ files: results.map(toFile) });
  })

  .post("/projects/:projectId/files", async (c) => {
    const user = requireUser(c);
    const project = await projectTeam(c.env.DB, c.req.param("projectId"));
    await requireTeamRole(c.env, user.id, project.team_id, "editor");
    const { name } = await readBody(c, z.object({ name: Name.default("Untitled") }));
    const now = Date.now();
    const row: FileRow = {
      id: newId(),
      project_id: project.id,
      team_id: project.team_id,
      name,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO files (id, project_id, team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(row.id, row.project_id, row.team_id, row.name, user.id, now, now),
      c.env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now, project.id),
    ]);
    return c.json({ file: toFile(row) }, 201);
  })

  .get("/files/:fileId", async (c) => {
    const user = requireUser(c);
    const { file, role } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "viewer");
    const project = await c.env.DB.prepare("SELECT id, name FROM projects WHERE id = ?")
      .bind(file.project_id)
      .first<{ id: string; name: string }>();
    return c.json({ file: toFile(file), role, project });
  })

  .patch("/files/:fileId", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    const body = await readBody(
      c,
      z.object({ name: Name.optional(), projectId: z.string().max(64).optional() }),
    );
    if (body.projectId && body.projectId !== file.project_id) {
      const target = await projectTeam(c.env.DB, body.projectId);
      if (target.team_id !== file.team_id)
        throw badRequest("Files can only move between projects on the same team.");
    }
    await c.env.DB.prepare("UPDATE files SET name = ?, project_id = ?, updated_at = ? WHERE id = ?")
      .bind(body.name ?? file.name, body.projectId ?? file.project_id, Date.now(), file.id)
      .run();
    return c.json({ ok: true });
  })

  .delete("/files/:fileId", async (c) => {
    const user = requireUser(c);
    const permanent = c.req.query("permanent") === "1";
    const { file } = await requireFileRole(
      c.env,
      user.id,
      c.req.param("fileId"),
      permanent ? "owner" : "editor",
    );
    if (permanent) {
      if (file.deleted_at === null)
        throw conflict("Move the file to trash before deleting it for good.");
      await c.env.FILE_ROOM.get(c.env.FILE_ROOM.idFromName(file.id)).destroy();
      await c.env.DB.prepare("DELETE FROM files WHERE id = ?").bind(file.id).run();
    } else {
      await c.env.DB.prepare("UPDATE files SET deleted_at = ? WHERE id = ?")
        .bind(Date.now(), file.id)
        .run();
    }
    return c.json({ ok: true });
  })

  .post("/files/:fileId/restore", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    await c.env.DB.prepare("UPDATE files SET deleted_at = NULL, updated_at = ? WHERE id = ?")
      .bind(Date.now(), file.id)
      .run();
    return c.json({ ok: true });
  });

async function projectTeam(db: D1Database, projectId: string) {
  const row = await db
    .prepare("SELECT id, team_id FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ id: string; team_id: string }>();
  if (!row) throw notFound();
  return row;
}
