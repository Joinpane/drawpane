import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { cachedFontLoader, faceKey, isSfnt, type ResvgRasteriser } from "../src";
import { nodeRasteriser } from "../src/node";

const font = new Uint8Array(
  readFileSync(new URL("./fixtures/InstrumentSans-Regular.ttf", import.meta.url)),
);

let r: ResvgRasteriser;
beforeAll(async () => {
  r = await nodeRasteriser();
});

const at = (p: { data: Uint8Array; width: number }, x: number, y: number) => [
  ...p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4),
];
const inked = (p: { data: Uint8Array }) => {
  let n = 0;
  for (let i = 3; i < p.data.length; i += 4) if ((p.data[i] ?? 0) > 0) n++;
  return n;
};

describe("resvg rasteriser", () => {
  it("draws at the scale asked for, as a PNG", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="5" viewBox="0 0 10 5"><rect width="5" height="5" fill="#ff0000"/></svg>`;
    const png = r.rasterise(svg, { scale: 3, fonts: [] });
    expect([png.width, png.height]).toEqual([30, 15]);
    expect([...png.png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    const px = r.pixels(svg, { scale: 3, fonts: [] });
    expect(at(px, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(at(px, 20, 2)).toEqual([0, 0, 0, 0]);
  });

  it("gives pixels with straight alpha, as a canvas's getImageData does", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" viewBox="0 0 2 2"><rect width="2" height="2" fill="#ff0000" fill-opacity="0.5"/></svg>`;
    expect(at(r.pixels(svg, { scale: 1, fonts: [] }), 1, 1)).toEqual([255, 0, 0, 128]);
  });

  it("paints a background when given one", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4"/>`;
    expect(at(r.pixels(svg, { scale: 1, fonts: [], background: "#00ff00" }), 1, 1)).toEqual([
      0, 255, 0, 255,
    ]);
  });

  it("sets text only in the font files it's given", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="30" viewBox="0 0 80 30"><text x="2" y="22" font-family="'Instrument Sans', sans-serif" font-size="20">Hi</text></svg>`;
    expect(inked(r.pixels(svg, { scale: 1, fonts: [] }))).toBe(0);
    expect(inked(r.pixels(svg, { scale: 1, fonts: [font] }))).toBeGreaterThan(40);
    // A family it lacks falls back to the one named.
    const other = svg.replace("Instrument Sans", "Nowhere Grotesk");
    expect(
      inked(r.pixels(other, { scale: 1, fonts: [font], fallbackFamily: "Instrument Sans" })),
    ).toBeGreaterThan(40);
  });

  it("draws images from data: URLs", () => {
    // A 1×1 blue PNG.
    const blue =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4"><image width="4" height="4" href="data:image/png;base64,${blue}" preserveAspectRatio="none"/></svg>`;
    expect(at(r.pixels(svg, { scale: 1, fonts: [] }), 2, 2)).toEqual([0, 0, 255, 255]);
  });

  it("draws images handed to it as files, and leaves out one it can't decode", () => {
    const blue = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
        "base64",
      ),
    );
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4" viewBox="0 0 8 4"><image width="4" height="4" href="https://media.invalid/a" preserveAspectRatio="none"/><image x="4" width="4" height="4" href="https://media.invalid/b" preserveAspectRatio="none"/></svg>`;
    const images = new Map([
      ["https://media.invalid/a", blue],
      ["https://media.invalid/b", new Uint8Array(16)],
    ]);
    const px = r.pixels(svg, { scale: 1, fonts: [], images });
    expect(at(px, 2, 2)).toEqual([0, 0, 255, 255]);
    expect(at(px, 6, 2)).toEqual([0, 0, 0, 0]);
  });

  it("masks by alpha when the mask says so", () => {
    // Black at full alpha: shows through an alpha mask, hides under a luminance one.
    const svg = (type: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4"><mask id="m" mask-type="${type}" maskUnits="userSpaceOnUse" x="0" y="0" width="4" height="4"><rect width="4" height="4" fill="#000"/></mask><rect width="4" height="4" fill="#f00" mask="url(#m)"/></svg>`;
    expect(at(r.pixels(svg("alpha"), { scale: 1, fonts: [] }), 1, 1)).toEqual([255, 0, 0, 255]);
    expect(at(r.pixels(svg("luminance"), { scale: 1, fonts: [] }), 1, 1)[3]).toBe(0);
  });
});

describe("font files", () => {
  it("tells font files from web fonts", () => {
    expect(isSfnt(font)).toBe(true);
    expect(isSfnt(new TextEncoder().encode("wOF2 and the rest"))).toBe(false);
  });

  it("loads each face once, a variable file for every weight", async () => {
    const asked: string[] = [];
    const load = cachedFontLoader(async (face) => {
      asked.push(faceKey(face));
      return face.family === "Missing" ? Promise.reject(new Error("gone")) : new ArrayBuffer(4);
    });
    await load({ family: "Inter", weight: 400, italic: false });
    await load({ family: "Inter", weight: 400, italic: false });
    await load({ family: "Inter", weight: 400, italic: false, variable: true });
    await load({ family: "Inter", weight: 700, italic: false, variable: true });
    expect(await load({ family: "Missing", weight: 400, italic: false })).toBeNull();
    expect(asked).toHaveLength(3);
  });
});
