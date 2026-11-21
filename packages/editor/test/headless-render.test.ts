import { readFileSync } from "node:fs";
import { ErrorCode } from "@drawpane/engine";
import { built } from "@drawpane/engine/node";
import { type Paint, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { ENGINE_EMOJI_FACE } from "../src/color-emoji";
import { Doc } from "../src/doc";
import { HarfBuzzMeasurer, measuredFaces } from "../src/harfbuzz-measurer";
import { headlessEngine } from "./fixtures/engine-raster";
import { enginePngColors, enginePngPixel, solidPng } from "./fixtures/png";

function picture(fills: Paint[]) {
  const doc = new Doc();
  doc.apply([
    { op: "create", id: "p", parent: ROOT_ID, type: "page", key: "a0", props: {} },
    {
      op: "create",
      id: "r",
      parent: "p",
      type: "rect",
      key: "a0",
      props: { width: 100, height: 80, fills },
    },
  ]);
  return doc;
}

const measure = { width: () => 0 };
const large = "a".repeat(64);
const missing = "b".repeat(64);

describe.skipIf(!built())("the capped headless PNG renderer", () => {
  it("draws a layer or page at the requested scale", async () => {
    const doc = picture([{ type: "solid", color: "#3366cc" }]);
    const renderer = headlessEngine(measure);
    const layer = await renderer.renderPng(doc, "r", { scale: 2, background: "white" });
    const page = await renderer.renderPng(doc, "p", { scale: 2, background: "white" });
    expect(layer).toEqual(page);
    expect(layer).toMatchObject({ width: 200, height: 160, scale: 2, approximate: [] });
    expect(enginePngPixel(layer.png, 50, 50)).toEqual([51, 102, 204, 255]);
  });

  it("uses the visible Han text's fixed slices for the requested locale", async () => {
    const fixture = readFileSync(new URL("./fixtures/NotoSansSC-Subset.ttf", import.meta.url));
    const bytes = Uint8Array.from(fixture).buffer;
    const requested: string[] = [];
    const measurer = new HarfBuzzMeasurer(
      async (face) => {
        if (face.subset) requested.push(`${face.family}/${face.subset}`);
        return face.family === "Noto Sans JP" ? bytes : null;
      },
      { scriptLocale: "ja-JP" },
    );
    const doc = picture([]);
    doc.apply([
      {
        op: "create",
        id: "shown",
        parent: "p",
        type: "text",
        key: "a1",
        props: {
          characters: "漢中漢",
          fontFamily: "Missing",
          fontSize: 24,
          textAutoResize: "none",
          width: 90,
          height: 42,
        },
      },
      {
        op: "create",
        id: "hidden",
        parent: "p",
        type: "text",
        key: "a2",
        props: { characters: "日", visible: false },
      },
    ]);
    const renderer = headlessEngine(measurer, {
      async prepareFonts(nodes) {
        await measurer.load(measuredFaces(nodes));
      },
    });
    const result = await renderer.renderPng(doc, "p");
    expect(requested).toEqual(["Noto Sans JP/4e00", "Noto Sans JP/6f00"]);
    expect(measurer.approximations.some((face) => face.reason === "glyphs")).toBe(false);
    expect(result.fallbackText).toBe(true);
    expect(result.png.length).toBeGreaterThan(200);
  });

  it("rasterises the bundled colour outlines at export scale", async () => {
    const fixture = readFileSync(new URL("../assets/Twemoji_GlyfColr0.ttf", import.meta.url));
    const bytes = Uint8Array.from(fixture).buffer;
    const renderer = headlessEngine(
      new HarfBuzzMeasurer(async (face) =>
        face.family === ENGINE_EMOJI_FACE.family ? bytes : null,
      ),
    );
    const doc = picture([]);
    doc.apply([
      {
        op: "create",
        id: "emoji",
        parent: "p",
        type: "text",
        key: "a1",
        props: {
          characters: "👩🏽‍🔬",
          fontFamily: "Missing",
          fontSize: 42,
          textAutoResize: "none",
          width: 60,
          height: 60,
        },
      },
    ]);

    const out = await renderer.renderPng(doc, "emoji", { scale: 24 });
    expect(out).toMatchObject({ scale: 24, width: 1440, height: 1440 });
    expect(enginePngColors(out.png, 7)).toBe(7);
  }, 20_000);

  it("decodes a large image at its drawn size and reports when tiling needs a smaller level", async () => {
    const doc = picture([{ type: "image", ref: large, scaleMode: "fill" }]);
    const rgba = [35, 101, 170, 255];
    const file = {
      bytes: solidPng(2000, 2000, rgba),
      type: "image/png",
      width: 2000,
      height: 2000,
    };
    const renderer = headlessEngine(measure, { images: async () => file });
    const image = await renderer.renderPng(doc, "r", { scale: 1 });
    expect(image).toMatchObject({ missingImages: [], skippedImages: [], approximate: [] });
    expect(image.reducedImages).toBeUndefined();
    expect(enginePngPixel(image.png, 50, 40)).toEqual(rgba);
    doc.apply([
      {
        op: "set",
        id: "r",
        prop: "fills",
        value: [{ type: "image", ref: large, scaleMode: "tile" }],
      },
    ]);
    const tiled = await renderer.renderPng(doc, "r", { scale: 1 });
    expect(tiled.reducedImages).toEqual([large]);
    expect(enginePngPixel(tiled.png, 50, 40)).toEqual(rgba);
  }, 30_000);

  it("reports missing images and uses a placeholder when the encoded file exceeds the budget", async () => {
    const doc = picture([
      { type: "image", ref: missing, scaleMode: "fill" },
      { type: "image", ref: large, scaleMode: "fill" },
    ]);
    const renderer = headlessEngine(measure, {
      images: async (ref) => (ref === large ? "too-large" : null),
    });
    const result = await renderer.renderPng(doc, "p");
    expect(result.missingImages).toEqual([missing]);
    expect(result.skippedImages).toEqual([large]);
    expect(enginePngPixel(result.png, 50, 40)[3]).toBe(255);
  });

  it("refuses an unsupported effect before starting the stream", async () => {
    const doc = picture([{ type: "solid", color: "#3366cc" }]);
    doc.apply([
      {
        op: "set",
        id: "r",
        prop: "effects",
        value: [
          {
            type: "layer-blur",
            blurType: "progressive",
            startRadius: 2,
            radius: 12,
            startOffset: { x: 0, y: 0 },
            endOffset: { x: 1, y: 1 },
          },
        ],
      },
    ]);
    const renderer = headlessEngine(measure);
    await expect(renderer.renderPngStream(doc, "r")).rejects.toMatchObject({
      code: ErrorCode.Unsupported,
    });
  });
});
