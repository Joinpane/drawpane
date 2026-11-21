import type { RenderEngine } from "@drawpane/engine";

/** Reads only the resized bitmap admitted by the interactive engine. */
export function uploadViewImage(engine: RenderEngine, handle: number, bitmap: ImageBitmap) {
  return engine.putViewImage(handle, bitmap.width, bitmap.height, (width, height) => {
    const surface =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement("canvas"), { width, height });
    const ctx = surface.getContext("2d", { willReadFrequently: true }) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error("could not read image pixels");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  });
}
