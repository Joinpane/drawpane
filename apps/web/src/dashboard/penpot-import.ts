/**
 * Importing a .penpot export: each file in it becomes a Drawpane file in the
 * project. For each one: create the file, upload its images (the converter
 * needs their hashes), convert it, and fill the file with the result. A file
 * that fails is removed again, so a failed import leaves nothing behind.
 *
 * The Penpot reader and converter load only when someone imports.
 */
import { api, type FileMeta } from "../api/client";

export type ImportStage = "waiting" | "images" | "converting" | "saving" | "done" | "failed";

export interface FileImport {
  readonly key: string;
  readonly name: string;
  readonly stage: ImportStage;
  readonly images: { readonly done: number; readonly total: number };
  readonly pages: number;
  readonly layers: number;
  /** The Drawpane file, once created. */
  readonly fileId: string | null;
  /** What couldn't come across exactly, in words. */
  readonly notes: readonly string[];
  readonly error: string | null;
}

interface MediaInfo {
  readonly sha: string;
}

/** Uploads an image's bytes; null when the server can't take it (an unsupported format, say). */
async function upload(fileId: string, bytes: Uint8Array, mime: string): Promise<string | null> {
  const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/media`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": mime },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  if (response.status === 413 || response.status === 415 || response.status === 400) return null;
  if (!response.ok) throw new Error("Couldn't upload the file's images. Try again.");
  return ((await response.json()) as MediaInfo).sha;
}

export async function importPenpot(
  source: Blob,
  projectId: string,
  onChange: (files: readonly FileImport[]) => void,
): Promise<readonly FileImport[]> {
  const penpot = await import("@drawpane/penpot");
  const exp = await penpot.readPenpot(new Uint8Array(await source.arrayBuffer()));
  let files: FileImport[] = exp.files.map((f) => ({
    key: f.id,
    name: f.name,
    stage: "waiting",
    images: { done: 0, total: 0 },
    pages: f.pages.length,
    layers: penpot.layerCount(f),
    fileId: null,
    notes: [],
    error: null,
  }));
  const update = (key: string, patch: Partial<FileImport>) => {
    files = files.map((f) => (f.key === key ? { ...f, ...patch } : f));
    onChange(files);
  };
  onChange(files);

  for (const file of exp.files) {
    let fileId: string | null = null;
    try {
      const { file: created } = await api.post<{ file: FileMeta }>(`/projects/${projectId}/files`, {
        name: file.name.slice(0, 120) || "Imported",
      });
      fileId = created.id;
      const images = penpot.imagesOf(exp, file);
      update(file.id, { stage: "images", fileId, images: { done: 0, total: images.length } });
      const hashes = new Map<string, string>();
      let done = 0;
      for (const image of images) {
        const sha = await upload(fileId, await image.read(), image.mime);
        if (sha) hashes.set(image.mediaId, sha);
        update(file.id, { images: { done: ++done, total: images.length } });
      }

      update(file.id, { stage: "converting" });
      const converted = penpot.convertFile(file, (id) => hashes.get(id));
      update(file.id, { stage: "saving", notes: converted.notes.lines() });
      await api.post(`/files/${fileId}/import`, { nodes: converted.nodes });
      update(file.id, { stage: "done" });
    } catch (error) {
      // Nothing half-imported stays behind.
      if (fileId) await api.delete(`/files/${fileId}`).catch(() => undefined);
      update(file.id, {
        stage: "failed",
        fileId: null,
        error: error instanceof Error ? error.message : "The import failed.",
      });
    }
  }
  return files;
}

/** Whether a dropped or chosen file looks like a Penpot export. */
export const isPenpotFile = (file: File) => /\.penpot$/i.test(file.name);
