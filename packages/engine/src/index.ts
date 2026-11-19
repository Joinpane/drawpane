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

/** An engine failure where a stream must throw (a PNG stream's error): it keeps the code. */
export class EngineFailure extends Error {
  readonly code: ErrorCode;
  constructor(failure: Failure) {
    super(failure.message);
    this.name = "EngineFailure";
    this.code = failure.code;
  }
}

export interface FrameStats {
  readonly records: number;
  readonly culled: number;
  readonly glyphsMasked: number;
  readonly glyphsOutlined: number;
  readonly maskHits: number;
  readonly maskMisses: number;
  readonly maskBytes: number;
  /** Records drawn coarse (unreadable text as bars) and skipped as specks. */
  readonly coarse: number;
  readonly specks: number;
  /** Made from the last frame (a pan shifted, a zoom scaled): a stand-in until an exact frame. */
  readonly standin: boolean;
  /** No stand-ins and no level of detail: the frame is what an export would draw. */
  readonly exact: boolean;
  /** The frame reached the canvas (false: the canvas couldn't take it now; show another). */
  readonly presented: boolean;
  /** How a GPU frame was made. */
  readonly plan: "whole" | "pan" | "zoom" | "unchanged";
  /** Where a GPU frame's CPU time went, in milliseconds (see `rust/src/gpu.rs`). */
  readonly ms: {
    /** The walk and Vello's strips. */
    readonly encode: number;
    /** The renderer's preparing and uploading. */
    readonly render: number;
    /** Presenting and submitting. */
    readonly submit: number;
    readonly total: number;
  };
}

const PLANS = ["whole", "pan", "zoom", "unchanged"] as const;

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
/** Bytes of output a band holds at once, at most. */
export const BAND_BYTES = 2 << 20;

/** Rows per band for a frame `width` wide: at most 2 MiB of rows, so an export's working set stays small. */
export function bandRows(width: number): number {
  return Math.max(1, Math.min(BAND_ROWS, Math.floor(BAND_BYTES / (Math.max(1, width) * 4))));
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
    coarse: o.coarse,
    specks: o.specks,
    standin: o.standin,
    exact: !o.standin && o.coarse === 0 && o.specks === 0,
    presented: o.presented,
    plan: PLANS[o.plan] ?? "whole",
    ms: { encode: o.encode_ms, render: o.render_ms, submit: o.submit_ms, total: o.cpu_ms },
  };
}

const bg = (c: readonly [number, number, number, number]) => new Float32Array(c);

export interface EngineOptions {
  /** Bytes of rasterised glyph masks to keep per backend (default 4 MiB). */
  readonly glyphMaskBytes?: number;
  /** Bytes of image pixels to keep (default 256 MiB; 6 MiB in the Worker build). */
  readonly imageBytes?: number;
  /** Bytes the render graph may hold, roughly (default 1 GiB; 10 MiB in the Worker build). */
  readonly graphBytes?: number;
  /** Bytes of one display-list message (default 512 MiB; 8 MiB in the Worker build). */
  readonly messageBytes?: number;
  /** Bytes of glyph outlines (default 64 MiB; 4 MiB in the Worker build). */
  readonly glyphOutlineBytes?: number;
  /** Bytes the whole engine may hold, for admitting an export (0: no check; 25 MiB in the Worker build). */
  readonly memoryBytes?: number;
  /** Bytes of GPU memory the engine allocates (default 768 MiB). */
  readonly gpuBytes?: number;
}

/**
 * The Worker build's budgets, inside its 25 MiB of linear memory (decision 0040, "Worker
 * memory"; the module's memory section holds the maximum): a message is copied in whole, and an
 * export's working set (a 2 MiB band, a tile, the compressor) is admitted beside what's held.
 */
export const WORKER_LIMITS: Required<Omit<EngineOptions, "gpuBytes" | "glyphMaskBytes">> = {
  memoryBytes: 25 << 20,
  graphBytes: 10 << 20,
  messageBytes: 8 << 20,
  imageBytes: 6 << 20,
  glyphOutlineBytes: 4 << 20,
};

const LIMIT_NAMES: Record<keyof EngineOptions, string> = {
  glyphMaskBytes: "glyph_mask_bytes",
  imageBytes: "image_bytes",
  graphBytes: "graph_bytes",
  messageBytes: "message_bytes",
  glyphOutlineBytes: "glyph_outline_bytes",
  memoryBytes: "memory_bytes",
  gpuBytes: "gpu_bytes",
};

/** One loaded build of the engine's module. */
export interface EngineModule {
  readonly glue: typeof Glue;
  readonly build: "browser" | "worker";
  /** Bytes of WebAssembly memory now: it only grows, so after a render it's the peak. */
  memoryBytes(): number;
  /** An instance trapped: engines made from here on get a new one (see `RenderEngine`). */
  trapped?: boolean;
}

