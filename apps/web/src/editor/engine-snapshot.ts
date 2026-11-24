/**
 * Browser engine snapshot service (decision 0040, W2): the single engine path for every picture
 * that is not a live interactive canvas (raster exports, export preview, dashboard thumbnails,
 * component and library previews, new-file template previews, and prototype overlays and screen
 * thumbnails).
 *
 * Builds a display list via `DisplayListBuilder.planLayers(ids, { context })`, waits for fonts
 * and HarfBuzz shaping faces, sizes photos to their exact drawn pixel resolution within the
 * browser device image budget, and renders off the main thread in one dedicated Worker running
 * the browser CPU engine build (`renderPngStream` / `renderBand`). Jobs run sequentially by
 * priority (`high` > `normal` > `low`), enforce a per-job watchdog, and support `AbortSignal`
 * cancellation before and during rendering.
 */
import {
  budgetExportImages,
  chooseDrawnImageSize,
  collectExportImageUses,
  DisplayListBuilder,
  type Editor,
  type EngineImage,
  ExportError,
  type ExportImageCandidate,
  exportBackgroundRgba,
  exportBounds,
  exportSizeError,
  GREEK_BELOW,
  type ImageCache,
  largestFontSize,
  MAX_EXPORT_PIXELS,
  MAX_EXPORT_SIDE,
  measuredFaces,
  type RasterFormat,
  type Rect,
  ShapingMeasurer,
  type Size,
  snapToPixels,
  type TextMeasurer,
} from "@drawpane/editor";
import { type Camera, ErrorCode, MAX_SIDE, refusingBits, unsupportedNames } from "@drawpane/engine";
import {
  MEDIA_PREVIEW_SIZES,
  type MediaPreviewSize,
  type NodeRecord,
  sniffImage,
} from "@drawpane/model";
import { fonts } from "../fonts/fonts";
import { deviceImageBudget } from "./engine-image";
import type {
  SnapshotImageTransfer,
  SnapshotWorkerReply,
  SnapshotWorkerRequest,
} from "./engine-snapshot.worker";
import { imagesFor } from "./media";
import { shaper } from "./shaping";

export type SnapshotPriority = "high" | "normal" | "low";

const PRIORITY_RANK: Record<SnapshotPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

const FONT_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 10_000;
const WORKER_START_TIMEOUT_MS = 30_000;
const DEFAULT_JOB_TIMEOUT_MS = 60_000;
/** Keep a small warm Worker across the 10 s thumbnail settle cadence and short pauses; heavy jobs recycle at once. */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_PREEMPT_TIMEOUT_MS = 300;
/** Recycle the snapshot Worker immediately after any job that grew Wasm linear memory past 64 MiB. */
const DEFAULT_RECYCLE_WASM_BYTES = 64 << 20;
const MAX_BROWSER_SNAPSHOT_IMAGE_BUDGET = 192 << 20;
/** Default decoded bitmap cap enforced by `ImageCache` (`CanvasRenderer`). */
const CANVAS_IMAGE_MAX_SIDE = 4096;
/** Transient decode + Wasm upload working memory counted inside the snapshot image budget. */
const SNAPSHOT_DECODE_WORKING_MULTIPLIER = 2;

/** Device-scaled image memory budget for browser snapshot jobs (128 MiB mobile, 192 MiB desktop). */
export function snapshotImageBudget(): number {
  return deviceImageBudget(MAX_BROWSER_SNAPSHOT_IMAGE_BUDGET);
}

export interface SnapshotOptions {
  /** Layers to draw (page children or selected layers). */
  readonly ids: readonly string[];
  /** Page rectangle to draw, in page units. */
  readonly rect: Rect;
  /** Output width in pixels (1..8,192). */
  readonly width: number;
  /** Output height in pixels (1..8,192). */
  readonly height: number;
  /** Output pixels per page unit (`zoom`). */
  readonly scale: number;
  /** Output format. Defaults to `"png"`. */
  readonly format?: RasterFormat;
  /** Encoder quality for JPEG/WebP (0..1). Defaults to 0.92. */
  readonly quality?: number;
  /** Background colour (hex, CSS rgb/rgba, "white", "black", "transparent", or null). */
  readonly background?: string | null;
  /** Include backdrop context beneath `ids` for glass and background blur (decision 0039). */
  readonly context?: boolean;
  /**
   * Level-of-detail mode for thumbnails and small previews (never exports): culls sub-pixel
   * specks, draws unreadable text as bars without shaping, and skips sub-pixel effects and tiny
   * backdrop readers so massive kit pages stay fast.
   */
  readonly detail?: boolean;
  /**
   * Optional soft byte target for WebP output (e.g., 64 KiB keepalive for dashboard thumbnails).
   * The Worker steps quality and then dimensions on the already-rendered pixels without
   * re-rendering the scene.
   */
  readonly maxBytes?: number;
  /** Image cache to read encoded bytes from (defaults to `imagesFor(editor)`). */
  readonly images?: ImageCache;
  /** Override decoded image budget in bytes (defaults to `snapshotImageBudget()`). */
  readonly imageBudget?: number;
  /** Scheduling priority: exports `"high"`, previews/overlays `"normal"`, thumbnails `"low"`. */
  readonly priority?: SnapshotPriority;
  /** Cancels queued or in-flight snapshot work. */
  readonly signal?: AbortSignal;
}

