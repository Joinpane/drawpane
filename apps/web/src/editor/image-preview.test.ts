import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueMediaPreviews,
  generateClientPreviews,
  MAX_CONCURRENT_PREVIEW_JOBS,
  resetPreviewUploadsForTest,
  uploadMediaPreviews,
} from "./image-preview";
import {
  createPreviewWorkerQueue,
  generatePreviews,
  MAX_PREVIEW_WORKER_CONCURRENCY,
  type PreviewWorkerReply,
  type PreviewWorkerRequest,
  resetWebpEncodeCacheForTest,
} from "./image-preview.worker";
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

  it("aborts stalled preview PUTs after putTimeoutMs without hanging", async () => {
    const signals: AbortSignal[] = [];
    const generate = vi.fn(async () => ({
      naturalWidth: 2000,
      naturalHeight: 1500,
      encodeMs: 2,
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
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      // Stall forever until aborted.
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    const sha = "c".repeat(64);
    const res = await uploadMediaPreviews(sha, new Blob(["orig"]), {
      generate,
      fetcher,
      putTimeoutMs: 25,
    });
    expect(res.generated).toBe(2);
    expect(res.uploaded).toBe(0);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("caps worker dispatch concurrency, times out a hung worker, and recovers for queued jobs", async () => {
    let createdWorkers = 0;
    let terminatedWorkers = 0;
    let activeInWorker = 0;
    let peakInWorker = 0;
    const inflight: Array<{
      worker: FakeWorker;
      req: PreviewWorkerRequest;
      hang: boolean;
    }> = [];

    class FakeWorker {
      onmessage: ((event: MessageEvent<PreviewWorkerReply>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      constructor() {
        createdWorkers++;
      }
      postMessage(req: PreviewWorkerRequest) {
        activeInWorker++;
        peakInWorker = Math.max(peakInWorker, activeInWorker);
        const hang = req.blob.size === 99;
        inflight.push({ worker: this, req, hang });
        if (!hang) {
          setTimeout(() => {
            if (this.terminated) return;
            activeInWorker--;
            this.onmessage?.({
              data: {
                id: req.id,
                naturalWidth: 1000,
                naturalHeight: 750,
                previews: [],
                encodeMs: 1,
              },
            } as unknown as MessageEvent<PreviewWorkerReply>);
          }, 10);
        }
      }
      terminate() {
        if (!this.terminated) {
          this.terminated = true;
          terminatedWorkers++;
          activeInWorker = 0;
        }
      }
    }

    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("OffscreenCanvas", class {});

    // 1. Dispatch 8 concurrent jobs -> worker never receives more than MAX_CONCURRENT_PREVIEW_JOBS at once.
    const batch = Array.from({ length: 8 }, () =>
      generateClientPreviews(new Blob([new Uint8Array(10)]), { timeoutMs: 200 }),
    );
    const settled = await Promise.all(batch);
    expect(settled.every((r) => r !== null && r.naturalWidth === 1000)).toBe(true);
    expect(peakInWorker).toBeLessThanOrEqual(MAX_CONCURRENT_PREVIEW_JOBS);
    expect(peakInWorker).toBe(MAX_CONCURRENT_PREVIEW_JOBS);

    // 2. A hung job times out, terminates the hung worker, and a queued job succeeds on a fresh worker.
    const hung = generateClientPreviews(new Blob([new Uint8Array(99)]), { timeoutMs: 30 });
    const hung2 = generateClientPreviews(new Blob([new Uint8Array(99)]), { timeoutMs: 30 });
    const queued = generateClientPreviews(new Blob([new Uint8Array(10)]), { timeoutMs: 200 });
    await expect(hung).rejects.toThrow(/timed out/i);
    await expect(hung2).rejects.toThrow(/timed out/i);
    const recovered = await queued;
    expect(recovered?.naturalWidth).toBe(1000);
    expect(terminatedWorkers).toBeGreaterThanOrEqual(1);
    expect(createdWorkers).toBeGreaterThanOrEqual(2);
  });

  it("createPreviewWorkerQueue caps concurrent full-image decodes inside the worker", async () => {
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const replies: PreviewWorkerReply[] = [];

    const enqueue = createPreviewWorkerQueue(
      async (req) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active--;
        return {
          id: req.id,
          naturalWidth: 2000,
          naturalHeight: 1500,
          previews: [],
          encodeMs: 1,
        };
      },
      (reply) => replies.push(reply),
    );

    // Drop 10 jobs at once onto the worker queue.
    for (let i = 1; i <= 10; i++) {
      enqueue({ id: i, blob: new Blob(["x"]) });
    }
    expect(active).toBe(MAX_PREVIEW_WORKER_CONCURRENCY);
    expect(peak).toBe(MAX_PREVIEW_WORKER_CONCURRENCY);

    // Release jobs one by one and confirm concurrency never exceeds the cap.
    while (replies.length < 10) {
      const next = gates.shift();
      if (next) next();
      await new Promise((r) => setTimeout(r, 0));
      expect(peak).toBeLessThanOrEqual(MAX_PREVIEW_WORKER_CONCURRENCY);
    }
    expect(replies).toHaveLength(10);
  });

  it("enqueueMediaPreviews runs in the background without blocking and bounds concurrency", async () => {
    let active = 0;
    let peak = 0;
    const completed: string[] = [];
    const gates: Array<() => void> = [];

    const generate = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active--;
      return {
        naturalWidth: 1000,
        naturalHeight: 750,
        encodeMs: 1,
        previews: [],
      };
    });

    for (let i = 0; i < 6; i++) {
      const sha = String(i).repeat(64);
      enqueueMediaPreviews(sha, new Blob(["img"]), {
        generate: async () => {
          const out = await generate();
          completed.push(sha);
          return out;
        },
      });
    }

    // Duplicate sha is skipped cleanly.
    enqueueMediaPreviews("0".repeat(64), new Blob(["img"]), { generate });

    expect(active).toBe(MAX_CONCURRENT_PREVIEW_JOBS);
    expect(peak).toBe(MAX_CONCURRENT_PREVIEW_JOBS);
    while (completed.length < 6) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
      expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_PREVIEW_JOBS);
    }
    expect(generate).toHaveBeenCalledTimes(6);
  });
});
