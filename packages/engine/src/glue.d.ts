/**
 * The types of the WebAssembly modules' JavaScript glue, which wasm-bindgen writes into dist/
 * at build time (never committed). Declared here so the repo typechecks without building Rust.
 * Must match `rust/src/lib.rs`; `test/glue.test.ts` checks the built glue has every member.
 */

export class Outcome {
  free(): void;
  __destroy_into_raw(): number;
  readonly ok: boolean;
  readonly code: number;
  readonly message: string;
  readonly dirty: Float64Array;
  readonly full: boolean;
  readonly records: number;
  readonly culled: number;
  readonly glyphs_masked: number;
  readonly glyphs_outlined: number;
  readonly reads: number;
  readonly mask_hits: number;
  readonly mask_misses: number;
  readonly mask_bytes: number;
  readonly coarse: number;
  readonly specks: number;
  readonly presented: boolean;
  readonly standin: boolean;
  readonly plan: number;
  readonly exact: boolean;
  readonly tiles_drawn: number;
  readonly pending: number;
  readonly queued: number;
  readonly held: number;
  readonly dragged: number;
  readonly evicted: number;
  readonly encode_ms: number;
  readonly render_ms: number;
  readonly submit_ms: number;
  readonly cpu_ms: number;
  readonly prepare_masks_ms: number;
  readonly vello_render_ms: number;
  readonly reader_ms: number;
  readonly shadow_ms: number;
  readonly submits: number;
  readonly draws: number;
  readonly vello_renders: number;
  readonly glass_ops: number;
  readonly glass_batched: number;
  readonly bg_blur_ops: number;
  readonly shadow_ops: number;
  readonly shadow_hits: number;
  readonly in_progress: boolean;
}

export class GpuInit {
  free(): void;
  __destroy_into_raw(): number;
  readonly ok: boolean;
  readonly code: number;
  readonly message: string;
  readonly adapter: string;
  readonly backend: string;
  readonly details: string;
  readonly fallback: boolean;
}

