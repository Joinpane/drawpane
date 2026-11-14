/**
 * Comments and the inbox: `/f/:id?thread=…` opens the file at that thread
 * (from the inbox), opening a thread marks its notifications read, and
 * comment activity in the file refreshes the unread count.
 */
import type { Editor } from "@drawpane/editor";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { markRead } from "../../inbox/inbox";
import { useEditorStateOutside } from "../hooks";
import { useComments } from "./CommentsLayer";
import { focusThread } from "./CommentsPanel";
import type { CommentStore } from "./store";

/** The comments panel's width, which takes up the right of the canvas while it's open. */
const PANEL = 276;

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
  focusThread(editor, store, thread, { left, right: PANEL });
  return true;
}

export function useThreadLink(
  editor: Editor,
  store: CommentStore,
  fileId: string,
  insets: { left: number },
): void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { thread: linked } = useSearch({ from: "/f/$fileId" });
  const live = useEditorStateOutside(editor, (s) => s.status === "live");
  const loaded = useComments(store, (s) => s.loaded);
  const openId = useComments(store, (s) => s.openId);

  // Once the document and its comments are in: show the linked thread, then drop it from the address.
  useEffect(() => {
    if (!linked || !live || !loaded) return;
    openThread(editor, store, linked, insets.left);
    void navigate({ to: "/f/$fileId", params: { fileId }, search: {}, replace: true });
  }, [linked, live, loaded, store, editor, insets.left, navigate, fileId]);

  // Seen: a thread's notifications are read once it's open, and again when a
  // reply arrives while it is. Always asked: the count cached here can be stale.
  const openedAt = useComments(store, (s) => (s.openId ? s.threads.get(s.openId)?.updatedAt : 0));
  useEffect(() => {
    void openedAt;
    if (!openId) return;
    void markRead(queryClient, { threadId: openId }).catch(() => {});
  }, [openId, openedAt, queryClient]);
}
