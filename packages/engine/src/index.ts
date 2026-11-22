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
import { MAJOR, MINOR } from "./wire";

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
  /** A call made in the wrong state (rendering on a backend that isn't attached). */
  State = 11,
  /** A bounded GPU wait (startup probe, read-back, or fence) expired on a live context. */
  Timeout = 12,
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
  readonly reads: number;
  readonly maskHits: number;
  readonly maskMisses: number;
  readonly maskBytes: number;
  /** Records drawn coarse (unreadable text as bars) and skipped as specks. */
  readonly coarse: number;
  readonly specks: number;
  /**
   * Something on screen stands in for what isn't drawn yet (a stale tile, another level scaled,
   * the last frame moved, unreadable text as bars): not exact.
   */
  readonly standin: boolean;
  /** No stand-ins and no level of detail: the frame is what a fresh engine (or an export) draws. */
  readonly exact: boolean;
  /** The frame reached the canvas (false: the canvas couldn't take it now; show another). */
  readonly presented: boolean;
  /**
   * How a GPU frame was made (decision 0040, phase 2): from its own tiles, all there; with
   * stand-ins under tiles not drawn yet; drawn tile by tile straight into the frame (its tiles
   * don't fit the budget); or unchanged.
   */
  readonly plan: "tiles" | "standin" | "direct" | "unchanged" | "reader-halo";
  /**
   * GPU tiles: drawn this frame, still stale or missing on screen, still to draw round the view
   * (ahead of a pan: idle frames may draw them), held, evicted for room.
   */
  readonly tiles: {
    readonly drawn: number;
    readonly pending: number;
    readonly queued: number;
    readonly held: number;
    readonly evicted: number;
    /**
     * Composited by a drag (decision 0040, "Dragging"): the page below the dragged layers, the
     * layers drawn afresh, the page above. Exact but for rounding, reported as a stand-in.
     */
    readonly dragged: number;
  };
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

const PLANS = ["tiles", "standin", "direct", "unchanged", "reader-halo"] as const;

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
  /** Which GPU backend this device runs on ("webgpu" or "webgl2"). */
  readonly backend: "webgpu" | "webgl2";
  /** JSON adapter metadata (vendor, device, driver, features, limits) for diagnostics. */
  readonly details: string;
  /** A software adapter (SwiftShader, llvmpipe): timings say nothing about a GPU. */
  readonly fallback: boolean;
}

export type BlurEdge =
  | { readonly kind: "zero" }
  | { readonly kind: "clamp" }
  | { readonly kind: "border"; readonly color: readonly [number, number, number, number] };

export interface BlurRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface BlurProbeOptions {
  /** Premultiplied RGBA8 source pixels. */
  readonly src: Uint8Array;
  readonly srcWidth: number;
  readonly srcHeight: number;
  readonly dstWidth?: number;
  readonly dstHeight?: number;
  readonly dstOriginX?: number;
  readonly dstOriginY?: number;
  readonly sigma: number;
  readonly edge?: BlurEdge;
  readonly clampBounds?: BlurRect;
  readonly dirty?: BlurRect;
  /** CPU only: force the full-resolution semantic reference above `DIRECT_SIGMA_MAX`. */
  readonly reference?: boolean;
  /** GPU only: non-zero shares/reuses a cached GPU blur pyramid across equal inputs. */
  readonly sourceId?: number;
}

export interface BlurCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evicted: number;
  readonly bytes: number;
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

/** A frame's numbers; `gpu`: a frame made of tiles, whose exactness the engine reports itself. */
function stats(o: Glue.Outcome, gpu = false): FrameStats {
  return {
    records: o.records,
    culled: o.culled,
    glyphsMasked: o.glyphs_masked,
    glyphsOutlined: o.glyphs_outlined,
    reads: o.reads,
    maskHits: o.mask_hits,
    maskMisses: o.mask_misses,
    maskBytes: o.mask_bytes,
    coarse: o.coarse,
    specks: o.specks,
    standin: o.standin,
    exact: gpu ? o.exact && !o.standin : !o.standin && o.coarse === 0 && o.specks === 0,
    presented: o.presented,
    plan: PLANS[o.plan] ?? "tiles",
    tiles: {
      drawn: o.tiles_drawn,
      pending: o.pending,
      queued: o.queued,
      held: o.held,
      evicted: o.evicted,
      dragged: o.dragged,
    },
    ms: { encode: o.encode_ms, render: o.render_ms, submit: o.submit_ms, total: o.cpu_ms },
  };
}

const bg = (c: readonly [number, number, number, number]) => new Float32Array(c);

/** What drawing ahead between frames did (`RenderEngine.renderGpuAhead`). */
export interface AheadStats {
  readonly drawn: number;
  /** Tiles the last frame shows still to draw. */
  readonly pending: number;
  /** Tiles round it still to draw. */
  readonly queued: number;
  readonly ms: number;
  readonly encodeMs: number;
  readonly renderMs: number;
  readonly maskMisses: number;
  readonly records: number;
  readonly glyphsMasked: number;
  readonly glyphsOutlined: number;
}

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
  /** Bytes of GPU tiles kept, within `gpuBytes` (default 256 MiB; decision 0040, phase 2). */
  readonly tileBytes?: number;
}

