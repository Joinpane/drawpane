import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPreviewUploadsForTest, uploadMediaPreviews } from "./image-preview";
import { generatePreviews, resetWebpEncodeCacheForTest } from "./image-preview.worker";
import { UploadQueue } from "./media";

function fakePngHeader(width: number, height: number, totalBytes = 8192): Blob {
  const buf = new Uint8Array(Math.max(32, totalBytes));
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(buf.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([buf], { type: "image/png" });
}

function fakeJpegHeader(width: number, height: number, totalBytes = 64_000): Blob {
  const buf = new Uint8Array(Math.max(32, totalBytes));
  buf.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  const view = new DataView(buf.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return new Blob([buf], { type: "image/jpeg" });
}

afterEach(() => {
  resetPreviewUploadsForTest();
  resetWebpEncodeCacheForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client preview generation", () => {
  it("gates decompression bombs above MEDIA_PREVIEW_MAX_PIXELS before calling createImageBitmap", async () => {
    const decodeSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", decodeSpy);
    const bomb = fakePngHeader(16_384, 16_384, 128_000);
    const reply = await generatePreviews({ id: 1, blob: bomb });
    expect("error" in reply).toBe(false);
    if ("error" in reply) return;
    expect(reply.skipped).toBe("pixel-limit");
    expect(reply.previews).toEqual([]);
    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it("skips tiny images (<= 256 px and <= 4 KiB) without decoding", async () => {
    const decodeSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", decodeSpy);
    const tiny = fakePngHeader(128, 128, 1024);
    const reply = await generatePreviews({ id: 2, blob: tiny });
    expect("error" in reply).toBe(false);
    if ("error" in reply) return;
    expect(reply.skipped).toBe("small");
    expect(reply.previews).toEqual([]);
    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it("encodes opaque images as JPEG q80 and alpha images as WebP q80 (falling back to PNG when WebP encode is unsupported)", async () => {
    const encodedMimes: string[] = [];
    let webpSupported = true;
    let alphaPixel = 255;

    class FakeOffscreenCanvas {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          imageSmoothingEnabled: true,
          imageSmoothingQuality: "high",
          fillStyle: "",
          fillRect() {},
          drawImage() {},
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            const data = new Uint8ClampedArray(w * h * 4);
            data.fill(255);
            if (data.length >= 4) data[3] = alphaPixel;
            return { data };
          },
        };
      }
      async convertToBlob(opts?: { type?: string; quality?: number }) {
        const req = opts?.type ?? "image/png";
        // Simulate Safari returning image/png when image/webp encoding is unsupported.
        const actual = req === "image/webp" && !webpSupported ? "image/png" : req;
        encodedMimes.push(actual);
        return new Blob([new Uint8Array(512)], { type: actual });
      }
    }

    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.stubGlobal("createImageBitmap", async (_blob: Blob, opts?: ImageBitmapOptions) => ({
      width: opts?.resizeWidth ?? 1024,
      height: opts?.resizeHeight ?? 768,
      close() {},
    }));

    // 1. Opaque JPEG -> JPEG previews for both 1024 and 256.
    const opaque = await generatePreviews({ id: 1, blob: fakeJpegHeader(2000, 1500, 100_000) });
    expect("error" in opaque).toBe(false);
    if ("error" in opaque) return;
    expect(opaque.previews.map((p) => [p.size, p.blob.type])).toEqual([
      [1024, "image/jpeg"],
      [256, "image/jpeg"],
    ]);

    // 2. Alpha PNG with WebP encoder supported -> WebP previews.
    alphaPixel = 128;
    webpSupported = true;
    resetWebpEncodeCacheForTest();
    const alphaWebp = await generatePreviews({ id: 2, blob: fakePngHeader(2000, 1500, 100_000) });
    expect("error" in alphaWebp).toBe(false);
    if ("error" in alphaWebp) return;
    expect(alphaWebp.previews.map((p) => [p.size, p.blob.type])).toEqual([
      [1024, "image/webp"],
      [256, "image/webp"],
    ]);

    // 3. Alpha PNG without WebP encoder (Safari) -> PNG fallback.
    webpSupported = false;
    resetWebpEncodeCacheForTest();
    const alphaPng = await generatePreviews({ id: 3, blob: fakePngHeader(2000, 1500, 100_000) });
    expect("error" in alphaPng).toBe(false);
    if ("error" in alphaPng) return;
    expect(alphaPng.previews.map((p) => [p.size, p.blob.type])).toEqual([
      [1024, "image/png"],
      [256, "image/png"],
    ]);
  });

  it("uploadMediaPreviews swallows preview PUT failures and deduplicates per sha", async () => {
    const calls: string[] = [];
    const generate = vi.fn(async () => ({
      naturalWidth: 2000,
      naturalHeight: 1500,
      encodeMs: 4,
      previews: [
        {
          size: 256 as const,
          width: 256,
          height: 192,
          blob: new Blob([new Uint8Array(100)], { type: "image/jpeg" }),
        },
        {
          size: 1024 as const,
          width: 1024,
          height: 768,
          blob: new Blob([new Uint8Array(200)], { type: "image/jpeg" }),
        },
      ],
    }));
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/256")) return new Response("boom", { status: 500 });
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const sha = "a".repeat(64);
    const res1 = await uploadMediaPreviews(sha, new Blob(["orig"]), { generate, fetcher });
    expect(res1.generated).toBe(2);
    expect(res1.uploaded).toBe(0);
    expect(calls).toEqual([`/api/media/${sha}/previews/256`, `/api/media/${sha}/previews/1024`]);

    // Second call for the same sha is deduplicated without regenerating or re-uploading.
    const res2 = await uploadMediaPreviews(sha, new Blob(["orig"]), { generate, fetcher });
    expect(res2.generated).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("UploadQueue.add succeeds even when background preview PUT returns 500", async () => {
    const sha = "b".repeat(64);
    class FakeXHR {
      status = 201;
      responseText = JSON.stringify({
        sha,
        mime: "image/png",
        width: 2000,
        height: 1500,
        bytes: 16_384,
      });
      withCredentials = false;
      upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      send(blob: Blob) {
        queueMicrotask(() => {
          this.upload.onprogress?.({ loaded: blob.size });
          this.onload?.();
        });
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("server error", { status: 500 })),
    );

    const queue = new UploadQueue();
    const info = await queue.add("file-1", "photo.png", fakePngHeader(2000, 1500, 16_384), sha);
    expect(info.sha).toBe(sha);
    expect(queue.items[0]?.status).toBe("done");
  });
});
