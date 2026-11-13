/**
 * Words for version history: what to call a version, who made it, when, and
 * what changed. Kept apart from the components so they read the same in the
 * list, the details pane, the scrubber and notices.
 */
import type { ChangeKind, VersionInfo, VersionPerson } from "@drawpane/model";
import type { IconName } from "@drawpane/ui";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const yearDayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const numberFormat = new Intl.NumberFormat();

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "4:12 PM" */
export function timeLabel(ms: number): string {
  return timeFormat.format(ms);
}

/** "Nov 10", or "Nov 10, 2025" outside this year. */
export function dateLabel(ms: number, now = Date.now()): string {
  return new Date(ms).getFullYear() === new Date(now).getFullYear()
    ? dayFormat.format(ms)
    : yearDayFormat.format(ms);
}

/** Group headings: "Today", "Yesterday", "Monday" this week, then dates. */
export function dayLabel(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return weekdayFormat.format(ms);
  return dateLabel(ms, now);
}

/** "Today, 4:12 PM", "Yesterday, 9:05 AM", "Nov 10, 4:12 PM". */
export function whenLabel(ms: number, now = Date.now()): string {
  const day = dayLabel(ms, now);
  return `${day === "Today" || day === "Yesterday" ? day : dateLabel(ms, now)}, ${timeLabel(ms)}`;
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${numberFormat.format(n)} ${n === 1 ? one : many}`;
}

export function revisionLabel(revn: number): string {
  return `Revision ${numberFormat.format(revn)}`;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** "Ana Ruiz", "Ana and Sam", "Ana, Sam and Lee", "Ana, Sam and 3 others". */
export function peopleLabel(people: readonly VersionPerson[]): string {
  if (people.length === 0) return "";
  if (people.length === 1) return (people[0] as VersionPerson).name;
  const names = people.map((p) => firstName(p.name));
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/** For inside a sentence: "today at 4:12 PM", "yesterday at 9:05 AM", "on Nov 10 at 4:12 PM". */
export function whenPhrase(ms: number, now = Date.now()): string {
  const day = dayLabel(ms, now);
  const on =
    day === "Today" || day === "Yesterday" ? day.toLowerCase() : `on ${dateLabel(ms, now)}`;
  return `${on} at ${timeLabel(ms)}`;
}

/** "4:12 PM" today, else "Nov 10, 4:12 PM": short enough for a title. */
export function shortWhen(ms: number, now = Date.now()): string {
  return dayLabel(ms, now) === "Today" ? timeLabel(ms) : `${dateLabel(ms, now)}, ${timeLabel(ms)}`;
}

/** How to refer to a version inside a sentence: “Before color pass”, or "the 4:12 PM version". */
export function versionReference(version: Pick<VersionInfo, "name" | "createdAt">): string {
  return version.name ? `“${version.name}”` : `the ${shortWhen(version.createdAt)} version`;
}

/** A version's title in the list and details. */
export function versionTitle(
  version: VersionInfo,
  byId: ReadonlyMap<string, VersionInfo> = new Map(),
): string {
  if (version.name) return version.name;
  if (version.reason === "restore") {
    const restored = version.restoredId ? byId.get(version.restoredId) : undefined;
    return restored ? `Before restoring ${versionReference(restored)}` : "Before a restore";
  }
  return version.summary.edits > 0 ? count(version.summary.edits, "edit") : "Autosave";
}

/** Who a version belongs to: its namer or restorer, else the people who edited. */
export function versionPeople(version: VersionInfo): readonly VersionPerson[] {
  if (version.reason !== "auto" && version.createdBy) return [version.createdBy];
  return version.authors;
}

/** The line under a version's title: "Ana and Sam · 2:30 PM". */
export function versionMeta(version: VersionInfo): string {
  const who = peopleLabel(versionPeople(version)) || "Saved automatically";
  return `${who} · ${timeLabel(version.createdAt)}`;
}

/** The details pane's longer line: "Named by Lena Park · Nov 10, 4:12 PM". */
export function versionByline(version: VersionInfo): string {
  const when = whenLabel(version.createdAt);
  if (version.reason === "restore") {
    return `Saved ${version.createdBy ? `when ${version.createdBy.name} restored a version` : "before a restore"} · ${when}`;
  }
  if (version.name) {
    return version.createdBy ? `Named by ${version.createdBy.name} · ${when}` : `Named · ${when}`;
  }
  return `Saved automatically · ${when}`;
}

export const KIND_LABEL: Readonly<Record<ChangeKind, string>> = {
  added: "Layers added",
  removed: "Layers removed",
  arranged: "Reordered or regrouped",
  geometry: "Moved or resized",
  style: "Fill and style changes",
  text: "Text edits",
  layout: "Layout changes",
  vector: "Path edits",
  component: "Component changes",
  prototype: "Prototype changes",
  tokens: "Token changes",
  renamed: "Renamed layers",
  other: "Visibility and locks",
};

export const KIND_ICON: Readonly<Record<ChangeKind, IconName>> = {
  added: "plus",
  removed: "trash",
  arranged: "layers",
  geometry: "fit",
  style: "rectangle",
  text: "text",
  layout: "layout-col",
  vector: "pen",
  component: "component",
  prototype: "flow",
  tokens: "token",
  renamed: "inspector",
  other: "eye",
};

/** A version's kinds of change, most frequent first. */
export function changeRows(version: VersionInfo): Array<{ kind: ChangeKind; n: number }> {
  return Object.entries(version.summary.kinds)
    .map(([kind, n]) => ({ kind: kind as ChangeKind, n: n ?? 0 }))
    .filter((row) => row.n > 0 && row.kind in KIND_LABEL)
    .sort((a, b) => b.n - a.n || KIND_LABEL[a.kind].localeCompare(KIND_LABEL[b.kind]));
}
