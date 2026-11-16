/**
 * Importing a .fig file (Figma's "Save local copy"): read and converted in
 * a Worker (`fig.worker.ts`), with the same converter, uploads and saving as
 * the import by link, so both bring a file in alike. No token and no reads
 * against Figma's limits: everything is in the file.
 *
 * Reading problems (not a .fig, a FigJam board, too large) throw before
 * anything is created, so the dialog shows them where the file was chosen.
 * Once the Drawpane file exists, a failure removes it again, so a failed
 * import leaves nothing behind.
 */
import type { ReadProgress } from "@drawpane/fig";
import type { NodeRecord } from "@drawpane/model";
import { api, type FileMeta } from "../api/client";
import { detachedNote, type FileImport } from "./penpot-import";

export type FigWorkerRequest =
  | { readonly type: "read"; readonly bytes: ArrayBuffer; readonly name: string }
  | { readonly type: "convert"; readonly images: readonly (readonly [string, string])[] };

export type FigWorkerReply =
  | { readonly type: "progress"; readonly progress: ReadProgress }
  | {
      readonly type: "read";
      readonly name: string;
      readonly pages: number;
      readonly notes: readonly string[];
      readonly images: readonly { ref: string; mime: string; bytes: Uint8Array }[];
    }
  | { readonly type: "converted"; readonly nodes: NodeRecord[]; readonly notes: readonly string[] }
  | { readonly type: "error"; readonly message: string };

/** Whether a dropped or chosen file looks like a Figma .fig file. */
export const isFigFile = (file: File) => /\.fig$/i.test(file.name);

/** Uploads an image's bytes; null when the server can't take them (an unsupported format, say). */
async function upload(fileId: string, bytes: Uint8Array, mime: string): Promise<string | null> {
  const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/media`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": mime },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  if (response.status === 413 || response.status === 415 || response.status === 400) return null;
  if (!response.ok) throw new Error("Couldn't upload the file's images. Try again.");
  return ((await response.json()) as { sha: string }).sha;
}

/** One request to the worker, and its answer; progress on the way goes to `onProgress`. */
function ask<T extends FigWorkerReply["type"]>(
  worker: Worker,
  request: FigWorkerRequest,
  answer: T,
  onProgress: (progress: ReadProgress) => void,
  transfer: Transferable[] = [],
): Promise<Extract<FigWorkerReply, { type: T }>> {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<FigWorkerReply>) => {
      if (data.type === "progress") onProgress(data.progress);
      else if (data.type === "error") reject(new Error(data.message));
      else if (data.type === answer) resolve(data as Extract<FigWorkerReply, { type: T }>);
    };
    // The worker itself stopped: almost always out of memory on a very large file.
    worker.onerror = (event) => {
      event.preventDefault();
      reject(
        new Error(
          "Reading this file stopped part way, probably for lack of memory. Try a smaller file, or split it in Figma.",
        ),
      );
    };
    worker.postMessage(request, transfer);
  });
}

export async function importFig(
  source: File,
  projectId: string,
  onChange: (files: readonly FileImport[]) => void,
): Promise<readonly FileImport[]> {
  let row: FileImport = {
    key: `${source.name}:${source.size}:${source.lastModified}`,
    name: source.name.replace(/\.fig$/i, "") || "Figma file",
    stage: "reading",
    images: { done: 0, total: 0 },
    building: { done: 0, total: 0 },
    pages: 0,
    layers: 0,
    fileId: null,
    notes: [],
    components: 0,
    error: null,
  };
  const update = (patch: Partial<FileImport>) => {
    row = { ...row, ...patch };
    onChange([row]);
  };
  onChange([row]);

  const worker = new Worker(new URL("./fig.worker.ts", import.meta.url), {
    type: "module",
    name: "fig-import",
  });
  const onProgress = (p: ReadProgress) => {
    if (p.stage === "pages") update({ building: { done: p.done, total: p.total } });
  };
  const [{ pinInstances }, bytes] = await Promise.all([
    import("@drawpane/editor"),
    source.arrayBuffer(),
  ]);
  let fileId: string | null = null;
  try {
    // Errors reading the file go back to the dialog: nothing has been created yet.
    const read = await ask(worker, { type: "read", bytes, name: source.name }, "read", onProgress, [
      bytes,
    ]);
    try {
      const { file: created } = await api.post<{ file: FileMeta }>(`/projects/${projectId}/files`, {
        name: read.name.slice(0, 120) || "Imported from Figma",
      });
      fileId = created.id;
      update({
        name: read.name,
        stage: "images",
        fileId,
        pages: read.pages,
        images: { done: 0, total: read.images.length },
      });
      const hashes: [string, string][] = [];
      let done = 0;
      for (const image of read.images) {
        const sha = await upload(fileId, image.bytes, image.mime);
        if (sha) hashes.push([image.ref, sha]);
        update({ images: { done: ++done, total: read.images.length } });
      }

      update({ stage: "converting" });
      const converted = await ask(
        worker,
        { type: "convert", images: hashes },
        "converted",
        onProgress,
      );
      // Copies open as Figma shows them, not snapped back to their mains.
      const pinned = pinInstances(converted.nodes);
      update({
        stage: "saving",
        notes: [...read.notes, ...converted.notes, ...detachedNote(pinned.detached)],
        layers: pinned.nodes.filter((n) => n.type !== "page").length,
        components: pinned.nodes.filter((n) => n.props.isComponent === true).length,
      });
      await api.post(`/files/${fileId}/import`, { nodes: pinned.nodes });
      update({ stage: "done" });
    } catch (error) {
      // Nothing half-imported stays behind.
      if (fileId) await api.delete(`/files/${fileId}`).catch(() => undefined);
      update({
        stage: "failed",
        fileId: null,
        error: error instanceof Error ? error.message : "The import failed.",
      });
    }
  } finally {
    worker.terminate();
  }
  return [row];
}