/** An engine: a render graph patched by display lists, drawn on the CPU or the GPU. */
export class RenderEngine {
  readonly #module: EngineModule;
  #engine: Glue.Engine | null = null;
  #gpu: GpuInfo | null = null;
  #dead: Failure | null = null;

  /**
   * An engine on `module`. If an engine on it trapped, the module's instance is renewed first
   * (its memory is gone with it: every engine on the old instance is dead).
   */
  constructor(module: EngineModule, options: EngineOptions = {}) {
    this.#module = module;
    try {
      if (module.trapped) {
        module.glue.__drawpaneRenew();
        module.trapped = false;
      }
      const engine = new module.glue.Engine(0, 0);
      this.#engine = engine;
      const limits: EngineOptions = {
        ...(module.build === "worker" ? WORKER_LIMITS : {}),
        ...options,
      };
      for (const [key, value] of Object.entries(limits) as Array<[keyof EngineOptions, number]>) {
        if (value === undefined) continue;
        const r = outcome(engine.setLimit(LIMIT_NAMES[key], value));
        if (!r.ok) throw new Error(r.message);
      }
    } catch (err) {
      this.#trapped(err);
    }
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

  /** Bytes the engine holds, roughly: its graph, images and glyph masks. */
  get heldBytes(): number {
    return this.#engine?.heldBytes ?? 0;
  }

  /** Whether the instance trapped (or was disposed): every call fails from then on. */
  get dead(): boolean {
    return this.#dead !== null;
  }

  /** Why the engine is dead, if it is. */
  get failure(): Failure | null {
    return this.#dead;
  }

  #trapped(err: unknown): Failure {
    // A trap (`RuntimeError: unreachable`, or memory that can't grow) leaves the instance
    // unusable. Its objects are let go without calling into it, never freed into a new one.
    try {
      this.#engine?.__destroy_into_raw();
    } catch {}
    this.#engine = null;
    this.#module.trapped = true;
    this.#dead = fail(ErrorCode.Trap, `the engine trapped: ${String(err)}`);
    return this.#dead;
  }

  #call<T>(fn: (e: Glue.Engine) => T): T | Failure {
    if (this.#dead) return this.#dead;
    const e = this.#engine;
    if (!e) return fail(ErrorCode.State, "the engine was disposed");
    try {
      return fn(e);
    } catch (err) {
      return this.#trapped(err);
    }
  }

