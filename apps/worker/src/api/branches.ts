/**
 * Branches (docs/decisions/0012-branches.md): a branch is a file of its own,
 * copied from its main file at a revision, with that revision's nodes kept
 * as its base. Review compares the three (base, branch, main); merging
 * happens in the main file's room, as one ordinary transaction after a
 * restore point, after which the branch is read-only history.
 */
import { type BranchInfo, type NodeRecord, newId, searchFold } from "@drawpane/model";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/session";
import type { AppContext, Env } from "../env";
import { badRequest, conflict, notFound } from "../lib/http";
import type { MergeResult, UpdateResult } from "../rooms/file-room";
import { branchBaseKey, readSnapshot, writeSnapshot } from "../rooms/snapshots";
import { type FileRow, readBody, requireFileRole } from "./access";
import { thumbnailKey } from "./media";

const BranchName = z
  .string()
  .trim()
  .min(1, "Give the branch a name.")
  .max(120, "Keep branch names under 120 characters.");

function room(env: Env, fileId: string) {
  return env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
}

interface BranchRow {
  id: string;
  name: string;
  branch_of: string;
  created_at: number;
  updated_at: number;
  thumbnail_at: number | null;
  created_by: string | null;
  created_by_name: string | null;
  base_revn: number;
  merged_at: number | null;
  merged_by: string | null;
  merged_by_name: string | null;
  merged_revn: number | null;
  merged_changes: number | null;
}

const BRANCH_SELECT = `SELECT f.id, f.name, f.branch_of, f.created_at, f.updated_at, f.thumbnail_at,
       f.created_by, cu.name AS created_by_name, b.base_revn, b.merged_at, b.merged_by,
       mu.name AS merged_by_name, b.merged_revn, b.merged_changes
  FROM files f JOIN branches b ON b.file_id = f.id
  LEFT JOIN users cu ON cu.id = f.created_by
  LEFT JOIN users mu ON mu.id = b.merged_by`;

const person = (id: string | null, name: string | null) =>
  id && name !== null ? { id, name } : null;

function toBranch(row: BranchRow): BranchInfo {
  return {
    id: row.id,
    name: row.name,
    mainId: row.branch_of,
    baseRevn: row.base_revn,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: person(row.created_by, row.created_by_name),
    thumbnailAt: row.thumbnail_at,
    merged:
      row.merged_at === null
        ? null
        : {
            at: row.merged_at,
            by: person(row.merged_by, row.merged_by_name),
            revn: row.merged_revn,
            changes: row.merged_changes,
          },
  };
}

/** A branch file's record, or null when the file isn't a branch. */
export async function branchInfo(env: Env, fileId: string): Promise<BranchInfo | null> {
  const row = await env.DB.prepare(`${BRANCH_SELECT} WHERE f.id = ?`)
    .bind(fileId)
    .first<BranchRow>();
  return row ? toBranch(row) : null;
}

/** Deletes a branch's room and stored objects. Its D1 rows go with its file row. */
async function deleteBranchStorage(env: Env, branchId: string): Promise<void> {
  await room(env, branchId).destroy();
  // The room only knows its file once someone has opened it: delete by prefix here too.
  const listed = await env.FILES.list({ prefix: `files/${branchId}/` });
  const keys = [...listed.objects.map((o) => o.key), thumbnailKey(branchId)];
  await env.FILES.delete([...new Set(keys)]);
}

/** Deletes every branch of a main file for good, before the main file itself goes. */
export async function deleteBranchesOf(env: Env, mainId: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM files WHERE branch_of = ?")
    .bind(mainId)
    .all<{ id: string }>();
  for (const { id } of results) await deleteBranchStorage(env, id);
  await env.DB.prepare("DELETE FROM files WHERE branch_of = ?").bind(mainId).run();
}

/**
 * Makes a branch of `main` (checked by the caller: a main file the person can
 * edit, not in trash): a copy of it now, with that as its base. Throws a
 * conflict, leaving nothing behind, when it can't be made.
 */
