import { readFileSync } from "node:fs";
import { DEFAULT_GLASS, type Op, ROOT_ID } from "@drawpane/model";
import type { Face, ResvgRasteriser } from "@drawpane/raster";
import { nodeRasteriser } from "@drawpane/raster/node";
import { RESVG_MAX_BYTES } from "@drawpane/raster/wasm-limits";
import { beforeAll, describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { HarfBuzzMeasurer } from "../src/harfbuzz-measurer";
import {
  approximations,
  base64,
  createHeadlessRenderer,
  FONTS_OUT_OF_MEMORY,
  facesUsed,
  HEADLESS_IMAGE_BYTES,
  type ImageBytesLoader,
  type ImageFile,
  imageCost,
  MIN_HEADLESS_SIDE,
  PICTURE_OUT_OF_MEMORY,
} from "../src/headless-render";
import { bytesPerPixel, RASTER_BASE_BYTES } from "../src/render-memory";
import { Scene } from "../src/scene";
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
function renderer(
  files: { fonts?: string[]; images?: Record<string, ImageFile>; load?: ImageBytesLoader } = {},
) {
  const asked: { fonts: Face[]; images: string[]; rooms: number[] } = {
    fonts: [],
    images: [],
    rooms: [],
  };
  const r = createHeadlessRenderer({
    measurer,
    rasteriser,
    fonts: async (face) => {
      asked.fonts.push(face);
      return (files.fonts ?? ["Instrument Sans"]).includes(face.family)
        ? font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength)
        : null;
    },
    images: async (ref, room) => {
      asked.images.push(ref);
      asked.rooms.push(room);
      if (files.load) return files.load(ref, room);
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

  it("measures and paints a Noto subset for Han text in an unavailable face", async () => {
    const fixture = readFileSync(new URL("./fixtures/NotoSansSC-Subset.ttf", import.meta.url));
    const noto = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);
    const fallback = font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength);
    const requested: Face[] = [];
    const load = async (face: Face) => {
      requested.push(face);
      if (face.family === "Noto Sans SC" && (face.subset === "4e00" || face.subset === "6f00"))
        return noto;
      return face.family === "Instrument Sans" ? fallback : null;
    };
    const shaper = new HarfBuzzMeasurer(load);
    const r = createHeadlessRenderer({
      measurer: shaper,
      rasteriser,
      fonts: load,
      images: async () => null,
    });
    const d = doc([
      layer("shown", "text", {
        characters: "漢中漢",
        fontFamily: "Missing",
        fontSize: 24,
        width: 90,
        height: 42,
      }),
      layer("hidden", "text", { characters: "日", visible: false }),
    ]);
    const out = await r.renderPng(d, "p");
    expect(requested.filter((face) => face.subset).map((face) => face.subset)).toEqual([
      "4e00",
      "6f00",
      "4e00",
      "6f00",
    ]);
    expect(shaper.approximations.some((face) => face.reason === "glyphs")).toBe(false);
    const png = `data:image/png;base64,${base64(out.png)}`;
    const rendered = rasteriser.pixels(
      `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="42"><image width="90" height="42" href="${png}"/></svg>`,
      { scale: 1, fonts: [] },
    );
    expect(
      rendered.data.filter((alpha, index) => index % 4 === 3 && alpha > 0).length,
    ).toBeGreaterThan(300);
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

  it("hands the rasteriser the image's file, not a data: URL in the SVG", async () => {
    const d = doc([
      layer("a", "rect", { fills: [{ type: "image", ref: SHA, scaleMode: "fill" }] }),
    ]);
    const svgs: string[] = [];
    const r = createHeadlessRenderer({
      measurer,
      fonts: async () => null,
      images: async () => ({ bytes: BLUE, type: "image/png", width: 1, height: 1 }),
      rasteriser: {
        rasterise: (svg, options) => {
          svgs.push(svg);
          return rasteriser.rasterise(svg, options);
        },
      },
    });
    const out = await r.renderPng(d, "a");
    expect(svgs.join("")).not.toContain("data:");
    const px = rasteriser.pixels(
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="data:image/png;base64,${base64(out.png)}"/></svg>`,
      { scale: 1, fonts: [] },
    );
    // The middle pixel is the image's blue.
    const middle = (5 * 10 + 5) * 4;
    expect([...px.data.subarray(middle, middle + 4)]).toEqual([0, 0, 255, 255]);
  });

  it("draws a tiled fill's image, carried in its pattern as resvg needs", async () => {
    const d = doc([
      layer("a", "rect", {
        width: 10,
        height: 10,
        fills: [{ type: "image", ref: SHA, scaleMode: "tile" }],
      }),
    ]);
    const svgs: string[] = [];
    const r = createHeadlessRenderer({
      measurer,
      fonts: async () => null,
      images: async () => ({ bytes: BLUE, type: "image/png", width: 1, height: 1 }),
      rasteriser: {
        rasterise: (svg, options) => {
          svgs.push(svg);
          return rasteriser.rasterise(svg, options);
        },
      },
    });
    const out = await r.renderPng(d, "a");
    expect(out.skippedImages).toEqual([]);
    // resvg reads files it's handed only outside patterns: the tile's image is inline.
    expect(svgs.join("")).toMatch(/<pattern[^>]*><image[^>]*href="data:image\/png;base64,/);
    const px = rasteriser.pixels(
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="data:image/png;base64,${base64(out.png)}"/></svg>`,
      { scale: 1, fonts: [] },
    );
    for (const [x, y] of [
      [1, 1],
      [5, 5],
      [8, 3],
    ] as const) {
      const at = (y * 10 + x) * 4;
      expect([...px.data.subarray(at, at + 4)], `${x},${y}`).toEqual([0, 0, 255, 255]);
    }
  });

  it("loads only the images it draws", async () => {
    const hidden = "e".repeat(64);
    const off = "f".repeat(64);
    const d = doc([
      layer("a", "rect", {
        fills: [
          { type: "image", ref: SHA, scaleMode: "fill" },
          { type: "image", ref: hidden, scaleMode: "fill", visible: false },
        ],
      }),
      layer("b", "rect", {
        x: 20,
        visible: false,
        fills: [{ type: "image", ref: off, scaleMode: "fill" }],
      }),
    ]);
    const { r, asked } = renderer({
      images: { [SHA]: { bytes: BLUE, type: "image/png", width: 1, height: 1 } },
    });
    await r.renderPng(d, "p");
    expect(asked.images).toEqual([SHA]);
  });

  it("skips images past what a render may hold, before reading them, and draws the rest", async () => {
    // The review's shape (#173): 32 image fills of 4 MiB files on a 100 × 100 rectangle.
    const refs = Array.from({ length: 32 }, (_, i) => String(i).padStart(64, "0"));
    const d = doc([
      layer("r", "rect", {
        width: 100,
        height: 100,
        fills: refs.map((ref) => ({ type: "image", ref, scaleMode: "fill" })),
      }),
    ]);
    const size = 4 << 20;
    const cost = imageCost(size, 1, 1);
    let read = 0;
    const { r, asked } = renderer({
      // As the Worker's loader does: the size is known before the file is read.
      load: async (_ref, room) => {
        if (cost > room) return "too-large";
        read++;
        return { bytes: new Uint8Array(size), type: "image/png", width: 1, height: 1 };
      },
    });
    const out = await r.renderPng(d, "r");
    // What images may hold: HEADLESS_IMAGE_BYTES at most, and less than resvg's capped memory,
    // which the picture needs room in too.
    const budget = asked.rooms[0] ?? 0;
    expect(budget).toBeLessThanOrEqual(HEADLESS_IMAGE_BYTES);
    expect(budget).toBeLessThan(RESVG_MAX_BYTES - RASTER_BASE_BYTES);
    const fit = Math.floor(budget / cost);
    expect(read).toBe(fit);
    // One at a time, each asked with what's left; those past it are asked and not read.
    expect(asked.rooms[1]).toBe(budget - cost);
    expect(asked.images.length).toBe(32);
    expect(out.skippedImages).toEqual(refs.slice(fit));
    expect(out.missingImages).toEqual([]);
  });

  it("draws a photo too large to decode as a marked placeholder, and the rest as they are", async () => {
    // The review's shape (#173): a 4000 × 3000 photo on an otherwise small frame, at scale 0.05.
    const d = doc([
      layer("f", "frame", {
        width: 200,
        height: 100,
        fills: [{ type: "solid", color: "#ff0000" }],
      }),
      layer(
        "photo",
        "rect",
        { width: 100, height: 100, fills: [{ type: "image", ref: SHA, scaleMode: "fill" }] },
        "f",
      ),
    ]);
    const { r } = renderer({
      // A 12-megapixel photo: 48 MB decoded.
      images: { [SHA]: { bytes: BLUE, type: "image/png", width: 4000, height: 3000 } },
    });
    const small = await r.renderPng(d, "f", { scale: 0.05 });
    expect(small.skippedImages).toEqual([SHA]);
    const out = await r.renderPng(d, "f", { scale: 1 });
    expect(out.skippedImages).toEqual([SHA]);
    expect(out.missingImages).toEqual([]);
    const px = rasteriser.pixels(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><image width="200" height="100" href="data:image/png;base64,${base64(out.png)}"/></svg>`,
      { scale: 1, fonts: [] },
    );
    const at = (x: number, y: number) => [
      ...px.data.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 4),
    ];
    // The frame's own red is drawn beside it; the photo's box is a neutral grey, crossed.
    expect(at(150, 50)).toEqual([255, 0, 0, 255]);
    expect(at(80, 20)).toEqual([229, 229, 229, 255]);
    const diagonal = at(50, 50);
    expect(diagonal[0]).toBeLessThan(229);
    expect(diagonal[0]).toBe(diagonal[2]);
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

describe("renderPng in the rasteriser's capped memory", () => {
  /** A 2000 × 2000 frame with a child as large casting a shadow: 107 MiB at 2048 px, measured. */
  const shadowed = () =>
    doc([
      layer("f", "frame", { width: 2000, height: 2000 }),
      layer(
        "c",
        "frame",
        {
          width: 2000,
          height: 2000,
          fills: [{ type: "solid", color: "#ff0000" }],
          effects: [{ type: "drop-shadow", x: 0, y: 4, blur: 16, spread: 0, color: "#00000040" }],
        },
        "f",
      ),
    ]);

  it("draws a picture too large for it at the largest scale that fits, and says so", async () => {
    const d = shadowed();
    const out = await renderer().r.renderPng(d, "f", { scale: 1 });
    expect(out.reduced).toEqual({ width: 2000, height: 2000, scale: 1 });
    expect(out.scale).toBeLessThan(1);
    expect(out.width).toBe(out.height);
    expect(out.width).toBeGreaterThanOrEqual(MIN_HEADLESS_SIDE);
    // The largest that fits: what it's estimated to hold is inside the cap, and not far inside.
    const held = (w: number) =>
      RASTER_BASE_BYTES + bytesPerPixel(new Scene(d), ["f"], out.bounds) * w * w;
    expect(held(out.width)).toBeLessThanOrEqual(RESVG_MAX_BYTES);
    expect(held(Math.ceil(out.width * 1.03))).toBeGreaterThan(RESVG_MAX_BYTES);
    const px = rasteriser.pixels(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${out.width}" height="${out.height}"><image width="${out.width}" height="${out.height}" href="data:image/png;base64,${base64(out.png)}"/></svg>`,
      { scale: 1, fonts: [] },
    );
    const mid = (Math.floor(out.height / 2) * out.width + Math.floor(out.width / 2)) * 4;
    expect([...px.data.subarray(mid, mid + 4)]).toEqual([255, 0, 0, 255]);
  });

  it("draws one that fits as asked, and says nothing", async () => {
    const out = await renderer().r.renderPng(shadowed(), "f", { scale: 0.25 });
    expect(out.reduced).toBeUndefined();
    expect([out.width, out.scale]).toEqual([500, 0.25]);
  });

  /** A renderer over the real rasteriser that fails as resvg does past its cap, as `fail` says. */
  function trapping(fail: (call: number) => boolean, memory?: number) {
    const scales: number[] = [];
    const r = createHeadlessRenderer({
      measurer,
      fonts: async () => font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength),
      images: async () => null,
      rasteriser: {
        ...(memory === undefined ? {} : { memory }),
        rasterise(svg, options) {
          scales.push(options.scale);
          if (fail(scales.length)) {
            const error = new Error("out of memory");
            error.name = "RasterOutOfMemory";
            throw error;
          }
          return rasteriser.rasterise(svg, options);
        },
      },
    });
    return { r, scales };
  }

  it("draws once more at half the scale when it runs out all the same", async () => {
    const d = doc([layer("r", "rect", { width: 400, height: 200 })]);
    const { r, scales } = trapping((call) => call === 1);
    const out = await r.renderPng(d, "r", { scale: 1 });
    expect(scales).toEqual([1, 0.5]);
    expect([out.width, out.height, out.scale]).toEqual([200, 100, 0.5]);
    expect(out.reduced).toEqual({ width: 400, height: 200, scale: 1 });
  });

  it("fails cleanly when half the scale runs out too", async () => {
    const d = doc([layer("r", "rect", { width: 400, height: 200 })]);
    const { r, scales } = trapping(() => true);
    await expect(r.renderPng(d, "r", { scale: 1 })).rejects.toThrow(PICTURE_OUT_OF_MEMORY);
    expect(scales).toEqual([1, 0.5]);
  });

  it("fails cleanly, without drawing, when even the smallest picture wouldn't fit", async () => {
    // 40 frames nested, each translucent: about 450 bytes a pixel, so 31 MiB at 256 × 256.
    const name = (i: number) => `n${String.fromCharCode(i < 26 ? 65 + i : 71 + i)}`;
    const nested = [layer(name(0), "frame", { width: 2000, height: 2000 })];
    for (let i = 1; i < 40; i++)
      nested.push(
        layer(name(i), "frame", { width: 2000, height: 2000, opacity: 0.9 }, name(i - 1)),
      );
    const deep = doc(nested);
    const { r, scales } = trapping(() => false, RESVG_MAX_BYTES);
    await expect(r.renderPng(deep, name(0), { scale: 1 })).rejects.toThrow(PICTURE_OUT_OF_MEMORY);
    expect(scales).toEqual([]);
  });

  it("says when it's the fonts that leave too little room", async () => {
    const d = doc([layer("t", "text", { characters: "Hi", fontFamily: "Instrument Sans" })]);
    // Room for the module and the picture (a few kB), but not for the font file as well.
    const { r, scales } = trapping(() => false, RASTER_BASE_BYTES + font.length / 2);
    await expect(r.renderPng(d, "t", { scale: 1 })).rejects.toThrow(FONTS_OUT_OF_MEMORY);
    expect(scales).toEqual([]);
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
