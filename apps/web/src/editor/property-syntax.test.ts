import { describe, expect, it } from "vitest";
import { evaluate, parsePropertyCommand } from "./property-syntax";

describe("evaluate", () => {
  it.each([
    ["24*2", 48],
    ["1.5rem", 24],
    ["(10+2)/4", 3],
    ["-8", -8],
    ["10 - 2 * 3", 4],
    ["50%", 50],
    ["320px", 320],
  ])("%s = %d", (input, expected) => {
    expect(evaluate(input)).toBe(expected);
  });

  it.each(["", "abc", "1/0", "2**3", "1+", "(1", "alert(1)"])("rejects %j", (input) => {
    expect(evaluate(input)).toBeNull();
  });
});

describe("parsePropertyCommand", () => {
  it("sets numbers with math", () => {
    expect(parsePropertyCommand("w 320")).toEqual({
      label: "Width",
      display: "320",
      sets: [{ prop: "width", value: 320 }],
    });
    expect(parsePropertyCommand("gap 8*2")?.sets).toEqual([{ prop: "gap", value: 16 }]);
  });

  it("expands padding shorthand like CSS", () => {
    expect(parsePropertyCommand("p 8 16")?.sets.map((s) => s.value)).toEqual([8, 16, 8, 16]);
    expect(parsePropertyCommand("p 1 2 3")).toBeNull();
  });

  it("parses colors, percentages and enums", () => {
    expect(parsePropertyCommand("fill f50")?.sets).toEqual([
      { prop: "fills", value: [{ type: "solid", color: "#ff5500" }] },
    ]);
    expect(parsePropertyCommand("opacity 50")?.sets).toEqual([{ prop: "opacity", value: 0.5 }]);
    expect(parsePropertyCommand("layout row")?.sets).toEqual([
      { prop: "layoutMode", value: "row" },
    ]);
    expect(parsePropertyCommand("layout diagonal")).toBeNull();
  });

  it("ignores text that isn't a property command", () => {
    expect(parsePropertyCommand("group")).toBeNull();
    expect(parsePropertyCommand("frobnicate 3")).toBeNull();
  });
});
