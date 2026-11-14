import { describe, expect, it } from "vitest";
import { searchFold } from "../src/search";

describe("searchFold", () => {
  it("drops accents and case, so any spelling of a name matches", () => {
    expect(searchFold("École brief")).toBe("ecole brief");
    expect(searchFold("ÜBER Landing")).toBe("uber landing");
    expect(searchFold("Crème brûlée")).toBe(searchFold("CREME BRULEE"));
    // Letters with no accent to drop stay as they are.
    expect(searchFold("Straße 東京")).toBe("straße 東京");
  });
});
