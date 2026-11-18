/**
 * Images for headless renders (decision 0023): an image fill's file by its
 * hash, from R2 (`media/<sha>`), with the type and size recorded when it was
 * uploaded. Only images the file's team may read, as the media API checks.
 */

import { mediaKey } from "@drawpane/worker/src/api/media";
import type { Env } from "../env";

/** What the headless renderer's image loader returns (`ImageFile` in @drawpane/editor). */
export interface WorkerImage {
  readonly bytes: Uint8Array;
  readonly type: string;
  readonly width: number;
  readonly height: number;
}

export function workerImageLoader(
  env: Env,
  teamId: string,
): (ref: string) => Promise<WorkerImage | null> {
  return async (ref) => {
    if (!/^[0-9a-f]{64}$/.test(ref)) return null;
    const row = await env.DB.prepare(
      "SELECT mime, width, height FROM media WHERE sha = ? AND team_id = ?",
    )
      .bind(ref, teamId)
      .first<{ mime: string; width: number; height: number }>();
    if (!row) return null;
    const object = await env.FILES.get(mediaKey(ref));
    if (!object) return null;
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      type: row.mime,
      width: row.width,
      height: row.height,
    };
  };
}
