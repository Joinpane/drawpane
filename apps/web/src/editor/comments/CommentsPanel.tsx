import { Camera, type Editor } from "@drawpane/editor";
import type { CommentThread } from "@drawpane/model";
import { Button, IconButton, SegmentedControl } from "@drawpane/ui";
import { useDocVersion, useEditor, useEditorState } from "../hooks";
import { anchorLabel, resolveAnchor } from "./anchor";
import { useComments } from "./CommentsLayer";
import { Avatar, CommentText, displayName, When } from "./people";
import {
  byRecency,
  type CommentFilter,
  type CommentScope,
  type CommentStore,
  matchesFilter,
} from "./store";

/** Brings a thread's pin into view, on its page, and opens it. */
export function focusThread(
  editor: Editor,
  store: CommentStore,
  thread: CommentThread,
  insets: { left: number; right: number },
): void {
  const pos = resolveAnchor(editor.scene, thread.anchor, thread.pageId);
  if (!editor.doc.has(pos.pageId)) {
    editor.notify("That comment's page was deleted, so its pin can't be shown.");
    store.open(thread.id);
    return;
  }
  if (editor.s.pageId !== pos.pageId) editor.setPage(pos.pageId);
  const { viewport, camera } = editor.s;
  const zoom = Math.max(camera.zoom, 1);
  const centreX = (insets.left + viewport.width - insets.right) / 2;
  editor.setCamera(
    new Camera(centreX - pos.point.x * zoom, viewport.height / 2 - pos.point.y * zoom, zoom),
  );
  store.open(thread.id);
}

export interface CommentsPanelProps {
  readonly store: CommentStore;
  readonly insets: { readonly left: number; readonly right: number };
  readonly onClose: () => void;
}

/** Every thread on this page (or in the file), most recent first. */
export function CommentsPanel({ store, insets, onClose }: CommentsPanelProps) {
  const editor = useEditor();
  useDocVersion();
  const pageId = useEditorState((s) => s.pageId);
  const threads = useComments(store, (s) => s.threads);
  const filter = useComments(store, (s) => s.filter);
  const scope = useComments(store, (s) => s.scope);
  const openId = useComments(store, (s) => s.openId);
  const loaded = useComments(store, (s) => s.loaded);
  const error = useComments(store, (s) => s.error);
  const me = store.me?.id ?? null;

  const inScope = [...threads.values()].filter(
    (t) => scope === "all" || resolveAnchor(editor.scene, t.anchor, t.pageId).pageId === pageId,
  );
  const openCount = inScope.filter((t) => matchesFilter(t, "open", me)).length;
  const list = inScope.filter((t) => matchesFilter(t, filter, me)).sort(byRecency);

  const options: Array<{ value: CommentFilter; label: string }> = [
    { value: "open", label: openCount > 0 ? `Open ${openCount}` : "Open" },
    { value: "mine", label: "Mine" },
    { value: "resolved", label: "Resolved" },
  ];

  const where = scope === "page" ? "on this page" : "in this file";
  const empty: Record<CommentFilter, string> = {
    open: `No open comments ${where}.`,
    mine: "Threads you start, reply to or are mentioned in show up here.",
    resolved: `No resolved comments ${where}.`,
  };

  return (
    <aside className="pane pane--right comments-panel" aria-label="Comments">
      <div className="comments-panel__head">
        <h2 className="comments-panel__title">Comments</h2>
        <select
          className="comments-panel__scope"
          aria-label="Which comments"
          value={scope}
          onChange={(e) => store.setScope(e.currentTarget.value as CommentScope)}
        >
          <option value="page">This page</option>
          <option value="all">All pages</option>
        </select>
        <IconButton icon="close" label="Close comments" onClick={onClose} />
      </div>
      <div className="comments-panel__filters">
        <SegmentedControl
          label="Show"
          options={options}
          value={filter}
          onChange={(value) => store.setFilter(value)}
        />
      </div>
      <div className="comments-panel__list">
        {!loaded ? (
          <p className="comments-panel__empty">Loading comments…</p>
        ) : error ? (
          <div className="comments-panel__empty" role="alert">
            <p>{error}</p>
            <Button size="sm" onClick={() => void store.load()}>
              Try again
            </Button>
          </div>
        ) : list.length === 0 ? (
          <div className="comments-panel__empty">
            <p>{empty[filter]}</p>
            {filter === "open" ? (
              <Button size="sm" icon="comment" onClick={() => editor.setTool("comment")}>
                Add comment
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="comments-panel__rows">
            {list.map((thread) => {
              const first = thread.messages[0];
              const replies = thread.messages.length - 1;
              const resolved = thread.resolvedAt !== null;
              const pos = resolveAnchor(editor.scene, thread.anchor, thread.pageId);
              const label = anchorLabel(editor.scene, thread.anchor, thread.pageId);
              const posPage = editor.doc.get(pos.pageId)?.props.name;
              // In "All pages", say which page a thread elsewhere is on (unless the label already does).
              const pageName =
                scope === "all" && pos.pageId !== pageId && posPage && posPage !== label
                  ? posPage
                  : null;
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    className="comments-panel__row"
                    aria-current={thread.id === openId || undefined}
                    data-resolved={resolved || undefined}
                    onClick={() => focusThread(editor, store, thread, insets)}
                  >
                    <span className="comments-panel__meta">
                      <Avatar person={thread.author} />
                      <span className="comments-panel__who">
                        <b>{displayName(thread.author)}</b>
                        <span className="comments-panel__muted">
                          {" · "}
                          <When ms={thread.updatedAt} />
                        </span>
                      </span>
                      <span className="comments-panel__count">
                        {replies > 0 ? `${replies} ${replies === 1 ? "reply" : "replies"}` : ""}
                      </span>
                    </span>
                    <span className="comments-panel__text">
                      {first ? (
                        <CommentText body={first.body} mentions={first.mentions} me={me} compact />
                      ) : null}
                    </span>
                    <span className="comments-panel__where">
                      {resolved
                        ? `Resolved by ${displayName(thread.resolvedBy)}`
                        : pageName
                          ? `${label} · ${pageName}`
                          : label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
