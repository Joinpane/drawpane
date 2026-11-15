import type { Context } from "hono";
import type { z } from "zod";
import type { AppContext, Env, Role } from "../env";
import { badRequest, forbidden, notFound } from "../lib/http";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export function atLeast(role: Role, needed: Role): boolean {
  return RANK[role] >= RANK[needed];
}

export async function teamRole(env: Env, userId: string, teamId: string): Promise<Role | null> {
  const row = await env.DB.prepare(
    "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?",
  )
    .bind(teamId, userId)
    .first<{ role: Role }>();
  return row?.role ?? null;
}

/** Throws 404 when the user isn't on the team (so team ids don't leak) and 403 when their role is too low. */
export async function requireTeamRole(
  env: Env,
  userId: string,
  teamId: string,
  needed: Role,
): Promise<Role> {
  const role = await teamRole(env, userId, teamId);
  if (!role) throw notFound();
  if (!atLeast(role, needed)) throw forbidden();
  return role;
}

/**
 * Someone's role on a file, from `files f` joined to their team membership
 * `m` and the file's branch record `b` (see FILE_ACCESS): their team role,
 * except that a merged branch is read-only history (decision 0012).
 */
export const FILE_ROLE = "CASE WHEN b.merged_at IS NOT NULL THEN 'viewer' ELSE m.role END";
/** The joins FILE_ROLE reads; binds the user's id. */
export const FILE_ACCESS = `files f JOIN team_members m ON m.team_id = f.team_id AND m.user_id = ?
  LEFT JOIN branches b ON b.file_id = f.id`;

export interface FileRow {
  id: string;
  project_id: string;
  team_id: string;
  name: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  /** When the current thumbnail was uploaded; null until the editor publishes one. */
  thumbnail_at?: number | null;
  /** 1 when the team starts new files from it. */
  is_template?: number;
  /** A branch's main file (decision 0012); null for a main file. */
  branch_of?: string | null;
  /** In lists: how many of its branches are open (see OPEN_BRANCHES). */
  open_branches?: number;
}

/** A column for file lists over `files`: how many open branches each file has. */
export const OPEN_BRANCHES = `(SELECT COUNT(*) FROM files ob JOIN branches obr ON obr.file_id = ob.id
   WHERE ob.branch_of = files.id AND obr.merged_at IS NULL) AS open_branches`;

export async function requireFileRole(
  env: Env,
  userId: string,
  fileId: string,
  needed: Role,
): Promise<{ file: FileRow; role: Role }> {
  const row = await env.DB.prepare(
    `SELECT f.id, f.project_id, f.team_id, f.name, f.created_at, f.updated_at, f.deleted_at,
            f.thumbnail_at, f.is_template, f.branch_of, ${FILE_ROLE} AS role
       FROM ${FILE_ACCESS} WHERE f.id = ?`,
  )
    .bind(userId, fileId)
    .first<FileRow & { role: Role }>();
  if (!row) throw notFound();
  if (!atLeast(row.role, needed)) throw forbidden();
  const { role, ...file } = row;
  return { file, role };
}

/** Parses a JSON body with a zod schema, turning the first issue into a readable 400. */
export async function readBody<S extends z.ZodType>(
  c: Context<AppContext>,
  schema: S,
): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid request.");
  return parsed.data;
}

export function toFile(row: FileRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    thumbnailAt: row.thumbnail_at ?? null,
    isTemplate: row.is_template === 1,
    branchOf: row.branch_of ?? null,
    openBranches: row.open_branches ?? 0,
  };
}
