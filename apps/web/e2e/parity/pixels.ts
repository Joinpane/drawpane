/**
 * Pixels between Node and the page, for comparing renders: PNGs decoded and
 * encoded by the browser, RGBA carried as base64.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/** RGBA pixels of a PNG file, decoded by the browser, as base64, with its size. */
export function decodePng(
  page: Page,
  file: string,
): Promise<{ data: string; width: number; height: number }> {
  const url = `data:image/png;base64,${readFileSync(file).toString("base64")}`;
  return page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    let s = "";
    for (let i = 0; i < data.length; i += 0x8000)
      s += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return { data: btoa(s), width: img.width, height: img.height };
  }, url);
}

/** A PNG data URL of RGBA pixels (base64), encoded by the browser. */
export function encodePng(page: Page, b64: string, width: number, height: number): Promise<string> {
  return page.evaluate(
    async ({ b64, width, height }) => {
      const raw = Uint8ClampedArray.from(atob(b64), (ch) => ch.charCodeAt(0));
      const c = new OffscreenCanvas(width, height);
      (c.getContext("2d") as OffscreenCanvasRenderingContext2D).putImageData(
        new ImageData(raw, width, height),
        0,
        0,
      );
      const blob = await c.convertToBlob({ type: "image/png" });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000)
        s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return `data:image/png;base64,${btoa(s)}`;
    },
    { b64, width, height },
  );
}

export interface Difference {
  /** Mean absolute difference over RGB, 0–255. */
  readonly mean: number;
  /** The 99th percentile of per-pixel difference (max over RGB): local defects show here. */
  readonly p99: number;
  /** Worst mean RGB error across any 32 × 32 pixel tile. */
  readonly worstTile: number;
  /** A heat map of the difference, as RGBA base64 (black: same; white: 64 or more apart). */
  readonly heat: string;
}

/**
 * Separable Gaussian over RGB, with transparent black beyond the image. The grain suite
 * calls this on opaque composites separately over white and black when the frame has alpha.
 */
function statisticalBlur(raw: Uint8Array, width: number, height: number, sigma: number) {
  if (sigma <= 0) return raw;
  const radius = Math.ceil(sigma * 3);
  const weights = Array.from({ length: 2 * radius + 1 }, (_, i) =>
    Math.exp(-0.5 * ((i - radius) / sigma) ** 2),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const kernel = weights.map((weight) => weight / total);
  const horizontal = new Float32Array(raw.length);
  const blurred = new Uint8Array(raw.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let value = 0;
        for (
          let offset = Math.max(-x, -radius);
          offset <= Math.min(width - x - 1, radius);
          offset++
        )
          value += (raw[(y * width + x + offset) * 4 + c] ?? 0) * (kernel[offset + radius] ?? 0);
        horizontal[(y * width + x) * 4 + c] = value;
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let value = 0;
        for (
          let offset = Math.max(-y, -radius);
          offset <= Math.min(height - y - 1, radius);
          offset++
        )
          value +=
            (horizontal[((y + offset) * width + x) * 4 + c] ?? 0) * (kernel[offset + radius] ?? 0);
        blurred[(y * width + x) * 4 + c] = Math.round(value);
      }
    }
  }
  return blurred;
}

/** Compares two RGBA buffers (base64) of the same size, optionally both blurred first. */
export function compare(
  ours: string,
  theirs: string,
  width: number,
  height: number,
  blur = 0,
): Difference {
  const a = statisticalBlur(Buffer.from(ours, "base64"), width, height, blur);
  const b = statisticalBlur(Buffer.from(theirs, "base64"), width, height, blur);
  const n = width * height;
  const per = new Float32Array(n);
  const heat = new Uint8ClampedArray(n * 4);
  const cols = Math.ceil(width / 32);
  const rows = Math.ceil(height / 32);
  const tileSums = new Float64Array(cols * rows);
  const tileCounts = new Uint32Array(cols * rows);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const dr = Math.abs((a[i * 4] ?? 0) - (b[i * 4] ?? 0));
    const dg = Math.abs((a[i * 4 + 1] ?? 0) - (b[i * 4 + 1] ?? 0));
    const db = Math.abs((a[i * 4 + 2] ?? 0) - (b[i * 4 + 2] ?? 0));
    const rgb = (dr + dg + db) / 3;
    sum += rgb;
    const x = i % width;
    const y = (i - x) / width;
    const ti = (y >> 5) * cols + (x >> 5);
    tileSums[ti] = (tileSums[ti] ?? 0) + rgb;
    tileCounts[ti] = (tileCounts[ti] ?? 0) + 1;
    const d = Math.max(dr, dg, db);
    per[i] = d;
    const v = Math.min(255, d * 4);
    heat[i * 4] = v;
    heat[i * 4 + 1] = v;
    heat[i * 4 + 2] = v;
    heat[i * 4 + 3] = 255;
  }
  let worstTile = 0;
  for (let i = 0; i < tileSums.length; i++) {
    const c = tileCounts[i] ?? 0;
    if (c > 0) worstTile = Math.max(worstTile, (tileSums[i] ?? 0) / c);
  }
  per.sort();
  return {
    mean: Math.round((sum / n) * 100) / 100,
    p99: per[Math.floor(n * 0.99)] ?? 0,
    worstTile: Math.round(worstTile * 100) / 100,
    heat: Buffer.from(heat).toString("base64"),
  };
}
