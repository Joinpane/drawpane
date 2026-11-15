import { describe, expect, it } from "vitest";
import {
  boxIn,
  boxMatrix,
  IDENTITY,
  type Matrix,
  NoteBook,
  parseSvgPath,
  pathBounds,
  serializePath,
} from "../src";

describe("boxes in a frame's space", () => {
  it("takes a page affine back to x, y, rotation and flip, and round-trips", () => {
    const r = Math.PI / 6;
    // A 100 × 40 box turned 30° about its centre at (200, 120), inside a frame at (50, 20).
    const space: Matrix = [1, 0, 0, 1, 50, 20];
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const world: Matrix = [
      cos,
      sin,
      -sin,
      cos,
      250 - (cos * 50 - sin * 20),
      140 - (sin * 50 + cos * 20),
    ];
    const box = boxIn(space, world, 100, 40);
    expect(box).toMatchObject({
      x: 150,
      y: 100,
      width: 100,
      height: 40,
      rotation: 30,
      flipX: false,
      skewed: false,
    });
    const back = boxMatrix(space, box);
    for (const [i, v] of world.entries()) expect(back[i]).toBeCloseTo(v, 3);
  });

  it("notices a skew", () => {
    expect(boxIn(IDENTITY, [1, 0, 0.5, 1, 0, 0], 10, 10).skewed).toBe(true);
  });
});

describe("path data", () => {
  it("parses, bounds and writes back", () => {
    const path = parseSvgPath("M0 0 L10 0 C10 10 0 10 0 0 Z");
    expect(serializePath(path)).toBe("M0 0 L10 0 C10 10 0 10 0 0 Z");
    expect(pathBounds(path)).toMatchObject({ x: 0, y: 0, width: 10 });
  });
});

describe("notes", () => {
  it("counts by kind and says so", () => {
    const notes = new NoteBook({ skewed: ["layer was straightened", "layers were straightened"] });
    notes.add("skewed");
    notes.add("skewed", 2);
    expect(notes.lines()).toEqual(["3 layers were straightened"]);
  });
});
