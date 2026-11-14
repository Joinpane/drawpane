import { Doc } from "@drawpane/editor";
import { ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import {
  backdropOf,
  colorAt,
  convertPaint,
  documentColors,
  gradientAngle,
  handlesForAngle,
  solidPickerValue,
  withPickerValue,
} from "./paint";
import { replaceColorOps, selectionColors } from "./selection-colors";
import { parseLetterSpacing, parseLineHeight } from "./TypographyFields";

describe("gradient angles", () => {
  it.each([0, 45, 90, 135, 180, 270])("round-trips %i°", (angle) => {
    expect(gradientAngle(handlesForAngle(angle))).toBe(angle);
  });

  it("puts 180° from top to bottom", () => {
    expect(handlesForAngle(180)).toEqual({ from: { x: 0.5, y: 0 }, to: { x: 0.5, y: 1 } });
  });
});

describe("paint conversions", () => {
  it("moves a solid's alpha into opacity for the picker, and back", () => {
    const paint = { type: "solid" as const, color: "#ff000080", opacity: 0.5 };
    expect(solidPickerValue(paint)).toBe("#ff000040");
    expect(withPickerValue(paint, "#00ff00cc")).toEqual({
      type: "solid",
      color: "#00ff00",
      opacity: 0.8,
    });
    expect(withPickerValue(paint, "#0000ff")).toEqual({ type: "solid", color: "#0000ff" });
  });

  it("starts a gradient from a color fading out, and comes back to its first stop", () => {
    const gradient = convertPaint({ type: "solid", color: "#2b4fd6", visible: false }, "linear");
    expect(gradient).toMatchObject({
      type: "linear",
      visible: false,
      stops: [
        { position: 0, color: "#2b4fd6" },
        { position: 1, color: "#2b4fd600" },
      ],
    });
    expect(convertPaint(gradient, "solid")).toEqual({
      type: "solid",
      color: "#2b4fd6",
      visible: false,
    });
    expect(convertPaint(gradient, "radial")).toMatchObject({
      type: "radial",
      from: { x: 0.5, y: 0.5 },
    });
  });

  it("finds the color between two stops", () => {
    const paint = {
      type: "linear" as const,
      ...handlesForAngle(90),
      stops: [
        { position: 0, color: "#000000" },
        { position: 1, color: "#ffffff" },
      ],
    };
    expect(colorAt(paint, 0.5)).toBe("#808080");
    expect(colorAt(paint, -1)).toBe("#000000");
  });
});

function doc() {
  const d = new Doc();
  d.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    {
      op: "create",
      id: "card",
      type: "frame",
      parent: "p",
      key: "a0",
      props: { fills: [{ type: "solid", color: "#1c1b1a" }] },
    },
    {
      op: "create",
      id: "title",
      type: "text",
      parent: "card",
      key: "a0",
      props: { fills: [{ type: "solid", color: "#ffffff" }] },
    },
    {
      op: "create",
      id: "chip",
      type: "rect",
      parent: "card",
      key: "a1",
      props: {
        fills: [{ type: "solid", color: "#ffffff" }],
        effects: [{ type: "drop-shadow", color: "#00000040", x: 0, y: 2, blur: 4, spread: 0 }],
      },
    },
  ]);
  return d;
}

describe("colors in a file", () => {
  it("lists the page's colors, most used first", () => {
    expect(documentColors(doc(), "p")).toEqual(["#ffffff", "#00000040", "#1c1b1a"]);
  });

  it("finds the backdrop behind a layer through its frames", () => {
    const d = doc();
    const title = d.get("title");
    expect(title && backdropOf(d, title)?.color).toEqual({ r: 28, g: 27, b: 26, a: 1 });
  });

  it("lists selection colors and replaces one everywhere", () => {
    const d = doc();
    expect(selectionColors(d, ["card"])).toEqual([
      { color: "#ffffff", layers: 2 },
      { color: "#1c1b1a", layers: 1 },
      { color: "#00000040", layers: 1 },
    ]);
    const ops = replaceColorOps(d, ["card"], "#ffffff", "#ff5a1f");
    expect(ops.map((o) => o.id)).toEqual(["title", "chip"]);
  });
});

describe("typed text values", () => {
  it.each([
    ["Auto", { unit: "auto" }],
    ["24", { unit: "px", value: 24 }],
    ["150%", { unit: "percent", value: 150 }],
    ["12*2", { unit: "px", value: 24 }],
    ["tall", null],
  ])("line height %s", (text, expected) => {
    expect(parseLineHeight(text)).toEqual(expected);
  });

  it.each([
    ["-0.5", { unit: "px", value: -0.5 }],
    ["2%", { unit: "percent", value: 2 }],
    ["", { unit: "px", value: 0 }],
  ])("letter spacing %s", (text, expected) => {
    expect(parseLetterSpacing(text)).toEqual(expected);
  });
});
