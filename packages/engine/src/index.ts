/**
 * Drawpane's render engine (decision 0040), from TypeScript: typed results around the
 * WebAssembly modules, and the display list's wire format (`wire.ts`).
 *
 * Two builds of one Rust crate (`rust/`):
 * - **browser**: the GPU backend (vello_gpu on WebGPU) and the CPU backend;
 * - **worker**: the CPU backend alone, for Workers.
 *
 * Nothing here throws for an engine failure: every call answers a `Result`. A WebAssembly trap
 * (which validation and the fuzz tests exist to prevent) marks the engine dead and answers
 * `ErrorCode.Trap` from then on; make a fresh engine.
 */
import type * as Glue from "./glue";

export * from "./wire";

/** The engine's error codes (`rust/src/error.rs`), and two of TypeScript's own. */
export enum ErrorCode {
  Malformed = 1,
  Version = 2,
  Revision = 3,
  Limit = 4,
  Unsupported = 5,
  Unknown = 6,
  Gpu = 7,
  DeviceLost = 8,
  NoAdapter = 9,
  Image = 10,
  State = 11,
  /** The WebAssembly instance trapped: it's gone. */
  Trap = 100,
  /** This build or browser can't do it (no WebGPU, or the worker build asked for a GPU). */
  NotAvailable = 101,
}

export type Result<T = undefined> =
  | ({ readonly ok: true } & (T extends undefined ? unknown : { readonly value: T }))
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

export type Failure = Extract<Result, { ok: false }>;

export interface FrameStats {
  readonly records: number;
  readonly culled: number;
  readonly glyphsMasked: number;
  readonly glyphsOutlined: number;
  readonly maskHits: number;
  readonly maskMisses: number;
  readonly maskBytes: number;
}

export interface Camera {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
  readonly dpr: number;
}

export interface Applied {
  /** Where the changed records painted before and paint now, page units: x0, y0, x1, y1 each. */
  readonly changes: Float64Array;
  /** Everything changed (a fresh list). */
  readonly full: boolean;
}

export interface GpuInfo {
  readonly adapter: string;
  /** A software adapter (SwiftShader, llvmpipe): timings say nothing about a GPU. */
  readonly fallback: boolean;
}

/** The longest side the engine draws, and the largest export (2× of a 4,096 px frame). */
export const MAX_SIDE = 8192;
/** Rows a band export renders at once, at most. */
export const BAND_ROWS = 256;

/** Rows per band for a frame `width` wide: at most 2 MiB of rows, so an export's working set stays small. */
export function bandRows(width: number): number {
  return Math.max(16, Math.min(BAND_ROWS, Math.floor((2 << 20) / (Math.max(1, width) * 4))));
}

const fail = (code: ErrorCode, message: string): Failure => ({ ok: false, code, message });

function outcome(o: Glue.Outcome): Result {
  const r: Result = o.ok ? { ok: true } : fail(o.code as ErrorCode, o.message);
  o.free();
  return r;
}

function stats(o: Glue.Outcome): FrameStats {
  return {
    records: o.records,
    culled: o.culled,
    glyphsMasked: o.glyphs_masked,
    glyphsOutlined: o.glyphs_outlined,
    maskHits: o.mask_hits,
    maskMisses: o.mask_misses,
    maskBytes: o.mask_bytes,
  };
}

const bg = (c: readonly [number, number, number, number]) => new Float32Array(c);

export interface EngineOptions {
  /** Bytes of rasterised glyph masks to keep per backend (default 16 MiB). */
  readonly glyphMaskBytes?: number;
  /** Bytes of image pixels to keep (default 256 MiB). */
  readonly imageBytes?: number;
}

/** One loaded build of the engine's module. */
export interface EngineModule {
  readonly glue: typeof Glue;
  readonly build: "browser" | "worker";
  /** Bytes of WebAssembly memory now: it only grows, so after a render it's the peak. */
  memoryBytes(): number;
}

/** An engine: a render graph patched by display lists, drawn on the CPU or the GPU. */
export class RenderEngine {
  readonly #module: EngineModule;
  #engine: Glue.Engine | null;
  #gpu: GpuInfo | null = null;
  #dead: Failure | null = null;

