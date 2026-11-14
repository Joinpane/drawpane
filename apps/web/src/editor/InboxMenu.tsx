/**
 * The inbox from inside a file: a button in the top bar, marked when
 * something's unread (the count is in its name), opening the latest
 * notifications. One in this file opens its comment
 * in place; one in another file opens that file at its comment. The whole
 * inbox is a link away, on the dashboard.
 */
import { Button, Icon, IconButton, Popover } from "@drawpane/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { InboxRow, useInboxList } from "../inbox/InboxRow";
import { allShown, markRead, useUnread } from "../inbox/inbox";
import "../inbox/inbox.css";

/** How many the menu shows; the rest are on the dashboard. */
const SHOWN = 8;

export function InboxMenu({
  fileId,
  teamId,
  onOpenThread,
}: {
  fileId: string;
  teamId: string | null;
  /** Opens a thread of this file in place. */
  onOpenThread: (threadId: string) => void;
}) {
  const unread = useUnread();
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <span className="inbox-menu">
      <IconButton
        ref={setButton}
        icon="inbox"
        size="md"
        label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"}
        aria-haspopup="dialog"
        aria-expanded={open}
        pressed={open}
        onClick={() => setOpen((v) => !v)}
      />
      {unread > 0 ? <span className="inbox-menu__dot" aria-hidden="true" /> : null}
      {open && button ? (
        <Popover
          anchor={button}
          label="Inbox"
          side="bottom"
          autoFocus={false}
          onClose={() => setOpen(false)}
          className="inbox-menu__popover"
        >
          <InboxMenuList
            fileId={fileId}
            teamId={teamId}
            unread={unread}
            onDone={() => setOpen(false)}
            onOpenThread={onOpenThread}
          />
        </Popover>
      ) : null}
    </span>
  );
}

function InboxMenuList({
  fileId,
  teamId,
  unread,
  onDone,
  onOpenThread,
}: {
  fileId: string;
  teamId: string | null;
  unread: number;
  onDone: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const queryClient = useQueryClient();
  const list = useInboxList("all");
  const items = (list.data?.pages[0]?.items ?? []).slice(0, SHOWN);
  return (
    <div className="inbox-menu__body">
      <div className="inbox-menu__head">
        <h2>Inbox</h2>
        <Button
          size="sm"
          variant="ghost"
          icon="check"
          disabled={unread === 0}
          onClick={() => void markRead(queryClient, allShown(items)).catch(() => {})}
        >
          Mark all read
        </Button>
      </div>
      {list.isPending ? (
        <ul className="inbox__list" aria-busy="true">
          {[0, 1].map((i) => (
            <li key={i} className="inbox__skeleton" />
          ))}
        </ul>
      ) : list.error ? (
        <p className="inbox-menu__empty" role="alert">
          {list.error.message}
        </p>
      ) : items.length === 0 ? (
        <p className="inbox-menu__empty">
          <Icon name="inbox" size={16} />
          Nothing yet. Mentions, replies in your threads, and resolved comments show up here.
        </p>
      ) : (
        <ul className="inbox__list inbox-menu__list">
          {items.map((item) => (
            <InboxRow
              key={item.id}
              item={item}
              here={fileId}
              onOpen={(event) => {
                if (item.readAt === null)
                  void markRead(queryClient, { ids: [item.id] }).catch(() => {});
                onDone();
                // This file: open the comment where it is, without reloading the editor.
                if (item.file.id === fileId) {
                  event.preventDefault();
                  onOpenThread(item.threadId);
                }
              }}
            />
          ))}
        </ul>
      )}
      {teamId ? (
        <div className="inbox-menu__foot">
          <Link
            to="/t/$teamId"
            params={{ teamId }}
            search={{ view: "inbox" }}
            className="inbox-menu__all"
          >
            Open inbox
            <Icon name="arrow-right" size={12} />
          </Link>
        </div>
      ) : null}
    </div>
  );
}
