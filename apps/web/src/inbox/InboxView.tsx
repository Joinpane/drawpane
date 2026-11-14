/**
 * The inbox: mentions, replies in your threads, and your threads resolved,
 * newest first and grouped by day. Each opens the file at its comment and
 * counts as read; Unread shows only what's new.
 */
import { Button, Icon, SegmentedControl } from "@drawpane/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { InboxItem } from "../api/client";
import { type InboxFilter, InboxRow, useInboxList } from "./InboxRow";
import { allShown, dayLabel, markRead, useUnread } from "./inbox";
import "./inbox.css";

type Filter = InboxFilter;

export function InboxView() {
  const queryClient = useQueryClient();
  const unread = useUnread();
  const [filter, setFilter] = useState<Filter>("unread");
  const [failed, setFailed] = useState<string | null>(null);
  const mark = (which: Parameters<typeof markRead>[1]) => {
    setFailed(null);
    void markRead(queryClient, which).catch(() =>
      setFailed("Couldn't mark that read. Check your connection and try again."),
    );
  };
  const list = useInboxList(filter);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const groups: { label: string; items: InboxItem[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.createdAt);
    const group = groups.at(-1);
    if (group?.label === label) group.items.push(item);
    else groups.push({ label, items: [item] });
  }

  return (
    <div className="inbox">
      <header className="dash__header">
        <h1 className="dash__title">Inbox</h1>
      </header>

      <section className="inbox__card" aria-label="Notifications" aria-busy={list.isPending}>
        <div className="inbox__bar">
          <SegmentedControl
            label="Show"
            options={[
              { value: "unread", label: unread > 0 ? `Unread · ${unread}` : "Unread" },
              { value: "all", label: "All" },
            ]}
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
          />
          <Button
            size="sm"
            variant="ghost"
            icon="check"
            disabled={unread === 0}
            onClick={() => mark(allShown(items))}
          >
            Mark all read
          </Button>
        </div>
        {failed ? (
          <p className="inbox__alert" role="alert">
            {failed}
          </p>
        ) : null}
        {list.isPending ? (
          <ul className="inbox__list">
            {[0, 1, 2].map((i) => (
              <li key={i} className="inbox__skeleton" />
            ))}
          </ul>
        ) : list.error && !list.data ? (
          <div className="inbox__empty" role="alert">
            <p>{list.error.message}</p>
            <Button size="sm" onClick={() => void list.refetch()}>
              Try again
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="inbox__empty">
            <span className="inbox__empty-mark" aria-hidden="true">
              <Icon name={filter === "unread" ? "check" : "inbox"} size={16} />
            </span>
            <p className="inbox__empty-title">
              {filter === "unread" ? "You're all caught up." : "Nothing here yet."}
            </p>
            <p>
              When someone mentions you, replies in a thread you're in, or resolves your comment, it
              shows up here.
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="inbox__group">
              <h2 className="inbox__day">{group.label}</h2>
              <ul className="inbox__list">
                {group.items.map((item) => (
                  <InboxRow
                    key={item.id}
                    item={item}
                    onOpen={() => {
                      if (item.readAt === null) mark({ ids: [item.id] });
                    }}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
        {list.hasNextPage ? (
          <div className="inbox__more">
            {list.isFetchNextPageError ? (
              <span className="inbox__more-error" role="alert">
                Couldn't load older notifications.
              </span>
            ) : null}
            <Button
              variant="ghost"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage
                ? "Loading…"
                : list.isFetchNextPageError
                  ? "Try again"
                  : "Show older"}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
