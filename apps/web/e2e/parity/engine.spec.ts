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

/** Cells of otherwise supported suites that need what phase 1 doesn't draw, and why. */
const EXPECTED_FALLBACKS: Record<string, RegExp> = {
  fills: /^blend-/, // Non-normal blend modes: phase 3's blend kernels.
};
/** Suites whose every cell needs a phase 3 feature (effects, glass, masks, blends, grain). */
const PHASE_3 = new Set([
  "shadows",
  "blurs",
  "glass",
  "glass-alpha",
  "glass-context",
  "glass-dark",
  "glass-ellipses",
  "glass-probe",
  "glass-probe-2",
  "masks",
  "grain",
  "linear-blends",
]);

test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      ...(process.env.ENGINE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
    ],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

type Engine = {
  drawpaneEngine: {
    render(o: {
      pageId: string;
      rect: { x: number; y: number; width: number; height: number };
      scale: number;
      width: number;
      height: number;
      backend: "cpu" | "gpu";
      ids?: string[];
      background?: [number, number, number, number];
    }): Promise<{
      ok: boolean;
      error?: string;
      code?: number;
      rgba?: string;
      unsupported: Record<string, string[]>;
      gpu?: { adapter: string; fallback: boolean } | null;
    }>;
    list(
      pageId: string,
      ids?: string[],
    ): { list: string; unsupported: Record<string, string[]>; records: number };
  };
  drawpane: { s: { pageId: string }; doc: { childIds(id: string): string[] } };
};

