// Loads this package's TypeScript (and the workspace packages it imports) in plain Node,
// through Vite's module runner, as tools/kit-parity does.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../package.json"));

/** Imports `file` (relative to the package) and returns its module. */
export async function importTs(file) {
  const vite = await import(pathToFileURL(require.resolve("vite")).href);
  const { module } = await vite.runnerImport(join(here, "..", file), {
    configFile: false,
    logLevel: "error",
    root: join(here, ".."),
  });
  return module;
}
