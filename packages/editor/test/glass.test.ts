import { DEFAULT_GLASS } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { DEFAULT_GLASS_TUNING, glassParams, heightScale } from "../src/glass";

describe("glassParams", () => {
  it("takes Figma's defaults to device pixels", () => {
    const k = DEFAULT_GLASS_TUNING;
    const p = glassParams(DEFAULT_GLASS, 2);
    // A 20-unit rim at 2× is 40px; full refraction bends a ray a share of that at the edge.
    expect(p.depth).toBe(40);
    expect(p.refraction).toBeCloseTo(0.8 * k.slopeBend * 40, 5);
    expect(p.dispersion).toBeCloseTo(0.5 * k.dispersion, 5);
    expect(p.frost).toBeCloseTo(4 * 2 * k.frost, 5);
    expect(p.splay).toBe(0);
    expect(p.intensity).toBeCloseTo(0.8, 5);
    // It reads the backdrop as far as a ray bends, and the frost reaches.
    expect(p.margin).toBeGreaterThanOrEqual(
      Math.ceil(p.refraction * (1 + p.dispersion) + p.frost * 3),
    );
  });

  it("bends a box's edge as far as its rim is deep at full refraction, as Figma does", () => {
    const k = DEFAULT_GLASS_TUNING;
    const box = glassParams(
      { ...DEFAULT_GLASS, refraction: 100, depth: 50 },
      2,
      k,
      Infinity,
      "box",
    );
    expect(box.refraction).toBeCloseTo(k.bend * 100, 5);
    // Figma's falloff steepens with depth.
    const deep = glassParams({ ...DEFAULT_GLASS, depth: 100 }, 1, k, Infinity, "box");
    const shallow = glassParams({ ...DEFAULT_GLASS, depth: 20 }, 1, k, Infinity, "box");
    expect(deep.falloff).toBeGreaterThan(shallow.falloff);
  });

  it("bends an ellipse a share of that growing with the depth, as Figma's", () => {
    const share = (depth: number) => {
      const p = glassParams(
        { ...DEFAULT_GLASS, refraction: 100, depth },
        1,
        undefined,
        Infinity,
        "ellipse",
      );
      return p.refraction / depth;
    };
    // Figma, measured on circles of every size: 0.38 at depth 10, 0.59 at 20, 0.78 at 40, 0.87 at 70.
    expect(share(10)).toBeCloseTo(0.38, 1);
    expect(share(20)).toBeCloseTo(0.59, 1);
    expect(share(40)).toBeCloseTo(0.78, 1);
    expect(share(70)).toBeCloseTo(0.87, 1);
  });

  it("takes depth and frost no further than Figma's 100", () => {
    const p = glassParams({ ...DEFAULT_GLASS, depth: 160, frost: 100 }, 1);
    expect(p.depth).toBe(100);
    expect(p.frost).toBeCloseTo(100 * DEFAULT_GLASS_TUNING.frost, 5);
  });

  it("lights from the top at 0°, turning clockwise, with no offset (as Figma)", () => {
    const at = (angle: number) => glassParams({ ...DEFAULT_GLASS, angle }, 1).light;
    expect(at(0).x).toBeCloseTo(0, 5);
    expect(at(0).y).toBeCloseTo(-1, 5);
    expect(at(90).x).toBeCloseTo(1, 5);
    // −45° lights the top and the left alike.
    expect(at(-45).x).toBeCloseTo(at(-45).y, 5);
    expect(at(-45).x).toBeLessThan(0);
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
