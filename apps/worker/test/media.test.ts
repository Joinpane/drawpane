import { env } from "cloudflare:test";
import {
  MEDIA_PREVIEW_VERSION,
  mediaPreviewKey,
  mediaPreviewMaxBytes,
  sniffImage,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import phoneJpegUrl from "./fixtures/progressive-4032.jpg?inline";
import { Browser, signedInUser } from "./helpers";

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const PHONE_JPEG = b64(phoneJpegUrl.slice(phoneJpegUrl.indexOf(",") + 1));

/** 3 × 2 images, made with ImageMagick. */
const PNG = b64(
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACAQMAAACnuvRZAAAAA1BMVEX/Wh/UvrEcAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC",
);
const GIF = b64("R0lGODlhAwACAPAAAP9aHwAAACH5BAAAAAAALAAAAAADAAIAAAIChF8AOw==");
const WEBP = b64(
  "UklGRjoAAABXRUJQVlA4IC4AAADwAQCdASoDAAIAAgA0JaACdLoB+AAF9AAA2m/8/M7txfvS/9tD+tD+tD/lwAAA",
);
const JPEG = b64(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AaM50P//Z",
);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><script>alert(1)</script></svg>',
);

interface MediaInfo {
  sha: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

async function hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A PNG header claiming the given size, padded to `bytes`. Enough for the sniffer. */
function fakePng(width: number, height: number, bytes = 64, fill = 0): Uint8Array {
  const out = new Uint8Array(bytes).fill(fill);
  out.set(PNG.subarray(0, 16));
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

/** A minimal JPEG with optional EXIF orientation and SOF0 dimensions, padded to `bytes`. */
function fakeJpeg(width: number, height: number, orientation?: number, bytes = 16_384): Uint8Array {
  const exif =
    orientation !== undefined
      ? [
          0xff,
          0xe1,
          0x00,
          0x22,
          // "Exif\0\0"
          0x45,
          0x78,
          0x69,
          0x66,
          0x00,
          0x00,
          // "II", 42, IFD offset = 8
          0x49,
          0x49,
          0x2a,
          0x00,
          0x08,
          0x00,
          0x00,
          0x00,
          // 1 entry: orientation tag 0x0112, SHORT (3), count 1, value = orientation
          0x01,
          0x00,
          0x12,
          0x01,
          0x03,
          0x00,
          0x01,
          0x00,
          0x00,
          0x00,
          orientation,
          0x00,
          0x00,
          0x00,
          // next IFD = 0
          0x00,
          0x00,
          0x00,
          0x00,
        ]
      : [];
  const sof = [
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ];
  const header = new Uint8Array([0xff, 0xd8, ...exif, ...sof, 0xff, 0xda, 0x00, 0x02]);
  const out = new Uint8Array(Math.max(bytes, header.length + 2));
  out.set(header);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

/** A minimal VP8X WebP claiming `width` x `height`, optionally with an EXIF orientation chunk. */
function fakeWebp(width: number, height: number, orientation?: number, bytes = 16_384): Uint8Array {
  const exifPayload =
    orientation !== undefined
      ? new Uint8Array([
          // "II", 42, IFD offset = 8
          0x49,
          0x49,
          0x2a,
          0x00,
          0x08,
          0x00,
          0x00,
          0x00,
          // 1 entry: orientation tag 0x0112, SHORT (3), count 1, value = orientation
          0x01,
          0x00,
          0x12,
          0x01,
          0x03,
          0x00,
          0x01,
          0x00,
          0x00,
          0x00,
          orientation,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
        ])
      : null;
  const total = Math.max(bytes, 12 + 18 + (exifPayload ? 8 + exifPayload.length : 0));
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  const writeAscii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  writeAscii(0, "RIFF");
  dv.setUint32(4, total - 8, true);
  writeAscii(8, "WEBP");
  writeAscii(12, "VP8X");
  dv.setUint32(16, 10, true);
  out[20] = exifPayload ? 0x08 : 0x00;
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  out[24] = wMinus1 & 0xff;
  out[25] = (wMinus1 >> 8) & 0xff;
  out[26] = (wMinus1 >> 16) & 0xff;
  out[27] = hMinus1 & 0xff;
  out[28] = (hMinus1 >> 8) & 0xff;
  out[29] = (hMinus1 >> 16) & 0xff;
  if (exifPayload) {
    writeAscii(30, "EXIF");
    dv.setUint32(34, exifPayload.length, true);
    out.set(exifPayload, 38);
  }
  return out;
}

async function newFile(browser: Browser, projectId: string): Promise<string> {
  const { file } = await browser.json<{ file: { id: string } }>(
    `/api/projects/${projectId}/files`,
    { method: "POST", json: {} },
  );
  return file.id;
}

function upload(browser: Browser, fileId: string, body: Uint8Array, type = "image/png") {
  return browser.fetch(`/api/files/${fileId}/media`, {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
}

describe("media API", () => {
  it("sniffs formats by magic bytes, whatever the content type says", async () => {
    const { browser, projectId } = await signedInUser();
    const fileId = await newFile(browser, projectId);
    for (const [bytes, mime] of [
      [PNG, "image/png"],
      [GIF, "image/gif"],
      [WEBP, "image/webp"],
      [JPEG, "image/jpeg"],
    ] as const) {
      // Every upload claims to be a JPEG: the bytes decide.
      const response = await upload(browser, fileId, bytes, "image/jpeg");
      expect(response.status).toBe(201);
      const info = (await response.json()) as MediaInfo;
      expect(info).toEqual({
        sha: await hex(bytes),
        mime,
        width: 3,
        height: 2,
        bytes: bytes.byteLength,
      });
    }
  });

  it("refuses SVG, text and empty bodies with a sentence that says what to do", async () => {
    const { browser, projectId } = await signedInUser();
    const fileId = await newFile(browser, projectId);
    for (const body of [SVG, new TextEncoder().encode("not an image"), new Uint8Array()]) {
      const response = await upload(browser, fileId, body, "image/png");
      expect(response.status).toBe(415);
      const { error } = (await response.json()) as { error: { message: string } };
      expect(error.message).toMatch(/PNG, JPEG, WebP and GIF/);
    }
  });

  it("enforces the size limits", async () => {
    const { browser, projectId } = await signedInUser();
    const fileId = await newFile(browser, projectId);
    const big = await upload(browser, fileId, fakePng(10, 10, 20 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { message: string } }).error.message).toMatch(
      /up to 20 MB/,
    );
    const exactly = await upload(browser, fileId, fakePng(10, 10, 20 * 1024 * 1024));
    expect(exactly.status).toBe(201);
    const huge = await upload(browser, fileId, fakePng(20_000, 10));
    expect(huge.status).toBe(400);
  }, 30_000); // Uploads bodies past the 20 MiB limit, slow on a loaded runner.

  it("stores each image once and serves it with immutable caching", async () => {
    const { browser, projectId, teamId } = await signedInUser();
    const a = await newFile(browser, projectId);
    const b = await newFile(browser, projectId);
    const first = await upload(browser, a, PNG);
    expect(first.status).toBe(201);
    const { sha } = (await first.json()) as MediaInfo;
    // Same bytes from another file on the same team: nothing new.
    const again = await upload(browser, b, PNG);
    expect(again.status).toBe(200);
    expect(((await again.json()) as MediaInfo).sha).toBe(sha);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM media WHERE sha = ? AND team_id = ?",
    )
      .bind(sha, teamId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const listed = await env.FILES.list({ prefix: `media/${sha}` });
    expect(listed.objects).toHaveLength(1);

    const served = await browser.fetch(`/api/media/${sha}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    const cached = await browser.fetch(`/api/media/${sha}`, {
      headers: { "if-none-match": served.headers.get("etag") ?? "" },
    });
    expect(cached.status).toBe(304);

    const info = await browser.json<MediaInfo>(`/api/media/${sha}/info`);
    expect(info).toMatchObject({ sha, width: 3, height: 2, mime: "image/png" });
  });

  it("serves an image only to teams that uploaded it", async () => {
    const owner = await signedInUser("Owner");
    const viewer = await signedInUser("Viewer", "viewer", owner.teamId);
    const outsider = await signedInUser("Outsider");
    const fileId = await newFile(owner.browser, owner.projectId);
    const { sha } = (await (await upload(owner.browser, fileId, GIF)).json()) as MediaInfo;

    expect((await viewer.browser.fetch(`/api/media/${sha}`)).status).toBe(200);
    expect((await outsider.browser.fetch(`/api/media/${sha}`)).status).toBe(404);
    expect((await outsider.browser.fetch(`/api/media/${sha}/info`)).status).toBe(404);
    expect((await new Browser().fetch(`/api/media/${sha}`)).status).toBe(401);
    expect((await owner.browser.fetch("/api/media/not-a-hash")).status).toBe(404);

    // Viewers can't upload; outsiders can't see the file at all.
    expect((await upload(viewer.browser, fileId, PNG)).status).toBe(403);
    expect((await upload(outsider.browser, fileId, PNG)).status).toBe(404);

    // Once the outsider's team uploads the same bytes, they can read it too.
    const theirs = await newFile(outsider.browser, outsider.projectId);
    expect((await upload(outsider.browser, theirs, GIF)).status).toBe(201);
    expect((await outsider.browser.fetch(`/api/media/${sha}`)).status).toBe(200);
  });

  it("refuses cross-site uploads", async () => {
    const { browser, projectId } = await signedInUser();
    const fileId = await newFile(browser, projectId);
    const response = await browser.fetch(`/api/files/${fileId}/media`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "image/png" },
      body: PNG,
    });
    expect(response.status).toBe(403);
  });
});

describe("media previews API", () => {
  function putPreview(
    browser: Browser,
    sha: string,
    size: number | string,
    body: Uint8Array,
    type = "image/png",
    extraHeaders: Record<string, string> = {},
  ) {
    return browser.fetch(`/api/media/${sha}/previews/${size}`, {
      method: "PUT",
      headers: { "content-type": type, ...extraHeaders },
      body,
    });
  }

  it("uploads originals without generating previews server-side and streams originals when previews are missing", async () => {
    const { browser, projectId, teamId } = await signedInUser();
    const fileId = await newFile(browser, projectId);
    const up = await upload(browser, fileId, PHONE_JPEG, "image/jpeg");
    expect(up.status).toBe(201);
    const { sha } = (await up.json()) as MediaInfo;

    // Upload never creates previews in R2 (zero server decode/encode CPU).
    expect(await env.FILES.head(mediaPreviewKey(teamId, sha, 256))).toBeNull();
    expect(await env.FILES.head(mediaPreviewKey(teamId, sha, 1024))).toBeNull();

    // Missing preview streams the original directly with no-cache and X-Image-Preview-Missing: 1.
    const miss = await browser.fetch(`/api/media/${sha}?w=256`);
    expect(miss.status).toBe(200);
    expect(miss.headers.get("content-type")).toBe("image/jpeg");
    expect(miss.headers.get("cache-control")).toBe("private, no-cache");
    expect(miss.headers.get("x-image-preview")).toBeNull();
    expect(miss.headers.get("x-image-preview-missing")).toBe("1");
    expect(new Uint8Array(await miss.arrayBuffer())).toEqual(PHONE_JPEG);

    // Invalid ?w= values are rejected cleanly.
    for (const bad of ["0", "-1", "500", "abc", "256px"]) {
      expect((await browser.fetch(`/api/media/${sha}?w=${bad}`)).status, bad).toBe(400);
    }
  });

  it("stores validated client previews under versioned team-scoped keys, deduplicates, and serves with immutable caching", async () => {
    const { browser, projectId, teamId } = await signedInUser();
    const fileId = await newFile(browser, projectId);
    const up = await upload(browser, fileId, PHONE_JPEG, "image/jpeg");
    expect(up.status).toBe(201);
    const { sha } = (await up.json()) as MediaInfo;

    const preview256 = fakePng(256, 192, 2048);
    const preview1024 = fakePng(1024, 768, 8192);

    const first = await putPreview(browser, sha, 256, preview256, "image/png", {
      "x-preview-width": "256",
      "x-preview-height": "192",
      "x-image-width": "4032",
      "x-image-height": "3024",
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ ok: true, cached: false });

    // Stored under a versioned, team-scoped key separate from media/<sha>.
    const key256 = mediaPreviewKey(teamId, sha, 256);
    expect(key256).toBe(`media/previews/v${MEDIA_PREVIEW_VERSION}/${teamId}/${sha}/256`);
    expect(await env.FILES.head(key256)).not.toBeNull();

    // Second upload for the same sha+size deduplicates cleanly.
    const dup = await putPreview(browser, sha, 256, preview256, "image/png");
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual({ ok: true, cached: true });

    const put1024 = await putPreview(browser, sha, 1024, preview1024, "image/png");
    expect(put1024.status).toBe(201);

    for (const [size, expected] of [
      [256, preview256],
      [1024, preview1024],
    ] as const) {
      const res = await browser.fetch(`/api/media/${sha}?w=${size}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
      expect(res.headers.get("x-image-preview")).toBe(String(size));
      expect(res.headers.get("x-image-preview-missing")).toBeNull();
      expect(res.headers.get("x-image-width")).toBe("4032");
      expect(res.headers.get("x-image-height")).toBe("3024");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(expected);

      const notModified = await browser.fetch(`/api/media/${sha}?w=${size}`, {
        headers: { "if-none-match": res.headers.get("etag") ?? "" },
      });
      expect(notModified.status).toBe(304);
      expect(notModified.headers.get("x-image-preview")).toBe(String(size));
    }

    // Bare original URL always returns the untouched original bytes.
    const full = await browser.fetch(`/api/media/${sha}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("image/jpeg");
    expect(full.headers.get("x-image-preview")).toBeNull();
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(PHONE_JPEG);
  });

  it("enforces access control and rejects oversized, invalid or mismatched previews", async () => {
    const owner = await signedInUser("Owner");
    const viewer = await signedInUser("Viewer", "viewer", owner.teamId);
    const outsider = await signedInUser("Outsider");
    const fileId = await newFile(owner.browser, owner.projectId);
    const largeOrig = fakePng(4032, 3024, 16_384);
    const { sha } = (await (
      await upload(owner.browser, fileId, largeOrig, "image/png")
    ).json()) as MediaInfo;

    const valid256 = fakePng(256, 192, 1024);

    // Access control matches originals: anonymous 401, outsider 404, viewer 403.
    expect((await putPreview(new Browser(), sha, 256, valid256)).status).toBe(401);
    expect((await putPreview(outsider.browser, sha, 256, valid256)).status).toBe(404);
    expect((await putPreview(viewer.browser, sha, 256, valid256)).status).toBe(403);

    // Invalid tier size.
    expect((await putPreview(owner.browser, sha, 512, valid256)).status).toBe(400);

    // Unsupported content-type (GIF, SVG) and spoofed magic bytes.
    expect((await putPreview(owner.browser, sha, 256, GIF, "image/gif")).status).toBe(415);
    expect((await putPreview(owner.browser, sha, 256, SVG, "image/svg+xml")).status).toBe(415);
    expect((await putPreview(owner.browser, sha, 256, valid256, "image/webp")).status).toBe(415);

    // Oversized preview exceeding tier byte cap.
    const tooBig = fakePng(256, 192, mediaPreviewMaxBytes(256) + 1);
    expect((await putPreview(owner.browser, sha, 256, tooBig)).status).toBe(413);

    // Dimensions exceeding tier or mismatched aspect ratio.
    const overTier = fakePng(512, 384, 1024);
    expect((await putPreview(owner.browser, sha, 256, overTier)).status).toBe(400);
    const wrongAspect = fakePng(256, 32, 1024);
    expect((await putPreview(owner.browser, sha, 256, wrongAspect)).status).toBe(400);

    // Lying declared dimension headers are rejected.
    expect(
      (
        await putPreview(owner.browser, sha, 256, valid256, "image/png", {
          "x-preview-width": "200",
          "x-preview-height": "150",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await putPreview(owner.browser, sha, 256, valid256, "image/png", {
          "x-image-width": "100",
          "x-image-height": "100",
        })
      ).status,
    ).toBe(400);
    // Swapped natural dimensions cannot be declared on an unswapped landscape preview.
    expect(
      (
        await putPreview(owner.browser, sha, 256, valid256, "image/png", {
          "x-image-width": "3024",
          "x-image-height": "4032",
        })
      ).status,
    ).toBe(400);

    // Swapped aspect (192x256 for a 4032x3024 PNG) MUST be rejected because PNG has no EXIF orientation.
    const rotated = fakePng(192, 256, 1024);
    expect(
      (
        await putPreview(owner.browser, sha, 256, rotated, "image/png", {
          "x-preview-width": "192",
          "x-preview-height": "256",
          "x-image-width": "3024",
          "x-image-height": "4032",
        })
      ).status,
    ).toBe(400);

    // Non-rotated JPEG (orientation 1) also rejects swapped preview dimensions.
    const uprightJpeg = fakeJpeg(4032, 3024, 1, 16_384);
    const { sha: uprightJpegSha } = (await (
      await upload(owner.browser, fileId, uprightJpeg, "image/jpeg")
    ).json()) as MediaInfo;
    expect((await putPreview(owner.browser, uprightJpegSha, 256, rotated)).status).toBe(400);

    // JPEG with EXIF orientation 6 (90 deg CW) rejects unswapped 256x192 and accepts swapped 192x256.
    const rotatedJpeg = fakeJpeg(4032, 3024, 6, 16_384);
    const { sha: rotJpegSha } = (await (
      await upload(owner.browser, fileId, rotatedJpeg, "image/jpeg")
    ).json()) as MediaInfo;
    expect((await putPreview(owner.browser, rotJpegSha, 256, valid256)).status).toBe(400);
    const okJpeg = await putPreview(owner.browser, rotJpegSha, 256, rotated, "image/png", {
      "x-preview-width": "192",
      "x-preview-height": "256",
      "x-image-width": "3024",
      "x-image-height": "4032",
    });
    expect(okJpeg.status).toBe(201);
    const served = await viewer.browser.fetch(`/api/media/${rotJpegSha}?w=256`);
    expect(served.status).toBe(200);
    expect(served.headers.get("x-image-width")).toBe("3024");
    expect(served.headers.get("x-image-height")).toBe("4032");
    expect(sniffImage(new Uint8Array(await served.arrayBuffer()))).toEqual({
      mime: "image/png",
      width: 192,
      height: 256,
    });

    // Plain WebP without EXIF rejects swapped dimensions; WebP with EXIF orientation 6 accepts swapped.
    const plainWebp = fakeWebp(4032, 3024, undefined, 16_384);
    const { sha: plainWebpSha } = (await (
      await upload(owner.browser, fileId, plainWebp, "image/webp")
    ).json()) as MediaInfo;
    expect((await putPreview(owner.browser, plainWebpSha, 256, rotated)).status).toBe(400);

    const rotWebp = fakeWebp(4032, 3024, 6, 16_384);
    const { sha: rotWebpSha } = (await (
      await upload(owner.browser, fileId, rotWebp, "image/webp")
    ).json()) as MediaInfo;
    expect((await putPreview(owner.browser, rotWebpSha, 256, valid256)).status).toBe(400);
    const okWebp = await putPreview(owner.browser, rotWebpSha, 256, rotated, "image/png", {
      "x-preview-width": "192",
      "x-preview-height": "256",
      "x-image-width": "3024",
      "x-image-height": "4032",
    });
    expect(okWebp.status).toBe(201);

    // Preview must be smaller than the original image.
    const smallOrig = fakePng(200, 100, 512);
    const { sha: smallSha } = (await (
      await upload(owner.browser, fileId, smallOrig, "image/png")
    ).json()) as MediaInfo;
    expect(
      (await putPreview(owner.browser, smallSha, 256, fakePng(200, 100, 512), "image/png")).status,
    ).toBe(400);
    // Asking to store a 1024 tier for a 200x100 image is rejected (only 256 applies).
    expect(
      (await putPreview(owner.browser, smallSha, 1024, fakePng(200, 100, 128), "image/png")).status,
    ).toBe(400);
  });

  it("isolates previews per team so another team's PUT for the same sha cannot poison team A", async () => {
    const teamA = await signedInUser("Team A");
    const teamB = await signedInUser("Team B");
    expect(teamA.teamId).not.toBe(teamB.teamId);

    const original = fakePng(4032, 3024, 32_768, 0x11);
    const fileA = await newFile(teamA.browser, teamA.projectId);
    const fileB = await newFile(teamB.browser, teamB.projectId);
    const { sha } = (await (await upload(teamA.browser, fileA, original)).json()) as MediaInfo;
    const { sha: shaB } = (await (
      await upload(teamB.browser, fileB, original)
    ).json()) as MediaInfo;
    expect(shaB).toBe(sha);

    // Team B uploads a preview first.
    const teamBPreview = fakePng(256, 192, 2048, 0xee);
    const putB = await putPreview(teamB.browser, sha, 256, teamBPreview);
    expect(putB.status).toBe(201);
    expect(await putB.json()).toEqual({ ok: true, cached: false });

    // Team A must NOT see Team B's preview (falls back to untouched original with missing header).
    const missA = await teamA.browser.fetch(`/api/media/${sha}?w=256`);
    expect(missA.status).toBe(200);
    expect(missA.headers.get("x-image-preview")).toBeNull();
    expect(missA.headers.get("x-image-preview-missing")).toBe("1");
    expect(new Uint8Array(await missA.arrayBuffer())).toEqual(original);

    // Team A can store its own preview without being blocked as cached by Team B's PUT.
    const teamAPreview = fakePng(256, 192, 2048, 0xaa);
    const putA = await putPreview(teamA.browser, sha, 256, teamAPreview);
    expect(putA.status).toBe(201);
    expect(await putA.json()).toEqual({ ok: true, cached: false });

    // Each team reads only its own preview bytes.
    const hitA = await teamA.browser.fetch(`/api/media/${sha}?w=256`);
    expect(hitA.headers.get("x-image-preview")).toBe("256");
    expect(new Uint8Array(await hitA.arrayBuffer())).toEqual(teamAPreview);

    const hitB = await teamB.browser.fetch(`/api/media/${sha}?w=256`);
    expect(hitB.headers.get("x-image-preview")).toBe("256");
    expect(new Uint8Array(await hitB.arrayBuffer())).toEqual(teamBPreview);
  });

  it("enforces write-once semantics under concurrent PUTs for the same team, sha and size", async () => {
    const user = await signedInUser("Race");
    const fileId = await newFile(user.browser, user.projectId);
    const original = fakePng(4032, 3024, 32_768, 0x22);
    const { sha } = (await (await upload(user.browser, fileId, original)).json()) as MediaInfo;

    const bodies = [1, 2, 3, 4, 5, 6].map((fill) => ({
      fill,
      bytes: fakePng(256, 192, 2048, fill),
    }));
    const results = await Promise.all(
      bodies.map(async ({ fill, bytes }) => {
        const res = await putPreview(user.browser, sha, 256, bytes);
        const body = (await res.json()) as { ok: boolean; cached: boolean };
        return { fill, status: res.status, ...body };
      }),
    );

    const winners = results.filter((r) => r.status === 201 && !r.cached);
    const cached = results.filter((r) => r.status === 200 && r.cached);
    expect(winners).toHaveLength(1);
    expect(cached).toHaveLength(5);

    const stored = await env.FILES.get(mediaPreviewKey(user.teamId, sha, 256));
    expect(stored).not.toBeNull();
    if (!stored) return;
    const storedBytes = new Uint8Array(await stored.arrayBuffer());
    expect(storedBytes[100]).toBe(winners[0]?.fill);
  });
});

describe("thumbnails API", () => {
  function putThumbnail(browser: Browser, fileId: string, body: Uint8Array, type = "image/png") {
    return browser.fetch(`/api/files/${fileId}/thumbnail`, {
      method: "PUT",
      headers: { "content-type": type },
      body,
    });
  }

  it("stores a thumbnail, bumps thumbnail_at and serves it to viewers", async () => {
    const owner = await signedInUser("Owner");
    const viewer = await signedInUser("Viewer", "viewer", owner.teamId);
    const fileId = await newFile(owner.browser, owner.projectId);

    const meta = await owner.browser.json<{ file: { thumbnailAt: number | null } }>(
      `/api/files/${fileId}`,
    );
    expect(meta.file.thumbnailAt).toBeNull();
    expect((await viewer.browser.fetch(`/api/files/${fileId}/thumbnail`)).status).toBe(404);

    const put = await putThumbnail(owner.browser, fileId, PNG);
    expect(put.status).toBe(200);
    const { thumbnailAt } = (await put.json()) as { thumbnailAt: number };
    expect(thumbnailAt).toBeGreaterThan(0);

    const list = await owner.browser.json<{ files: Array<{ id: string; thumbnailAt: number }> }>(
      `/api/teams/${owner.teamId}/files`,
    );
    expect(list.files.find((f) => f.id === fileId)?.thumbnailAt).toBe(thumbnailAt);

    const versioned = await viewer.browser.fetch(`/api/files/${fileId}/thumbnail?v=${thumbnailAt}`);
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get("content-type")).toBe("image/png");
    expect(versioned.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await versioned.arrayBuffer())).toEqual(PNG);
    const bare = await viewer.browser.fetch(`/api/files/${fileId}/thumbnail`);
    expect(bare.headers.get("cache-control")).toBe("private, no-cache");

    // A second save always moves the version forward.
    const second = (await (
      await putThumbnail(owner.browser, fileId, WEBP, "image/webp")
    ).json()) as {
      thumbnailAt: number;
    };
    expect(second.thumbnailAt).toBeGreaterThan(thumbnailAt);
    const now = await viewer.browser.fetch(`/api/files/${fileId}/thumbnail`);
    expect(now.headers.get("content-type")).toBe("image/webp");
  });

  it("checks role, type and size", async () => {
    const owner = await signedInUser("Owner");
    const viewer = await signedInUser("Viewer", "viewer", owner.teamId);
    const outsider = await signedInUser("Outsider");
    const fileId = await newFile(owner.browser, owner.projectId);

    expect((await putThumbnail(viewer.browser, fileId, PNG)).status).toBe(403);
    expect((await putThumbnail(outsider.browser, fileId, PNG)).status).toBe(404);
    // JPEG and GIF aren't thumbnail formats, and the bytes must match the declared type.
    expect((await putThumbnail(owner.browser, fileId, JPEG, "image/jpeg")).status).toBe(415);
    expect((await putThumbnail(owner.browser, fileId, PNG, "image/webp")).status).toBe(415);
    expect((await putThumbnail(owner.browser, fileId, SVG, "image/png")).status).toBe(415);
    expect(
      (await putThumbnail(owner.browser, fileId, fakePng(10, 10, 1024 * 1024 + 1))).status,
    ).toBe(413);
    expect((await putThumbnail(owner.browser, fileId, fakePng(4000, 10))).status).toBe(400);

    await putThumbnail(owner.browser, fileId, PNG);
    expect((await outsider.browser.fetch(`/api/files/${fileId}/thumbnail`)).status).toBe(404);
  });

  it("clears a thumbnail and removes it with the file", async () => {
    const { browser, projectId } = await signedInUser();
    const fileId = await newFile(browser, projectId);
    await putThumbnail(browser, fileId, PNG);
    await browser.json(`/api/files/${fileId}/thumbnail`, { method: "DELETE" });
    expect((await browser.fetch(`/api/files/${fileId}/thumbnail`)).status).toBe(404);
    expect(await env.FILES.head(`files/${fileId}/thumbnail`)).toBeNull();

    await putThumbnail(browser, fileId, PNG);
    expect(await env.FILES.head(`files/${fileId}/thumbnail`)).not.toBeNull();
    await browser.json(`/api/files/${fileId}`, { method: "DELETE" });
    await browser.json(`/api/files/${fileId}?permanent=1`, { method: "DELETE" });
    expect(await env.FILES.head(`files/${fileId}/thumbnail`)).toBeNull();
  });
});
