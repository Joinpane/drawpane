import type { ImageCacheOptions } from "@drawpane/editor";
import type { EngineOptions } from "@drawpane/engine";

const MIB = 1024 * 1024;
/** Keep canvas dimensions within older mobile browsers' per-axis allowance, too. */
export const MOBILE_BACKING_SIDE = 4096;

export interface MobileRendererMemory {
  readonly gpuLimits: Required<Pick<EngineOptions, "gpuBytes" | "tileBytes" | "glyphMaskBytes">>;
  readonly maxDpr: number;
  readonly backingPixels: number;
  readonly imageBytes: number;
  readonly imageSide: number;
  readonly canvasImageSide: number;
  readonly decodeBytes: number;
  readonly stagedImageBytes: number;
  readonly cpuGlyphMaskBytes: number;
  readonly cpuTileSlots: number;
}

interface DeviceSignals {
  readonly deviceMemory?: number | undefined;
  readonly userAgent?: string | undefined;
  readonly maxTouchPoints?: number | undefined;
  readonly coarsePointer?: boolean | undefined;
  readonly screenWidth?: number | undefined;
  readonly screenHeight?: number | undefined;
}

const LOW_MOBILE: MobileRendererMemory = {
  gpuLimits: { gpuBytes: 128 * MIB, tileBytes: 16 * MIB, glyphMaskBytes: 8 * MIB },
  maxDpr: 2,
  backingPixels: 6_000_000,
  imageBytes: 48 * MIB,
  imageSide: 2048,
  canvasImageSide: 1024,
  decodeBytes: 16 * MIB,
  stagedImageBytes: 8 * MIB,
  cpuGlyphMaskBytes: 4 * MIB,
  cpuTileSlots: 16,
};

const MOBILE: MobileRendererMemory = {
  gpuLimits: { gpuBytes: 160 * MIB, tileBytes: 24 * MIB, glyphMaskBytes: 8 * MIB },
  maxDpr: 2.5,
  backingPixels: 7_000_000,
  imageBytes: 56 * MIB,
  imageSide: 2048,
  canvasImageSide: 1536,
  decodeBytes: 20 * MIB,
  stagedImageBytes: 8 * MIB,
  cpuGlyphMaskBytes: 4 * MIB,
  cpuTileSlots: 24,
};

const HIGH_MOBILE: MobileRendererMemory = {
  gpuLimits: { gpuBytes: 192 * MIB, tileBytes: 32 * MIB, glyphMaskBytes: 12 * MIB },
  maxDpr: 3,
  backingPixels: 8_000_000,
  imageBytes: 64 * MIB,
  imageSide: 2560,
  canvasImageSide: 1536,
  decodeBytes: 24 * MIB,
  stagedImageBytes: 8 * MIB,
  cpuGlyphMaskBytes: 6 * MIB,
  cpuTileSlots: 32,
};

/** Screen dimensions are stable across pane resizes and browser chrome changes. */
export function mobileRendererMemory({
  deviceMemory,
  userAgent = "",
  maxTouchPoints = 0,
  coarsePointer = false,
  screenWidth = 0,
  screenHeight = 0,
}: DeviceSignals): MobileRendererMemory | undefined {
  const mobileUA = /\b(Android|iPhone|iPad|iPod|Mobile)\b/i.test(userAgent);
  const desktopIpad = /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
  const shortSide = Math.min(screenWidth, screenHeight);
  if (!mobileUA && !desktopIpad && !(coarsePointer && shortSide > 0 && shortSide <= 1024)) {
    return undefined;
  }
  if (deviceMemory !== undefined && Number.isFinite(deviceMemory) && deviceMemory > 0) {
    if (deviceMemory <= 2) return LOW_MOBILE;
    if (deviceMemory >= 6) return HIGH_MOBILE;
  }
  return MOBILE;
}

export function readMobileRendererMemory(): MobileRendererMemory | undefined {
  if (typeof window === "undefined") return undefined;
  const nav = window.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  return mobileRendererMemory({
    deviceMemory: nav?.deviceMemory,
    userAgent: nav?.userAgent,
    maxTouchPoints: nav?.maxTouchPoints,
    coarsePointer: window.matchMedia?.("(pointer: coarse)").matches,
    screenWidth: window.screen?.width,
    screenHeight: window.screen?.height,
  });
}

export function mobileImageCacheOptions(profile = readMobileRendererMemory()): ImageCacheOptions {
  return profile
    ? {
        maxBytes: profile.imageBytes,
        maxSide: profile.canvasImageSide,
        enforceMaxBytes: true,
        maxConcurrentLoads: 2,
      }
    : {};
}

/** Fit one backing with uniform scale. Round down when reducing an oversized request. */
export function mobileBacking(
  profile: MobileRendererMemory,
  cssWidth: number,
  cssHeight: number,
  deviceDpr: number,
) {
  const dpr = Math.min(deviceDpr, profile.maxDpr);
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  if (w * h <= profile.backingPixels && Math.max(w, h) <= MOBILE_BACKING_SIDE) {
    return { width: w, height: h, dpr };
  }

  const scale = Math.min(
    dpr,
    Math.sqrt(profile.backingPixels / (Math.max(1, cssWidth) * Math.max(1, cssHeight))),
    MOBILE_BACKING_SIDE / Math.max(cssWidth, cssHeight),
  );
  return {
    width: Math.max(1, Math.floor(cssWidth * scale)),
    height: Math.max(1, Math.floor(cssHeight * scale)),
    dpr: scale,
  };
}

/** Largest symmetric CSS margin whose rounded backing still fits at the primary canvas DPR. */
export function mobileOverscan(
  profile: MobileRendererMemory,
  width: number,
  height: number,
  dpr: number,
  pad: number,
): number {
  let low = 0;
  let high = pad;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const w = Math.max(1, Math.round((width + mid * 2) * dpr));
    const h = Math.max(1, Math.round((height + mid * 2) * dpr));
    if (w * h <= profile.backingPixels && Math.max(w, h) <= MOBILE_BACKING_SIDE) low = mid;
    else high = mid - 1;
  }
  return low;
}
