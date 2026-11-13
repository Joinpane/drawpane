import type { CommentPerson } from "@drawpane/model";
import { type CSSProperties, Fragment, type ReactNode } from "react";
import { initials } from "../../app/format";

/** A stable presence color (1–8) for a person, so their pins look the same in every session. */
export function presenceSlotFor(id: string | null | undefined): number {
  if (!id) return 8;
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 8) + 1;
}

export type ColorStyle = CSSProperties & Record<"--comment-color", string>;

/** Inline style that sets `--comment-color` to the person's presence color. */
export function colorStyle(id: string | null | undefined): ColorStyle {
  return { "--comment-color": `var(--presence-${presenceSlotFor(id)})` };
}

export function displayName(person: CommentPerson | null): string {
  return person?.name ?? "Former member";
}

export function personInitials(person: CommentPerson | null): string {
  return person ? initials(person.name) || "?" : "?";
}

/** A 22px avatar: initials on the raised surface, ringed in the person's presence color. */
export function Avatar({ person }: { person: CommentPerson | null }) {
  return (
    <span className="comment-avatar" style={colorStyle(person?.id)} aria-hidden="true">
      {personInitials(person)}
    </span>
  );
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "now", "20m", "2h", "Yesterday", then "Nov 9": compact, for comment headers. */
export function shortTime(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (ms >= today.getTime() - 86_400_000) return "Yesterday";
  return dayFormat.format(ms);
}

export function When({ ms }: { ms: number }) {
  return (
    <time dateTime={new Date(ms).toISOString()} title={fullFormat.format(ms)}>
      {shortTime(ms)}
    </time>
  );
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches `@Name` for any of `people`, longest names first, not followed by a letter or digit. */
export function mentionPattern(people: readonly CommentPerson[]): RegExp | null {
  const names = [...new Set(people.map((p) => p.name).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (names.length === 0) return null;
  return new RegExp(`@(${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "gu");
}

/** The people `body` mentions by name. */
export function mentionsIn(body: string, people: readonly CommentPerson[]): string[] {
  const pattern = mentionPattern(people);
  if (!pattern) return [];
  const ids = new Set<string>();
  for (const match of body.matchAll(pattern)) {
    const person = people.find((p) => p.name === match[1]);
    if (person) ids.add(person.id);
  }
  return [...ids];
}

/** Renders a comment body with its mentions emphasized; a mention of you uses signal ink. */
export function CommentText({
  body,
  mentions,
  me,
}: {
  body: string;
  mentions: readonly CommentPerson[];
  me: string | null;
}) {
  const pattern = mentionPattern(mentions);
  if (!pattern) return <>{body}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of body.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(body.slice(last, index));
    const person = mentions.find((p) => p.name === match[1]);
    parts.push(
      <span
        key={index}
        className={person?.id === me ? "comment-mention comment-mention--you" : "comment-mention"}
      >
        {match[0]}
      </span>,
    );
    last = index + match[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return (
    <>
      {parts.map((part, i) =>
        typeof part === "string" ? <Fragment key={`t${String(i)}`}>{part}</Fragment> : part,
      )}
    </>
  );
}