/**
 * The Worker build's budgets, inside its 25 MiB of linear memory (decision 0040, "Worker
 * memory"; the module's memory section holds the maximum): a message is copied in whole, and an
 * export's working set (a 2 MiB band, a tile, the compressor) is admitted beside what's held.
 */
export const WORKER_LIMITS: Required<
  Omit<EngineOptions, "gpuBytes" | "glyphMaskBytes" | "tileBytes">
> = {
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
  tileBytes: "tile_bytes",
};

export type EngineBuild = "browser" | "webgl" | "worker";

/** One loaded build of the engine's module. */
export interface EngineModule {
  readonly glue: typeof Glue;
  readonly build: EngineBuild;
  /** Bytes of WebAssembly memory now: it only grows, so after a render it's the peak. */
  memoryBytes(): number;
  /** An instance trapped: engines made from here on get a new one (see `RenderEngine`). */
  trapped?: boolean;
  /**
   * Which instance is current: bumped when one traps. An engine made on an earlier one is dead
   * (its memory went with the instance), and never calls into or frees in a later one.
   */
  epoch?: number;
}

/** Bytes an image's levels take (`rust/src/images.rs`, `levels_bytes`), worked out up front. */
export function imageLevelsBytes(width: number, height: number): number {
  let [w, h, total] = [Math.floor(width), Math.floor(height), 0];
  for (;;) {
    total += w * h * 4;
    if (Math.floor(Math.max(w, h) / 2) < 32 || w < 2 || h < 2) return total;
    w = Math.floor(w / 2);
    h = Math.floor(h / 2);
  }
}

/** The next smaller mip level, with the same floor as the engine's image pyramid. */
export function smallerImageLevel(width: number, height: number) {
  const w = Math.max(1, Math.floor(width / 2));
  const h = Math.max(1, Math.floor(height / 2));
  return Math.max(w, h) >= 32 && (w < width || h < height) ? { width: w, height: h } : null;
}

interface GlueState {
  epoch: number;
  trapped: boolean;
  /** Immutable glue instance for the current generation (never overwritten in place on renewal). */
  activeGlue: typeof Glue;
  /** Compiled WebAssembly.Module cached from initial load for Worker-safe renewal. */
  compiledModule?: WebAssembly.Module;
  /** Resolves immediately when the current generation traps so pending async waits settle as Trap. */
  trapNotice: Promise<void>;
  fireTrap: () => void;
}

function makeTrapSignal(): { trapNotice: Promise<void>; fireTrap: () => void } {
  let fireTrap!: () => void;
  const trapNotice = new Promise<void>((resolve) => {
    fireTrap = resolve;
  });
  return { trapNotice, fireTrap };
}

/**
 * Shared WASM instance state keyed by the underlying wasm-bindgen glue module.
 * Multiple `EngineModule` wrappers around the same glue share one instance and one linear memory,
 * so a trap or renewal on any wrapper advances the epoch for every sibling engine. Each renewed
 * generation gets its own isolated glue closure (`__drawpaneCreateGlue`) so stale async callbacks
 * from an older generation can never mutate or enter the new generation's Wasm memory.
 */
const GLUE_STATE = new WeakMap<object, GlueState>();

function glueState(glue: typeof Glue): GlueState {
  let state = GLUE_STATE.get(glue);
  if (!state) {
    const signal = makeTrapSignal();
    state = {
      epoch: 0,
      trapped: false,
      activeGlue: glue,
      trapNotice: signal.trapNotice,
      fireTrap: signal.fireTrap,
    };
    GLUE_STATE.set(glue, state);
  }
  return state;
}

function makeModule(glue: typeof Glue, build: EngineBuild): EngineModule {
  const state = glueState(glue);
  const compiled = glue.__drawpaneModule?.();
  if (compiled) state.compiledModule = compiled;
  return {
    glue,
    build,
    memoryBytes: () => (state.trapped ? 0 : state.activeGlue.memoryBytes()),
    get epoch(): number {
      return state.epoch;
    },
    set epoch(value: number) {
      state.epoch = value;
    },
    get trapped(): boolean {
      return state.trapped;
    },
    set trapped(value: boolean) {
      state.trapped = value;
    },
  };
}

/**
 * Lets a glue object go from wasm-bindgen's finalizer without freeing it: the facade frees what
 * it makes itself (`dispose`), so a finalizer can never free an old instance's pointer into a
 * renewed one after a trap.
 */
function unfinalized<T extends { __destroy_into_raw?: () => number }>(o: T): T {
  if (typeof o.__destroy_into_raw === "function") {
    const ptr = o.__destroy_into_raw();
    (o as unknown as { __wbg_ptr: number }).__wbg_ptr = ptr;
  }
  return o;
}

