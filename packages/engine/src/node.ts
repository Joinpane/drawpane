/**
 * The engine in Node (tests, benches, tools): a build's glue and WebAssembly from dist/.
 * `built()` says whether `pnpm --filter @drawpane/engine build` has run.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Glue from "./glue";
import { type EngineModule, loadEngineSync } from "./index";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

export function built(build: "browser" | "worker" = "worker"): boolean {
  return (
    existsSync(join(DIST, build, "engine_bg.wasm")) && existsSync(join(DIST, build, "engine.js"))
  );
}

export function wasmPath(build: "browser" | "worker"): string {
  return join(DIST, build, "engine_bg.wasm");
}

let fresh = 0;

/**
 * Loads a build in Node. Each build is its own module instance (its own memory), shared by
 * every caller; `fresh` loads another, of its own (a test that traps it on purpose).
 */
export async function loadNodeEngine(
  build: "browser" | "worker" = "worker",
  options: { fresh?: boolean } = {},
): Promise<EngineModule> {
  if (!built(build))
    throw new Error(
      `The engine's ${build} build isn't in dist/: run pnpm --filter @drawpane/engine build`,
    );
  const url = pathToFileURL(join(DIST, build, "engine.js")).href;
  const glue = (await import(
    /* @vite-ignore */ options.fresh ? `${url}?fresh=${++fresh}` : url
  )) as typeof Glue;
  return loadEngineSync(glue, readFileSync(wasmPath(build)), build);
}
