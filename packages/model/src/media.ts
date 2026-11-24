/**
 * Media rules shared by the browser and the Worker: which image formats a
 * file can hold, how big they may be, and how to recognise them.
 *
 * Formats are recognised by their magic bytes, never by a file name or a
 * Content-Type header, so a renamed file can't smuggle in another format.
 *
 * SVG is never stored as media (decision 0020). An SVG is a document that
 * can carry scripts, external references and CSS, so the browser converts it
 * instead: to editable layers when it's placed on the canvas, or to a PNG
 * when it's an image fill. What reaches storage is always one of the
 * formats below.
 */

/** Largest image a file can hold, in bytes. */
export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/** Largest side of an image, in pixels. Larger images are refused rather than decoded. */
export const MEDIA_MAX_SIDE = 16_384;

/** Fixed server-generated preview long-side sizes, smallest first. */
export const MEDIA_PREVIEW_SIZES = [256, 1024] as const;
export type MediaPreviewSize = (typeof MEDIA_PREVIEW_SIZES)[number];

/** Parses a preview size query parameter (`256` or `1024`), or null if invalid. */
export function parseMediaPreviewSize(value: string | null | undefined): MediaPreviewSize | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return (MEDIA_PREVIEW_SIZES as readonly number[]).includes(n) ? (n as MediaPreviewSize) : null;
}

/**
 * The dimensions a preview of `natural` capped to `maxSide` on its longest side
 * will have. Never upscales; always at least 1x1.
 */
export function mediaPreviewDimensions(
  natural: { readonly width: number; readonly height: number },
  maxSide: number,
): { readonly width: number; readonly height: number } {
  const longest = Math.max(natural.width, natural.height);
  if (longest <= maxSide) return { width: natural.width, height: natural.height };
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale)),
  };
}

function tiffOrientation(b: Uint8Array, start: number, end: number): number | null {
  if (end - start < 8) return null;
  const little = b[start] === 0x49 && b[start + 1] === 0x49;
  const big = b[start] === 0x4d && b[start + 1] === 0x4d;
  if (!little && !big) return null;
  const read16 = (at: number) => (little ? u16le(b, start + at) : u16be(b, start + at));
  const read32 = (at: number) =>
    little ? u16le(b, start + at) + u16le(b, start + at + 2) * 65536 : u32be(b, start + at);
  if (read16(2) !== 42) return null;
  const ifd = read32(4);
  if (start + ifd + 2 > end) return null;
  const count = Math.min(256, read16(ifd));
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (start + entry + 12 > end) break;
    if (read16(entry) === 0x0112) {
      if (read16(entry + 2) === 3 && read32(entry + 4) === 1) {
        const value = read16(entry + 8);
        if (value >= 1 && value <= 8) return value;
      }
      return null;
    }
  }
  return null;
}

/** Extracts EXIF orientation (1..8) from JPEG APP1 or WebP EXIF chunks. Defaults to 1. */
export function exifOrientation(b: Uint8Array): number {
  if (startsWith(b, [0xff, 0xd8])) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) break;
      while (b[i] === 0xff && i < b.length) i++;
      const marker = b[i] ?? 0;
      i++;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (marker === 0xd9 || marker === 0xda) break;
      const length = u16be(b, i);
      if (length < 2 || i + length > b.length) break;
      if (marker === 0xe1 && ascii(b, i + 2, "Exif\0\0")) {
        const found = tiffOrientation(b, i + 8, i + length);
        if (found !== null) return found;
      }
      i += length;
    }
    return 1;
  }
  if (b.length >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) {
    let i = 12;
    while (i + 8 <= b.length) {
      const len = u16le(b, i + 4) + u16le(b, i + 6) * 65536;
      const start = i + 8;
      const end = start + len;
      if (end > b.length) break;
      if (ascii(b, i, "EXIF")) {
        const tiffStart = ascii(b, start, "Exif\0\0") ? start + 6 : start;
        return tiffOrientation(b, tiffStart, end) ?? 1;
      }
      i = end + (len & 1);
    }
  }
  return 1;
}

/** Dimensions after applying EXIF orientation (swaps width and height for orientations 5..8). */
export function orientedSize(
  size: { readonly width: number; readonly height: number },
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } {
  const orientation = exifOrientation(bytes);
  return orientation >= 5 && orientation <= 8
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

export const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export interface SniffedImage {
  readonly mime: MediaType;
  readonly width: number;
  readonly height: number;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number) => u16be(b, i) * 65536 + u16be(b, i + 2);

function startsWith(b: Uint8Array, bytes: readonly number[], at = 0): boolean {
  return bytes.every((v, i) => b[at + i] === v);
}

function ascii(b: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function png(b: Uint8Array): SniffedImage | null {
  if (!startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  if (!ascii(b, 12, "IHDR")) return null;
  return { mime: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
}

function gif(b: Uint8Array): SniffedImage | null {
  if (!ascii(b, 0, "GIF87a") && !ascii(b, 0, "GIF89a")) return null;
  return { mime: "image/gif", width: u16le(b, 6), height: u16le(b, 8) };
}

/** Start-of-frame markers carry the image size; DHT (C4), JPG (C8) and DAC (CC) don't. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(b: Uint8Array): SniffedImage | null {
  if (!startsWith(b, [0xff, 0xd8, 0xff])) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    // Markers may be padded with extra 0xFF bytes.
    while (b[i] === 0xff && i < b.length) i++;
    const marker = b[i] ?? 0;
    i++;
    // Standalone markers have no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // End of image or start of scan before any frame header: no size to read.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, i);
    if (length < 2) return null;
    if (SOF.has(marker))
      return { mime: "image/jpeg", height: u16be(b, i + 3), width: u16be(b, i + 5) };
    i += length;
  }
  return null;
}

function webp(b: Uint8Array): SniffedImage | null {
  if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ")) {
    // Lossy: a frame tag (3 bytes), the start code 9D 01 2A, then 14-bit sizes.
    if (!startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null;
    return { mime: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return null;
    const b1 = b[21] ?? 0;
    const b2 = b[22] ?? 0;
    const b3 = b[23] ?? 0;
    const b4 = b[24] ?? 0;
    return {
      mime: "image/webp",
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  if (ascii(b, 12, "VP8X")) {
    return { mime: "image/webp", width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  }
  return null;
}

/**
 * Recognises a PNG, JPEG, WebP or GIF from its first bytes and reads its
 * pixel size. Returns null for anything else, including SVG, and for images
 * whose header is truncated or reports a zero size.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const found = png(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? gif(bytes);
  if (!found || found.width <= 0 || found.height <= 0) return null;
  return found;
}

/** A sentence for an image Drawpane can't take, or null when it is fine. */
export function mediaProblem(bytes: number, image: SniffedImage | null): string | null {
  if (bytes > MEDIA_MAX_BYTES)
    return "Images can be up to 20 MB. Export a smaller version and try again.";
  if (!image)
    return "Drawpane takes PNG, JPEG, WebP and GIF images. Convert the file and try again.";
  if (image.width > MEDIA_MAX_SIDE || image.height > MEDIA_MAX_SIDE)
    return "Images can be up to 16,384 px on a side. Resize it and try again.";
  return null;
}
