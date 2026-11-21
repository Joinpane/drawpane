import type { ImageCache, ImageDemand, Size } from "@drawpane/editor";
import type { RenderEngine } from "@drawpane/engine";
import { sniffImage } from "@drawpane/model";

const MIB = 1024 * 1024;
const MAX_DECODES = 4;
const PREFETCH_LEVELS = 2;
const UPLOAD_SLICE_BYTES = 12 * MIB;
const REQUEST_TIMEOUT_MS = 8000;
const SOURCE_BUDGET = 64 * MIB;
const MAX_BITMAP_SIDE = 4096;
export const CPU_IMAGE_BUDGET = 64 * MIB;
export const CPU_IMAGE_SIDE = MAX_BITMAP_SIDE;

export function deviceImageBudget(max: number): number {
  const memory = (globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined)
    ?.deviceMemory;
  const bytes = memory && memory > 0 ? Math.max(16, memory * 32) * MIB : 128 * MIB;
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
  used: number;
}

interface Target extends Size {
  readonly ref: string;
  readonly handle: number;
  readonly priority: number;
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

function fits(level: Size, needed: Size): boolean {
  return level.width >= needed.width && level.height >= needed.height;
}

function levels(size: Size, maxSide: number): Size[] {
  const fit = Math.min(1, maxSide / Math.max(size.width, size.height));
  let width = Math.max(1, Math.floor(size.width * fit));
  let height = Math.max(1, Math.floor(size.height * fit));
  const out = [{ width, height }];
  while (width >= 2 && height >= 2 && Math.max(width, height) >= 64) {
    width = Math.floor(width / 2);
    height = Math.floor(height / 2);
    out.push({ width, height });
  }
  return out;
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
  readonly #jobs = new Map<string, AbortController>();
  readonly #retryAt = new Map<string, { at: number; attempts: number; version: number }>();
  readonly #denied = new Set<string>();
  readonly #failed = new Map<string, number>();
  readonly #protected = new Set<string>();
  #visible = new Set<string>();
  #targets = new Map<string, Target>();
  #metadata = new Map<string, boolean>();
  #backend: ImageBackend | null = null;
  #budget = 0;
  #reduced = 0;
  #uploadedThisFrame = 0;
  #uploadFrame: Promise<void> | undefined;
  #inflightBytes = 0;
  #residentBytes = 0;
  #clock = 0;
  #nextHandle = 1;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly cache: Pick<ImageCache, "encoded" | "encodedVersion">,
    private readonly metadataReady: (ref: string) => void,
    private readonly changed: () => void,
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
  evict(): void {
    for (const job of this.#jobs.values()) job.abort();
    for (const key of this.#residents.keys()) this.#drop(key);
    this.#targets.clear();
    this.#metadata.clear();
    this.#visible.clear();
    this.#protected.clear();
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  retain(used: ReadonlySet<string>): void {
    for (const ref of this.#sources.keys()) if (!used.has(ref)) this.#sources.delete(ref);
    for (const [key, level] of this.#residents) if (!used.has(level.ref)) this.#drop(key);
  }

  update(
    demands: Iterable<ImageDemand>,
    scale: number,
    zoomingIn: boolean,
    limits: { side: number; bytes: number },
  ): boolean {
    if (!this.#backend) return true;
    const budget = deviceImageBudget(limits.bytes);
    if (budget !== this.#budget) this.#denied.clear();
    const maxSide = Math.min(MAX_BITMAP_SIDE, limits.side);
    const candidates = new Map<string, Target>();
    const metadata = new Map<string, boolean>();
    const ideal = new Map<string, Target>();
    const pyramids = new Map<string, Size[]>();
    const visible = new Set<string>();
    const reduced = new Set<string>();
    const clock = ++this.#clock;

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
      const needed = { width: span.width * scale, height: span.height * scale };
      const current = Math.max(
        0,
        pyramid.findLastIndex((level) => fits(level, needed)),
      );
      const handle = source.info.handle;
      const size = pyramid[current];
      if (!size) continue;
      const wanted = { ...size, ref, handle, priority: onScreen ? 0 : 3 };
      if (onScreen) ideal.set(keyOf(wanted), wanted);
      const available = pyramid
        .slice(current)
        .find((level) => !this.#denied.has(keyOf({ ...wanted, ...level })));
      if (available) {
        const target = { ...wanted, ...available };
        const key = keyOf(target);
        const previous = candidates.get(key);
        if (!previous || target.priority < previous.priority) candidates.set(key, target);
      }
      if (onScreen) {
        for (let ahead = 1; ahead <= PREFETCH_LEVELS; ahead++) {
          const finer = pyramid[current - ahead];
          if (!finer) break;
          const target = { ...finer, ref, handle, priority: zoomingIn ? ahead : 3 + ahead };
          const key = keyOf(target);
          if (!candidates.has(key) && !this.#denied.has(key)) candidates.set(key, target);
        }
      }
    }

    const targets = new Map<string, Target>();
    const primary = [...candidates.values()].filter((target) => target.priority === 0);
    let planned = primary.reduce((sum, target) => sum + bytes(target), 0);
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
      planned -= largestBytes;
      if (primary.some((other, i) => i !== largest && keyOf(other) === keyOf(replacement))) {
        primary.splice(largest, 1);
      } else {
        planned += bytes(replacement);
        primary[largest] = replacement;
      }
    }

    planned = 0;
    const ordered = [
      ...primary,
      ...[...candidates.values()]
        .filter((target) => target.priority > 0)
        .sort((a, b) => a.priority - b.priority),
    ];
    for (const target of ordered) {
      const key = keyOf(target);
      if (targets.has(key) || planned + bytes(target) > budget) continue;
      targets.set(key, target);
      planned += bytes(target);
      const resident = this.#residents.get(key);
      if (resident) resident.used = clock;
    }

    this.#budget = budget;
    this.#targets = targets;
    this.#metadata = metadata;
    this.#visible = visible;
    for (const [key, job] of this.#jobs) {
      if (key.startsWith("source:") ? !metadata.has(key.slice(7)) : !targets.has(key)) job.abort();
    }
    this.#pump();

    // An in-flight improvement makes a frame provisional. Failed or unaffordable
    // detail is a settled reduction at the current budget, even with a placeholder.
    const pending = new Set<string>();
    for (const [ref, onScreen] of metadata) {
      if (onScreen && !this.#retryAt.has(ref)) pending.add(ref);
    }
    for (const target of targets.values()) {
      const key = keyOf(target);
      if (
        target.priority === 0 &&
        !this.#residents.has(key) &&
        (this.#jobs.has(key) || this.#canMakeRoom(target))
      )
        pending.add(target.ref);
    }
    const sharp = new Map<string, Resident>();
    for (const resident of this.#residents.values()) {
      const previous = sharp.get(resident.ref);
      if (!previous || previous.width < resident.width) sharp.set(resident.ref, resident);
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
    const represented = new Set<string>();
    for (const [key, target] of this.#targets) {
      if (target.priority === 0 && this.#residents.has(key)) {
        this.#protected.add(key);
        represented.add(target.ref);
      }
    }
    for (const [key, resident] of this.#residents) {
      if (this.#visible.has(resident.ref) && !represented.has(resident.ref)) {
        this.#protected.add(key);
        represented.add(resident.ref);
      }
    }
  }

  #evictable(target: Target): [string, Resident][] {
    return [...this.#residents].filter(
      ([key]) =>
        !this.#protected.has(key) &&
        (this.#targets.get(key)?.priority ?? Infinity) > target.priority,
    );
  }

  #canMakeRoom(target: Target): boolean {
    // In-flight reservations eventually become residents or go away.
    // Count only the residents that this target must preserve.
    const need = this.#residentBytes + bytes(target) - this.#budget;
    return (
      need <= 0 || this.#evictable(target).reduce((sum, [, level]) => sum + bytes(level), 0) >= need
    );
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

  #makeRoom(target: Target): boolean {
    const need = bytes(target);
    if (this.#residentBytes + this.#inflightBytes + need <= this.#budget) return true;
    const evictable = this.#evictable(target);
    const available = this.#budget - this.#residentBytes - this.#inflightBytes;
    if (available + evictable.reduce((sum, [, level]) => sum + bytes(level), 0) < need)
      return false;
    evictable.sort(([, a], [, b]) => a.used - b.used);
    for (const [key] of evictable) {
      if (this.#residentBytes + this.#inflightBytes + need <= this.#budget) break;
      this.#drop(key);
    }
    return this.#residentBytes + this.#inflightBytes + need <= this.#budget;
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

  #pump(): void {
    if (!this.#backend) return;
    this.#refreshProtection();
    if (this.#jobs.size >= MAX_DECODES) return;
    const ordered = [...this.#targets.values()].sort((a, b) => a.priority - b.priority);
    for (const target of ordered) {
      const key = keyOf(target);
      if (
        target.priority !== 0 ||
        this.#failed.get(target.ref) === this.cache.encodedVersion(target.ref)
      )
        continue;
      if (this.#residents.has(key) || this.#jobs.has(key) || this.#denied.has(key)) continue;
      if (!this.#canMakeRoom(target) || !this.#makeRoom(target)) continue;
      this.#requestLevel(key, target, this.#backend);
      if (this.#jobs.size >= MAX_DECODES) return;
    }
    for (const [ref, visible] of this.#metadata) {
      if (visible) this.#requestMetadata(ref);
      if (this.#jobs.size >= MAX_DECODES) return;
    }
    for (const target of ordered) {
      const key = keyOf(target);
      if (
        target.priority === 0 ||
        this.#jobs.size >= MAX_DECODES - 1 ||
        this.#failed.get(target.ref) === this.cache.encodedVersion(target.ref)
      )
        continue;
      if (this.#residents.has(key) || this.#jobs.has(key) || this.#denied.has(key)) continue;
      if (!this.#canMakeRoom(target) || !this.#makeRoom(target)) continue;
      this.#requestLevel(key, target, this.#backend);
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
    this.#jobs.set(key, abort);
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

  #requestLevel(key: string, target: Target, backend: ImageBackend): void {
    const abort = new AbortController();
    this.#jobs.set(key, abort);
    const need = bytes(target);
    this.#inflightBytes += need;
    void (async () => {
      let bitmap: ImageBitmap | undefined;
      const version = this.cache.encodedVersion(target.ref);
      try {
        const source = this.#sources.get(target.ref);
        if (!source) return;
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
        const blob =
          source.blob ?? (await untilAborted(this.cache.encoded(target.ref, signal), signal)).blob;
        if (abort.signal.aborted) return;
        source.blob = blob;
        this.#trimSources();
        bitmap = await untilAborted(
          createImageBitmap(blob, {
            resizeWidth: target.width,
            resizeHeight: target.height,
            resizeQuality: "high",
            premultiplyAlpha: "premultiply",
          }),
          signal,
          (bitmap) => bitmap.close(),
        );
        await this.#paceUpload(need, abort.signal);
        if (abort.signal.aborted) return;
        let uploaded = await backend.upload(target.handle, bitmap);
        if (!uploaded && !abort.signal.aborted && backend === this.#backend) {
          const reclaimed = this.releasePressure();
          if (reclaimed && backend.retryUpload) {
            await this.#paceUpload(need, abort.signal);
            if (!abort.signal.aborted) uploaded = await backend.upload(target.handle, bitmap);
          }
        }
        if (abort.signal.aborted || backend !== this.#backend) {
          if (uploaded) backend.drop(target.handle, target.width);
          return;
        }
        if (!uploaded) {
          this.#denied.add(key);
          this.changed();
          return;
        }
        this.#residents.set(key, { ...target, used: this.#clock });
        this.#residentBytes += need;
        this.changed();
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
