/**
 * The bound culling uses for type running past a fixed-size text box
 * (`textOverflow`), held against the real layout with real fonts: whatever
 * the text, size, box and spacing, the laid-out lines never reach further
 * past the box than the bound says.
 */
import { readFileSync } from "node:fs";
import type { NodeRecord } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type FaceFileLoader, HarfBuzzMeasurer } from "../src/harfbuzz-measurer";
import { textOverflow } from "../src/reach";
import { layoutText } from "../src/text";

const fixture = (name: string) => {
  const b = readFileSync(new URL(`../../../apps/web/e2e/fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const INTER = fixture("Inter-Variable.ttf");
const loader: FaceFileLoader = async (face) => (face.family === "Inter" ? INTER : null);

const WORDS = ["a", "it", "Wow", "MMMM", "settings", "WWWWWWWWWW", "日本語", "🙂", "1234567890"];

describe("how far fixed-size type can run past its box", { timeout: 60_000 }, () => {
  it("is never less than the real layout's", async () => {
    const measurer = new HarfBuzzMeasurer(loader);
    await measurer.load([
      { family: "Inter", weight: 400, italic: false, canvas: true },
      { family: "Inter", weight: 700, italic: false, canvas: true },
    ]);
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...WORDS, "\n"), { minLength: 1, maxLength: 120 }),
        fc.integer({ min: 4, max: 96 }),
        fc.integer({ min: 1, max: 600 }),
        fc.integer({ min: 1, max: 200 }),
        fc.oneof(
          fc.constant({ unit: "auto" as const }),
          fc.record({
            unit: fc.constant("percent" as const),
            value: fc.integer({ min: 50, max: 300 }),
          }),
          fc.record({ unit: fc.constant("px" as const), value: fc.integer({ min: 1, max: 200 }) }),
        ),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 40 }),
        (words, fontSize, width, height, lineHeight, letterSpacing, paragraphSpacing) => {
          const node = {
            id: "T",
            type: "text",
            parent: "P",
            key: "a0",
            props: {
              characters: words.join(" "),
              fontFamily: "Inter",
              fontSize,
              width,
              height,
              lineHeight,
              letterSpacing: { unit: "px", value: letterSpacing },
              paragraphSpacing,
              textAutoResize: "none",
            },
          } as unknown as NodeRecord;
          const laid = layoutText(node, measurer, width);
          const bound = textOverflow(node);
          expect(Math.max(0, laid.height - height)).toBeLessThanOrEqual(bound + 0.5);
          const widest = Math.max(0, ...laid.lines.map((l) => l.width));
          expect(Math.max(0, widest - width)).toBeLessThanOrEqual(bound + 0.5);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("is nothing for text that sizes itself", () => {
    const node = (textAutoResize: string) =>
      ({
        id: "T",
        type: "text",
        parent: "P",
        key: "a0",
        props: { characters: "x ".repeat(500), width: 10, height: 10, textAutoResize },
      }) as unknown as NodeRecord;
    expect(textOverflow(node("height"))).toBe(0);
    expect(textOverflow(node("width"))).toBe(0);
    expect(textOverflow(node("none"))).toBeGreaterThan(0);
  });
});