/** An engine: a render graph patched by display lists, drawn on the CPU or the GPU. */
export class RenderEngine {
  readonly #module: EngineModule;
  /** Immutable glue instance owning this engine's generation. */
  #glue: typeof Glue;
  #genTrapNotice: Promise<void>;
  #engine: Glue.Engine | null = null;
  #gpu: GpuInfo | null = null;
  #dead: Failure | null = null;
  /** The module's instance this engine lives in (`EngineModule.epoch`). */
  #epoch: number;
  /** The CPU's tiles were set up (`renderCpuTiled`). */
  #cpuTiles = false;

  /**
   * An engine on `module`. If an engine on it trapped, a fresh isolated Wasm instance is created
   * first (every engine on the old generation is dead and quiesced).
   */
  constructor(module: EngineModule, options: EngineOptions = {}) {
    this.#module = module;
    const state = glueState(module.glue);
    this.#glue = state.activeGlue;
    this.#genTrapNotice = state.trapNotice;
    this.#epoch = state.epoch;
    try {
      if (state.trapped) {
        if (typeof module.glue.__drawpaneCreateGlue === "function") {
          const compiled = state.compiledModule ?? state.activeGlue.__drawpaneModule?.();
          if (!compiled) throw new Error("the engine was never instantiated");
          const nextGlue = module.glue.__drawpaneCreateGlue();
          nextGlue.initSync({ module: compiled });
          state.compiledModule = compiled;
          state.activeGlue = nextGlue;
        } else {
          module.glue.__drawpaneRenew();
        }
        const nextSignal = makeTrapSignal();
        state.trapNotice = nextSignal.trapNotice;
        state.fireTrap = nextSignal.fireTrap;
        state.trapped = false;
        this.#glue = state.activeGlue;
        this.#genTrapNotice = state.trapNotice;
      }
      // Explicitly verify the paired Wasm module supports the wire version JS writes.
      if (typeof this.#glue.listVersion === "function") {
        const version = this.#glue.listVersion();
        const wasmMajor = version[0] ?? 0;
        const wasmMinor = version[1] ?? 0;
        if (wasmMajor !== MAJOR || wasmMinor < MINOR) {
          this.#dead = {
            ok: false,
            code: ErrorCode.Version,
            message: `Wasm module speaks display list ${wasmMajor}.${wasmMinor}; JS requires ${MAJOR}.${MINOR}`,
          };
          return;
        }
      }
      const engine = unfinalized(new this.#glue.Engine(0, 0));
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

  get build(): EngineBuild {
    return this.#module.build;
  }

  get gpu(): GpuInfo | null {
    return this.#gpu;
  }

  /** The revision the engine holds: a patch must be made for it. */
  get revision(): number {
    return this.#live()?.revision ?? 0;
  }

  get records(): number {
    return this.#live()?.records ?? 0;
  }

  /**
   * The drag in progress (decision 0040, "Dragging"), followed from the messages: one that only
   * moves the same records continues it. "composited": the page is drawn in parts around the
   * dragged layers; "drawn": they're drawn at their real position every frame (no fast path).
   */
  get dragging(): "none" | "drawn" | "composited" {
    return (["none", "drawn", "composited"] as const)[this.#live()?.dragging ?? 0] ?? "none";
  }

  get glyphs(): { count: number; bytes: number } {
    const e = this.#live();
    return { count: e?.glyphs ?? 0, bytes: e?.glyphBytes ?? 0 };
  }

  /** Bytes the engine holds, roughly: its graph, images and glyph masks. */
  get heldBytes(): number {
    return this.#live()?.heldBytes ?? 0;
  }

  /** Allocated Wasm pages, including freed space retained by the allocator. */
  get memoryBytes(): number {
    return this.#module.memoryBytes();
  }

  /** Updates the render budget before applying a display list. */
  setMemoryBudget(bytes: number): Result {
    return this.#call((e) => outcome(e.setLimit("memory_bytes", bytes))) as Result;
  }

  /** Whether the instance trapped (or was disposed): every call fails from then on. */
  get dead(): boolean {
    this.#live();
    return this.#dead !== null;
  }

  /**
   * The engine's object, if it's alive: not disposed, not trapped, and in the module's current
   * instance. One whose instance went (another engine on the module trapped) is marked dead and
   * let go without a call into the instance that replaced it.
   */
  #live(): Glue.Engine | null {
    if (this.#dead) return null;
    if (this.#epoch !== glueState(this.#module.glue).epoch) {
      this.#engine = null;
      this.#gpu = null;
      this.#dead = fail(
        ErrorCode.Trap,
        "another engine on this module trapped: the instance this engine lived in is gone",
      );
      return null;
    }
    return this.#engine;
  }

  /** Why the engine is dead, if it is. */
  get failure(): Failure | null {
    this.#live();
    return this.#dead;
  }

  #trapped(err: unknown): Failure {
    // A trap (`RuntimeError: unreachable`, or memory that can't grow) leaves the instance
    // unusable, and every engine in it with it: quiesce this generation's timers and closures,
    // advance the epoch, and wake pending async waits so none can enter Wasm again.
    this.#engine = null;
    this.#gpu = null;
    const state = glueState(this.#module.glue);
    if (this.#epoch === state.epoch) {
      this.#glue.__drawpaneQuiesce?.();
      state.trapped = true;
      state.epoch = this.#epoch + 1;
      state.fireTrap();
    }
    this.#dead = fail(ErrorCode.Trap, `the engine trapped: ${String(err)}`);
    return this.#dead;
  }

  #call<T>(fn: (e: Glue.Engine) => T): T | Failure {
    const e = this.#live();
    if (this.#dead) return this.#dead;
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
    return this.#call((e) => {
      // Refused before the bytes are copied into the engine's memory (in a Worker, an upload
      // past the budget would otherwise exhaust it while being copied).
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        rgba.length !== width * height * 4
      )
        return fail(ErrorCode.Image, "image bytes don't match its size");
      if (width > e.textureSide || height > e.textureSide)
        return fail(
          ErrorCode.Limit,
          `an image ${width} × ${height}; the longest side allowed is ${e.textureSide}`,
        );
      const need = imageLevelsBytes(width, height);
      if (e.imageBytes - e.imageHeld(id) + need > e.imageBudget)
        return fail(
          ErrorCode.Limit,
          `an image ${width} × ${height} takes ${Math.ceil(need / 2 ** 20)} MiB with its levels; images may hold ${Math.floor(e.imageBudget / 2 ** 20)} MiB`,
        );
      return outcome(e.putImage(id, width, height, rgba, premultiplied));
    }) as Result;
  }

  clearViewCaches(): void {
    this.#call((e) => e.clearViewCaches());
  }

  enableViewImages(): void {
    this.#call((e) => e.enableViewImages());
  }

  viewImageLimits(): Result<{ side: number; bytes: number }> {
    return this.#value(() =>
      this.#call((e) => {
        const [side = 0, bytes = 0] = e.viewImageLimits();
        return { side, bytes };
      }),
    );
  }

  putCpuImageLevel(id: number, width: number, height: number, rgba: Uint8Array): Result {
    return this.#call((e) => {
      if (rgba.length > e.imageBudget - e.imageBytes)
        return fail(ErrorCode.Limit, "images over their budget");
      return outcome(e.putCpuImageLevel(id, width, height, rgba));
    }) as Result;
  }

  putGpuImageLevel(id: number, bitmap: ImageBitmap): Result {
    return this.#call((e) =>
      e.putGpuImageLevel
        ? outcome(e.putGpuImageLevel(id, bitmap))
        : fail(ErrorCode.NotAvailable, "no GPU image upload"),
    ) as Result;
  }

  dropImageLevel(id: number, width: number): Result {
    return this.#call((e) => outcome(e.dropImageLevel(id, width))) as Result;
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

  /**
   * A frame made of tiles on the CPU (decision 0040, phase 2), as the GPU makes its frames:
   * what tests hold invalidation to (an exact one is bitwise a fresh engine's). `tile` and
   * `slots` set the CPU's tiles the first time (default 512 px, 256 slots); `maxJobs` bounds
   * the tiles drawn beyond those nothing else can stand in for.
   */
  renderCpuTiled(
    width: number,
    height: number,
    camera: Camera,
    background: readonly [number, number, number, number],
    options: { moving?: boolean; maxJobs?: number; tile?: number; slots?: number } = {},
  ): Result<{ pixels: Uint8Array; stats: FrameStats }> {
    return this.#call((e) => {
      if (options.tile !== undefined && !this.#cpuTiles) {
        e.useCpuTiles(options.tile, options.slots ?? 256);
        this.#cpuTiles = true;
      }
      const o = e.renderCpuTiled(
        width,
        height,
        camera.zoom,
        camera.x,
        camera.y,
        camera.dpr,
        bg(background),
        options.moving ?? false,
        options.maxJobs ?? 0xffffffff,
      );
      const s = stats(o, true);
      const r = outcome(o);
      return r.ok ? { ok: true as const, value: { pixels: e.pixels(), stats: s } } : r;
    }) as Result<{ pixels: Uint8Array; stats: FrameStats }>;
  }

  /** Rows a band of a frame `width` wide may have: at most 2 MiB of output. */
  bandRows(width: number): number {
    const r = this.#call((e) => e.bandRows(width));
    return typeof r === "number" ? r : bandRows(width);
  }

  /** Draws one whole-frame band (`y0 .. y0 + rows`) on the CPU: straight RGBA8. */
  renderBand(
    width: number,
    height: number,
    camera: Camera,
    background: readonly [number, number, number, number],
    y0: number,
    rows: number,
  ): Result<Uint8Array> {
    return this.#call((e) => {
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
          rows,
        ),
      );
      return res.ok ? { ok: true as const, value: e.pixels() } : res;
    }) as Result<Uint8Array>;
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
      const r = this.renderBand(width, height, camera, background, y0, n);
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
    const begun = this.#begin(width, height, camera, rows);
    if (!begun.ok) return begun;
    try {
      for (let y0 = 0; y0 < height; y0 += begun.value) {
        const r = this.#band(background);
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

  #begin(width: number, height: number, camera: Camera, rows: number): Result<number> {
    return this.#call((e) => {
      const res = outcome(
        e.pngBegin(width, height, camera.zoom, camera.x, camera.y, camera.dpr, rows),
      );
      return res.ok ? { ok: true, value: e.pngRows() } : res;
    }) as Result<number>;
  }

  /** Checks the PNG bounds and working set without opening a stream. */
  checkPng(width: number, height: number, camera: Camera, rows = bandRows(width)): Result {
    return this.#call((e) =>
      outcome(e.checkPng(width, height, camera.zoom, camera.x, camera.y, camera.dpr, rows)),
    ) as Result;
  }

  #band(background: readonly [number, number, number, number]): Result<Uint8Array> {
    return this.#call((e) => {
      const res = outcome(e.pngBand(bg(background)));
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
    beforeBand?: () => void | Promise<void>,
    signal?: AbortSignal,
  ): Result<ReadableStream<Uint8Array>> {
    const begun = this.#begin(width, height, camera, rows);
    if (!begun.ok) return begun;
    let y0 = 0;
    let ended = false;
    let unlisten: (() => void) | undefined;
    const end = () => {
      if (ended) return;
      ended = true;
      unlisten?.();
      this.#call((e) => e.pngAbort());
      onEnd();
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (!signal) return;
        const abort = () => {
          end();
          controller.error(signal.reason);
        };
        if (signal.aborted) abort();
        else {
          signal.addEventListener("abort", abort, { once: true });
          unlisten = () => signal.removeEventListener("abort", abort);
        }
      },
      // Each pull draws bands until there are bytes to hand on (the compressor holds small
      // outputs back): a pull that enqueues nothing isn't always called again.
      pull: async (controller) => {
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
            if (beforeBand) await beforeBand();
            if (ended) return;
            const r = this.#band(background);
            if (!r.ok) throw new EngineFailure(r);
            y0 += begun.value;
            if (r.value.length > 0) {
              controller.enqueue(r.value);
              return;
            }
          }
        } catch (err) {
          if (ended) return;
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
   * Attaches a GPU device (WebGPU on the `browser` build, WebGL2 on the `webgl` build) drawing
   * into `canvas` (or into nothing: frames are only read back). In WebGPU compatibility mode the
   * adapter is asked for `featureLevel: "compatibility"`, which drivers without core WebGPU still
   * offer.
   */
  async attachGpu(
    canvas: HTMLCanvasElement | OffscreenCanvas | null,
    options: { compatibility?: boolean; glyphMaskBytes?: number } = {},
  ): Promise<Result<GpuInfo>> {
    const liveBefore = this.#live();
    if (this.#dead) return this.#dead;
    if (!liveBefore) return fail(ErrorCode.State, "the engine was disposed");
    const glue = this.#glue;
    if ((this.#module.build !== "browser" && this.#module.build !== "webgl") || !glue.hasGpu())
      return fail(ErrorCode.NotAvailable, "this build of the engine has no GPU backend");
    const state = glueState(this.#module.glue);
    const startEpoch = this.#epoch;
    const genTrap = this.#genTrapNotice;
    const isWebgl = this.#module.build === "webgl" || glue.gpuBackend() === "webgl2";
    const awaitOrTrap = async (raw: Promise<Glue.GpuInit>): Promise<Glue.GpuInit | null> => {
      // Ensure any late-resolving stale GpuInit from a trapped generation is detached from its
      // FinalizationRegistry even if we already returned Trap via `genTrap`.
      raw.then(
        (stale) => {
          if (state.epoch !== startEpoch) unfinalized(stale);
        },
        () => {},
      );
      const settled = await Promise.race([
        raw.then((value) => ({ kind: "value" as const, value })),
        genTrap.then(() => ({ kind: "trapped" as const })),
      ]);
      return settled.kind === "value" ? settled.value : null;
    };
    let init: Glue.GpuInit | null;
    if (isWebgl) {
      if (typeof WebGL2RenderingContext === "undefined")
        return fail(ErrorCode.NotAvailable, "this browser has no WebGL2");
      try {
        init = await awaitOrTrap(glue.createGpu(canvas, options.glyphMaskBytes ?? 0));
      } catch (err) {
        if (err instanceof WebAssembly.RuntimeError || state.epoch !== startEpoch) {
          return this.#trapped(err);
        }
        return fail(ErrorCode.NoAdapter, String(err));
      }
    } else {
      const gpu =
        typeof navigator !== "undefined"
          ? (navigator as Navigator & { gpu?: GPULike }).gpu
          : undefined;
      if (!gpu) return fail(ErrorCode.NotAvailable, "this browser has no WebGPU");
      try {
        init = await withFeatureLevel(gpu, options.compatibility ? "compatibility" : null, () =>
          awaitOrTrap(glue.createGpu(canvas, options.glyphMaskBytes ?? 0)),
        );
      } catch (err) {
        if (err instanceof WebAssembly.RuntimeError || state.epoch !== startEpoch) {
          return this.#trapped(err);
        }
        return fail(ErrorCode.NoAdapter, String(err));
      }
    }
    // The instance may have trapped or renewed while `createGpu` was awaiting: `init` belongs to
    // the old instance, so detach its finalizer without reading or freeing it in the new one.
    if (state.epoch !== startEpoch || init === null) {
      if (init !== null) unfinalized(init);
      this.#live();
      return this.#dead ?? fail(ErrorCode.Trap, "the engine instance changed during GPU init");
    }
    if (!this.#live()) {
      try {
        init.free();
      } catch (err) {
        return this.#trapped(err);
      }
      return this.#dead ?? fail(ErrorCode.State, "the engine was disposed");
    }
    let ok: boolean;
    let code: number;
    let message: string;
    let info: GpuInfo | null = null;
    try {
      ok = init.ok;
      code = init.code;
      message = init.message;
      if (ok) {
        info = {
          adapter: init.adapter,
          backend: init.backend === "webgl2" ? "webgl2" : "webgpu",
          details: init.details,
          fallback: init.fallback,
        };
      }
    } catch (err) {
      unfinalized(init);
      return this.#trapped(err);
    }
    if (!ok || !info) {
      try {
        init.free();
      } catch (err) {
        return this.#trapped(err);
      }
      return fail(code as ErrorCode, message);
    }
    const attached = this.#call((e) =>
      e.attachGpu ? outcome(e.attachGpu(init)) : fail(ErrorCode.NotAvailable, "no GPU backend"),
    ) as Result;
    if (state.epoch === startEpoch) {
      try {
        init.free();
      } catch (err) {
        return this.#trapped(err);
      }
    } else {
      unfinalized(init);
    }
    if (!attached.ok) return attached;
    this.#gpu = info;
    return { ok: true, value: info };
  }

  detachGpu(): void {
    this.#gpu = null;
    this.#call((e) => e.detachGpu?.());
  }

  /**
   * Draws a frame on the GPU (into its canvas, if it has one), made of tiles the engine keeps
   * (decision 0040, phase 2). The GPU may still be drawing when it returns.
   *
   * - `moving`: the camera is moving. Tiles not drawn yet may show stand-ins (stale tiles,
   *   another level scaled, the last frame moved), and a zoom draws no tiles of a passing scale.
   * - `budgetMs`: milliseconds the frame may spend drawing tiles beyond those nothing else can
   *   stand in for. 0: no limit, so a frame at rest comes back exact.
   * - `editorViewport`: whole-view readers can sample page paint beyond the displayed viewport.
   *
   * While the answer isn't `exact`, draw again (at rest, a frame a time under a budget): each
   * draws more of what's missing, never in one long frame.
   */
  renderGpu(
    width: number,
    height: number,
    camera: Camera,
    background: readonly [number, number, number, number],
    moving = true,
    budgetMs = 0,
    editorViewport = false,
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
        moving,
        budgetMs,
        editorViewport,
      );
      const s = stats(o, true);
      const r = outcome(o);
      return r.ok ? { ok: true as const, value: s } : r;
    }) as Result<FrameStats>;
  }

  /**
   * Draws tiles for the next frame of the view last drawn, for at most `budgetMs` (at least one
   * tile; 0: no limit), compositing and presenting nothing (decision 0040, phase 2): what a page
   * runs between frames at rest, so the exact frame comes sooner without any one long frame.
   * `pending`: tiles the last frame shows still to draw; `queued`: tiles round it still to draw.
   */
  renderGpuAhead(
    background: readonly [number, number, number, number],
    budgetMs: number,
  ): Result<AheadStats> {
    return this.#call((e) => {
      if (!e.renderGpuAhead) return fail(ErrorCode.NotAvailable, "no GPU backend");
      const o = e.renderGpuAhead(bg(background), budgetMs);
      const value: AheadStats = {
        drawn: o.tiles_drawn,
        pending: o.pending,
        queued: o.queued,
        ms: o.cpu_ms,
        encodeMs: o.encode_ms,
        renderMs: o.render_ms,
        maskMisses: o.mask_misses,
        records: o.records,
        glyphsMasked: o.glyphs_masked,
        glyphsOutlined: o.glyphs_outlined,
      };
      const r = outcome(o);
      return r.ok ? { ok: true as const, value } : r;
    }) as Result<AheadStats>;
  }

  /** Drops every GPU tile (benches time cold frames this way). */
  clearTiles(): void {
    this.#call((e) => e.clearTiles?.());
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
    const startEpoch = this.#epoch;
    const state = glueState(this.#module.glue);
    const genTrap = this.#genTrapNotice;
    const p = this.#call((e) => e.gpuFinished?.());
    if (isFailure(p)) return p;
    if (!(p instanceof Promise)) return fail(ErrorCode.NotAvailable, "no GPU");
    p.then(
      (stale) => {
        if (state.epoch !== startEpoch && stale !== undefined) unfinalized(stale);
      },
      () => {},
    );
    let v: Glue.Outcome | undefined;
    try {
      const settled = await Promise.race([
        p.then((value) => ({ kind: "value" as const, value })),
        genTrap.then(() => ({ kind: "trapped" as const })),
      ]);
      if (settled.kind === "trapped") {
        this.#live();
        return this.#dead ?? fail(ErrorCode.Trap, "the engine instance changed during gpuFinished");
      }
      v = settled.value;
    } catch (err) {
      if (err instanceof WebAssembly.RuntimeError || state.epoch !== startEpoch) {
        return this.#trapped(err);
      }
      return fail(ErrorCode.Gpu, String(err));
    }
    if (state.epoch !== startEpoch) {
      if (v !== undefined) unfinalized(v);
      this.#live();
      return this.#dead ?? fail(ErrorCode.Trap, "the engine instance changed during gpuFinished");
    }
    if (!this.#live()) {
      if (v !== undefined) {
        try {
          v.free();
        } catch (err) {
          return this.#trapped(err);
        }
      }
      return this.#dead ?? fail(ErrorCode.State, "the engine was disposed");
    }
    if (v !== undefined) return outcome(v);
    return { ok: true };
  }

  /** The last GPU frame, straight RGBA8, read back through a buffer (not the canvas). */
  async gpuPixels(): Promise<Result<Uint8Array>> {
    const startEpoch = this.#epoch;
    const state = glueState(this.#module.glue);
    const genTrap = this.#genTrapNotice;
    const p = this.#call((e) => e.gpuPixels?.());
    if (isFailure(p)) return p;
    if (!(p instanceof Promise)) return fail(ErrorCode.NotAvailable, "no GPU");
    p.then(
      (stale) => {
        if (state.epoch !== startEpoch && !(stale instanceof Uint8Array)) unfinalized(stale);
      },
      () => {},
    );
    let v: Uint8Array | Glue.Outcome;
    try {
      const settled = await Promise.race([
        p.then((value) => ({ kind: "value" as const, value })),
        genTrap.then(() => ({ kind: "trapped" as const })),
      ]);
      if (settled.kind === "trapped") {
        this.#live();
        return this.#dead ?? fail(ErrorCode.Trap, "the engine instance changed during gpuPixels");
      }
      v = settled.value;
    } catch (err) {
      return this.#trapped(err);
    }
    // The instance may have gone while it was on its way (another engine trapped): an object
    // it answered belongs to the old instance, so it's let go without freeing into the new one.
    if (state.epoch !== startEpoch) {
      if (!(v instanceof Uint8Array)) unfinalized(v);
      this.#live();
      return this.#dead ?? fail(ErrorCode.Trap, "the engine instance changed during gpuPixels");
    }
    if (!this.#live()) {
      if (!(v instanceof Uint8Array)) {
        try {
          v.free();
        } catch (err) {
          return this.#trapped(err);
        }
      }
      return this.#dead ?? fail(ErrorCode.State, "the engine was disposed");
    }
    if (v instanceof Uint8Array) return { ok: true, value: v };
    return outcome(v) as Result<Uint8Array>;
  }

  /** Runs the reference Gaussian blur on the CPU (premultiplied RGBA8, for conformance tests). */
  blurCpu(options: BlurProbeOptions): Result<Uint8Array> {
    const a = blurArgs(options);
    return this.#call((e) => {
      const res = outcome(
        e.blurCpu(
          options.src,
          options.srcWidth,
          options.srcHeight,
          a.dstW,
          a.dstH,
          a.dstOx,
          a.dstOy,
          options.sigma,
          a.edgeMode,
          a.border,
          a.cb.x0,
          a.cb.y0,
          a.cb.x1,
          a.cb.y1,
          a.dirty.x0,
          a.dirty.y0,
          a.dirty.x1,
          a.dirty.y1,
          options.reference ?? false,
        ),
      );
      return res.ok ? { ok: true as const, value: e.pixels() } : res;
    }) as Result<Uint8Array>;
  }

  /** Runs the GPU Gaussian blur pass (premultiplied RGBA8, for CPU-vs-GPU conformance tests). */
  async blurGpu(options: BlurProbeOptions): Promise<Result<Uint8Array>> {
    const a = blurArgs(options);
    const p = this.#call((e) =>
      e.blurGpu?.(
        options.src,
        options.srcWidth,
        options.srcHeight,
        a.dstW,
        a.dstH,
        a.dstOx,
        a.dstOy,
        options.sigma,
        a.edgeMode,
        a.border,
        a.cb.x0,
        a.cb.y0,
        a.cb.x1,
        a.cb.y1,
        a.dirty.x0,
        a.dirty.y0,
        a.dirty.x1,
        a.dirty.y1,
        options.sourceId ?? 0,
      ),
    );
    if (isFailure(p)) return p;
    if (!(p instanceof Promise)) return fail(ErrorCode.NotAvailable, "no GPU");
    let v: Uint8Array | Glue.Outcome;
    try {
      v = await p;
    } catch (err) {
      return this.#trapped(err);
    }
    if (!this.#live()) {
      if (!(v instanceof Uint8Array)) unfinalized(v);
      return this.#dead ?? fail(ErrorCode.State, "the engine was disposed");
    }
    if (v instanceof Uint8Array) return { ok: true, value: v };
    return outcome(v) as Result<Uint8Array>;
  }

  /** GPU blur pyramid cache statistics. */
  blurGpuStats(): Result<BlurCacheStats> {
    return this.#value(() =>
      this.#call((e) => {
        if (!e.blurGpuStats) return fail(ErrorCode.NotAvailable, "no GPU");
        const s = e.blurGpuStats();
        return {
          hits: s[0] ?? 0,
          misses: s[1] ?? 0,
          evicted: s[2] ?? 0,
          bytes: s[3] ?? 0,
        };
      }),
    );
  }

  /** Frees the engine's memory (nothing, if its instance is gone). */
  dispose(): void {
    const e = this.#live();
    try {
      e?.free();
    } catch (err) {
      this.#trapped(err);
    }
    this.#engine = null;
    this.#dead ??= fail(ErrorCode.State, "the engine was disposed");
  }
}

