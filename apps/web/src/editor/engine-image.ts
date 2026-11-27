import type { ImageCache, ImageDemand, Size } from "@drawpane/editor";
import type { RenderEngine } from "@drawpane/engine";
import {
  exifOrientationComplete,
  MEDIA_PREVIEW_SIZES,
  type MediaPreviewSize,
  mediaPreviewDimensions,
  sniffImage,
} from "@drawpane/model";
import type { DecodeReply, DecodeRequest } from "./image-decode.worker";
import type { MobileRendererMemory } from "./renderer-memory";

const MIB = 1024 * 1024;
const MAX_DECODES = 4;
const MAX_FETCHES = 6;
/** Dedicated fetch slots reserved for urgent direct-full / upgrade fetches. */
const URGENT_FETCH_SLOTS = 2;
/** Dedicated fetch slots reserved strictly for visible previews (`?w=256` / `?w=1024`). */
const PREVIEW_FETCH_SLOTS = 4;
/** Concurrent visible original-refinement slots shared alongside active preview fetches. */
const REFINE_CONCURRENT_SLOTS = 2;
/** Cap on decoded full-original bitmaps staged for batched GPU upload after initial preview paint. */
const STAGED_UPLOAD_BYTES = 16 * MIB;
const PREFETCH_RATIOS = [2, 4];
const DECODE_BYTES = 64 * MIB;
const ZOOM_SAMPLE_MS = 100;
const ZOOM_LOOKAHEAD_MS = 180;
const MAX_ZOOM_LOOKAHEAD = 8;
const UPLOAD_SLICE_BYTES = 12 * MIB;
/**
 * A backend that uploads in row strips (`ImageBackend.uploadRows`) gets at most this much a frame,
 * in strips of at most `UPLOAD_STRIP_BYTES`: on a T4 a 1 MiB strip of an ImageBitmap holds the
 * main thread 1.5-2 ms, a whole 12 MiB level 20-55 ms.
 */
const UPLOAD_FRAME_BYTES = 2 * MIB;
const UPLOAD_STRIP_BYTES = 1 * MIB;
const REQUEST_TIMEOUT_MS = 8000;
/** Full originals (up to 20 MB) need a wider timeout than small previews on slow links (e.g. 10 Mbps). */
const FULL_FETCH_TIMEOUT_MS = 30_000;
const SOURCE_BUDGET = 64 * MIB;
const MAX_BITMAP_SIDE = 4096;
const LARGEST_PREVIEW_TIER = MEDIA_PREVIEW_SIZES[MEDIA_PREVIEW_SIZES.length - 1] ?? 1024;
export const CPU_IMAGE_BUDGET = 64 * MIB;
export const CPU_IMAGE_SIDE = MAX_BITMAP_SIDE;

export type ImageTier = MediaPreviewSize | "full";
type FetchLane = "urgent" | "preview" | "refine" | "background";

function tierRank(tier: ImageTier): number {
  return tier === "full" ? Number.POSITIVE_INFINITY : tier;
}

/** True when a decoded/cached `have` tier satisfies a demand for `need`. */
export function tierCovers(have: ImageTier, need: ImageTier): boolean {
  return tierRank(have) >= tierRank(need);
}

/**
 * Smallest server tier that supplies enough pixels for an immediate preview of `target` on an
 * image of `natural` size. When the view demands `> 1024` pixels, or the chosen mip level already
 * requires full natural resolution (`natural <= demanded` or `target >= natural`), returns `"full"`
 * so upgrades fetch directly in Lane A without sitting behind `?w=256` bursts.
 * Previews are never considered exact: visible images always refine to `"full"` at rest.
 */
export function tierForTarget(natural: Size, target: Size, demanded?: number): ImageTier {
  const naturalLong = Math.max(natural.width, natural.height);
  const targetLong = Math.max(target.width, target.height);
  if (demanded !== undefined && (demanded > LARGEST_PREVIEW_TIER || naturalLong <= demanded)) {
    return "full";
  }
  if (target.width >= natural.width && target.height >= natural.height) {
    return "full";
  }
  for (const size of MEDIA_PREVIEW_SIZES) {
    if (targetLong <= size) return size;
  }
  return "full";
}

/** Initial network tier chosen before natural dimensions are known, using the layout box hint. */
export function initialTierForDemand(visible: boolean, demandedPx: number): ImageTier {
  if (!visible) return MEDIA_PREVIEW_SIZES[0];
  if (demandedPx > LARGEST_PREVIEW_TIER) return "full";
  for (const size of MEDIA_PREVIEW_SIZES) {
    if (demandedPx <= size) return size;
  }
  return "full";
}

export function deviceImageBudget(max: number): number {
  const navigator = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  const memory = navigator?.deviceMemory;
  // iPadOS can advertise a desktop user agent while still having touch input.
  const mobile =
    (navigator?.maxTouchPoints ?? 0) > 0 ||
    /\b(Android|iPhone|iPad|iPod|Mobile)\b/i.test(navigator?.userAgent ?? "");
  const mib = memory && memory > 0 ? Math.max(16, memory * 48) : mobile ? 128 : 192;
  return Math.min(max, mib * MIB);
}

export function uploadCpuLevel(engine: RenderEngine, handle: number, bitmap: ImageBitmap) {
  const { width, height } = bitmap;
  const surface = new OffscreenCanvas(width, height);
  const ctx = surface.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("could not read image pixels");
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;
  return engine.putCpuImageLevel(handle, width, height, new Uint8Array(data.buffer));
}

interface ImageInfo extends Size {
  readonly handle: number;
}

interface Source {
  info: ImageInfo;
  version: number;
  readonly blobs: Map<ImageTier, Blob>;
  /** True when the server streamed the original (no previews exist) or a preview failed decode. */
  fullOnly: boolean;
  /** True once `info` has been verified against the original image bytes (not just preview headers). */
  naturalVerified: boolean;
  used: number;
  pyramidMaxSide?: number;
  pyramid?: { zoom: Size[]; rest: Size[] };
}

interface MetaDemand {
  visible: boolean;
  demandedPx: number;
  centerDistance: number;
}

interface Target extends Size {
  readonly ref: string;
  readonly handle: number;
  readonly priority: number;
  readonly tier: ImageTier;
  /** Preview tier that suffices for immediate display (may be smaller than `tier: "full"`). */
  readonly previewTier?: ImageTier;
  /** Largest demanded pixel edge on screen, used to order fetches and refinements. */
  readonly demandedPx?: number;
  /** Nearest layer bounds distance to the viewport centre, used as visual-importance tie-breaker. */
  readonly centerDistance?: number;
  readonly forecast?: boolean;
  readonly standIn?: boolean;
}

interface StagedUpload {
  readonly target: Target;
  readonly bitmap: ImageBitmap;
  readonly bytes: number;
}

/** Visual importance ordering: largest on-screen span first, nearest the viewport centre first. */
function compareImportance(
  a: { readonly demandedPx?: number; readonly centerDistance?: number },
  b: { readonly demandedPx?: number; readonly centerDistance?: number },
): number {
  const spanDiff = Math.round(b.demandedPx ?? 0) - Math.round(a.demandedPx ?? 0);
  if (spanDiff !== 0) return spanDiff;
  return (a.centerDistance ?? Infinity) - (b.centerDistance ?? Infinity);
}

interface Resident extends Target {
  used: number;
}

interface ImageBackend {
  readonly retryUpload?: boolean;
  upload(handle: number, bitmap: ImageBitmap): boolean | Promise<boolean>;
  /**
   * Uploads rows `y` to `y + rows` of a level, in order from 0, so a large one spreads over
   * frames. The level is drawn once its last rows are in, in place of the resident one of its
   * width, kept until then (both count against the budget meanwhile).
   */
  uploadRows?(handle: number, bitmap: ImageBitmap, y: number, rows: number): boolean;
  /** Lets go of a level left part done by `uploadRows` (the resident one of its width stays). */
  cancelRows?(handle: number, width: number): void;
  drop(handle: number, width: number): void;
}

const bytes = ({ width, height }: Size) => width * height * 4;
const levelKey = ({ handle, width }: { handle: number; width: number }) => `${handle}/${width}`;
const jobKey = ({ handle, width, tier }: { handle: number; width: number; tier: ImageTier }) =>
  `${handle}/${width}/${tier}`;
const fetchKey = (ref: string, tier: ImageTier) => `fetch:${ref}/${tier}`;
const metaKey = (ref: string) => `meta:${ref}`;
const resize = ({ width, height }: Size): ImageBitmapOptions => ({
  resizeWidth: width,
  resizeHeight: height,
  resizeQuality: "high",
  premultiplyAlpha: "premultiply",
});

function fits(level: Size, needed: Size): boolean {
  return level.width >= needed.width && level.height >= needed.height;
}

function satisfies(
  level: { readonly width: number; readonly height: number; readonly tier: ImageTier },
  needed: { readonly width: number; readonly height: number; readonly tier: ImageTier },
): boolean {
  return fits(level, needed) && tierCovers(level.tier, needed.tier);
}

function cachedBlobFor(
  source: Source,
  need: ImageTier,
): { readonly tier: ImageTier; readonly blob: Blob } | undefined {
  let bestTier: ImageTier | undefined;
  let bestBlob: Blob | undefined;
  for (const [tier, blob] of source.blobs) {
    if (!tierCovers(tier, need)) continue;
    if (!bestTier || tierRank(tier) < tierRank(bestTier)) {
      bestTier = tier;
      bestBlob = blob;
    }
  }
  return bestTier && bestBlob ? { tier: bestTier, blob: bestBlob } : undefined;
}

