/**
 * Importing a Figma file by its link, through Figma's REST API, from this
 * browser: the person's access token goes to Figma and nowhere else.
 *
 * One import is one read of the whole file (with its vector geometry), and
 * one more for its images if it has any: Figma's free plans allow only a
 * few file reads a month, so nothing here retries on its own. Then, as for
 * Penpot: create the file, upload the images, convert, and fill the file. A
 * file that fails is removed again, so a failed import leaves nothing behind.
 *
 * The converter loads only when someone imports.
 */
import { api, type FileMeta } from "../api/client";
import type { FileImport } from "./penpot-import";

const FIGMA_API = "https://api.figma.com/v1";

/** A Figma file's key from its link (design, file, proto or board), or a bare key. */
export function figmaFileKey(link: string): string | null {
  const text = link.trim();
  const fromLink = /figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]{10,})/.exec(text)?.[1];
  if (fromLink) return fromLink;
  return /^[A-Za-z0-9]{10,}$/.test(text) ? text : null;
}

/** What Figma's API said, in words someone importing can act on. */
async function figmaError(response: Response): Promise<Error> {
  if (response.status === 403)
    return new Error(
      "Figma turned the token away. Check it's still valid and can read file content.",
    );
  if (response.status === 404)
    return new Error("Figma has no file at that link, or the token's account can't open it.");
  if (response.status === 429) {
    const wait = Number(response.headers.get("Retry-After") ?? "");
    const plan = response.headers.get("X-Figma-Plan-Tier");
    const when =
      Number.isFinite(wait) && wait > 0
        ? wait > 3600
          ? ` Try again in about ${Math.ceil(wait / 3600)} hours.`
          : ` Try again in ${Math.ceil(wait / 60)} minutes.`
        : " Try again later.";
    return new Error(
      `Figma's limit on reading files was reached${plan === "starter" ? " (files on Figma's free plan can be read only a few times a month)" : ""}.${when}`,
    );
  }
  return new Error(`Figma couldn't send the file (${response.status}). Try again.`);
}

async function figma<T>(path: string, token: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${FIGMA_API}/${path}`, { headers: { "X-Figma-Token": token } });
  } catch {
    throw new Error("Couldn't reach Figma. Check your connection and try again.");
  }
  if (!response.ok) throw await figmaError(response);
  return (await response.json()) as T;
}

/** Uploads an image's bytes; null when the server can't take them. */
async function upload(fileId: string, bytes: Blob): Promise<string | null> {
  const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/media`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": bytes.type || "application/octet-stream" },
    body: bytes,
  });
  if (response.status === 413 || response.status === 415 || response.status === 400) return null;
  if (!response.ok) throw new Error("Couldn't upload the file's images. Try again.");
  return ((await response.json()) as { sha: string }).sha;
}

export async function importFigma(
  link: string,
  token: string,
  projectId: string,
  onChange: (files: readonly FileImport[]) => void,
): Promise<readonly FileImport[]> {
  const key = figmaFileKey(link);
  if (!key) throw new Error("That doesn't look like a Figma file link.");
  let row: FileImport = {
    key,
    name: "Reading from Figma…",
    stage: "waiting",
    images: { done: 0, total: 0 },
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

  const [converter, file] = await Promise.all([
    import("@drawpane/figma"),
    figma<import("@drawpane/figma").Figma.File>(`files/${key}?geometry=paths`, token),
  ]);
  let fileId: string | null = null;
  try {
    const { file: created } = await api.post<{ file: FileMeta }>(`/projects/${projectId}/files`, {
      name: file.name.slice(0, 120) || "Imported from Figma",
    });
    fileId = created.id;
    const refs = converter.imageRefs(file);
    update({
      name: file.name,
      stage: "images",
      fileId,
      images: { done: 0, total: refs.length },
      pages: (file.document.children ?? []).length,
    });
    const hashes = new Map<string, string>();
    if (refs.length > 0) {
      // One call for every image's address; each one then downloads from Figma's storage.
      const { meta } = await figma<{ meta?: { images?: Record<string, string | null> } }>(
        `files/${key}/images`,
        token,
      );
      let done = 0;
      for (const ref of refs) {
        const url = meta?.images?.[ref];
        if (url) {
          const response = await fetch(url).catch(() => null);
          if (response?.ok) {
            const sha = await upload(fileId, await response.blob());
            if (sha) hashes.set(ref, sha);
          }
        }
        update({ images: { done: ++done, total: refs.length } });
      }
    }

    update({ stage: "converting" });
    const converted = converter.convertFile(file, { images: (ref) => hashes.get(ref) ?? null });
    update({
      stage: "saving",
      notes: converted.notes.lines(),
      layers: converted.nodes.filter((n) => n.type !== "page").length,
    });
    await api.post(`/files/${fileId}/import`, { nodes: converted.nodes });
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
  return [row];
}
