import { describe, expect, it } from "vitest";
import { Camera } from "../src/camera";
import {
  drawPixelGrid,
  PIXEL_GRID_FULL_ZOOM,
  PIXEL_GRID_MIN_ZOOM,
  pixelGridColor,
  pixelGridDeviceLine,
  pixelGridFade,
  pixelGridLines,
  pixelGridVisible,
} from "../src/pixel-grid";

describe("pixel grid fade", () => {
  it("starts at Figma's 400% and is full at 800%, fading between rather than popping on", () => {
    expect(PIXEL_GRID_MIN_ZOOM).toBe(4);
    expect(PIXEL_GRID_FULL_ZOOM).toBe(8);
    expect(pixelGridFade(2)).toBe(0);
    expect(pixelGridFade(3.99)).toBe(0);
    expect(pixelGridFade(4)).toBe(0);
    expect(pixelGridFade(Math.sqrt(32))).toBeCloseTo(0.5, 10);
    expect(pixelGridFade(8)).toBe(1);
    expect(pixelGridFade(256)).toBe(1);
    expect(pixelGridFade(Number.NaN)).toBe(0);
    expect(pixelGridVisible(4)).toBe(false);
    expect(pixelGridVisible(4.01)).toBe(true);
    // A faint translucent mid grey, so it reads on light and dark content alike.
    expect(pixelGridColor(1)).toBe("rgba(128, 128, 128, 0.4)");
    expect(pixelGridColor(0.5)).toBe("rgba(128, 128, 128, 0.2)");
    expect(pixelGridColor(0)).toBe("rgba(128, 128, 128, 0)");
  });
});

describe("pixel grid line placement", () => {
  it("places whole-pixel boundaries on the nearest device pixel at DPR 2", () => {
    const camera = new Camera(10.3, -5.2, 8);
    expect(pixelGridDeviceLine(3, camera.x, camera.zoom, 2)).toBe(69);
    const lines = pixelGridLines(camera, 100, 50, 2);
    expect(lines.vertical).toEqual([5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197]);
    expect(lines.horizontal).toEqual([6, 22, 38, 54, 70, 86]);
  });

  it("places lines at a fractional DPR and an odd zoom, where spacing is not a whole device pixel count", () => {
    // 5.3 x zoom at 1.5 DPR is 7.95 device pixels a cell: most lines land
    // 8 device pixels apart, one in a while 7, each within half a device
    // pixel of its page boundary rather than drifting like a fixed pattern.
    const camera = new Camera(7.25, 0, 5.3);
    const lines = pixelGridLines(camera, 60, 30, 1.5);
    expect(lines.vertical).toEqual([3, 11, 19, 27, 35, 43, 51, 59, 67, 74, 82]);
    expect(lines.horizontal).toEqual([0, 8, 16, 24, 32, 40]);
  });

  it("keeps every line within half a device pixel of its boundary, inside the canvas, once each", () => {
    for (const zoom of [4.2, 5.3, 7.77, 8, 13.5, 100, 256]) {
      for (const dpr of [1, 1.25, 1.5, 2, 2.75]) {
        const camera = new Camera(-123.45, 987.6, zoom);
        const lines = pixelGridLines(camera, 320, 200, dpr);
        for (const [at, offset, extent] of [
          ...lines.vertical.map((x) => [x, camera.x, 320] as const),
          ...lines.horizontal.map((y) => [y, camera.y, 200] as const),
        ]) {
          expect(Number.isInteger(at)).toBe(true);
          expect(at).toBeGreaterThanOrEqual(0);
          expect(at).toBeLessThan(Math.ceil(extent * dpr));
          // The boundary this line stands for, and its exact device position.
          const boundary = Math.round((at / dpr - offset) / zoom);
          const exact = (boundary * zoom + offset) * dpr;
          expect(Math.abs(at - exact)).toBeLessThanOrEqual(0.5 + 1e-9);
        }
        for (const list of [lines.vertical, lines.horizontal])
          for (let i = 1; i < list.length; i++)
            expect(list[i] as number).toBeGreaterThan(list[i - 1] as number);
      }
    }
  });

  it("shifts lines by an overscanned canvas's origin, so a retained bake lines up with the viewport", () => {
    const camera = new Camera(0, 0, 8);
    expect(pixelGridLines(camera, 100, 24, 1, 16).vertical).toEqual([
      0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96,
    ]);
    expect(pixelGridLines(camera, 100, 24, 1).vertical.slice(0, 3)).toEqual([0, 8, 16]);
  });

  it("draws every line in a single fill of one-device-pixel rects, and nothing below the threshold", () => {
    const rects: number[][] = [];
    let fills = 0;
    let fillStyle = "";
    const ctx = {
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(v: string) {
        fillStyle = v;
      },
      save: () => {},
      restore: () => {},
      setTransform: () => {},
      beginPath: () => {},
      rect: (x: number, y: number, w: number, h: number) => rects.push([x, y, w, h]),
      fill: () => fills++,
    } as unknown as CanvasRenderingContext2D;

    expect(drawPixelGrid(ctx, new Camera(0, 0, 3), 100, 50, 1)).toBe(false);
    expect(drawPixelGrid(ctx, new Camera(0, 0, 4), 100, 50, 1)).toBe(false);
    expect(fills).toBe(0);

    expect(drawPixelGrid(ctx, new Camera(10.3, -5.2, 8), 100, 50, 2)).toBe(true);
    expect(fills).toBe(1);
    expect(fillStyle).toBe("rgba(128, 128, 128, 0.4)");
    // 13 vertical + 6 horizontal (see above), each one device pixel thick.
    expect(rects).toHaveLength(19);
    expect(rects.every(([, , w, h]) => w === 1 || h === 1)).toBe(true);
    expect(rects.slice(0, 13).every((r) => r[2] === 1 && r[3] === 100)).toBe(true);
    expect(rects.slice(13).every((r) => r[2] === 200 && r[3] === 1)).toBe(true);
  });
});
