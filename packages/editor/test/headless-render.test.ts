import { readFileSync } from "node:fs";
import { DEFAULT_GLASS, type Op, ROOT_ID } from "@drawpane/model";
import type { Face, ResvgRasteriser } from "@drawpane/raster";
import { nodeRasteriser } from "@drawpane/raster/node";
import { beforeAll, describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import {
  approximations,
  base64,
  createHeadlessRenderer,
  facesUsed,
  type ImageFile,
} from "../src/headless-render";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = {
  width: (font, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16) * 0.5,
};
const font = readFileSync(
  new URL("../../raster/test/fixtures/InstrumentSans-Regular.ttf", import.meta.url),
);
const SHA = "c".repeat(64);
// A 1×1 blue PNG.
const BLUE = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
  ),
  (c) => c.charCodeAt(0),
);

function doc(ops: Op[]): Doc {
  const d = new Doc();
  d.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page 1" } },
    ...ops,
  ]);
  return d;
}
const layer = (id: string, type: string, props: Record<string, unknown>, parent = "p"): Op =>
  ({
    op: "create",
    id,
    type,
    parent,
    key: `a${id}`,
    props: { x: 0, y: 0, width: 10, height: 10, ...props },
  }) as Op;

let rasteriser: ResvgRasteriser;
beforeAll(async () => {
  rasteriser = await nodeRasteriser();
});

/** A renderer whose loaders record what they were asked for. */
function renderer(files: { fonts?: string[]; images?: Record<string, ImageFile> } = {}) {
  const asked: { fonts: Face[]; images: string[] } = { fonts: [], images: [] };
  const r = createHeadlessRenderer({
    measurer,
    rasteriser,
    fonts: async (face) => {
      asked.fonts.push(face);
      return (files.fonts ?? ["Instrument Sans"]).includes(face.family)
        ? font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength)
        : null;
    },
    images: async (ref) => {
      asked.images.push(ref);
      return files.images?.[ref] ?? null;
    },
  });
  return { r, asked };
}

describe("renderPng", () => {
  it("draws a layer at the scale asked for, over its background", async () => {
    const d = doc([
      layer("r", "rect", { x: 5, y: 5, fills: [{ type: "solid", color: "#ff0000" }] }),
    ]);
    const { r } = renderer();
    const out = await r.renderPng(d, "r", { scale: 2, background: "#ffffff" });
    expect([out.width, out.height]).toEqual([20, 20]);
    expect(out.bounds).toEqual({ x: 5, y: 5, width: 10, height: 10 });
    expect(out.approximate).toEqual([]);
    const px = rasteriser.pixels(
      `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image width="20" height="20" href="data:image/png;base64,${base64(out.png)}"/></svg>`,
      { scale: 1, fonts: [] },
    );
    expect([...px.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it("draws a page's layers together", async () => {
    const d = doc([
      layer("a", "rect", { fills: [{ type: "solid", color: "#000000" }] }),
      layer("b", "rect", { x: 30, fills: [{ type: "solid", color: "#000000" }] }),
    ]);
    const out = await renderer().r.renderPng(d, "p");
    expect([out.width, out.height]).toEqual([40, 10]);
  });

  it("supplies the text's faces, and the fallback for a family without files", async () => {
    const d = doc([
      layer("t", "text", {
        characters: "Hello there",
        fontFamily: "Fraunces",
        fontWeight: 700,
        width: 120,
        height: 20,
        textRuns: [{ start: 0, end: 5, fontFamily: "Instrument Sans", fontStyle: "italic" }],
      }),
    ]);
    const { r, asked } = renderer();
    const out = await r.renderPng(d, "t");
    expect(out.missingFonts).toEqual(["Fraunces 700"]);
    expect(asked.fonts).toContainEqual({ family: "Instrument Sans", weight: 700, italic: true });
    // The fallback stands in at the missing face's weight and style.
    expect(asked.fonts).toContainEqual({ family: "Instrument Sans", weight: 700, italic: false });
    expect(out.png.byteLength).toBeGreaterThan(100);
  });

  it("embeds images, and says which it couldn't have", async () => {
    const missing = "d".repeat(64);
    const d = doc([
      layer("a", "rect", { fills: [{ type: "image", ref: SHA, scaleMode: "fill" }] }),
      layer("b", "rect", { x: 20, fills: [{ type: "image", ref: missing, scaleMode: "fill" }] }),
    ]);
    const { r, asked } = renderer({
      images: { [SHA]: { bytes: BLUE, type: "image/png", width: 1, height: 1 } },
    });
    const out = await r.renderPng(d, "p");
    expect(asked.images.sort()).toEqual([SHA, missing]);
    expect(out.missingImages).toEqual([missing]);
  });

  it("says when effects are approximate", async () => {
    const d = doc([
      layer("g", "rect", { effects: [{ ...DEFAULT_GLASS, type: "glass" }] }),
      layer("b", "rect", { effects: [{ type: "background-blur", radius: 8 }] }),
    ]);
    expect(approximations(d, ["p"])).toEqual(["background-blur", "glass"]);
    expect((await renderer().r.renderPng(d, "g")).approximate).toEqual(["glass"]);
  });

  it("refuses what isn't there and what's too large", async () => {
    const d = doc([
      layer("r", "rect", {
        width: 3000,
        height: 3000,
        fills: [{ type: "solid", color: "#000000" }],
      }),
    ]);
    const { r } = renderer();
    await expect(r.renderPng(d, "nope")).rejects.toThrow("no layer");
    await expect(r.renderPng(d, "r", { scale: 2 })).rejects.toThrow("too large");
    await expect(r.renderPng(d, "r", { scale: 0 })).rejects.toThrow("positive");
  });
});

describe("facesUsed", () => {
  it("lists each face once, from layers and their runs", () => {
    const d = doc([
      layer("f", "frame", {}),
      layer(
        "t",
        "text",
        { characters: "ab", textRuns: [{ start: 0, end: 1, fontWeight: 600 }] },
        "f",
      ),
      layer("u", "text", { characters: "cd" }, "f"),
    ]);
    expect(facesUsed(d, ["f"])).toEqual([
      { family: "Instrument Sans", weight: 400, italic: false },
      { family: "Instrument Sans", weight: 600, italic: false },
    ]);
  });
});
