import type { CommentMessage, CommentPerson, CommentThread } from "@drawpane/model";
import { Button, Icon, IconButton, MenuButton, type MenuItem } from "@drawpane/ui";
import {
  forwardRef,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { isMac } from "../../app/format";
import { Composer } from "./Composer";
import { Avatar, CommentText, displayName, When } from "./people";
import type { CommentStore } from "./store";

type Role = "owner" | "editor" | "viewer";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong. Try again.";

export interface ThreadPopoverProps {
  readonly store: CommentStore;
  readonly thread: CommentThread;
  readonly label: string;
  readonly people: readonly CommentPerson[];
  readonly role: Role;
  readonly onClose: () => void;
}

/** The popover for one thread: its messages, a reply box, resolve, and author actions. */
export const ThreadPopover = forwardRef<HTMLElement, ThreadPopoverProps>(function ThreadPopover(
  { store, thread, label, people, role, onClose },
  ref,
) {
  const me = store.me?.id ?? null;
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const resolved = thread.resolvedAt !== null;
  const canDeleteThread = role === "owner" || (me !== null && thread.author?.id === me);
  const count = thread.messages.length;

  // Keep the newest message in view as replies arrive.
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
    if (e.key.toLowerCase() === "r" && e.shiftKey && (isMac() ? e.metaKey : e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void run(() => store.setResolved(thread.id, !resolved));
    }
  };

  const menuItems: MenuItem[] = [
    {
      label: resolved ? "Reopen thread" : "Resolve thread",
      icon: "check",
      onSelect: () => void run(() => store.setResolved(thread.id, !resolved)),
    },
    ...(canDeleteThread
      ? [
          { separator: true as const },
          { label: "Delete thread", danger: true, onSelect: () => setConfirmDelete(true) },
        ]
      : []),
  ];

  return (
    <section
      ref={ref}
      className="comment-popover"
      role="dialog"
      aria-label={`Thread on ${label}`}
      onKeyDown={onKeyDown}
    >
      <header className="comment-popover__head">
        <span className="comment-popover__title" title={label}>
          {label}
        </span>
        <IconButton
          icon="check"
          label={resolved ? "Reopen thread" : "Resolve thread"}
          shortcut={isMac() ? "⌘⇧R" : "Ctrl+Shift+R"}
          pressed={resolved}
          disabled={busy}
          onClick={() => void run(() => store.setResolved(thread.id, !resolved))}
        />
        <MenuButton label="Thread options" items={menuItems} />
      </header>
      {resolved ? (
        <p className="comment-popover__resolved">
          <Icon name="check" size={12} />
          <span>
            Resolved by {displayName(thread.resolvedBy)} ·{" "}
            <When ms={thread.resolvedAt ?? thread.updatedAt} />
          </span>
        </p>
      ) : null}
      {confirmDelete ? (
        <div className="comment-confirm" role="alert">
          <p>Delete this thread and its replies? This can't be undone.</p>
          <span className="comment-confirm__actions">
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)} autoFocus>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => void run(() => store.deleteThread(thread.id))}
            >
              Delete thread
            </Button>
          </span>
        </div>
      ) : null}
      <ol
        ref={list}
        className="comment-popover__messages"
        aria-label="Messages"
        aria-live="polite"
        aria-relevant="additions"
      >
        {thread.messages.map((message, i) => (
          <MessageItem
            key={message.id}
            store={store}
            thread={thread}
            message={message}
            first={i === 0}
            people={people}
            role={role}
            onError={setError}
          />
        ))}
      </ol>
      <div className="comment-popover__reply">
        <Composer
          people={people}
          value={reply}
          onChange={setReply}
          submitLabel="Reply"
          placeholder={resolved ? "Reply to reopen the conversation" : "Reply"}
          label="Reply"
          busy={busy}
          autoFocus
          onSubmit={(body, mentions) =>
            void run(() => store.reply(thread.id, body, mentions)).then((ok) => {
              if (ok) setReply("");
            })
          }
        />
        {error ? (
          <p className="comment-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
});

function MessageItem({
  store,
  thread,
  message,
  first,
  people,
  role,
  onError,
}: {
  store: CommentStore;
  thread: CommentThread;
  message: CommentMessage;
  first: boolean;
  people: readonly CommentPerson[];
  role: Role;
  onError: (message: string | null) => void;
}) {
  const me = store.me?.id ?? null;
  const mine = me !== null && message.author?.id === me;
  const canDelete = first
    ? role === "owner" || (me !== null && (thread.author?.id ?? message.author?.id) === me)
    : role === "owner" || mine;
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [draft, setDraft] = useState(message.body);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === "view") setDraft(message.body);
  }, [message.body, mode]);

  const items: MenuItem[] = [
    ...(mine ? [{ label: "Edit", onSelect: () => setMode("edit") }] : []),
    ...(canDelete ? [{ label: "Delete", danger: true, onSelect: () => setMode("confirm") }] : []),
  ];

  const act = async (task: () => Promise<unknown>) => {
    setBusy(true);
    onError(null);
    try {
      await task();
      setMode("view");
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="comment-message">
      <Avatar person={message.author} />
      <div className="comment-message__main">
        <div className="comment-message__meta">
          <span className="comment-message__who">
            <b>{displayName(message.author)}</b>
            <span className="comment-message__when">
              {" · "}
              <When ms={message.createdAt} />
              {message.editedAt ? " · edited" : ""}
            </span>
          </span>
          {items.length > 0 && mode === "view" ? (
            <MenuButton
              label={`Options for ${displayName(message.author)}'s comment`}
              menuLabel="Comment options"
              items={items}
              className="comment-message__more"
              tooltip={false}
            />
          ) : null}
        </div>
        {mode === "edit" ? (
          <Composer
            people={people}
            value={draft}
            onChange={setDraft}
            submitLabel="Save"
            placeholder="Edit your comment"
            label="Edit comment"
            hint={false}
            busy={busy}
            autoFocus
            onCancel={() => setMode("view")}
            onSubmit={(body, mentions) =>
              void act(() => store.edit(thread.id, message.id, body, mentions))
            }
          />
        ) : (
          <p className="comment-message__text">
            <CommentText body={message.body} mentions={message.mentions} me={me} />
          </p>
        )}
        {mode === "confirm" ? (
          <div className="comment-confirm" role="alert">
            <p>
              {first
                ? "Delete this thread and its replies? This can't be undone."
                : "Delete this comment? This can't be undone."}
            </p>
            <span className="comment-confirm__actions">
              <Button size="sm" variant="ghost" onClick={() => setMode("view")} autoFocus>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => void act(() => store.deleteMessage(thread.id, message.id))}
              >
                Delete
              </Button>
            </span>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export interface DraftPopoverProps {
  readonly store: CommentStore;
  readonly text: string;
  readonly label: string;
  readonly people: readonly CommentPerson[];
  readonly onCancel: () => void;
}

/** The popover for a new pin: the first message of a thread. */
export const DraftPopover = forwardRef<HTMLElement, DraftPopoverProps>(function DraftPopover(
  { store, text, label, people, onCancel },
  ref,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section
      ref={ref}
      className="comment-popover comment-popover--draft"
      role="dialog"
      aria-label={`New comment on ${label}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <header className="comment-popover__head">
        <span className="comment-popover__title" title={label}>
          {label}
        </span>
      </header>
      <div className="comment-popover__reply comment-popover__reply--draft">
        <Composer
          people={people}
          value={text}
          onChange={(value) => store.setDraftText(value)}
          submitLabel="Comment"
          placeholder="Add a comment"
          label="Comment"
          busy={busy}
          autoFocus
          onSubmit={async (body, mentions) => {
            const draft = store.s.draft;
            if (!draft) return;
            setBusy(true);
            setError(null);
            try {
              await store.create(draft, body, mentions);
            } catch (e) {
              setError(errorText(e));
              setBusy(false);
            }
          }}
        />
        {error ? (
          <p className="comment-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
});
