import { describe, expect, it } from "vitest";
import { FontVariations, PROPS, TextRun } from "../src/schema";

describe("font variations (decision 0009)", () => {
  it("are axis tags with numbers, at most 32", () => {
    expect(FontVariations.safeParse({ wdth: 85, GRAD: -50, opsz: 12.5 }).success).toBe(true);
    expect(FontVariations.safeParse({ width: 85 }).success).toBe(false);
    expect(FontVariations.safeParse({ wdth: Number.NaN }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`A${100 + i}`, 1]));
    expect(FontVariations.safeParse(many).success).toBe(false);
  });

  it("leave weight and italic to fontWeight and fontStyle", () => {
    expect(FontVariations.safeParse({ wght: 650 }).success).toBe(false);
    expect(FontVariations.safeParse({ ital: 1 }).success).toBe(false);
  });

  it("are a text prop, empty by default, and a run can set its own", () => {
    expect(PROPS.fontVariations.default).toEqual({});
    expect(TextRun.safeParse({ start: 0, end: 2, fontVariations: { wdth: 75 } }).success).toBe(
      true,
    );
  });
});
