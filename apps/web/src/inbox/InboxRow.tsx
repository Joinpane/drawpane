/**
 * One notification, as the inbox lists it (on the dashboard, and in the
 * editor's inbox menu), and the list query both use.
 */
import { Icon } from "@drawpane/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { MouseEvent } from "react";
import { api, type InboxItem } from "../api/client";
import { initials, timeAgo } from "../app/format";
import { inboxSentence, LIST_KEY } from "./inbox";

export type InboxFilter = "unread" | "all";

/** Notifications, newest first, a page at a time. */
export function useInboxList(filter: InboxFilter) {
  return useInfiniteQuery({
    queryKey: [...LIST_KEY, filter],
    queryFn: ({ pageParam }) => api.inbox(filter, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.before,
  });
}

/** A stable presence colour per person, as their cursor would have. */
function slotOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (Math.abs(h) % 8) + 1;
}

/**
 * A notification: who did what in which file, what they wrote, and when. It
 * links to the file at the comment; `onOpen` runs first, and can open the
 * comment in place instead (preventing the navigation).
 */
export function InboxRow({
  item,
  here,
  onOpen,
}: {
  item: InboxItem;
  /** The file open now, if any: its notifications say "in this file". */
  here?: string;
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
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
            <strong>{who}</strong> {did}{" "}
            {item.file.id === here ? "this file" : <strong>{item.file.name}</strong>}
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
