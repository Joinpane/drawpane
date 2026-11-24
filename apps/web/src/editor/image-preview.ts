/**
 * Client-side preview generation and upload (never blocks or fails original image uploads).
 *
 * Uses a dedicated module Worker (`image-preview.worker.ts`) with browser-native
 * `OffscreenCanvas.convertToBlob` (JPEG q80 for opaque, WebP q80 or PNG fallback for alpha),
 * a client-side pixel-count gate (`MEDIA_PREVIEW_MAX_PIXELS`), bounded worker concurrency
 * (`MAX_CONCURRENT_PREVIEW_JOBS`), and explicit timeouts on both worker jobs and preview PUTs.
 *
 * Three entry points:
 * - `uploadMediaPreviews(sha, blob)`: generates and uploads previews best-effort, returning stats.
 * - `enqueueMediaPreviews(sha, blob)`: hands previews to a bounded background queue without
 *   blocking the caller (used by canvas drops/uploads and Figma/Penpot imports).
 * - `backfillMediaPreviews(sha, blob)`: concurrency-1 idle-priority background queue used when an
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
  readonly timer: ReturnType<typeof setTimeout>;
  resolve(result: ClientPreviewResult | null): void;
  reject(error: unknown): void;
}

interface QueuedWorkerJob {
  readonly blob: Blob;
  readonly sizes?: readonly MediaPreviewSize[];
  readonly quality?: number;
  readonly timeoutMs: number;
  resolve(result: ClientPreviewResult | null): void;
  reject(error: unknown): void;
}

const IDLE_TERMINATE_MS = 15_000;
/** Maximum concurrent preview decode/encode jobs dispatched to the worker. */
export const MAX_CONCURRENT_PREVIEW_JOBS = 2;
/** Timeout for a single preview generation job once dispatched to the worker. */
export const PREVIEW_WORKER_TIMEOUT_MS = 15_000;
/** Timeout for a single preview PUT request. */
export const PREVIEW_PUT_TIMEOUT_MS = 15_000;

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextJobId = 0;
const pending = new Map<number, PendingJob>();
const waitingWorkerJobs: QueuedWorkerJob[] = [];

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function resetWorker(reason?: unknown, clearWaiting = true): void {
  clearIdleTimer();
  const current = worker;
  worker = null;
  current?.terminate();
  const error = reason ?? new Error("Preview worker stopped");
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(error);
  }
  pending.clear();
  if (clearWaiting) {
    for (const job of waitingWorkerJobs.splice(0)) job.reject(error);
  }
}

function scheduleIdleTerminate(): void {
  clearIdleTimer();
  if (pending.size > 0 || waitingWorkerJobs.length > 0 || !worker) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending.size === 0 && waitingWorkerJobs.length === 0 && worker) {
      worker.terminate();
      worker = null;
    }
  }, IDLE_TERMINATE_MS);
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
      clearTimeout(job.timer);
      pending.delete(data.id);
      if ("error" in data) job.reject(new Error(data.error));
      else
        job.resolve({
          naturalWidth: data.naturalWidth,
          naturalHeight: data.naturalHeight,
          previews: data.previews,
          encodeMs: data.encodeMs,
          ...(data.skipped ? { skipped: data.skipped } : {}),
        });
      drainWorkerQueue();
      scheduleIdleTerminate();
    };
    created.onerror = (event) => resetWorker(event.error ?? new Error(event.message), true);
    created.onmessageerror = () => resetWorker(new Error("Preview worker message error"), true);
    worker = created;
    return created;
  } catch {
    return null;
  }
}

function drainWorkerQueue(): void {
  while (pending.size < MAX_CONCURRENT_PREVIEW_JOBS && waitingWorkerJobs.length > 0) {
    const w = getWorker();
    if (!w) {
      for (const job of waitingWorkerJobs.splice(0)) job.resolve(null);
      return;
    }
    const next = waitingWorkerJobs.shift();
    if (!next) break;
    clearIdleTimer();
    const id = ++nextJobId;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      // Terminate a hung worker so subsequent queued jobs can run on a fresh worker.
      resetWorker(new Error("Preview worker timed out"), false);
      drainWorkerQueue();
    }, next.timeoutMs);
    pending.set(id, { timer, resolve: next.resolve, reject: next.reject });
    const req: PreviewWorkerRequest = {
      id,
      blob: next.blob,
      ...(next.sizes ? { sizes: next.sizes } : {}),
      ...(next.quality !== undefined ? { quality: next.quality } : {}),
    };
    w.postMessage(req);
  }
}

