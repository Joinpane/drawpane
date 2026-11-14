import { describe, expect, it } from "vitest";
import { highlightParts, matchesAll } from "./search";

describe("dashboard search", () => {
  it("marks every match of every word, merging overlaps", () => {
    expect(highlightParts("Onboarding flow", "flow on")).toEqual([
      { text: "On", match: true },
      { text: "boarding ", match: false },
      { text: "flow", match: true },
    ]);
    expect(highlightParts("banana", "ana")).toEqual([
      { text: "b", match: false },
      { text: "anana", match: true },
    ]);
    expect(highlightParts("Settings", "  ")).toEqual([{ text: "Settings", match: false }]);
  });

  it("matches only names with every word, in any order and case", () => {
    expect(matchesAll("Onboarding flow v2", "FLOW onboard")).toBe(true);
    expect(matchesAll("Checkout flow", "flow onboard")).toBe(false);
  });
});