  constructor(module: EngineModule, options: EngineOptions = {}) {
    this.#module = module;
    this.#engine = new module.glue.Engine(options.glyphMaskBytes ?? 0, options.imageBytes ?? 0);
  }

  get build(): "browser" | "worker" {
    return this.#module.build;
  }

  get gpu(): GpuInfo | null {
    return this.#gpu;
  }

  /** The revision the engine holds: a patch must be made for it. */
  get revision(): number {
    return this.#engine?.revision ?? 0;
  }

  get records(): number {
    return this.#engine?.records ?? 0;
  }

  get glyphs(): { count: number; bytes: number } {
    return { count: this.#engine?.glyphs ?? 0, bytes: this.#engine?.glyphBytes ?? 0 };
  }

  /** Whether the instance trapped (or was disposed): every call fails from then on. */
  get dead(): boolean {
    return this.#dead !== null;
  }

  #call<T>(fn: (e: Glue.Engine) => T): T | Failure {
    if (this.#dead) return this.#dead;
    const e = this.#engine;
    if (!e) return fail(ErrorCode.State, "the engine was disposed");
    try {
      return fn(e);
    } catch (err) {
      // A trap (`RuntimeError: unreachable`) leaves the instance unusable.
      this.#dead = fail(ErrorCode.Trap, `the engine trapped: ${String(err)}`);
      this.#engine = null;
      return this.#dead;
    }
  }

  /** Applies a display-list message, all or nothing. */
  apply(bytes: Uint8Array): Result<Applied> {
    const r = this.#call((e) => {
      const o = e.apply(bytes);
      const value = { changes: o.dirty, full: o.full };
      const res = outcome(o);
      return res.ok ? { ok: true as const, value } : res;
    });
    return r as Result<Applied>;
  }

  /** Where pixels may have changed on the device since the last apply, readers included. */
  dirty(camera: Camera): Float64Array {
    const r = this.#call((e) => e.dirtyFor(camera.zoom, camera.x, camera.y, camera.dpr));
    return r instanceof Float64Array ? r : new Float64Array();
  }

  /** A record's children in paint order, as the engine holds them (tests, debugging). */
  children(id: number): number[] {
    const r = this.#call((e) => e.children(id));
    return r instanceof Uint32Array ? [...r] : [];
  }

  /** Records the builder flagged as needing what the engine doesn't draw: [id, bits] pairs. */
  unsupported(): Array<[number, number]> {
    const r = this.#call((e) => e.unsupported());
    if (!(r instanceof Uint32Array)) return [];
    const out: Array<[number, number]> = [];
    for (let i = 0; i + 1 < r.length; i += 2) out.push([r[i] as number, r[i + 1] as number]);
    return out;
  }

  putImage(
    id: number,
    width: number,
    height: number,
    rgba: Uint8Array,
    premultiplied = false,
  ): Result {
    return this.#call((e) => outcome(e.putImage(id, width, height, rgba, premultiplied))) as Result;
  }

  dropImage(id: number): void {
    this.#call((e) => e.dropImage(id));
  }

  /** Draws a frame on the CPU: straight RGBA8. */
  renderCpu(
    width: number,
    height: number,
    camera: Camera,
    background: readonly [number, number, number, number],
    detail = true,
  ): Result<{ pixels: Uint8Array; stats: FrameStats }> {
    return this.#call((e) => {
      const o = e.renderCpu(
        width,
        height,
        camera.zoom,
        camera.x,
        camera.y,
        camera.dpr,
        bg(background),
        detail,
      );
      const s = stats(o);
      const r = outcome(o);
      return r.ok ? { ok: true as const, value: { pixels: e.pixels(), stats: s } } : r;
    }) as Result<{ pixels: Uint8Array; stats: FrameStats }>;
  }

  /**
   * Draws a large frame band by band on the CPU, in bounded memory (the band, never the frame):
   * `onBand` gets each band's rows, straight RGBA8. Frames over `MAX_SIDE` are refused.
   */
  renderBands(
    width: number,
    height: number,
    camera: Camera,
    background: readonly [number, number, number, number],
    onBand: (y0: number, rows: number, pixels: Uint8Array) => void,
    rows = bandRows(width),
  ): Result {
    for (let y0 = 0; y0 < height; y0 += rows) {
      const n = Math.min(rows, height - y0);
      const r = this.#call((e) => {
        const res = outcome(
          e.renderBand(
            width,
            height,
            camera.zoom,
            camera.x,
            camera.y,
            camera.dpr,
            bg(background),
            y0,
            n,
          ),
        );
        if (res.ok) onBand(y0, n, e.pixels());
        return res;
      }) as Result;
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  /** A PNG of a large frame, rendered and compressed band by band: its chunks, in order. */
  renderPng(
    width: number,
    height: number,
    camera: Camera,
    background: readonly [number, number, number, number],
    onChunk: (bytes: Uint8Array) => void,
    rows = bandRows(width),
  ): Result {
    return this.#call((e) => {
      const begun = outcome(e.pngBegin(width, height));
      if (!begun.ok) return begun;
      for (let y0 = 0; y0 < height; y0 += rows) {
        const n = Math.min(rows, height - y0);
        const r = outcome(
          e.pngBand(camera.zoom, camera.x, camera.y, camera.dpr, bg(background), n),
        );
        if (!r.ok) {
          e.pngEnd();
          return r;
        }
        const chunk = e.pngTake();
        if (chunk.length > 0) onChunk(chunk);
      }
      onChunk(e.pngEnd());
      return { ok: true as const };
    }) as Result;
  }

  /**
   * A PNG of a large frame as a stream: each band is rendered and compressed when the reader
   * asks for more, so neither the picture nor the compressed file is held whole (a Worker
   * returns it as a response body). A failure errors the stream with the engine's message.
   */
  renderPngStream(
    width: number,
    height: number,
    camera: Camera,
    background: readonly [number, number, number, number],
    rows = bandRows(width),
  ): Result<ReadableStream<Uint8Array>> {
    const begun = this.#call((e) => outcome(e.pngBegin(width, height))) as Result;
    if (!begun.ok) return begun;
    let y0 = 0;
    const stream = new ReadableStream<Uint8Array>({
      // Each pull draws bands until there are bytes to hand on (the compressor holds small
      // outputs back): a pull that enqueues nothing isn't always called again.
      pull: (controller) => {
        for (;;) {
          if (y0 >= height) {
            const last = this.#call((e) => e.pngEnd());
            if (last instanceof Uint8Array) controller.enqueue(last);
            controller.close();
            return;
          }
          const n = Math.min(rows, height - y0);
          const r = this.#call((e) => {
            const res = outcome(
              e.pngBand(camera.zoom, camera.x, camera.y, camera.dpr, bg(background), n),
            );
            return res.ok ? { ok: true as const, value: e.pngTake() } : res;
          }) as Result<Uint8Array>;
          if (!r.ok) {
            this.#call((e) => e.pngEnd());
            controller.error(new Error(r.message));
            return;
          }
          y0 += n;
          if (r.value.length > 0) {
            controller.enqueue(r.value);
            return;
          }
        }
      },
    });
    return { ok: true, value: stream };
  }

  /**
   * Attaches a WebGPU device drawing into `canvas` (or into nothing: frames are only read
   * back). In compatibility mode the adapter is asked for WebGPU's compatibility feature level
   * (`featureLevel: "compatibility"`), which drivers without core WebGPU still offer.
   */
  async attachGpu(
    canvas: HTMLCanvasElement | OffscreenCanvas | null,
    options: { compatibility?: boolean; glyphMaskBytes?: number } = {},
  ): Promise<Result<GpuInfo>> {
    if (this.#module.build !== "browser" || !this.#module.glue.hasGpu())
      return fail(ErrorCode.NotAvailable, "this build of the engine has no GPU backend");
    const gpu =
      typeof navigator !== "undefined"
        ? (navigator as Navigator & { gpu?: GPULike }).gpu
        : undefined;
    if (!gpu) return fail(ErrorCode.NotAvailable, "this browser has no WebGPU");
    let init: Glue.GpuInit;
    try {
      init = await withFeatureLevel(gpu, options.compatibility ? "compatibility" : null, () =>
        this.#module.glue.createGpu(canvas, options.glyphMaskBytes ?? 0),
      );
    } catch (err) {
      return fail(ErrorCode.NoAdapter, String(err));
    }
    if (!init.ok) {
      const r = fail(init.code as ErrorCode, init.message);
      init.free();
      return r;
    }
    const info = { adapter: init.adapter, fallback: init.fallback };
    const attached = this.#call((e) =>
      e.attachGpu ? outcome(e.attachGpu(init)) : fail(ErrorCode.NotAvailable, "no GPU backend"),
    ) as Result;
    init.free();
    if (!attached.ok) return attached;
    this.#gpu = info;
    return { ok: true, value: info };
  }

  detachGpu(): void {
    this.#gpu = null;
    this.#call((e) => e.detachGpu?.());
  }

  /** Draws a frame on the GPU (into its canvas, if it has one). The GPU may still be drawing. */
  renderGpu(
    width: number,
    height: number,
    camera: Camera,
    background: readonly [number, number, number, number],
    detail = true,
  ): Result<FrameStats> {
    return this.#call((e) => {
      if (!e.renderGpu) return fail(ErrorCode.NotAvailable, "no GPU backend");
      const o = e.renderGpu(
        width,
        height,
        camera.zoom,
        camera.x,
        camera.y,
        camera.dpr,
        bg(background),
        detail,
      );
      const s = stats(o);
      const r = outcome(o);
      return r.ok ? { ok: true as const, value: s } : r;
    }) as Result<FrameStats>;
  }

  /** The GPU's health: an error recorded since the last frame, or the device's loss. */
  gpuCheck(): Result {
    return this.#call((e) =>
      e.gpuCheck ? outcome(e.gpuCheck()) : fail(ErrorCode.NotAvailable, "no GPU"),
    ) as Result;
  }

  /** Destroys the GPU device, as a driver reset loses it: for testing the fallback. */
  loseGpu(): void {
    this.#call((e) => e.gpuDestroy?.());
  }

  /** Resolves when the GPU has finished what it was given (how the bench times GPU work). */
  async gpuFinished(): Promise<void> {
    const p = this.#call((e) => e.gpuFinished?.());
    if (p instanceof Promise) await p;
  }

  /** The last GPU frame, straight RGBA8, read back through a buffer (not the canvas). */
  async gpuPixels(): Promise<Result<Uint8Array>> {
    const p = this.#call((e) => e.gpuPixels?.());
    if (!(p instanceof Promise)) return fail(ErrorCode.NotAvailable, "no GPU");
    try {
      return { ok: true, value: await p };
    } catch (err) {
      return fail(ErrorCode.Gpu, String(err));
    }
  }

  dispose(): void {
    this.#engine?.free();
    this.#engine = null;
    this.#dead = fail(ErrorCode.State, "the engine was disposed");
  }
}

