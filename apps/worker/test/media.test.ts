import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Browser, signedInUser } from "./helpers";

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

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
function fakePng(width: number, height: number, bytes = 64): Uint8Array {
  const out = new Uint8Array(bytes);
  out.set(PNG.subarray(0, 16));
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
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
  });

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
