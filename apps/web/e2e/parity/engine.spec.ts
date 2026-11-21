/**
 * The render engine's accuracy gates (decision 0040, "Parity gates"), on every Figma parity
 * suite (tools/figma-parity):
 *
 * - every cell is drawn by the engine on the CPU and on the GPU (SwiftShader here: the same
 *   shaders a GPU runs; its timings mean nothing), read back through a buffer;
 * - a cell holding anything the engine doesn't draw yet must be refused (it falls back to the
 *   canvas renderer), never drawn: a supported suite's cell may only fall back where it's
 *   listed below with its reason;
 * - every cell the engine draws must be no further from Figma than the canvas renderer is
 *   allowed to be on the same golden (`thresholds.json`, the same metric as parity.spec.ts);
 * - CPU against GPU within decision 0040's tolerance (mean, p99, worst 32 × 32 tile, severe
 *   clusters);
 * - the Worker's CPU build, in Node, draws the page's display list bit for bit as the browser
 *   build's CPU path does.
 *
 * The alpha-aware scores (over black as well as white, alpha, worst tile) are reported per
 * cell. Writes a report to ENGINE_PARITY_OUT (default test-results/engine-parity/index.html)
 * and the scores to scores.json beside it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RenderEngine } from "@drawpane/engine";
import { outsideTolerance, score } from "@drawpane/engine/compare";
import { loadNodeEngine } from "@drawpane/engine/node";
import { expect, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { compare, decodePng, encodePng } from "./pixels";
import {
  build,
  exportRect,
  gridSize,
  over,
  ROOT,
  recorded,
  SCALE,
  suites,
  waitForFonts,
} from "./suites";

const OUT =
  process.env.ENGINE_PARITY_OUT ??
  fileURLToPath(new URL("../../test-results/engine-parity", import.meta.url));

/**
 * Per-cell expected fallbacks for supported and partially supported suites: every cell not
 * listed here (outside `PHASE_3`) MUST draw; every cell listed here MUST fall back with these
 * exact feature reasons so a spurious fallback bit on a drawable cell fails immediately.
 */
const EXPECTED_CELL_FALLBACKS: Record<string, Record<string, readonly string[]>> = {
  blurs: {
    "background-4": ["backgroundBlur"],
    "background-12": ["backgroundBlur"],
    "background-32": ["backgroundBlur"],
    "background-clear-12": ["backgroundBlur"],
    "background-ellipse-16": ["backgroundBlur"],
  },
  corners: {
    mask: ["mask"],
  },
  "corners-glass": {
    "glass-ios": ["glass"],
    "glass-full": ["glass"],
    "background-blur": ["backgroundBlur"],
    "glass-plain": ["glass"],
  },
  "glass-context": {
    blur: ["backgroundBlur"],
    "blur-no-fill": ["backgroundBlur"],
    glass: ["glass"],
    "glass-fill": ["glass"],
    "glass-over-inside": ["glass"],
    knob: ["glass"],
    button: ["glass"],
    "blur-text": ["backgroundBlur"],
    "blur-text-dodge": ["backgroundBlur"],
    "blur-text-faint": ["backgroundBlur"],
  },
  "glass-alpha": {
    "glass-none": ["glass"],
    "glass-fill": ["glass"],
    "glass-half": ["glass"],
    "glass-half-fill": ["glass"],
    "glass-faint": ["glass"],
    "glass-faint-multiply": ["glass"],
    "glass-light-none": ["glass"],
    "glass-frost-half": ["glass"],
    "glass-bend-half": ["glass"],
    "glass-near-black": ["glass"],
    button: ["glass"],
    "button-no-shadows": ["glass"],
    knob: ["glass"],
    "knob-no-specular": ["glass"],
    "blur-dark-material": ["backgroundBlur"],
    "blur-light-material": ["backgroundBlur"],
    "blur-no-fill-half": ["backgroundBlur"],
    "blur-dark-half": ["backgroundBlur"],
    "blur-burn-material": ["backgroundBlur"],
  },
};
/** Suites whose every cell needs a phase 3 feature (glass, masks, grain). */
const PHASE_3 = new Set([
  "glass",
  "glass-dark",
  "glass-ellipses",
  "glass-probe",
  "glass-probe-2",
  "glass-stack",
  "masks",
  "grain",
]);
/**
 * Suites gated against the live current canvas renderer baseline (decision 0040 replacement gate:
 * mean not worse by more than 0.01, worst 32 x 32 tile not worse by more than 1, alpha not worse).
 */
