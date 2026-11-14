import { describe, expect, it } from "vitest";
import { initials, timeUntil } from "./format";

const now = Date.UTC(2026, 10, 14, 12);
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

describe("timeUntil", () => {
  it("counts down in minutes, hours, then days, never as a date", () => {
    const until = (ms: number) => timeUntil(now + ms, now);
    expect(until(40 * minute)).toMatch(/40 minutes/);
    expect(until(5 * hour)).toMatch(/5 hours/);
    expect(until(47 * hour)).toMatch(/47 hours/);
    expect(until(6 * day + 23 * hour)).toMatch(/7 days/);
    expect(until(7 * day)).toMatch(/7 days/);
  });

  it("says at least a minute for something about to happen, or just past", () => {
    expect(timeUntil(now + 10_000, now)).toMatch(/1 minute/);
    expect(timeUntil(now - 10_000, now)).toMatch(/1 minute/);
  });
});

describe("initials", () => {
  it("takes the first and last name's first letters", () => {
    expect(initials("Ana Lima")).toBe("AL");
    expect(initials("  Sam  ")).toBe("S");
    expect(initials("Mo van der Berg")).toBe("MB");
  });
});
