import { describe, expect, it } from "vitest";
import { largestInscribedRadius } from "../src/inradius";

/** A width × height raster, inside where `at(x, y)` is (pixel centres). */
function raster(width: number, height: number, at: (x: number, y: number) => boolean) {
  const inside = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) inside[y * width + x] = at(x + 0.5, y + 0.5) ? 1 : 0;
  return inside;
}

describe("largestInscribedRadius", () => {
  it("is half a bar's thickness, whatever its length", () => {
    const bar = raster(200, 40, (_, y) => y > 8 && y < 32);
    expect(largestInscribedRadius(bar, 200, 40)).toBe(12);
  });

  it("is half a square's side, the raster's edge counting as outside", () => {
    const full = raster(10, 10, () => true);
    expect(largestInscribedRadius(full, 10, 10)).toBe(5);
  });

  it("is a disc's radius, to within a pixel", () => {
    const disc = raster(100, 100, (x, y) => Math.hypot(x - 50, y - 50) < 30);
    const r = largestInscribedRadius(disc, 100, 100);
    expect(Math.abs(r - 30)).toBeLessThan(1);
  });

  it("is the thickest part's, for a shape thick in one place and thin in another", () => {
    // An L: a 40-thick arm and a 10-thick one.
    const l = raster(120, 120, (x, y) => (x < 40 && y < 120) || (y > 100 && y < 110));
    expect(largestInscribedRadius(l, 120, 120)).toBe(20);
  });

  it("is 0 for nothing", () => {
    expect(largestInscribedRadius(new Uint8Array(64), 8, 8)).toBe(0);
    expect(largestInscribedRadius(new Uint8Array(0), 0, 0)).toBe(0);
  });
});
