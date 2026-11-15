import { type NodeRecord, type Props, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { autoSize, layoutText, type TextMeasurer, textBlockOffset } from "../src/text";

/** Half an em a character; ascent 0.8 em, descent 0.2, capitals 0.7 em tall. */
const measurer: TextMeasurer = {
  width: (font, text) => text.length * (Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16) / 2),
  metrics: (font) => {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
    return { ascent: size * 0.8, descent: size * 0.2, capHeight: size * 0.7 };
  },
};

const text = (characters: string, props: Partial<Props> = {}): NodeRecord =>
  ({
    id: "t",
    type: "text",
    parent: ROOT_ID,
    key: "a0",
    props: { characters, fontSize: 20, ...props } as Props,
  }) as NodeRecord;

describe("vertical trim (cap height to baseline)", () => {
  it("starts the box at the first line's capitals and ends it at the last line's baseline", () => {
    // 30 px lines of 20 px type: the first baseline 5 (half the leading) + 16 down.
    const props = { lineHeight: { unit: "px", value: 30 } } as Partial<Props>;
    const standard = layoutText(text("One\nTwo", props), measurer, null);
    expect(standard.lines.map((l) => l.baseline)).toEqual([21, 51]);
    expect(standard.height).toBe(60);

    const trimmed = layoutText(
      text("One\nTwo", { ...props, leadingTrim: "cap-height" }),
      measurer,
      null,
    );
    // Moved up by what's above the capitals: 21 − 14.
    expect(trimmed.lines.map((l) => l.baseline)).toEqual([14, 44]);
    expect(trimmed.lines.map((l) => l.top)).toEqual([-7, 23]);
    // The lines keep their spacing; the box ends at the last baseline.
    expect(trimmed.height).toBe(44);
  });

  it("is one line's cap height for a single line, whatever its line height", () => {
    for (const lineHeight of [
      { unit: "auto" },
      { unit: "percent", value: 150 },
      { unit: "px", value: 64 },
    ])
      expect(
        layoutText(
          text("Hi", { lineHeight, leadingTrim: "cap-height" } as Partial<Props>),
          measurer,
          null,
        ).height,
      ).toBeCloseTo(14, 6);
  });

  it("trims to the tallest capitals on the first line", () => {
    const node = text("Big small", {
      leadingTrim: "cap-height",
      textRuns: [{ start: 0, end: 3, fontSize: 40 }],
    } as Partial<Props>);
    const { lines, height } = layoutText(node, measurer, null);
    expect(lines[0]?.baseline).toBeCloseTo(28, 6);
    expect(height).toBeCloseTo(28, 6);
  });

  it("sizes an auto-height box to the trim, and aligns the trimmed block in a fixed one", () => {
    const node = text("One two three four", {
      leadingTrim: "cap-height",
      textAutoResize: "height",
      width: 100,
    } as Partial<Props>);
    // 10 characters a line: two lines, 20 apart (auto line height is 1 em here).
    expect(autoSize(node, measurer)).toEqual({ width: 100, height: 14 + 20 });

    const fixed = text("Hi", {
      leadingTrim: "cap-height",
      textAutoResize: "none",
      textAlignVertical: "middle",
      height: 40,
    } as Partial<Props>);
    expect(textBlockOffset(fixed, layoutText(fixed, measurer, 100))).toBeCloseTo(13, 6);
  });

  it("stands in a typical cap height when the font's isn't known", () => {
    const blind: TextMeasurer = { width: measurer.width };
    const node = text("Hi", { leadingTrim: "cap-height" } as Partial<Props>);
    expect(layoutText(node, blind, null).height).toBeCloseTo(14, 6);
  });

  it("changes nothing when off", () => {
    const a = layoutText(text("One\nTwo"), measurer, null);
    const b = layoutText(
      text("One\nTwo", { leadingTrim: "none" } as Partial<Props>),
      measurer,
      null,
    );
    expect(b.lines.map((l) => l.baseline)).toEqual(a.lines.map((l) => l.baseline));
    expect(b.height).toBe(a.height);
  });
});
