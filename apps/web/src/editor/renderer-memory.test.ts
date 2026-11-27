import { describe, expect, test } from "vitest";
import { mobileBacking, mobileOverscan, mobileRendererMemory } from "./renderer-memory";

const MiB = 1024 * 1024;

describe("renderer memory profile", () => {
  test("keeps hover and fine-pointer devices on desktop, even if touch is primary", () => {
    expect(
      mobileRendererMemory({
        deviceMemory: 2,
        maxTouchPoints: 10,
        coarsePointer: true,
        finePointer: true,
        hover: true,
        userAgent: "Windows NT",
      }),
    ).toBeUndefined();
    expect(mobileRendererMemory({ userAgent: "Macintosh" })).toBeUndefined();
    expect(
      mobileRendererMemory({ userAgent: "Android", hover: true, finePointer: true }),
    ).toBeUndefined();
  });

  test("recognizes desktop-UA iPads and Android tablets without hover", () => {
    const ipad = mobileRendererMemory({ userAgent: "Macintosh", maxTouchPoints: 5 });
    expect(ipad).toMatchObject({ backingPixels: 7_000_000, imageBytes: 56 * MiB });
    expect(mobileRendererMemory({ userAgent: "iPhone" })).toBe(ipad);
    expect(
      mobileRendererMemory({
        userAgent: "X11; Linux x86_64",
        maxTouchPoints: 10,
        hover: false,
      }),
    ).toBe(ipad);
    expect(mobileRendererMemory({ coarsePointer: true, hover: false })).toBe(ipad);
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

  test("keeps native DPR until the pixel allowance is reached", () => {
    const memory = mobileRendererMemory({ userAgent: "Android", deviceMemory: 2 });
    if (!memory) throw new Error("Expected a mobile profile");

    expect(mobileBacking(memory, 390, 844, 2)).toEqual({ width: 780, height: 1688, dpr: 2 });
    expect(mobileBacking(memory, 390, 844, 3)).toEqual({ width: 1170, height: 2532, dpr: 3 });
    const noHint = mobileRendererMemory({ userAgent: "iPhone" });
    if (!noHint) throw new Error("Expected an iPhone profile");
    expect(mobileBacking(noHint, 393, 659, 3)).toEqual({ width: 1179, height: 1977, dpr: 3 });
    const long = mobileBacking(noHint, 393, 6000, 3);
    expect(long.dpr).toBeGreaterThan(1.7);
    expect(long.height).toBeGreaterThan(4096);
    expect(long.width * long.height).toBeLessThanOrEqual(7_000_000);
    for (const [w, h] of [
      [2033.75, 1991.5],
      [1, 20000],
      [2300, 1040],
    ] as const) {
      const { width, height, dpr } = mobileBacking(memory, w, h, 3);
      expect(width * height).toBeLessThanOrEqual(memory.backingPixels);
      expect(Math.abs(width - w * dpr)).toBeLessThanOrEqual(1);
      expect(Math.abs(height - h * dpr)).toBeLessThanOrEqual(1);
    }
    expect(mobileBacking(memory, 393, 6000, 3, 8192).height).toBeLessThanOrEqual(8192);
    const pad = mobileOverscan(memory, 1440, 1024, 2, 144);
    expect(pad).toBeGreaterThan(0);
    expect(pad).toBeLessThan(144);
    expect((1440 + pad * 2) * (1024 + pad * 2) * 4).toBeLessThanOrEqual(memory.backingPixels);
  });
});
