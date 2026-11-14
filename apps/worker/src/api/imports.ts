/**
 * Importing into a new file: the browser converts the source (a .penpot
 * export, say) to Drawpane nodes and uploads its images as media; this fills
 * the file with those nodes in one go. The file must still be empty.
 */
import { type NodeRecord, NodeRecordSchema } from "@drawpane/model";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/session";
import type { AppContext } from "../env";
import { readCapped } from "../lib/body";
import { badRequest, conflict } from "../lib/http";
import { requireFileRole } from "./access";

/** A converted file's JSON; generous, since large design files are mostly nodes. */
export const IMPORT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_NODES = 200_000;

const ImportBody = z.object({ nodes: z.array(NodeRecordSchema).min(1).max(MAX_NODES) });

export const imports = new Hono<AppContext>()
  /** Fills an empty file with nodes (editors). */
  .post("/files/:fileId/import", async (c) => {
    const user = requireUser(c);
    const { file } = await requireFileRole(c.env, user.id, c.req.param("fileId"), "editor");
    const bytes = await readCapped(
      c.req.raw,
      IMPORT_MAX_BYTES,
      "That file is too large to import (64 MB at most).",
    );
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw badRequest("The import isn't valid JSON.");
    }
    const parsed = ImportBody.safeParse(json);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid import.");
    const room = c.env.FILE_ROOM.get(c.env.FILE_ROOM.idFromName(file.id));
    const result = await room.importNodes(
      { userId: user.id, name: user.name },
      parsed.data.nodes as NodeRecord[],
    );
    if (!result.ok) {
      if (result.reason === "not-empty")
        throw conflict("This file already has content; import into a new file.");
      throw badRequest(result.message);
    }
    await c.env.DB.prepare("UPDATE files SET updated_at = ? WHERE id = ?")
      .bind(Date.now(), file.id)
      .run();
    return c.json({ revn: result.revn, nodes: result.nodes });
  });
