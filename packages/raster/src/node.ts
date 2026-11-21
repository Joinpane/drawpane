/** The Node rasteriser used by SVG export tests. */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { type ResvgRasteriser, resvgRasteriser } from "./resvg";

export type { ResvgRasteriser } from "./resvg";

const resvgWasmPath = (): string =>
  createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm");

export function nodeRasteriser(): Promise<ResvgRasteriser> {
  return resvgRasteriser(readFile(resvgWasmPath()));
}
