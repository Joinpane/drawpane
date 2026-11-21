import { type Camera, ErrorCode, type Result } from "@drawpane/engine";

export const MIN_RASTER_SCALE = 1 / 64;

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly camera: Camera;
  readonly scale: number;
}

/** Retry viewport rendering at lower device resolution, preserving its page-space crop. */
export function fitEngineRaster<T>(
  width: number,
  height: number,
  camera: Camera,
  draw: (raster: Raster) => Result<T>,
  initialScale = 1,
) {
  let scale = initialScale;
  let limit: string | null = null;
  for (;;) {
    const raster = {
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
      camera: { ...camera, dpr: camera.dpr * scale },
      scale,
    };
    const result = draw(raster);
    if (result.ok || result.code !== ErrorCode.Limit) return { raster, result, limit };
    limit ??= result.message;
    if (scale <= MIN_RASTER_SCALE || (raster.width === 1 && raster.height === 1))
      return { raster, result, limit };
    scale /= 2;
  }
}
