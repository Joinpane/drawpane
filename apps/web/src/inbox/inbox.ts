/**
 * The inbox's shared state: the unread count (kept fresh by polling, focus
 * and comment events) and marking things read everywhere at once.
 */
import { type InfiniteData, type QueryClient, useQuery } from "@tanstack/react-query";
import { api, type InboxItem, type InboxPage, type MarkRead } from "../api/client";

export const UNREAD_KEY = ["inbox", "unread"] as const;
export const LIST_KEY = ["inbox", "list"] as const;

/** How often the count is asked for while a page is open; focus asks at once. */
const POLL_MS = 60_000;

/** Unread notifications, for badges. */
export function useUnread(): number {
  const query = useQuery({
    queryKey: UNREAD_KEY,
    queryFn: api.unread,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });
  return query.data?.unread ?? 0;
}

const matches = (item: InboxItem, which: MarkRead) =>
  "all" in which
    ? which.upTo === undefined || item.createdAt <= which.upTo
    : "threadId" in which
      ? item.threadId === which.threadId
      : which.ids.includes(item.id);

/**
 * Marks notifications read: lists show it at once (items stay where they are
 * until the next refetch, so nothing jumps), and the count follows the server.
 */
export async function markRead(queryClient: QueryClient, which: MarkRead): Promise<void> {
  const now = Date.now();
  queryClient.setQueriesData<InfiniteData<InboxPage>>({ queryKey: LIST_KEY }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) =>
              item.readAt === null && matches(item, which) ? { ...item, readAt: now } : item,
            ),
          })),
        }
      : data,
  );
  try {
    const { unread } = await api.markRead(which);
    queryClient.setQueryData(UNREAD_KEY, { unread });
  } catch (error) {
    // Didn't take: show what the server has, rather than what was hoped.
    refreshInbox(queryClient);
    throw error;
  }
}

/**
 * "Mark all read" for a list: everything up to the newest item it shows,
 * so something arriving meanwhile isn't marked read unseen.
 */
export function allShown(items: readonly InboxItem[]): MarkRead {
  const newest = Math.max(0, ...items.map((i) => i.createdAt));
  return newest > 0 ? { all: true, upTo: newest } : { all: true };
}

/** Something changed that may have notified someone: ask again. */
export function refreshInbox(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["inbox"] });
}

/** "Lena mentioned you", for the sentence that starts each item. */
export function inboxSentence(item: InboxItem): { who: string; did: string } {
  const who = item.actor?.name ?? "Someone";
  switch (item.kind) {
    case "mention":
      return { who, did: "mentioned you in" };
    case "reply":
      return { who, did: "replied in" };
    case "resolved":
      return { who, did: "resolved your comment in" };
  }
}

/** Day headings: Today, Yesterday, a weekday this week, then dates. */
export function dayLabel(ms: number, now = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(ms)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(ms);
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(ms);
}
