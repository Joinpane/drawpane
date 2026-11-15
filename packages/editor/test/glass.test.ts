import { DEFAULT_GLASS, Effect } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { DEFAULT_GLASS_TUNING, floodSteps, glassParams } from "../src/glass";

describe("glassParams", () => {
  it("takes Figma's defaults to device pixels", () => {
    const k = DEFAULT_GLASS_TUNING;
    const p = glassParams(DEFAULT_GLASS, 2);
    // A 20-unit rim at 2× is 40px; full refraction bends a ray a share of that at the edge.
    expect(p.depth).toBe(40);
    expect(p.refraction).toBeCloseTo(0.8 * k.bend * 40, 5);
    expect(p.dispersion).toBeCloseTo(0.5 * k.dispersion, 5);
    expect(p.frost).toBeCloseTo(4 * 2 * k.frost, 5);
    expect(p.splay).toBe(0);
    expect(p.intensity).toBeCloseTo(0.8, 5);
    // It reads the backdrop as far as a ray bends, and the frost reaches.
    expect(p.margin).toBeGreaterThanOrEqual(
      Math.ceil(p.refraction * (1 + p.dispersion) + p.frost * 3),
    );
  });

  it("lights from the top at 0°, turning clockwise", () => {
    // Without the calibrated offset, so the convention itself is what's tested.
    const neutral = { ...DEFAULT_GLASS_TUNING, angleOffset: 0, angleTurn: 1 as const };
    const at = (angle: number) => glassParams({ ...DEFAULT_GLASS, angle }, 1, neutral).light;
    expect(at(0).x).toBeCloseTo(0, 5);
    expect(at(0).y).toBeCloseTo(-1, 5);
    expect(at(90).x).toBeCloseTo(1, 5);
    expect(at(-45).x).toBeLessThan(0);
    expect(at(-45).y).toBeLessThan(0);
  });

  it("keeps the rim within the shape's inner radius, while thicker glass still bends more", () => {
    const deep = { ...DEFAULT_GLASS, depth: 80 };
    const inside = glassParams(deep, 2, DEFAULT_GLASS_TUNING, 140);
    expect(inside.depth).toBe(140);
    const deeper = glassParams({ ...deep, depth: 120 }, 2, DEFAULT_GLASS_TUNING, 140);
    expect(deeper.depth).toBe(140);
    expect(deeper.refraction).toBeGreaterThan(inside.refraction);
  });

  it("still bends a little through a rim with no depth, so refraction stays visible", () => {
    expect(glassParams({ ...DEFAULT_GLASS, depth: 0 }, 1).refraction).toBeGreaterThan(0);
    expect(glassParams({ ...DEFAULT_GLASS, refraction: 0 }, 1).refraction).toBe(0);
  });
});

describe("floodSteps", () => {
  it("floods from just past the rim down to single pixels, then once more at 1", () => {
    expect(floodSteps(20)).toEqual([32, 16, 8, 4, 2, 1, 1]);
    expect(floodSteps(0)).toEqual([2, 1, 1]);
    // A huge rim still stops at a step the GPU can take in a few passes.
    expect(floodSteps(1e6)[0]).toBe(2048);
  });
});

describe("the glass effect in a file", () => {
  it("is valid with Figma's defaults, and keeps its values in range", () => {
    expect(Effect.safeParse(DEFAULT_GLASS).success).toBe(true);
    expect(Effect.safeParse({ ...DEFAULT_GLASS, refraction: 140 }).success).toBe(false);
    expect(Effect.safeParse({ ...DEFAULT_GLASS, depth: -1 }).success).toBe(false);
  });
});
