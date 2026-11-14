/**
 * Making new files: blank, with a first frame of a chosen size, from a
 * built-in template, or as a copy of a team template. Content built here is
 * filled in through the import endpoint; a copy is made by the server.
 */
import { CanvasRenderer, type Editor, renderThumbnail } from "@drawpane/editor";
import { api, type FileMeta } from "../api/client";
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
 * A picture of a built-in template, drawn with the canvas's renderer from
 * the same build the file gets, so the preview is what you'll open. Cached
 * for the session as an object URL.
 */
export function templatePreview(template: BuiltInTemplate): Promise<string | null> {
  let preview = previews.get(template.id);
  if (!preview) {
    preview = (async () => {
      const { editor, pageId } = await scratchEditor();
      buildTemplate(template, editor, pageId);
      const renderer = new CanvasRenderer(editor.scene, editor.measurer);
      const blob = await renderThumbnail(renderer, editor.scene, pageId, {
        maxWidth: 640,
        maxHeight: 400,
      });
      return blob ? URL.createObjectURL(blob) : null;
    })().catch(() => null);
    previews.set(template.id, preview);
  }
  return preview;
}
