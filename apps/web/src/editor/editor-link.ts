import type { Editor } from "@drawpane/editor";
import { isValidId } from "@drawpane/model";
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";

export interface EditorSearch {
  "page-id"?: string;
  "node-id"?: string;
}

export function editorSearch(search: Record<string, unknown> | URLSearchParams): EditorSearch {
  const page = search instanceof URLSearchParams ? search.get("page-id") : search["page-id"];
  const node = search instanceof URLSearchParams ? search.get("node-id") : search["node-id"];
  return {
    ...(typeof page === "string" && isValidId(page) ? { "page-id": page } : {}),
    ...(typeof node === "string" && isValidId(node) ? { "node-id": node } : {}),
  };
}

/** Changes the editor target in place, keeping the rest of the query. */
export function writeEditorSearch(params: URLSearchParams, search: EditorSearch): void {
  for (const key of ["page-id", "node-id"] as const) {
    const id = search[key];
    if (id) params.set(key, id);
    else params.delete(key);
  }
}

// The model accepts ids like "1" and "true". Keep those as literal strings.
export function parseAppSearch(query: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = defaultParseSearch(query);
  const { "page-id": _page, "node-id": _node, ...rest } = parsed;
  return { ...rest, ...editorSearch(new URLSearchParams(query)) };
}

export function stringifyAppSearch({
  "page-id": page,
  "node-id": node,
  ...rest
}: Record<string, unknown>): string {
  const query = defaultStringifySearch(rest);
  if (page === undefined && node === undefined) return query;
  const params = new URLSearchParams(query);
  writeEditorSearch(params, editorSearch({ "page-id": page, "node-id": node }));
  return params.size ? `?${params.toString()}` : "";
}

export function currentEditorSearch(editor: Editor): EditorSearch {
  const { pageId, selection } = editor.s;
  const node = selection[0];
  return {
    ...(pageId ? { "page-id": pageId } : {}),
    ...(node && editor.doc.pageOf(node)?.id === pageId ? { "node-id": node } : {}),
  };
}

/** A layer can move after its link is copied. Its current page wins when it can be shown. */
export function restoreEditorLink(editor: Editor, search: EditorSearch): void {
  const page = search["page-id"];
  const node = search["node-id"];
  const nodePage = node ? editor.doc.pageOf(node)?.id : undefined;
  const visible = node && nodePage && nodePage !== node && editor.scene.isVisible(node);
  const linkedPage = page && editor.doc.get(page)?.type === "page" ? page : undefined;
  const targetPage = (visible ? nodePage : (linkedPage ?? nodePage)) ?? editor.doc.pageIds()[0];

  editor.stopFollowing();
  if (targetPage && targetPage !== editor.s.pageId) editor.setPage(targetPage);
  editor.select(visible ? [node] : []);
  if (visible) editor.zoomToSelection();
  else if (node) editor.notify("That layer is no longer available.");
  else if (page && !linkedPage) editor.notify("That page is no longer available.");
}

export async function copyEditorLink(editor: Editor, search: EditorSearch): Promise<void> {
  const url = new URL(window.location.href);
  writeEditorSearch(url.searchParams, search);
  try {
    await navigator.clipboard.writeText(url.href);
    editor.notify("Link copied.");
  } catch {
    editor.notify("Couldn't copy the link.");
  }
}
