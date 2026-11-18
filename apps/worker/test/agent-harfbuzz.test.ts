/**
 * The headless engine's real measurer runs here, in workerd: HarfBuzz
 * instantiated from the bundled WebAssembly (agent/harfbuzz.ts), measuring
 * with a font file as the browser's canvas would.
 */
import { describe, expect, it } from "vitest";
import { harfBuzzMeasurer } from "../../agent-runner/src/harfbuzz";
import { STANDIN } from "../../agent-runner/src/measurer";
import ttfUrl from "./fixtures/InstrumentSans-Regular.ttf?inline";

const bytes = async () => (await fetch(ttfUrl)).arrayBuffer();
const FONT = '400 16px "Instrument Sans", "Instrument Sans Variable", system-ui, sans-serif';
const face = { family: "Instrument Sans", weight: 400, italic: false };

describe("the headless measurer in the Worker", () => {
  it("loads HarfBuzz from the bundle and measures text in the face's own file", async () => {
    let asked = 0;
    const measurer = harfBuzzMeasurer(async () => {
      asked++;
      return bytes();
    });
    expect(measurer.has(face)).toBe(false);
    await measurer.load([face]);
    expect(asked).toBeGreaterThan(0);
    expect(measurer.has(face)).toBe(true);
    const hello = measurer.width(FONT, "Hello, world");
    // The font's own advances (the browser parity suite holds them to the canvas), not the
    // stand-in's half an em per character: "i" is narrower than "m".
    expect(hello).toBeGreaterThan(50);
    expect(hello).not.toBeCloseTo(STANDIN.width(FONT, "Hello, world"), 1);
    expect(measurer.width(FONT, "i")).toBeLessThan(measurer.width(FONT, "m") / 2);
    const metrics = measurer.metrics?.(FONT);
    expect(metrics?.ascent).toBeGreaterThan(10);
    expect(metrics?.descent).toBeGreaterThan(2);
  });

  it("measures a face it has no file for in the fallback, without throwing", async () => {
    const measurer = harfBuzzMeasurer(async (f) =>
      f.family === "Instrument Sans" ? bytes() : null,
    );
    const missing = { family: "Nowhere Sans", weight: 400, italic: false };
    await measurer.load([missing]);
    // Known to have no file: ready to measure (in the fallback), not waiting.
    expect(measurer.has(missing)).toBe(true);
    expect(measurer.width('400 16px "Nowhere Sans", system-ui', "Hello")).toBeGreaterThan(20);
  });
});
