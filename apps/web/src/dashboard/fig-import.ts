/**
 * Importing a .fig file (Figma's "Save local copy"): read and converted in
 * a Worker (`fig.worker.ts`), with the same converter, uploads and saving as
 * the import by link, so both bring a file in alike. No token and no reads
 * against Figma's limits: everything is in the file.
 *
 * Opening the file decodes it and lists its pages with their estimated
 * sizes, in seconds. A file that fits one Drawpane file is then imported
 * whole; a larger one has its pages chosen first (the dialog's picker),
 * and can be imported again, other pages into another file, without
 * reading it twice.
 *
 * Reading problems (not a .fig, a FigJam board, too large) throw before
 * anything is created, so the dialog shows them where the file was chosen.
 * Once the Drawpane file exists, a failure removes it again, so a failed
 * import leaves nothing behind.
 */
import type { FigPage, ImportErrorCode, ReadProgress } from "@drawpane/fig";
import type { NodeRecord } from "@drawpane/model";
import { api, type FileMeta } from "../api/client";
import { enqueueMediaPreviews } from "../editor/image-preview";
import { ImportTooLarge, saveImport } from "./import-save";
import { detachedNote, type FileImport } from "./penpot-import";

export type FigWorkerRequest =
  | { readonly type: "open"; readonly bytes: ArrayBuffer; readonly name: string }
  | { readonly type: "read"; readonly pageIds: readonly string[] | null }
  | { readonly type: "convert"; readonly images: readonly (readonly [string, string])[] };

export type FigWorkerReply =
  | { readonly type: "progress"; readonly progress: ReadProgress }
  | {
      readonly type: "opened";
      readonly name: string;
      readonly pages: readonly FigPage[];
      readonly layers: number;
    }
  | {
      readonly type: "read";
      readonly pages: number;
      readonly notes: readonly string[];
      readonly images: readonly { ref: string; mime: string; bytes: Uint8Array }[];
    }
  | { readonly type: "converted"; readonly nodes: NodeRecord[]; readonly notes: readonly string[] }
  | { readonly type: "error"; readonly message: string; readonly code: ImportErrorCode | null };

/** What reading the file said went wrong, and whether choosing fewer pages would help. */
export class FigImportError extends Error {
  constructor(
    message: string,
    readonly code: ImportErrorCode | null,
    /** For pages too large for one file, measured: how much of them would fit, 0 to 1. */
    readonly fits: number | null = null,
  ) {
    super(message);
  }
  /** The chosen pages come to more than one Drawpane file holds. */
  get tooManyLayers(): boolean {
    return this.code === "too-many-layers";
  }
}

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
  const { sha } = (await response.json()) as { sha: string };
  enqueueMediaPreviews(sha, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
  return sha;
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
      else if (data.type === "error") reject(new FigImportError(data.message, data.code));
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

/** A .fig file decoded in its worker, its pages known; `close` lets the worker go. */
export interface OpenedFigImport {
  readonly name: string;
  readonly pages: readonly FigPage[];
  /** About how many layers the whole file comes to, instances filled in. */
  readonly layers: number;
  /**
   * Imports the pages named (all of them for null) into a new file in the project. A file of
   * some of the pages is named for them. Throws a FigImportError, before creating anything, when
   * the pages can't be read; `tooManyLayers` when they come to more than one file holds.
   */
  import(
    projectId: string,
    pageIds: readonly string[] | null,
    onChange: (files: readonly FileImport[]) => void,
  ): Promise<readonly FileImport[]>;
  close(): void;
}

/** A Drawpane file's name for some of a Figma file's pages. */
export function partName(
  name: string,
  pages: readonly FigPage[],
  chosen: readonly string[] | null,
) {
  if (chosen === null || chosen.length === pages.length) return name;
  if (chosen.length === 1)
    return `${name}: ${pages.find((p) => p.id === chosen[0])?.name ?? "1 page"}`;
  return `${name} (${chosen.length} of ${pages.length} pages)`;
}

/** Decodes a .fig file in a worker and lists its pages; throws a FigImportError on a file it can't read. */
export async function openFigImport(
  source: File,
  onProgress: (progress: ReadProgress) => void = () => undefined,
): Promise<OpenedFigImport> {
  const worker = new Worker(new URL("./fig.worker.ts", import.meta.url), {
    type: "module",
    name: "fig-import",
  });
  try {
    const bytes = await source.arrayBuffer();
    const opened = await ask(
      worker,
      { type: "open", bytes, name: source.name },
      "opened",
      onProgress,
      [bytes],
    );
    return {
      name: opened.name,
      pages: opened.pages,
      layers: opened.layers,
      import: (projectId, pageIds, onChange) =>
        importPages(worker, opened, source, projectId, pageIds, onChange),
      close: () => worker.terminate(),
    };
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

async function importPages(
  worker: Worker,
  opened: Extract<FigWorkerReply, { type: "opened" }>,
  source: File,
  projectId: string,
  pageIds: readonly string[] | null,
  onChange: (files: readonly FileImport[]) => void,
): Promise<readonly FileImport[]> {
  const name = partName(opened.name, opened.pages, pageIds);
  let row: FileImport = {
    key: `${source.name}:${source.size}:${source.lastModified}:${pageIds?.join(",") ?? "all"}`,
    name,
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
  const onProgress = (p: ReadProgress) => {
    if (p.stage === "pages") update({ building: { done: p.done, total: p.total } });
  };

  const { pinInstances } = await import("@drawpane/editor");
  // Errors reading the pages go back to the dialog: nothing has been created yet.
  const read = await ask(worker, { type: "read", pageIds }, "read", onProgress);
  let fileId: string | null = null;
  try {
    const { file: created } = await api.post<{ file: FileMeta }>(`/projects/${projectId}/files`, {
      name: name.slice(0, 120) || "Imported from Figma",
    });
    fileId = created.id;
    update({
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
    await saveImport(fileId, pinned.nodes);
    update({ stage: "done" });
  } catch (error) {
    // Nothing half-imported stays behind.
    if (fileId) await api.delete(`/files/${fileId}`).catch(() => undefined);
    // Too large once converted: fewer pages will do, so they're chosen again.
    if (error instanceof ImportTooLarge)
      throw new FigImportError(
        `${error.message} Choose fewer pages.`,
        "too-many-layers",
        error.fits,
      );
    update({
      stage: "failed",
      fileId: null,
      error: error instanceof Error ? error.message : "The import failed.",
    });
  }
  return [row];
}
