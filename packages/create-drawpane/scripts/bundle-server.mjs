// Packs the release this installer carries into server/: the two Workers as
// built (apps/worker's build, `wrangler deploy --dry-run`, and the agent
// runner's, apps/agent-runner), the web app's assets, the D1 migrations, and
// each Worker's configuration as a template. The templates come from
// apps/worker/wrangler.jsonc and apps/agent-runner/wrangler.jsonc, so
// bindings, Durable Object migrations and compatibility settings have one
// source of truth.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const worker = join(repo, "apps/worker");
const runner = join(repo, "apps/agent-runner");
const web = join(repo, "apps/web/dist");
const out = resolve(here, "../server");

async function need(path, hint) {
  try {
    await stat(path);
  } catch {
    throw new Error(`Missing ${path}: ${hint}`);
  }
}

await need(join(worker, "dist/index.js"), "build the Worker first (pnpm build).");
await need(join(runner, "dist/index.js"), "build the agent runner first (pnpm build).");
await need(join(web, "index.html"), "build the web app first (pnpm build).");

/**
 * A Worker's wrangler.jsonc as a template, without what an instance chooses
 * for itself (rendered by the installer, src/release.ts). JSONC to JSON: our
 * configs have whole-line comments only, and no trailing commas.
 */
async function template(app) {
  const jsonc = await readFile(join(app, "wrangler.jsonc"), "utf8");
  const config = JSON.parse(
    jsonc
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n"),
  );
  for (const key of ["$schema", "name", "main", "routes", "d1_databases", "r2_buckets"])
    delete config[key];
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** A built Worker and its imported WebAssembly and font modules. */
async function copyWorker(app, into) {
  await mkdir(into, { recursive: true });
  await cp(join(app, "dist/index.js"), join(into, "index.js"));
  await cp(join(app, "dist/index.js.map"), join(into, "index.js.map")).catch(() => {});
  for (const name of await readdir(join(app, "dist")))
    if (name.endsWith(".wasm") || name.endsWith(".ttf"))
      await cp(join(app, "dist", name), join(into, name));
}

await rm(out, { recursive: true, force: true });
await copyWorker(worker, join(out, "worker"));
// HarfBuzz and the CPU render engine live in the runner now (docs/decisions/0033-agent-runner.md).
await copyWorker(runner, join(out, "agent-runner"));
await cp(web, join(out, "assets"), { recursive: true });
await cp(join(worker, "migrations"), join(out, "migrations"), { recursive: true });
await writeFile(join(out, "wrangler.template.json"), await template(worker));
await writeFile(join(out, "agent-runner.template.json"), await template(runner));
console.log(`create-drawpane: server bundled into ${out}`);
