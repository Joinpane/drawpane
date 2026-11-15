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
 * can't compile WebAssembly at run time); Node and tests read its bytes
 * (`./node.ts`). It is set up once per isolate.
 */
import { initWasm, Resvg } from "@resvg/resvg-wasm";

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

let setup: Promise<void> | null = null;

/**
 * A rasteriser backed by resvg. The first call sets the module up; later
 * ones reuse it, whatever they pass.
 */
export async function resvgRasteriser(
  wasm: ResvgWasm | Promise<ResvgWasm>,
): Promise<ResvgRasteriser> {
  setup ??= (async () => initWasm(await wasm))().catch((error: unknown) => {
    setup = null;
    throw error;
  });
  await setup;
  return {
    rasterise: (svg, options) =>
      draw(svg, options, (image) => ({
        png: image.asPng(),
        width: image.width,
        height: image.height,
      })),
    pixels: (svg, options) =>
      draw(svg, options, (image) => ({
        data: unpremultiply(image.pixels),
        width: image.width,
        height: image.height,
      })),
  };
}

type Rendered = ReturnType<InstanceType<typeof Resvg>["render"]>;

function draw<T>(svg: string, options: RasterOptions, read: (image: Rendered) => T): T {
  const family = options.fallbackFamily;
  const resvg = new Resvg(svg, {
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
  try {
    const image = resvg.render();
    try {
      return read(image);
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
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
