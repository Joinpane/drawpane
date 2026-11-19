/** SVG path data as engine path verbs, with Path2D's rules (src/engine/svg-path.ts). */
import { VERB } from "@drawpane/engine/wire";
import { describe, expect, it } from "vitest";
import { svgPathData } from "../src/engine/svg-path";

describe("SVG path data for the engine", () => {
  it("reads absolute and relative commands, and further pairs after a move as lines", () => {
    const p = svgPathData("M10 10 20 10 l5 5 h-5 V30 z");
    expect(p.verbs).toEqual([VERB.move, VERB.line, VERB.line, VERB.line, VERB.line, VERB.close]);
    expect(p.coords).toEqual([10, 10, 20, 10, 25, 15, 20, 15, 20, 30]);
  });

  it("turns smooth curves and arcs into curves", () => {
    const p = svgPathData(
      "M0 0 C10 0 20 10 20 20 S30 40 40 40 Q50 40 50 50 T60 60 A10 10 0 0 1 80 60",
    );
    expect(p.verbs.filter((v) => v === VERB.cubic).length).toBeGreaterThanOrEqual(3);
    // S reflects the last control point: (20, 20) - (20, 10) + (20, 20) = (20, 30).
    expect(p.coords.slice(8, 10)).toEqual([20, 30]);
    expect(p.coords.at(-2)).toBeCloseTo(80);
  });

  it("starts a new subpath where a closed one began, as a canvas does", () => {
    const p = svgPathData("M5 5 L10 5 L10 10 Z L0 10");
    expect(p.verbs).toEqual([VERB.move, VERB.line, VERB.line, VERB.close, VERB.move, VERB.line]);
    expect(p.coords.slice(6, 8)).toEqual([5, 5]);
  });

  it("stops at the first error, keeping what came before", () => {
    const p = svgPathData("M0 0 L10 10 L20 x L30 30");
    expect(p.verbs).toEqual([VERB.move, VERB.line]);
    expect(svgPathData("L10 10").empty).toBe(true);
  });
});
