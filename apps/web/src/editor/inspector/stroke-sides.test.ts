import { describe, expect, it } from "vitest";
import { forMode, sidesMode, withSide, withWeight } from "./stroke-sides";

describe("stroke sides in the inspector", () => {
  it("names what a layer has", () => {
    expect(sidesMode(null)).toBe("all");
    expect(sidesMode([2, 2, 2, 2])).toBe("all");
    expect(sidesMode([0, 0, 1, 0])).toBe("bottom");
    expect(sidesMode([0, 3, 0, 0])).toBe("right");
    expect(sidesMode([1, 0, 1, 0])).toBe("custom");
  });

  it("moves the width to one side, back to all, or out to each", () => {
    expect(forMode("bottom", 2, null)).toEqual({ strokeWeights: [0, 0, 2, 0], strokeWeight: 2 });
    expect(forMode("all", 1, [0, 0, 3, 0])).toEqual({ strokeWeights: null, strokeWeight: 3 });
    expect(forMode("custom", 2, null)).toEqual({ strokeWeights: [2, 2, 2, 2], strokeWeight: 2 });
    // From one side: that side kept, the others none.
    expect(forMode("custom", 4, [0, 0, 4, 0])).toEqual({
      strokeWeights: [0, 0, 4, 0],
      strokeWeight: 4,
    });
    // Already custom: kept as it is.
    expect(forMode("custom", 4, [1, 0, 4, 0])).toEqual({
      strokeWeights: [1, 0, 4, 0],
      strokeWeight: 4,
    });
    // No width at all: a side gets 1, so it shows.
    expect(forMode("top", 0, null)).toEqual({ strokeWeights: [1, 0, 0, 0], strokeWeight: 1 });
  });

  it("sets the width of the side shown, or of every side", () => {
    expect(withWeight([0, 0, 1, 0], 4)).toEqual({ strokeWeights: [0, 0, 4, 0], strokeWeight: 4 });
    expect(withWeight([1, 0, 4, 0], 2)).toEqual({ strokeWeights: null, strokeWeight: 2 });
    expect(withWeight(null, 3)).toEqual({ strokeWeights: null, strokeWeight: 3 });
  });

  it("sets one side, keeping the widest as the layer's width", () => {
    expect(withSide([1, 0, 4, 0], "left", 6)).toEqual({
      strokeWeights: [1, 0, 4, 6],
      strokeWeight: 6,
    });
  });
});
