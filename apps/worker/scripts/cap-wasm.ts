/**
 * Writes the WebAssembly the Worker bundles with each module's memory
 * capped (decision 0033, item 4.2; the caps are in
 * `@drawpane/raster/wasm-limits`): resvg's and HarfBuzz's, from their
 * packages, into `wasm/` (not committed). A Worker can't compile
 * WebAssembly at run time, so the cap has to be in the file it bundles.
 *
 * Run before anything bundles the Worker: `build`, `dev` and `deploy` do,
 * and so does the vitest config.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARFBUZZ_MAX_BYTES,
  memoryLimits,
  RESVG_MAX_BYTES,
  withMemoryMaximum,
} from "@drawpane/raster/wasm-limits";

const require = createRequire(import.meta.url);

const MODULES = [
  { out: "resvg.wasm", from: "@resvg/resvg-wasm/index_bg.wasm", max: RESVG_MAX_BYTES },
  { out: "harfbuzz.wasm", from: "harfbuzzjs/dist/harfbuzz.wasm", max: HARFBUZZ_MAX_BYTES },
] as const;

/** Writes the capped modules (only those that changed); answers where they are. */
export function capWasm(): string {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../wasm");
  mkdirSync(dir, { recursive: true });
  for (const { out, from, max } of MODULES) {
    const capped = withMemoryMaximum(new Uint8Array(readFileSync(require.resolve(from))), max);
    const limits = memoryLimits(capped);
    if (limits?.max !== Math.floor(max / 65536)) throw new Error(`${out} wasn't capped`);
    const target = join(dir, out);
    let current: Uint8Array | null = null;
    try {
      current = new Uint8Array(readFileSync(target));
    } catch {
      // Not written yet.
    }
    if (!current || Buffer.compare(current, capped) !== 0) writeFileSync(target, capped);
  }
  return dir;
}

if (import.meta.url === `file://${process.argv[1]}`) capWasm();
