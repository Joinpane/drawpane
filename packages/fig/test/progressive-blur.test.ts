import { Blur } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { convertEffect as convertRest } from "../../figma/src/effects";
import { Notes } from "../../figma/src/notes";
import { FigNotes } from "../src/notes";
import { convertEffect as convertFig } from "../src/paint";

describe("progressive blur conversion and backwards-compatible storage", () => {
  const offsets = { startOffset: { x: 0.5, y: 1 }, endOffset: { x: 0.5, y: 0 } };
  const graph = { type: "BACKGROUND_BLUR", radius: 10 } as Parameters<typeof convertFig>[0];

  it("keeps raw progressive endpoints in the display model", () => {
    const input = {
      type: "BACKGROUND_BLUR",
      blurOpType: "PROGRESSIVE",
      radius: 10,
      startRadius: 0,
      ...offsets,
    };
    const adapted = convertFig(graph, input, new FigNotes());
    expect(adapted).toEqual({
      type: "BACKGROUND_BLUR",
      radius: 10,
      blurType: "PROGRESSIVE",
      startRadius: 0,
      ...offsets,
    });
    const model = adapted && convertRest(adapted, new Notes());
    expect(Blur.parse(model)).toEqual({
      type: "background-blur",
      radius: 10,
      blurType: "progressive",
      startRadius: 0,
      ...offsets,
    });
  });

  it("uses uniform blur for legacy, NORMAL, and incomplete progressive inputs", () => {
    const legacy = { type: "background-blur", radius: 10 };
    expect(Blur.parse(legacy)).toEqual(legacy);

    const rawNormal = {
      type: "BACKGROUND_BLUR",
      blurOpType: "NORMAL",
      radius: 10,
      startRadius: 20,
      ...offsets,
    };
    const adapted = convertFig(graph, rawNormal, new FigNotes());
    expect(adapted && convertRest(adapted, new Notes())).toEqual(legacy);

    const notes = new Notes();
    expect(
      convertRest({ type: "BACKGROUND_BLUR", radius: 10, blurType: "PROGRESSIVE" }, notes),
    ).toEqual(legacy);
    expect(notes.entries().some(([kind]) => kind === "blur-progressive")).toBe(true);
  });
});
