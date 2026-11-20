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
//   drawpane  --fig <file.fig> [--port 8951] [--run <dir>] [--allow-missing-fonts]
//                                              Drawpane's renders and layout (a new run);
//                                              missing fonts fail it unless allowed
//   compare   [--run <dir>] [--against <scoreboard.json>] [--same] [--allow-missing-fonts]
//                                              scores, scoreboard.json and report.html;
//                                              with --against, what got better and worse
//                                              (--same: fail unless nothing changed)
//   detach    --fig <file.fig> | --nodes <lines.json> [--name <label>]
//                                              which instances the compact form keeps and
//                                              why the rest are detached (detach-<label>.json)
//   coverage  --fig <file.fig> [--nodes <lines.json>] [--name <label>]
//                                              every Figma feature the file uses and what the
//                                              import makes of it, judged on the converted
//                                              output (coverage[-<label>].json and .md)
//   relayout  --fig <file.fig> | --nodes <lines.json> [--name <label>]
//                                              geometry drift after rerunning editor auto layout
//   text-widths [--run <dir>] [--only id,id] [--name <label>]
//                                              Figma's text widths against Drawpane's, per font
//                                              (text-widths[-<label>].json and .md in the run)
//
// The drawpane step converts and draws a whole file: one at a time per
// machine (a lock in the temp folder), since each takes several GB.
//
// Everything a run makes stays in <dir>, which should be outside the repo
// (or in a gitignored folder) when the file isn't yours to publish.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    same: { type: "boolean" },
    "allow-missing-fonts": { type: "boolean" },
    nodes: { type: "string" },
    name: { type: "string" },
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
    ...(values["allow-missing-fonts"] ? { E2E_KIT_PARITY_ALLOW_MISSING_FONTS: "1" } : {}),
    ...extra,
  };
  const run = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "e2e/kit-parity.spec.ts",
      "--project",
      "chromium",
      "--workers",
      "1",
    ],
    { cwd: web, env, stdio: "inherit" },
  );
  if (run.status !== 0) process.exit(run.status ?? 1);
}

async function drawpane() {
  const { withMachineLock } = await import("./src/lock.mjs");
  await withMachineLock(`drawpane step for ${out}`, async () => {
    const cache = await convert();
    if (!existsSync(join(out, "sample.json"))) await sample();
    spec("render", {
      E2E_KIT_PARITY_CACHE: cache,
      ...(values.run ? { E2E_KIT_PARITY_RUN: resolve(values.run) } : {}),
    });
  });
}

function compare() {
  spec("compare", {
    ...(values.run ? { E2E_KIT_PARITY_RUN: resolve(values.run) } : {}),
    ...(values.against ? { E2E_KIT_PARITY_AGAINST: resolve(values.against) } : {}),
    ...(values.same ? { E2E_KIT_PARITY_SAME: "1" } : {}),
  });
}

async function detach() {
  const { withMachineLock } = await import("./src/lock.mjs");
  await withMachineLock(`detach step for ${out}`, async () => {
    const { importTs } = await import("./src/ts.mjs");
    const { readNodes, measureDetaches, measurePins } = await importTs("detach.ts");
    // What pinInstances unlinked is measured on what the converter gave before it.
    process.env.KIT_PARITY_KEEP_UNPINNED = "1";
    const cache = values.nodes ? null : await convert();
    const source = values.nodes ? resolve(values.nodes) : join(cache, "nodes.ndjson");
    // Next to the nodes, when they're a conversion's.
    const unpinned = join(dirname(source), "unpinned.ndjson");
    let pins = null;
    if (existsSync(unpinned)) {
      console.log(`Reading ${unpinned}`);
      pins = measurePins(readNodes(unpinned));
      console.log(`pinInstances: ${pins.detached} of ${pins.roots} instance roots unlinked.`);
      for (const reason of pins.reasons.slice(0, 15))
        console.log(`  ${reason.count}  ${reason.kind}`);
    }
    console.log(`Reading ${source}`);
    const report = measureDetaches(readNodes(source), console.log);
    const file = join(out, `detach-${values.name ?? "latest"}.json`);
    writeFileSync(file, `${JSON.stringify({ source, pins, ...report }, null, 1)}\n`);
    const { topLevel: t, instanceRoots: r } = report;
    console.log(
      `Top-level instances: ${t.total}, ${t.kept} kept, ${t.detached} detached. Instance roots: ${r.before}, ${r.keptStored} stored, ${r.compacted} compacted, ${r.detached} detached. ${report.overrides} override records, ${report.stored} records stored.`,
    );
    for (const reason of report.reasons.slice(0, 15))
      console.log(`  ${reason.count}  ${reason.kind}`);
    console.log(`Saved ${file}`);
  });
}

