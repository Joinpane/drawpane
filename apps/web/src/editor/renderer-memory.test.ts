import { describe, expect, test } from "vitest";
import { mobileBacking, mobileOverscan, mobileRendererMemory } from "./renderer-memory";

const MiB = 1024 * 1024;

describe("renderer memory profile", () => {
  test("keeps the desktop path even with a low memory hint and a touchscreen", () => {
    expect(
      mobileRendererMemory({
        deviceMemory: 2,
        maxTouchPoints: 10,
        screenWidth: 1920,
        screenHeight: 1080,
        userAgent: "Windows NT",
      }),
    ).toBeUndefined();
    expect(mobileRendererMemory({ userAgent: "Macintosh" })).toBeUndefined();
  });

  test("recognizes phones, iPads advertising a desktop UA, and small coarse-pointer screens", () => {
    const ipad = mobileRendererMemory({ userAgent: "Macintosh", maxTouchPoints: 5 });
    expect(ipad).toMatchObject({ backingPixels: 7_000_000, imageBytes: 56 * MiB, maxDpr: 2.5 });
    expect(mobileRendererMemory({ userAgent: "iPhone" })).toBe(ipad);
    expect(
      mobileRendererMemory({ coarsePointer: true, screenWidth: 1194, screenHeight: 834 }),
    ).toBe(ipad);
    expect(
      mobileRendererMemory({ coarsePointer: true, screenWidth: 1920, screenHeight: 1080 }),
    ).toBeUndefined();
  });

  test("uses smaller tiles and cache limits for lower memory hints", () => {
    expect(mobileRendererMemory({ userAgent: "Android", deviceMemory: 1 })).toMatchObject({
      gpuLimits: { gpuBytes: 128 * MiB, tileBytes: 16 * MiB, glyphMaskBytes: 8 * MiB },
      imageBytes: 48 * MiB,
    });
    expect(mobileRendererMemory({ userAgent: "Android", deviceMemory: 8 })).toMatchObject({
      gpuLimits: { gpuBytes: 192 * MiB, tileBytes: 32 * MiB },
      imageBytes: 64 * MiB,
    });
    expect(mobileRendererMemory({ userAgent: "Android", deviceMemory: NaN })).toBe(
      mobileRendererMemory({ userAgent: "Android" }),
    );
  });

  test("keeps normal DPR 2 pixels and bounds large, skinny and overscanned DPR 3 surfaces", () => {
    const memory = mobileRendererMemory({ userAgent: "Android", deviceMemory: 2 });
    if (!memory) throw new Error("Expected a mobile profile");

    expect(mobileBacking(memory, 390, 844, 2)).toEqual({ width: 780, height: 1688, dpr: 2 });
    expect(mobileBacking(memory, 390, 844, 3)).toEqual({ width: 780, height: 1688, dpr: 2 });
    for (const [w, h] of [
      [2033.75, 1991.5],
      [1, 20000],
      [2300, 1040],
    ] as const) {
      const { width, height, dpr } = mobileBacking(memory, w, h, 3);
      expect(width * height).toBeLessThanOrEqual(memory.backingPixels);
      expect(Math.max(width, height)).toBeLessThanOrEqual(4096);
      expect(Math.abs(width - w * dpr)).toBeLessThanOrEqual(1);
      expect(Math.abs(height - h * dpr)).toBeLessThanOrEqual(1);
    }
    const pad = mobileOverscan(memory, 1440, 1024, 2, 144);
    expect(pad).toBeGreaterThan(0);
    expect(pad).toBeLessThan(144);
    expect((1440 + pad * 2) * (1024 + pad * 2) * 4).toBeLessThanOrEqual(memory.backingPixels);
  });
});