export async function makeBranch(
  env: Env,
  by: { readonly id: string; readonly name: string },
  main: FileRow,
  name: string,
): Promise<BranchInfo> {
  // Main's nodes and the revision they're at, read together.
  const base = (await room(env, main.id).snapshot()) as { revn: number; nodes: NodeRecord[] };
  const id = newId();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO files (id, project_id, team_id, name, search_name, created_by, created_at, updated_at, branch_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, main.project_id, main.team_id, name, searchFold(name), by.id, now, now, main.id),
    env.DB.prepare("INSERT INTO branches (file_id, base_revn) VALUES (?, ?)").bind(id, base.revn),
  ]);
  try {
    await writeSnapshot(env.FILES, id, base.revn, now, base.nodes, branchBaseKey(id));
    const copied = await room(env, id).importNodes(
      { userId: by.id, name: by.name },
      base.nodes,
      id,
    );
    if (!copied.ok) throw new Error(`couldn't copy into the branch: ${copied.reason}`);
    // The branch looks like its main file in the branch list straight away.
    const thumbnail = await env.FILES.get(thumbnailKey(main.id));
    if (thumbnail) {
      await env.FILES.put(thumbnailKey(id), thumbnail.body, {
        httpMetadata: thumbnail.httpMetadata ?? {},
      });
      await env.DB.prepare("UPDATE files SET thumbnail_at = ? WHERE id = ?").bind(now, id).run();
    }
  } catch (error) {
    console.error(`couldn't make a branch of ${main.id}`, error);
    await deleteBranchStorage(env, id);
    await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
    throw conflict("The branch couldn't be made. Try again.");
  }
  return (await branchInfo(env, id)) as BranchInfo;
}

/** A branch, checked: the person can see it, and it is one. */
async function requireBranch(env: Env, userId: string, fileId: string) {
  const { file, role } = await requireFileRole(env, userId, fileId, "viewer");
  if (!file.branch_of) throw notFound("That file isn't a branch.");
  return { file: file as FileRow & { branch_of: string }, role };
}

