/**
 * Dedicated snapshot Worker (decision 0040, W2): runs the browser CPU build
 * (`@drawpane/engine/browser-glue`) off the main thread for every browser picture that is not
 * the live canvas (raster exports, export preview, dashboard thumbnails, component/library
 * previews, new-file template previews, and prototype overlays and screen thumbnails).
 *
 * Uses the browser build (like `engine-cpu.worker.ts`) rather than the 25 MiB Cloudflare Worker
 * build so 2x/3x photo exports keep full drawn sharpness and large kit pages stay within graph
 * and message limits, while PNG renders still stream band by band (`renderPngStream`).
 *
 * Each job creates a fresh `RenderEngine` and disposes it in `finally`, so every snapshot starts
 * at zero held bytes, stays deterministic across runs, and recovers automatically from any trap.
 */

import type { RasterFormat } from "@drawpane/editor";
import {
  type Camera,
  type EngineModule,
  ErrorCode,
  RenderEngine,
  smallerImageLevel,
} from "@drawpane/engine";
import { loadBrowserEngine } from "@drawpane/engine/browser";
import { imageDecoder } from "@drawpane/engine/decode";
import decoderWasmUrl from "@drawpane/engine/decoder.wasm?url";

export type SnapshotImageTransfer =
  | {
      readonly kind: "blob";
      readonly handle: number;
      readonly blob: Blob;
      readonly naturalWidth: number;
      readonly naturalHeight: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "rgba";
      readonly handle: number;
      readonly width: number;
      readonly height: number;
      readonly pixels: ArrayBuffer;
    };

export type SnapshotWorkerRequest =
  | { readonly type: "init" }
  | {
      readonly type: "render";
      readonly jobId: number;
      readonly format: RasterFormat;
      readonly quality: number;
      readonly maxBytes?: number;
      readonly width: number;
      readonly height: number;
      readonly imageBudget: number;
      readonly camera: Camera;
      readonly background: readonly [number, number, number, number];
      readonly list: ArrayBuffer;
      readonly images: readonly SnapshotImageTransfer[];
    }
  | { readonly type: "cancel"; readonly jobId: number }
  | { readonly type: "dispose" };

export type SnapshotWorkerReply =
  | { readonly type: "ready" }
  | {
      readonly type: "done";
      readonly jobId: number;
      readonly mime: string;
      readonly bytes: ArrayBuffer;
      readonly reducedImages: number;
      readonly omittedImages: number;
    }
  | { readonly type: "cancelled"; readonly jobId: number }
  | {
      readonly type: "error";
      readonly jobId?: number;
      readonly code: ErrorCode | null;
      readonly message: string;
    };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SnapshotWorkerRequest>) => void) | null;
  postMessage(message: SnapshotWorkerReply, transfer?: Transferable[]): void;
};

const post = (message: SnapshotWorkerReply, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer);

/** Yield every ~16 ms on long jobs so incoming cancel messages take effect between bands. */
const YIELD_INTERVAL_MS = 16;
const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const DECODER_BUDGET = 16 << 20;

let engineModule: EngineModule | null = null;
let wasmDecoderPromise: Promise<ReturnType<typeof imageDecoder> | null> | null = null;
let disposed = false;
let lastFinishedJobId = 0;
const cancelled = new Set<number>();

function pruneCancelled(): void {
  for (const id of cancelled) {
    if (id <= lastFinishedJobId) cancelled.delete(id);
  }
}

/** Lazy streaming/banded Wasm decoder fallback (#257) when browser bitmap decode fails. */
function getWasmDecoder(): Promise<ReturnType<typeof imageDecoder> | null> {
  if (!wasmDecoderPromise) {
    wasmDecoderPromise = (async () => {
      try {
        const [glue, response] = await Promise.all([
          import("@drawpane/engine/decoder-glue"),
          fetch(decoderWasmUrl),
        ]);
        if (!response.ok) return null;
        const mod = await WebAssembly.compile(await response.arrayBuffer());
        return imageDecoder(glue, mod);
      } catch {
        return null;
      }
    })();
  }
  return wasmDecoderPromise;
}

