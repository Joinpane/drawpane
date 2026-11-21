interface ColorBitmap {
  readonly ref: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: ImageData;
}

const cache = new Map<string, ColorBitmap | null>();
let revision = 0;
let heldBytes = 0;
const MAX_BITMAP_BYTES = 8 * 1024 * 1024;
export function invalidateColorBitmaps(): void {
  cache.clear();
  heldBytes = 0;
  revision++;
}

/** Let the browser resolve colour glyphs, including variation selectors and ZWJ sequences. */
export function colorBitmap(text: string, font: string, scale: number): ColorBitmap | null {
  const ref = `\0emoji:${JSON.stringify([text, font, scale, revision])}`;
  const cached = cache.get(ref);
  if (cached !== undefined) return cached;
  const result = rasterize(ref, text, font, scale);
  heldBytes += result?.pixels.data.byteLength ?? 0;
  for (const [key, value] of cache) {
    if (cache.size < 128 && heldBytes <= MAX_BITMAP_BYTES) break;
    heldBytes -= value?.pixels.data.byteLength ?? 0;
    cache.delete(key);
  }
  cache.set(ref, result);
  return result;
}

function rasterize(ref: string, text: string, font: string, scale: number): ColorBitmap | null {
  const surface = document.createElement("canvas");
  const ctx = surface.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.font = font;
  ctx.textAlign = "left";
  const metrics = ctx.measureText(text);
  const left = -metrics.actualBoundingBoxLeft - 1;
  const top = -metrics.actualBoundingBoxAscent - 1;
  const width = Math.ceil((metrics.actualBoundingBoxRight - left + 1) * scale);
  const height = Math.ceil((metrics.actualBoundingBoxDescent - top + 1) * scale);
  if (width <= 0 || height <= 0 || width * height > 1024 * 1024) return null;
  surface.width = width;
  surface.height = height;
  ctx.scale(scale, scale);
  ctx.font = font;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f0f";
  ctx.fillText(text, -left, -top);
  const pixels = ctx.getImageData(0, 0, width, height);
  // A monochrome glyph takes the fill colour. Use a second paint to
  // distinguish a fixed palette from monochrome fallback, even for grey emoji.
  ctx.clearRect(0, 0, width / scale, height / scale);
  ctx.fillStyle = "#0f0";
  ctx.fillText(text, -left, -top);
  const check = ctx.getImageData(0, 0, width, height).data;
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    if (
      (data[i + 3] ?? 0) > 64 &&
      data[i] === check[i] &&
      data[i + 1] === check[i + 1] &&
      data[i + 2] === check[i + 2] &&
      data[i + 3] === check[i + 3]
    ) {
      return { ref, x: left, y: top, width: width / scale, height: height / scale, pixels };
    }
  }
  return null;
}
