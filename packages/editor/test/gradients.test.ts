import { describe, expect, it } from "vitest";
import {
  boxInGradientSpace,
  cssGradient,
  type GradientPaint,
  gradientMatrix,
  linearInPixels,
} from "../src/gradients";

const paint = (type: GradientPaint["type"], from: [number, number], to: [number, number]) =>
  ({
    type,
    from: { x: from[0], y: from[1] },
    to: { x: to[0], y: to[1] },
    stops: [
      { position: 0, color: "#000000" },
      { position: 1, color: "#ffffff" },
    ],
  }) as GradientPaint;

const apply = (m: readonly number[], x: number, y: number) => ({
  x: (m[0] as number) * x + (m[2] as number) * y + (m[4] as number),
  y: (m[1] as number) * x + (m[3] as number) * y + (m[5] as number),
});

describe("gradients in the layer's unit square", () => {
  it("puts a radial gradient's circle there, an ellipse on a wide layer", () => {
    const m = gradientMatrix(paint("radial", [0.5, 0.5], [1, 0.5]), 200, 100) as readonly number[];
    // Centre, the end of the handle, and a quarter turn round: 100 across, 50 down.
    expect(apply(m, 0, 0)).toEqual({ x: 100, y: 50 });
    expect(apply(m, 1, 0)).toEqual({ x: 200, y: 50 });
    expect(apply(m, 0, 1)).toEqual({ x: 100, y: 100 });
  });

  it("covers the layer's box in the gradient's space", () => {
    const m = gradientMatrix(paint("linear", [0, 0], [1, 1]), 200, 100) as readonly number[];
    const box = boxInGradientSpace(m as never, 200, 100);
    for (const [x, y] of [
      [0, 0],
      [200, 100],
    ] as const) {
      // Each corner, back in the gradient's space, is inside the box.
      const det = (m[0] as number) * (m[3] as number) - (m[1] as number) * (m[2] as number);
      const gx =
        ((m[3] as number) * (x - (m[4] as number)) - (m[2] as number) * (y - (m[5] as number))) /
        det;
      const gy =
        (-(m[1] as number) * (x - (m[4] as number)) + (m[0] as number) * (y - (m[5] as number))) /
        det;
      expect(gx).toBeGreaterThanOrEqual(box.x);
      expect(gx).toBeLessThanOrEqual(box.x + box.width);
      expect(gy).toBeGreaterThanOrEqual(box.y);
      expect(gy).toBeLessThanOrEqual(box.y + box.height);
    }
  });

  it("gives a linear gradient the same bands as a line in pixels", () => {
    // Corner to corner on a wide layer: the bands run along the other diagonal, not at right angles.
    const line = linearInPixels(paint("linear", [0, 0], [1, 1]), 200, 100);
    expect(line).not.toBeNull();
    const { x0, y0, x1, y1 } = line as { x0: number; y0: number; x1: number; y1: number };
    const value = (x: number, y: number) =>
      ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / ((x1 - x0) ** 2 + (y1 - y0) ** 2);
    expect(value(0, 0)).toBeCloseTo(0, 6);
    expect(value(200, 100)).toBeCloseTo(1, 6);
    // The other two corners lie on the middle band.
    expect(value(200, 0)).toBeCloseTo(0.5, 6);
    expect(value(0, 100)).toBeCloseTo(0.5, 6);
  });

  it("has no layout when the handles meet", () => {
    expect(gradientMatrix(paint("radial", [0.5, 0.5], [0.5, 0.5]), 100, 100)).toBeNull();
    expect(linearInPixels(paint("linear", [0.2, 0.2], [0.2, 0.2]), 100, 100)).toBeNull();
  });
});

describe("cssGradient", () => {
  const css = (p: GradientPaint, w = 100, h = 100) => cssGradient(p, w, h, (c) => c);

  it("writes a radial gradient as an ellipse in percent of the box, which CSS accepts", () => {
    // `circle 50%` isn't valid CSS: a browser would drop the whole background.
    expect(css(paint("radial", [0.5, 0.5], [1, 0.5]), 240, 112)).toBe(
      "radial-gradient(ellipse 50% 50% at 50% 50%, #000000 0%, #ffffff 100%)",
    );
    expect(css(paint("radial", [0.25, 0.5], [0.25, 0.8]))).toBe(
      "radial-gradient(ellipse 30% 30% at 25% 50%, #000000 0%, #ffffff 100%)",
    );
  });

  it("lays a linear gradient's stops where its handles are, for the box's size", () => {
    // Across the whole box: CSS's own line, stops unchanged.
    expect(css(paint("linear", [0, 0.5], [1, 0.5]), 240, 112)).toBe(
      "linear-gradient(90deg, #000000 0%, #ffffff 100%)",
    );
    // Handles over the middle half: the stops move in to them.
    expect(css(paint("linear", [0.25, 0.5], [0.75, 0.5]), 240, 112)).toBe(
      "linear-gradient(90deg, #000000 25%, #ffffff 75%)",
    );
    // Top to bottom, the other way round.
    expect(css(paint("linear", [0.5, 1], [0.5, 0]), 240, 112)).toBe(
      "linear-gradient(0deg, #000000 0%, #ffffff 100%)",
    );
  });

  it("slants a diagonal linear gradient on a wide box as the canvas does", () => {
    // Corner to corner in the unit square: on a 2:1 box the bands stay parallel to the other
    // diagonal, so the gradient rises along (1, 2), steeper than the handles' (2, 1).
    const out = css(paint("linear", [0, 0], [1, 1]), 200, 100) as string;
    const angle = Number(/linear-gradient\(([\d.]+)deg/.exec(out)?.[1]);
    expect(angle).toBeCloseTo((Math.atan2(1, -2) * 180) / Math.PI, 1);
    expect(out).toMatch(/#000000 0%, #ffffff 100%\)$/);
  });

  it("starts an angular gradient toward its end handle, from CSS's 12 o'clock", () => {
    expect(css(paint("angular", [0.5, 0.5], [1, 0.5]))).toBe(
      "conic-gradient(from 90deg at 50% 50%, #000000 0%, #ffffff 100%)",
    );
    expect(css(paint("angular", [0.5, 0.5], [0.5, 0]))).toBe(
      "conic-gradient(from 0deg at 50% 50%, #000000 0%, #ffffff 100%)",
    );
  });

  it("is null when the handles meet, as the canvas draws nothing then", () => {
    for (const type of ["linear", "radial", "angular"] as const)
      expect(css(paint(type, [0.5, 0.5], [0.5, 0.5]))).toBeNull();
  });

  it("orders stops by position, as CSS needs", () => {
    const p = paint("radial", [0.5, 0.5], [1, 0.5]);
    p.stops = [
      { position: 1, color: "#ffffff" },
      { position: 0, color: "#000000" },
    ];
    expect(css(p)).toBe("radial-gradient(ellipse 50% 50% at 50% 50%, #000000 0%, #ffffff 100%)");
  });
});
