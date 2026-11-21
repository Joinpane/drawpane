import type { ImageCache, ImageDemand, Size } from "@drawpane/editor";
import type { RenderEngine } from "@drawpane/engine";
import { sniffImage } from "@drawpane/model";
import { colorBitmap } from "./color-glyphs";

const MIB = 1024 * 1024;
const MAX_DECODES = 4;
const PREFETCH_LEVELS = 2;
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

export function deviceImageBudget(max: number): number {
  const memory = (globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined)
    ?.deviceMemory;
  const bytes = memory && memory > 0 ? Math.max(16, memory * 48) * MIB : 192 * MIB;
  return Math.min(max, bytes);
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
  blob?: Blob;
  glyph?: () => ImageData | null;
  used: number;
}

interface Target extends Size {
  readonly ref: string;
  readonly handle: number;
  readonly priority: number;
  readonly forecast?: boolean;
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
const keyOf = ({ handle, width }: Target) => `${handle}/${width}`;
const resize = ({ width, height }: Size): ImageBitmapOptions => ({
  resizeWidth: width,
  resizeHeight: height,
  resizeQuality: "high",
  premultiplyAlpha: "premultiply",
});

function fits(level: Size, needed: Size): boolean {
  return level.width >= needed.width && level.height >= needed.height;
}

function levels(size: Size, maxSide: number): Size[] {
  const fit = Math.min(1, maxSide / Math.max(size.width, size.height));
  let width = Math.max(1, Math.floor(size.width * fit));
  let height = Math.max(1, Math.floor(size.height * fit));
  const out = [{ width, height }];
  while (width >= 2 && Math.max(width, height) >= 64) {
    width = Math.floor(width / 2);
    height = Math.max(1, Math.floor(height / 2));
    out.push({ width, height });
  }
  // Large photos on high-DPR displays could round up to nearly four times the
  // visible pixel count. Stable 256 px steps keep headroom without decoding a
  // different size on every camera tick.
  if (Math.max(size.width, size.height) < 3072) return out;
  const largest = out[0];
  if (!largest) return out;
  const side = Math.max(largest.width, largest.height);
  const byWidth = new Map(out.map((level) => [level.width, level]));
  for (let step = 1280; step < side; step += 256) {
    const smaller = {
      width: Math.ceil((largest.width * step) / side),
      height: Math.ceil((largest.height * step) / side),
    };
    if (!byWidth.has(smaller.width)) byWidth.set(smaller.width, smaller);
  }
  return [...byWidth.values()].sort((a, b) => b.width - a.width);
}

function levelFor(pyramid: readonly Size[], span: Size, scale: number): number {
  return Math.max(
    0,
    pyramid.findLastIndex(
      (size) => size.width >= span.width * scale && size.height >= span.height * scale,
    ),
  );
}

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
  readonly #residents = new Map<string, Resident>();
  readonly #jobs = new Map<string, { ref: string; abort: AbortController; target?: Target }>();
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
  ) {}

  info(ref: string): ImageInfo | null {
    return this.#sources.get(ref)?.info ?? null;
  }

  /** Registers generated glyphs with the same handles, budget and lifetime as photos. */
  colorGlyph(text: string, font: string, scale: number) {
    const sprite = colorBitmap(text, font, scale);
    if (!sprite) return null;
    const { ref, x, y, width, height, pixels } = sprite;
    let source = this.#sources.get(ref);
    if (!source) {
      source = {
        info: { handle: this.#nextHandle++, width: pixels.width, height: pixels.height },
        version: this.cache.encodedVersion(ref),
        used: this.#clock,
        glyph: () => {
          const bitmap = colorBitmap(text, font, scale);
          return bitmap?.ref === ref ? bitmap.pixels : null;
        },
      };
      this.#sources.set(ref, source);
    }
    return { ref, handle: source.info.handle, x, y, width, height };
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
    for (const { abort } of this.#jobs.values()) abort.abort();
    const keep = new Map<string, Resident>();
    if (keepVisible) {
      for (const level of this.#residents.values()) {
        if (!this.#visible.has(level.ref)) continue;
        const previous = keep.get(level.ref);
        if (!previous || level.width < previous.width) keep.set(level.ref, level);
      }
    }
    for (const [key, level] of this.#residents) {
      if (keep.get(level.ref) !== level) this.#drop(key);
    }
    this.#targets.clear();
    this.#metadata.clear();
    if (!keepVisible) this.#visible.clear();
    this.#primary.clear();
    this.#fallbacks.clear();
    this.#protected.clear();
    this.#zoomSample = undefined;
    this.#forecastScale = 0;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  retain(used: ReadonlySet<string>): void {
    for (const { ref, abort } of this.#jobs.values()) if (!used.has(ref)) abort.abort();
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

  update(
    demands: Iterable<ImageDemand>,
    scale: number,
    limits: { side: number; bytes: number },
    now = performance.now(),
  ): boolean {
    if (!this.#backend) return true;
    const budget = deviceImageBudget(limits.bytes);
    if (budget !== this.#budget) this.#denied.clear();
    const maxSide = Math.min(MAX_BITMAP_SIDE, limits.side);
    const candidates = new Map<string, Target>();
    const metadata = new Map<string, boolean>();
    const ideal = new Map<string, Target>();
    const forecasts = new Map<string, Target>();
    const fallbacks = new Map<string, Target>();
    const pyramids = new Map<string, Size[]>();
    const heldByHandle = new Map<number, Resident[]>();
    for (const level of this.#residents.values()) {
      const held = heldByHandle.get(level.handle) ?? [];
      held.push(level);
      heldByHandle.set(level.handle, held);
    }
    const visible = new Set<string>();
    const reduced = new Set<string>();
    const clock = ++this.#clock;
    const forecastScale = this.#predictScale(scale, now);

    for (const { ref, visible: onScreen, span } of demands) {
      if (onScreen) visible.add(ref);
      const source = this.#sources.get(ref);
      const version = this.cache.encodedVersion(ref);
      const retry = this.#retryAt.get(ref);
      if (retry && retry.version !== version) this.#retryAt.delete(ref);
      if (source && source.version !== version) {
        source.version = version;
        delete source.blob;
      }
      if (this.#failed.get(ref) === version) {
        if (onScreen) reduced.add(ref);
        continue;
      }
      if (!source) {
        metadata.set(ref, onScreen || Boolean(metadata.get(ref)));
        if (onScreen && this.#retryAt.has(ref)) reduced.add(ref);
        continue;
      }
      if (!span) continue;
      source.used = clock;
      let pyramid = pyramids.get(ref);
      if (!pyramid) {
        pyramid = levels(source.info, maxSide);
        pyramids.set(ref, pyramid);
      }
      const current = levelFor(pyramid, span, scale);
      const ahead = levelFor(pyramid, span, forecastScale);
      const handle = source.info.handle;
      const size = pyramid[current];
      if (!size) continue;
      const wanted = { ...size, ref, handle, priority: onScreen ? 0 : 3 };
      if (onScreen) ideal.set(keyOf(wanted), wanted);
      let available = pyramid
        .slice(current)
        .find((level) => !this.#denied.has(keyOf({ ...wanted, ...level })));
      if (onScreen && available) {
        // A prefetched level can satisfy the current view. Charge its real
        // size to the plan so it still gives way under budget pressure.
        let held: Resident | undefined;
        for (const level of heldByHandle.get(handle) ?? []) {
          if (fits(level, available) && (!held || level.width < held.width)) held = level;
        }
        if (held) available = held;
      }
      if (available) {
        const target = { ...wanted, ...available };
        const key = keyOf(target);
        const previous = candidates.get(key);
        if (!previous || target.priority < previous.priority) candidates.set(key, target);
      }
      if (onScreen) {
        const coarse = pyramid.at(-1);
        if (coarse) fallbacks.set(ref, { ...coarse, ref, handle, priority: 0 });
        const projected = pyramid[ahead];
        if (ahead < current && projected) {
          const forecast = { ...projected, ref, handle, priority: 1, forecast: true };
          const previous = forecasts.get(ref);
          if ((!previous || forecast.width > previous.width) && !this.#denied.has(keyOf(forecast)))
            forecasts.set(ref, forecast);
        }
        for (let ahead = 1; ahead <= PREFETCH_LEVELS; ahead++) {
          const finer = pyramid[current - ahead];
          if (!finer) break;
          const target = { ...finer, ref, handle, priority: 3 + ahead };
          const key = keyOf(target);
          if (!candidates.has(key) && !this.#denied.has(key)) candidates.set(key, target);
        }
      }
    }

    for (const [key, { target, abort }] of this.#jobs) {
      if (!target?.forecast || abort.signal.aborted || candidates.get(key)?.priority === 0)
        continue;
      const useful = [...candidates.values()].some(
        (level) =>
          level.priority === 0 &&
          level.ref === target.ref &&
          fits(target, level) &&
          !this.#residents.has(keyOf(level)),
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
        const smaller = pyramids
          .get(target.ref)
          ?.find(
            (level) =>
              level.width < target.width && !this.#denied.has(keyOf({ ...target, ...level })),
          );
        if (!smaller) continue;
        largest = i;
        largestBytes = bytes(target);
        replacement = { ...target, ...smaller };
      }
      if (largest < 0 || !replacement) break;
      const removed = primary[largest];
      if (!removed) break;
      planned -= plannedBytes(removed);
      if (primary.some((other, i) => i !== largest && keyOf(other) === keyOf(replacement))) {
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
        const affordable = pyramids.get(target.ref)?.find((level) => {
          const choice = { ...target, ...level };
          return (
            level.width <= target.width &&
            level.width > current.width &&
            planned + plannedBytes(choice) - credit <= budget &&
            !this.#denied.has(keyOf(choice))
          );
        });
        if (!affordable) continue;
        target = { ...target, ...affordable };
      }
      const key = keyOf(target);
      if (targets.has(key)) continue;
      targets.set(key, target);
      planned += plannedBytes(target) - credit;
      if (target.priority === 0 && (!current || target.width > current.width))
        primaryByRef.set(target.ref, target);
      const resident = this.#residents.get(key);
      if (resident) resident.used = clock;
    }
    // A photo decoded in the neighbouring ring can already be sharp when it
    // enters the view. Give it a thumbnail without waiting for another zoom.
    for (const [ref, fallback] of fallbacks) {
      const primary = primaryByRef.get(ref);
      const key = keyOf(fallback);
      if (primary && this.#residents.has(keyOf(primary)) && !this.#residents.has(key))
        targets.set(key, { ...fallback, priority: 2 });
    }

    this.#budget = budget;
    this.#targets = targets;
    this.#primary = primaryByRef;
    this.#fallbacks = fallbacks;
    this.#metadata = metadata;
    this.#visible = visible;
    for (const [key, { ref, abort, target }] of this.#jobs) {
      if (target ? !targets.has(key) : !metadata.has(ref)) abort.abort();
    }
    this.#pump();

    // An in-flight improvement makes a frame provisional. Failed or unaffordable
    // detail is a settled reduction at the current budget, even with a placeholder.
    const pending = new Set<string>();
    for (const [ref, onScreen] of metadata) {
      if (onScreen && !this.#retryAt.has(ref)) pending.add(ref);
    }
    const sharp = new Map<string, Resident>();
    for (const resident of this.#residents.values()) {
      const previous = sharp.get(resident.ref);
      if (!previous || previous.width < resident.width) sharp.set(resident.ref, resident);
    }
    for (const target of targets.values()) {
      if (target.priority !== 0) continue;
      const resident = sharp.get(target.ref);
      if (resident && fits(resident, target)) continue;
      if (this.#jobs.has(keyOf(target)) || this.#room(target, this.#missingFallback(target)))
        pending.add(target.ref);
    }
    for (const target of ideal.values()) {
      const resident = sharp.get(target.ref);
      if (!pending.has(target.ref) && (!resident || !fits(resident, target)))
        reduced.add(target.ref);
    }
    this.#reduced = reduced.size;
    return pending.size === 0;
  }

  #refreshProtection(): void {
    this.#protected.clear();
    const nearest = new Map<string, Resident>();
    for (const [key, resident] of this.#residents) {
      if (!this.#visible.has(resident.ref)) continue;
      const wanted = this.#primary.get(resident.ref);
      const previous = nearest.get(resident.ref);
      if (
        !previous ||
        (wanted && fits(previous, wanted)
          ? fits(resident, wanted) && resident.width < previous.width
          : resident.width > previous.width)
      )
        nearest.set(resident.ref, resident);
      if (
        this.#targets.get(key)?.priority === 0 ||
        this.#fallbacks.get(resident.ref)?.width === resident.width
      )
        this.#protected.add(key);
    }
    for (const resident of nearest.values()) this.#protected.add(keyOf(resident));
  }

  #missingFallback(target: Target): Target | undefined {
    if (target.priority !== 0 && !target.forecast) return;
    const fallback = this.#fallbacks.get(target.ref);
    if (
      fallback &&
      fallback.width < target.width &&
      !this.#residents.has(keyOf(fallback)) &&
      !this.#denied.has(keyOf(fallback))
    )
      return fallback;
  }

  #room(target: Target, missingFallback?: Target): Resident[] | null {
    const available = this.#budget - this.#residentBytes;
    const extra = missingFallback ? bytes(missingFallback) : 0;
    const need = bytes(target) + extra - available;
    if (need <= 0) return [];
    const optional: Resident[] = [];
    const replaceable: Resident[] = [];
    const fallback = this.#fallbacks.get(target.ref);
    const mayReplace = Boolean(
      (target.priority === 0 || target.forecast) &&
        fallback &&
        (missingFallback || this.#residents.has(keyOf(fallback))),
    );
    for (const [key, resident] of this.#residents) {
      if (
        !this.#protected.has(key) &&
        (this.#targets.get(key)?.priority ?? Infinity) > target.priority
      ) {
        optional.push(resident);
      } else if (
        mayReplace &&
        resident.ref === target.ref &&
        resident.width !== fallback?.width &&
        (fits(target, resident) ||
          (target.priority === 0 && this.#targets.get(key)?.priority !== 0))
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
    for (const [key] of this.#residents) {
      if (this.#protected.has(key)) continue;
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
    const sources = [...this.#sources.values()]
      .filter((s) => s.blob)
      .sort((a, b) => a.used - b.used);
    let held = sources.reduce((total, source) => total + (source.blob?.size ?? 0), 0);
    for (const source of sources) {
      if (held <= SOURCE_BUDGET) break;
      held -= source.blob?.size ?? 0;
      delete source.blob;
    }
  }

  #scheduleLevel(target: Target): void {
    const backend = this.#backend;
    const key = keyOf(target);
    if (
      !backend ||
      this.#residents.has(key) ||
      this.#jobs.has(key) ||
      this.#denied.has(key) ||
      this.#failed.get(target.ref) === this.cache.encodedVersion(target.ref)
    )
      return;
    if (this.#inflightBytes > 0 && this.#inflightBytes + bytes(target) > DECODE_BYTES) return;
    // A finer bitmap already in flight or resident can serve this level as well.
    if (target.priority > 0 && target.width !== this.#fallbacks.get(target.ref)?.width) {
      for (const resident of this.#residents.values()) {
        if (resident.ref === target.ref && fits(resident, target)) return;
      }
    }
    for (const { target: pending, abort } of this.#jobs.values()) {
      if (
        pending?.ref === target.ref &&
        !abort.signal.aborted &&
        fits(pending, target) &&
        (pending.forecast ||
          (target.priority > 0 && target.width !== this.#fallbacks.get(target.ref)?.width))
      )
        return;
    }
    if (this.#room(target, this.#missingFallback(target))) this.#requestLevel(key, target, backend);
  }

  #pump(): void {
    if (!this.#backend) return;
    this.#refreshProtection();
    if (this.#jobs.size >= MAX_DECODES) return;
    const ordered = [...this.#targets.values()].sort((a, b) => a.priority - b.priority);
    for (const target of ordered) {
      if (target.priority === 0) this.#scheduleLevel(target);
      if (this.#jobs.size >= MAX_DECODES) return;
    }
    for (const target of ordered) {
      if (this.#jobs.size >= MAX_DECODES - 1) break;
      if (target.forecast) this.#scheduleLevel(target);
    }
    for (const [ref, visible] of this.#metadata) {
      if (visible) this.#requestMetadata(ref);
      if (this.#jobs.size >= MAX_DECODES) return;
    }
    for (const target of ordered) {
      if (this.#jobs.size >= MAX_DECODES - 1) break;
      if (target.priority > 0 && !target.forecast) this.#scheduleLevel(target);
    }
    for (const [ref, visible] of this.#metadata) {
      if (!visible) this.#requestMetadata(ref);
      if (this.#jobs.size >= MAX_DECODES) return;
    }
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    let next = Infinity;
    for (const ref of this.#metadata.keys()) {
      const retry = this.#retryAt.get(ref);
      if (retry && !this.#jobs.has(`source:${ref}`)) next = Math.min(next, retry.at);
    }
    if (Number.isFinite(next))
      this.#retryTimer = setTimeout(() => this.#pump(), Math.max(0, next - Date.now()));
  }

  #requestMetadata(ref: string): void {
    const key = `source:${ref}`;
    if (
      this.#sources.has(ref) ||
      this.#jobs.has(key) ||
      (this.#retryAt.get(ref)?.at ?? 0) > Date.now()
    )
      return;
    const abort = new AbortController();
    this.#jobs.set(key, { ref, abort });
    void (async () => {
      const version = this.cache.encodedVersion(ref);
      try {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
        const { blob, size } = await untilAborted(this.cache.encoded(ref, signal), signal);
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
        this.#sources.set(ref, {
          info: { ...dimensions, handle: this.#nextHandle++ },
          version,
          blob,
          used: this.#clock,
        });
        this.#trimSources();
        this.#retryAt.delete(ref);
        this.metadataReady(ref);
      } catch {
        if (!abort.signal.aborted) {
          const attempts = (this.#retryAt.get(ref)?.attempts ?? 0) + 1;
          const delay = attempts < 8 ? Math.min(60_000, 2000 * 2 ** (attempts - 1)) : Infinity;
          this.#retryAt.set(ref, { at: Date.now() + delay, attempts, version });
          this.changed();
        }
      } finally {
        this.#jobs.delete(key);
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
    const key = keyOf(target);
    if (uploaded) {
      this.#residents.set(key, { ...target, used: this.#clock });
      this.#residentBytes += bytes(target);
    } else {
      this.#denied.add(key);
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
          this.#drop(keyOf(level));
        }
        await this.#uploadLevel(fallback, thumbnail, backend, signal);
      } catch {
        // The optional copy must not mark otherwise usable source bytes corrupt.
        if (!signal.aborted) this.#denied.add(keyOf(fallback));
      } finally {
        thumbnail?.close();
      }
    }
    await this.#paceUpload(bytes(target), signal);
    if (signal.aborted) return;
    this.#refreshProtection();
    const room = this.#room(target);
    if (!room) return;
    for (const level of room) this.#drop(keyOf(level));
    await this.#uploadLevel(target, bitmap, backend, signal);
  }

  #requestLevel(key: string, target: Target, backend: ImageBackend): void {
    const abort = new AbortController();
    this.#jobs.set(key, { ref: target.ref, abort, target });
    const need = bytes(target);
    this.#inflightBytes += need;
    void (async () => {
      let bitmap: ImageBitmap | undefined;
      const version = this.cache.encodedVersion(target.ref);
      try {
        const source = this.#sources.get(target.ref);
        if (!source) return;
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const signal = AbortSignal.any([abort.signal, timeout]);
        let input: ImageData | Blob | null;
        if (source.glyph) {
          input = source.glyph();
        } else {
          input =
            source.blob ??
            (await untilAborted(this.cache.encoded(target.ref, signal), signal)).blob;
          source.blob = input;
          this.#trimSources();
        }
        if (abort.signal.aborted) return;
        if (!input) {
          this.#failed.set(target.ref, version);
          this.changed();
          return;
        }
        // Bitmap decodes cannot be interrupted. Keep the slot until the native
        // work returns instead of starting a new decode on every camera tick.
        bitmap = await untilAborted(createImageBitmap(input, resize(target)), timeout, (b) =>
          b.close(),
        );
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
        this.#jobs.delete(key);
        this.#pump();
      }
    })();
  }
}