function largestCachedBlob(
  source: Source,
): { readonly tier: ImageTier; readonly blob: Blob } | undefined {
  let bestTier: ImageTier | undefined;
  let bestBlob: Blob | undefined;
  for (const [tier, blob] of source.blobs) {
    if (!bestTier || tierRank(tier) > tierRank(bestTier)) {
      bestTier = tier;
      bestBlob = blob;
    }
  }
  return bestTier && bestBlob ? { tier: bestTier, blob: bestBlob } : undefined;
}

function storeBlob(source: Source, tier: ImageTier, blob: Blob): void {
  source.blobs.set(tier, blob);
  // Once a finer tier is cached, smaller preview blobs are redundant because local decoding can
  // downscale from the finer blob directly.
  for (const existing of [...source.blobs.keys()]) {
    if (tierRank(existing) < tierRank(tier)) source.blobs.delete(existing);
  }
}

function levels(size: Size, maxSide: number): { zoom: Size[]; rest: Size[] } {
  const fit = Math.min(1, maxSide / Math.max(size.width, size.height));
  let width = Math.max(1, Math.floor(size.width * fit));
  let height = Math.max(1, Math.floor(size.height * fit));
  const largest = { width, height };
  const zoom = [largest];
  while (width >= 2 && Math.max(width, height) >= 64) {
    width = Math.floor(width / 2);
    height = Math.max(1, Math.floor(height / 2));
    zoom.push({ width, height });
  }
  // Large photos on high-DPR displays could round up to nearly four times the
  // visible pixel count. Stable 256 px steps keep headroom without decoding a
  // different size on every camera tick.
  if (Math.max(size.width, size.height) < 3072) return { zoom, rest: zoom };
  const side = Math.max(largest.width, largest.height);
  const byWidth = new Map(zoom.map((level) => [level.width, level]));
  for (let step = 1280; step < side; step += 256) {
    const smaller = {
      width: Math.ceil((largest.width * step) / side),
      height: Math.ceil((largest.height * step) / side),
    };
    if (!byWidth.has(smaller.width)) byWidth.set(smaller.width, smaller);
  }
  return { zoom, rest: [...byWidth.values()].sort((a, b) => b.width - a.width) };
}

function levelFor(pyramid: readonly Size[], span: Size, scale: number): number {
  return Math.max(
    0,
    pyramid.findLastIndex(
      (size) => size.width >= span.width * scale && size.height >= span.height * scale,
    ),
  );
}

type Decode = (blob: Blob, options: ImageBitmapOptions) => Promise<ImageBitmap>;

/**
 * A decoder that runs `createImageBitmap(blob, options)` in the worker `spawn` starts, or on this
 * thread if none starts or it fails. Chrome finishes a decode's resize and premultiply on the
 * calling thread (see image-decode.worker.ts), so on the main thread a large photo's decode is a
 * long task.
 */
export function imageDecoder(spawn: () => Worker | null): Decode {
  type Job = {
    readonly blob: Blob;
    readonly options: ImageBitmapOptions;
    resolve(bitmap: ImageBitmap): void;
    reject(error: unknown): void;
  };
  const jobs = new Map<number, Job>();
  const here = (job: Job) =>
    void createImageBitmap(job.blob, job.options).then(job.resolve, job.reject);
  let worker: Worker | null | undefined;
  let ticket = 0;
  const start = (): Worker | null => {
    try {
      worker = spawn();
    } catch {
      worker = null;
    }
    if (!worker) return null;
    const started = worker;
    started.onmessage = ({ data }: MessageEvent<DecodeReply>) => {
      const job = jobs.get(data.id);
      if (!job) {
        if ("bitmap" in data) data.bitmap.close();
        return;
      }
      jobs.delete(data.id);
      if ("bitmap" in data) job.resolve(data.bitmap);
      else job.reject(new Error(data.error));
    };
    started.onerror = () => {
      // It could not load (a strict CSP, say) or it died: decode here from now on.
      started.terminate();
      worker = null;
      const stranded = [...jobs.values()];
      jobs.clear();
      for (const job of stranded) here(job);
    };
    return started;
  };
  return (blob, options) =>
    new Promise<ImageBitmap>((resolve, reject) => {
      const job = { blob, options, resolve, reject };
      const target = worker === undefined ? start() : worker;
      if (!target) {
        here(job);
        return;
      }
      const id = ++ticket;
      jobs.set(id, job);
      target.postMessage({ id, blob, options } satisfies DecodeRequest);
    });
}

const decodeInWorker = imageDecoder(() =>
  typeof Worker === "function"
    ? new Worker(new URL("./image-decode.worker.ts", import.meta.url), { type: "module" })
    : null,
);