interface CellResult {
  readonly cell: string;
  readonly status: "drawn" | "fallback";
  readonly reasons?: string[];
  readonly figmaCpu?: number;
  readonly figmaGpu?: number;
  readonly limit?: number;
  readonly cpuGpu?: ReturnType<typeof score> extends infer S ? Omit<S & object, "heat"> : never;
  readonly alpha?: { cpu: Omit<ReturnType<typeof score>, "heat"> };
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
  let adapter = "";

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const port = Number(process.env.ENGINE_PARITY_PORT ?? 8974);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
    await instance.page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
  });

  test.afterAll(async () => {
    await instance?.stop();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, "scores.json"),
      `${JSON.stringify({ adapter, suites: all }, null, 2)}\n`,
    );
    writeFileSync(
      join(OUT, "index.html"),
      `<!doctype html><meta charset="utf-8"><title>Engine parity</title><style>body{font:13px system-ui;margin:24px;background:#f4f3ef}img{width:200px;display:block}td,th{padding:4px 8px;vertical-align:top;text-align:left}small{color:#666}</style><h1>Render engine parity</h1><p>GPU adapter: ${adapter} (SwiftShader timings are not representative). Figma, the engine on the CPU and on the GPU, and the CPU against the GPU.</p>${report.join("")}`,
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
      const worker = new RenderEngine(await loadNodeEngine("worker"));

      const results: CellResult[] = [];
      const failures: string[] = [];
      const rows: string[] = [];
      for (const [i, cell] of suite.cells.entries()) {
        const golden = join(ROOT, "goldens", suite.suite, `${cell.id}.png`);
        if (!existsSync(golden)) continue;
        const rect = exportRect(suite, i);
        const width = rect.width * SCALE;
        const height = rect.height * SCALE;
        const background: [number, number, number, number] = clear ? [0, 0, 0, 0] : [1, 1, 1, 1];
        // Each cell as the canvas renderer's parity spec takes it: exported cells drawn alone
        // (the exported layer and what's in it), the others with the page under them.
        const opts = {
          pageId,
          rect,
          scale: SCALE,
          width,
          height,
          background,
          ...(clear ? { ids: [frames[i] as string] } : {}),
        };
        const cpu = await page.evaluate(
          (o) => (window as unknown as Engine).drawpaneEngine.render({ ...o, backend: "cpu" }),
          opts,
        );
        const mine = new Set(members[i]);
        const reasons = Object.entries(cpu.unsupported)
          .filter(([, ids]) => ids.some((id) => mine.has(id)))
          .map(([name]) => name);
        if (!cpu.ok) {
          // Refused: it must be for what the builder flagged in this cell, and allowed here.
          if (cpu.code !== 5 || (reasons.length === 0 && !PHASE_3.has(suite.suite)))
            failures.push(`${cell.id}: refused without a reason it flagged (${cpu.error})`);
          else if (!PHASE_3.has(suite.suite) && !EXPECTED_FALLBACKS[suite.suite]?.test(cell.id))
            failures.push(`${cell.id}: falls back (${reasons.join(", ")}) in a supported suite`);
          results.push({ cell: cell.id, status: "fallback", reasons });
          rows.push(
            `<tr><th>${cell.id}<br><small>falls back: ${reasons.join(", ")}</small></th></tr>`,
          );
          continue;
        }
        const gpu = await page.evaluate(
          (o) => (window as unknown as Engine).drawpaneEngine.render({ ...o, backend: "gpu" }),
          opts,
        );
        if (gpu.gpu) adapter = `${gpu.gpu.adapter}${gpu.gpu.fallback ? " (software)" : ""}`;
        if (!gpu.ok || !gpu.rgba || !cpu.rgba) {
          failures.push(`${cell.id}: the GPU refused what the CPU drew (${gpu.error})`);
          continue;
        }
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
        const figmaGpu = await figma(gpu.rgba);
        const limit = recorded[suite.suite]?.[cell.id];
        const cpuPx = Buffer.from(cpu.rgba, "base64");
        const gpuPx = Buffer.from(gpu.rgba, "base64");
        const cg = score(cpuPx, gpuPx, width, height);
        const vsFigma = score(cpuPx, Buffer.from(theirs.data, "base64"), width, height);
        const worse = outsideTolerance(cg);
        if (worse.length > 0) failures.push(`${cell.id}: CPU against GPU ${worse.join(", ")}`);
        if (limit !== undefined && suite.blur === undefined) {
          if (figmaCpu > limit)
            failures.push(
              `${cell.id}: CPU ${figmaCpu} from Figma (the canvas renderer may be ${limit})`,
            );
          if (figmaGpu > limit)
            failures.push(
              `${cell.id}: GPU ${figmaGpu} from Figma (the canvas renderer may be ${limit})`,
            );
        }
        // The Worker's build draws the same list bit for bit.
        const cellList = await page.evaluate(
          ({ pageId, ids }) => (window as unknown as Engine).drawpaneEngine.list(pageId, ids),
          { pageId, ids: clear ? [frames[i] as string] : undefined },
        );
        expect(worker.apply(Uint8Array.from(Buffer.from(cellList.list, "base64"))).ok).toBe(true);
        const w = worker.renderCpu(
          width,
          height,
          { zoom: SCALE, x: -rect.x * SCALE, y: -rect.y * SCALE, dpr: 1 },
          background,
          false,
        );
        const workerIdentical = w.ok && Buffer.from(w.value.pixels).equals(cpuPx);
        if (!workerIdentical)
          failures.push(
            `${cell.id}: the Worker build's pixels differ from the browser build's CPU path`,
          );
        results.push({
          cell: cell.id,
          status: "drawn",
          figmaCpu,
          figmaGpu,
          ...(limit !== undefined ? { limit } : {}),
          cpuGpu: strip(cg),
          alpha: { cpu: strip(vsFigma) },
          workerIdentical,
        });
        const img = async (b64: string) => encodePng(page, b64, width, height);
        rows.push(
          `<tr><th>${cell.id}<br><small>Figma: CPU ${figmaCpu} · GPU ${figmaGpu}${limit !== undefined ? ` · canvas may be ${limit}` : ""}<br>alpha-aware: mean ${vsFigma.mean.toFixed(2)} · alpha ${vsFigma.alphaMean.toFixed(2)} · worst tile ${vsFigma.worstTile.toFixed(1)}<br>CPU/GPU: mean ${cg.mean.toFixed(3)} · p99 ${cg.p99} · worst tile ${cg.worstTile.toFixed(2)}</small></th><td><img src="data:image/png;base64,${readFileSync(golden).toString("base64")}"></td><td><img src="${await img(cpu.rgba)}"></td><td><img src="${await img(gpu.rgba)}"></td></tr>`,
        );
      }
      worker.dispose();
      all[suite.suite] = results;
      const drawn = results.filter((r) => r.status === "drawn");
      const mean = (k: "figmaCpu" | "figmaGpu") =>
        drawn.reduce((a, r) => a + (r[k] ?? 0), 0) / Math.max(1, drawn.length);
      report.push(
        `<h2>${suite.suite} <small>${drawn.length} drawn, ${results.length - drawn.length} fall back · mean from Figma CPU ${mean("figmaCpu").toFixed(2)}, GPU ${mean("figmaGpu").toFixed(2)}</small></h2><table><tr><th></th><th>Figma</th><th>CPU</th><th>GPU</th></tr>${rows.join("")}</table>`,
      );
      console.log(
        `${suite.suite}: ${drawn.length} drawn (Figma CPU ${mean("figmaCpu").toFixed(2)}, GPU ${mean("figmaGpu").toFixed(2)}), ${results.length - drawn.length} fall back`,
      );
      expect(failures, `${suite.suite}: engine parity`).toEqual([]);
    });
  }
});
