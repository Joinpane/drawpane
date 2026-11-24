import type { ImageCache, ImageDemand, Size } from "@drawpane/editor";
import type { RenderEngine } from "@drawpane/engine";
import {
  MEDIA_PREVIEW_SIZES,
  type MediaPreviewSize,
  mediaPreviewDimensions,
  sniffImage,
} from "@drawpane/model";
import type { DecodeReply, DecodeRequest } from "./image-decode.worker";

const MIB = 1024 * 1024;
const MAX_DECODES = 4;
const MAX_FETCHES = 6;
const PREFETCH_RATIOS = [2, 4];
const DECODE_BYTES = 64 * MIB;
const ZOOM_SAMPLE_MS = 100;
const ZOOM_LOOKAHEAD_MS = 180;
const MAX_ZOOM_LOOKAHEAD = 8;
const UPLOAD_SLICE_BYTES = 12 * MIB;
const REQUEST_TIMEOUT_MS = 8000;
const SOURCE_BUDGET = 64 * MIB;
const MAX_BITMAP_SIDE = 4096;
export const CPU_IMAGE_BUDGET = 64 * MIB;
export const CPU_IMAGE_SIDE = MAX_BITMAP_SIDE;

export type ImageTier = MediaPreviewSize | "full";

function tierRank(tier: ImageTier): number {
  return tier === "full" ? Number.POSITIVE_INFINITY : tier;
}

/** True when a decoded/cached `have` tier satisfies a demand for `need`. */
export function tierCovers(have: ImageTier, need: ImageTier): boolean {
  return tierRank(have) >= tierRank(need);
}

/**
 * Smallest server tier that supplies enough pixels for `target` on an image of `natural` size.
 * Once the view actually demands full natural dimensions (or exceeds the largest preview tier),
 * use `"full"` so lossless graphics and 1:1+ views do not stay on a lossy preview. When a smaller
 * image (e.g. a 256x256 icon drawn at 136x136) rounds its mip target up to natural size while
 * still viewed downscaled, stay on the preview tier that covers it.
 */
