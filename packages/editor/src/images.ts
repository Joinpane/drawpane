/**
 * Images for the renderer: a decoded-bitmap cache, and the math that places
 * an image inside a layer for each scale mode.
 *
 * Bitmaps decode with `createImageBitmap`, which runs off the main thread, so
 * a large photo never blocks a frame. The cache holds a memory budget and
 * evicts the least recently drawn images first. At low zoom it draws a
 * downscaled copy (made once, also off the main thread), which is both
 * sharper and cheaper than shrinking a full-size bitmap every frame.
 */
import {
  exifOrientationComplete,
  type MediaPreviewSize,
  mediaPreviewDimensions,
  parseMediaPreviewSize,
  sniffImage,
} from "@drawpane/model";
import type { Point, Rect } from "./geometry";

export type ScaleMode = "fill" | "fit" | "tile" | "stretch" | "crop";

/** The part of an image a cropped fill shows, in the image's unit square. */
export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface ImagePlacement extends Rect {
  /** Repeat the image from (x, y) in steps of (width, height). */
  readonly tile: boolean;
}

/**
 * Where an image of natural size `image` lands inside a `box` (both in layer
 * units, one image pixel per unit). The caller clips to the layer's shape.
 *
 * - fill: cover the box, keeping the aspect ratio, centred (overflow is clipped)
 * - fit: fit inside the box, keeping the aspect ratio, centred
 * - stretch: match the box exactly, distorting if needed
 * - tile: repeat at natural size from the top-left corner
 * - crop: the part of the image in `crop`, stretched to the box (the crop tool
 *   keeps its proportions)
 */
export function imagePlacement(
  mode: ScaleMode,
  box: Size,
  image: Size,
  crop: CropRect = FULL_CROP,
): ImagePlacement {
  const iw = Math.max(1e-9, image.width);
  const ih = Math.max(1e-9, image.height);
  if (mode === "crop") {
    // The crop fills the box; the rest of the image lies outside it, clipped.
    const width = box.width / Math.max(1e-9, crop.width);
    const height = box.height / Math.max(1e-9, crop.height);
    return { x: -crop.x * width, y: -crop.y * height, width, height, tile: false };
  }
  if (mode === "stretch") return { x: 0, y: 0, width: box.width, height: box.height, tile: false };
  if (mode === "tile") return { x: 0, y: 0, width: iw, height: ih, tile: true };
  const sx = box.width / iw;
  const sy = box.height / ih;
  const s = mode === "fill" ? Math.max(sx, sy) : Math.min(sx, sy);
  const width = iw * s;
  const height = ih * s;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height, tile: false };
}

/** The projected size of one image, including any part cropped out by the layer. */
export function imageDrawnSize(
  mode: ScaleMode,
  box: Size,
  natural: Size,
  scale: Size,
  crop?: CropRect,
): Size {
  const place = imagePlacement(mode, box, natural, crop);
  return { width: place.width * scale.width, height: place.height * scale.height };
}

/**
 * Lays out images dropped or pasted together: each at its natural size,
 * scaled down (never up) to fit `max`, side by side with `gap` between them,
 * the row centred on `center` with tops aligned. Positions are whole units.
 */
export function layoutImageRow(sizes: readonly Size[], center: Point, max: Size, gap = 24): Rect[] {
  const scaled = sizes.map((s) => {
    const k = Math.min(1, max.width / Math.max(1, s.width), max.height / Math.max(1, s.height));
    return {
      width: Math.max(1, Math.round(s.width * k * 100) / 100),
      height: Math.max(1, Math.round(s.height * k * 100) / 100),
    };
  });
  const total = scaled.reduce((sum, s) => sum + s.width, 0) + gap * Math.max(0, scaled.length - 1);
  const tallest = scaled.reduce((m, s) => Math.max(m, s.height), 0);
  let x = Math.round(center.x - total / 2);
  const y = Math.round(center.y - tallest / 2);
  return scaled.map((s) => {
    const rect = { x, y, width: s.width, height: s.height };
    x = Math.round(x + s.width + gap);
    return rect;
  });
}

// ---------------------------------------------------------------------------
// Cache

