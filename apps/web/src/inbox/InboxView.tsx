/**
 * The inbox: mentions, replies in your threads, and your threads resolved,
 * newest first and grouped by day. Each opens the file at its comment and
 * counts as read; Unread shows only what's new.
 */
import { Button, Icon, SegmentedControl } from "@drawpane/ui";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, type InboxItem } from "../api/client";
import { initials, timeAgo } from "../app/format";
import { dayLabel, inboxSentence, LIST_KEY, markRead, useUnread } from "./inbox";
import "./inbox.css";

type Filter = "unread" | "all";

/** A stable presence colour per person, as their cursor would have. */
function slotOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (Math.abs(h) % 8) + 1;
}

export function InboxView() {
  const queryClient = useQueryClient();
  const unread = useUnread();
  const [filter, setFilter] = useState<Filter>("unread");
  const list = useInfiniteQuery({
    queryKey: [...LIST_KEY, filter],
    queryFn: ({ pageParam }) => api.inbox(filter, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.before,
  });
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
            onClick={() => void markRead(queryClient, { all: true })}
          >
            Mark all read
          </Button>
        </div>
        {list.isPending ? (
          <ul className="inbox__list">
            {[0, 1, 2].map((i) => (
              <li key={i} className="inbox__skeleton" />
            ))}
          </ul>
        ) : list.error ? (
          <p className="inbox__empty" role="alert">
            {list.error.message}
          </p>
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
                      if (item.readAt === null) void markRead(queryClient, { ids: [item.id] });
                    }}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
        {list.hasNextPage ? (
          <div className="inbox__more">
            <Button
              variant="ghost"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? "Loading…" : "Show older"}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function InboxRow({ item, onOpen }: { item: InboxItem; onOpen: () => void }) {
  const { who, did } = inboxSentence(item);
  const unread = item.readAt === null;
  return (
    <li>
      <Link
        to="/f/$fileId"
        params={{ fileId: item.file.id }}
        search={{ thread: item.threadId }}
        className={`inbox__item${unread ? " inbox__item--unread" : ""}`}
        onClick={onOpen}
      >
        <span
          className="inbox__avatar"
          style={{ boxShadow: `inset 0 0 0 2px var(--presence-${slotOf(item.actor?.id ?? "")})` }}
          aria-hidden="true"
        >
          {item.actor ? initials(item.actor.name) : "?"}
          {item.kind === "resolved" ? (
            <span className="inbox__kind">
              <Icon name="check" size={12} />
            </span>
          ) : null}
        </span>
        <span className="inbox__text">
          <span className="inbox__sentence">
            <strong>{who}</strong> {did} <strong>{item.file.name}</strong>
            {item.resolved && item.kind !== "resolved" ? (
              <span className="inbox__resolved">Resolved</span>
            ) : null}
          </span>
          {item.excerpt ? <span className="inbox__excerpt">{item.excerpt}</span> : null}
        </span>
        <span className="inbox__meta">
          <time dateTime={new Date(item.createdAt).toISOString()}>{timeAgo(item.createdAt)}</time>
          {unread ? (
            <span className="inbox__dot">
              <span className="dp-visually-hidden">Unread</span>
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}
