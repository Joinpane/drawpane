/**
 * The types of the WebAssembly modules' JavaScript glue, which wasm-bindgen writes into dist/
 * at build time (never committed). Declared here so the repo typechecks without building Rust.
 * Must match `rust/src/lib.rs`; `test/glue.test.ts` checks the built glue has every member.
 */

export class Outcome {
  free(): void;
  readonly ok: boolean;
  readonly code: number;
  readonly message: string;
  readonly dirty: Float64Array;
  readonly full: boolean;
  readonly records: number;
  readonly culled: number;
  readonly glyphs_masked: number;
  readonly glyphs_outlined: number;
  readonly mask_hits: number;
  readonly mask_misses: number;
  readonly mask_bytes: number;
}

export class GpuInit {
  free(): void;
  readonly ok: boolean;
  readonly code: number;
  readonly message: string;
  readonly adapter: string;
  readonly fallback: boolean;
}

export class Engine {
  constructor(glyphMaskBytes: number, imageBytes: number);
  free(): void;
  readonly revision: number;
  readonly records: number;
  readonly glyphs: number;
  readonly glyphBytes: number;
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
  dropImage(id: number): void;
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
  pngBegin(width: number, height: number): Outcome;
  pngBand(
    zoom: number,
    x: number,
    y: number,
    dpr: number,
    background: Float32Array,
    rows: number,
  ): Outcome;
  pngTake(): Uint8Array;
  pngEnd(): Uint8Array;
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
    detail: boolean,
  ): Outcome;
  gpuCheck?(): Outcome;
  gpuDestroy?(): void;
  gpuFinished?(): Promise<void>;
  gpuPixels?(): Promise<Uint8Array>;
}

export function listVersion(): Uint32Array;
export function memoryBytes(): number;
export function hasGpu(): boolean;
/** The browser build only. */
export function createGpu(
  canvas: HTMLCanvasElement | OffscreenCanvas | null,
  glyphMaskBytes: number,
): Promise<GpuInit>;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
}
export function initSync(module: { module: BufferSource | WebAssembly.Module }): InitOutput;
export default function init(module?: {
  module_or_path: RequestInfo | URL | Response | BufferSource | WebAssembly.Module;
}): Promise<InitOutput>;
