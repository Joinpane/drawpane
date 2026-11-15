import { describe, expect, it } from "vitest";
import {
  isUniform,
  roundBoxPath,
  strokeReach,
  strokeRegion,
  strokeRegionPath,
} from "../src/stroke-sides";

const SQUARE = [0, 0, 0, 0] as const;

describe("per-side stroke regions", () => {
  it("is a bottom border alone: the box less one inset only from below", () => {
    const { outer, inner } = strokeRegion(100, 40, SQUARE, [0, 0, 1, 0], "inside");
    expect(outer).toMatchObject({ x: 0, y: 0, width: 100, height: 40 });
    expect(inner).toMatchObject({ x: 0, y: 0, width: 100, height: 39 });
  });

  it("straddles the edge when centred, and lies outside it when outside", () => {
    const centred = strokeRegion(100, 40, SQUARE, [2, 0, 2, 0], "center");
    expect(centred.outer).toMatchObject({ x: 0, y: -1, width: 100, height: 42 });
    expect(centred.inner).toMatchObject({ x: 0, y: 1, width: 100, height: 38 });
    const outside = strokeRegion(100, 40, SQUARE, [0, 0, 0, 3], "outside");
    expect(outside.outer).toMatchObject({ x: -3, y: 0, width: 103, height: 40 });
    expect(outside.inner).toMatchObject({ x: 0, y: 0, width: 100, height: 40 });
  });

  it("keeps square corners square, inside and out", () => {
    const { outer, inner } = strokeRegion(100, 40, SQUARE, [4, 1, 1, 1], "outside");
    expect(outer.corners).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(inner?.corners).toEqual(outer.corners);
  });

  it("shrinks a rounded corner along each side's own width: elliptical inside", () => {
    const { outer, inner } = strokeRegion(100, 40, [8, 8, 8, 8], [4, 1, 1, 1], "inside");
    expect(outer.corners[0]).toEqual([8, 8]);
    // Top-left: in by 1 from the left, by 4 from the top.
    expect(inner?.corners[0]).toEqual([7, 4]);
    expect(inner?.corners[2]).toEqual([7, 7]);
  });

  it("grows a rounded corner outside", () => {
    const { outer } = strokeRegion(100, 40, [8, 8, 8, 8], [2, 2, 2, 6], "outside");
    expect(outer.corners[0]).toEqual([14, 10]);
  });

  it("is the whole box when the widths meet in the middle", () => {
    expect(strokeRegion(10, 10, SQUARE, [6, 0, 6, 0], "inside").inner).toBeNull();
  });

  it("clamps radii as the outline does", () => {
    const { outer } = strokeRegion(100, 20, [50, 50, 50, 50], [1, 1, 1, 1], "inside");
    expect(outer.corners[0]).toEqual([10, 10]);
  });
});

describe("per-side stroke paths", () => {
  it("draw a square box as four straight sides", () => {
    expect(
      roundBoxPath({
        x: 0,
        y: 0,
        width: 10,
        height: 5,
        corners: [
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
        ],
      }),
    ).toBe("M0 0H10V5H0V0Z");
  });

  it("add the inner box as a second subpath, for the even-odd rule", () => {
    const d = strokeRegionPath(strokeRegion(10, 10, SQUARE, [1, 1, 1, 1], "inside"));
    expect(d).toBe("M0 0H10V10H0V0ZM1 1H9V9H1V1Z");
  });

  it("round corners with quarter-ellipse curves", () => {
    const d = roundBoxPath({
      x: 0,
      y: 0,
      width: 20,
      height: 20,
      corners: [
        [4, 2],
        [0, 0],
        [0, 0],
        [0, 0],
      ],
    });
    expect(d.startsWith("M4 0H20")).toBe(true);
    expect(d.endsWith("V2C0 0.895 1.791 0 4 0Z")).toBe(true);
  });
});

describe("per-side stroke reach", () => {
  it("is each width outside, half of it centred, nothing inside", () => {
    expect(strokeReach([1, 2, 3, 4], "outside")).toEqual([1, 2, 3, 4]);
    expect(strokeReach([1, 2, 3, 4], "center")).toEqual([0.5, 1, 1.5, 2]);
    expect(strokeReach([1, 2, 3, 4], "inside")).toEqual([0, 0, 0, 0]);
  });

  it("knows a stroke as wide all round", () => {
    expect(isUniform([2, 2, 2, 2])).toBe(true);
    expect(isUniform([2, 2, 2, 0])).toBe(false);
  });
});
