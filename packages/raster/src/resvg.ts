/**
 * SVG to PNG with resvg (`@resvg/resvg-wasm`), in WebAssembly.
 *
 * Chosen for the headless renderer (decision 0023) over the alternatives
 * measured: it draws everything our SVG export writes (gradients, patterns,
 * clip paths, alpha and luminance masks, blend modes, the filters behind
 * shadows, blur, noise and texture, text from supplied font files, images
 * from data: URLs), runs with no Node or browser APIs, and is the build
 * Cloudflare's own resvg packages wrap.
 *
 * The WebAssembly module comes from the host, the way each loads it: a
 * Worker imports the `.wasm` file as a compiled `WebAssembly.Module` (Workers
 * can't compile WebAssembly at run time), its memory capped at build time;
 * Node and tests read its bytes (`./node.ts`), capped here as they're
 * compiled (`wasm-limits.ts`).
 *
 * Each picture is drawn in an instance of its own, made from the compiled
 * module (0.4 ms) and dropped afterwards (decision 0033, item 4.2). A render
 * past the cap traps, and a trap leaves an instance unusable and what it
 * held unfreed; linear memory never shrinks, either. A fresh instance gives
 * all of that back, so the next render is as if the failed one never ran.
 */
import { createResvg } from "@resvg/resvg-wasm";
import { RESVG_MAX_BYTES, withMemoryMaximum } from "./wasm-limits";

/** What a render needs besides the SVG. */
export interface RasterOptions {
  /** Output pixels per SVG unit. */
  readonly scale: number;
  /** TrueType or OpenType files for the text in the SVG; nothing else is available to it. */
  readonly fonts: readonly Uint8Array[];
  /** The family for generic names (`sans-serif`) and text whose own family has no file. */
  readonly fallbackFamily?: string;
  /** Painted behind everything, as a CSS colour; transparent when absent. */
  readonly background?: string | null;
  /**
   * Image files by the `https:` URL the SVG names each by (never fetched):
   * handed to resvg as bytes, so the SVG needn't carry them as data: URLs.
   * An image the SVG names that isn't here, or that resvg can't decode, is
   * left out. Images inside a `<pattern>` aren't resolved from here (resvg
   * doesn't list them): a pattern needs its image as a data: URL.
   */
  readonly images?: ReadonlyMap<string, Uint8Array>;
}

/** A rendered picture. */
export interface Raster {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** A rendered picture as RGBA pixels with straight alpha, row by row, as a canvas's `getImageData` gives them. */
export interface Pixels {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Draws SVG into a PNG. Asynchronous where it runs elsewhere: in a Worker of
 * its own behind a service binding, or across a test's page and Node.
 */
export interface Rasteriser {
  rasterise(svg: string, options: RasterOptions): Raster | Promise<Raster>;
}

/** resvg, in this isolate: at once, and as pixels too. */
export interface ResvgRasteriser extends Rasteriser {
  rasterise(svg: string, options: RasterOptions): Raster;
  /** The SVG drawn, as pixels: for comparing renders. */
  pixels(svg: string, options: RasterOptions): Pixels;
}

/** The module, compiled (a Worker's `.wasm` import) or as bytes (Node). */
export type ResvgWasm = WebAssembly.Module | ArrayBuffer | Uint8Array;

/**
 * A render that ran out of the memory resvg may grow to (a trap), worded
 * for whoever asked. Nothing of it is kept: the next render starts afresh.
 */
export class RasterOutOfMemory extends Error {
  constructor() {
    super("That picture needs more memory than rendering has.");
    this.name = "RasterOutOfMemory";
  }
}

let compiled: Promise<WebAssembly.Module> | null = null;

/** The module as given (a Worker's, capped when it was built), or compiled from bytes with the cap. */
async function compile(wasm: ResvgWasm): Promise<WebAssembly.Module> {
  if (wasm instanceof WebAssembly.Module) return wasm;
  const bytes = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
  // Only Node and tests come here (a Worker can't compile at run time): compiled at once.
  // (Typed as Workers type it, where it can't be constructed.)
  const { Module } = WebAssembly as unknown as {
    Module: new (bytes: Uint8Array) => WebAssembly.Module;
  };
  return new Module(withMemoryMaximum(bytes, RESVG_MAX_BYTES));
}

/**
 * A rasteriser backed by resvg. The first call compiles the module; later
 * ones reuse it, whatever they pass. Every render instantiates it afresh.
 */
export async function resvgRasteriser(
  wasm: ResvgWasm | Promise<ResvgWasm>,
): Promise<ResvgRasteriser> {
  compiled ??= (async () => compile(await wasm))().catch((error: unknown) => {
    compiled = null;
    throw error;
  });
  const module = await compiled;
  return {
    rasterise: (svg, options) =>
      draw(module, svg, options, (image) => ({
        png: image.asPng(),
        width: image.width,
        height: image.height,
      })),
    pixels: (svg, options) =>
      draw(module, svg, options, (image) => ({
        data: unpremultiply(image.pixels),
        width: image.width,
        height: image.height,
      })),
  };
}

type Glue = ReturnType<typeof createResvg>;
type Rendered = ReturnType<InstanceType<Glue["Resvg"]>["render"]>;

/**
 * Draws in a new instance, which goes with this call: nothing is freed by
 * hand (after a trap, wasm-bindgen's `free()` throws and would hide the
 * trap), and what the instance held goes with it.
 */
function draw<T>(
  module: WebAssembly.Module,
  svg: string,
  options: RasterOptions,
  read: (image: Rendered) => T,
): T {
  const glue = createResvg();
  glue.initSync(module);
  try {
    return drawIn(glue, svg, options, read);
  } catch (error) {
    // A trap: an allocation past the cap (Rust aborts with `unreachable`), or the like.
    if (error instanceof WebAssembly.RuntimeError) throw new RasterOutOfMemory();
    throw error;
  }
}

function drawIn<T>(
  glue: Glue,
  svg: string,
  options: RasterOptions,
  read: (image: Rendered) => T,
): T {
  const family = options.fallbackFamily;
  const resvg = new glue.Resvg(svg, {
    fitTo: { mode: "zoom", value: options.scale },
    font: {
      fontBuffers: [...options.fonts],
      ...(family ? { defaultFontFamily: family, sansSerifFamily: family } : {}),
    },
    ...(options.background ? { background: options.background } : {}),
    // As the canvas draws: anti-aliased shapes, text at its exact outlines, smooth images.
    shapeRendering: 2,
    textRendering: 2,
    imageRendering: 0,
  });
  if (options.images)
    for (const href of resvg.imagesToResolve() as string[]) {
      const bytes = options.images.get(href);
      if (!bytes) continue;
      try {
        resvg.resolveImage(href, bytes);
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError) throw error;
        // A file it can't decode is left out, as a broken data: URL is.
      }
    }
  return read(resvg.render());
}

/** resvg's pixels have their colour multiplied by alpha; undone in place. */
function unpremultiply(data: Uint8Array): Uint8Array {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a === 0 || a === 255) continue;
    for (let c = i; c < i + 3; c++) data[c] = Math.min(255, Math.round(((data[c] ?? 0) * 255) / a));
  }
  return data;
}