export interface LoadedImage {
  readonly bitmap: ImageBitmap;
  /** The image's own size, which may be larger than a bitmap capped for memory. */
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  /** Encoded bytes already available for an image placed before its upload completes. */
  readonly source?: Blob;
}

/** What the renderer draws: a bitmap (maybe downscaled) and the image's natural size. */
export interface ImageView {
  readonly bitmap: ImageBitmap;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

export type ImageStatus = "loading" | "ready" | "error";

export interface ImageCacheOptions {
  /** Fetches and decodes an image. Defaults to fetching `url(sha)` and `createImageBitmap`. */
  readonly load?: (sha: string, signal: AbortSignal) => Promise<LoadedImage>;
  /** Where the default loader fetches an image from. Defaults to `/api/media/<sha>`. */
  readonly url?: (sha: string) => string;
  /** Makes a smaller copy of a bitmap. Defaults to `createImageBitmap` with resize options. */
  readonly resize?: (bitmap: ImageBitmap, width: number, height: number) => Promise<ImageBitmap>;
  /** Decoded bytes to keep (4 per pixel). Default 384 MB. */
  readonly maxBytes?: number;
  /** Keep decoded pixels within maxBytes, including those used in the current view. */
  readonly enforceMaxBytes?: boolean;
  /** Longest side to keep a bitmap at; larger images decode, then shrink to this. Default 4096. */
  readonly maxSide?: number;
  /** Limit concurrent fetch/decode jobs. */
  readonly maxConcurrentLoads?: number;
  /** First retry delay after a failed load; doubles each time up to a minute. Default 2 s. */
  readonly retryMs?: number;
  /** Clock, for tests. */
  readonly now?: () => number;
}

interface Entry {
  status: ImageStatus;
  full: ImageBitmap | null;
  naturalWidth: number;
  naturalHeight: number;
  /** Downscaled copies by width. */
  readonly levels: Map<number, ImageBitmap>;
  readonly pendingLevels: Set<number>;
  /** Frame in which the renderer last asked for it. */
  usedFrame: number;
  attempts: number;
  retryAt: number;
  /** Width of the largest drawn use during the current display frame. */
  wantedWidth?: number;
  /** Some custom sources supply fewer pixels than the natural dimensions imply. */
  displaySourceSide?: number;
  /** An externally supplied bitmap whose encoded original is unavailable. */
  seed?: ImageBitmap;
  abort: AbortController | null;
}

/** Downscaled copies are never smaller than this. */
const MIN_LEVEL = 32;
const MAX_RETRY_MS = 60_000;
/**
 * Give up after this many failures (about four minutes with the default
 * delay): long enough for a collaborator's upload to land, short enough not
 * to poll forever for an image this team can't read, such as one in layers
 * pasted from another team's file.
 */
const MAX_ATTEMPTS = 8;
const DISPLAY_SOURCE_BYTES = 32 * 1024 * 1024;
const DISPLAY_REFINE_MS = 150;
const DISPLAY_MIN_SIDE = 64;

const bytesOf = (b: ImageBitmap) => b.width * b.height * 4;

async function defaultResize(bitmap: ImageBitmap, width: number, height: number) {
  return createImageBitmap(bitmap, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
  });
}

export interface EncodedImage {
  readonly blob: Blob;
  readonly size?: Size;
  /** Preview long-side size served by the Worker, or undefined when full original bytes were returned. */
  readonly preview?: MediaPreviewSize;
  /** True when a `?w=` preview was requested but none is stored yet (server streamed the original). */
  readonly previewMissing?: boolean;
}

export interface EncodedImageOptions {
  /** Request a fixed stored preview tier instead of the full original. */
  readonly preview?: MediaPreviewSize;
}

export function mediaUrl(sha: string, preview?: MediaPreviewSize): string {
  return preview ? `/api/media/${sha}?w=${preview}` : `/api/media/${sha}`;
}