const REPLACEMENT_SUITES = new Set(["shadows", "blurs", "linear-blends"]);

/**
 * Minimum drawn-cell count per supported suite so a regression or accidental fallback cannot turn
 * a suite silently empty while staying green.
 */
const MIN_DRAWN: Record<string, number> = {
  strokes: 17,
  fills: 10,
  corners: 20,
  diamonds: 6,
  "text-strokes": 4,
  text: 19,
  "text-overlap": 3,
  "text-ranges": 3,
  lists: 6,
  "vertical-trim": 12,
  shadows: 15,
  blurs: 4,
  "linear-blends": 19,
};

const WANT_BACKENDS = (process.env.ENGINE_PARITY_BACKENDS ?? "gpu,webgl")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!process.env.ENGINE_BROWSER || process.env.ENGINE_BROWSER === "chromium") {
  test.use({
    launchOptions: {
      args: [
        "--enable-unsafe-webgpu",
        "--enable-unsafe-swiftshader",
        ...(process.env.ENGINE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
      ],
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    },
  });
}

type GpuBackend = "gpu" | "webgl";

type Engine = {
  drawpaneEngine: {
    render(o: {
      pageId: string;
      rect: { x: number; y: number; width: number; height: number };
      scale: number;
      width: number;
      height: number;
      backend: "cpu" | "gpu" | "webgl";
      compatibility?: boolean;
      ids?: string[];
      background?: [number, number, number, number];
    }): Promise<{
      ok: boolean;
      error?: string;
      code?: number;
      rgba?: string;
      unsupported: Record<string, string[]>;
      gpu?: { adapter: string; backend: "webgpu" | "webgl2"; fallback: boolean } | null;
    }>;
    gpu(
      compatibility?: boolean,
      backend?: "gpu" | "webgl",
    ): Promise<
      | { adapter: string; backend: "webgpu" | "webgl2"; fallback: boolean; details: string }
      | { error: string }
    >;
    list(
      pageId: string,
      ids?: string[],
    ): { list: string; unsupported: Record<string, string[]>; records: number };
    presentCheck(o: {
      backend: "gpu" | "webgl";
      compatibility?: boolean;
      width: number;
      height: number;
      backgrounds: Array<[number, number, number, number]>;
    }): Promise<{
      ok: boolean;
      error?: string;
      gpu?: { adapter: string; backend: "webgpu" | "webgl2"; fallback: boolean } | null;
      samples?: Array<{
        presented: boolean;
        topLeftScreen: number[];
        topLeftReadback: number[];
        bottomRightScreen: number[];
        bottomRightReadback: number[];
        bytes: number;
      }>;
    }>;
  };
  drawpane: { s: { pageId: string }; doc: { childIds(id: string): string[] } };
  drawpaneParity: {
    render(
      id: string,
      rect: { x: number; y: number; width: number; height: number },
      scale: number,
      width: number,
      height: number,
    ): Promise<{ png: string }>;
  };
};

interface CellResult {
  readonly cell: string;
  readonly status: "drawn" | "fallback";
  readonly reasons?: string[];
  readonly figmaCpu?: number;
  readonly figmaGpu?: number;
  readonly figmaWebgl?: number;
  readonly figmaCanvas?: number;
  readonly limit?: number;
  readonly cpuGpu?: ReturnType<typeof score> extends infer S ? Omit<S & object, "heat"> : never;
  readonly cpuWebgl?: ReturnType<typeof score> extends infer S ? Omit<S & object, "heat"> : never;
  readonly alpha?: {
    cpu: Omit<ReturnType<typeof score>, "heat">;
    gpu?: Omit<ReturnType<typeof score>, "heat">;
    webgl?: Omit<ReturnType<typeof score>, "heat">;
    canvas?: Omit<ReturnType<typeof score>, "heat">;
  };
  readonly workerIdentical?: boolean;
}

const strip = <T extends { heat: unknown }>(s: T): Omit<T, "heat"> => {
  const { heat: _, ...rest } = s;
  return rest;
};

test.describe("Render engine parity", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;
  const all: Record<string, CellResult[]> = {};
  const report: string[] = [];
  const adapters: Partial<Record<GpuBackend, string>> = {};
  let activeBackends: Array<{ backend: GpuBackend; compatibility: boolean }> | null = null;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const port = Number(process.env.ENGINE_PARITY_PORT ?? 8974);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
    await instance.page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    if (!WANT_BACKENDS.includes("auto")) {
      const compat = process.env.ENGINE_PARITY_COMPAT === "1";
      activeBackends = WANT_BACKENDS.filter(
        (b): b is GpuBackend => b === "gpu" || b === "webgl",
      ).map((backend) => ({ backend, compatibility: backend === "gpu" && compat }));
    }
  });

  test.afterAll(async () => {
    await instance?.stop();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, "scores.json"),
      `${JSON.stringify({ adapter: adapters.gpu ?? adapters.webgl ?? "", adapters, suites: all }, null, 2)}\n`,
    );
    const adapterSummary = Object.entries(adapters)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ");
    writeFileSync(
      join(OUT, "index.html"),
      `<!doctype html><meta charset="utf-8"><title>Engine parity</title><style>body{font:13px system-ui;margin:24px;background:#f4f3ef}img{width:200px;display:block}td,th{padding:4px 8px;vertical-align:top;text-align:left}small{color:#666}</style><h1>Render engine parity</h1><p>GPU adapters: ${adapterSummary} (SwiftShader timings are not representative). Figma, the engine on the CPU and on each GPU backend, and CPU against GPU.</p>${report.join("")}`,
    );
  });

  for (const suite of suites) {
    test(`${suite.suite}: ${suite.about}`, async () => {
      test.setTimeout(300_000);
      const page = instance.page;
      const grid = gridSize(suite);
      await page.setViewportSize({
        width: Math.min(2000, grid.width + 200),
        height: Math.min(1400, grid.height + 200),
      });
      await page.goto("/");
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      const frames = await build(page, suite);
      await waitForFonts(page, suite);
      await page.waitForTimeout(500);
      const clear = suite.background === "none" || suite.export !== undefined;
      const pageId = await page.evaluate(() => (window as unknown as Engine).drawpane.s.pageId);
      // Which layers each cell holds, to tell its fallbacks from another cell's.
      const members = await page.evaluate((frames) => {
        const e = (window as unknown as Engine).drawpane;
        return frames.map((f) => {
          const out: string[] = [];
          const visit = (id: string) => {
            out.push(id);
            for (const c of e.doc.childIds(id)) visit(c);
          };
          visit(f);
          return out;
        });
      }, frames);
      const workerModule = await loadNodeEngine("worker");
      if (!activeBackends) {
        const probe = await page.evaluate(async () => {
          const eng = (window as unknown as Engine).drawpaneEngine;
          const tries: Array<{ backend: GpuBackend; compatibility: boolean }> = [
            { backend: "gpu", compatibility: false },
            { backend: "gpu", compatibility: true },
            { backend: "webgl", compatibility: false },
          ];
          let software: {
            backend: GpuBackend;
            compatibility: boolean;
            info: { adapter: string; backend: "webgpu" | "webgl2"; fallback: boolean };
          } | null = null;
          for (const t of tries) {
            const info = await eng.gpu(t.compatibility, t.backend);
            if ("error" in info) continue;
            if (!info.fallback) return { ...t, info };
            software ??= { ...t, info };
          }
          return software;
        });
        if (!probe) throw new Error("No working GPU backend (WebGPU or WebGL2) in auto mode");
        activeBackends = [{ backend: probe.backend, compatibility: probe.compatibility }];
        adapters[probe.backend] =
          `${probe.info.adapter}${probe.info.fallback ? " (software)" : ""}`;
      }

      const results: CellResult[] = [];
      const failures: string[] = [];
      const rows: string[] = [];
      for (const [i, cell] of suite.cells.entries()) {
        const golden = join(ROOT, "goldens", suite.suite, `${cell.id}.png`);
        if (!existsSync(golden)) {
          failures.push(`${cell.id}: missing Figma golden at ${golden}`);
          continue;
        }
        const expectedFallback = EXPECTED_CELL_FALLBACKS[suite.suite]?.[cell.id];
        const rect = exportRect(suite, i);
        const width = rect.width * SCALE;
        const height = rect.height * SCALE;
        const background: [number, number, number, number] = clear ? [0, 0, 0, 0] : [1, 1, 1, 1];
        // Each cell drawn alone, its frame and what's in it, on the page's background: the engine
        // refuses a page holding anything it doesn't draw whole (anywhere on it), so a cell is its
        // own list, as an export of it is.
        const opts = {
          pageId,
          rect,
          scale: SCALE,
          width,
          height,
          background,
          ids: [frames[i] as string],
        };
        const cpu = await page.evaluate(
          (o) => (window as unknown as Engine).drawpaneEngine.render({ ...o, backend: "cpu" }),
          opts,
        );
        const mine = new Set(members[i]);
        const reasons = Object.entries(cpu.unsupported)
          .filter(([, ids]) => ids.some((id) => mine.has(id)))
          .map(([name]) => name)
          .sort();
        if (!cpu.ok) {
          // Refused: it must be for what the builder flagged in this cell, and allowed here.
          if (cpu.code !== 5 || (reasons.length === 0 && !PHASE_3.has(suite.suite)))
            failures.push(`${cell.id}: refused without a reason it flagged (${cpu.error})`);
          else if (!PHASE_3.has(suite.suite)) {
            if (!expectedFallback)
              failures.push(
                `${cell.id}: unexpected fallback (${reasons.join(", ")}) on a drawable cell`,
              );
            else {
              const want = [...expectedFallback].sort();
              if (reasons.length !== want.length || reasons.some((r, k) => r !== want[k]))
                failures.push(
                  `${cell.id}: fallback reasons [${reasons.join(", ")}] differ from expected [${want.join(", ")}]`,
                );
            }
          }
          results.push({ cell: cell.id, status: "fallback", reasons });
          rows.push(
            `<tr><th>${cell.id}<br><small>falls back: ${reasons.join(", ")}</small></th></tr>`,
          );
          continue;
        }
        if (!cpu.rgba) {
          failures.push(`${cell.id}: CPU render returned no pixels`);
          continue;
        }
        if (expectedFallback)
          failures.push(
            `${cell.id}: drew cleanly, remove from EXPECTED_CELL_FALLBACKS (expected ${expectedFallback.join(", ")})`,
          );
        const theirs = await decodePng(page, golden);
        expect(theirs.width, `${cell.id} golden size`).toBe(width);
        // The canvas renderer's metric, as parity.spec.ts records thresholds with it.
        const figma = async (ours: string) =>
          clear
            ? await Promise.all(
                [255, 0].map((g) =>
                  compare(page, over(ours, g), over(theirs.data, g), width, height, suite.blur),
                ),
              ).then(([a, b]) => Math.round((((a?.mean ?? 0) + (b?.mean ?? 0)) / 2) * 100) / 100)
            : (await compare(page, ours, theirs.data, width, height, suite.blur)).mean;
        const figmaCpu = await figma(cpu.rgba);
        // The two-shadow card exercises accumulated error from analytic shadow masks.
        const limit =
          suite.suite === "shadows" && cell.id === "drop-layered"
            ? 0.23
            : recorded[suite.suite]?.[cell.id];
        const figmaPx = Buffer.from(theirs.data, "base64");
        const cpuPx = Buffer.from(cpu.rgba, "base64");
        const vsFigma = score(cpuPx, figmaPx, width, height);
        if (limit !== undefined && figmaCpu > limit)
          failures.push(`${cell.id}: CPU ${figmaCpu} from Figma (limit ${limit})`);

        let figmaGpu: number | undefined;
        let figmaWebgl: number | undefined;
        let vsFigmaGpu: ReturnType<typeof score> | undefined;
        let vsFigmaWebgl: ReturnType<typeof score> | undefined;
        let cpuGpu: Omit<ReturnType<typeof score>, "heat"> | undefined;
        let cpuWebgl: Omit<ReturnType<typeof score>, "heat"> | undefined;
        const backendImgs: string[] = [];
        const backendNotes: string[] = [];

        for (const { backend, compatibility } of activeBackends) {
          const label = backend === "webgl" ? "WebGL2" : "WebGPU";
          const out = await page.evaluate(
            (o) => (window as unknown as Engine).drawpaneEngine.render(o),
            { ...opts, backend, compatibility },
          );
          const expectedBackend = backend === "webgl" ? "webgl2" : "webgpu";
          if (out.gpu)
            adapters[backend] = `${out.gpu.adapter}${out.gpu.fallback ? " (software)" : ""}`;
          if (!out.ok || !out.rgba) {
            failures.push(`${cell.id}: ${label} refused what the CPU drew (${out.error})`);
            continue;
          }
          if (out.gpu?.backend !== expectedBackend) {
            failures.push(
              `${cell.id}: expected backend ${expectedBackend}, got ${out.gpu?.backend ?? "none"}`,
            );
            continue;
          }
          const f = await figma(out.rgba);
          const px = Buffer.from(out.rgba, "base64");
          const cg = score(cpuPx, px, width, height);
          const vf = score(px, figmaPx, width, height);
          const worse = outsideTolerance(cg);
          if (worse.length > 0)
            failures.push(`${cell.id}: CPU against ${label} ${worse.join(", ")}`);
          if (limit !== undefined && f > limit)
            failures.push(`${cell.id}: ${label} ${f} from Figma (limit ${limit})`);
          if (backend === "gpu") {
            figmaGpu = f;
            vsFigmaGpu = vf;
            cpuGpu = strip(cg);
          } else {
            figmaWebgl = f;
            vsFigmaWebgl = vf;
            cpuWebgl = strip(cg);
          }
          backendNotes.push(
            `CPU/${label}: mean ${cg.mean.toFixed(3)} · p99 ${cg.p99} · worst tile ${cg.worstTile.toFixed(2)}`,
          );
          backendImgs.push(
            `<td><img src="${await encodePng(page, out.rgba, width, height)}"></td>`,
          );
        }
        let figmaCanvas: number | undefined;
        let vsFigmaCanvas: ReturnType<typeof score> | undefined;
        if (REPLACEMENT_SUITES.has(suite.suite)) {
          const canvasRgba = await page.evaluate(
            async ({ id, rect, scale, width, height }) => {
              const p = (window as unknown as Engine).drawpaneParity;
              const { png } = await p.render(id, rect, scale, width, height);
              const bytes = Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0));
              const img = await createImageBitmap(new Blob([bytes], { type: "image/png" }), {
                premultiplyAlpha: "none",
              });
              const c = new OffscreenCanvas(width, height);
              const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
              ctx.drawImage(img, 0, 0);
              const data = ctx.getImageData(0, 0, width, height).data;
              let s = "";
              for (let j = 0; j < data.length; j += 0x8000)
                s += String.fromCharCode(...data.subarray(j, j + 0x8000));
              return btoa(s);
            },
            { id: frames[i] as string, rect, scale: SCALE, width, height },
          );
          figmaCanvas = await figma(canvasRgba);
          vsFigmaCanvas = score(Buffer.from(canvasRgba, "base64"), figmaPx, width, height);
          if (figmaCpu > figmaCanvas + 0.01)
            failures.push(
              `${cell.id}: CPU ${figmaCpu} regresses past live canvas ${figmaCanvas} (+0.01 gate)`,
            );
          if (figmaGpu !== undefined && figmaGpu > figmaCanvas + 0.01)
            failures.push(
              `${cell.id}: WebGPU ${figmaGpu} regresses past live canvas ${figmaCanvas} (+0.01 gate)`,
            );
          if (figmaWebgl !== undefined && figmaWebgl > figmaCanvas + 0.01)
            failures.push(
              `${cell.id}: WebGL2 ${figmaWebgl} regresses past live canvas ${figmaCanvas} (+0.01 gate)`,
            );
          if (suite.blur === undefined) {
            if (vsFigma.worstTile > vsFigmaCanvas.worstTile + 1.0)
              failures.push(
                `${cell.id}: CPU worst tile ${vsFigma.worstTile.toFixed(2)} regresses past canvas ${vsFigmaCanvas.worstTile.toFixed(2)} (+1.0 gate)`,
              );
            if (vsFigmaGpu && vsFigmaGpu.worstTile > vsFigmaCanvas.worstTile + 1.0)
              failures.push(
                `${cell.id}: WebGPU worst tile ${vsFigmaGpu.worstTile.toFixed(2)} regresses past canvas ${vsFigmaCanvas.worstTile.toFixed(2)} (+1.0 gate)`,
              );
            if (vsFigmaWebgl && vsFigmaWebgl.worstTile > vsFigmaCanvas.worstTile + 1.0)
              failures.push(
                `${cell.id}: WebGL2 worst tile ${vsFigmaWebgl.worstTile.toFixed(2)} regresses past canvas ${vsFigmaCanvas.worstTile.toFixed(2)} (+1.0 gate)`,
              );
            if (vsFigma.alphaMean > vsFigmaCanvas.alphaMean + 0.05)
              failures.push(
                `${cell.id}: CPU alpha mean ${vsFigma.alphaMean.toFixed(3)} regresses past canvas ${vsFigmaCanvas.alphaMean.toFixed(3)}`,
              );
            if (vsFigmaGpu && vsFigmaGpu.alphaMean > vsFigmaCanvas.alphaMean + 0.05)
              failures.push(
                `${cell.id}: WebGPU alpha mean ${vsFigmaGpu.alphaMean.toFixed(3)} regresses past canvas ${vsFigmaCanvas.alphaMean.toFixed(3)}`,
              );
            if (vsFigmaWebgl && vsFigmaWebgl.alphaMean > vsFigmaCanvas.alphaMean + 0.05)
              failures.push(
                `${cell.id}: WebGL2 alpha mean ${vsFigmaWebgl.alphaMean.toFixed(3)} regresses past canvas ${vsFigmaCanvas.alphaMean.toFixed(3)}`,
              );
          }
        }
        // The Worker's build draws the same list bit for bit (an engine of its own per cell: each
        // cell's list is a fresh list from revision 0).
        const cellList = await page.evaluate(
          ({ pageId, ids }) => (window as unknown as Engine).drawpaneEngine.list(pageId, ids),
          { pageId, ids: [frames[i] as string] },
        );
        const worker = new RenderEngine(workerModule);
        const applied = worker.apply(Uint8Array.from(Buffer.from(cellList.list, "base64")));
        expect(applied.ok, applied.ok ? "" : applied.message).toBe(true);
        const w = worker.renderCpu(
          width,
          height,
          { zoom: SCALE, x: -rect.x * SCALE, y: -rect.y * SCALE, dpr: 1 },
          background,
          false,
        );
        const workerIdentical = w.ok && Buffer.from(w.value.pixels).equals(cpuPx);
        worker.dispose();
        if (!workerIdentical)
          failures.push(
            `${cell.id}: the Worker build's pixels differ from the browser build's CPU path`,
          );
        results.push({
          cell: cell.id,
          status: "drawn",
          figmaCpu,
          ...(figmaGpu !== undefined ? { figmaGpu } : {}),
          ...(figmaWebgl !== undefined ? { figmaWebgl } : {}),
          ...(figmaCanvas !== undefined ? { figmaCanvas } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(cpuGpu ? { cpuGpu } : {}),
          ...(cpuWebgl ? { cpuWebgl } : {}),
          alpha: {
            cpu: strip(vsFigma),
            ...(vsFigmaGpu ? { gpu: strip(vsFigmaGpu) } : {}),
            ...(vsFigmaWebgl ? { webgl: strip(vsFigmaWebgl) } : {}),
            ...(vsFigmaCanvas ? { canvas: strip(vsFigmaCanvas) } : {}),
          },
          workerIdentical,
        });
        const img = async (b64: string) => encodePng(page, b64, width, height);
        const figmaLine = [
          `CPU ${figmaCpu}`,
          ...(figmaGpu !== undefined ? [`WebGPU ${figmaGpu}`] : []),
          ...(figmaWebgl !== undefined ? [`WebGL2 ${figmaWebgl}`] : []),
          ...(figmaCanvas !== undefined ? [`canvas ${figmaCanvas}`] : []),
          ...(limit !== undefined ? [`max ${limit}`] : []),
        ].join(" · ");
        rows.push(
          `<tr><th>${cell.id}<br><small>Figma: ${figmaLine}<br>alpha-aware: mean ${vsFigma.mean.toFixed(2)} · alpha ${vsFigma.alphaMean.toFixed(2)} · worst tile ${vsFigma.worstTile.toFixed(1)}${vsFigmaCanvas ? ` (canvas ${vsFigmaCanvas.worstTile.toFixed(1)})` : ""}<br>${backendNotes.join("<br>")}</small></th><td><img src="data:image/png;base64,${readFileSync(golden).toString("base64")}"></td><td><img src="${await img(cpu.rgba)}"></td>${backendImgs.join("")}</tr>`,
        );
      }
      all[suite.suite] = results;
      const drawn = results.filter((r) => r.status === "drawn");
      const mean = (k: "figmaCpu" | "figmaGpu" | "figmaWebgl") => {
        const vals = drawn.map((r) => r[k]).filter((v): v is number => v !== undefined);
        return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      const summaryParts = [`CPU ${(mean("figmaCpu") ?? 0).toFixed(2)}`];
      const mg = mean("figmaGpu");
      const mw = mean("figmaWebgl");
      if (mg !== null) summaryParts.push(`WebGPU ${mg.toFixed(2)}`);
      if (mw !== null) summaryParts.push(`WebGL2 ${mw.toFixed(2)}`);
      const cols = activeBackends
        .map((b) => `<th>${b.backend === "webgl" ? "WebGL2" : "WebGPU"}</th>`)
        .join("");
      report.push(
        `<h2>${suite.suite} <small>${drawn.length} drawn, ${results.length - drawn.length} fall back · mean from Figma ${summaryParts.join(", ")}</small></h2><table><tr><th></th><th>Figma</th><th>CPU</th>${cols}</tr>${rows.join("")}</table>`,
      );
      console.log(
        `${suite.suite}: ${drawn.length} drawn (Figma ${summaryParts.join(", ")}), ${results.length - drawn.length} fall back`,
      );
      const minDrawn = MIN_DRAWN[suite.suite];
      if (minDrawn !== undefined && drawn.length < minDrawn) {
        failures.push(
          `${suite.suite}: expected at least ${minDrawn} drawn cells, got ${drawn.length}`,
        );
      }
      expect(failures, `${suite.suite}: engine parity`).toEqual([]);
    });
  }

  test("visible canvas presentation matches readback on active WebGL2 surface", async () => {
    const page = instance.page;
    await page.goto("/");
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 15_000,
    });
    const checkWebgl = !activeBackends || activeBackends.some((b) => b.backend === "webgl");
    if (!checkWebgl) return;
    const res = await page.evaluate(() =>
      (window as unknown as Engine).drawpaneEngine.presentCheck({
        backend: "webgl",
        width: 65,
        height: 17,
        backgrounds: [
          [0.25, 0.5, 0.75, 1],
          [0.25, 0.5, 0.75, 0.5],
        ],
      }),
    );
    expect(res.ok, res.error).toBe(true);
    expect(res.gpu?.backend).toBe("webgl2");
    expect(res.samples).toHaveLength(2);
    const [opaque, translucent] = res.samples ?? [];
    expect(opaque?.presented).toBe(true);
    expect(opaque?.bytes).toBe(65 * 17 * 4);
    // Asymmetric top-left red rect verifies orientation (not vertically flipped) and surface blit.
    expect(opaque?.topLeftScreen).toEqual([255, 0, 0, 255]);
    expect(opaque?.topLeftReadback).toEqual([255, 0, 0, 255]);
    expect(opaque?.bottomRightScreen).toEqual(opaque?.bottomRightReadback);
    expect(translucent?.presented).toBe(true);
    expect(translucent?.bytes).toBe(65 * 17 * 4);
    expect(translucent?.topLeftScreen).toEqual([255, 0, 0, 255]);
    expect(translucent?.topLeftReadback).toEqual([255, 0, 0, 255]);
    // Translucent background unpremultiplies cleanly in readback (within 1 LSB of 64, 128, 191, 128).
    expect(translucent?.bottomRightReadback[3]).toBeGreaterThanOrEqual(127);
    expect(translucent?.bottomRightReadback[3]).toBeLessThanOrEqual(128);
  });
});
