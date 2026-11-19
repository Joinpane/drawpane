import { describe, expect, it } from "vitest";
import { outsideTolerance, score } from "../src/compare";

const solid = (w: number, h: number, rgba: [number, number, number, number]) => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set(rgba, i * 4);
  return out;
};

describe("the parity score", () => {
  it("sees alpha: transparent white is not opaque white", () => {
    const s = score(solid(10, 10, [255, 255, 255, 0]), solid(10, 10, [255, 255, 255, 255]), 10, 10);
    // Kit parity's own score, over white only, can't tell them apart.
    expect(s.kit.mean).toBe(0);
    expect(s.alphaMax).toBe(255);
    expect(s.mean).toBe(255);
    expect(outsideTolerance(s)).not.toEqual([]);
  });

  it("catches a small local defect a frame's mean hides", () => {
    const ours = solid(100, 100, [255, 255, 255, 255]);
    for (let i = 0; i < 5; i++) ours.set([0, 0, 0, 255], (i * 100 + i) * 4);
    const s = score(ours, solid(100, 100, [255, 255, 255, 255]), 100, 100);
    expect(s.kit.mean).toBeLessThan(0.25);
    expect(s.kit.p99).toBe(0);
    expect(s.max).toBe(255);
    expect(s.severeInTile).toBe(5);
    expect(outsideTolerance(s).join()).toMatch(/severe/);
  });

  it("passes identical pictures", () => {
    const a = solid(40, 40, [10, 20, 30, 128]);
    const s = score(a, a, 40, 40);
    expect(outsideTolerance(s)).toEqual([]);
    expect(s.max).toBe(0);
  });
});
