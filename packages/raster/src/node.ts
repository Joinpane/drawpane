/**
 * The resvg rasteriser in Node (tests, and the render parity suite's
 * headless side): the same WebAssembly file a Worker imports, read from
 * disk.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { type ResvgRasteriser, resvgRasteriser } from "./resvg";

/** Where the WebAssembly file is: what a Worker bundles. */
export const resvgWasmPath = (): string =>
  createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm");

export function nodeRasteriser(): Promise<ResvgRasteriser> {
  return resvgRasteriser(readFile(resvgWasmPath()));
}
