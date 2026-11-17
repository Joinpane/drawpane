#!/usr/bin/env node
// Kit parity: a real Figma file as Figma draws and lays it out, against the
// same file imported into Drawpane. See README.md.
//
//   node tools/kit-parity/kit-parity.mjs <step> --out <dir> [options]
//
// Steps, in order (`all` runs them in turn):
//   sample    --fig <file.fig> [--count 400]   pick the frames to compare
//   convert   --fig <file.fig>                 convert as the dashboard does (cached)
//   figma     --key <figma file key> [--only id,id] [--limit n]
//                                              Figma's renders and trees (resumable)
//   drawpane  --fig <file.fig> [--port 8951] [--run <dir>]
//                                              Drawpane's renders and layout (a new run)
//   compare   [--run <dir>] [--against <scoreboard.json>]
//                                              scores, scoreboard.json and report.html
//
// Everything a run makes stays in <dir>, which should be outside the repo
// (or in a gitignored folder) when the file isn't yours to publish.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    fig: { type: "string" },
    key: { type: "string" },
    count: { type: "string" },
    only: { type: "string" },
    limit: { type: "string" },
    port: { type: "string" },
    run: { type: "string" },
    against: { type: "string" },
  },
});
const step = positionals[0];
const out = values.out && resolve(values.out);
if (!step || !out) {
  console.error(
    readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("//"))
      .join("\n"),
  );
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const need = (name) => {
  const v = values[name];
  if (!v) {
    console.error(`The ${step} step needs --${name}.`);
    process.exit(1);
  }
  return v;
};

async function sample() {
  const { importTs } = await import("./src/ts.mjs");
  const { sampleFig } = await importTs("sample.ts");
  const fig = resolve(need("fig"));
  const result = sampleFig(new Uint8Array(readFileSync(fig)), {
    ...(values.count ? { count: Number(values.count) } : {}),
  });
  writeFileSync(join(out, "sample.json"), `${JSON.stringify(result, null, 1)}\n`);
  const kinds = {};
  for (const f of result.frames) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
  console.log(
    `Sampled ${result.frames.length} of ${result.units} units on ${result.pages} pages: ${Object.entries(
      kinds,
    )
      .map(([k, n]) => `${n} ${k}`)
      .join(", ")}.`,
  );
}

async function convert() {
  const { importTs } = await import("./src/ts.mjs");
  const { convertFig } = await importTs("convert.ts");
  const result = await convertFig(resolve(need("fig")), join(out, "drawpane-cache"));
  console.log(`${result.cached ? "Cached" : "Converted"}: ${result.dir}`);
  return result.dir;
}

async function figma() {
  const { figmaTruth } = await import("./src/figma-truth.mjs");
  const key = need("key");
  const result = await figmaTruth({
    link: `https://www.figma.com/design/${key}/file`,
    out,
    only: values.only ? values.only.split(",") : null,
    limit: values.limit ? Number(values.limit) : Infinity,
  });
  if (result.left > 0) process.exitCode = 1;
}

/** Runs the opt-in e2e spec for one of its stages. */
function spec(stage, extra = {}) {
  const web = join(here, "../../apps/web");
  const port = values.port ?? "8951";
  const env = {
    ...process.env,
    E2E_KIT_PARITY: out,
    E2E_KIT_PARITY_STAGE: stage,
    E2E_PORT: port,
    ...extra,
  };
  const run = spawnSync(
    "npx",
    ["playwright", "test", "e2e/kit-parity.spec.ts", "--project", "chromium", "--workers", "1"],
    { cwd: web, env, stdio: "inherit" },
  );
  if (run.status !== 0) process.exit(run.status ?? 1);
}

async function drawpane() {
  const cache = await convert();
  if (!existsSync(join(out, "sample.json"))) await sample();
  spec("render", {
    E2E_KIT_PARITY_CACHE: cache,
    ...(values.run ? { E2E_KIT_PARITY_RUN: resolve(values.run) } : {}),
  });
}

function compare() {
  spec("compare", {
    ...(values.run ? { E2E_KIT_PARITY_RUN: resolve(values.run) } : {}),
    ...(values.against ? { E2E_KIT_PARITY_AGAINST: resolve(values.against) } : {}),
  });
}

const steps = { sample, convert, figma, drawpane, compare };
if (step === "all") {
  const started = Date.now();
  if (!existsSync(join(out, "sample.json"))) await sample();
  await figma();
  await drawpane();
  compare();
  console.log(`All steps took ${Math.round((Date.now() - started) / 60000)} min.`);
} else if (steps[step]) await steps[step]();
else {
  console.error(`No step "${step}". Steps: ${Object.keys(steps).join(", ")}, all.`);
  process.exit(1);
}