/** Decode directly to the smaller size when we can determine display-oriented dimensions. */
export async function decodeBoundedImage(
  blob: Blob,
  limit: number | ((natural: Size) => number),
): Promise<LoadedImage> {
  const targetSize = (width: number, height: number) => {
    const natural = { width, height };
    return mediaPreviewDimensions(natural, typeof limit === "number" ? limit : limit(natural));
  };
  const head = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer());
  const info = sniffImage(head);
  const orientation =
    info?.mime === "image/jpeg" || info?.mime === "image/webp" ? exifOrientationComplete(head) : 1;
  if (info && orientation !== null) {
    const rotated = orientation >= 5 && orientation <= 8;
    const naturalWidth = rotated ? info.height : info.width;
    const naturalHeight = rotated ? info.width : info.height;
    const size = targetSize(naturalWidth, naturalHeight);
    const bitmap =
      size.width === naturalWidth && size.height === naturalHeight
        ? await createImageBitmap(blob)
        : await createImageBitmap(blob, {
            resizeWidth: size.width,
            resizeHeight: size.height,
            resizeQuality: "high",
          });
    return { bitmap, naturalWidth, naturalHeight };
  }

  const full = await createImageBitmap(blob);
  const naturalWidth = full.width;
  const naturalHeight = full.height;
  const size = targetSize(naturalWidth, naturalHeight);
  if (size.width === naturalWidth && size.height === naturalHeight)
    return { bitmap: full, naturalWidth, naturalHeight };
  try {
    return {
      bitmap: await defaultResize(full, size.width, size.height),
      naturalWidth,
      naturalHeight,
    };
  } finally {
    full.close();
  }
}

function defaultLoader(
  maxSide: number,
  resize: ImageCacheOptions["resize"] = defaultResize,
  url: (sha: string) => string = mediaUrl,
) {
  return async (sha: string, signal: AbortSignal): Promise<LoadedImage> => {
    const response = await fetch(url(sha), { credentials: "same-origin", signal });
    if (!response.ok) throw new Error(`Image ${sha} answered ${response.status}`);
    // Decoding happens off the main thread; EXIF orientation is applied, so the
    // bitmap's size is the size people see.
    const blob = await response.blob();
    let bitmap = await createImageBitmap(blob);
    const naturalWidth = bitmap.width;
    const naturalHeight = bitmap.height;
    const longest = Math.max(naturalWidth, naturalHeight);
    if (longest > maxSide) {
      const k = maxSide / longest;
      const smaller = await resize(
        bitmap,
        Math.max(1, Math.round(naturalWidth * k)),
        Math.max(1, Math.round(naturalHeight * k)),
      );
      bitmap.close();
      bitmap = smaller;
    }
    return { bitmap, naturalWidth, naturalHeight };
  };
}

/**
 * Decoded images by content hash. `get` returns what can be drawn now and
 * starts whatever loading is missing; `subscribe` hears when something new
 * becomes drawable, so the view can repaint.
 */
export class ImageCache {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();
  readonly #load: NonNullable<ImageCacheOptions["load"]>;
  readonly #url: (sha: string) => string;
  readonly #encodedVersions = new Map<string, number>();
  readonly #localSources = new Map<string, { blob: Blob; size: Size }>();
  #localBytes = 0;
  readonly #resize: NonNullable<ImageCacheOptions["resize"]>;
  readonly #maxBytes: number;
  readonly #enforceMaxBytes: boolean;
  readonly #maxConcurrentLoads: number;
  readonly #queuedLoads = new Map<string, Entry>();
  #activeLoads = 0;
  readonly #displaySide: number;
  readonly #customLoad: ImageCacheOptions["load"];
  readonly #displayDemands = new Map<string, Entry>();
  readonly #displaySources = new Map<string, EncodedImage>();
  #displaySourceBytes = 0;
  #displayTargets = new Map<string, number>();
  #collectingDisplayFrame = false;
  #displayQueued = false;
  #displayBusy = false;
  #refineAt = 0;
  #refineTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #retryMs: number;
  readonly #now: () => number;
  #frame = 0;
  #bytes = 0;
  #notifyQueued = false;

