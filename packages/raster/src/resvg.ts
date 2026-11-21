/** Rasteriser for Node SVG tests. Each picture uses a fresh capped instance. */
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

export interface ResvgRasteriser {
  rasterise(svg: string, options: RasterOptions): Raster;
  /** The SVG drawn, as pixels: for comparing renders. */
  pixels(svg: string, options: RasterOptions): Pixels;
}

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

function compile(bytes: Uint8Array): WebAssembly.Module {
  const { Module } = WebAssembly as unknown as {
    Module: new (bytes: Uint8Array) => WebAssembly.Module;
  };
  return new Module(withMemoryMaximum(bytes, RESVG_MAX_BYTES));
}

/**
 * A rasteriser backed by resvg. The first call compiles the module; later
 * ones reuse it, whatever they pass. Every render instantiates it afresh.
 */
export async function resvgRasteriser(wasm: Promise<Uint8Array>): Promise<ResvgRasteriser> {
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
