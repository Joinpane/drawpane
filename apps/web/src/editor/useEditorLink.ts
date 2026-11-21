import type { Editor } from "@drawpane/editor";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";
import type { CommentStore } from "./comments/store";
import { openThread } from "./comments/useThreadLink";
import {
  currentEditorSearch,
  type EditorSearch,
  editorSearch,
  restoreEditorLink,
  writeEditorSearch,
} from "./editor-link";

function sameTarget(a: EditorSearch, b: EditorSearch): boolean {
  return a["page-id"] === b["page-id"] && a["node-id"] === b["node-id"];
}

/** Keeps the editor and the current history entry in sync, including inbox and email links. */
export function useEditorLink(
  editor: Editor,
  fileId: string,
  comments: CommentStore,
  leftInset: number,
): void {
  const { history } = useRouter();
  const focusThread = useEffectEvent((id: string) => openThread(editor, comments, id, leftInset));

  useEffect(() => {
    const path = `/f/${encodeURIComponent(fileId)}`;
    let active = true;
    let scheduled = false;
    let synced: EditorSearch | undefined;
    let before = editor.s;
    const update = () => {
      scheduled = false;
      if (!active) return;
      const location = history.location;
      if (location.pathname.replace(/\/$/, "") !== path) return;
      const { pageId, status, viewport } = editor.s;
      const ready = status === "live" || (status === "offline" && editor.sync.revn !== null);
      if (!pageId || !ready || viewport.width === 0 || viewport.height === 0) return;

      const params = new URLSearchParams(location.search);
      const linked = editorSearch(params);
      const thread = params.get("thread");
      if (thread && !comments.s.loaded) return;
      // A new address can come from a link or browser history. A change to review or renderer
      // alone keeps the current selection and camera.
      const hasTarget = !!(linked["page-id"] || linked["node-id"]);
      const changed = synced ? !sameTarget(linked, synced) : hasTarget;
      if (changed && (hasTarget || !thread)) restoreEditorLink(editor, linked);
      if (thread) focusThread(thread);

      synced = currentEditorSearch(editor);
      if (!thread && sameTarget(linked, synced)) return;
      if (thread) params.delete("thread");
      writeEditorSearch(params, synced);
      const search = params.toString();
      history.replace(
        `${location.pathname}${search ? `?${search}` : ""}${location.hash}`,
        location.state,
      );
    };
    // A page switch can set selection and camera in the same turn. Read the final state.
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(update);
    };
    const unlisten = history.subscribe(schedule);
    const unsubscribe = editor.state.subscribe(() => {
      const next = editor.s;
      if (
        next.pageId !== before.pageId ||
        next.selection !== before.selection ||
        next.status !== before.status ||
        next.viewport !== before.viewport
      )
        schedule();
      before = next;
    });
    const unsubscribeComments = comments.state.subscribe(schedule);
    schedule();
    return () => {
      active = false;
      unlisten();
      unsubscribe();
      unsubscribeComments();
    };
  }, [editor, fileId, history, comments]);
}
