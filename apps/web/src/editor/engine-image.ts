import type { ImageCache, ImageDemand, Size } from "@drawpane/editor";
import type { RenderEngine } from "@drawpane/engine";
import { sniffImage } from "@drawpane/model";

const MIB = 1024 * 1024;
const MAX_DECODES = 3;
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
  upload(handle: number, bitmap: ImageBitmap): boolean | Promise<boolean>;
  drop(handle: number, width: number): void;
}

const bytes = ({ width, height }: Size) => width * height * 4;
const keyOf = ({ handle, width }: Target) => `${handle}/${width}`;

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

async function naturalSize(blob: Blob): Promise<Size> {
  // JPEG and WebP may carry EXIF orientation. Use the browser's oriented size.
  const header = sniffImage(new Uint8Array(await blob.slice(0, 32).arrayBuffer()));
  if (header?.mime === "image/gif" || header?.mime === "image/png") return header;
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/** One view's bounded set of image levels. The sources can be decoded again after eviction. */
export class ViewImages {
  readonly #sources = new Map<string, Source>();
  readonly #residents = new Map<string, Resident>();
  readonly #jobs = new Map<string, AbortController>();
  readonly #retryAt = new Map<string, { at: number; attempts: number }>();
  readonly #denied = new Set<string>();
  #targets = new Map<string, Target>();
  #metadata = new Map<string, boolean>();
  #backend: ImageBackend | null = null;
  #budget = 0;
  #waiting = false;
  #inflightBytes = 0;
  #residentBytes = 0;
  #clock = 0;
  #nextHandle = 1;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly cache: ImageCache,
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

  get waiting(): boolean {
    return this.#waiting;
  }

  setBackend(backend: ImageBackend | null): void {
    this.evict();
    this.#backend = backend;
  }

  /** Releases pixel memory and cancels work which could bring it back while hidden. */
  evict(): void {
    for (const job of this.#jobs.values()) job.abort();
    for (const key of this.#residents.keys()) this.#drop(key);
    this.#targets.clear();
    this.#metadata.clear();
    this.#denied.clear();
    this.#waiting = false;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  retain(used: ReadonlySet<string>): void {
    for (const ref of this.#sources.keys()) if (!used.has(ref)) this.#sources.delete(ref);
    for (const ref of this.#retryAt.keys()) if (!used.has(ref)) this.#retryAt.delete(ref);
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
    const maxSide = Math.min(MAX_BITMAP_SIDE, limits.side);
    const candidates = new Map<string, Target>();
    const metadata = new Map<string, boolean>();
    const required = new Set<string>();
    const add = (target: Target) => {
      const key = keyOf(target);
      const previous = candidates.get(key);
      if (!previous || target.priority < previous.priority) candidates.set(key, target);
      return key;
    };
    const clock = ++this.#clock;
    for (const { ref, visible, span } of demands) {
      const source = this.#sources.get(ref);
      if (!source) {
        metadata.set(ref, visible || Boolean(metadata.get(ref)));
        continue;
      }
      source.used = clock;
      if (!(span > 0)) continue;
      const pyramid = levels(source.info, maxSide);
      const neededWidth = span * scale;
      const index = pyramid.findLastIndex((level) => level.width >= neededWidth);
      const current = Math.max(0, index);
      const size = pyramid[current];
      if (!size) continue;
      const handle = source.info.handle;
      const key = add({ ...size, ref, handle, priority: visible ? 0 : 2 });
      if (visible) required.add(key);
      const finer = pyramid[current - 1];
      if (finer && visible) add({ ...finer, ref, handle, priority: zoomingIn ? 1 : 3 });
    }

    const targets = new Map<string, Target>();
    const visibleTargets = [...required].flatMap((key) => {
      const target = candidates.get(key);
      return target ? [target] : [];
    });
    let planned = visibleTargets.reduce((sum, target) => sum + bytes(target), 0);
    const exact =
      planned <= budget &&
      ![...metadata.values()].includes(true) &&
      [...required].every((key) => this.#residents.has(key));

    // Make space for every visible image. Shrink the largest level first so a
    // single enormous cropped image can't starve the remaining photographs.
    while (planned > budget) {
      let largest = -1;
      let largestBytes = 0;
      let replacement: Target | undefined;
      for (let i = 0; i < visibleTargets.length; i++) {
        const target = visibleTargets[i];
        if (!target || bytes(target) <= largestBytes) continue;
        const source = this.#sources.get(target.ref);
        const smaller =
          source && levels(source.info, maxSide).find((level) => level.width < target.width);
        if (smaller) {
          largest = i;
          largestBytes = bytes(target);
          replacement = { ...target, ...smaller };
        }
      }
      if (largest < 0 || !replacement) break;
      planned -= largestBytes - bytes(replacement);
      visibleTargets[largest] = replacement;
    }
    planned = 0;
    const priority = [
      ...visibleTargets,
      ...[...candidates.values()]
        .filter((target) => target.priority > 0)
        .sort((a, b) => a.priority - b.priority),
    ];
    for (const target of priority) {
      const key = keyOf(target);
      if (targets.has(key) || planned + bytes(target) > budget) continue;
      targets.set(key, target);
      planned += bytes(target);
      const resident = this.#residents.get(key);
      if (resident) resident.used = clock;
    }

    if (
      budget !== this.#budget ||
      targets.size !== this.#targets.size ||
      [...targets.keys()].some((key) => !this.#targets.has(key))
    )
      this.#denied.clear();
    this.#waiting =
      [...metadata].some(([ref, visible]) => visible && !this.#retryAt.has(ref)) ||
      [...required].some(
        (key) => targets.has(key) && !this.#residents.has(key) && !this.#denied.has(key),
      );
    this.#budget = budget;
    this.#targets = targets;
    this.#metadata = metadata;
    for (const [key, job] of this.#jobs) {
      if (key.startsWith("source:") ? !metadata.has(key.slice(7)) : !targets.has(key)) job.abort();
    }
    this.#pump();
    return exact;
  }

  #drop(key: string): void {
    const resident = this.#residents.get(key);
    if (!resident) return;
    this.#residents.delete(key);
    this.#residentBytes -= bytes(resident);
    this.#backend?.drop(resident.handle, resident.width);
  }

  #makeRoom(need: number): boolean {
    if (this.#residentBytes + this.#inflightBytes + need <= this.#budget) return true;
    const evictable = [...this.#residents.entries()]
      .filter(([key]) => !this.#targets.has(key))
      .sort(([, a], [, b]) => a.used - b.used);
    for (const [key] of evictable) {
      if (this.#residentBytes + this.#inflightBytes + need <= this.#budget) break;
      this.#drop(key);
    }
    return this.#residentBytes + this.#inflightBytes + need <= this.#budget;
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
    if (!this.#backend || this.#jobs.size >= MAX_DECODES) return;
    const ordered = [...this.#targets.values()].sort((a, b) => a.priority - b.priority);
    for (const target of ordered) {
      const key = keyOf(target);
      if (this.#residents.has(key) || this.#jobs.has(key) || this.#denied.has(key)) continue;
      if (!this.#makeRoom(bytes(target))) continue;
      this.#requestLevel(key, target, this.#backend);
      if (this.#jobs.size >= MAX_DECODES) return;
    }
    for (const [ref, visible] of this.#metadata) {
      if (visible) this.#requestMetadata(ref);
      if (this.#jobs.size >= MAX_DECODES) return;
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
      try {
        const { blob, size } = await this.cache.encoded(ref, abort.signal);
        const dimensions = size ?? (await naturalSize(blob));
        if (abort.signal.aborted) return;
        this.#sources.set(ref, {
          info: { ...dimensions, handle: this.#nextHandle++ },
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
          this.#retryAt.set(ref, { at: Date.now() + delay, attempts });
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
      try {
        const source = this.#sources.get(target.ref);
        if (!source) return;
        const blob = source.blob ?? (await this.cache.encoded(target.ref, abort.signal)).blob;
        if (abort.signal.aborted) return;
        source.blob = blob;
        this.#trimSources();
        bitmap = await createImageBitmap(blob, {
          resizeWidth: target.width,
          resizeHeight: target.height,
          resizeQuality: "high",
          premultiplyAlpha: "premultiply",
        });
        if (abort.signal.aborted) return;
        const uploaded = await backend.upload(target.handle, bitmap);
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
          this.#denied.add(key);
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