export interface SnapshotResult {
  readonly blob: Blob;
  /** Photos downsampled below their drawn pixel size to fit the image memory budget. */
  readonly reducedImages: number;
  /** Photos that could not be decoded or fit even at their smallest level. */
  readonly omittedImages: number;
}

export interface SnapshotWorkerPort {
  onmessage: ((event: MessageEvent<SnapshotWorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SnapshotWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface SnapshotJobPayload {
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
  readonly transfer: Transferable[];
  readonly reducedImages: number;
  readonly omittedImages: number;
}

interface QueuedJob {
  jobId: number;
  readonly priority: SnapshotPriority;
  readonly seq: number;
  readonly payload: SnapshotJobPayload;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  preempted: boolean;
  readonly resolve: (result: SnapshotResult) => void;
  readonly reject: (error: Error) => void;
}

function abortError(): DOMException {
  return new DOMException("Snapshot cancelled", "AbortError");
}

/** True when `error` represents an explicit AbortSignal cancellation. */
export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
}

/** Portable timeout + caller-signal combiner (avoids Safari < 17.4 `AbortSignal.any`). */
function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  if (signal?.aborted) {
    controller.abort(signal.reason);
    return { signal: controller.signal, cleanup() {} };
  }
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("timed out")), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!signal && timeoutMs === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => finish(() => reject(new Error("timed out"))), timeoutMs)
        : undefined;
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function mapEngineError(
  code: ErrorCode | null,
  message: string,
  width: number,
  height: number,
): ExportError {
  if (code === ErrorCode.Limit) {
    if (width > MAX_SIDE || height > MAX_SIDE || /longest side/i.test(message)) {
      return exportSizeError(width, height, MAX_SIDE);
    }
    if (message.includes("glyph outlines")) {
      return new ExportError(
        "This export has too many different glyph outlines. Export a smaller part of the text.",
        "limit",
      );
    }
    const detail = message
      ? `${message[0]?.toUpperCase() ?? ""}${message.slice(1)}`
      : "This export exceeds the engine's limits";
    const sentence = detail.endsWith(".") ? detail : `${detail}.`;
    return new ExportError(`${sentence} Try a smaller scale.`, "limit");
  }
  if (code === ErrorCode.Unsupported) {
    return new ExportError(
      message || "This layer uses a feature the engine cannot export yet.",
      "unsupported",
    );
  }
  return new ExportError(message || "Couldn't export. Try a smaller scale, or another format.");
}

