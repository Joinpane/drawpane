import type { CommentPerson } from "@drawpane/model";
import { type CSSProperties, Fragment, type ReactNode } from "react";
import { initials } from "../../app/format";
import { type Inline, parseComment } from "./format";

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

/**
 * A comment's text, formatted (see `format.ts`): paragraphs, lists, bold,
 * italic, code, links, and mentions (a mention of you in signal ink).
 * `compact` runs it all together for a few-line preview: lists become
 * "• item" lines, and links stay text, so the preview's row stays one button.
 */
export function CommentText({
  body,
  mentions,
  me,
  compact = false,
}: {
  body: string;
  mentions: readonly CommentPerson[];
  me: string | null;
  compact?: boolean;
}) {
  const blocks = parseComment(
    body,
    mentions.map((p) => p.name),
  );
  const run = (r: Inline, k: string): ReactNode => {
    switch (r.kind) {
      case "text":
        return <Fragment key={k}>{r.text}</Fragment>;
      case "strong":
        return <strong key={k}>{runs(r.children, k)}</strong>;
      case "em":
        return <em key={k}>{runs(r.children, k)}</em>;
      case "code":
        return (
          <code key={k} className="comment-code">
            {r.text}
          </code>
        );
      case "link":
        return compact ? (
          <span key={k} className="comment-link">
            {r.text}
          </span>
        ) : (
          <a
            key={k}
            className="comment-link"
            href={r.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {r.text}
          </a>
        );
      case "mention": {
        const person = mentions.find((p) => p.name === r.name);
        return (
          <span
            key={k}
            className={
              person?.id === me ? "comment-mention comment-mention--you" : "comment-mention"
            }
          >
            {r.text}
          </span>
        );
      }
    }
  };
  const runs = (items: readonly Inline[], key: string): ReactNode =>
    items.map((r, i) => run(r, `${key}.${i}`));
  const lines = (items: readonly (readonly Inline[])[], key: string) =>
    items.map((line, i) => (
      <Fragment key={i}>
        {i > 0 ? <br /> : null}
        {runs(line, `${key}.${i}`)}
      </Fragment>
    ));
  if (compact)
    return (
      <>
        {blocks.map((block, b) => (
          <Fragment key={b}>
            {b > 0 ? <br /> : null}
            {block.kind === "paragraph"
              ? lines(block.lines, String(b))
              : lines(
                  block.items.map((item, n) => [
                    { kind: "text", text: block.ordered ? `${block.start + n}. ` : "• " },
                    ...item,
                  ]),
                  String(b),
                )}
          </Fragment>
        ))}
      </>
    );
  return (
    <>
      {blocks.map((block, b) => {
        const key = String(b);
        if (block.kind === "paragraph") return <p key={key}>{lines(block.lines, key)}</p>;
        const items = block.items.map((item, n) => <li key={n}>{runs(item, `${key}.${n}`)}</li>);
        return block.ordered ? (
          <ol key={key} start={block.start === 1 ? undefined : block.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      })}
    </>
  );
}
