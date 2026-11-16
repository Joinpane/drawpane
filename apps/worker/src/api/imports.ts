/**
 * Importing into a new file (decision 0026): the browser converts the
 * source (a .fig, a Figma file read by link, a .penpot export) to Drawpane
 * nodes and uploads its images as media; these fill the file with the nodes.
 * The file must still be empty.
 *
 * A large import comes in parts: `POST /files/:id/imports` begins one,
 * `POST …/imports/:importId/parts` sends a few MB of nodes at a time (each
 * checked and kept aside by the file's room), `POST …/commit` checks the
 * whole and fills the file in one go, and `DELETE …/imports/:importId` gives
 * up. Nothing shows in the file until the commit, and a failed or abandoned
 * import leaves it empty. `POST /files/:id/import` does all three in one
 * request, for imports of one part.
 */
import {
  ID_PATTERN,
  MAX_IMPORT_PART_BYTES,
  type NodeRecord,
  NodeRecordSchema,
} from "@drawpane/model";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/session";
import type { AppContext, Env } from "../env";
import { readCapped } from "../lib/body";
import { badRequest, conflict, notFound } from "../lib/http";
import type { ImportPartResult, ImportResult } from "../rooms/file-room";
import { readBody, requireFileRole } from "./access";

/** The most one request sends: a part, or a whole one-request import. */
export const IMPORT_MAX_BYTES = MAX_IMPORT_PART_BYTES;
/** Nodes in one part at most: a part is a few MB, so this only stops a flood of tiny ones. */
const PART_NODES = 100_000;
const Part = z.object({ nodes: z.array(NodeRecordSchema).min(1).max(PART_NODES) });

function room(env: Env, fileId: string) {
  return env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
}

/** A request's nodes: read up to the cap, parsed and shaped (the room checks their values). */
async function readNodes(request: Request): Promise<NodeRecord[]> {
  const bytes = await readCapped(
    request,
    IMPORT_MAX_BYTES,
    `That's too much to send at once (${IMPORT_MAX_BYTES / (1024 * 1024)} MB at most): send it in parts.`,
  );
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw badRequest("The import isn't valid JSON.");
  }
  const parsed = Part.safeParse(json);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid import.");
  // Override records (decision 0029) come only into a file that stores compact copies: the
  // room says, for each part and again at the commit.
  return parsed.data.nodes as NodeRecord[];
}

const GONE =
  "That import isn't there any more (it was finished, given up, or left too long). Start again.";

/** The answer for a commit, with the file's edited time moved on when it went through. */
async function committed(env: Env, fileId: string, result: ImportResult) {
  if (!result.ok) {
    if (result.reason === "not-empty")
      throw conflict("This file already has content; import into a new file.");
    if (result.reason === "gone") throw notFound(GONE);
    if (result.reason === "changed")
      throw conflict(
        "This file changed while the import was under way, so nothing was imported. Import into a new file.",
      );
    throw badRequest(result.message);
  }
  await env.DB.prepare("UPDATE files SET updated_at = ? WHERE id = ?")
    .bind(Date.now(), fileId)
    .run();
  return { revn: result.revn, nodes: result.nodes };
}

function importId(id: string): string {
  if (!ID_PATTERN.test(id)) throw notFound(GONE);
  return id;
}

export const imports = new Hono<AppContext>()
  /** Fills an empty file with nodes in one request (editors): an import of one part. */
  .post("/files/:fileId/import", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    const nodes = await readNodes(c.req.raw);
    const result = (await room(c.env, file.id).importNodes(
      { userId: user.id, name: user.name },
      nodes,
      file.id,
    )) as ImportResult;
    return c.json(await committed(c.env, file.id, result));
  })

  /** Begins an import in parts into an empty file (editors). */
  .post("/files/:fileId/imports", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    const begun = await room(c.env, file.id).beginImport(file.id);
    if (!begun.ok) throw conflict("This file already has content; import into a new file.");
    // How the file stores copies (decision 0029): the browser converts before sending when it can.
    return c.json(
      { importId: begun.importId, partBytes: IMPORT_MAX_BYTES, copies: begun.copies },
      201,
    );
  })

  /** One part of an import's nodes, checked and kept for the commit. */
  .post("/files/:fileId/imports/:importId/parts", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    const id = importId(c.req.param("importId"));
    const nodes = await readNodes(c.req.raw);
    const result = (await room(c.env, file.id).importPart(file.id, id, nodes)) as ImportPartResult;
    if (!result.ok) {
      if (result.reason === "gone") throw notFound(GONE);
      throw badRequest(result.message);
    }
    return c.json({ staged: result.staged });
  })

  /** Checks the whole import and fills the file with it, all at once. */
  .post("/files/:fileId/imports/:importId/commit", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    const id = importId(c.req.param("importId"));
    // How the parts store copies: the browser says `compact` when it converted them.
    const { copies } = await readBody(
      c,
      // An empty body (a client from before compact copies) is materialized.
      z.preprocess(
        (body) => body ?? {},
        z.object({ copies: z.enum(["materialized", "compact"]).default("materialized") }),
      ),
    );
    const result = (await room(c.env, file.id).commitImport(
      { userId: user.id, name: user.name },
      file.id,
      id,
      copies,
    )) as ImportResult;
    return c.json(await committed(c.env, file.id, result));
  })

  /** Gives up an import: what was sent is thrown away, and the file stays empty. */
  .delete("/files/:fileId/imports/:importId", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    await room(c.env, file.id).abortImport(file.id, importId(c.req.param("importId")));
    return c.json({ ok: true });
  });
