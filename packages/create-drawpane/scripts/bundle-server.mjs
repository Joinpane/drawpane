// Packs the release this installer carries into server/: the Worker as built
// by `wrangler deploy --dry-run` (apps/worker's build), the web app's assets,
// the D1 migrations, and the Worker's configuration as a template. The
// template comes from apps/worker/wrangler.jsonc, so bindings, Durable Object
// migrations and compatibility settings have one source of truth.
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const worker = join(repo, "apps/worker");
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
await need(join(web, "index.html"), "build the web app first (pnpm build).");

/** JSONC to JSON: our config has whole-line comments only, and no trailing commas. */
const jsonc = await readFile(join(worker, "wrangler.jsonc"), "utf8");
const config = JSON.parse(
  jsonc
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n"),
);
// What an instance chooses for itself, rendered by the installer (src/release.ts).
for (const key of ["$schema", "name", "main", "routes", "d1_databases", "r2_buckets"])
  delete config[key];

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "worker"), { recursive: true });
await cp(join(worker, "dist/index.js"), join(out, "worker/index.js"));
await cp(join(worker, "dist/index.js.map"), join(out, "worker/index.js.map")).catch(() => {});
await cp(web, join(out, "assets"), { recursive: true });
await cp(join(worker, "migrations"), join(out, "migrations"), { recursive: true });
await writeFile(join(out, "wrangler.template.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`create-drawpane: server bundled into ${out}`);
