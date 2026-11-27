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
import { uiFor } from "../ui-state";
import { isCompactTablet } from "../workspace-mode";
import { useComments } from "./CommentsLayer";
import { focusThread } from "./CommentsPanel";
import type { CommentStore } from "./store";

/** Opens a thread of this file at its pin, using the active workspace's visible insets; says so when gone. */
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
  const mode = uiFor(editor).get().workspaceMode;
  if (mode === "phone") {
    // On phones, opening the thread shows the focused thread sheet rather than a desktop side pane.
    const { viewport, insets } = editor.s;
    focusThread(editor, store, thread, {
      left: 0,
      right: 0,
      top: insets.top,
      bottom: Math.max(insets.bottom, Math.round(viewport.height * 0.5)),
    });
    return true;
  }
  store.setPanel(true);
  const compact = isCompactTablet(mode, window.innerWidth);
  const effectiveLeft = compact ? 0 : left;
  // The comments panel takes up the right of the canvas, at the right panel's width.
  const right = PANE.gutter + clampPane(panelLayout().right, window.innerWidth, effectiveLeft);
  focusThread(editor, store, thread, { left: effectiveLeft, right });
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
