/**
 * Canvas performance against the PRD's budget: p95 frame time under 16 ms
 * while panning a 10,000-layer file. Builds a realistic file (400 cards of
 * 25 layers: boards, text, shapes, icons) on a throwaway instance, pans it
 * for 240 frames at three zoom levels, and reports what drawing took.
 *
 * Prints the numbers always; fails over budget only with BENCH_ENFORCE=1,
 * since headless browsers without a GPU are far slower than a laptop.
 *
 * BENCH_RENDERER=engine runs the same file through the render engine (decision 0040), without
 * the cards' shadows, which phase 1 doesn't draw (it would leave the page to the canvas
 * renderer); BENCH_ENGINE_PRESENT=readback where WebGPU canvases don't present. The GPU's time
 * per frame (`onSubmittedWorkDone`) is reported beside the frame times, labelled not
 * representative on a software adapter.
 * Run with `pnpm --filter @drawpane/web bench`.
 */
import { expect, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { buildFile } from "./cards";
import { pan, type Summary, summaryRow, zoom } from "./frames";

const BUDGET_MS = Number(process.env.BENCH_BUDGET_MS ?? 16);
const ENFORCE = process.env.BENCH_ENFORCE === "1";
const ENGINE = process.env.BENCH_RENDERER === "engine";

test.describe("Canvas performance", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    instance = await freshInstance(browser, { port: 8821, inspectorPort: 9361 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("pans a 10,000-layer file within budget", async () => {
    const page = instance.page;
    await page.evaluate(
      ({ engine, present }) => {
        localStorage.setItem("drawpane:debug", "1");
        localStorage.setItem("drawpane:renderer", engine ? "engine" : "canvas");
        localStorage.setItem("drawpane:engine-present", present);
      },
      {
        engine: ENGINE,
        present: process.env.BENCH_ENGINE_PRESENT === "readback" ? "readback" : "webgpu",
      },
    );
    await page.reload();
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 15_000,
    });
    const layers = await buildFile(page, 400, !ENGINE);
    expect(layers).toBe(10_000);
    // Let fonts and the first full paint settle.
    await page.waitForTimeout(1500);

    const results: Record<string, Summary> = {};
    for (const level of ["fit", 0.25, 1] as const)
      results[level === "fit" ? "pan, whole" : `pan, ${level * 100}%`] = await pan(
        page,
        level,
        240,
      );
    results["zoom, whole"] = await zoom(page, 240);

    const rows = Object.entries(results).map(([name, r]) => summaryRow(name, r));
    // With the engine: who drew, on what adapter, and the GPU's time per frame over a pan.
    const engine = ENGINE
      ? await page.evaluate(async () => {
          type View = {
            last: { supported: boolean };
            engine: {
              gpu: { adapter: string; fallback: boolean } | null;
              gpuFinished(): Promise<void>;
            };
          };
          const w = window as unknown as {
            drawpaneEngineView?: View;
            drawpane: {
              s: { camera: { pan(x: number, y: number): unknown } };
              state: { set(p: object): void };
            };
          };
          const view = w.drawpaneEngineView;
          if (!view?.last.supported)
            return { drawnBy: "canvas", adapter: view?.engine.gpu?.adapter ?? null };
          const times: number[] = [];
          for (let i = 0; i < 60; i++) {
            w.drawpane.state.set({ camera: w.drawpane.s.camera.pan(i % 30 < 15 ? 6 : -6, 3) });
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            const t = performance.now();
            await view.engine.gpuFinished();
            times.push(performance.now() - t);
          }
          times.sort((a, b) => a - b);
          const at = (q: number) =>
            Math.round((times[Math.floor(q * (times.length - 1))] ?? 0) * 10) / 10;
          return {
            drawnBy: "engine",
            adapter: view.engine.gpu?.adapter ?? null,
            software: !!view.engine.gpu?.fallback,
            gpuMs: { p50: at(0.5), p95: at(0.95), max: at(1) },
          };
        })
      : null;
    console.log(
      `\n${ENGINE ? "Engine" : "Canvas"}, 10,000 layers, ${BUDGET_MS} ms budget\n${rows.join("\n")}${engine ? `\n${JSON.stringify(engine)}${engine.software ? " (software adapter: not representative)" : ""}` : ""}\n`,
    );
    test.info().annotations.push({
      type: "bench",
      description: JSON.stringify({ ...results, ...(engine ? { engine } : {}) }),
    });
    if (ENFORCE)
      for (const [name, r] of Object.entries(results))
        expect(r.content.p95 + r.overlay.p95, `${name} p95 frame time`).toBeLessThan(BUDGET_MS);
  });
});
