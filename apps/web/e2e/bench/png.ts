import { inflateSync } from "node:zlib";

/** An 8-bit RGB or RGBA image (`bpp` 3 or 4). */
export interface Image {
  width: number;
  height: number;
  bpp: number;
  data: Uint8Array;
}

/** Decodes an 8-bit RGB or RGBA, non-interlaced PNG (what a CDP screencast sends). */
export function decodePng(buf: Buffer): Image {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString("ascii");
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8] ?? 0;
      colour = data[9] ?? 0;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (depth !== 8 || (colour !== 2 && colour !== 6)) {
    throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}`);
  }
  const bpp = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(width * height * bpp);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    const filter = raw[row] ?? 0;
    const dst = y * stride;
    const prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[row + 1 + x] ?? 0;
      const a = x >= bpp ? (out[dst + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[prev + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (out[prev + x - bpp] ?? 0) : 0;
      let r = v;
      if (filter === 1) r = v + a;
      else if (filter === 2) r = v + b;
      else if (filter === 3) r = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[dst + x] = r & 0xff;
    }
  }
  return { width, height, bpp, data: out };
}

/** A rectangle in an image's pixels, `x1` and `y1` exclusive. */
export interface Crop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The share of `crop`'s pixels (percent) whose largest RGB difference between `a` and `b` is over
 * `tolerance`: the Figma research's `diffPct` (its `analyze_png.mjs`, tolerance 3).
 */
export function diffPercent(a: Image, b: Image, crop: Crop, tolerance = 3): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error("images differ in size");
  let total = 0;
  let differing = 0;
  for (let y = crop.y0; y < crop.y1; y++) {
    for (let x = crop.x0; x < crop.x1; x++) {
      const i = (y * a.width + x) * a.bpp;
      const j = (y * b.width + x) * b.bpp;
      const d = Math.max(
        Math.abs((a.data[i] ?? 0) - (b.data[j] ?? 0)),
        Math.abs((a.data[i + 1] ?? 0) - (b.data[j + 1] ?? 0)),
        Math.abs((a.data[i + 2] ?? 0) - (b.data[j + 2] ?? 0)),
      );
      total++;
      if (d > tolerance) differing++;
    }
  }
  return total === 0 ? 0 : (differing / total) * 100;
}
