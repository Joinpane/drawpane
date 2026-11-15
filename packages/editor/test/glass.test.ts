import { DEFAULT_GLASS } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { DEFAULT_GLASS_TUNING, glassParams, heightScale } from "../src/glass";

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

  it("makes the rim's height with a Gaussian a share of its depth wide", () => {
    const p = glassParams({ ...DEFAULT_GLASS, depth: 40 }, 2);
    expect(p.sigma).toBeCloseTo(80 * DEFAULT_GLASS_TUNING.rimSigma, 5);
    // A rim with no depth still has a little.
    expect(glassParams({ ...DEFAULT_GLASS, depth: 0 }, 1).sigma).toBeGreaterThan(0);
  });

  it("still bends a little through a rim with no depth, so refraction stays visible", () => {
    expect(glassParams({ ...DEFAULT_GLASS, depth: 0 }, 1).refraction).toBeGreaterThan(0);
    expect(glassParams({ ...DEFAULT_GLASS, refraction: 0 }, 1).refraction).toBe(0);
  });
});

describe("heightScale", () => {
  it("downsamples a wide rim's blur, keeping its Gaussian at least 3 pixels wide", () => {
    expect(heightScale(1)).toBe(1);
    expect(heightScale(5.9)).toBe(1);
    expect(heightScale(12)).toBe(4);
    // Even past 1, so the downsample can read four pixels at a time.
    expect(heightScale(9)).toBe(2);
    expect(heightScale(500)).toBe(8);
  });
});
