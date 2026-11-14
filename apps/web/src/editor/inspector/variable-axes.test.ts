import { describe, expect, it } from "vitest";
import { axisName, axisStep, onAxis, variationSummary, withAxis } from "./variable-axes";

describe("variable axes in the inspector", () => {
  it("names an axis as the font does, else as registered, else by its tag", () => {
    expect(axisName({ tag: "XTRA", name: "Counter width" })).toBe("Counter width");
    expect(axisName({ tag: "wdth", name: null })).toBe("Width");
    expect(axisName({ tag: "opsz", name: "  " })).toBe("Optical size");
    expect(axisName({ tag: "YTUC", name: null })).toBe("YTUC");
  });

  it("moves narrow axes finely and wide ones in whole units", () => {
    expect(axisStep({ min: 0, max: 1 })).toBe(0.01);
    expect(axisStep({ min: -10, max: 0 })).toBe(0.1);
    expect(axisStep({ min: 25, max: 151 })).toBe(1);
    expect(onAxis({ min: 25, max: 151 }, 84.6)).toBe(85);
    expect(onAxis({ min: -10, max: 0 }, -3.12345)).toBe(-3.1);
    expect(onAxis({ min: 25, max: 151 }, 400)).toBe(151);
  });

  it("sums up what text sets, by name, in tag order", () => {
    expect(variationSummary({})).toBeNull();
    expect(variationSummary({ wdth: 85, GRAD: 50 })).toBe("Grade 50 · Width 85");
    expect(variationSummary({ XTRA: 400 }, new Map([["XTRA", "Counter width"]]))).toBe(
      "Counter width 400",
    );
  });

  it("sets an axis, or takes it back to the font's default", () => {
    expect(withAxis({ wdth: 85 }, "GRAD", 50)).toEqual({ wdth: 85, GRAD: 50 });
    expect(withAxis({ wdth: 85, GRAD: 50 }, "wdth", null)).toEqual({ GRAD: 50 });
  });
});
