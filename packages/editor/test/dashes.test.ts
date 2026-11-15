import { describe, expect, it } from "vitest";
import { boxOutline, ellipseOutline, fitDashes } from "../src/dashes";

describe("dashes fitted to each piece of an outline, as Figma draws them", () => {
  it("keeps a pattern that already fits, centring a dash on the start", () => {
    // 96 long, a 10 + 6 pattern: six repeats, unchanged.
    expect(fitDashes(96, [10, 6])).toEqual({ dashes: [10, 6], offset: 5 });
  });

  it("stretches or squeezes it to a whole number of repeats", () => {
    // 56 long: 3.5 repeats of 16 becomes 4 of 14.
    const { dashes, offset } = fitDashes(56, [10, 6]);
    expect(dashes[0]).toBeCloseTo(8.75, 6);
    expect(dashes[1]).toBeCloseTo(5.25, 6);
    expect(offset).toBeCloseTo(4.375, 6);
    // Shorter than one repeat: one, squeezed.
    expect(fitDashes(8, [10, 6]).dashes[0]).toBeCloseTo(5, 6);
  });

  it("repeats an odd pattern twice over, as a canvas does", () => {
    expect(fitDashes(30, [5]).dashes).toEqual([5, 5]);
  });

  it("splits a rounded box into its sides and corners", () => {
    const pieces = boxOutline(120, 80, [12, 12, 12, 12]);
    expect(pieces.map((p) => p.kind)).toEqual([
      "line",
      "arc",
      "line",
      "arc",
      "line",
      "arc",
      "line",
      "arc",
    ]);
    expect(pieces[0]?.length).toBeCloseTo(96, 6);
    expect(pieces[2]?.length).toBeCloseTo(56, 6);
    // A quarter circle of radius 12.
    expect(pieces[1]?.length).toBeCloseTo((Math.PI / 2) * 12, 4);
    // Square corners have no corner pieces; radii past half the shorter side are clamped.
    expect(boxOutline(120, 80, [0, 0, 0, 0])).toHaveLength(4);
    expect(boxOutline(120, 80, [100, 0, 0, 0])[0]?.length).toBeCloseTo(80, 6);
  });

  it("splits an ellipse into quarters", () => {
    const quarters = ellipseOutline(100, 100);
    expect(quarters).toHaveLength(4);
    expect(quarters[0]?.length).toBeCloseTo((Math.PI * 100) / 4, 3);
  });
});
