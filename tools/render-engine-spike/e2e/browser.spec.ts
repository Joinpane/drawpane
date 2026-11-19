/**
 * The engine on WebGPU in the browser (decision 0040's spike). Builds the board's display list
 * from the kit named by SPIKE_FILE / SPIKE_BOARD (src/kit.ts), serves the page and the GPU
 * build from routes, and records: the adapter (a software adapter's timings are reported as
 * not representative), GPU frame times, and kit parity's score of the GPU render against the
 * CPU render (the Worker's, from scripts/measure-worker.mjs, when SPIKE_OUT holds one; else
 * the page's own), against Figma's render (SPIKE_REFERENCE), and against the canvas
 * renderer's (SPIKE_CANVAS, a kit-parity run's PNG of the board). Writes browser.json, the
 * PNGs and heat maps into SPIKE_OUT. Skipped without SPIKE_FILE.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { decode, encode } from "fast-png";
import { buildBoard } from "../src/board";
import { outsideTolerance, type Score, score } from "../src/compare";
import { kitInput, readNodes } from "../src/kit";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const input = kitInput();
const out = process.env.SPIKE_OUT ?? join(root, "out");
const ORIGIN = "https://spike.test";

const TYPES: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  wasm: "application/wasm",
  dl: "application/octet-stream",
};

test("the board on the GPU, against the CPU", async ({ page }) => {
  test.skip(!input, "Opt-in: set SPIKE_FILE to a folder kit-parity's convert step made.");
  if (!input) return;
  mkdirSync(out, { recursive: true });
  // SPIKE_OMIT (glass, inner-shadow, drop-shadow, linear) leaves features out, to find a fault.
  const omit = (process.env.SPIKE_OMIT ?? "").split(",").filter(Boolean) as never[];
  const list = buildBoard(readNodes(input.folder), input.boardId, { omit });
  // SPIKE_BACKEND=webgl draws through wgpu's WebGL2 backend (the dist/gl build) instead of WebGPU.
  const backend = process.env.SPIKE_BACKEND === "webgl" ? "webgl" : "webgpu";
  const build = backend === "webgl" ? "gl" : "gpu";
  const files: Record<string, Uint8Array | string> = {
    "/index.html": readFileSync(join(root, "page/index.html")),
    "/page.js": readFileSync(join(root, "page/page.js")),
    "/engine/engine.js": readFileSync(join(root, `dist/${build}/engine.js`)),
    "/engine/engine_bg.wasm": readFileSync(join(root, `dist/${build}/engine_bg.wasm`)),
    "/board.dl": list.bytes,
  };
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = files[path];
    if (body === undefined) return route.fulfill({ status: 404 });
    return route.fulfill({
      body: Buffer.from(body),
      contentType: TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream",
    });
  });
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  const srcOver = process.env.SPIKE_VELLO_SRC_OVER === "0" ? "&vello-src-over=0" : "";
  await page.goto(
    `${ORIGIN}/index.html?runs=${process.env.SPIKE_RUNS ?? 9}&backend=${backend}${srcOver}`,
  );
  await page
    .waitForFunction(() => (window as { spike?: unknown }).spike !== undefined, null, {
      timeout: Number(process.env.SPIKE_PAGE_TIMEOUT ?? 540_000),
    })
    .catch(async (error: unknown) => {
      const status = await page.locator("#status").textContent();
      throw new Error(`${error}\nstatus: ${status}\n${logs.join("\n")}`);
    });
  const result = await page.evaluate(
    () => (window as unknown as { spike: Record<string, unknown> }).spike,
  );
  if (result.error) throw new Error(`${result.error}\n${logs.join("\n")}`);
  const { width, height } = result as { width: number; height: number };
  const gpu = new Uint8Array(Buffer.from(result.gpuPixels as string, "base64"));
  const cpuInPage = new Uint8Array(Buffer.from(result.cpuPixels as string, "base64"));
  const workerFile = join(out, "cpu.rgba");
  const cpu = existsSync(workerFile) ? new Uint8Array(readFileSync(workerFile)) : cpuInPage;
  const png = (name: string, data: Uint8Array) =>
    writeFileSync(join(out, name), encode({ width, height, data, channels: 4 }));
  png("gpu.png", gpu);
  png("cpu-page.png", cpuInPage);

  const scores: Record<string, Omit<Score, never>> = {};
  const failures: string[] = [];
  if (Object.keys(list.unsupported).length > 0)
    failures.push(`unsupported in the display list: ${JSON.stringify(list.unsupported)}`);
  const compare = (name: string, a: Uint8Array, b: Uint8Array) => {
    const { heat, ...s } = score(a, b, width, height);
    scores[name] = s;
    png(`heat-${name}.png`, heat);
    return s;
  };
  // The gate: the GPU against the CPU (the Worker's pixels when measure-worker.mjs ran).
  for (const why of outsideTolerance(compare("gpu-vs-cpu", gpu, cpu)))
    failures.push(`GPU against CPU: ${why}`);
  const same = compare("cpu-worker-vs-cpu-page", cpu, cpuInPage);
  if (same.max !== 0)
    failures.push(`the Worker's CPU render and the page's differ (max ${same.max})`);
  const load = (what: string, file: string | undefined) => {
    if (!file) return null;
    if (!existsSync(file)) {
      failures.push(`${what} ${file} is missing`);
      return null;
    }
    const img = decode(readFileSync(file));
    if (img.channels !== 4 || img.width !== width || img.height !== height) {
      failures.push(
        `${what} is ${img.width} × ${img.height} × ${img.channels}, not ${width} × ${height} RGBA`,
      );
      return null;
    }
    return new Uint8Array(img.data);
  };
  // Figma's render and the canvas renderer's are reported, not gated: the spike cut features.
  const figma = load("Figma's render", input.reference ?? undefined);
  const canvas = load("The canvas renderer's render", process.env.SPIKE_CANVAS);
  if (figma) {
    compare("gpu-vs-figma", gpu, figma);
    compare("cpu-vs-figma", cpu, figma);
    if (canvas) compare("canvas-vs-figma", canvas, figma);
  }
  if (canvas) compare("gpu-vs-canvas", gpu, canvas);
  const report = {
    board: input.figmaId,
    cache: input.folder.split("/").pop(),
    size: [width, height],
    backend: result.backend,
    adapter: result.adapter,
    wgpuAdapter: result.wgpuAdapter,
    moduleInitMs: result.initMs,
    engineCreateMs: result.createMs,
    timingNote: result.note,
    frame: result.frame,
    gpu: result.gpu,
    cpuInPageMs: result.cpuInPageMs,
    cpuSource: existsSync(workerFile) ? "worker" : "page",
    scores,
    failures,
    displayList: {
      bytes: list.bytes.length,
      layers: list.layers,
      ops: list.ops,
      unsupported: list.unsupported,
    },
  };
  writeFileSync(join(out, "browser.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  expect(gpu.length).toBe(width * height * 4);
  expect(failures).toEqual([]);
});
