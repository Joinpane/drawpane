import { describe, expect, it } from "vitest";
import { evaluate, parseBindingCommand, parsePropertyCommand } from "./property-syntax";

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

  it("sets and clears size limits, and row gap", () => {
    expect(parsePropertyCommand("maxw 640")).toEqual({
      label: "Max width",
      display: "640",
      sets: [{ prop: "maxWidth", value: 640 }],
    });
    expect(parsePropertyCommand("minh 2.5rem")?.sets).toEqual([{ prop: "minHeight", value: 40 }]);
    expect(parsePropertyCommand("minwidth none")).toEqual({
      label: "Min width",
      display: "None",
      sets: [{ prop: "minWidth", value: null }],
    });
    expect(parsePropertyCommand("maxh -4")).toBeNull();
    expect(parsePropertyCommand("rowgap 12")?.sets).toEqual([{ prop: "rowGap", value: 12 }]);
  });

  it("ignores text that isn't a property command", () => {
    expect(parsePropertyCommand("group")).toBeNull();
    expect(parsePropertyCommand("frobnicate 3")).toBeNull();
  });
});

describe("parseBindingCommand", () => {
  it("reads a property and the variable to look for", () => {
    expect(parseBindingCommand("fill brand/500")).toEqual({
      keys: ["fill"],
      label: "Fill",
      query: "brand/500",
    });
    expect(parseBindingCommand("p space/200")?.keys).toEqual([
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
    ]);
  });

  it("accepts a token reference in braces, and nothing else", () => {
    expect(parseBindingCommand("gap {space/300}")?.query).toBe("space/300");
    expect(parseBindingCommand("fill")).toBeNull();
    expect(parseBindingCommand("frobnicate brand")).toBeNull();
  });
});
