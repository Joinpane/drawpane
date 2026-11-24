/**
 * Client-side preview generation and upload (never blocks or fails original image uploads).
 *
 * Uses a dedicated module Worker (`image-preview.worker.ts`) with browser-native
 * `OffscreenCanvas.convertToBlob` (JPEG q80 for opaque, WebP q80 or PNG fallback for alpha)
 * and a client-side pixel-count gate (`MEDIA_PREVIEW_MAX_PIXELS`).
 *
 * Two entry points:
 * - `uploadMediaPreviews(sha, blob)`: called best-effort after an original upload succeeds.
 * - `backfillMediaPreviews(sha, blob)`: concurrency-1 low-priority background queue used when an
 *   editor opens a pre-existing image whose server response carried `X-Image-Preview-Missing: 1`.
 */
import type { MediaPreviewSize } from "@drawpane/model";
import type {
  GeneratedClientPreview,
  PreviewWorkerReply,
  PreviewWorkerRequest,
} from "./image-preview.worker";

export type { GeneratedClientPreview };

export interface ClientPreviewResult {
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly previews: readonly GeneratedClientPreview[];
  readonly encodeMs: number;
  readonly skipped?: "unsupported" | "pixel-limit" | "small";
}

interface PendingJob {
  resolve(result: ClientPreviewResult): void;
  reject(error: unknown): void;
}

const IDLE_TERMINATE_MS = 15_000;

let worker: Worker | null = null;
let idleTimer = 0;
let nextJobId = 0;
const pending = new Map<number, PendingJob>();

function resetWorker(reason?: unknown): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = 0;
  }
  const current = worker;
  worker = null;
  current?.terminate();
  const error = reason ?? new Error("Preview worker stopped");
  for (const job of pending.values()) job.reject(error);
  pending.clear();
}

function scheduleIdleTerminate(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (pending.size > 0 || !worker) return;
  idleTimer = setTimeout(() => {
    idleTimer = 0;
    if (pending.size === 0 && worker) {
      worker.terminate();
      worker = null;
    }
  }, IDLE_TERMINATE_MS) as unknown as number;
}

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker !== "function" || typeof OffscreenCanvas === "undefined") return null;
  try {
    const created = new Worker(new URL("./image-preview.worker.ts", import.meta.url), {
      type: "module",
    });
    created.onmessage = ({ data }: MessageEvent<PreviewWorkerReply>) => {
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      scheduleIdleTerminate();
      if ("error" in data) job.reject(new Error(data.error));
      else
        job.resolve({
          naturalWidth: data.naturalWidth,
          naturalHeight: data.naturalHeight,
          previews: data.previews,
          encodeMs: data.encodeMs,
          ...(data.skipped ? { skipped: data.skipped } : {}),
        });
    };
    created.onerror = (event) => resetWorker(event.error ?? new Error(event.message));
    created.onmessageerror = () => resetWorker(new Error("Preview worker message error"));
    worker = created;
    return created;
  } catch {
    return null;
  }
}

/** Generates fixed-size previews for `blob` in the preview Web Worker. */
export async function generateClientPreviews(
  blob: Blob,
  options?: { readonly sizes?: readonly MediaPreviewSize[]; readonly quality?: number },
): Promise<ClientPreviewResult | null> {
  const w = getWorker();
  if (!w) return null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = 0;
  }
  const id = ++nextJobId;
  return new Promise<ClientPreviewResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const req: PreviewWorkerRequest = {
      id,
      blob,
      ...(options?.sizes ? { sizes: options.sizes } : {}),
      ...(options?.quality !== undefined ? { quality: options.quality } : {}),
    };
    w.postMessage(req);
  });
}

export interface UploadPreviewsResult {
  readonly generated: number;
  readonly uploaded: number;
  readonly encodeMs: number;
  readonly skipped?: "unsupported" | "pixel-limit" | "small";
  readonly previews: readonly {
    readonly size: MediaPreviewSize;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
    readonly mime: string;
  }[];
}

/** Content-addressed session deduplication so no client uploads previews for the same sha twice. */
const attemptedShas = new Set<string>();

/** Test helper: resets per-session preview deduplication and terminates any idle worker. */
export function resetPreviewUploadsForTest(): void {
  attemptedShas.clear();
  backfillQueue.length = 0;
  backfillRunning = false;
  resetWorker();
}

/**
 * Generates previews in a worker and uploads each tier via `PUT /api/media/:sha/previews/:size`.
 * Best-effort: swallows generation or network errors so original uploads never fail.
 */
export async function uploadMediaPreviews(
  sha: string,
  blob: Blob,
  options?: {
    readonly force?: boolean;
    readonly generate?: (blob: Blob) => Promise<ClientPreviewResult | null>;
    readonly fetcher?: typeof fetch;
  },
): Promise<UploadPreviewsResult> {
  if (!options?.force && attemptedShas.has(sha)) {
    return { generated: 0, uploaded: 0, encodeMs: 0, previews: [] };
  }
  attemptedShas.add(sha);
  const runGenerate = options?.generate ?? generateClientPreviews;
  const doFetch = options?.fetcher ?? fetch;
  let result: ClientPreviewResult | null = null;
  try {
    result = await runGenerate(blob);
  } catch {
    return { generated: 0, uploaded: 0, encodeMs: 0, previews: [] };
  }
  if (!result || result.previews.length === 0) {
    return {
      generated: 0,
      uploaded: 0,
      encodeMs: result?.encodeMs ?? 0,
      ...(result?.skipped ? { skipped: result.skipped } : {}),
      previews: [],
    };
  }

  let uploaded = 0;
  const summaries: Array<{
    readonly size: MediaPreviewSize;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
    readonly mime: string;
  }> = [];

  for (const preview of result.previews) {
    summaries.push({
      size: preview.size,
      width: preview.width,
      height: preview.height,
      bytes: preview.blob.size,
      mime: preview.blob.type,
    });
    try {
      const response = await doFetch(
        `/api/media/${encodeURIComponent(sha)}/previews/${preview.size}`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "content-type": preview.blob.type || "image/jpeg",
            "x-preview-width": String(preview.width),
            "x-preview-height": String(preview.height),
            "x-image-width": String(result.naturalWidth),
            "x-image-height": String(result.naturalHeight),
          },
          body: preview.blob,
        },
      );
      if (response.ok) uploaded++;
    } catch {
      // Best-effort: preview upload failure must never break the editor or original upload.
    }
  }

  return {
    generated: result.previews.length,
    uploaded,
    encodeMs: result.encodeMs,
    previews: summaries,
  };
}

const backfillQueue: Array<{ readonly sha: string; readonly blob: Blob }> = [];
let backfillRunning = false;

function drainBackfill(): void {
  if (backfillRunning) return;
  const next = backfillQueue.shift();
  if (!next) return;
  backfillRunning = true;
  // Yield to active frame rendering before encoding previews for pre-existing images.
  const start = () => {
    void uploadMediaPreviews(next.sha, next.blob, { force: true }).finally(() => {
      backfillRunning = false;
      drainBackfill();
    });
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(start, { timeout: 2000 });
  } else {
    setTimeout(start, 50);
  }
}

/**
 * Low-priority, content-hash-deduplicated background preview backfill for pre-existing images
 * whose server response indicated no stored previews (`X-Image-Preview-Missing: 1`).
 */
export function backfillMediaPreviews(sha: string, blob: Blob): void {
  if (attemptedShas.has(sha)) return;
  attemptedShas.add(sha);
  backfillQueue.push({ sha, blob });
  drainBackfill();
}
