import { deflateSync, inflateSync } from "node:zlib";

function crc32(...parts: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const data of parts) {
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(tag: string, data: Uint8Array): Buffer {
  const item = Buffer.from(tag);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.byteLength);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(item, data));
  return Buffer.concat([head, item, data, check]);
}

/** Small encoded PNG of a solid image, including fixtures with a large natural size. */
export function solidPng(width: number, height: number, rgba: readonly number[]): Uint8Array {
  const stride = width * 4 + 1;
  const row = Buffer.alloc(stride);
  row.fill(Buffer.from(rgba), 1);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) row.copy(pixels, y * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** Reads a pixel from an engine PNG. It always uses the Sub filter on RGBA8. */
export function enginePngPixel(png: Uint8Array, x: number, y: number): number[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Uint8Array[] = [];
  for (let at = 8; at + 8 < png.length; ) {
    const bytes = view.getUint32(at);
    if (view.getUint32(at + 4) === 0x49444154) chunks.push(png.subarray(at + 8, at + 8 + bytes));
    at += bytes + 12;
  }
  const rows = inflateSync(Buffer.concat(chunks));
  const stride = view.getUint32(16) * 4 + 1;
  const start = y * stride;
  if (rows[start] !== 1) throw new Error("expected the engine's Sub filter");
  const out = [0, 0, 0, 0];
  for (let col = 0; col <= x; col++) {
    for (let channel = 0; channel < 4; channel++) {
      out[channel] = ((out[channel] ?? 0) + (rows[start + 1 + col * 4 + channel] ?? 0)) & 255;
    }
  }
  return out;
}
