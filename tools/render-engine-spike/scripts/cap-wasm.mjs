// Writes the modules the spike's Worker bundles into wasm/ (not committed), each with its
// memory capped as the agent runner caps its own (decision 0033, item 4.2): the engine at
// resvg's 25 MiB, whose place it would take, and HarfBuzz at its 32 MiB.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importTs } from "./ts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../package.json"));
const { HARFBUZZ_MAX_BYTES, RESVG_MAX_BYTES, withMemoryMaximum, memoryLimits } = await importTs(
  "../../packages/raster/src/wasm-limits.ts",
);
const out = join(here, "../wasm");
mkdirSync(out, { recursive: true });
const ENGINE_MAX_BYTES = Number(process.env.SPIKE_ENGINE_MAX_MIB ?? 25) * 1024 * 1024;
for (const [name, from, max] of [
  ["engine.wasm", join(here, "../dist/cpu/engine_bg.wasm"), ENGINE_MAX_BYTES],
  ["harfbuzz.wasm", require.resolve("harfbuzzjs/dist/harfbuzz.wasm"), HARFBUZZ_MAX_BYTES],
]) {
  const capped = withMemoryMaximum(new Uint8Array(readFileSync(from)), max);
  writeFileSync(join(out, name), capped);
  console.log(name, memoryLimits(capped), `(resvg's cap is ${RESVG_MAX_BYTES / 2 ** 20} MiB)`);
}
