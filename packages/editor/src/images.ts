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
import type { Point, Rect } from "./geometry";

export type ScaleMode = "fill" | "fit" | "tile" | "stretch";

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
 */
export function imagePlacement(mode: ScaleMode, box: Size, image: Size): ImagePlacement {
  const iw = Math.max(1e-9, image.width);
  const ih = Math.max(1e-9, image.height);
  if (mode === "stretch") return { x: 0, y: 0, width: box.width, height: box.height, tile: false };
  if (mode === "tile") return { x: 0, y: 0, width: iw, height: ih, tile: true };
  const sx = box.width / iw;
  const sy = box.height / ih;
  const s = mode === "fill" ? Math.max(sx, sy) : Math.min(sx, sy);
  const width = iw * s;
  const height = ih * s;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height, tile: false };
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
  /** Longest side to keep a bitmap at; larger images decode, then shrink to this. Default 4096. */
  readonly maxSide?: number;
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

const bytesOf = (b: ImageBitmap) => b.width * b.height * 4;

async function defaultResize(bitmap: ImageBitmap, width: number, height: number) {
  return createImageBitmap(bitmap, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
  });
}

export function mediaUrl(sha: string): string {
  return `/api/media/${sha}`;
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
    let bitmap = await createImageBitmap(await response.blob());
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
  readonly #resize: NonNullable<ImageCacheOptions["resize"]>;
  readonly #maxBytes: number;
  readonly #retryMs: number;
  readonly #now: () => number;
  #frame = 0;
  #bytes = 0;
  #notifyQueued = false;

  constructor(options: ImageCacheOptions = {}) {
    this.#resize = options.resize ?? defaultResize;
    this.#load = options.load ?? defaultLoader(options.maxSide ?? 4096, this.#resize, options.url);
    this.#maxBytes = options.maxBytes ?? 384 * 1024 * 1024;
    this.#retryMs = options.retryMs ?? 2000;
    this.#now = options.now ?? (() => Date.now());
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
    this.#frame++;
    this.#evict();
  }

  /**
   * The image's natural size if it has loaded, else null (and loading starts).
   * Use it to place the image before asking for a bitmap at the right size.
   */
  natural(sha: string): Size | null {
    const entry = this.#touch(sha);
    return entry.status === "ready"
      ? { width: entry.naturalWidth, height: entry.naturalHeight }
      : null;
  }

  /**
   * A bitmap to draw `sha` about `targetWidth` device pixels wide, or null
   * while it loads. A smaller copy is made in the background when the image
   * shows at under half its bitmap size; until it arrives the full one is used.
   */
  get(sha: string, targetWidth = Number.POSITIVE_INFINITY): ImageView | null {
    const entry = this.#touch(sha);
    const full = entry.full;
    if (entry.status !== "ready" || !full) return null;
    const view = (bitmap: ImageBitmap): ImageView => ({
      bitmap,
      naturalWidth: entry.naturalWidth,
      naturalHeight: entry.naturalHeight,
    });
    if (!(targetWidth < full.width / 2) || full.width <= MIN_LEVEL * 2) return view(full);
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

  /** Adds an image decoded elsewhere (a file just dropped), so it draws before its upload ends. */
  put(sha: string, image: LoadedImage): void {
    const existing = this.#entries.get(sha);
    if (existing) this.#drop(sha, existing);
    const entry = this.#newEntry();
    entry.status = "ready";
    entry.full = image.bitmap;
    entry.naturalWidth = image.naturalWidth;
    entry.naturalHeight = image.naturalHeight;
    entry.usedFrame = this.#frame;
    this.#entries.set(sha, entry);
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
  #touch(sha: string): Entry {
    let entry = this.#entries.get(sha);
    if (entry) {
      // Map order is the LRU order: move to the end.
      this.#entries.delete(sha);
      this.#entries.set(sha, entry);
    } else {
      entry = this.#newEntry();
      this.#entries.set(sha, entry);
    }
    entry.usedFrame = this.#frame;
    if (entry.status === "error" && this.#now() >= entry.retryAt) entry.status = "loading";
    if (entry.status === "loading" && !entry.abort) this.#start(sha, entry);
    return entry;
  }

  #start(sha: string, entry: Entry): void {
    const abort = new AbortController();
    entry.abort = abort;
    this.#load(sha, abort.signal).then(
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
    );
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
    entry.abort?.abort();
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
