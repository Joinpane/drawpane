import { describe, expect, it } from "vitest";
import { readingOrder } from "./export-assets";
import { parseFontFaces, pickFace } from "./pdf";

describe("PDF export", () => {
  it("reads the faces a TrueType stylesheet offers", () => {
    const css = `@font-face {
  font-family: 'Inter';
  font-style: italic;
  font-weight: 400;
  src: url(/api/fonts/gstatic/s/inter/v20/a.ttf) format('truetype');
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 700;
  src: url(/api/fonts/gstatic/s/inter/v20/b.ttf) format('truetype');
}`;
    expect(parseFontFaces(css)).toEqual([
      { weight: 400, italic: true, url: "/api/fonts/gstatic/s/inter/v20/a.ttf" },
      { weight: 700, italic: false, url: "/api/fonts/gstatic/s/inter/v20/b.ttf" },
    ]);
  });

  it("picks the same style first, then the nearest weight", () => {
    const faces = [
      { weight: 400, italic: false },
      { weight: 700, italic: false },
      { weight: 400, italic: true },
    ];
    expect(pickFace(faces, { weight: 600, italic: false })).toEqual({ weight: 700, italic: false });
    expect(pickFace(faces, { weight: 800, italic: true })).toEqual({ weight: 400, italic: true });
    // No bold italic: an upright face is better than nothing.
    expect(pickFace([{ weight: 700, italic: false }], { weight: 700, italic: true })).toEqual({
      weight: 700,
      italic: false,
    });
    expect(pickFace([], { weight: 400, italic: false })).toBeNull();
  });

  it("orders pages like a deck reads: rows top to bottom, each left to right", () => {
    const at = (name: string, x: number, y: number) => ({
      name,
      bounds: { x, y, width: 100, height: 100 },
    });
    const pages = readingOrder([
      at("c", 0, 300),
      at("b", 240, 10),
      at("a", 0, 0),
      at("d", 240, 290),
    ]);
    expect(pages.map((p) => p.name)).toEqual(["a", "b", "c", "d"]);
  });
});
