// @vitest-environment node
import { describe, expect, it } from "vitest";
import { evaluateNumericInput, formatNumber, roundTo } from "../src/lib/numeric-input";

describe("evaluateNumericInput", () => {
  it.each([
    ["24", 24],
    ["24*2", 48],
    ["24 × 2", 48],
    ["(100 - 8) / 2", 46],
    ["-4 + 10", 6],
    ["1.5rem", 24],
    ["12px + 1rem", 28],
    [".5", 0.5],
  ])("evaluates %s as %d", (input, expected) => {
    expect(evaluateNumericInput(input)).toBe(expected);
  });

  it.each(["", "abc", "1/0", "24 2", "4 +", "(2", "50%", "1.5vw"])("rejects %j", (input) => {
    expect(evaluateNumericInput(input)).toBeNull();
  });

  it("accepts the field's own unit and extra units", () => {
    expect(evaluateNumericInput("50%", { unit: "%" })).toBe(50);
    expect(evaluateNumericInput("1rem", { unit: "%" })).toBeNull();
    expect(evaluateNumericInput("50%", { units: { "%": 3.2 } })).toBe(160);
  });
});

describe("formatting", () => {
  it("rounds without -0 and trims zeros", () => {
    expect(roundTo(-0.001, 2)).toBe(0);
    expect(formatNumber(0.1 + 0.2, 2)).toBe("0.3");
    expect(formatNumber(12, 2)).toBe("12");
  });
});
