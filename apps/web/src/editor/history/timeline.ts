/**
 * The version timeline's scale: where its track starts for each range, and
 * the labels along its axis. Kept apart from the Scrubber so the arithmetic
 * is tested on its own, young files and old ones alike.
 */
import { dateLabel, timeLabel } from "./labels";

export type TimelineRange = "day" | "week" | "all";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const RANGE_MS: Record<Exclude<TimelineRange, "all">, number> = {
  day: 24 * HOUR,
  week: 7 * 24 * HOUR,
};

/**
 * Where the track starts. "All" starts a little before the oldest version
 * (2% of its age, and at least 10 seconds) so that tick sits clear of the
 * edge, and the versions spread across the track however young the file is.
 * With no versions yet it shows the last hour.
 */
export function timelineStart(
  range: TimelineRange,
  oldest: number | undefined,
  now: number,
): number {
  if (range !== "all") return now - RANGE_MS[range];
  if (oldest === undefined) return now - HOUR;
  return oldest - Math.max(10_000, (now - oldest) * 0.02);
}

/**
 * The axis under the track, left to right: its start, its middle, then
 * "Now". Times for a span under a day and a half, dates beyond. A middle
 * that would read the same as either end is left out, so no label repeats.
 */
export function axisLabels(start: number, now: number): string[] {
  const span = Math.max(1, now - start);
  const label = (ms: number) => (span < 36 * HOUR ? timeLabel(ms) : dateLabel(ms, now));
  const first = label(start);
  const middle = label(start + span / 2);
  return middle === first || middle === label(now) ? [first, "Now"] : [first, middle, "Now"];
}
