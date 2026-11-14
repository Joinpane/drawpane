/**
 * Comments and the inbox: `/f/:id?thread=…` opens the file at that thread
 * (from the inbox), opening a thread marks its notifications read, and
 * comment activity in the file refreshes the unread count.
 */
import type { Editor } from "@drawpane/editor";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { markRead, UNREAD_KEY } from "../../inbox/inbox";
import { useEditorStateOutside } from "../hooks";
import { useComments } from "./CommentsLayer";
import { focusThread } from "./CommentsPanel";
import type { CommentStore } from "./store";

/** The comments panel's width, which takes up the right of the canvas while it's open. */
const PANEL = 276;

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
    const thread = store.s.threads.get(linked);
    if (thread) {
      store.setPanel(true);
      focusThread(editor, store, thread, { left: insets.left, right: PANEL });
    } else {
      editor.notify("That comment was deleted.");
    }
    void navigate({ to: "/f/$fileId", params: { fileId }, search: {}, replace: true });
  }, [linked, live, loaded, store, editor, insets.left, navigate, fileId]);

  // Seen: a thread's notifications are read once it's open. Only asks when something's unread.
  useEffect(() => {
    if (!openId) return;
    const unread = queryClient.getQueryData<{ unread: number }>(UNREAD_KEY)?.unread;
    if (unread === 0) return;
    void markRead(queryClient, { threadId: openId }).catch(() => {});
  }, [openId, queryClient]);
}