function blurArgs(o: BlurProbeOptions) {
  const dstW = o.dstWidth ?? o.srcWidth;
  const dstH = o.dstHeight ?? o.srcHeight;
  const dstOx = o.dstOriginX ?? 0;
  const dstOy = o.dstOriginY ?? 0;
  const cb: BlurRect = o.clampBounds ?? { x0: 0, y0: 0, x1: o.srcWidth, y1: o.srcHeight };
  const dirty: BlurRect = o.dirty ?? { x0: dstOx, y0: dstOy, x1: dstOx + dstW, y1: dstOy + dstH };
  const edge = o.edge ?? { kind: "zero" };
  const edgeMode = edge.kind === "clamp" ? 1 : edge.kind === "border" ? 2 : 0;
  const border =
    edge.kind === "border" ? new Float32Array(edge.color) : new Float32Array([0, 0, 0, 0]);
  return { dstW, dstH, dstOx, dstOy, cb, dirty, edgeMode, border };
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

const GPU_ADAPTER_QUEUE = new WeakMap<GPULike, Promise<void>>();

/**
 * Serializes only the brief `navigator.gpu.requestAdapter` call window per `GPU` object so
 * `featureLevel: "compatibility"` never leaks to concurrent core attaches or later callers,
 * and restores `requestAdapter` immediately once invoked (never waiting for device/probe).
 */
async function withFeatureLevel<T>(
  gpu: GPULike,
  level: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = GPU_ADAPTER_QUEUE.get(gpu) ?? Promise.resolve();
  let releaseSlot!: () => void;
  let released = false;
  const slot = new Promise<void>((resolve) => {
    releaseSlot = () => {
      if (released) return;
      released = true;
      resolve();
    };
  });
  GPU_ADAPTER_QUEUE.set(gpu, slot);
  await prev;

  const original = gpu.requestAdapter;
  const wrapped = (options?: Record<string, unknown>) => {
    if (gpu.requestAdapter === wrapped) gpu.requestAdapter = original;
    releaseSlot();
    return original.call(gpu, level ? { ...options, featureLevel: level } : options);
  };
  gpu.requestAdapter = wrapped;
  try {
    return await fn();
  } finally {
    if (gpu.requestAdapter === wrapped) gpu.requestAdapter = original;
    releaseSlot();
    if (GPU_ADAPTER_QUEUE.get(gpu) === slot) GPU_ADAPTER_QUEUE.delete(gpu);
  }
}

/** Initialises browser-hosted Wasm, then wraps the instance shared by its engines. */
export async function loadEngineAsync(
  glue: typeof Glue,
  build: EngineBuild,
): Promise<EngineModule> {
  const state = glueState(glue);
  if (state.epoch === 0) await glue.default();
  return makeModule(glue, build);
}

/** Loads a build from its glue and WebAssembly bytes or module (Node, Workers, tests). */
export function loadEngineSync(
  glue: typeof Glue,
  wasm: BufferSource | WebAssembly.Module,
  build: EngineBuild,
): EngineModule {
  const state = glueState(glue);
  if (state.epoch === 0) glue.initSync({ module: wasm });
  return makeModule(glue, build);
}