  constructor(options: ImageCacheOptions = {}) {
    this.#url = options.url ?? mediaUrl;
    this.#resize = options.resize ?? defaultResize;
    this.#maxConcurrentLoads = Math.max(1, options.maxConcurrentLoads ?? Infinity);
    this.#enforceMaxBytes = options.enforceMaxBytes ?? false;
    this.#displaySide = options.maxSide ?? 4096;
    this.#customLoad = options.load;
    this.#load = options.load ?? defaultLoader(this.#displaySide, this.#resize, options.url);
    this.#maxBytes = options.maxBytes ?? 384 * 1024 * 1024;
    this.#retryMs = options.retryMs ?? 2000;
    this.#now = options.now ?? (() => Date.now());
  }

  get boundedDisplay(): boolean {
    return this.#enforceMaxBytes;
  }

  /** Decoded bytes held, including downscaled copies. */
  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Called when an image (or a sharper copy of one) becomes drawable, or fails. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  status(sha: string): ImageStatus | null {
    return this.#entries.get(sha)?.status ?? null;
  }

  /** Marks the start of a frame. Images drawn in this frame or the last one are never evicted. */
  frame(): void {
    if (this.#enforceMaxBytes) {
      // A stage and its overlays can draw in one turn. Keep their demands together.
      if (!this.#collectingDisplayFrame) {
        this.#displayDemands.clear();
        this.#collectingDisplayFrame = true;
        queueMicrotask(() => {
          this.#collectingDisplayFrame = false;
        });
      }
      this.#scheduleDisplay();
      return;
    }
    this.#frame++;
    this.#evict();
  }