interface GPULike {
  requestAdapter(options?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Runs `fn` with `navigator.gpu.requestAdapter` asking for `level` (wgpu 30 can't say
 * `featureLevel` itself), then puts it back.
 */
async function withFeatureLevel<T>(
  gpu: GPULike,
  level: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!level) return fn();
  const original = gpu.requestAdapter;
  gpu.requestAdapter = (options?: Record<string, unknown>) =>
    original.call(gpu, { ...options, featureLevel: level });
  try {
    return await fn();
  } finally {
    gpu.requestAdapter = original;
  }
}

/** Loads the browser build (GPU and CPU). Vite bundles its glue and WebAssembly. */
export async function loadBrowserEngine(): Promise<EngineModule> {
  const glue = (await import("@drawpane/engine/browser-glue")) as typeof Glue;
  await glue.default();
  return { glue, build: "browser", memoryBytes: () => glue.memoryBytes() };
}

/** Loads a build from its glue and WebAssembly bytes or module (Node, Workers, tests). */
export function loadEngineSync(
  glue: typeof Glue,
  wasm: BufferSource | WebAssembly.Module,
  build: "browser" | "worker",
): EngineModule {
  glue.initSync({ module: wasm });
  return { glue, build, memoryBytes: () => glue.memoryBytes() };
}
