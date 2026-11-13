import { describe, expect, it } from "vitest";
import { MEDIA_MAX_BYTES, mediaProblem, sniffImage } from "../src/media";

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
});
