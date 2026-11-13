/** Comments in the editor: pins, threads, the panel, and the store behind them. */
import type { Editor } from "@drawpane/editor";
import type { CommentPerson } from "@drawpane/model";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { CommentStore } from "./store";

export { CommentsLayer, useComments } from "./CommentsLayer";
export { CommentsPanel } from "./CommentsPanel";
export { CommentStore } from "./store";

/**
 * One comment store per open file. Loads threads when the file's socket goes
 * live (and again after every reconnect, which may have missed events), and
 * opens the panel when you pick the comment tool.
 */
export function useCommentStore(editor: Editor, fileId: string) {
  const [store] = useState(() => new CommentStore(fileId));
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const people = useQuery({
    queryKey: ["mentions", fileId],
    queryFn: () => api.get<{ people: CommentPerson[] }>(`/files/${fileId}/mentions`),
  });
  const { refetch } = people;

  // Teammates can join while the file is open: refresh the @ list whenever a composer opens.
  useEffect(() => {
    let composing = false;
    return store.state.subscribe(() => {
      const now = store.s.openId !== null || store.s.draft !== null;
      if (now && !composing) void refetch();
      composing = now;
    });
  }, [store, refetch]);

  const user = session.data?.user ?? null;
  store.me = user ? { id: user.id, name: user.name } : null;

  useEffect(() => {
    let status = editor.s.status;
    let tool = editor.s.tool;
    if (status === "live") void store.load();
    return editor.state.subscribe(() => {
      const s = editor.s;
      if (s.status === "live" && status !== "live") void store.load();
      if (s.tool === "comment" && tool !== "comment") store.setPanel(true);
      status = s.status;
      tool = s.tool;
    });
  }, [editor, store]);

  return { store, people: people.data?.people ?? [] };
}