/** Generates fixed-size previews for `blob` in the preview Web Worker with bounded concurrency and timeout. */
export async function generateClientPreviews(
  blob: Blob,
  options?: {
    readonly sizes?: readonly MediaPreviewSize[];
    readonly quality?: number;
    readonly timeoutMs?: number;
  },
): Promise<ClientPreviewResult | null> {
  if (typeof Worker !== "function" || typeof OffscreenCanvas === "undefined") return null;
  return new Promise<ClientPreviewResult | null>((resolve, reject) => {
    waitingWorkerJobs.push({
      blob,
      ...(options?.sizes ? { sizes: options.sizes } : {}),
      ...(options?.quality !== undefined ? { quality: options.quality } : {}),
      timeoutMs: options?.timeoutMs ?? PREVIEW_WORKER_TIMEOUT_MS,
      resolve,
      reject,
    });
    drainWorkerQueue();
  });
}

async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Preview upload timed out");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([doFetch(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

export interface UploadPreviewsOptions {
  readonly force?: boolean;
  readonly generate?: (blob: Blob) => Promise<ClientPreviewResult | null>;
  readonly fetcher?: typeof fetch;
  readonly workerTimeoutMs?: number;
  readonly putTimeoutMs?: number;
}

/** Content-addressed session deduplication so no client uploads previews for the same sha twice. */
const attemptedShas = new Set<string>();

interface BackgroundPreviewJob {
  readonly sha: string;
  readonly blob: Blob;
  readonly options?: UploadPreviewsOptions;
}

const previewQueue: BackgroundPreviewJob[] = [];
let previewActive = 0;

function drainPreviewQueue(): void {
  while (previewActive < MAX_CONCURRENT_PREVIEW_JOBS && previewQueue.length > 0) {
    const next = previewQueue.shift();
    if (!next) break;
    previewActive++;
    void uploadMediaPreviews(next.sha, next.blob, { ...next.options, force: true }).finally(() => {
      previewActive--;
      drainPreviewQueue();
    });
  }
}

/**
 * Hands preview generation and upload to a bounded background queue after an original upload
 * succeeds, so drops and imports never block on preview encode or PUT latency.
 */
export function enqueueMediaPreviews(
  sha: string,
  blob: Blob,
  options?: UploadPreviewsOptions,
): void {
  if (!options?.force && attemptedShas.has(sha)) return;
  attemptedShas.add(sha);
  previewQueue.push({ sha, blob, ...(options ? { options } : {}) });
  drainPreviewQueue();
}

/** Test helper: resets per-session preview deduplication, background queues, and any idle worker. */
export function resetPreviewUploadsForTest(): void {
  attemptedShas.clear();
  previewQueue.length = 0;
  previewActive = 0;
  backfillQueue.length = 0;
  backfillRunning = false;
  resetWorker();
}

/**
 * Generates previews in a worker and uploads each tier via `PUT /api/media/:sha/previews/:size`.
 * Best-effort: swallows generation, timeout, or network errors so original uploads never fail.
 */
export async function uploadMediaPreviews(
  sha: string,
  blob: Blob,
  options?: UploadPreviewsOptions,
): Promise<UploadPreviewsResult> {
  if (!options?.force && attemptedShas.has(sha)) {
    return { generated: 0, uploaded: 0, encodeMs: 0, previews: [] };
  }
  attemptedShas.add(sha);
  const runGenerate =
    options?.generate ??
    ((b: Blob) =>
      generateClientPreviews(
        b,
        options?.workerTimeoutMs !== undefined ? { timeoutMs: options.workerTimeoutMs } : undefined,
      ));
  const doFetch = options?.fetcher ?? fetch;
  const putTimeoutMs = options?.putTimeoutMs ?? PREVIEW_PUT_TIMEOUT_MS;
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
      const response = await fetchWithTimeout(
        doFetch,
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
        putTimeoutMs,
      );
      if (response.ok) uploaded++;
    } catch {
      // Best-effort: preview upload failure or timeout must never break the editor or original upload.
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