async function decodeTargetRgba(
  blob: Blob,
  natural: { width: number; height: number },
  target: { width: number; height: number },
  isCancelled: () => boolean,
): Promise<{ width: number; height: number; rgba: Uint8Array } | null> {
  if (typeof createImageBitmap === "function" && typeof OffscreenCanvas !== "undefined") {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(blob, {
        resizeWidth: target.width,
        resizeHeight: target.height,
        resizeQuality: "high",
      });
      if (isCancelled()) return null;
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = surface.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
        const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        return {
          width: bitmap.width,
          height: bitmap.height,
          rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        };
      }
    } catch {
      // Fall through to streaming Wasm decoder below.
    } finally {
      bitmap?.close();
    }
  }
  const decoder = await getWasmDecoder();
  if (!decoder || isCancelled()) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (isCancelled()) return null;
  const decoded = decoder.decode(
    { width: natural.width, height: natural.height, bytes },
    target,
    DECODER_BUDGET,
  );
  if (!decoded || decoded === "too-large") return null;
  return { width: target.width, height: target.height, rgba: decoded };
}

async function decodeAndUploadBlob(
  engine: RenderEngine,
  image: Extract<SnapshotImageTransfer, { kind: "blob" }>,
  isCancelled: () => boolean,
): Promise<
  { ok: true; reduced: boolean; omitted: boolean } | { ok: false; code: ErrorCode; message: string }
> {
  const wantedWidth = Math.max(1, image.width);
  const wantedHeight = Math.max(1, image.height);
  let target: { width: number; height: number } | null = {
    width: wantedWidth,
    height: wantedHeight,
  };
  let stepped = false;
  while (target) {
    if (isCancelled()) return { ok: true, reduced: false, omitted: false };
    try {
      const decoded = await decodeTargetRgba(
        image.blob,
        { width: Math.max(1, image.naturalWidth), height: Math.max(1, image.naturalHeight) },
        target,
        isCancelled,
      );
      if (isCancelled()) return { ok: true, reduced: false, omitted: false };
      if (decoded) {
        const uploaded = engine.putImage(
          image.handle,
          decoded.width,
          decoded.height,
          decoded.rgba,
          false,
        );
        if (uploaded.ok) {
          return {
            ok: true,
            reduced: stepped || decoded.width < wantedWidth || decoded.height < wantedHeight,
            omitted: false,
          };
        }
        if (uploaded.code === ErrorCode.Trap) return uploaded;
        if (uploaded.code !== ErrorCode.Limit) {
          return { ok: true, reduced: false, omitted: true };
        }
      }
    } catch {
      return { ok: true, reduced: false, omitted: true };
    }
    stepped = true;
    target = smallerImageLevel(target.width, target.height);
  }
  return { ok: true, reduced: false, omitted: true };
}