export class Engine {
  constructor(glyphMaskBytes: number, imageBytes: number);
  free(): void;
  readonly revision: number;
  readonly records: number;
  readonly dragging: number;
  readonly glyphs: number;
  readonly glyphBytes: number;
  readonly heldBytes: number;
  readonly exporting_png: boolean;
  /** Detaches the object from its finalizer without freeing it (after a trap). */
  __destroy_into_raw(): number;
  setLimit(name: string, value: number): Outcome;
  readonly imageBytes: number;
  readonly imageBudget: number;
  readonly textureSide: number;
  imageHeld(id: number): number;
  bandRows(width: number): number;
  apply(bytes: Uint8Array): Outcome;
  dirtyFor(zoom: number, x: number, y: number, dpr: number): Float64Array;
  unsupported(): Uint32Array;
  children(id: number): Uint32Array;
  putImage(
    id: number,
    width: number,
    height: number,
    rgba: Uint8Array,
    premultiplied: boolean,
  ): Outcome;
  dropImage(id: number): Outcome;
  clearViewCaches(): void;
  enableViewImages(): void;
  viewImageLimits(): Uint32Array;
  putCpuImageLevel(id: number, width: number, height: number, rgba: Uint8Array): Outcome;
  putGpuImageLevel?(id: number, bitmap: ImageBitmap): Outcome;
  dropImageLevel(id: number, width: number): Outcome;
  renderCpu(
    width: number,
    height: number,
    zoom: number,
    x: number,
    y: number,
    dpr: number,
    background: Float32Array,
    detail: boolean,
  ): Outcome;
  useCpuTiles(tile: number, slots: number): void;
  renderCpuTiled(
    width: number,
    height: number,
    zoom: number,
    x: number,
    y: number,
    dpr: number,
    background: Float32Array,
    moving: boolean,
    maxJobs: number,
  ): Outcome;
  pixels(): Uint8Array;
  renderBand(
    width: number,
    height: number,
    zoom: number,
    x: number,
    y: number,
    dpr: number,
    background: Float32Array,
    y0: number,
    rows: number,
  ): Outcome;
  pngBegin(
    width: number,
    height: number,
    zoom: number,
    x: number,
    y: number,
    dpr: number,
    rows: number,
  ): Outcome;
  pngRows(): number;
  checkPng(
    width: number,
    height: number,
    zoom: number,
    x: number,
    y: number,
    dpr: number,
    rows: number,
  ): Outcome;
  pngBand(background: Float32Array): Outcome;
  pngTake(): Uint8Array;
  pngEnd(): Uint8Array;
  pngAbort(): void;
  strokeCacheStats(): Float64Array;
  setComputeOrdinary?(enabled: boolean): Outcome;
  stageComputeFrame?(
    width: number,
    height: number,
    zoom: number,
    x: number,
    y: number,
    dpr: number,
    background: Float32Array,
  ): Promise<void> | undefined;
  finishComputeFrame?(finalAttempt: boolean): Outcome | undefined;
  presentComputeFrame?(
    width: number,
    height: number,
    zoom: number,
    x: number,
    y: number,
    dpr: number,
    background: Float32Array,
  ): Outcome | number | undefined;
  takeComputeGateCheck?(): Promise<void> | undefined;
  finishComputeGate?(): number;
  cancelComputeFrame?(): void;
  computeFallbackReason?(): string | undefined;
  computeTight?(tight: boolean): Outcome;
  computeUsed?(): boolean;
  computeResetStats?(): void;
  computeStats?(): string;
  blurCpu(
    src: Uint8Array,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
    dstOx: number,
    dstOy: number,
    sigma: number,
    edgeMode: number,
    border: Float32Array,
    clampX0: number,
    clampY0: number,
    clampX1: number,
    clampY1: number,
    dirtyX0: number,
    dirtyY0: number,
    dirtyX1: number,
    dirtyY1: number,
    reference: boolean,
  ): Outcome;
  // The browser build only:
  attachGpu?(init: GpuInit): Outcome;
  detachGpu?(): void;
  renderGpu?(
    width: number,
    height: number,
    zoom: number,
    x: number,
    y: number,
    dpr: number,
    background: Float32Array,
    moving: boolean,
    budgetMs: number,
    editorViewport?: boolean,
  ): Outcome;
  renderGpuAhead?(background: Float32Array, budgetMs: number): Outcome;
  clearTiles?(): void;
  gpuCounters?(): Uint32Array;
  setSceneBlends?(enabled: boolean): void;
  gpuCheck?(): Outcome;
  gpuDestroy?(): void;
  setGpuTimestamps?(enabled: boolean): boolean;
  gpuTimestampMs?(): Promise<number | Outcome | undefined>;
  gpuFinished?(): Promise<Outcome | undefined>;
  /** Resolves to the pixels, or to an `Outcome` saying why not; never rejects. */
  gpuPixels?(): Promise<Uint8Array | Outcome>;
  blurGpu?(
    src: Uint8Array,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
    dstOx: number,
    dstOy: number,
    sigma: number,
    edgeMode: number,
    border: Float32Array,
    clampX0: number,
    clampY0: number,
    clampX1: number,
    clampY1: number,
    dirtyX0: number,
    dirtyY0: number,
    dirtyX1: number,
    dirtyY1: number,
    sourceId: number,
  ): Promise<Uint8Array | Outcome>;
  blurGpuStats?(): Float64Array;
}

export function listVersion(): Uint32Array;
export function memoryBytes(): number;
export function hasGpu(): boolean;
export function gpuBackend(): string;
/** The browser builds (WebGPU and WebGL2) only. */
export function createGpu(
  canvas: HTMLCanvasElement | OffscreenCanvas | null,
  glyphMaskBytes: number,
): Promise<GpuInit>;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
}
/** Added to the glue by scripts/build.mjs: creates an isolated per-generation glue instance. */
export function __drawpaneCreateGlue(): typeof import("./glue");
/** Added to the glue by scripts/build.mjs: silences timers, closures, and finalizers on trap. */
export function __drawpaneQuiesce(): void;
/** Added to the glue by scripts/build.mjs: returns the compiled WebAssembly.Module. */
export function __drawpaneModule(): WebAssembly.Module | undefined;
/** Added to the glue by scripts/build.mjs: a new instance after a trap. */
export function __drawpaneRenew(): InitOutput | typeof import("./glue");
export function initSync(module?: { module: BufferSource | WebAssembly.Module }): InitOutput;
export default function init(module?: {
  module_or_path: RequestInfo | URL | Response | BufferSource | WebAssembly.Module;
}): Promise<InitOutput>;
