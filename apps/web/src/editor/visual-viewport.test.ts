import { describe, expect, it } from "vitest";
import { readVisualViewport } from "./visual-viewport";

describe("readVisualViewport", () => {
  it("falls back to layout dimensions when visualViewport is absent", () => {
    expect(readVisualViewport({ innerWidth: 393, innerHeight: 852, visualViewport: null })).toEqual(
      {
        width: 393,
        height: 852,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
        bottomInset: 0,
      },
    );
  });

  it("computes keyboard bottomInset and preserves visualViewport offsets", () => {
    expect(
      readVisualViewport({
        innerWidth: 393,
        innerHeight: 852,
        visualViewport: {
          width: 393,
          height: 460,
          offsetTop: 24,
          offsetLeft: 0,
          scale: 1,
        },
      }),
    ).toEqual({
      width: 393,
      height: 460,
      offsetTop: 24,
      offsetLeft: 0,
      scale: 1,
      bottomInset: 368,
    });
  });

  it("clamps negative bottomInset to zero", () => {
    expect(
      readVisualViewport({
        innerWidth: 393,
        innerHeight: 800,
        visualViewport: {
          width: 393,
          height: 840,
          offsetTop: 0,
          offsetLeft: 0,
          scale: 1,
        },
      }).bottomInset,
    ).toBe(0);
  });
});