async function runJob(job: Extract<SnapshotWorkerRequest, { type: "render" }>): Promise<void> {
  const isCancelled = () => disposed || cancelled.has(job.jobId);
  if (isCancelled()) {
    lastFinishedJobId = Math.max(lastFinishedJobId, job.jobId);
    pruneCancelled();
    post({ type: "cancelled", jobId: job.jobId });
    return;
  }
  if (!engineModule) {
    post({
      type: "error",
      jobId: job.jobId,
      code: ErrorCode.State,
      message: "Snapshot worker is not initialized",
    });
    return;
  }

  const engine = new RenderEngine(engineModule, {
    glyphMaskBytes: 16 << 20,
    imageBytes: Math.max(6 << 20, job.imageBudget),
  });
  let reducedImages = 0;
  let omittedImages = 0;
  try {
    if (engine.failure) {
      post({
        type: "error",
        jobId: job.jobId,
        code: engine.failure.code,
        message: engine.failure.message,
      });
      return;
    }

    // Decode blob images in bounded parallel batches (4 at a time), then upload in deterministic
    // handle order so large photo/kit pages stay fast without spiking memory.
    const DECODE_CONCURRENCY = 4;
    for (let i = 0; i < job.images.length; i += DECODE_CONCURRENCY) {
      if (isCancelled()) {
        post({ type: "cancelled", jobId: job.jobId });
        return;
      }
      const batch = job.images.slice(i, i + DECODE_CONCURRENCY);
      const prepared = await Promise.all(
        batch.map(async (img) => {
          if (img.kind === "rgba") return { kind: "rgba" as const, img };
          const decoded = await decodeTargetRgba(
            img.blob,
            { width: Math.max(1, img.naturalWidth), height: Math.max(1, img.naturalHeight) },
            { width: Math.max(1, img.width), height: Math.max(1, img.height) },
            isCancelled,
          );
          return { kind: "blob" as const, img, decoded };
        }),
      );
      if (isCancelled()) {
        post({ type: "cancelled", jobId: job.jobId });
        return;
      }
      for (const item of prepared) {
        if (isCancelled()) {
          post({ type: "cancelled", jobId: job.jobId });
          return;
        }
        if (item.kind === "rgba") {
          const uploaded = engine.putImage(
            item.img.handle,
            item.img.width,
            item.img.height,
            new Uint8Array(item.img.pixels),
            false,
          );
          if (!uploaded.ok && uploaded.code === ErrorCode.Trap) {
            post({
              type: "error",
              jobId: job.jobId,
              code: uploaded.code,
              message: uploaded.message,
            });
            return;
          }
        } else if (item.decoded) {
          const uploaded = engine.putImage(
            item.img.handle,
            item.decoded.width,
            item.decoded.height,
            item.decoded.rgba,
            false,
          );
          if (uploaded.ok) {
            if (item.decoded.width < item.img.width || item.decoded.height < item.img.height) {
              reducedImages++;
            }
            continue;
          }
          if (uploaded.code === ErrorCode.Trap) {
            post({
              type: "error",
              jobId: job.jobId,
              code: uploaded.code,
              message: uploaded.message,
            });
            return;
          }
          if (uploaded.code === ErrorCode.Limit) {
            const res = await decodeAndUploadBlob(engine, item.img, isCancelled);
            if (!res.ok) {
              post({ type: "error", jobId: job.jobId, code: res.code, message: res.message });
              return;
            }
            if (res.reduced) reducedImages++;
            if (res.omitted) omittedImages++;
          } else {
            omittedImages++;
          }
        } else {
          const res = await decodeAndUploadBlob(engine, item.img, isCancelled);
          if (!res.ok) {
            post({ type: "error", jobId: job.jobId, code: res.code, message: res.message });
            return;
          }
          if (res.reduced) reducedImages++;
          if (res.omitted) omittedImages++;
        }
      }
    }

    if (isCancelled()) {
      post({ type: "cancelled", jobId: job.jobId });
      return;
    }

    const applied = engine.apply(new Uint8Array(job.list));
    if (!applied.ok) {
      post({ type: "error", jobId: job.jobId, code: applied.code, message: applied.message });
      return;
    }

    if (job.format === "png") {
      const stream = engine.renderPngStream(job.width, job.height, job.camera, job.background);
      if (!stream.ok) {
        post({ type: "error", jobId: job.jobId, code: stream.code, message: stream.message });
        return;
      }
      const reader = stream.value.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let lastYield = performance.now();
      try {
        for (;;) {
          if (isCancelled()) {
            await reader.cancel().catch(() => {});
            post({ type: "cancelled", jobId: job.jobId });
            return;
          }
          const next = await reader.read();
          if (next.done) break;
          chunks.push(next.value);
          totalBytes += next.value.byteLength;
          if (performance.now() - lastYield >= YIELD_INTERVAL_MS) {
            await yieldTick();
            lastYield = performance.now();
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (isCancelled()) {
        post({ type: "cancelled", jobId: job.jobId });
        return;
      }
      const combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      post(
        {
          type: "done",
          jobId: job.jobId,
          mime: "image/png",
          bytes: combined.buffer,
          reducedImages,
          omittedImages,
        },
        [combined.buffer],
      );
      return;
    }

    // JPEG and WebP: render band by band into an OffscreenCanvas and encode via the browser.
    if (typeof OffscreenCanvas === "undefined") {
      post({
        type: "error",
        jobId: job.jobId,
        code: ErrorCode.NotAvailable,
        message: "This browser can't encode JPEG or WebP exports. Try PNG instead.",
      });
      return;
    }
    const canvas = new OffscreenCanvas(job.width, job.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      post({
        type: "error",
        jobId: job.jobId,
        code: ErrorCode.NotAvailable,
        message: "This browser can't encode JPEG or WebP exports. Try PNG instead.",
      });
      return;
    }
    const rowsPerBand = engine.bandRows(job.width);
    let lastYield = performance.now();
    for (let y0 = 0; y0 < job.height; y0 += rowsPerBand) {
      if (isCancelled()) {
        post({ type: "cancelled", jobId: job.jobId });
        return;
      }
      const bandHeight = Math.min(rowsPerBand, job.height - y0);
      const band = engine.renderBand(
        job.width,
        job.height,
        job.camera,
        job.background,
        y0,
        bandHeight,
      );
      if (!band.ok) {
        post({
          type: "error",
          jobId: job.jobId,
          code: band.code,
          message: band.message,
        });
        return;
      }
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(band.value), job.width, bandHeight),
        0,
        y0,
      );
      if (performance.now() - lastYield >= YIELD_INTERVAL_MS) {
        await yieldTick();
        lastYield = performance.now();
      }
    }
    if (isCancelled()) {
      post({ type: "cancelled", jobId: job.jobId });
      return;
    }
    const type = `image/${job.format}`;
    let blob = await canvas.convertToBlob({ type, quality: job.quality });
    if (isCancelled()) {
      post({ type: "cancelled", jobId: job.jobId });
      return;
    }
    // When a byte budget is set (e.g. 64 KiB thumbnail keepalive), re-encode the already-rendered
    // pixels at stepped WebP qualities and then downscaled dimensions without re-rendering.
    const maxBytes = job.maxBytes;
    if (maxBytes !== undefined && maxBytes > 0 && job.format === "webp" && blob.size > maxBytes) {
      for (const q of [0.72, 0.58]) {
        if (q >= job.quality) continue;
        if (isCancelled()) {
          post({ type: "cancelled", jobId: job.jobId });
          return;
        }
        blob = await canvas.convertToBlob({ type, quality: q });
        if (blob.size <= maxBytes) break;
      }
      let scale = 0.5;
      while (blob.size > maxBytes && Math.max(job.width, job.height) * scale >= 120) {
        if (isCancelled()) {
          post({ type: "cancelled", jobId: job.jobId });
          return;
        }
        const sw = Math.max(1, Math.round(job.width * scale));
        const sh = Math.max(1, Math.round(job.height * scale));
        const small = new OffscreenCanvas(sw, sh);
        const sctx = small.getContext("2d");
        if (!sctx) break;
        sctx.imageSmoothingQuality = "high";
        sctx.drawImage(canvas, 0, 0, sw, sh);
        blob = await small.convertToBlob({ type, quality: 0.72 });
        scale *= 0.5;
      }
    }
    if (isCancelled()) {
      post({ type: "cancelled", jobId: job.jobId });
      return;
    }
    const bytes = await blob.arrayBuffer();
    post(
      {
        type: "done",
        jobId: job.jobId,
        mime: blob.type || type,
        bytes,
        reducedImages,
        omittedImages,
      },
      [bytes],
    );
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err && typeof err.code === "number"
        ? (err.code as ErrorCode)
        : null;
    const message = err instanceof Error ? err.message : String(err);
    post({ type: "error", jobId: job.jobId, code, message });
  } finally {
    lastFinishedJobId = Math.max(lastFinishedJobId, job.jobId);
    pruneCancelled();
    engine.dispose();
  }
}

scope.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      if (!engineModule) engineModule = await loadBrowserEngine();
      if (disposed) return;
      post({ type: "ready" });
      return;
    }
    if (data.type === "dispose") {
      disposed = true;
      cancelled.clear();
      return;
    }
    if (data.type === "cancel") {
      if (data.jobId > lastFinishedJobId) cancelled.add(data.jobId);
      return;
    }
    if (data.type === "render") {
      await runJob(data);
    }
  } catch (err) {
    post({
      type: "error",
      code: null,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
