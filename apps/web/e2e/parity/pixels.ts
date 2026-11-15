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
  /** A heat map of the difference, as RGBA base64 (black: same; white: 64 or more apart). */
  readonly heat: string;
}

/** Compares two RGBA buffers (base64) of the same size, optionally both blurred first. */
export function compare(
  page: Page,
  ours: string,
  theirs: string,
  width: number,
  height: number,
  blur = 0,
): Promise<Difference> {
  return page.evaluate(
    async ({ ours, theirs, width, height, blur }) => {
      const load = async (b64: string) => {
        const raw = Uint8ClampedArray.from(atob(b64), (ch) => ch.charCodeAt(0));
        if (blur <= 0) return raw;
        const c = new OffscreenCanvas(width, height);
        const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
        ctx.putImageData(new ImageData(raw, width, height), 0, 0);
        const out = new OffscreenCanvas(width, height);
        const octx = out.getContext("2d") as OffscreenCanvasRenderingContext2D;
        octx.filter = `blur(${blur}px)`;
        octx.drawImage(c, 0, 0);
        return octx.getImageData(0, 0, width, height).data;
      };
      const a = await load(ours);
      const b = await load(theirs);
      const n = width * height;
      const per = new Float32Array(n);
      const heat = new Uint8ClampedArray(n * 4);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const dr = Math.abs((a[i * 4] ?? 0) - (b[i * 4] ?? 0));
        const dg = Math.abs((a[i * 4 + 1] ?? 0) - (b[i * 4 + 1] ?? 0));
        const db = Math.abs((a[i * 4 + 2] ?? 0) - (b[i * 4 + 2] ?? 0));
        sum += (dr + dg + db) / 3;
        const d = Math.max(dr, dg, db);
        per[i] = d;
        const v = Math.min(255, d * 4);
        heat[i * 4] = v;
        heat[i * 4 + 1] = v;
        heat[i * 4 + 2] = v;
        heat[i * 4 + 3] = 255;
      }
      per.sort();
      let s = "";
      for (let i = 0; i < heat.length; i += 0x8000)
        s += String.fromCharCode(...heat.subarray(i, i + 0x8000));
      return {
        mean: Math.round((sum / n) * 100) / 100,
        p99: per[Math.floor(n * 0.99)] ?? 0,
        heat: btoa(s),
      };
    },
    { ours, theirs, width, height, blur },
  );
}