/** Rejects abandoned work promptly and closes a bitmap that resolves after cancellation. */
function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  release?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) release?.(value);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function nextUploadFrame(): Promise<void> {
  return new Promise((resolve) => {
    // Background tabs may suspend rAF while an offscreen render is waiting.
    const timer = setTimeout(resolve, 32);
    globalThis.requestAnimationFrame?.(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function naturalSize(blob: Blob, signal: AbortSignal): Promise<Size> {
  // JPEG and WebP may carry EXIF orientation. Use the browser's oriented size.
  const header = sniffImage(new Uint8Array(await blob.slice(0, 32).arrayBuffer()));
  if (header?.mime === "image/gif" || header?.mime === "image/png") return header;
  const bitmap = await untilAborted(createImageBitmap(blob), signal, (bitmap) => bitmap.close());
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

const EXIF_HEAD_BYTES = 65_536;

/**
 * Determines the authoritative display-oriented natural size of a full original blob.
 * Reads PNG/GIF and standard JPEG/WebP headers in O(1) without an extra full decode, and falls
 * back to `createImageBitmap(blob)` whenever EXIF may lie past 64 KB or headers are absent.
 */
async function originalNaturalSize(
  blob: Blob,
  signal: AbortSignal,
  fallbackSize?: Size,
): Promise<Size | null> {
  const head = new Uint8Array(await blob.slice(0, EXIF_HEAD_BYTES).arrayBuffer());
  const sniffed = sniffImage(head);
  if (sniffed) {
    if (sniffed.mime === "image/png" || sniffed.mime === "image/gif") {
      return { width: sniffed.width, height: sniffed.height };
    }
    const orientation = exifOrientationComplete(head);
    if (orientation !== null) {
      return orientation >= 5 && orientation <= 8
        ? { width: sniffed.height, height: sniffed.width }
        : { width: sniffed.width, height: sniffed.height };
    }
    try {
      return await naturalSize(blob, signal);
    } catch {
      return null;
    }
  }
  if (fallbackSize) return fallbackSize;
  try {
    return await naturalSize(blob, signal);
  } catch {
    return null;
  }
}

/** One view's bounded set of image levels. The sources can be decoded again after eviction. */
export class ViewImages {
  readonly #sources = new Map<string, Source>();
  /** Resident GPU/CPU textures keyed by `levelKey(handle, width)` (matches Rust engine). */
  readonly #residents = new Map<string, Resident>();
  /** Active worker decode/upload jobs keyed by `jobKey(handle, width, tier)`. */
  readonly #decodeJobs = new Map<string, { ref: string; abort: AbortController; target: Target }>();
  /** Active network fetches keyed by `metaKey(ref)` or `fetchKey(ref, tier)`. */
  readonly #fetchJobs = new Map<
    string,
    { ref: string; abort: AbortController; tier: ImageTier; lane: FetchLane }
  >();
  readonly #retryAt = new Map<string, { at: number; attempts: number; version: number }>();
  readonly #denied = new Set<string>();
  readonly #failed = new Map<string, number>();
  /** Refs whose `?w=` preview failed decoding and must bypass previews for the full original. */
  readonly #previewBroken = new Set<string>();
  /** Decoded full-original replacement bitmaps staged until initial preview paint presents. */
  readonly #staged = new Map<string, StagedUpload>();
  readonly #protected = new Set<string>();
  #fallbacks = new Map<string, Target>();
  #primary = new Map<string, Target>();
  #visible = new Set<string>();
  #targets = new Map<string, Target>();
  #metadata = new Map<string, MetaDemand>();
  #backend: ImageBackend | null = null;
  #budget = 0;
  #hidden = false;
  #zooming = false;
  #deferRefine = false;
  #opening = false;
  #reduced = 0;
  #uploadedThisFrame = 0;
  #uploadFrame: Promise<void> | undefined;
  #inflightBytes = 0;
  #stagedBytes = 0;
  #flushingBytes = 0;
  #thumbnailBytes = 0;
  #peakBytes = 0;
  #flushingStaged = false;
  /** Decoded levels waiting their turn to upload, one at a time, what the view shows first. */
  #commits: {
    key: string;
    priority: number;
    seq: number;
    run(): Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
  }[] = [];
  #commitSeq = 0;
  #committing = false;
  #residentBytes = 0;
  #clock = 0;
  #nextHandle = 1;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #refineTimer: ReturnType<typeof setTimeout> | undefined;
  #zoomSample: { scale: number; at: number } | undefined;
  #forecastScale = 0;

  constructor(
    private readonly cache: Pick<ImageCache, "encoded" | "encodedVersion">,
    private readonly metadataReady: (ref: string) => void,
    private readonly changed: () => void,
    private readonly decode: Decode = decodeInWorker,
    private readonly onPreviewMissing?: (ref: string, blob: Blob) => void,
    private readonly onAllVisibleFullReady?: () => void,
    private readonly memory?: MobileRendererMemory,
  ) {}

  info(ref: string): ImageInfo | null {
    return this.#sources.get(ref)?.info ?? null;
  }

  get residentBytes(): number {
    return this.#residentBytes;
  }

  get memoryEstimate() {
    return {
      budget: this.#budget,
      residentBytes: this.#residentBytes,
      workingBytes: this.#workingBytes,
      peakBytes: this.#peakBytes,
    };
  }

  get #workingBytes(): number {
    return this.#inflightBytes + this.#stagedBytes + this.#flushingBytes + this.#thumbnailBytes;
  }

  #recordMemory(): void {
    this.#peakBytes = Math.max(this.#peakBytes, this.#residentBytes + this.#workingBytes);
  }

  get budget(): number {
    return this.#budget;
  }

  get reduced(): number {
    return this.#reduced;
  }

  /** True when every visible image has a resident texture (or cannot load) and no urgent/preview fetch is running. */
  get allVisiblePreviewResident(): boolean {
    return this.#allVisibleHaveResident();
  }

  /** True when every visible primary image is either resident at `"full"` or decoded and staged at `"full"`. */
  get allVisibleFullReady(): boolean {
    for (const demand of this.#metadata.values()) {
      if (demand.visible) return false;
    }
    let count = 0;
    for (const target of this.#primary.values()) {
      count++;
      if (this.#hasSatisfyingResident(target)) continue;
      const staged = this.#staged.get(levelKey(target));
      if (staged && satisfies(staged.target, target)) continue;
      return false;
    }
    return count > 0;
  }

  /** Controls whether full-original GPU replacement uploads stage for batch flush after initial preview paint. */
  setDeferRefine(defer: boolean): void {
    if (this.#deferRefine === defer) return;
    this.#deferRefine = defer;
    if (!defer) {
      this.#flushStaged();
      this.#pump();
    }
  }

  #clearStaged(): void {
    for (const entry of this.#staged.values()) entry.bitmap.close();
    this.#staged.clear();
    this.#stagedBytes = 0;
  }

  setBackend(backend: ImageBackend | null): void {
    this.evict();
    this.#denied.clear();
    this.#backend = backend;
  }

  /** Releases pixel memory and cancels work which could bring it back while hidden. */
  evict(keepVisible = false): void {
    for (const { abort } of this.#decodeJobs.values()) abort.abort();
    for (const { abort } of this.#fetchJobs.values()) abort.abort();
    this.#clearStaged();
    this.#hidden = keepVisible;
    const keep = keepVisible ? this.#closestVisible() : new Map<string, Resident>();
    for (const [key, level] of this.#residents) {
      const thumbnail = this.#fallbacks.get(level.ref);
      if (
        keep.get(level.ref) !== level &&
        (!keepVisible || !thumbnail || levelKey(thumbnail) !== key)
      )
        this.#drop(key);
    }
    this.#targets.clear();
    this.#metadata.clear();
    if (!keepVisible) {
      this.#visible.clear();
      this.#fallbacks.clear();
    }
    this.#primary.clear();
    this.#protected.clear();
    this.#zoomSample = undefined;
    this.#forecastScale = 0;
    this.#zooming = false;
    this.#deferRefine = false;
    this.#opening = false;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    clearTimeout(this.#refineTimer);
    this.#refineTimer = undefined;
  }

  retain(used: ReadonlySet<string>): void {
    for (const { ref, abort } of this.#decodeJobs.values()) if (!used.has(ref)) abort.abort();
    for (const { ref, abort } of this.#fetchJobs.values()) if (!used.has(ref)) abort.abort();
    for (const [key, entry] of this.#staged) {
      if (!used.has(entry.target.ref)) {
        entry.bitmap.close();
        this.#stagedBytes -= entry.bytes;
        this.#staged.delete(key);
      }
    }
    for (const ref of this.#sources.keys()) if (!used.has(ref)) this.#sources.delete(ref);
    for (const ref of this.#metadata.keys()) if (!used.has(ref)) this.#metadata.delete(ref);
    for (const ref of this.#previewBroken) if (!used.has(ref)) this.#previewBroken.delete(ref);
    for (const [key, target] of this.#targets) if (!used.has(target.ref)) this.#targets.delete(key);
    for (const [key, level] of this.#residents) if (!used.has(level.ref)) this.#drop(key);
  }

  #predictScale(scale: number, now: number): number {
    const previous = this.#zoomSample;
    const elapsed = previous ? now - previous.at : Infinity;
    if (!previous || elapsed >= ZOOM_SAMPLE_MS || scale < previous.scale) {
      this.#forecastScale = scale;
    } else if (scale > previous.scale && elapsed > 0) {
      const velocity = Math.log(scale / previous.scale) / Math.max(elapsed, 8);
      const growth = Math.min(MAX_ZOOM_LOOKAHEAD, Math.exp(velocity * ZOOM_LOOKAHEAD_MS));
      this.#forecastScale = scale * growth;
    }
    if (!previous || scale !== previous.scale || elapsed >= ZOOM_SAMPLE_MS)
      this.#zoomSample = { scale, at: now };
    return this.#forecastScale;
  }

  #clearRetries(ref: string, version: number): void {
    for (const [key, retry] of this.#retryAt) {
      if (retry.version !== version && (key === metaKey(ref) || key.startsWith(`fetch:${ref}/`))) {
        this.#retryAt.delete(key);
      }
    }
  }

  #previewTierOf(source: Source, ref: string, size: Size, demanded?: number): ImageTier {
    if (source.fullOnly || this.#previewBroken.has(ref)) return "full";
    return tierForTarget(source.info, size, demanded);
  }

  #initialTierOf(ref: string, demand: MetaDemand): ImageTier {
    if (this.#previewBroken.has(ref)) return "full";
    return initialTierForDemand(demand.visible, demand.demandedPx);
  }

  #fetchTierForTarget(target: Target): ImageTier {
    if (target.priority > 0) return target.tier;
    const source = this.#sources.get(target.ref);
    if (!source || source.fullOnly || this.#previewBroken.has(target.ref)) return "full";
    const previewNeed = target.previewTier ?? "full";
    if (previewNeed === "full") return "full";
    if (cachedBlobFor(source, previewNeed)) return "full";
    // While actively zooming, fetch intermediate preview tiers first; at rest, go straight to full
    // if a smaller preview is already cached locally.
    if (!this.#zooming && largestCachedBlob(source)) return "full";
    return previewNeed;
  }

  #isUrgentTarget(target: Target): boolean {
    if (target.priority !== 0 || target.standIn) return false;
    const source = this.#sources.get(target.ref);
    if (!source) return false;
    const previewNeed = target.previewTier ?? "full";
    return !cachedBlobFor(source, previewNeed);
  }

  update(
    demands: Iterable<ImageDemand>,
    scale: number,
    limits: { side: number; bytes: number },
    now = performance.now(),
    deferRefine = false,
    opening = false,
  ): boolean {
    if (!this.#backend) return true;
    this.#hidden = false;
    clearTimeout(this.#refineTimer);
    this.#refineTimer = undefined;
    const budget = this.memory
      ? Math.min(limits.bytes, this.memory.imageBytes)
      : deviceImageBudget(limits.bytes);
    if (budget !== this.#budget) this.#denied.clear();
    const maxSide = Math.min(this.memory?.imageSide ?? MAX_BITMAP_SIDE, limits.side);
    const candidates = new Map<string, Target>();
    const metadata = new Map<string, MetaDemand>();
    const ideal = new Map<string, Target>();
    const forecasts = new Map<string, Target>();
    const fallbacks = new Map<string, Target>();
    const pyramids = new Map<string, ReturnType<typeof levels>>();
    const heldByHandle = new Map<number, Resident[]>();
    for (const level of this.#residents.values()) {
      const held = heldByHandle.get(level.handle) ?? [];
      held.push(level);
      heldByHandle.set(level.handle, held);
    }
    const visible = new Set<string>();
    const reduced = new Set<string>();
    const clock = ++this.#clock;
    const scaleChanged = this.#zoomSample !== undefined && this.#zoomSample.scale !== scale;
    const forecastScale = this.#predictScale(scale, now);
    const zooming = scaleChanged || forecastScale > scale;
    this.#zooming = zooming;
    this.#deferRefine = deferRefine;
    this.#opening = opening;

    for (const { ref, visible: onScreen, span, hint, centerDistance } of demands) {
      if (onScreen) visible.add(ref);
      const source = this.#sources.get(ref);
      const version = this.cache.encodedVersion(ref);
      this.#clearRetries(ref, version);
      if (source && source.version !== version) {
        source.version = version;
        source.blobs.clear();
        source.fullOnly = false;
        source.naturalVerified = false;
        this.#previewBroken.delete(ref);
      }
      if (this.#failed.get(ref) === version) {
        if (onScreen) reduced.add(ref);
        continue;
      }
      if (!source) {
        const estSpan = span ?? hint;
        const estPx = estSpan ? Math.max(estSpan.width, estSpan.height) * scale : 0;
        const dist = centerDistance ?? Infinity;
        const prev = metadata.get(ref);
        metadata.set(ref, {
          visible: onScreen || Boolean(prev?.visible),
          demandedPx: Math.max(prev?.demandedPx ?? 0, onScreen ? estPx : 0),
          centerDistance: Math.min(prev?.centerDistance ?? Infinity, onScreen ? dist : Infinity),
        });
        if (onScreen && this.#retryAt.has(metaKey(ref))) reduced.add(ref);
        continue;
      }
      if (!span) continue;
      source.used = clock;
      let pyramid = pyramids.get(ref);
      if (!pyramid) {
        if (source.pyramid && source.pyramidMaxSide === maxSide) {
          pyramid = source.pyramid;
        } else {
          pyramid = levels(source.info, maxSide);
          source.pyramid = pyramid;
          source.pyramidMaxSide = maxSide;
        }
        pyramids.set(ref, pyramid);
      }
      const sizing = zooming ? pyramid.zoom : pyramid.rest;
      const handle = source.info.handle;
      const demanded = Math.max(span.width, span.height) * scale;
      let size = pyramid.rest[levelFor(pyramid.rest, span, scale)];
      if (!size) continue;

      // Strict exactness rule: visible images always require original-backed pixels (`"full"`).
      // Off-screen neighbouring ring stays capped to the smallest preview over the network.
      let tier: ImageTier = "full";
      const previewTier = this.#previewTierOf(source, ref, size, demanded);
      if (!onScreen && !cachedBlobFor(source, "full")) {
        const maxOffscreen = MEDIA_PREVIEW_SIZES[0];
        const capped =
          pyramid.zoom.find((l) => Math.max(l.width, l.height) <= maxOffscreen) ??
          pyramid.zoom.at(-1);
        if (capped && capped.width < size.width) {
          size = capped;
        }
        tier = source.fullOnly || this.#previewBroken.has(ref) ? "full" : maxOffscreen;
      }
      const dist = centerDistance ?? Infinity;
      const wanted: Target = {
        ...size,
        ref,
        handle,
        priority: onScreen ? 0 : 3,
        tier,
        previewTier,
        demandedPx: demanded,
        centerDistance: dist,
      };
      if (onScreen) ideal.set(jobKey(wanted), wanted);
      const start = onScreen
        ? levelFor(sizing, span, scale)
        : Math.max(
            0,
            sizing.findIndex((level) => level.width <= size.width),
          );
      let availableSize: Size | undefined = sizing
        .slice(start)
        .find((level) => !this.#denied.has(levelKey({ handle, width: level.width })));
      let availableTier: ImageTier | undefined = availableSize
        ? onScreen
          ? "full"
          : tier
        : undefined;
      if (onScreen && availableSize && availableTier) {
        // A prefetched original-backed level can satisfy the current view. Charge its real size
        // to the plan so it still gives way under budget pressure.
        let held: Resident | undefined;
        for (const level of heldByHandle.get(handle) ?? []) {
          if (satisfies(level, wanted) && (!held || level.width < held.width)) held = level;
        }
        if (held) {
          availableSize = held;
          availableTier = held.tier;
        } else {
          // A zoom level can still finish after the camera stops moving.
          for (const job of this.#decodeJobs.values()) {
            const pending = job.target;
            if (
              pending.handle === handle &&
              pending.priority === 0 &&
              !pending.standIn &&
              !job.abort.signal.aborted &&
              satisfies(pending, wanted)
            ) {
              availableSize = pending;
              availableTier = pending.tier;
              break;
            }
          }
        }
      }
      if (availableSize && availableTier) {
        const target: Target = {
          ...wanted,
          width: availableSize.width,
          height: availableSize.height,
          tier: availableTier,
          previewTier: onScreen ? this.#previewTierOf(source, ref, availableSize, demanded) : tier,
          demandedPx: demanded,
          centerDistance: dist,
        };
        const key = jobKey(target);
        const previous = candidates.get(key);
        if (!previous || target.priority < previous.priority) {
          candidates.set(key, target);
        } else if (previous && target.priority === previous.priority) {
          const bestDemanded = Math.max(previous.demandedPx ?? 0, target.demandedPx ?? 0);
          const bestDist = Math.min(
            previous.centerDistance ?? Infinity,
            target.centerDistance ?? Infinity,
          );
          if (bestDemanded !== previous.demandedPx || bestDist !== previous.centerDistance) {
            candidates.set(key, {
              ...previous,
              demandedPx: bestDemanded,
              centerDistance: bestDist,
            });
          }
        }
      }
      if (onScreen) {
        const coarse = pyramid.zoom.at(-1);
        if (coarse) {
          fallbacks.set(ref, {
            ...coarse,
            ref,
            handle,
            priority: 0,
            tier: this.#previewTierOf(source, ref, coarse, 0),
          });
        }
        const projected = pyramid.zoom[levelFor(pyramid.zoom, span, forecastScale)];
        if (
          forecastScale > scale &&
          projected &&
          projected.width > (availableSize?.width ?? size.width)
        ) {
          const forecastDemanded = Math.max(span.width, span.height) * forecastScale;
          const forecast: Target = {
            ...projected,
            ref,
            handle,
            priority: 1,
            tier: this.#previewTierOf(source, ref, projected, forecastDemanded),
            demandedPx: forecastDemanded,
            forecast: true,
          };
          const previous = forecasts.get(ref);
          if (
            (!previous || forecast.width > previous.width) &&
            !this.#denied.has(levelKey(forecast))
          )
            forecasts.set(ref, forecast);
        }
        for (const [index, ratio] of PREFETCH_RATIOS.entries()) {
          const finer = pyramid.zoom[levelFor(pyramid.zoom, span, scale * ratio)];
          if (!finer || finer.width <= (availableSize?.width ?? size.width)) continue;
          // Speculative zoom-ahead prefetch never triggers network fetches; it only decodes
          // finer original-backed mip levels from a full blob already cached locally.
          if (!cachedBlobFor(source, "full")) continue;
          const target: Target = {
            ...finer,
            ref,
            handle,
            priority: 4 + index,
            tier: "full",
          };
          const key = jobKey(target);
          if (!candidates.has(key) && !this.#denied.has(levelKey(target)))
            candidates.set(key, target);
        }
      }
    }

    for (const { target, abort } of this.#decodeJobs.values()) {
      const key = jobKey(target);
      if (!target.forecast || abort.signal.aborted || candidates.get(key)?.priority === 0) continue;
      const useful = [...candidates.values()].some(
        (level) =>
          level.priority === 0 &&
          level.ref === target.ref &&
          satisfies(target, level) &&
          !this.#hasSatisfyingResident(level),
      );
      if (forecasts.has(target.ref) || useful) {
        forecasts.set(target.ref, target);
      }
    }

    const targets = new Map<string, Target>();
    const primary = [...candidates.values()].filter((target) => target.priority === 0);
    const fallbackBytes = [...fallbacks.values()].reduce((sum, level) => sum + bytes(level), 0);
    const plannedBytes = (target: Target) =>
      target.width === fallbacks.get(target.ref)?.width ? 0 : bytes(target);
    let planned = primary.reduce((sum, target) => sum + plannedBytes(target), fallbackBytes);
    // Fit all visible images before allocating space for speculative detail.
    while (planned > budget) {
      let largest = -1;
      let largestBytes = 0;
      let replacement: Target | undefined;
      for (const [i, target] of primary.entries()) {
        if (bytes(target) <= largestBytes) continue;
        const source = this.#sources.get(target.ref);
        const smaller = pyramids
          .get(target.ref)
          ?.rest.find(
            (level) =>
              level.width < target.width &&
              !this.#denied.has(levelKey({ handle: target.handle, width: level.width })),
          );
        if (!smaller || !source) continue;
        largest = i;
        largestBytes = bytes(target);
        replacement = {
          ...target,
          width: smaller.width,
          height: smaller.height,
          tier: "full",
          previewTier: this.#previewTierOf(source, target.ref, smaller, target.demandedPx),
        };
      }
      if (largest < 0 || !replacement) break;
      const removed = primary[largest];
      if (!removed) break;
      planned -= plannedBytes(removed);
      if (primary.some((other, i) => i !== largest && jobKey(other) === jobKey(replacement))) {
        primary.splice(largest, 1);
      } else {
        planned += plannedBytes(replacement);
        primary[largest] = replacement;
      }
    }

    planned = Math.min(fallbackBytes, budget);
    const primaryByRef = new Map<string, Target>();
    const ordered = [
      ...primary,
      ...forecasts.values(),
      ...[...candidates.values()]
        .filter((target) => target.priority > 0)
        .sort((a, b) => a.priority - b.priority),
    ];
    for (let target of ordered) {
      const current = primaryByRef.get(target.ref);
      const credit = target.forecast && current ? plannedBytes(current) : 0;
      if (planned + plannedBytes(target) - credit > budget) {
        if (!target.forecast || !current) continue;
        const source = this.#sources.get(target.ref);
        const affordable = source
          ? pyramids.get(target.ref)?.zoom.find((level) => {
              const choice: Target = {
                ...target,
                width: level.width,
                height: level.height,
                tier: this.#previewTierOf(source, target.ref, level),
              };
              return (
                level.width <= target.width &&
                level.width > current.width &&
                planned + plannedBytes(choice) - credit <= budget &&
                !this.#denied.has(levelKey(choice))
              );
            })
          : undefined;
        if (!affordable || !source) continue;
        target = {
          ...target,
          width: affordable.width,
          height: affordable.height,
          tier: this.#previewTierOf(source, target.ref, affordable),
        };
      }
      const key = jobKey(target);
      if (targets.has(key)) continue;
      targets.set(key, target);
      planned += plannedBytes(target) - credit;
      if (target.priority === 0 && (!current || target.width > current.width))
        primaryByRef.set(target.ref, target);
      const resident = this.#residents.get(levelKey(target));
      if (resident && tierCovers(resident.tier, target.tier)) resident.used = clock;
    }

    // Progressive stand-in: when a visible primary target still needs `"full"` to download,
    // immediately decode and upload the largest already-cached preview so the user sees the
    // image right away while the original downloads or waits for opening/zoom settle.
    // While the display list is still streaming (`opening`), skip decoding a throwaway
    // same-resolution stand-in for tiny assets (`<= 256` px) whose urgent `"full"` original is
    // already targeted in Lane A, avoiding a duplicate decode, GPU upload, and tile invalidation.
    for (const [ref, primaryTarget] of primaryByRef) {
      if (this.#hasSatisfyingResident(primaryTarget)) continue;
      const source = this.#sources.get(ref);
      if (!source || cachedBlobFor(source, primaryTarget.tier)) continue;
      const preview = largestCachedBlob(source);
      if (!preview || preview.tier === "full") continue;
      if (
        this.#opening &&
        primaryTarget.previewTier === "full" &&
        Math.max(source.info.width, source.info.height) <= MEDIA_PREVIEW_SIZES[0] &&
        !this.#retryAt.has(fetchKey(ref, "full")) &&
        this.#failed.get(ref) !== source.version
      ) {
        continue;
      }
      const dims = mediaPreviewDimensions(source.info, preview.tier);
      const fit = Math.min(1, primaryTarget.width / dims.width, primaryTarget.height / dims.height);
      const standInSize = {
        width: Math.max(1, Math.round(dims.width * fit)),
        height: Math.max(1, Math.round(dims.height * fit)),
      };
      const standIn: Target = {
        ...standInSize,
        ref,
        handle: source.info.handle,
        priority: 0,
        tier: preview.tier,
        standIn: true,
      };
      if (
        !this.#hasSatisfyingResident(standIn) &&
        !this.#denied.has(levelKey(standIn)) &&
        bytes(standIn) <= budget
      ) {
        targets.set(jobKey(standIn), standIn);
      }
    }

    // A photo decoded in the neighbouring ring can already be sharp when it
    // enters the view. Give it a thumbnail without waiting for another zoom.
    for (const [ref, fallback] of fallbacks) {
      const primaryTarget = primaryByRef.get(ref);
      if (
        primaryTarget &&
        this.#hasSatisfyingResident(primaryTarget) &&
        !this.#residents.has(levelKey(fallback))
      )
        targets.set(jobKey(fallback), { ...fallback, priority: 2 });
    }

    this.#budget = budget;
    this.#targets = targets;
    this.#primary = primaryByRef;
    this.#fallbacks = fallbacks;
    this.#metadata = metadata;
    this.#visible = visible;

    const neededFetches = new Set<string>();
    for (const ref of metadata.keys()) neededFetches.add(metaKey(ref));
    for (const target of targets.values()) {
      if (target.standIn) continue;
      const source = this.#sources.get(target.ref);
      if (!source || cachedBlobFor(source, target.tier)) continue;
      const fTier = this.#fetchTierForTarget(target);
      neededFetches.add(fetchKey(target.ref, fTier));
      // Keep an already-running `"full"` refinement alive if the target still needs `"full"`.
      if (target.tier === "full" && fTier !== "full") {
        neededFetches.add(fetchKey(target.ref, "full"));
      }
    }
    for (const [key, entry] of this.#staged) {
      if (!targets.has(jobKey(entry.target)) || this.#hasSatisfyingResident(entry.target)) {
        entry.bitmap.close();
        this.#stagedBytes -= entry.bytes;
        this.#staged.delete(key);
      }
    }
    for (const [key, { abort }] of this.#decodeJobs) {
      if (!targets.has(key)) abort.abort();
    }
    for (const [key, { abort }] of this.#fetchJobs) {
      if (!neededFetches.has(key)) abort.abort();
    }
    if (!deferRefine && this.#staged.size > 0) this.#flushStaged();
    this.#pump();

    // Strict exactness rule: previews are NEVER exact. Any visible image still downloading,
    // decoding, or queued to refine to original pixels (`tier: "full"`) keeps the frame
    // provisional (`false`). Any settled visible image whose resident does not cover its ideal
    // pixels AND original tier (due to budget, decode failure, or failed `"full"` fetch) is
    // counted in `reduced` so `EngineView` never reports `exact: true` while showing a preview.
    const pending = new Set<string>();
    let waitingOnZoomForRefine = false;
    for (const [ref, demand] of metadata) {
      if (demand.visible && !this.#retryAt.has(metaKey(ref))) pending.add(ref);
    }
    for (const target of targets.values()) {
      if (target.priority !== 0 || target.standIn) continue;
      if (this.#hasSatisfyingResident(target)) continue;
      const source = this.#sources.get(target.ref);
      const hasBlob = source ? Boolean(cachedBlobFor(source, target.tier)) : false;
      const fTier = this.#fetchTierForTarget(target);
      const fKey = fetchKey(target.ref, fTier);
      const fullKey = fetchKey(target.ref, "full");
      const dKey = jobKey(target);
      const hasRoom = this.#room(target, this.#missingFallback(target)) !== null;
      const backedOff =
        this.#retryAt.has(fKey) || (target.tier === "full" && this.#retryAt.has(fullKey));
      if (
        this.#fetchJobs.has(fKey) ||
        this.#fetchJobs.has(fullKey) ||
        this.#decodeJobs.has(dKey) ||
        (!hasBlob && !backedOff && hasRoom) ||
        (hasBlob && hasRoom)
      ) {
        pending.add(target.ref);
        if (!hasBlob && !backedOff && !this.#isUrgentTarget(target) && zooming) {
          waitingOnZoomForRefine = true;
        }
      }
    }
    if (waitingOnZoomForRefine) {
      const delay = Math.max(0, ZOOM_SAMPLE_MS - (now - (this.#zoomSample?.at ?? now))) + 1;
      this.#refineTimer = setTimeout(() => {
        this.#refineTimer = undefined;
        this.changed();
      }, delay);
    }
    for (const target of ideal.values()) {
      if (!pending.has(target.ref) && !this.#hasSatisfyingResident(target)) {
        reduced.add(target.ref);
      }
    }
    this.#reduced = reduced.size;
    return pending.size === 0;
  }

  #hasSatisfyingResident(target: {
    readonly handle: number;
    readonly width: number;
    readonly height: number;
    readonly tier: ImageTier;
  }): boolean {
    for (const resident of this.#residents.values()) {
      if (resident.handle === target.handle && satisfies(resident, target)) return true;
    }
    return false;
  }

  #hasAnyResident(ref: string): boolean {
    for (const resident of this.#residents.values()) {
      if (resident.ref === ref) return true;
    }
    return false;
  }

  #closestVisible(): Map<string, Resident> {
    const nearest = new Map<string, Resident>();
    for (const resident of this.#residents.values()) {
      if (!this.#visible.has(resident.ref)) continue;
      const wanted = this.#primary.get(resident.ref);
      const previous = nearest.get(resident.ref);
      if (!previous) {
        nearest.set(resident.ref, resident);
        continue;
      }
      const prevSatisfies = wanted ? satisfies(previous, wanted) : false;
      const currSatisfies = wanted ? satisfies(resident, wanted) : false;
      if (
        prevSatisfies
          ? currSatisfies && resident.width < previous.width
          : currSatisfies ||
            resident.width > previous.width ||
            (resident.width === previous.width && tierRank(resident.tier) > tierRank(previous.tier))
      ) {
        nearest.set(resident.ref, resident);
      }
    }
    return nearest;
  }

  #refreshProtection(): void {
    this.#protected.clear();
    for (const [key, resident] of this.#residents) {
      if (!this.#visible.has(resident.ref)) continue;
      const target = this.#targets.get(jobKey(resident));
      if (
        (target?.priority === 0 && !target.standIn) ||
        this.#fallbacks.get(resident.ref)?.width === resident.width
      )
        this.#protected.add(key);
    }
    for (const resident of this.#closestVisible().values()) this.#protected.add(levelKey(resident));
  }

  #missingFallback(target: Target): Target | undefined {
    if ((target.priority !== 0 && !target.forecast) || target.standIn) return;
    const fallback = this.#fallbacks.get(target.ref);
    if (
      fallback &&
      fallback.width < target.width &&
      !this.#residents.has(levelKey(fallback)) &&
      !this.#denied.has(levelKey(fallback))
    )
      return fallback;
  }

  #room(target: Target, missingFallback?: Target): Resident[] | null {
    const existing = this.#residents.get(levelKey(target));
    // A level uploaded in strips lands beside the one it replaces, which goes only then.
    const delta =
      existing && !this.#backend?.uploadRows
        ? Math.max(0, bytes(target) - bytes(existing))
        : bytes(target);
    const available = this.#budget - this.#residentBytes;
    const extra = missingFallback ? bytes(missingFallback) : 0;
    const need = delta + extra - available;
    if (need <= 0) return [];
    const optional: Resident[] = [];
    const replaceable: Resident[] = [];
    const fallback = this.#fallbacks.get(target.ref);
    const mayReplace = Boolean(
      ((target.priority === 0 && !target.standIn) || target.forecast) &&
        fallback &&
        (missingFallback || this.#residents.has(levelKey(fallback))),
    );
    for (const [key, resident] of this.#residents) {
      if (key === levelKey(target)) continue;
      const targetPriority = this.#targets.get(jobKey(resident))?.priority ?? Infinity;
      if (!this.#protected.has(key) && targetPriority > target.priority) {
        optional.push(resident);
      } else if (
        mayReplace &&
        resident.ref === target.ref &&
        resident.width !== fallback?.width &&
        (satisfies(target, resident) ||
          (target.priority === 0 && !target.standIn && targetPriority !== 0))
      ) {
        replaceable.push(resident);
      }
    }
    optional.sort((a, b) => a.used - b.used);
    replaceable.sort((a, b) => a.width - b.width);
    let freed = 0;
    const evict: Resident[] = [];
    for (const level of optional) {
      evict.push(level);
      freed += bytes(level);
      if (freed >= need) return evict;
    }
    // A swap can use the old sharp level's space only after its small stand-in
    // is resident. The stand-in itself must fit beside the old sharp level.
    if (available + freed < extra) return null;
    for (const level of replaceable) {
      evict.push(level);
      freed += bytes(level);
      if (freed >= need) return evict;
    }
    return null;
  }

  /** An actual backend allocation refusal can reclaim optional and off-screen levels. */
  releasePressure(): boolean {
    this.#refreshProtection();
    let freed = false;
    for (const [key, resident] of this.#residents) {
      const thumbnail = this.#fallbacks.get(resident.ref);
      const canKeepThumbnail =
        this.#hidden &&
        thumbnail &&
        levelKey(thumbnail) !== key &&
        this.#residents.has(levelKey(thumbnail));
      if (this.#protected.has(key) && !canKeepThumbnail) continue;
      this.#drop(key);
      freed = true;
    }
    return freed;
  }

  #drop(key: string): void {
    const resident = this.#residents.get(key);
    if (!resident) return;
    this.#residents.delete(key);
    this.#residentBytes -= bytes(resident);
    this.#backend?.drop(resident.handle, resident.width);
  }

  async #paceUpload(need: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      if (!this.#uploadFrame) {
        this.#uploadFrame = nextUploadFrame().then(() => {
          this.#uploadedThisFrame = 0;
          this.#uploadFrame = undefined;
        });
      }
      // The largest allowed single bitmap is 64 MiB. Give an upload over the
      // slice budget its own frame so it can keep its required resolution.
      const slice = this.#backend?.uploadRows ? UPLOAD_FRAME_BYTES : UPLOAD_SLICE_BYTES;
      if (this.#uploadedThisFrame === 0 || this.#uploadedThisFrame + need <= slice) {
        this.#uploadedThisFrame += need;
        return;
      }
      await this.#uploadFrame;
    }
  }

  #trimSources(): void {
    const entries: Array<{ source: Source; tier: ImageTier; size: number }> = [];
    let held = 0;
    for (const source of this.#sources.values()) {
      for (const [tier, blob] of source.blobs) {
        entries.push({ source, tier, size: blob.size });
        held += blob.size;
      }
    }
    if (held <= SOURCE_BUDGET) return;
    // Evict least recently used sources first, dropping larger full/1024 blobs before small previews.
    entries.sort((a, b) => a.source.used - b.source.used || tierRank(b.tier) - tierRank(a.tier));
    for (const entry of entries) {
      if (held <= SOURCE_BUDGET) break;
      entry.source.blobs.delete(entry.tier);
      held -= entry.size;
    }
  }

  #markPreviewBroken(ref: string): void {
    this.#previewBroken.add(ref);
    const source = this.#sources.get(ref);
    if (source) {
      source.fullOnly = true;
      for (const tier of [...source.blobs.keys()]) {
        if (tier !== "full") source.blobs.delete(tier);
      }
    }
    for (const key of [...this.#retryAt.keys()]) {
      if (key === metaKey(ref) || (key.startsWith(`fetch:${ref}/`) && !key.endsWith("/full"))) {
        this.#retryAt.delete(key);
      }
    }
    this.changed();
  }

  #scheduleDecode(target: Target): void {
    const backend = this.#backend;
    const dKey = jobKey(target);
    const lKey = levelKey(target);
    const existing = this.#residents.get(lKey);
    const staged = this.#staged.get(lKey);
    if (
      !backend ||
      (existing && tierCovers(existing.tier, target.tier)) ||
      (staged && tierCovers(staged.target.tier, target.tier)) ||
      this.#decodeJobs.has(dKey) ||
      this.#denied.has(lKey) ||
      this.#failed.get(target.ref) === this.cache.encodedVersion(target.ref)
    )
      return;
    const source = this.#sources.get(target.ref);
    if (!source) return;
    const cached = cachedBlobFor(source, target.tier);
    if (!cached) return;
    const stagedLimit = this.memory?.stagedImageBytes ?? STAGED_UPLOAD_BYTES;
    if (this.#shouldStageUpload(target) && this.#stagedBytes + bytes(target) > stagedLimit) return;
    const decodeLimit = this.memory?.decodeBytes ?? DECODE_BYTES;
    if (this.#inflightBytes > 0 && this.#inflightBytes + bytes(target) > decodeLimit) return;
    // A finer bitmap already resident (still wanted in the plan, or for any background target)
    // can serve this level as well without evicting itself.
    if (target.width !== this.#fallbacks.get(target.ref)?.width) {
      for (const resident of this.#residents.values()) {
        if (
          resident.handle === target.handle &&
          satisfies(resident, target) &&
          (target.priority > 0 || this.#targets.has(jobKey(resident)))
        )
          return;
      }
    }
    for (const { target: pending, abort } of this.#decodeJobs.values()) {
      if (
        pending.ref === target.ref &&
        !abort.signal.aborted &&
        satisfies(pending, target) &&
        (pending.forecast ||
          (target.priority > 0 && target.width !== this.#fallbacks.get(target.ref)?.width))
      )
        return;
    }
    if (this.#room(target, this.#missingFallback(target))) {
      this.#requestDecode(dKey, target, cached.blob, cached.tier, backend);
    }
  }

  #applyNaturalSize(ref: string, source: Source, size: Size): void {
    source.info = { width: size.width, height: size.height, handle: source.info.handle };
    delete source.pyramid;
    delete source.pyramidMaxSide;
    for (const [rKey, resident] of this.#residents) {
      if (resident.handle === source.info.handle) this.#drop(rKey);
    }
    for (const job of this.#decodeJobs.values()) {
      if (job.ref === ref) job.abort.abort();
    }
    for (const [sKey, entry] of this.#staged) {
      if (entry.target.ref === ref) {
        entry.bitmap.close();
        this.#stagedBytes -= entry.bytes;
        this.#staged.delete(sKey);
      }
    }
    const prefix = `${source.info.handle}/`;
    for (const deniedKey of [...this.#denied]) {
      if (deniedKey.startsWith(prefix)) this.#denied.delete(deniedKey);
    }
    for (const [tKey, t] of this.#targets) {
      if (t.ref === ref) this.#targets.delete(tKey);
    }
    this.#primary.delete(ref);
    this.#fallbacks.delete(ref);
  }

  #scheduleTierFetch(target: Target, lane: FetchLane): boolean {
    if (target.standIn) return false;
    const source = this.#sources.get(target.ref);
    if (!source) return false;
    const tier = this.#fetchTierForTarget(target);
    if (cachedBlobFor(source, tier)) return false;
    if (this.#hasSatisfyingResident(target)) return false;
    if (this.#failed.get(target.ref) === this.cache.encodedVersion(target.ref)) return false;
    if (this.#denied.has(levelKey(target))) return false;
    if (!this.#room(target, this.#missingFallback(target))) return false;
    const key = fetchKey(target.ref, tier);
    if (this.#fetchJobs.has(key) || (this.#retryAt.get(key)?.at ?? 0) > Date.now()) return false;
    const abort = new AbortController();
    this.#fetchJobs.set(key, { ref: target.ref, abort, tier, lane });
    void (async () => {
      const version = this.cache.encodedVersion(target.ref);
      try {
        const timeoutMs = tier === "full" ? FULL_FETCH_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
        const opts = tier === "full" ? undefined : { preview: tier };
        const res = await untilAborted(this.cache.encoded(target.ref, signal, opts), signal);
        if (abort.signal.aborted) return;
        let sizeChanged = false;
        const current = this.#sources.get(target.ref);
        if (current && current.version === version) {
          const receivedTier: ImageTier = res.preview ?? "full";
          if (!res.preview) {
            current.fullOnly = true;
            if (!current.naturalVerified) {
              const actual = await originalNaturalSize(res.blob, signal, res.size);
              if (abort.signal.aborted) return;
              if (this.#sources.get(target.ref) !== current || current.version !== version) return;
              if (actual) {
                current.naturalVerified = true;
                if (actual.width !== current.info.width || actual.height !== current.info.height) {
                  this.#applyNaturalSize(target.ref, current, actual);
                  sizeChanged = true;
                }
              }
            }
          }
          storeBlob(current, receivedTier, res.blob);
          this.#trimSources();
        }
        if (res.previewMissing) this.onPreviewMissing?.(target.ref, res.blob);
        this.#retryAt.delete(key);
        if (sizeChanged) {
          this.metadataReady(target.ref);
        } else if (
          res.preview !== undefined ||
          !this.#room(target, this.#missingFallback(target))
        ) {
          // Full blobs decode immediately from `this.#pump()` in `finally` and trigger `changed()`
          // once uploaded to the backend; avoid forcing a redundant redraw before pixels change.
          this.changed();
        }
      } catch {
        if (!abort.signal.aborted) {
          const attempts = (this.#retryAt.get(key)?.attempts ?? 0) + 1;
          const delay = attempts < 8 ? Math.min(60_000, 2000 * 2 ** (attempts - 1)) : Infinity;
          this.#retryAt.set(key, { at: Date.now() + delay, attempts, version });
          this.changed();
        }
      } finally {
        this.#fetchJobs.delete(key);
        this.#pump();
      }
    })();
    return true;
  }

  #allVisibleHaveResident(): boolean {
    const now = Date.now();
    for (const [ref, demand] of this.#metadata) {
      if (!demand.visible) continue;
      const key = metaKey(ref);
      if (this.#fetchJobs.has(key) || (this.#retryAt.get(key)?.at ?? 0) <= now) return false;
    }
    for (const job of this.#fetchJobs.values()) {
      if (job.lane === "urgent" || job.lane === "preview") return false;
    }
    // Wait until every visible image that can display a preview or original has at least one
    // resident texture uploaded to the GPU so first-useful happens before background refinement.
    for (const [ref, primary] of this.#primary) {
      if (this.#hasAnyResident(ref)) continue;
      if (this.#failed.get(ref) === this.cache.encodedVersion(ref)) continue;
      if (this.#denied.has(levelKey(primary))) continue;
      const fKey = fetchKey(ref, this.#fetchTierForTarget(primary));
      if ((this.#retryAt.get(fKey)?.at ?? 0) > now) continue;
      if (this.#room(primary, this.#missingFallback(primary)) === null) continue;
      return false;
    }
    return true;
  }

  /**
   * True when deferring Lane C refinement until after the preview frame presents would stall
   * `exact` behind a redundant tile re-bake for just a handful of tiny (`<= 256` px) assets on
   * a view that is already fetching `"full"` originals for most visible images.
   */
  #canRefineDuringDefer(): boolean {
    if (this.#opening || this.#zooming) return false;
    let urgentFull = 0;
    let smallRefines = 0;
    for (const target of this.#primary.values()) {
      if (target.previewTier === "full") {
        urgentFull++;
        continue;
      }
      const source = this.#sources.get(target.ref);
      if (!source || this.#hasSatisfyingResident(target)) continue;
      if (Math.max(source.info.width, source.info.height) > MEDIA_PREVIEW_SIZES[0]) {
        return false;
      }
      smallRefines++;
    }
    return smallRefines > 0 && urgentFull >= smallRefines;
  }

  /**
   * True when uploading a `"full"` replacement right now would invalidate tiles mid-initial-paint
   * for an image that already has a visible preview resident. Network download and worker decode
   * still overlap immediately; only the GPU replacement upload stages for one batched flush.
   */
  #shouldStageUpload(target: Target): boolean {
    return (
      this.#deferRefine &&
      !this.#opening &&
      !target.standIn &&
      target.priority === 0 &&
      target.tier === "full" &&
      target.previewTier !== "full" &&
      !this.#canRefineDuringDefer() &&
      this.#hasAnyResident(target.ref)
    );
  }

  #pump(): void {
    if (!this.#backend) return;
    this.#refreshProtection();
    const ordered = [...this.#targets.values()].sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.standIn ? 0 : 1) - (b.standIn ? 0 : 1) ||
        compareImportance(a, b),
    );

    // 1. Decode cached blobs first: stand-ins land on screen immediately, then sharp primaries.
    if (this.#decodeJobs.size < MAX_DECODES) {
      for (const target of ordered) {
        if (target.priority === 0) this.#scheduleDecode(target);
        if (this.#decodeJobs.size >= MAX_DECODES) break;
      }
      for (const target of ordered) {
        if (this.#decodeJobs.size >= MAX_DECODES - 1) break;
        if (target.forecast) this.#scheduleDecode(target);
      }
      for (const target of ordered) {
        if (this.#decodeJobs.size >= MAX_DECODES - 1) break;
        if (target.priority > 0 && !target.forecast) this.#scheduleDecode(target);
      }
    }

    // 2. Network fetches across decoupled lanes:
    //    - Lane A (urgent): visible direct-full (`demanded > 1024`, `natural <= demanded`, or
    //      `target >= natural`) and visible upgrades missing their preview tier. Guaranteed
    //      `URGENT_FETCH_SLOTS` slots, expanding to `MAX_FETCHES` when idle.
    //    - Lane B (preview): visible `?w=256` / `?w=1024` initial previews, strictly prioritized
    //      in `PREVIEW_FETCH_SLOTS` dedicated slots (bursting to `MAX_FETCHES` before originals
    //      are ready to refine), ordered by visual importance (largest span, nearest centre).
    //    - Lane C (refine): visible `"full"` originals start immediately alongside previews in
    //      shared bandwidth (`REFINE_CONCURRENT_SLOTS` while previews are pending, expanding to
    //      `MAX_FETCHES` once previews are issued), ordered largest span first, nearest centre.
    //    - Background: zoom forecasts and off-screen ring `?w=256` warmers.
    if (this.#fetchJobs.size < MAX_FETCHES) {
      const now = Date.now();
      const visibleMeta = [...this.#metadata.entries()]
        .filter(([, demand]) => demand.visible)
        .sort((a, b) => compareImportance(a[1], b[1]));

      const urgentMeta: Array<[string, MetaDemand]> = [];
      const previewMeta: Array<[string, MetaDemand]> = [];
      for (const entry of visibleMeta) {
        if (this.#initialTierOf(entry[0], entry[1]) === "full") urgentMeta.push(entry);
        else previewMeta.push(entry);
      }
      const urgentTargets = ordered.filter((t) => this.#isUrgentTarget(t));

      const countLane = (lane: FetchLane) => {
        let n = 0;
        for (const job of this.#fetchJobs.values()) if (job.lane === lane) n++;
        return n;
      };

      const fillUrgent = (cap: number) => {
        for (const [ref, demand] of urgentMeta) {
          if (this.#fetchJobs.size >= MAX_FETCHES || countLane("urgent") >= cap) return;
          this.#requestMetadata(ref, demand, "urgent");
        }
        for (const target of urgentTargets) {
          if (this.#fetchJobs.size >= MAX_FETCHES || countLane("urgent") >= cap) return;
          this.#scheduleTierFetch(target, "urgent");
        }
      };

      const fillPreview = (cap: number) => {
        for (const [ref, demand] of previewMeta) {
          if (this.#fetchJobs.size >= MAX_FETCHES || countLane("preview") >= cap) return;
          this.#requestMetadata(ref, demand, "preview");
        }
      };

      // Step 2a: Reserve dedicated slots for urgent direct-full & upgrade fetches first.
      fillUrgent(URGENT_FETCH_SLOTS);

      // Step 2b: Strictly prioritize visible previews in their own dedicated slots.
      fillPreview(PREVIEW_FETCH_SLOTS);

      // Step 2c: Let urgent fetches expand into remaining slots when previews aren't using them.
      if (this.#fetchJobs.size < MAX_FETCHES) fillUrgent(MAX_FETCHES);

      // Step 2d: Start visible `"full"` original fetches immediately after visible previews are
      // issued, sharing bandwidth in visual-importance order while keeping preview slots protected.
      if (this.#fetchJobs.size < MAX_FETCHES && !this.#zooming) {
        let unissuedPreviews = 0;
        for (const [ref] of previewMeta) {
          const key = metaKey(ref);
          if (!this.#fetchJobs.has(key) && (this.#retryAt.get(key)?.at ?? 0) <= now) {
            unissuedPreviews++;
          }
        }
        const activePreviews = countLane("preview");
        const refineCap =
          unissuedPreviews > 0 || activePreviews > 0
            ? Math.max(
                REFINE_CONCURRENT_SLOTS,
                MAX_FETCHES - Math.min(PREVIEW_FETCH_SLOTS, unissuedPreviews + activePreviews),
              )
            : MAX_FETCHES;
        for (const target of ordered) {
          if (this.#fetchJobs.size >= MAX_FETCHES || countLane("refine") >= refineCap) break;
          if (target.priority === 0 && !target.standIn && !this.#isUrgentTarget(target)) {
            this.#scheduleTierFetch(target, "refine");
          }
        }
      }

      // Step 2e: Only let previews burst past PREVIEW_FETCH_SLOTS before any visible image has
      // landed its preview and is ready to start `"full"` refinement in the shared refine slots.
      if (this.#fetchJobs.size < MAX_FETCHES) {
        let hasRefineSource = false;
        if (!this.#zooming) {
          for (const ref of this.#visible) {
            const source = this.#sources.get(ref);
            if (source && !cachedBlobFor(source, "full")) {
              hasRefineSource = true;
              break;
            }
          }
        }
        if (!hasRefineSource) fillPreview(MAX_FETCHES);
      }

      // Step 2f: Forecasts and off-screen ring (`?w=256` only).
      for (const target of ordered) {
        if (this.#fetchJobs.size >= MAX_FETCHES - 1) break;
        if (target.forecast) this.#scheduleTierFetch(target, "background");
      }
      for (const [ref, demand] of this.#metadata) {
        if (this.#fetchJobs.size >= MAX_FETCHES - 1) break;
        if (!demand.visible) this.#requestMetadata(ref, demand, "background");
      }
      for (const target of ordered) {
        if (this.#fetchJobs.size >= MAX_FETCHES - 1) break;
        if (target.priority > 0 && !target.forecast) this.#scheduleTierFetch(target, "background");
      }
    }

    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    let next = Infinity;
    for (const ref of this.#metadata.keys()) {
      const key = metaKey(ref);
      const retry = this.#retryAt.get(key);
      if (retry && !this.#fetchJobs.has(key)) next = Math.min(next, retry.at);
    }
    for (const target of this.#targets.values()) {
      if (target.standIn) continue;
      const key = fetchKey(target.ref, this.#fetchTierForTarget(target));
      const retry = this.#retryAt.get(key);
      if (retry && !this.#fetchJobs.has(key)) next = Math.min(next, retry.at);
    }
    if (Number.isFinite(next))
      this.#retryTimer = setTimeout(() => this.#pump(), Math.max(0, next - Date.now()));
  }

  #requestMetadata(ref: string, demand: MetaDemand, lane: FetchLane): void {
    const key = metaKey(ref);
    if (
      this.#sources.has(ref) ||
      this.#fetchJobs.has(key) ||
      (this.#retryAt.get(key)?.at ?? 0) > Date.now()
    )
      return;
    const requestedTier = this.#initialTierOf(ref, demand);
    const abort = new AbortController();
    this.#fetchJobs.set(key, { ref, abort, tier: requestedTier, lane });
    void (async () => {
      const version = this.cache.encodedVersion(ref);
      try {
        const timeoutMs = requestedTier === "full" ? FULL_FETCH_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
        const opts = requestedTier === "full" ? undefined : { preview: requestedTier };
        const { blob, size, preview, previewMissing } = await untilAborted(
          this.cache.encoded(ref, signal, opts),
          signal,
        );
        let dimensions: Size;
        try {
          dimensions = size ?? (await naturalSize(blob, signal));
        } catch {
          if (!abort.signal.aborted) {
            if (preview !== undefined) {
              // Corrupt preview bytes: bypass previews and fall back to the full original.
              this.#markPreviewBroken(ref);
            } else {
              this.#failed.set(ref, version);
              this.changed();
            }
          }
          return;
        }
        if (abort.signal.aborted) return;
        const blobs = new Map<ImageTier, Blob>();
        const receivedTier: ImageTier = preview ?? "full";
        blobs.set(receivedTier, blob);
        const fullOnly = !preview && (requestedTier !== "full" || previewMissing === true);
        this.#sources.set(ref, {
          info: { ...dimensions, handle: this.#nextHandle++ },
          version,
          blobs,
          fullOnly,
          naturalVerified: preview === undefined,
          used: this.#clock,
        });
        this.#trimSources();
        if (previewMissing) this.onPreviewMissing?.(ref, blob);
        this.#retryAt.delete(key);
        this.metadataReady(ref);
      } catch {
        if (!abort.signal.aborted) {
          const attempts = (this.#retryAt.get(key)?.attempts ?? 0) + 1;
          const delay = attempts < 8 ? Math.min(60_000, 2000 * 2 ** (attempts - 1)) : Infinity;
          this.#retryAt.set(key, { at: Date.now() + delay, attempts, version });
          this.changed();
        }
      } finally {
        this.#fetchJobs.delete(key);
        this.#pump();
      }
    })();
  }

  #flushStaged(): void {
    const backend = this.#backend;
    if (!backend || this.#staged.size === 0 || this.#flushingStaged) return;
    const batch = [...this.#staged.values()];
    this.#flushingBytes = this.#stagedBytes;
    this.#staged.clear();
    this.#stagedBytes = 0;
    this.#flushingStaged = true;
    const first = batch.reduce((best, entry) => Math.min(best, entry.target.priority), Infinity);
    const upload = this.#queueCommit("staged", first, async () => {
      let didChange = false;
      const signal = new AbortController().signal;
      try {
        for (const entry of batch) {
          try {
            if (backend !== this.#backend || !this.#visible.has(entry.target.ref)) continue;
            const uploaded = await this.#commit(entry.target, entry.bitmap, backend, signal, false);
            if (uploaded) didChange = true;
          } finally {
            entry.bitmap.close();
            this.#flushingBytes -= entry.bytes;
          }
        }
      } finally {
        if (this.#flushingBytes > 0) {
          for (const entry of batch) entry.bitmap.close();
          this.#flushingBytes = 0;
        }
        this.#flushingStaged = false;
        if (didChange && backend === this.#backend) this.changed();
        if (!this.#deferRefine && this.#staged.size > 0) this.#flushStaged();
        this.#pump();
      }
    });
    void upload.catch(() => {});
  }

  async #uploadLevel(
    target: Target,
    bitmap: ImageBitmap,
    backend: ImageBackend,
    signal: AbortSignal,
    notify = true,
  ): Promise<boolean> {
    const lKey = levelKey(target);
    const current = this.#residents.get(lKey);
    // Never overwrite a same-width resident that already has an equal or finer tier.
    if (current && tierCovers(current.tier, target.tier)) return false;
    let uploaded = await this.#upload(target, bitmap, backend, signal);
    if (!uploaded && !signal.aborted && backend === this.#backend) {
      const reclaimed = this.releasePressure();
      if (reclaimed && backend.retryUpload) {
        await this.#paceUpload(this.#firstUpload(target), signal);
        if (!signal.aborted) uploaded = await this.#upload(target, bitmap, backend, signal);
      }
    }
    if (signal.aborted || backend !== this.#backend) {
      // A level that landed took the place of the resident one of its width (the backend let
      // that one go): it stays resident there. Otherwise it's let go.
      const replaced =
        uploaded && backend === this.#backend && !this.#hidden
          ? this.#residents.get(lKey)
          : undefined;
      if (!replaced) {
        if (uploaded) backend.drop(target.handle, target.width);
        return false;
      }
    }
    if (uploaded) {
      const replaced = this.#residents.get(lKey);
      if (replaced) this.#residentBytes -= bytes(replaced);
      this.#residents.set(lKey, { ...target, used: this.#clock });
      this.#residentBytes += bytes(target);
      this.#recordMemory();
    } else {
      this.#denied.add(lKey);
    }
    if (notify) this.changed();
    return true;
  }

  /**
   * Uploads a level whole, or in row strips paced over frames (the caller paced the first). A
   * level left part done (dropped, or a strip refused) is let go; the resident one of its width
   * stays.
   */
  async #upload(
    target: Target,
    bitmap: ImageBitmap,
    backend: ImageBackend,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!backend.uploadRows) return backend.upload(target.handle, bitmap);
    const { width, height } = bitmap;
    const strip = Math.max(1, Math.floor(UPLOAD_STRIP_BYTES / (width * 4)));
    for (let y = 0; y < height; y += strip) {
      const rows = Math.min(strip, height - y);
      if (y > 0) {
        try {
          await this.#paceUpload(rows * width * 4, signal);
        } catch {
          // Dropped: nothing more of it comes.
        }
      }
      if (
        signal.aborted ||
        backend !== this.#backend ||
        !backend.uploadRows(target.handle, bitmap, y, rows)
      ) {
        if (y > 0) {
          if (backend.cancelRows) backend.cancelRows(target.handle, width);
          else backend.drop(target.handle, width);
        }
        return false;
      }
    }
    return true;
  }

  /** What a level's upload takes from its first frame: all of it, or its first strip. */
  #firstUpload(target: Target): number {
    if (!this.#backend?.uploadRows) return bytes(target);
    const strip = Math.max(1, Math.floor(UPLOAD_STRIP_BYTES / (target.width * 4)));
    return Math.min(target.height, strip) * target.width * 4;
  }

  /**
   * Runs a decoded level's commit when its turn comes: one at a time (each makes room against
   * what's resident), the most wanted first (what the view shows), in order of arrival among
   * equals. A level arriving mid-upload waits for that one's last strips.
   */
  #queueCommit(key: string, priority: number, run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#commits.push({ key, priority, seq: ++this.#commitSeq, run, resolve, reject });
      void this.#nextCommits();
    });
  }

  async #nextCommits(): Promise<void> {
    if (this.#committing) return;
    this.#committing = true;
    try {
      const want = (c: { key: string; priority: number }) =>
        this.#targets.get(c.key)?.priority ?? c.priority;
      for (;;) {
        this.#commits.sort((a, b) => want(a) - want(b) || a.seq - b.seq);
        const next = this.#commits.shift();
        if (!next) break;
        try {
          await next.run();
          next.resolve();
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.#committing = false;
    }
  }

  async #commit(
    target: Target,
    bitmap: ImageBitmap,
    backend: ImageBackend,
    signal: AbortSignal,
    notify = true,
  ): Promise<boolean> {
    if (signal.aborted) return false;
    let didChange = false;
    const fallback = this.#missingFallback(target);
    if (fallback) {
      // Reuse the decoded pixels. Restoring a tab needs no second full decode.
      let thumbnail: ImageBitmap | undefined;
      this.#thumbnailBytes += bytes(fallback);
      this.#recordMemory();
      try {
        thumbnail = await untilAborted(createImageBitmap(bitmap, resize(fallback)), signal, (b) =>
          b.close(),
        );
        await this.#paceUpload(this.#firstUpload(fallback), signal);
        this.#refreshProtection();
        const room = this.#room(target, fallback);
        if (!room || signal.aborted) return didChange;
        for (const level of room) {
          if (this.#residentBytes + bytes(fallback) <= this.#budget) break;
          this.#drop(levelKey(level));
        }
        if (await this.#uploadLevel(fallback, thumbnail, backend, signal, notify)) didChange = true;
      } catch {
        // The optional copy must not mark otherwise usable source bytes corrupt.
        if (!signal.aborted) this.#denied.add(levelKey(fallback));
      } finally {
        thumbnail?.close();
        this.#thumbnailBytes -= bytes(fallback);
      }
    }
    await this.#paceUpload(this.#firstUpload(target), signal);
    if (signal.aborted) return didChange;
    this.#refreshProtection();
    const room = this.#room(target);
    if (!room) return didChange;
    for (const level of room) this.#drop(levelKey(level));
    if (await this.#uploadLevel(target, bitmap, backend, signal, notify)) didChange = true;
    return didChange;
  }

  #requestDecode(
    key: string,
    target: Target,
    input: Blob,
    inputTier: ImageTier,
    backend: ImageBackend,
  ): void {
    const abort = new AbortController();
    this.#decodeJobs.set(key, { ref: target.ref, abort, target });
    const need = bytes(target);
    this.#inflightBytes += need;
    this.#recordMemory();
    let staged = false;
    void (async () => {
      let bitmap: ImageBitmap | undefined;
      const version = this.cache.encodedVersion(target.ref);
      try {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        // Bitmap decodes cannot be interrupted. Keep the slot until the native
        // work returns instead of starting a new decode on every camera tick.
        bitmap = await untilAborted(this.decode(input, resize(target)), timeout, (b) => b.close());
        const decoded = bitmap;
        const upload = this.#queueCommit(jobKey(target), target.priority, async () => {
          if (
            !abort.signal.aborted &&
            backend === this.#backend &&
            this.#shouldStageUpload(target) &&
            this.#stagedBytes + need <= (this.memory?.stagedImageBytes ?? STAGED_UPLOAD_BYTES)
          ) {
            const lKey = levelKey(target);
            const prev = this.#staged.get(lKey);
            if (prev) {
              prev.bitmap.close();
              this.#stagedBytes -= prev.bytes;
            }
            this.#staged.set(lKey, { target, bitmap: decoded, bytes: need });
            this.#stagedBytes += need;
            if (this.memory) {
              this.#inflightBytes -= need;
              staged = true;
            }
            bitmap = undefined;
            if (this.allVisibleFullReady) this.onAllVisibleFullReady?.();
            return;
          }
          await this.#commit(target, decoded, backend, abort.signal);
        });
        await upload;
      } catch {
        if (!abort.signal.aborted) {
          if (inputTier !== "full") {
            // Corrupt preview bytes: drop the preview and fall back to the full original.
            this.#markPreviewBroken(target.ref);
          } else {
            this.#failed.set(target.ref, version);
            this.changed();
          }
        }
      } finally {
        bitmap?.close();
        if (!staged) this.#inflightBytes -= need;
        this.#decodeJobs.delete(key);
        this.#pump();
      }
    })();
  }
}
