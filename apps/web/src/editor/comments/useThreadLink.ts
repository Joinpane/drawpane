/**
 * Comments and the inbox: `/f/:id?thread=…` opens the file at that thread
 * (from the inbox), opening a thread marks its notifications read, and
 * comment activity in the file refreshes the unread count.
 */
import type { Editor } from "@drawpane/editor";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { markRead } from "../../inbox/inbox";
import { clampPane, PANE, panelLayout } from "../panel-layout";
import { useComments } from "./CommentsLayer";
import { focusThread } from "./CommentsPanel";
import type { CommentStore } from "./store";

/** Opens a thread of this file at its pin, with the comments panel; says so when it's gone. */
export function openThread(
  editor: Editor,
  store: CommentStore,
  threadId: string,
  left: number,
): boolean {
  const thread = store.s.threads.get(threadId);
  if (!thread) {
    editor.notify("That comment was deleted.");
    return false;
  }
  store.setPanel(true);
  // The comments panel takes up the right of the canvas, at the right panel's width.
  const right = PANE.gutter + clampPane(panelLayout().right, window.innerWidth, left);
  focusThread(editor, store, thread, { left, right });
  return true;
}

export function useMarkOpenThreadRead(store: CommentStore): void {
  const queryClient = useQueryClient();
  const openId = useComments(store, (s) => s.openId);

  // Seen: a thread's notifications are read once it's open, and again when a
  // reply arrives while it is. Always asked: the count cached here can be stale.
  const openedAt = useComments(store, (s) => (s.openId ? s.threads.get(s.openId)?.updatedAt : 0));
  useEffect(() => {
    void openedAt;
    if (!openId) return;
    void markRead(queryClient, { threadId: openId }).catch(() => {});
  }, [openId, openedAt, queryClient]);
}
