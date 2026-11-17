// Loads this package's TypeScript (and the workspace packages it imports,
// which are TypeScript too) in plain Node, through Vite's module runner: the
// same transform the app and the tests use, with no build step.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../package.json"));

/** Imports `file` (relative to this folder) and returns its module. */
export async function importTs(file) {
  const vite = await import(pathToFileURL(require.resolve("vite")).href);
  const { module } = await vite.runnerImport(join(here, file), {
    configFile: false,
    logLevel: "error",
    root: join(here, ".."),
  });
  return module;
}
