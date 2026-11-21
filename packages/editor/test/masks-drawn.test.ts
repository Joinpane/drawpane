/**
 * Masks drawn by the SVG export, as Figma draws
 * them: what each kind of mask lets show, which layers it reaches, and
 * masks made of a group, a text, a line, turned, or alone. The canvas draws
 * the same scopes (masks.ts) and is checked against it in
 * `apps/web/e2e/masks.spec.ts`.
 */
import { readFileSync } from "node:fs";
import { type Op, ROOT_ID } from "@drawpane/model";
import { nodeRasteriser, type ResvgRasteriser } from "@drawpane/raster/node";
import { beforeAll, describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import type { TextMeasurer } from "../src/text";
import { rasterSvg } from "./fixtures/svg-raster";

const measurer: TextMeasurer = {
  width: (font, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16) * 0.6,
};
const font = readFileSync(
  new URL("../../raster/test/fixtures/InstrumentSans-Regular.ttf", import.meta.url),
);
const solid = (color: string) => [{ type: "solid" as const, color }];
const WHITE = [255, 255, 255];
const BLUE = [0, 0, 255];
const GREEN = [0, 255, 0];

let rasteriser: ResvgRasteriser;
beforeAll(async () => {
  rasteriser = await nodeRasteriser();
});

type Layer = [id: string, type: string, props: Record<string, unknown>, parent?: string];

/** The page drawn over white at 1×, from its origin (a white backdrop pins it at 0, 0). */
async function draw(layers: Layer[], size = 240) {
  const d = new Doc();
  d.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "P" } },
    {
      op: "create",
      id: "bg",
      type: "rect",
      parent: "p",
      key: "a0",
      props: { x: 0, y: 0, width: size, height: size, fills: solid("#ffffff") },
    },
    ...layers.map(
      ([id, type, props, parent], i) =>
        ({
          op: "create",
          id,
          type,
          parent: parent ?? "p",
          key: `a${String(i + 1).padStart(3, "0")}`,
          props,
        }) as Op,
    ),
  ]);
  const px = rasterSvg(d, "p", measurer, rasteriser, { background: "#ffffff", fonts: [font] });
  const at = (x: number, y: number) => [
    ...px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 3),
  ];
  /** How many pixels in a box are near a colour. */
  const count = (box: { x: number; y: number; w: number; h: number }, color: number[]) => {
    let n = 0;
    for (let y = box.y; y < box.y + box.h; y++)
      for (let x = box.x; x < box.x + box.w; x++)
        if (at(x, y).every((c, i) => Math.abs(c - (color[i] ?? 0)) < 40)) n++;
    return n;
  };
  return { at, count };
}