export const branches = new Hono<AppContext>()
  /**
   * A file's branches, open ones first (most recently edited first), then
   * merged ones. From a branch, its main file's branches.
   */
  .get("/files/:fileId/branches", async (c) => {
    const user = requireUser(c);
    const { file, role } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "viewer");
    const mainId = file.branch_of ?? file.id;
    // From a merged branch (read-only), the main file says whether they can branch.
    const mainRole = file.branch_of
      ? (await requireFileRole(c.env, user.id, mainId, "viewer")).role
      : role;
    const { results } = await c.env.DB.prepare(
      `${BRANCH_SELECT} WHERE f.branch_of = ? AND f.deleted_at IS NULL
        ORDER BY b.merged_at IS NOT NULL, COALESCE(b.merged_at, f.updated_at) DESC`,
    )
      .bind(mainId)
      .all<BranchRow>();
    return c.json({ mainId, canBranch: mainRole !== "viewer", branches: results.map(toBranch) });
  })

  /** Makes a branch of a main file (editors): a copy of it now, with that as its base. */
  .post("/files/:fileId/branches", async (c) => {
    const user = requireUser(c);
    const { file: main } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    if (main.branch_of) throw badRequest("Branches are made from main files, not from branches.");
    if (main.deleted_at !== null)
      throw conflict("Restore the file from trash before branching it.");
    const { name } = await readBody(c, z.object({ name: BranchName }));

    return c.json({ branch: await makeBranch(c.env, user, main, name) }, 201);
  })

  /**
   * What review compares: the branch's base, the branch now and main now,
   * from which the editor works out the changes and their conflicts. Merging
   * works them out again against main as it is then (see merge).
   */
  .get("/files/:fileId/branch/review", async (c) => {
    const user = requireUser(c);
    const { file } = await requireBranch(c.env, user.id, c.req.param("fileId"));
    const base = await readSnapshot(c.env.FILES, branchBaseKey(file.id));
    if (!base) throw conflict("This branch's starting point is missing, so it can't be reviewed.");
    const [branch, main] = await Promise.all([
      room(c.env, file.id).snapshot(),
      room(c.env, file.branch_of).snapshot(),
    ]);
    return c.json({ base, branch: branch.nodes, main: main.nodes, mainRevn: main.revn });
  })

  /**
   * Merges the branch into its main file (editors on the main file), with a
   * side for each conflict and any changes left out. Main's room works out
   * the changes against itself and applies them as one transaction, after
   * saving a restore point. The branch then becomes read-only history, and
   * everyone in it hears so at once.
   */
  .post("/files/:fileId/branch/merge", async (c) => {
    const user = requireUser(c);
    const { file } = await requireBranch(c.env, user.id, c.req.param("fileId"));
    await requireFileRole(c.env, user.id, file.branch_of, "editor");
    const choices = await readBody(
      c,
      z.object({
        resolutions: z.record(z.string().max(200), z.enum(["branch", "main"])).default({}),
        skip: z.array(z.string().max(200)).max(50_000).default([]),
      }),
    );
    // Claimed first, so two people merging at once can't both apply it.
    const now = Date.now();
    const claimed = await c.env.DB.prepare(
      "UPDATE branches SET merged_at = ?, merged_by = ? WHERE file_id = ? AND merged_at IS NULL",
    )
      .bind(now, user.id, file.id)
      .run();
    if (claimed.meta.changes === 0) throw conflict("This branch was already merged.");
    const release = () =>
      c.env.DB.prepare("UPDATE branches SET merged_at = NULL, merged_by = NULL WHERE file_id = ?")
        .bind(file.id)
        .run();

    let result: MergeResult;
    try {
      const base = await readSnapshot(c.env.FILES, branchBaseKey(file.id));
      if (!base) throw conflict("This branch's starting point is missing, so it can't be merged.");
      const branch = await room(c.env, file.id).snapshot();
      result = (await room(c.env, file.branch_of).mergeBranch(
        { userId: user.id, name: user.name },
        file.branch_of,
        { id: file.id, name: file.name },
        { base, branch: branch.nodes as NodeRecord[] },
        choices,
      )) as MergeResult;
    } catch (error) {
      await release();
      throw error;
    }
    if (!result.ok) {
      await release();
      throw result.reason === "undecided"
        ? conflict(
            `Main changed while you were reviewing: ${result.undecided === 1 ? "a conflict needs" : `${result.undecided} conflicts need`} a decision. Review again.`,
          )
        : conflict(`These changes can't be merged as they are. ${result.message}`);
    }
    await c.env.DB.prepare(
      "UPDATE branches SET merged_revn = ?, merged_changes = ? WHERE file_id = ?",
    )
      .bind(result.revn, result.changes, file.id)
      .run();
    await room(c.env, file.id).merged({ id: user.id, name: user.name });
    return c.json({
      branch: await branchInfo(c.env, file.id),
      revn: result.revn,
      restorePoint: result.restorePoint,
    });
  })

  /**
   * Brings main's changes since the branch was made (or last updated) into
   * the branch (editors on the branch), and moves its base forward to main
   * as it is now. Where both changed the same thing the branch keeps its
   * own, which review then shows against main as it is now.
   */
  .post("/files/:fileId/branch/update", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    if (!file.branch_of) throw notFound("That file isn't a branch.");
    const base = await readSnapshot(c.env.FILES, branchBaseKey(file.id));
    if (!base) throw conflict("This branch's starting point is missing, so it can't be updated.");
    const main = (await room(c.env, file.branch_of).snapshot()) as {
      revn: number;
      nodes: NodeRecord[];
    };
    const result = (await room(c.env, file.id).updateFromMain(
      { userId: user.id, name: user.name },
      file.id,
      { base, main: main.nodes },
    )) as UpdateResult;
    if (!result.ok)
      throw conflict(`Main's changes can't be brought in as they are. ${result.message}`);
    // The branch now starts from main as it is: that's its base from here on.
    await writeSnapshot(
      c.env.FILES,
      file.id,
      main.revn,
      Date.now(),
      main.nodes,
      branchBaseKey(file.id),
    );
    await c.env.DB.prepare("UPDATE branches SET base_revn = ? WHERE file_id = ?")
      .bind(main.revn, file.id)
      .run();
    return c.json({
      branch: await branchInfo(c.env, file.id),
      changes: result.changes,
      kept: result.kept,
    });
  })

  /** Deletes a branch for good (editors on the main file). Branches don't go to trash. */
  .delete("/files/:fileId/branch", async (c) => {
    const user = requireUser(c);
    const { file } = await requireBranch(c.env, user.id, c.req.param("fileId"));
    await requireFileRole(c.env, user.id, file.branch_of, "editor");
    await deleteBranchStorage(c.env, file.id);
    await c.env.DB.prepare("DELETE FROM files WHERE id = ?").bind(file.id).run();
    return c.json({ ok: true });
  });
