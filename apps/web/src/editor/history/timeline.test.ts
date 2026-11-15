import { describe, expect, it } from "vitest";
import { dateLabel, timeLabel } from "./labels";
import { axisLabels, timelineStart } from "./timeline";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 2:30 PM local time, mid-month: no day or year boundary nearby.
const NOW = new Date(2026, 10, 15, 14, 30, 0).getTime();

const share = (ms: number, start: number) => (ms - start) / (NOW - start);

describe("the version timeline", () => {
  it("spreads a young file's versions across the track", () => {
    // Three versions over the last 40 seconds.
    const oldest = NOW - 40_000;
    const start = timelineStart("all", oldest, NOW);
    expect(start).toBeLessThan(oldest);
    // The oldest sits in from the left edge, not piled at the right with the rest.
    expect(share(oldest, start)).toBeGreaterThan(0);
    expect(share(oldest, start)).toBeLessThan(0.25);
    expect(share(NOW - 20_000, start)).toBeLessThan(0.7);
  });

  it("leaves an old file's oldest version a little in from the edge", () => {
    const oldest = NOW - 30 * 24 * HOUR;
    const start = timelineStart("all", oldest, NOW);
    expect(share(oldest, start)).toBeCloseTo(0.02, 2);
  });

  it("shows a day, a week, or the last hour before any version", () => {
    expect(timelineStart("day", NOW - MINUTE, NOW)).toBe(NOW - 24 * HOUR);
    expect(timelineStart("week", NOW - MINUTE, NOW)).toBe(NOW - 7 * 24 * HOUR);
    expect(timelineStart("all", undefined, NOW)).toBe(NOW - HOUR);
  });

  it("labels the axis with times, then dates past a day and a half", () => {
    expect(axisLabels(NOW - 2 * HOUR, NOW)).toEqual([
      timeLabel(NOW - 2 * HOUR),
      timeLabel(NOW - HOUR),
      "Now",
    ]);
    expect(axisLabels(NOW - 7 * 24 * HOUR, NOW)).toEqual([
      dateLabel(NOW - 7 * 24 * HOUR, NOW),
      dateLabel(NOW - 3.5 * 24 * HOUR, NOW),
      "Now",
    ]);
  });

  it("never prints the same label twice", () => {
    // Under a minute: the middle reads the same as the start, or as now.
    for (const span of [20_000, 50_000, 90_000, 2 * 24 * HOUR - HOUR]) {
      const labels = axisLabels(NOW - span, NOW);
      expect(new Set(labels).size).toBe(labels.length);
      expect(labels.at(-1)).toBe("Now");
    }
    const young = axisLabels(NOW - 30_000, NOW);
    expect(young).toEqual([timeLabel(NOW - 30_000), "Now"]);
  });
});