describe("masks, drawn", () => {
  it("leave a clipping frame above their scope whole: a popover's card shows", async () => {
    // A large iOS UI kit's popover: an arrow under the card masks the material over it; the
    // card's background (a frame clipping its content) ends the mask and shows whole.
    const { at } = await draw([
      ["pop", "frame", { x: 0, y: 0, width: 200, height: 200, clipContent: false, fills: [] }],
      [
        "arrow",
        "rect",
        {
          x: 72,
          y: 200,
          width: 56,
          height: 13,
          flipX: true,
          isMask: true,
          maskType: "alpha",
          fills: solid("#ff0000"),
        },
        "pop",
      ],
      ["material", "group", {}, "pop"],
      [
        "fill",
        "rect",
        { x: 40, y: 200, width: 120, height: 13, fills: solid("#0000ff") },
        "material",
      ],
      [
        "background",
        "frame",
        { x: 0, y: 0, width: 200, height: 200, fills: solid("#00ff00") },
        "pop",
      ],
    ]);
    expect(at(100, 100)).toEqual(GREEN);
    expect(at(10, 10)).toEqual(GREEN);
    // The material shows inside the arrow only.
    expect(at(100, 206)).toEqual(BLUE);
    expect(at(50, 206)).toEqual(WHITE);
  });

  it("mask by a turned layer's own outline", async () => {
    // A square turned 45°: the blue square above shows as a diamond.
    const { at } = await draw([
      ["f", "frame", { x: 0, y: 0, width: 200, height: 200, fills: [] }],
      [
        "m",
        "rect",
        {
          x: 50,
          y: 50,
          width: 100,
          height: 100,
          rotation: 45,
          isMask: true,
          maskType: "alpha",
          fills: solid("#000000"),
        },
        "f",
      ],
      ["over", "rect", { x: 0, y: 0, width: 200, height: 200, fills: solid("#0000ff") }, "f"],
    ]);
    expect(at(100, 100)).toEqual(BLUE);
    expect(at(100, 35)).toEqual(BLUE); // the diamond's top, past the square's own box
    expect(at(55, 55)).toEqual(WHITE); // the square's corner, cut off by the turn
  });

  it("mask by a group's luminance: white shows, black hides", async () => {
    const { at } = await draw([
      ["icon", "group", {}],
      ["shape", "group", { isMask: true, maskType: "luminance" }, "icon"],
      [
        "white",
        "rect",
        { x: 20, y: 20, width: 100, height: 100, fills: solid("#ffffff") },
        "shape",
      ],
      ["black", "rect", { x: 50, y: 50, width: 40, height: 40, fills: solid("#000000") }, "shape"],
      ["ink", "rect", { x: 0, y: 0, width: 140, height: 140, fills: solid("#0000ff") }, "icon"],
    ]);
    expect(at(30, 30)).toEqual(BLUE);
    expect(at(70, 70)).toEqual(WHITE);
    expect(at(130, 130)).toEqual(WHITE);
  });

  it("mask by a group's outline: every layer in it, opaque", async () => {
    const { at } = await draw([
      ["g", "group", {}],
      ["shape", "group", { isMask: true, maskType: "outline" }, "g"],
      [
        "dot",
        "ellipse",
        { x: 20, y: 20, width: 100, height: 100, fills: solid("#00000033") },
        "shape",
      ],
      ["ink", "rect", { x: 0, y: 0, width: 140, height: 140, fills: solid("#0000ff") }, "g"],
    ]);
    // Inside the dot, the ink shows fully, though the dot is mostly see-through.
    expect(at(70, 70)).toEqual(BLUE);
    expect(at(22, 22)).toEqual(WHITE); // the dot's box corner
  });

  it("mask by a text's glyphs", async () => {
    const { at, count } = await draw([
      ["f", "frame", { x: 0, y: 0, width: 200, height: 100, fills: [] }],
      [
        "label",
        "text",
        {
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          characters: "HHH",
          fontFamily: "Instrument Sans",
          fontSize: 80,
          lineHeight: { unit: "px", value: 100 },
          textAutoResize: "none",
          fills: solid("#000000"),
          isMask: true,
          maskType: "alpha",
        },
        "f",
      ],
      ["tint", "rect", { x: 0, y: 0, width: 200, height: 100, fills: solid("#0000ff") }, "f"],
    ]);
    const blue = count({ x: 0, y: 0, w: 200, h: 100 }, BLUE);
    // Some of the box shows the tint (the letters), most of it not.
    expect(blue).toBeGreaterThan(400);
    expect(blue).toBeLessThan(200 * 100 * 0.6);
    expect(at(1, 1)).toEqual(WHITE);
  });

  it("mask by a line's stroke", async () => {
    const { count } = await draw([
      ["f", "frame", { x: 0, y: 0, width: 200, height: 100, fills: [] }],
      [
        "l",
        "line",
        {
          x: 0,
          y: 50,
          width: 200,
          height: 0,
          strokes: solid("#000000"),
          strokeWeight: 10,
          strokeAlign: "center",
          isMask: true,
          maskType: "alpha",
        },
        "f",
      ],
      ["tint", "rect", { x: 0, y: 0, width: 200, height: 100, fills: solid("#0000ff") }, "f"],
    ]);
    // A band 10 high across the frame: about 2,000 pixels of tint, not 20,000.
    const blue = count({ x: 0, y: 0, w: 200, h: 100 }, BLUE);
    expect(blue).toBeGreaterThan(1500);
    expect(blue).toBeLessThan(2600);
  });

  it("draw nothing when alone: a mask with nothing above it isn't drawn", async () => {
    const { at } = await draw([
      ["f", "frame", { x: 0, y: 0, width: 100, height: 100, fills: [] }],
      [
        "m",
        "rect",
        { x: 0, y: 0, width: 100, height: 100, isMask: true, fills: solid("#0000ff") },
        "f",
      ],
    ]);
    expect(at(50, 50)).toEqual(WHITE);
  });
});
