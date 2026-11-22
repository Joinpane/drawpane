/**
 * Making new files: blank, with a first frame of a chosen size, from a
 * built-in template, or as a copy of a team template. Content built here is
 * filled in through the import endpoint; a copy is made by the server.
 */
import type { Editor } from "@drawpane/editor";
import { api, type FileMeta } from "../api/client";
import { useEngineRenderer } from "../editor/renderer-switch";
import { renderPageThumbnail } from "../editor/thumbnail";
import { nodesOf, scratchEditor } from "./scratch";
import { type BuiltInTemplate, buildTemplate } from "./templates";

async function fill(projectId: string, name: string, editor: Editor): Promise<FileMeta> {
  const { file } = await api.post<{ file: FileMeta }>(`/projects/${projectId}/files`, { name });
  try {
    await api.post(`/files/${file.id}/import`, { nodes: nodesOf(editor) });
  } catch (error) {
    // No half-made file left behind.
    await api.delete(`/files/${file.id}`).catch(() => undefined);
    throw error;
  }
  return file;
}

export async function createBlank(projectId: string): Promise<FileMeta> {
  return (await api.post<{ file: FileMeta }>(`/projects/${projectId}/files`, { name: "Untitled" }))
    .file;
}

/** A new file with one frame of `width` × `height`, named for its size. */
export async function createSized(
  projectId: string,
  frame: { name: string; width: number; height: number },
): Promise<FileMeta> {
  const { editor, pageId } = await scratchEditor();
  editor.createLayer("frame", { x: 0, y: 0, width: frame.width, height: frame.height }, pageId, {
    name: frame.name,
    fills: [{ type: "solid", color: "#ffffff" }],
  });
  return fill(projectId, "Untitled", editor);
}

export async function createFromTemplate(
  projectId: string,
  template: BuiltInTemplate,
): Promise<FileMeta> {
  const { editor, pageId } = await scratchEditor();
  buildTemplate(template, editor, pageId);
  return fill(projectId, template.name, editor);
}

export async function createFromFile(projectId: string, file: FileMeta): Promise<FileMeta> {
  return (
    await api.post<{ file: FileMeta }>(`/projects/${projectId}/files`, {
      name: file.name,
      from: file.id,
    })
  ).file;
}

const previews = new Map<string, Promise<string | null>>();

/**
 * A picture of a built-in template, drawn from the same build the file gets (following the
 * renderer switch: engine snapshot service when engine is on, CanvasRenderer in canvas mode).
 * Cached for the session as an object URL.
 */
export function templatePreview(template: BuiltInTemplate): Promise<string | null> {
  const key = `${template.id}:${useEngineRenderer() ? "engine" : "canvas"}`;
  let preview = previews.get(key);
  if (!preview) {
    preview = (async () => {
      const { editor, pageId } = await scratchEditor();
      buildTemplate(template, editor, pageId);
      const blob = await renderPageThumbnail(editor, {
        pageId,
        maxWidth: 640,
        maxHeight: 400,
        priority: "low",
      });
      return blob ? URL.createObjectURL(blob) : null;
    })().catch(() => null);
    previews.set(key, preview);
  }
  return preview;
}