function createDefaultWorker(): SnapshotWorkerPort {
  if (typeof Worker === "undefined") {
    throw new ExportError("Web Workers are not available in this browser.");
  }
  return new Worker(new URL("./engine-snapshot.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as SnapshotWorkerPort;
}

/**
 * Manages one dedicated CPU-engine Worker with a priority queue, per-job watchdog, cancellation,
 * and automatic recovery if the Worker crashes or hangs.
 */
export class EngineSnapshotService {
  readonly #makeWorker: () => SnapshotWorkerPort;
  readonly #jobTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #preemptTimeoutMs: number;
  readonly #recycleWasmBytes: number;
  #worker: SnapshotWorkerPort | null = null;
  #starting: Promise<SnapshotWorkerPort> | null = null;
  #queue: QueuedJob[] = [];
  #active: QueuedJob | null = null;
  #watchdog: ReturnType<typeof setTimeout> | null = null;
  #preemptTimer: ReturnType<typeof setTimeout> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #nextJobId = 1;
  #seq = 0;

  constructor(
    makeWorker: () => SnapshotWorkerPort = createDefaultWorker,
    options: {
      readonly jobTimeoutMs?: number;
      readonly idleTimeoutMs?: number;
      readonly preemptTimeoutMs?: number;
      readonly recycleWasmBytes?: number;
    } = {},
  ) {
    this.#makeWorker = makeWorker;
    this.#jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#preemptTimeoutMs = options.preemptTimeoutMs ?? DEFAULT_PREEMPT_TIMEOUT_MS;
    this.#recycleWasmBytes = options.recycleWasmBytes ?? DEFAULT_RECYCLE_WASM_BYTES;
  }

  enqueueWithMeta(
    payload: SnapshotJobPayload,
    priority: SnapshotPriority = "normal",
    signal?: AbortSignal,
  ): Promise<SnapshotResult> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<SnapshotResult>((resolve, reject) => {
      const jobId = this.#nextJobId++;
      const seq = this.#seq++;
      const job: QueuedJob = {
        jobId,
        priority,
        seq,
        payload,
        ...(signal ? { signal } : {}),
        preempted: false,
        resolve,
        reject,
      };
      if (signal) {
        const onAbort = () => this.#cancel(job);
        job.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#clearIdleTimer();
      this.#insert(job);
      this.#maybePreempt(priority);
      void this.#pump();
    });
  }

  enqueue(
    payload: SnapshotJobPayload,
    priority: SnapshotPriority = "normal",
    signal?: AbortSignal,
  ): Promise<Blob> {
    return this.enqueueWithMeta(payload, priority, signal).then((res) => res.blob);
  }

  /** Terminates the Worker and rejects any pending jobs (for cleanup and tests). */
  dispose(): void {
    this.#clearWatchdog();
    this.#clearPreemptTimer();
    this.#clearIdleTimer();
    const err = abortError();
    if (this.#active) {
      this.#detachSignal(this.#active);
      this.#active.reject(err);
      this.#active = null;
    }
    for (const job of this.#queue) {
      this.#detachSignal(job);
      job.reject(err);
    }
    this.#queue = [];
    this.#killWorker();
  }

  #clearWatchdog(): void {
    if (this.#watchdog !== null) {
      clearTimeout(this.#watchdog);
      this.#watchdog = null;
    }
  }

  #clearPreemptTimer(): void {
    if (this.#preemptTimer !== null) {
      clearTimeout(this.#preemptTimer);
      this.#preemptTimer = null;
    }
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  #scheduleIdleRecycle(): void {
    this.#clearIdleTimer();
    if (this.#idleTimeoutMs <= 0 || !this.#worker || this.#active || this.#queue.length > 0) {
      return;
    }
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (!this.#active && this.#queue.length === 0) {
        this.#killWorker();
      }
    }, this.#idleTimeoutMs);
  }

  #insert(job: QueuedJob): void {
    const rank = PRIORITY_RANK[job.priority];
    let at = this.#queue.length;
    for (let i = 0; i < this.#queue.length; i++) {
      const other = this.#queue[i] as QueuedJob;
      const otherRank = PRIORITY_RANK[other.priority];
      if (otherRank > rank || (otherRank === rank && other.seq > job.seq)) {
        at = i;
        break;
      }
    }
    this.#queue.splice(at, 0, job);
  }

  #requeuePreempted(job: QueuedJob): void {
    job.preempted = false;
    job.jobId = this.#nextJobId++;
    this.#insert(job);
  }

  #maybePreempt(incomingPriority: SnapshotPriority): void {
    const active = this.#active;
    if (!active || active.preempted || active.signal?.aborted) return;
    // Preempt a running background ("low") job so user-triggered exports and previews never stall
    // behind a slow page thumbnail.
    if (active.priority !== "low") return;
    if (PRIORITY_RANK[incomingPriority] >= PRIORITY_RANK[active.priority]) return;
    active.preempted = true;
    try {
      this.#worker?.postMessage({ type: "cancel", jobId: active.jobId });
    } catch {
      // Worker will be recycled on error or timeout.
    }
    this.#clearPreemptTimer();
    if (this.#preemptTimeoutMs > 0) {
      this.#preemptTimer = setTimeout(() => {
        if (this.#active !== active) return;
        this.#preemptTimer = null;
        this.#clearWatchdog();
        this.#active = null;
        this.#killWorker();
        if (active.preempted && !active.signal?.aborted) {
          this.#requeuePreempted(active);
        } else {
          this.#detachSignal(active);
        }
        void this.#pump();
      }, this.#preemptTimeoutMs);
    }
  }

  #shouldRecycleWorker(wasmBytes: number | undefined): boolean {
    return (
      wasmBytes !== undefined && this.#recycleWasmBytes > 0 && wasmBytes >= this.#recycleWasmBytes
    );
  }

  #detachSignal(job: QueuedJob): void {
    if (job.signal && job.onAbort) {
      job.signal.removeEventListener("abort", job.onAbort);
    }
  }

  #cancel(job: QueuedJob): void {
    this.#detachSignal(job);
    job.preempted = false;
    const idx = this.#queue.indexOf(job);
    if (idx !== -1) {
      this.#queue.splice(idx, 1);
      job.reject(abortError());
      return;
    }
    if (this.#active === job) {
      try {
        this.#worker?.postMessage({ type: "cancel", jobId: job.jobId });
      } catch {
        // Worker may already be dead.
      }
      job.reject(abortError());
    }
  }

  #killWorker(): void {
    this.#clearIdleTimer();
    this.#clearPreemptTimer();
    const w = this.#worker;
    this.#worker = null;
    this.#starting = null;
    if (!w) return;
    w.onmessage = null;
    w.onerror = null;
    try {
      w.postMessage({ type: "dispose" });
    } catch {
      // Worker may already be dead.
    }
    w.terminate();
  }

  #ensureWorker(): Promise<SnapshotWorkerPort> {
    if (this.#worker) return Promise.resolve(this.#worker);
    if (this.#starting) return this.#starting;
    const start = new Promise<SnapshotWorkerPort>((resolve, reject) => {
      let worker: SnapshotWorkerPort;
      try {
        worker = this.#makeWorker();
      } catch (err) {
        reject(err instanceof Error ? err : new ExportError(String(err)));
        return;
      }
      const timer = setTimeout(() => {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        reject(new ExportError("Snapshot renderer timed out while starting."));
      }, WORKER_START_TIMEOUT_MS);
      worker.onmessage = (event) => {
        const msg = event.data;
        if (msg.type === "ready") {
          clearTimeout(timer);
          this.#worker = worker;
          this.#wireWorker(worker);
          resolve(worker);
        } else if (msg.type === "error") {
          clearTimeout(timer);
          worker.onmessage = null;
          worker.onerror = null;
          worker.terminate();
          reject(new ExportError(msg.message || "Snapshot renderer failed to start."));
        }
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        reject(new ExportError(event.message || "Snapshot renderer failed to load."));
      };
      worker.postMessage({ type: "init" });
    });
    this.#starting = start.finally(() => {
      if (this.#starting === start) this.#starting = null;
    });
    return this.#starting;
  }

  #wireWorker(worker: SnapshotWorkerPort): void {
    worker.onmessage = (event) => {
      if (this.#worker !== worker) return;
      const msg = event.data;
      if (msg.type === "ready") return;
      const active = this.#active;
      if (!active || (msg.type !== "error" && msg.jobId !== active.jobId)) return;
      if (msg.type === "error" && msg.jobId !== undefined && msg.jobId !== active.jobId) return;
      this.#clearWatchdog();
      this.#clearPreemptTimer();
      this.#active = null;
      if (msg.type === "done") {
        this.#detachSignal(active);
        if (!active.signal?.aborted) {
          active.resolve({
            blob: new Blob([msg.bytes], { type: msg.mime }),
            reducedImages: active.payload.reducedImages + (msg.reducedImages ?? 0),
            omittedImages: active.payload.omittedImages + (msg.omittedImages ?? 0),
          });
        }
      } else if (msg.type === "cancelled") {
        if (active.preempted && !active.signal?.aborted) {
          // Re-queue preempted background work behind the urgent job without rejecting the caller.
          this.#requeuePreempted(active);
        } else {
          // Already rejected synchronously when #cancel fired.
          this.#detachSignal(active);
        }
      } else if (msg.type === "error") {
        this.#detachSignal(active);
        if (!active.signal?.aborted) {
          active.reject(
            mapEngineError(msg.code, msg.message, active.payload.width, active.payload.height),
          );
        }
      }
      if (this.#shouldRecycleWorker(msg.wasmBytes)) {
        this.#killWorker();
      }
      void this.#pump();
    };
    worker.onerror = (event) => {
      if (this.#worker !== worker) return;
      this.#clearWatchdog();
      this.#clearPreemptTimer();
      const active = this.#active;
      this.#active = null;
      this.#killWorker();
      if (active) {
        this.#detachSignal(active);
        if (!active.signal?.aborted) {
          active.reject(new ExportError(event.message || "Snapshot renderer crashed. Try again."));
        }
      }
      void this.#pump();
    };
  }

  async #pump(): Promise<void> {
    if (this.#active) return;
    if (this.#queue.length === 0) {
      this.#scheduleIdleRecycle();
      return;
    }
    this.#clearIdleTimer();
    let worker: SnapshotWorkerPort;
    try {
      worker = await this.#ensureWorker();
    } catch (err) {
      const error = err instanceof Error ? err : new ExportError(String(err));
      const pending = this.#queue.splice(0, this.#queue.length);
      for (const job of pending) {
        this.#detachSignal(job);
        job.reject(error);
      }
      return;
    }
    if (this.#worker !== worker || this.#active) return;
    if (this.#queue.length === 0) {
      this.#scheduleIdleRecycle();
      return;
    }
    const job = this.#queue.shift();
    if (!job) return;
    if (job.signal?.aborted) {
      this.#detachSignal(job);
      job.reject(abortError());
      void this.#pump();
      return;
    }
    this.#active = job;
    this.#clearWatchdog();
    if (this.#jobTimeoutMs > 0) {
      this.#watchdog = setTimeout(() => {
        if (this.#active !== job) return;
        this.#watchdog = null;
        this.#clearPreemptTimer();
        this.#active = null;
        this.#detachSignal(job);
        this.#killWorker();
        if (!job.signal?.aborted) {
          job.reject(new ExportError("Snapshot renderer timed out. Try again.", "limit"));
        }
        void this.#pump();
      }, this.#jobTimeoutMs);
    }
    try {
      // Structured-clone "low" priority payloads (do not transfer) so an active thumbnail can be
      // preempted by a higher-priority job and re-queued with intact buffers.
      const transfer = job.priority === "low" ? [] : job.payload.transfer;
      worker.postMessage(
        {
          type: "render",
          jobId: job.jobId,
          format: job.payload.format,
          quality: job.payload.quality,
          ...(job.payload.maxBytes !== undefined ? { maxBytes: job.payload.maxBytes } : {}),
          width: job.payload.width,
          height: job.payload.height,
          imageBudget: job.payload.imageBudget,
          camera: job.payload.camera,
          background: job.payload.background,
          list: job.payload.list,
          images: job.payload.images,
        },
        transfer,
      );
    } catch (err) {
      this.#clearWatchdog();
      this.#clearPreemptTimer();
      this.#active = null;
      this.#detachSignal(job);
      job.reject(err instanceof Error ? err : new ExportError(String(err)));
      void this.#pump();
    }
  }
}

export const snapshotService = new EngineSnapshotService();

/**
 * Ensures the snapshot builder has an engine-text `ShapingMeasurer` without mutating a live
 * canvas-mode editor's measurer (so canvas-mode bidi and CJK caches stay undisturbed).
 */
function ensureEngineMeasurer(measurer: TextMeasurer): TextMeasurer {
  if (measurer instanceof ShapingMeasurer) {
    if (measurer.engineText) return measurer;
    const base = measurer.base;
    const isolated = new ShapingMeasurer(
      {
        width: base.width.bind(base),
        ...(base.metrics ? { metrics: base.metrics.bind(base) } : {}),
        get generation() {
          return base.generation ?? 0;
        },
        invalidate() {
          // Do not invalidate the live canvas editor's text cache.
        },
      },
      measurer.shaper,
      measurer.fonts,
      measurer.scriptLocale,
    );
    isolated.setEngineText(true);
    return isolated;
  }
  if (typeof measurer.shapeForEngine === "function") return measurer;
  const base = measurer as TextMeasurer & { invalidate?: (bumpGeneration?: boolean) => void };
  const wrapped = {
    width: base.width.bind(base),
    ...(base.metrics ? { metrics: base.metrics.bind(base) } : {}),
    get generation() {
      return base.generation ?? 0;
    },
    invalidate(bumpGeneration?: boolean) {
      base.invalidate?.(bumpGeneration);
    },
  };
  const created = new ShapingMeasurer(
    wrapped,
    shaper,
    fonts,
    typeof navigator !== "undefined" ? navigator.language : "",
  );
  created.setEngineText(true);
  return created;
}

async function measureBlobSize(blob: Blob, signal?: AbortSignal): Promise<Size | null> {
  try {
    const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
    const sniffed = sniffImage(head);
    if (sniffed?.mime === "image/png" || sniffed?.mime === "image/gif") {
      return { width: sniffed.width, height: sniffed.height };
    }
    if (typeof createImageBitmap !== "function") {
      return sniffed ? { width: sniffed.width, height: sniffed.height } : null;
    }
    const bitmap = await raceSignal(createImageBitmap(blob), signal);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

/** Returns true if any readable text nodes were present and font preparation ran. */
async function prepareFonts(
  nodes: readonly NodeRecord[],
  measurer: TextMeasurer,
  signal?: AbortSignal,
  detailScale?: number,
): Promise<boolean> {
  const textNodes = nodes.filter(
    (n) =>
      n.type === "text" &&
      (detailScale === undefined || largestFontSize(n) * detailScale >= GREEK_BELOW),
  );
  if (textNodes.length === 0) return false;
  shaper.preloadFallback();
  const resolver = measurer.family ? { family: measurer.family.bind(measurer) } : null;
  const faces = measuredFaces(textNodes, resolver);
  const waits: Promise<unknown>[] = [];
  if (typeof document !== "undefined" && document.fonts) {
    for (const face of faces) {
      const style = face.italic ? "italic " : "";
      waits.push(
        document.fonts.load(`${style}${face.weight} 16px "${face.family}"`).catch(() => []),
      );
    }
    waits.push(document.fonts.ready.catch(() => {}));
  }
  for (const face of faces) {
    waits.push(shaper.load(face).catch(() => "unavailable"));
  }
  try {
    await raceSignal(Promise.all(waits), signal, FONT_TIMEOUT_MS);
  } catch (err) {
    if (isAbortError(err)) throw err;
    // Timed out waiting on a slow web font: proceed with whatever faces are ready or fallback.
  }
  return true;
}

/**
 * Estimates synchronously (from already-cached image dimensions) how many photos in `ids` at
 * `scale` would be reduced to fit the browser snapshot image budget.
 */
export function estimateReducedExportImages(
  editor: Editor,
  ids: readonly string[],
  scale: number,
  cache: ImageCache = imagesFor(editor),
  imageBudget = snapshotImageBudget(),
): { readonly reduced: number; readonly omitted: number } {
  const measurer = editor.measurer;
  const builder = new DisplayListBuilder(editor.scene, measurer);
  const plan = builder.planLayers(ids, { context: true });
  const usesByRef = collectExportImageUses(editor.scene, plan.visibleNodes(), scale);
  if (usesByRef.size === 0) return { reduced: 0, omitted: 0 };
  const candidates: ExportImageCandidate[] = [];
  for (const [ref, uses] of usesByRef) {
    const natural = cache.natural(ref);
    if (natural && natural.width > 0 && natural.height > 0) {
      candidates.push({ ref, natural, uses });
    }
  }
  if (candidates.length === 0) return { reduced: 0, omitted: 0 };
  const budgeted = budgetExportImages(candidates, imageBudget, {
    exactDrawn: true,
    maxSide: MAX_SIDE,
    decodeWorkingMultiplier: SNAPSHOT_DECODE_WORKING_MULTIPLIER,
  });
  let reduced = 0;
  let omitted = 0;
  for (const entry of budgeted.values()) {
    if (!entry) omitted++;
    else if (entry.reduced) reduced++;
  }
  return { reduced, omitted };
}

/**
 * Counts how many photos in an export would still be drawn below their full drawn resolution on
 * `CanvasRenderer` (`ImageCache`'s 4,096 px longest-side bitmap cap).
 */
export function estimateCanvasReducedExportImages(
  editor: Editor,
  ids: readonly string[],
  scale: number,
  cache: ImageCache = imagesFor(editor),
): number {
  const builder = new DisplayListBuilder(editor.scene, editor.measurer);
  const plan = builder.planLayers(ids, { context: true });
  const usesByRef = collectExportImageUses(editor.scene, plan.visibleNodes(), scale);
  if (usesByRef.size === 0) return 0;
  let reduced = 0;
  for (const [ref, uses] of usesByRef) {
    const natural = cache.natural(ref);
    if (!natural || natural.width <= 0 || natural.height <= 0) continue;
    const longest = Math.max(natural.width, natural.height);
    if (longest <= CANVAS_IMAGE_MAX_SIDE) continue;
    const desired = chooseDrawnImageSize(natural, uses, MAX_EXPORT_SIDE);
    const k = CANVAS_IMAGE_MAX_SIDE / longest;
    const cappedW = Math.max(1, Math.round(natural.width * k));
    const cappedH = Math.max(1, Math.round(natural.height * k));
    if (desired.width > cappedW || desired.height > cappedH) reduced++;
  }
  return reduced;
}

/**
 * Whether the canvas exporter draws this export's photos sharper than the engine would. Each
 * photo's sharpness is its drawn size over its wanted size: the engine's image budget halves or
 * omits photos, and canvas caps bitmaps at 4,096 px on the longest side (`ImageCache`). Canvas
 * wins when its worst photo is sharper than the engine's worst, so neither path is chosen for a
 * gain on one photo that costs another more.
 */
export function canvasExportIsSharper(
  editor: Editor,
  ids: readonly string[],
  scale: number,
  cache: ImageCache = imagesFor(editor),
  imageBudget = snapshotImageBudget(),
): boolean {
  const builder = new DisplayListBuilder(editor.scene, editor.measurer);
  const plan = builder.planLayers(ids, { context: true });
  const usesByRef = collectExportImageUses(editor.scene, plan.visibleNodes(), scale);
  const candidates: ExportImageCandidate[] = [];
  for (const [ref, uses] of usesByRef) {
    const natural = cache.natural(ref);
    if (natural && natural.width > 0 && natural.height > 0) {
      candidates.push({ ref, natural, uses });
    }
  }
  if (candidates.length === 0) return false;
  const budgeted = budgetExportImages(candidates, imageBudget, {
    exactDrawn: true,
    maxSide: MAX_SIDE,
    decodeWorkingMultiplier: SNAPSHOT_DECODE_WORKING_MULTIPLIER,
  });
  let canvasWorst = 1;
  let engineWorst = 1;
  for (const { ref, natural, uses } of candidates) {
    const desired = chooseDrawnImageSize(natural, uses, MAX_EXPORT_SIDE);
    const wanted = Math.max(desired.width, desired.height);
    const canvasSide = Math.min(wanted, CANVAS_IMAGE_MAX_SIDE);
    const engine = budgeted.get(ref);
    const engineSide = engine ? Math.max(engine.target.width, engine.target.height) : 0;
    canvasWorst = Math.min(canvasWorst, canvasSide / wanted);
    engineWorst = Math.min(engineWorst, Math.min(engineSide, wanted) / wanted);
  }
  return canvasWorst > engineWorst;
}

/** Human-readable notice when large photos were downsampled or omitted to fit memory. */
export function formatReducedImagesNote(reduced: number, omitted = 0): string | null {
  if (omitted > 0 && reduced > 0) {
    return `${reduced} ${reduced === 1 ? "photo was" : "photos were"} reduced and ${omitted} omitted to fit memory. Try a smaller scale.`;
  }
  if (omitted > 0) {
    return `${omitted} ${omitted === 1 ? "photo couldn't" : "photos couldn't"} fit in memory at this scale. Try a smaller scale.`;
  }
  if (reduced > 0) {
    return `${reduced} ${reduced === 1 ? "photo was" : "photos were"} reduced in resolution to fit memory. Try a smaller scale for full detail.`;
  }
  return null;
}

/**
 * Prepares the display list, fonts, and budgeted images for a snapshot job on the main thread,
 * ready to send to the snapshot Worker. Runs `planLayers` once when no new fonts load.
 */
export async function prepareSnapshotJob(
  editor: Editor,
  options: SnapshotOptions,
): Promise<SnapshotJobPayload> {
  const width = Math.round(options.width);
  const height = Math.round(options.height);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_SIDE ||
    height > MAX_SIDE ||
    width * height > MAX_EXPORT_PIXELS
  ) {
    throw exportSizeError(
      Number.isFinite(width) ? width : MAX_SIDE + 1,
      Number.isFinite(height) ? height : MAX_SIDE + 1,
      MAX_SIDE,
    );
  }
  const background = exportBackgroundRgba(options.background);
  const format = options.format ?? "png";
  const quality = options.quality ?? 0.92;
  const imageBudget = options.imageBudget ?? snapshotImageBudget();
  const signal = options.signal;
  if (signal?.aborted) throw abortError();

  const measurer = ensureEngineMeasurer(editor.measurer);
  const cache = options.images ?? imagesFor(editor);
  const engineImages = new Map<string, EngineImage | null>();
  const builder = new DisplayListBuilder(editor.scene, measurer, {
    image: (ref) => engineImages.get(ref),
  });

  const detailScale = options.detail ? options.scale : undefined;
  const planOpts = {
    context: options.context,
    ...(detailScale !== undefined ? { detailScale } : {}),
  };

  // Plan visible layers (including decision 0039 backdrop context when requested).
  let plan = builder.planLayers(options.ids, planOpts);
  let visibleNodes = [...plan.visibleNodes()];
  const versionBeforeFonts = editor.doc.version;
  const hadText = await prepareFonts(visibleNodes, measurer, signal, detailScale);
  if (signal?.aborted) throw abortError();

  // Only re-plan if text was prepared and the document changed while awaiting fonts.
  if (hadText && editor.doc.version !== versionBeforeFonts) {
    plan = builder.planLayers(options.ids, planOpts);
    visibleNodes = [...plan.visibleNodes()];
  }

  const usesByRef = collectExportImageUses(editor.scene, visibleNodes, options.scale);
  const loaded: Array<{
    ref: string;
    blob: Blob;
    natural: Size;
    uses: ReturnType<typeof usesByRef.get> & object;
  }> = [];

  if (usesByRef.size > 0) {
    await Promise.all(
      [...usesByRef.entries()].map(async ([ref, uses]) => {
        const timeout = withTimeoutSignal(signal, IMAGE_TIMEOUT_MS);
        try {
          let preview: MediaPreviewSize | undefined;
          if (options.detail) {
            // Dashboard thumbnails and LOD previews use fixed-size previews instead of pulling
            // full-resolution originals; exports never set `detail` and always fetch originals.
            let maxNeeded = 0;
            for (const use of uses) {
              const crop = use.paint.crop;
              const cx = crop ? Math.max(0.05, crop.width) : 1;
              const cy = crop ? Math.max(0.05, crop.height) : 1;
              maxNeeded = Math.max(
                maxNeeded,
                (use.box.width * use.scale.width) / cx,
                (use.box.height * use.scale.height) / cy,
              );
            }
            preview = MEDIA_PREVIEW_SIZES.find((s) => s >= maxNeeded);
          }
          const { blob, size } = await cache.encoded(
            ref,
            timeout.signal,
            preview ? { preview } : undefined,
          );
          if (signal?.aborted) throw abortError();
          const natural = size ?? cache.natural(ref) ?? (await measureBlobSize(blob, signal));
          if (!natural || natural.width <= 0 || natural.height <= 0) return;
          loaded.push({ ref, blob, natural, uses });
        } catch (err) {
          if (isAbortError(err)) throw err;
          // Unavailable image: omitted in display list rather than crashing the snapshot.
        } finally {
          timeout.cleanup();
        }
      }),
    );
    if (signal?.aborted) throw abortError();
  }

  const candidates: ExportImageCandidate[] = loaded.map((item) => ({
    ref: item.ref,
    natural: item.natural,
    uses: item.uses,
  }));
  const imagePlan = budgetExportImages(candidates, imageBudget, {
    exactDrawn: true,
    maxSide: MAX_SIDE,
    decodeWorkingMultiplier: SNAPSHOT_DECODE_WORKING_MULTIPLIER,
  });

  const transfers: SnapshotImageTransfer[] = [];
  const transferables: Transferable[] = [];
  let nextHandle = 1;
  let reducedImages = 0;
  let omittedImages = 0;

  for (const item of loaded) {
    const planned = imagePlan.get(item.ref);
    if (!planned) {
      engineImages.set(item.ref, null);
      omittedImages++;
      continue;
    }
    if (planned.reduced) reducedImages++;
    const handle = nextHandle++;
    engineImages.set(item.ref, {
      handle,
      width: item.natural.width,
      height: item.natural.height,
    });
    transfers.push({
      kind: "blob",
      handle,
      blob: item.blob,
      naturalWidth: item.natural.width,
      naturalHeight: item.natural.height,
      width: planned.target.width,
      height: planned.target.height,
    });
  }

  let list = plan.build();

  // Wait for any script fallback or vector emoji faces triggered while shaping text, then rebuild
  // so snapshots never emit provisional text bars.
  const waitedFaces = new Set<string>();
  while (builder.waiting > 0) {
    const pending = [...builder.waitingFaces()].filter((key) => !waitedFaces.has(key));
    if (pending.length === 0) break;
    for (const key of pending) waitedFaces.add(key);
    try {
      await raceSignal(
        Promise.all(pending.map((key) => shaper.waitForFace(key))),
        signal,
        FONT_TIMEOUT_MS,
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      break;
    }
    if (signal?.aborted) throw abortError();
    plan = builder.planLayers(options.ids, planOpts);
    list = plan.build();
  }

  if (!builder.supported) {
    const names = [
      ...new Set(
        [...builder.unsupported.values()].flatMap((bits) => unsupportedNames(refusingBits(bits))),
      ),
    ];
    const features = names.map((name) => name.replace(/([A-Z])/g, " $1").toLowerCase());
    throw new ExportError(
      `This export needs ${features.join(", ") || "an unsupported feature"}.`,
      "unsupported",
    );
  }

  const listCopy = new Uint8Array(list.byteLength);
  listCopy.set(list);
  transferables.push(listCopy.buffer);

  return {
    format,
    quality,
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    width,
    height,
    imageBudget,
    camera: {
      zoom: options.scale,
      x: -options.rect.x * options.scale,
      y: -options.rect.y * options.scale,
      dpr: 1,
    },
    background,
    list: listCopy.buffer,
    images: transfers,
    transfer: transferables,
    reducedImages,
    omittedImages,
  };
}

/**
 * Renders any selection or page rectangle with the engine's snapshot Worker and returns the
 * encoded image `Blob` plus image reduction metadata.
 */
export async function renderEngineSnapshotWithMeta(
  editor: Editor,
  options: SnapshotOptions,
  service: EngineSnapshotService = snapshotService,
): Promise<SnapshotResult> {
  const payload = await prepareSnapshotJob(editor, options);
  return service.enqueueWithMeta(payload, options.priority ?? "normal", options.signal);
}

/**
 * Renders any selection or page rectangle with the engine's snapshot Worker and returns the
 * encoded image `Blob`.
 */
export async function renderEngineSnapshot(
  editor: Editor,
  options: SnapshotOptions,
  service: EngineSnapshotService = snapshotService,
): Promise<Blob> {
  return (await renderEngineSnapshotWithMeta(editor, options, service)).blob;
}

/**
 * Renders layers as a raster export (PNG, JPEG or WebP) with decision 0039 backdrop context,
 * whole-pixel snapping, JPEG white default background, and the engine's 8,192 px limit.
 */
export async function renderEngineRasterExportWithMeta(
  editor: Editor,
  ids: readonly string[],
  options: {
    readonly format: RasterFormat;
    readonly scale: number;
    readonly background?: string | null;
    readonly quality?: number;
    readonly images?: ImageCache;
    readonly imageBudget?: number;
    readonly priority?: SnapshotPriority;
    readonly signal?: AbortSignal;
  },
  service: EngineSnapshotService = snapshotService,
): Promise<SnapshotResult> {
  const bounds = exportBounds(editor.scene, ids);
  if (!bounds) {
    throw new ExportError("Nothing visible to export. Show the layer and try again.");
  }
  const rect = snapToPixels(bounds, options.scale);
  const width = Math.max(1, Math.round(rect.width * options.scale));
  const height = Math.max(1, Math.round(rect.height * options.scale));
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width > MAX_SIDE ||
    height > MAX_SIDE ||
    width * height > MAX_EXPORT_PIXELS
  ) {
    throw exportSizeError(width, height, MAX_SIDE);
  }
  const background =
    options.background === undefined
      ? options.format === "jpeg"
        ? "#ffffff"
        : null
      : options.background;
  return renderEngineSnapshotWithMeta(
    editor,
    {
      ids,
      rect,
      width,
      height,
      scale: options.scale,
      format: options.format,
      ...(options.quality !== undefined ? { quality: options.quality } : {}),
      background,
      context: true,
      ...(options.images ? { images: options.images } : {}),
      ...(options.imageBudget !== undefined ? { imageBudget: options.imageBudget } : {}),
      priority: options.priority ?? "high",
      ...(options.signal ? { signal: options.signal } : {}),
    },
    service,
  );
}

/**
 * Renders layers as a raster export (PNG, JPEG or WebP) on the engine snapshot service.
 */
export async function renderEngineRasterExport(
  editor: Editor,
  ids: readonly string[],
  options: {
    readonly format: RasterFormat;
    readonly scale: number;
    readonly background?: string | null;
    readonly quality?: number;
    readonly images?: ImageCache;
    readonly imageBudget?: number;
    readonly priority?: SnapshotPriority;
    readonly signal?: AbortSignal;
  },
  service: EngineSnapshotService = snapshotService,
): Promise<Blob> {
  return (await renderEngineRasterExportWithMeta(editor, ids, options, service)).blob;
}