async function coverage() {
  const { withMachineLock } = await import("./src/lock.mjs");
  await withMachineLock(`coverage step for ${out}`, async () => {
    const { importTs } = await import("./src/ts.mjs");
    const { coverage: measure, coverageMarkdown } = await importTs("coverage.ts");
    const fig = resolve(need("fig"));
    const nodes = values.nodes ? resolve(values.nodes) : join(await convert(), "nodes.ndjson");
    console.log(`Reading ${fig} and ${nodes}`);
    const result = await measure(new Uint8Array(readFileSync(fig)), nodes);
    const base = join(out, `coverage${values.name ? `-${values.name}` : ""}`);
    writeFileSync(`${base}.json`, `${JSON.stringify({ fig, nodes, ...result }, null, 1)}\n`);
    writeFileSync(`${base}.md`, coverageMarkdown(result));
    const gaps = result.features.filter((f) => f.status !== "faithful" && f.status !== "unchecked");
    console.log(
      `${result.features.length} features: ${result.features.length - gaps.length} faithful or unjudged, ${gaps.length} gaps. Top 10 by impact:`,
    );
    for (const f of gaps.slice(0, 10))
      console.log(`  ${f.impact}  ${f.label} (${f.status}, ${f.layers} layers)`);
    console.log(`Saved ${base}.json and ${base}.md`);
  });
}

async function relayout() {
  const { withMachineLock } = await import("./src/lock.mjs");
  await withMachineLock(`relayout step for ${out}`, async () => {
    const { importTs } = await import("./src/ts.mjs");
    const { relayoutReport } = await importTs("relayout.ts");
    const source = values.nodes ? resolve(values.nodes) : join(await convert(), "nodes.ndjson");
    const report = relayoutReport(source);
    const file = join(out, `relayout${values.name ? `-${values.name}` : ""}.json`);
    writeFileSync(file, `${JSON.stringify({ source, ...report }, null, 1)}\n`);
    console.log(
      `${report.changed} of ${report.layers} visible layer boxes changed by more than ${report.threshold} px in ${report.framesAffected} of ${report.frames.length} frame subtrees (${report.alreadyChanged} boxes already different on resolution).`,
    );
    for (const { cause, count } of report.causes) console.log(`  ${count}  ${cause}`);
    console.log(`${report.hiddenChanged} of ${report.hiddenLayers} hidden layer boxes changed.`);
    console.log(`Saved ${file}`);
  });
}

async function textWidthsStep() {
  const { importTs } = await import("./src/ts.mjs");
  const { textWidths, textWidthsMarkdown } = await importTs("text-widths.ts");
  const runs = join(out, "runs");
  const run = values.run ? resolve(values.run) : join(runs, readdirSync(runs).sort().at(-1) ?? "");
  const result = textWidths(out, run, values.only ? new Set(values.only.split(",")) : undefined);
  const base = join(run, `text-widths${values.name ? `-${values.name}` : ""}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 1)}\n`);
  writeFileSync(`${base}.md`, textWidthsMarkdown(result));
  console.log(
    `${result.textLayers} text layers in ${result.frames} frames. Saved ${base}.json and .md`,
  );
}

const steps = {
  sample,
  convert,
  figma,
  drawpane,
  compare,
  detach,
  coverage,
  relayout,
  "text-widths": textWidthsStep,
};
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