export function tierForTarget(natural: Size, target: Size, demanded?: number): ImageTier {
  const naturalLong = Math.max(natural.width, natural.height);
  const targetLong = Math.max(target.width, target.height);
  if (
    target.width >= natural.width &&
    target.height >= natural.height &&
    (demanded === undefined || demanded >= naturalLong)
  ) {
    return "full";
  }
  for (const size of MEDIA_PREVIEW_SIZES) {
    if (targetLong <= size) return size;
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
  readonly info: ImageInfo;
  version: number;
  readonly blobs: Map<ImageTier, Blob>;
  /** True when the server returned the full original on a preview request (no previews exist). */
  fullOnly: boolean;
  used: number;
  pyramidMaxSide?: number;
  pyramid?: { zoom: Size[]; rest: Size[] };
}

interface Target extends Size {
  readonly ref: string;
  readonly handle: number;
  readonly priority: number;
  readonly tier: ImageTier;
  readonly forecast?: boolean;
  readonly standIn?: boolean;
}

interface Resident extends Target {
  used: number;
}

interface ImageBackend {
  readonly retryUpload?: boolean;
  upload(handle: number, bitmap: ImageBitmap): boolean | Promise<boolean>;
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
    { ref: string; abort: AbortController; tier?: ImageTier }
  >();
  readonly #retryAt = new Map<string, { at: number; attempts: number; version: number }>();
  readonly #denied = new Set<string>();
  readonly #failed = new Map<string, number>();
  readonly #protected = new Set<string>();
  #fallbacks = new Map<string, Target>();
  #primary = new Map<string, Target>();
  #visible = new Set<string>();
  #targets = new Map<string, Target>();
  #metadata = new Map<string, boolean>();
  #backend: ImageBackend | null = null;
  #budget = 0;
  #hidden = false;
  #reduced = 0;
  #uploadedThisFrame = 0;
  #uploadFrame: Promise<void> | undefined;
  #inflightBytes = 0;
  #uploadTail = Promise.resolve();
  #residentBytes = 0;
  #clock = 0;
  #nextHandle = 1;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #zoomSample: { scale: number; at: number } | undefined;
  #forecastScale = 0;

  constructor(
    private readonly cache: Pick<ImageCache, "encoded" | "encodedVersion">,
    private readonly metadataReady: (ref: string) => void,
    private readonly changed: () => void,
    private readonly decode: Decode = decodeInWorker,
  ) {}

  info(ref: string): ImageInfo | null {
    return this.#sources.get(ref)?.info ?? null;
  }

  get residentBytes(): number {
    return this.#residentBytes;
  }

  get budget(): number {
    return this.#budget;
  }

  get reduced(): number {
    return this.#reduced;
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
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  retain(used: ReadonlySet<string>): void {
    for (const { ref, abort } of this.#decodeJobs.values()) if (!used.has(ref)) abort.abort();
    for (const { ref, abort } of this.#fetchJobs.values()) if (!used.has(ref)) abort.abort();
    for (const ref of this.#sources.keys()) if (!used.has(ref)) this.#sources.delete(ref);
    for (const ref of this.#metadata.keys()) if (!used.has(ref)) this.#metadata.delete(ref);
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

  #tierOf(source: Source, size: Size, demanded?: number): ImageTier {
    return source.fullOnly ? "full" : tierForTarget(source.info, size, demanded);
  }

  update(
    demands: Iterable<ImageDemand>,
    scale: number,
    limits: { side: number; bytes: number },
    now = performance.now(),
  ): boolean {
    if (!this.#backend) return true;
    this.#hidden = false;
    const budget = deviceImageBudget(limits.bytes);
    if (budget !== this.#budget) this.#denied.clear();
    const maxSide = Math.min(MAX_BITMAP_SIDE, limits.side);
    const candidates = new Map<string, Target>();
    const metadata = new Map<string, boolean>();
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

    for (const { ref, visible: onScreen, span } of demands) {
      if (onScreen) visible.add(ref);
      const source = this.#sources.get(ref);
      const version = this.cache.encodedVersion(ref);
      this.#clearRetries(ref, version);
      if (source && source.version !== version) {
        source.version = version;
        source.blobs.clear();
        source.fullOnly = false;
      }
      if (this.#failed.get(ref) === version) {
        if (onScreen) reduced.add(ref);
        continue;
      }
      if (!source) {
        metadata.set(ref, onScreen || Boolean(metadata.get(ref)));
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
      let tier = this.#tierOf(source, size, demanded);
      if (!onScreen && !cachedBlobFor(source, tier)) {
        // Off-screen neighbouring ring only warms the small preview tier over the network so
        // off-screen boards do not download full-resolution originals before entering view.
        const maxOffscreen = MEDIA_PREVIEW_SIZES[0];
        const capped =
          pyramid.zoom.find((l) => Math.max(l.width, l.height) <= maxOffscreen) ??
          pyramid.zoom.at(-1);
        if (capped && capped.width < size.width) {
          size = capped;
        }
        tier = source.fullOnly ? "full" : maxOffscreen;
      }
      const wanted: Target = { ...size, ref, handle, priority: onScreen ? 0 : 3, tier };
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
        ? this.#tierOf(source, availableSize, demanded)
        : undefined;
      if (onScreen && availableSize && availableTier) {
        // A prefetched level can satisfy the current view (both pixels and tier). Charge its real
        // size to the plan so it still gives way under budget pressure.
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
          tier: onScreen ? availableTier : tier,
        };
        const key = jobKey(target);
        const previous = candidates.get(key);
        if (!previous || target.priority < previous.priority) candidates.set(key, target);
      }
      if (onScreen) {
        const coarse = pyramid.zoom.at(-1);
        if (coarse) {
          fallbacks.set(ref, {
            ...coarse,
            ref,
            handle,
            priority: 0,
            tier: this.#tierOf(source, coarse, 0),
          });
        }
        const projected = pyramid.zoom[levelFor(pyramid.zoom, span, forecastScale)];
        if (
          forecastScale > scale &&
          projected &&
          projected.width > (availableSize?.width ?? size.width)
        ) {
          const forecast: Target = {
            ...projected,
            ref,
            handle,
            priority: 1,
            tier: this.#tierOf(
              source,
              projected,
              Math.max(span.width, span.height) * forecastScale,
            ),
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
          const finerTier = this.#tierOf(
            source,
            finer,
            Math.max(span.width, span.height) * scale * ratio,
          );
          // Speculative zoom-ahead prefetch never triggers larger network fetches; it only
          // decodes finer mip levels from an encoded blob that is already cached locally.
          if (!cachedBlobFor(source, finerTier)) continue;
          const target: Target = {
            ...finer,
            ref,
            handle,
            priority: 4 + index,
            tier: finerTier,
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
          tier: this.#tierOf(source, smaller),
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
                tier: this.#tierOf(source, level),
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
          tier: this.#tierOf(source, affordable),
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

    // Progressive stand-in: when a visible primary target still needs a higher-tier network
    // fetch, immediately decode and upload the largest already-cached preview so the user sees
    // the image right away while the upgrade downloads.
    for (const [ref, primaryTarget] of primaryByRef) {
      if (this.#hasSatisfyingResident(primaryTarget)) continue;
      const source = this.#sources.get(ref);
      if (!source || cachedBlobFor(source, primaryTarget.tier)) continue;
      const preview = largestCachedBlob(source);
      if (!preview || preview.tier === "full") continue;
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
      if (source && !cachedBlobFor(source, target.tier)) {
        neededFetches.add(fetchKey(target.ref, target.tier));
      }
    }
    for (const [key, { abort }] of this.#decodeJobs) {
      if (!targets.has(key)) abort.abort();
    }
    for (const [key, { abort }] of this.#fetchJobs) {
      if (!neededFetches.has(key)) abort.abort();
    }
    this.#pump();

    // Honesty rule: any in-flight or queued improvement makes the frame provisional (`false`).
    // Any settled visible image whose resident level does not cover its ideal pixels AND tier
    // (because of GPU budget, decode failure, or failed higher-tier fetch) is counted in
    // `reduced` so `EngineView` never reports `exact: true` while showing a preview.
    const pending = new Set<string>();
    for (const [ref, onScreen] of metadata) {
      if (onScreen && !this.#retryAt.has(metaKey(ref))) pending.add(ref);
    }
    for (const target of targets.values()) {
      if (target.priority !== 0 || target.standIn) continue;
      if (this.#hasSatisfyingResident(target)) continue;
      const source = this.#sources.get(target.ref);
      const hasBlob = source ? Boolean(cachedBlobFor(source, target.tier)) : false;
      const fKey = fetchKey(target.ref, target.tier);
      const dKey = jobKey(target);
      const hasRoom = this.#room(target, this.#missingFallback(target)) !== null;
      if (
        this.#fetchJobs.has(fKey) ||
        this.#decodeJobs.has(dKey) ||
        (!hasBlob && !this.#retryAt.has(fKey) && hasRoom) ||
        (hasBlob && hasRoom)
      ) {
        pending.add(target.ref);
      }
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
    const delta = existing ? Math.max(0, bytes(target) - bytes(existing)) : bytes(target);
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
      if (this.#uploadedThisFrame === 0 || this.#uploadedThisFrame + need <= UPLOAD_SLICE_BYTES) {
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

  #scheduleDecode(target: Target): void {
    const backend = this.#backend;
    const dKey = jobKey(target);
    const lKey = levelKey(target);
    const existing = this.#residents.get(lKey);
    if (
      !backend ||
      (existing && tierCovers(existing.tier, target.tier)) ||
      this.#decodeJobs.has(dKey) ||
      this.#denied.has(lKey) ||
      this.#failed.get(target.ref) === this.cache.encodedVersion(target.ref)
    )
      return;
    const source = this.#sources.get(target.ref);
    if (!source) return;
    const cached = cachedBlobFor(source, target.tier);
    if (!cached) return;
    if (this.#inflightBytes > 0 && this.#inflightBytes + bytes(target) > DECODE_BYTES) return;
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
      this.#requestDecode(dKey, target, cached.blob, backend);
    }
  }

  #scheduleTierFetch(target: Target): void {
    if (target.standIn) return;
    const source = this.#sources.get(target.ref);
    if (!source || cachedBlobFor(source, target.tier)) return;
    if (this.#hasSatisfyingResident(target)) return;
    if (this.#failed.get(target.ref) === this.cache.encodedVersion(target.ref)) return;
    if (this.#denied.has(levelKey(target))) return;
    if (!this.#room(target, this.#missingFallback(target))) return;
    const key = fetchKey(target.ref, target.tier);
    if (this.#fetchJobs.has(key) || (this.#retryAt.get(key)?.at ?? 0) > Date.now()) return;
    const abort = new AbortController();
    this.#fetchJobs.set(key, { ref: target.ref, abort, tier: target.tier });
    void (async () => {
      const version = this.cache.encodedVersion(target.ref);
      try {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
        const opts = target.tier === "full" ? undefined : { preview: target.tier };
        const res = await untilAborted(this.cache.encoded(target.ref, signal, opts), signal);
        if (abort.signal.aborted) return;
        const current = this.#sources.get(target.ref);
        if (current && current.version === version) {
          const receivedTier: ImageTier = res.preview ?? "full";
          if (!res.preview) current.fullOnly = true;
          storeBlob(current, receivedTier, res.blob);
          this.#trimSources();
        }
        this.#retryAt.delete(key);
        this.changed();
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

  #pump(): void {
    if (!this.#backend) return;
    this.#refreshProtection();
    const ordered = [...this.#targets.values()].sort(
      (a, b) => a.priority - b.priority || (a.standIn ? 0 : 1) - (b.standIn ? 0 : 1),
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

    // 2. Network fetches: small previews for visible images first, then visible upgrades, then
    //    forecasts and off-screen ring previews.
    if (this.#fetchJobs.size < MAX_FETCHES) {
      for (const [ref, visible] of this.#metadata) {
        if (visible) this.#requestMetadata(ref);
        if (this.#fetchJobs.size >= MAX_FETCHES) break;
      }
      for (const target of ordered) {
        if (this.#fetchJobs.size >= MAX_FETCHES) break;
        if (target.priority === 0) this.#scheduleTierFetch(target);
      }
      for (const target of ordered) {
        if (this.#fetchJobs.size >= MAX_FETCHES - 1) break;
        if (target.forecast) this.#scheduleTierFetch(target);
      }
      for (const [ref, visible] of this.#metadata) {
        if (this.#fetchJobs.size >= MAX_FETCHES - 1) break;
        if (!visible) this.#requestMetadata(ref);
      }
      for (const target of ordered) {
        if (this.#fetchJobs.size >= MAX_FETCHES - 1) break;
        if (target.priority > 0 && !target.forecast) this.#scheduleTierFetch(target);
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
      const key = fetchKey(target.ref, target.tier);
      const retry = this.#retryAt.get(key);
      if (retry && !this.#fetchJobs.has(key)) next = Math.min(next, retry.at);
    }
    if (Number.isFinite(next))
      this.#retryTimer = setTimeout(() => this.#pump(), Math.max(0, next - Date.now()));
  }

  #requestMetadata(ref: string): void {
    const key = metaKey(ref);
    if (
      this.#sources.has(ref) ||
      this.#fetchJobs.has(key) ||
      (this.#retryAt.get(key)?.at ?? 0) > Date.now()
    )
      return;
    const abort = new AbortController();
    this.#fetchJobs.set(key, { ref, abort });
    void (async () => {
      const version = this.cache.encodedVersion(ref);
      try {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
        const { blob, size, preview } = await untilAborted(
          this.cache.encoded(ref, signal, { preview: MEDIA_PREVIEW_SIZES[0] }),
          signal,
        );
        let dimensions: Size;
        try {
          dimensions = size ?? (await naturalSize(blob, signal));
        } catch {
          if (!abort.signal.aborted) {
            this.#failed.set(ref, version);
            this.changed();
          }
          return;
        }
        if (abort.signal.aborted) return;
        const blobs = new Map<ImageTier, Blob>();
        const receivedTier: ImageTier = preview ?? "full";
        blobs.set(receivedTier, blob);
        this.#sources.set(ref, {
          info: { ...dimensions, handle: this.#nextHandle++ },
          version,
          blobs,
          fullOnly: !preview,
          used: this.#clock,
        });
        this.#trimSources();
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

  async #uploadLevel(
    target: Target,
    bitmap: ImageBitmap,
    backend: ImageBackend,
    signal: AbortSignal,
  ): Promise<void> {
    const lKey = levelKey(target);
    const current = this.#residents.get(lKey);
    // Never overwrite a same-width resident that already has an equal or finer tier.
    if (current && tierCovers(current.tier, target.tier)) return;
    let uploaded = await backend.upload(target.handle, bitmap);
    if (!uploaded && !signal.aborted && backend === this.#backend) {
      const reclaimed = this.releasePressure();
      if (reclaimed && backend.retryUpload) {
        await this.#paceUpload(bytes(target), signal);
        if (!signal.aborted) uploaded = await backend.upload(target.handle, bitmap);
      }
    }
    if (signal.aborted || backend !== this.#backend) {
      if (uploaded) backend.drop(target.handle, target.width);
      return;
    }
    if (uploaded) {
      const replaced = this.#residents.get(lKey);
      if (replaced) this.#residentBytes -= bytes(replaced);
      this.#residents.set(lKey, { ...target, used: this.#clock });
      this.#residentBytes += bytes(target);
    } else {
      this.#denied.add(lKey);
    }
    this.changed();
  }

  async #commit(
    target: Target,
    bitmap: ImageBitmap,
    backend: ImageBackend,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const fallback = this.#missingFallback(target);
    if (fallback) {
      // Reuse the decoded pixels. Restoring a tab needs no second full decode.
      let thumbnail: ImageBitmap | undefined;
      try {
        thumbnail = await untilAborted(createImageBitmap(bitmap, resize(fallback)), signal, (b) =>
          b.close(),
        );
        await this.#paceUpload(bytes(fallback), signal);
        this.#refreshProtection();
        const room = this.#room(target, fallback);
        if (!room || signal.aborted) return;
        for (const level of room) {
          if (this.#residentBytes + bytes(fallback) <= this.#budget) break;
          this.#drop(levelKey(level));
        }
        await this.#uploadLevel(fallback, thumbnail, backend, signal);
      } catch {
        // The optional copy must not mark otherwise usable source bytes corrupt.
        if (!signal.aborted) this.#denied.add(levelKey(fallback));
      } finally {
        thumbnail?.close();
      }
    }
    await this.#paceUpload(bytes(target), signal);
    if (signal.aborted) return;
    this.#refreshProtection();
    const room = this.#room(target);
    if (!room) return;
    for (const level of room) this.#drop(levelKey(level));
    await this.#uploadLevel(target, bitmap, backend, signal);
  }

  #requestDecode(key: string, target: Target, input: Blob, backend: ImageBackend): void {
    const abort = new AbortController();
    this.#decodeJobs.set(key, { ref: target.ref, abort, target });
    const need = bytes(target);
    this.#inflightBytes += need;
    void (async () => {
      let bitmap: ImageBitmap | undefined;
      const version = this.cache.encodedVersion(target.ref);
      try {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        // Bitmap decodes cannot be interrupted. Keep the slot until the native
        // work returns instead of starting a new decode on every camera tick.
        bitmap = await untilAborted(this.decode(input, resize(target)), timeout, (b) => b.close());
        const decoded = bitmap;
        const upload = this.#uploadTail.then(() =>
          this.#commit(target, decoded, backend, abort.signal),
        );
        this.#uploadTail = upload.catch(() => {});
        await upload;
      } catch {
        if (!abort.signal.aborted) {
          this.#failed.set(target.ref, version);
          this.changed();
        }
      } finally {
        bitmap?.close();
        this.#inflightBytes -= need;
        this.#decodeJobs.delete(key);
        this.#pump();
      }
    })();
  }
}
