/**
 * What the headless engine needs to render PNGs in the Worker (decision
 * 0023), besides its text measurer: font files, images and the rasteriser.
 * The engine passes these, with its measurer, to the editor's
 * `createHeadlessRenderer`; the Worker itself doesn't import the editor.
 *
 * resvg's WebAssembly comes in as a compiled module, as Workers require,
 * with its memory capped. Each render draws in a fresh instance of it.
 */
import {
  cachedFontLoader,
  type FontBytesLoader,
  type Rasteriser,
  resvgRasteriser,
} from "@drawpane/raster";
// The same file @drawpane/raster's glue expects (both pin one version: test/render.test.ts checks),
// with its memory capped by scripts/cap-wasm.ts.
import resvgWasm from "../../wasm/resvg.wasm";
import type { Env } from "../env";
import { workerFontLoader } from "./fonts";
import { type WorkerImage, workerImageLoader } from "./media";

export interface WorkerRenderDeps {
  readonly fonts: FontBytesLoader;
  readonly images: (ref: string) => Promise<WorkerImage | null>;
  readonly rasteriser: Rasteriser;
}

/** The rasteriser, set up once per isolate. */
export const workerRasteriser = (): Promise<Rasteriser> => resvgRasteriser(resvgWasm);

/** Loaders and the rasteriser for one file's renders: its team's fonts and images. */
export async function renderDeps(env: Env, teamId: string): Promise<WorkerRenderDeps> {
  return {
    fonts: cachedFontLoader(workerFontLoader(env, teamId)),
    images: workerImageLoader(env, teamId),
    rasteriser: await workerRasteriser(),
  };
}