  /** Keeps a use in the current view even if a retained frame reuses its pixels. */
  demand(sha: string, targetWidth: number): void {
    if (this.#enforceMaxBytes) this.#touch(sha, targetWidth);
  }

  /**
   * The image's natural size if it has loaded, else null (and loading starts).
   * Use it to place the image before asking for a bitmap at the right size.
   */
  natural(sha: string): Size | null {
    const entry = this.#touch(sha);
    return entry.status === "ready" || (this.#enforceMaxBytes && entry.naturalWidth > 0)
      ? { width: entry.naturalWidth, height: entry.naturalHeight }
      : null;
  }

  /**
   * A bitmap to draw `sha` about `targetWidth` device pixels wide, or null
   * while it loads. A smaller copy is made in the background when the image
   * shows at under half its bitmap size; until it arrives the full one is used.
   */
  get(sha: string, targetWidth = Number.POSITIVE_INFINITY): ImageView | null {
    const entry = this.#touch(sha, targetWidth);
    const full = entry.full;
    if (entry.status !== "ready" || !full) return null;
    const view = (bitmap: ImageBitmap): ImageView => ({
      bitmap,
      naturalWidth: entry.naturalWidth,
      naturalHeight: entry.naturalHeight,
    });
    if (this.#enforceMaxBytes || !(targetWidth < full.width / 2) || full.width <= MIN_LEVEL * 2)
      return view(full);
    // Halve until one more halving would drop below the target.
    let width = full.width;
    while (width / 2 >= Math.max(targetWidth, MIN_LEVEL)) width = Math.floor(width / 2);
    const level = entry.levels.get(width);
    if (level) return view(level);
    this.#makeLevel(sha, entry, full, width);
    // Meanwhile, the smallest copy that is still at least as sharp as needed.
    let best = full;
    for (const [w, bitmap] of entry.levels) if (w >= width && w < best.width) best = bitmap;
    return view(best);
  }

  /** Changes when locally supplied encoded data becomes available. */
  encodedVersion(sha: string): number {
    return this.#encodedVersions.get(sha) ?? 0;
  }

  /** Base URL used to fetch `sha` (defaults to `/api/media/<sha>`). */
  encodedUrl(sha: string): string {
    return this.#url(sha);
  }

  /** Reads stored media without populating the canvas renderer's decoded cache. */
  async encoded(
    sha: string,
    signal: AbortSignal,
    options?: EncodedImageOptions,
  ): Promise<EncodedImage> {
    const local = this.#localSources.get(sha);
    if (local) return local;
    const original = !options?.preview && this.#displaySources.get(sha);
    if (original) {
      this.#displaySources.delete(sha);
      this.#displaySources.set(sha, original);
      return original;
    }
    const base = this.#url(sha);
    const readResponse = async (response: Response): Promise<EncodedImage> => {
      const headerW = Number(response.headers.get("x-image-width"));
      const headerH = Number(response.headers.get("x-image-height"));
      const size =
        Number.isFinite(headerW) && headerW > 0 && Number.isFinite(headerH) && headerH > 0
          ? { width: headerW, height: headerH }
          : undefined;
      const preview = parseMediaPreviewSize(response.headers.get("x-image-preview"));
      const previewMissing = response.headers.get("x-image-preview-missing") === "1";
      return {
        blob: await response.blob(),
        ...(size ? { size } : {}),
        ...(preview ? { preview } : {}),
        ...(previewMissing ? { previewMissing: true } : {}),
      };
    };
    if (options?.preview) {
      const previewUrl = `${base}${base.includes("?") ? "&" : "?"}w=${options.preview}`;
      try {
        const response = await fetch(previewUrl, { credentials: "same-origin", signal });
        if (response.ok) return await readResponse(response);
        await response.body?.cancel().catch(() => {});
      } catch (err) {
        if (signal.aborted) throw err;
        // Fall through to the original URL whenever a preview fetch errors.
      }
    }
    const response = await fetch(base, { credentials: "same-origin", signal });
    if (!response.ok) throw new Error(`Image ${sha} answered ${response.status}`);
    return readResponse(response);
  }

  /** Adds an image decoded elsewhere (a file just dropped), so it draws before its upload ends. */
  put(sha: string, image: LoadedImage): void {
    if (image.source) {
      this.#encodedVersions.set(sha, this.encodedVersion(sha) + 1);
      const existing = this.#localSources.get(sha);
      if (existing) this.#localBytes -= existing.blob.size;
      this.#localSources.delete(sha);
      this.#localSources.set(sha, {
        blob: image.source,
        size: { width: image.naturalWidth, height: image.naturalHeight },
      });
      this.#localBytes += image.source.size;
      for (const [ref, source] of this.#localSources) {
        if (this.#localBytes <= 32 * 1024 * 1024) break;
        this.#localSources.delete(ref);
        this.#localBytes -= source.blob.size;
      }
    }
    const existing = this.#entries.get(sha);
    if (existing) this.#drop(sha, existing);
    const entry = this.#newEntry();
    this.#entries.set(sha, entry);
    if (this.#enforceMaxBytes) {
      this.#markDisplay(sha, entry, existing?.wantedWidth ?? DISPLAY_MIN_SIDE);
      entry.naturalWidth = image.naturalWidth;
      entry.naturalHeight = image.naturalHeight;
      if (this.#bytes + bytesOf(image.bitmap) <= this.#maxBytes) {
        this.#replaceDisplay(entry, image.bitmap);
        this.#notify();
      } else if (image.source) {
        image.bitmap.close();
      } else {
        entry.seed = image.bitmap;
      }
      return;
    }
    entry.naturalWidth = image.naturalWidth;
    entry.naturalHeight = image.naturalHeight;
    entry.status = "ready";
    entry.full = image.bitmap;
    this.#bytes += bytesOf(image.bitmap);
    this.#evict();
    this.#notify();
  }

  /**
   * Resolves once every image has loaded or failed, or after `timeoutMs`.
   * Exports and thumbnails wait on this so they never capture a placeholder.
   */
  async ready(shas: Iterable<string>, timeoutMs = 10_000): Promise<void> {
    const list = [...new Set(shas)];
    const pending = () =>
      list.filter((sha) => {
        const entry = this.#touch(sha);
        return entry.status === "loading";
      });
    if (pending().length === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const off = this.subscribe(() => {
        if (pending().length === 0) done();
      });
      function done() {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  }

  /** Releases every bitmap and cancels loads. */
  clear(): void {
    this.#localSources.clear();
    this.#displaySources.clear();
    this.#displaySourceBytes = 0;
    this.#displayDemands.clear();
    this.#displayTargets.clear();
    clearTimeout(this.#refineTimer);
    this.#encodedVersions.clear();
    this.#localBytes = 0;
    for (const [sha, entry] of this.#entries) this.#drop(sha, entry);
  }

  #newEntry(): Entry {
    return {
      status: "loading",
      full: null,
      naturalWidth: 0,
      naturalHeight: 0,
      levels: new Map(),
      pendingLevels: new Set(),
      usedFrame: this.#frame,
      attempts: 0,
      retryAt: 0,
      abort: null,
    };
  }

  /** Finds or creates the entry, marks it used and most recent, and (re)starts loading if due. */
  #touch(sha: string, targetWidth = DISPLAY_MIN_SIDE): Entry {
    let entry = this.#entries.get(sha);
    if (entry) {
      // Map order is the LRU order: move to the end.
      this.#entries.delete(sha);
      this.#entries.set(sha, entry);
    } else {
      entry = this.#newEntry();
      this.#entries.set(sha, entry);
    }
    if (this.#enforceMaxBytes) {
      this.#markDisplay(sha, entry, targetWidth);
      return entry;
    }
    entry.usedFrame = this.#frame;
    if (entry.status === "error" && this.#now() >= entry.retryAt) entry.status = "loading";
    if (entry.status === "loading" && !entry.abort) {
      if (this.#activeLoads < this.#maxConcurrentLoads) this.#start(sha, entry);
      else this.#queuedLoads.set(sha, entry);
    }
    return entry;
  }

  #start(sha: string, entry: Entry): void {
    const abort = new AbortController();
    entry.abort = abort;
    this.#activeLoads++;
    this.#queuedLoads.delete(sha);
    this.#load(sha, abort.signal)
      .then(
        (image) => {
          if (this.#entries.get(sha) !== entry || abort.signal.aborted) {
            image.bitmap.close();
            return;
          }
          entry.abort = null;
          entry.status = "ready";
          entry.full = image.bitmap;
          entry.naturalWidth = image.naturalWidth;
          entry.naturalHeight = image.naturalHeight;
          entry.attempts = 0;
          this.#bytes += bytesOf(image.bitmap);
          this.#evict();
          this.#notify();
        },
        () => {
          if (this.#entries.get(sha) !== entry || abort.signal.aborted) return;
          // Often a collaborator's upload that hasn't finished yet: try again, backing off.
          entry.abort = null;
          entry.status = "error";
          entry.attempts++;
          entry.retryAt =
            entry.attempts >= MAX_ATTEMPTS
              ? Number.POSITIVE_INFINITY
              : this.#now() + Math.min(MAX_RETRY_MS, this.#retryMs * 2 ** (entry.attempts - 1));
          this.#notify();
        },
      )
      .finally(() => {
        this.#activeLoads--;
        for (const [next, queued] of this.#queuedLoads) {
          this.#start(next, queued);
          break;
        }
      });
  }

  #markDisplay(sha: string, entry: Entry, width: number): void {
    entry.wantedWidth = this.#displayDemands.has(sha)
      ? Math.max(entry.wantedWidth ?? 0, width)
      : width;
    this.#displayDemands.set(sha, entry);
    this.#scheduleDisplay();
  }

  #scheduleDisplay(): void {
    if (this.#displayBusy || this.#displayQueued) return;
    this.#displayQueued = true;
    queueMicrotask(() => {
      this.#displayQueued = false;
      this.#pumpDisplay();
    });
  }

  #displaySize(entry: Entry, side: number): Size {
    return mediaPreviewDimensions(
      {
        width: entry.naturalWidth || this.#displaySide,
        height: entry.naturalHeight || this.#displaySide,
      },
      side,
    );
  }

  /** Reserve a level for every visible ref before assigning bytes to any one refinement. */
  #planDisplay(): Map<string, number> {
    const desired = Array.from(this.#displayDemands, ([ref, entry]) => {
      const w = entry.naturalWidth || this.#displaySide;
      const h = entry.naturalHeight || this.#displaySide;
      const longest = Math.max(w, h);
      const wanted = ((entry.wantedWidth ?? DISPLAY_MIN_SIDE) * longest) / w;
      const tier = 2 ** Math.ceil(Math.log2(Math.max(DISPLAY_MIN_SIDE, wanted)));
      return {
        ref,
        entry,
        side: Math.min(longest, entry.displaySourceSide ?? this.#displaySide, tier),
      };
    });
    const sideAt = (side: number, scale: number) => Math.max(1, Math.floor(side * scale));
    const cost = (scale: number) =>
      desired.reduce((bytes, { side, entry }) => {
        const size = this.#displaySize(entry, sideAt(side, scale));
        return bytes + size.width * size.height * 4;
      }, 0);

    let scale = 1;
    if (cost(1) > this.#maxBytes) {
      scale = 0;
      let high = 1;
      for (let i = 0; i < 15; i++) {
        const mid = (scale + high) / 2;
        if (cost(mid) <= this.#maxBytes) scale = mid;
        else high = mid;
      }
    }
    return new Map(desired.map(({ ref, side }) => [ref, sideAt(side, scale)]));
  }

  #pumpDisplay(): void {
    const targets = this.#planDisplay();
    const now = this.#now();
    if (
      this.#displayTargets.size !== targets.size ||
      [...targets].some(([ref, side]) => this.#displayTargets.get(ref) !== side)
    ) {
      this.#displayTargets = targets;
      this.#refineAt = now + DISPLAY_REFINE_MS;
    }

    let missing: { ref: string; entry: Entry; side: number } | undefined;
    let finer: typeof missing;
    let shrink: typeof missing;
    for (const [ref, entry] of this.#displayDemands) {
      const side = targets.get(ref) ?? 1;
      if (entry.retryAt > now) continue;
      const current = entry.full ? Math.max(entry.full.width, entry.full.height) : 0;
      if (current === 0 && !missing) missing = { ref, entry, side };
      else if (current > 0 && current < side && !finer) finer = { ref, entry, side };
      else if (current > side && !shrink) shrink = { ref, entry, side };
    }

    if (!missing && finer && now < this.#refineAt) {
      clearTimeout(this.#refineTimer);
      this.#refineTimer = setTimeout(() => this.#scheduleDisplay(), this.#refineAt - now);
      return;
    }
    const request = missing ?? finer;
    if (!request) return;
    const { entry, side, ref } = request;
    const dim = this.#displaySize(entry, side);
    const incoming = dim.width * dim.height * 4 - (entry.full ? bytesOf(entry.full) : 0);
    this.#evictDisplay(incoming);
    if (this.#bytes + incoming > this.#maxBytes) {
      if (shrink) this.#runDisplay(shrink.ref, shrink.entry, shrink.side, true);
      return;
    }
    this.#runDisplay(ref, entry, side, false);
  }

  #evictDisplay(incoming: number): void {
    for (const [ref, entry] of this.#entries) {
      if (this.#bytes + incoming <= this.#maxBytes) break;
      if (this.#displayDemands.has(ref) || !entry.full) continue;
      this.#bytes -= bytesOf(entry.full);
      entry.full.close();
      entry.full = null;
      entry.status = "loading";
    }
  }

  #runDisplay(ref: string, entry: Entry, side: number, shrink: boolean): void {
    const abort = new AbortController();
    const prior = entry.full;
    this.#displayBusy = true;
    entry.abort = abort;
    if (!prior) entry.status = "loading";
    void (async () => {
      let image: LoadedImage | undefined;
      try {
        if (shrink && prior) {
          const { width, height } = this.#displaySize(entry, side);
          image = {
            bitmap: await this.#resize(prior, width, height),
            naturalWidth: entry.naturalWidth,
            naturalHeight: entry.naturalHeight,
          };
        } else {
          image = await this.#loadDisplay(ref, entry, side, abort.signal);
        }
        if (this.#entries.get(ref) !== entry || abort.signal.aborted) return;
        entry.naturalWidth = image.naturalWidth;
        entry.naturalHeight = image.naturalHeight;
        const loadedSide = Math.max(image.bitmap.width, image.bitmap.height);
        if (!shrink && loadedSide < side) entry.displaySourceSide = loadedSide;
        const incoming = bytesOf(image.bitmap) - (entry.full ? bytesOf(entry.full) : 0);
        if (this.#displayDemands.has(ref)) this.#evictDisplay(incoming);
        if (this.#bytes + incoming > this.#maxBytes) return;
        this.#replaceDisplay(entry, image.bitmap);
        image = undefined;
        this.#notify();
      } catch {
        if (abort.signal.aborted) return;
        entry.attempts++;
        entry.retryAt =
          entry.attempts >= MAX_ATTEMPTS
            ? Infinity
            : this.#now() + Math.min(MAX_RETRY_MS, this.#retryMs * 2 ** (entry.attempts - 1));
        if (!entry.full) entry.status = "error";
        this.#notify();
      } finally {
        image?.bitmap.close();
        entry.abort = null;
        this.#displayBusy = false;
        this.#scheduleDisplay();
      }
    })();
  }

  #replaceDisplay(entry: Entry, bitmap: ImageBitmap): void {
    if (entry.full) {
      this.#bytes -= bytesOf(entry.full);
      entry.full.close();
    }
    entry.full = bitmap;
    entry.status = "ready";
    entry.attempts = 0;
    entry.retryAt = 0;
    this.#bytes += bytesOf(bitmap);
  }

  async #loadDisplay(
    ref: string,
    entry: Entry,
    side: number,
    signal: AbortSignal,
  ): Promise<LoadedImage> {
    const seed = entry.seed;
    if (!seed && !this.#customLoad) {
      const source = await this.encoded(ref, signal);
      signal.throwIfAborted();
      if (!this.#localSources.has(ref) && !this.#displaySources.has(ref)) {
        this.#displaySources.set(ref, source);
        this.#displaySourceBytes += source.blob.size;
        for (const [old, stored] of this.#displaySources) {
          if (this.#displaySourceBytes <= DISPLAY_SOURCE_BYTES) break;
          this.#displaySources.delete(old);
          this.#displaySourceBytes -= stored.blob.size;
        }
      }
      return decodeBoundedImage(source.blob, side);
    }

    const image = seed
      ? { bitmap: seed, naturalWidth: entry.naturalWidth, naturalHeight: entry.naturalHeight }
      : await this.#load(ref, signal);
    if (Math.max(image.bitmap.width, image.bitmap.height) <= side) {
      delete entry.seed;
      return image;
    }
    const size = mediaPreviewDimensions(image.bitmap, side);
    try {
      return { ...image, bitmap: await this.#resize(image.bitmap, size.width, size.height) };
    } finally {
      delete entry.seed;
      image.bitmap.close();
    }
  }

  #makeLevel(sha: string, entry: Entry, full: ImageBitmap, width: number): void {
    if (entry.pendingLevels.has(width)) return;
    entry.pendingLevels.add(width);
    const height = Math.max(1, Math.round((full.height * width) / full.width));
    this.#resize(full, width, height).then(
      (bitmap) => {
        entry.pendingLevels.delete(width);
        if (this.#entries.get(sha) !== entry || entry.full !== full) {
          bitmap.close();
          return;
        }
        entry.levels.set(width, bitmap);
        this.#bytes += bytesOf(bitmap);
        this.#evict();
        this.#notify();
      },
      () => {
        // Keep drawing the full bitmap; don't retry this size.
        entry.levels.set(width, full);
      },
    );
  }

  #drop(sha: string, entry: Entry): void {
    this.#queuedLoads.delete(sha);
    this.#displayDemands.delete(sha);
    entry.abort?.abort();
    entry.seed?.close();
    for (const bitmap of entry.levels.values()) {
      if (bitmap === entry.full) continue;
      this.#bytes -= bytesOf(bitmap);
      bitmap.close();
    }
    entry.levels.clear();
    if (entry.full) {
      this.#bytes -= bytesOf(entry.full);
      entry.full.close();
      entry.full = null;
    }
    this.#entries.delete(sha);
  }

  /**
   * Least recently used first. Anything drawn in this frame or the previous
   * one stays, so a view showing more than the budget doesn't reload in a loop.
   */
  #evict(): void {
    if (this.#bytes <= this.#maxBytes) return;
    for (const [sha, entry] of this.#entries) {
      if (this.#bytes <= this.#maxBytes) break;
      if (entry.usedFrame >= this.#frame - 1 || entry.status !== "ready") continue;
      this.#drop(sha, entry);
    }
  }

  /** One notification per microtask, however many images landed together. */
  #notify(): void {
    if (this.#notifyQueued) return;
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      for (const listener of [...this.#listeners]) listener();
    });
  }
}