  /** Applies a display-list message, all or nothing. Refused while an export streams. */
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
  dirty(camera: Camera): Result<Float64Array> {
    return this.#value(() =>
      this.#call((e) => e.dirtyFor(camera.zoom, camera.x, camera.y, camera.dpr)),
    );
  }

  /** A record's children in paint order, as the engine holds them (tests, debugging). */
  children(id: number): Result<number[]> {
    return this.#value(() => this.#call((e) => [...e.children(id)]));
  }

  /** Records the builder flagged as needing what the engine doesn't draw: [id, bits] pairs. */
  unsupported(): Result<Array<[number, number]>> {
    return this.#value(() =>
      this.#call((e) => {
        const r = e.unsupported();
        const out: Array<[number, number]> = [];
        for (let i = 0; i + 1 < r.length; i += 2) out.push([r[i] as number, r[i + 1] as number]);
        return out;
      }),
    );
  }

  /** A value or the failure that stopped it, as a Result. */
  #value<T>(get: () => T | Failure): Result<T> {
    const v = get();
    if (isFailure(v)) return v;
    return { ok: true, value: v } as Result<T>;
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

  /** Lets an image's pixels go (refused while an export streams). */
  dropImage(id: number): Result {
    return this.#call((e) => outcome(e.dropImage(id))) as Result;
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

  /** Rows a band of a frame `width` wide may have: at most 2 MiB of output. */
  bandRows(width: number): number {
    const r = this.#call((e) => e.bandRows(width));
    return typeof r === "number" ? r : bandRows(width);
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
    rows = Math.max(1, Math.min(rows, this.bandRows(width)));
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
        return res.ok ? { ok: true as const, value: e.pixels() } : res;
      }) as Result<Uint8Array>;
      if (!r.ok) return r;
      onBand(y0, n, r.value);
    }
    return { ok: true };
  }

  /**
   * A PNG of a large frame, rendered and compressed band by band: its chunks, in order. The
   * engine is pinned to one revision while it's made (patches are refused meanwhile).
   */
  renderPng(
    width: number,
    height: number,
    camera: Camera,
    background: readonly [number, number, number, number],
    onChunk: (bytes: Uint8Array) => void,
    rows = bandRows(width),
  ): Result {
    const begun = this.#begin(width, height, camera);
    if (!begun.ok) return begun;
    rows = Math.max(1, Math.min(rows, this.bandRows(width)));
    try {
      for (let y0 = 0; y0 < height; y0 += rows) {
        const n = Math.min(rows, height - y0);
        const r = this.#band(camera, background, n);
        if (!r.ok) return r;
        if (r.value.length > 0) onChunk(r.value);
      }
      const last = this.#call((e) => e.pngEnd());
      if (isFailure(last)) return last;
      onChunk(last);
      return { ok: true };
    } finally {
      this.#call((e) => e.pngAbort());
    }
  }

  #begin(width: number, height: number, camera: Camera): Result {
    return this.#call((e) =>
      outcome(e.pngBegin(width, height, camera.zoom, camera.x, camera.y, camera.dpr)),
    ) as Result;
  }

  #band(
    camera: Camera,
    background: readonly [number, number, number, number],
    rows: number,
  ): Result<Uint8Array> {
    return this.#call((e) => {
      const res = outcome(
        e.pngBand(camera.zoom, camera.x, camera.y, camera.dpr, bg(background), rows),
      );
      return res.ok ? { ok: true as const, value: e.pngTake() } : res;
    }) as Result<Uint8Array>;
  }

  /**
   * A PNG of a large frame as a stream: each band is rendered and compressed when the reader
   * asks for more, so neither the picture nor the compressed file is held whole (a Worker
   * returns it as a response body).
   *
   * - Refused before any byte (a typed failure) when the page holds a layer the engine doesn't
   *   draw, the frame is too large, another export is streaming, or it wouldn't fit the
   *   engine's memory budget.
   * - Pinned to one revision: until the stream ends, errors or is cancelled, the engine refuses
   *   patches and image changes (`ErrorCode.State`).
   * - A failure after it starts errors the stream with an `EngineFailure`, which keeps the code.
   * - `onEnd` is called once, however it ends (done, failed, cancelled), to let the engine go.
   */
  renderPngStream(
    width: number,
    height: number,
    camera: Camera,
    background: readonly [number, number, number, number],
    rows = bandRows(width),
    onEnd: () => void = () => {},
  ): Result<ReadableStream<Uint8Array>> {
    const begun = this.#begin(width, height, camera);
    if (!begun.ok) return begun;
    rows = Math.max(1, Math.min(rows, this.bandRows(width)));
    let y0 = 0;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.#call((e) => e.pngAbort());
      onEnd();
    };
    const stream = new ReadableStream<Uint8Array>({
      // Each pull draws bands until there are bytes to hand on (the compressor holds small
      // outputs back): a pull that enqueues nothing isn't always called again.
      pull: (controller) => {
        try {
          for (;;) {
            if (y0 >= height) {
              const last = this.#call((e) => e.pngEnd());
              if (isFailure(last)) throw new EngineFailure(last);
              if (last.length > 0) controller.enqueue(last);
              end();
              controller.close();
              return;
            }
            const n = Math.min(rows, height - y0);
            const r = this.#band(camera, background, n);
            if (!r.ok) throw new EngineFailure(r);
            y0 += n;
            if (r.value.length > 0) {
              controller.enqueue(r.value);
              return;
            }
          }
        } catch (err) {
          end();
          controller.error(
            err instanceof EngineFailure
              ? err
              : new EngineFailure(fail(ErrorCode.State, String(err))),
          );
        }
      },
      cancel: () => end(),
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
  async gpuFinished(): Promise<Result> {
    const p = this.#call((e) => e.gpuFinished?.());
    if (isFailure(p)) return p;
    if (!(p instanceof Promise)) return fail(ErrorCode.NotAvailable, "no GPU");
    try {
      await p;
      return { ok: true };
    } catch (err) {
      return fail(ErrorCode.Gpu, String(err));
    }
  }

  /** The last GPU frame, straight RGBA8, read back through a buffer (not the canvas). */
  async gpuPixels(): Promise<Result<Uint8Array>> {
    const p = this.#call((e) => e.gpuPixels?.());
    if (isFailure(p)) return p;
    if (!(p instanceof Promise)) return fail(ErrorCode.NotAvailable, "no GPU");
    let v: Uint8Array | Glue.Outcome;
    try {
      v = await p;
    } catch (err) {
      return this.#trapped(err);
    }
    if (v instanceof Uint8Array) return { ok: true, value: v };
    return outcome(v) as Result<Uint8Array>;
  }

  dispose(): void {
    try {
      this.#engine?.free();
    } catch (err) {
      this.#trapped(err);
    }
    this.#engine = null;
    this.#dead ??= fail(ErrorCode.State, "the engine was disposed");
  }
}

function isFailure(v: unknown): v is Failure {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { ok?: unknown }).ok === false &&
    typeof (v as { code?: unknown }).code === "number"
  );
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
