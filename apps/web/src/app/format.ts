const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** "2 minutes ago", "yesterday", or "Nov 9" for anything older than a week. */
export function timeAgo(ms: number, now = Date.now()): string {
  const seconds = Math.round((ms - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86_400) return rtf.format(Math.round(seconds / 86_400), "day");
  return dateFormat.format(ms);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase();
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** "⌘K" on macOS, "Ctrl K" elsewhere. */
export function modKey(key: string): string {
  return isMac() ? `⌘${key}` : `Ctrl ${key}`;
}
