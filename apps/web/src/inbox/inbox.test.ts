import { describe, expect, it } from "vitest";
import type { InboxItem } from "../api/client";
import { dayLabel, inboxSentence } from "./inbox";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe("dayLabel", () => {
  const now = at(2026, 11, 14, 9);

  it("says Today and Yesterday by calendar day, not 24-hour windows", () => {
    expect(dayLabel(at(2026, 11, 14, 0), now)).toBe("Today");
    // Late last night is yesterday, though it's under 24 hours ago.
    expect(dayLabel(at(2026, 11, 13, 23), now)).toBe("Yesterday");
  });

  it("names the weekday within the week, then the date, with the year only when it's another", () => {
    expect(dayLabel(at(2026, 11, 10), now)).toBe(
      new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(at(2026, 11, 10)),
    );
    expect(dayLabel(at(2026, 10, 2), now)).toBe(
      new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" }).format(at(2026, 10, 2)),
    );
    expect(dayLabel(at(2025, 12, 30), now)).toContain("2025");
  });
});

describe("inboxSentence", () => {
  const item = (kind: InboxItem["kind"], actor: InboxItem["actor"]): InboxItem => ({
    id: "n1",
    kind,
    createdAt: 0,
    readAt: null,
    file: { id: "f", name: "Onboarding" },
    threadId: "t",
    resolved: false,
    actor,
    excerpt: "",
  });

  it("says who did what", () => {
    const lena = { id: "u", name: "Lena Park" };
    expect(inboxSentence(item("mention", lena))).toEqual({
      who: "Lena Park",
      did: "mentioned you in",
    });
    expect(inboxSentence(item("reply", lena)).did).toBe("replied in");
    expect(inboxSentence(item("resolved", lena)).did).toBe("resolved your comment in");
    // Their account is gone.
    expect(inboxSentence(item("reply", null)).who).toBe("Someone");
  });
});
