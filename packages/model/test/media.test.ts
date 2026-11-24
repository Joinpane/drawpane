import { describe, expect, it } from "vitest";
import {
  exifOrientation,
  MEDIA_MAX_BYTES,
  MEDIA_PREVIEW_SIZES,
  MEDIA_PREVIEW_VERSION,
  mediaPreviewBucketFor,
  mediaPreviewDimensions,
  mediaPreviewKey,
  mediaPreviewMatchesOriginal,
  mediaPreviewMaxBytes,
  mediaPreviewTiersFor,
  mediaProblem,
  orientedSize,
  parseMediaPreviewSize,
  sniffImage,
} from "../src/media";

// Node, browsers and Workers all have atob; the model compiles without DOM or Node types.
declare global {
  function atob(data: string): string;
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c: string) => c.charCodeAt(0));
const ascii = (s: string) => Uint8Array.from(s, (c: string) => c.charCodeAt(0));

/** 3 × 2 images in each format, made with ImageMagick. */
const FIXTURES = {
  png: "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACAQMAAACnuvRZAAAAA1BMVEX/Wh/UvrEcAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC",
  jpeg: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AaM50P//Z",
  gif: "R0lGODlhAwACAPAAAP9aHwAAACH5BAAAAAAALAAAAAADAAIAAAIChF8AOw==",
  webpLossy:
    "UklGRjoAAABXRUJQVlA4IC4AAADwAQCdASoDAAIAAgA0JaACdLoB+AAF9AAA2m/8/M7txfvS/9tD+tD+tD/lwAAA",
  webpLossless: "UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQrf73o/+BiOh/AAA=",
  webpExtended:
    "UklGRlwAAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAgICAgICAAFZQOCAuAAAA8AEAnQEqAwACAAIANCWgAnS6AfgABfQAANpv/PzO7cX70v/bQ/rQ/rQ/5cAAAA==",
};

describe("sniffImage", () => {
  it.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webpLossy", "image/webp"],
    ["webpLossless", "image/webp"],
    ["webpExtended", "image/webp"],
  ] as const)("reads %s", (name, mime) => {
    expect(sniffImage(b64(FIXTURES[name]))).toEqual({ mime, width: 3, height: 2 });
  });

  it("reads a progressive JPEG's frame header", () => {
    const prog = b64(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wgARCAAEAAUDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQBAQAAAAAAAAAAAAAAAAAAAAf/2gAMAwEAAhADEAAAAWM3T//Z",
    );
    expect(sniffImage(prog)).toEqual({ mime: "image/jpeg", width: 5, height: 4 });
  });

  it("refuses SVG, text, truncated headers and lying extensions", () => {
    expect(sniffImage(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(ascii("hello"))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(sniffImage(b64(FIXTURES.png).subarray(0, 12))).toBeNull();
    expect(sniffImage(b64(FIXTURES.jpeg).subarray(0, 40))).toBeNull();
  });

  it("explains what's wrong", () => {
    const png = sniffImage(b64(FIXTURES.png));
    expect(mediaProblem(100, png)).toBeNull();
    expect(mediaProblem(MEDIA_MAX_BYTES + 1, png)).toMatch(/up to 20 MB/);
    expect(mediaProblem(100, null)).toMatch(/PNG, JPEG, WebP and GIF/);
    expect(mediaProblem(100, { mime: "image/png", width: 20_000, height: 10 })).toMatch(/16,384/);
  });

  it("parses preview sizes and calculates preview dimensions without upscaling", () => {
    expect(MEDIA_PREVIEW_SIZES).toEqual([256, 1024]);
    expect(parseMediaPreviewSize("256")).toBe(256);
    expect(parseMediaPreviewSize("1024")).toBe(1024);
    expect(parseMediaPreviewSize("512")).toBeNull();
    expect(parseMediaPreviewSize("256px")).toBeNull();
    expect(parseMediaPreviewSize("")).toBeNull();
    expect(parseMediaPreviewSize(null)).toBeNull();

    expect(mediaPreviewDimensions({ width: 1206, height: 2622 }, 256)).toEqual({
      width: 118,
      height: 256,
    });
    expect(mediaPreviewDimensions({ width: 1206, height: 2622 }, 1024)).toEqual({
      width: 471,
      height: 1024,
    });
    expect(mediaPreviewDimensions({ width: 200, height: 100 }, 256)).toEqual({
      width: 200,
      height: 100,
    });
    expect(mediaPreviewKey("a".repeat(64), 256)).toBe(
      `media/previews/v${MEDIA_PREVIEW_VERSION}/${"a".repeat(64)}/256`,
    );
    expect(mediaPreviewTiersFor(200, 100)).toEqual([256]);
    expect(mediaPreviewTiersFor(1200, 800)).toEqual([256, 1024]);
    expect(mediaPreviewBucketFor(200, 100, 1024)).toBe(256);
    expect(mediaPreviewBucketFor(1200, 800, 1024)).toBe(1024);
    expect(mediaPreviewMaxBytes(256)).toBe(256 * 1024);
    expect(mediaPreviewMaxBytes(1024)).toBe(1024 * 1024);
    expect(
      mediaPreviewMatchesOriginal({ width: 4032, height: 3024 }, { width: 256, height: 192 }, 256),
    ).toEqual({ ok: true, swapped: false });
    expect(
      mediaPreviewMatchesOriginal({ width: 4032, height: 3024 }, { width: 192, height: 256 }, 256),
    ).toEqual({ ok: true, swapped: true });
    expect(
      mediaPreviewMatchesOriginal({ width: 4032, height: 3024 }, { width: 300, height: 225 }, 256),
    ).toEqual({ ok: false });
    expect(
      mediaPreviewMatchesOriginal({ width: 4032, height: 3024 }, { width: 256, height: 10 }, 256),
    ).toEqual({ ok: false });
  });

  it("reads EXIF orientation for rotated JPEGs", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x22,
      // "Exif\0\0"
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      // "II", 42, IFD offset = 8
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      // 1 entry: tag 0x0112, type SHORT (3), count 1, value 6
      0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
      // next IFD = 0, EOI
      0x00, 0x00, 0x00, 0x00, 0xff, 0xd9,
    ]);
    expect(exifOrientation(jpeg)).toBe(6);
    expect(orientedSize({ width: 400, height: 300 }, jpeg)).toEqual({ width: 300, height: 400 });
    expect(exifOrientation(b64(FIXTURES.png))).toBe(1);
  });
});
