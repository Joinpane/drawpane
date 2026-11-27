import type { ImageCacheOptions } from "@drawpane/editor";
import type { EngineOptions } from "@drawpane/engine";

const MIB = 1024 * 1024;

export interface MobileRendererMemory {
  readonly gpuLimits: Required<Pick<EngineOptions, "gpuBytes" | "tileBytes" | "glyphMaskBytes">>;
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
  readonly hover?: boolean | undefined;
  readonly finePointer?: boolean | undefined;
}

const LOW_MOBILE: MobileRendererMemory = {
  gpuLimits: { gpuBytes: 128 * MIB, tileBytes: 16 * MIB, glyphMaskBytes: 8 * MIB },
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
  backingPixels: 8_000_000,
  imageBytes: 64 * MIB,
  imageSide: 2560,
  canvasImageSide: 1536,
  decodeBytes: 24 * MIB,
  stagedImageBytes: 8 * MIB,
  cpuGlyphMaskBytes: 6 * MIB,
  cpuTileSlots: 32,
};

/** Pointer capabilities distinguish touch tablets with desktop UAs from touch laptops. */
export function mobileRendererMemory({
  deviceMemory,
  userAgent = "",
  maxTouchPoints = 0,
  coarsePointer = false,
  hover,
  finePointer = false,
}: DeviceSignals): MobileRendererMemory | undefined {
  const mobileUA = /\b(Android|iPhone|iPad|iPod|Mobile)\b/i.test(userAgent);
  const desktopIpad = /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
  if (!mobileUA && !desktopIpad && hover && finePointer) return undefined;
  const touchOnly = hover === false && (maxTouchPoints > 0 || coarsePointer);
  if (!mobileUA && !desktopIpad && !touchOnly) return undefined;
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
    hover: window.matchMedia?.("(any-hover: hover)").matches,
    finePointer: window.matchMedia?.("(any-pointer: fine)").matches,
  });
}

export function mobileImageCacheOptions(profile = readMobileRendererMemory()): ImageCacheOptions {
  return profile
    ? {
        maxBytes: profile.imageBytes,
        maxSide: profile.canvasImageSide,
        decodeBytes: profile.decodeBytes,
        enforceMaxBytes: true,
      }
    : {};
}

/** Fit one backing with uniform scale. Round down when reducing an oversized request. */
export function mobileBacking(
  profile: MobileRendererMemory,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  maxSide = Infinity,
) {
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  if (w * h <= profile.backingPixels && Math.max(w, h) <= maxSide) {
    return { width: w, height: h, dpr };
  }

  const scale = Math.min(
    dpr,
    Math.sqrt(profile.backingPixels / (Math.max(1, cssWidth) * Math.max(1, cssHeight))),
    maxSide / Math.max(cssWidth, cssHeight),
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
    if (w * h <= profile.backingPixels) low = mid;
    else high = mid - 1;
  }
  return low;
}
