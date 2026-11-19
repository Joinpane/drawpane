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
 * the cards' shadows, which the engine doesn't draw yet (it would leave the page to the canvas
 * renderer); BENCH_RENDERER=both runs the canvas renderer and then the engine on that same
 * shadowless file, in one browser; BENCH_ENGINE_PRESENT=readback where WebGPU canvases don't
 * present. The GPU's time per frame (`onSubmittedWorkDone`) is reported beside the frame times,
 * labelled not representative on a software adapter.
 * Run with `pnpm --filter @drawpane/web bench`.
 */
import { expect, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { buildFile } from "./cards";
import { pan, type Summary, summaryRow, zoom } from "./frames";

const BUDGET_MS = Number(process.env.BENCH_BUDGET_MS ?? 16);
const ENFORCE = process.env.BENCH_ENFORCE === "1";
const RENDERERS: Array<"canvas" | "engine"> =
  process.env.BENCH_RENDERER === "both"
    ? ["canvas", "engine"]
    : process.env.BENCH_RENDERER === "engine"
      ? ["engine"]
      : ["canvas"];
/** The engine draws no shadows yet: with it in the run, the cards have none. */
const SHADOWS = !RENDERERS.includes("engine");

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
    test.setTimeout(30 * 60_000);
    const page = instance.page;
    const use = (renderer: "canvas" | "engine") =>
      page.evaluate(
        ({ renderer, present }) => {
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:renderer", renderer);
          localStorage.setItem("drawpane:engine-present", present);
        },
        {
          renderer,
          present: process.env.BENCH_ENGINE_PRESENT === "readback" ? "readback" : "webgpu",
        },
      );
    // Why the engine didn't draw, if it didn't (no hardware adapter, a failure): the bench
    // reports the canvas renderer then, never hangs on it.
    await page.addInitScript(() => {
      window.addEventListener("drawpane:renderer-fallback", (e) => {
        (window as unknown as { engineFallback?: unknown }).engineFallback = (
          e as CustomEvent
        ).detail;
      });
    });
    // Each renderer gets its own copy of the file, built the same way in the same browser (a
    // file built in one session isn't reliably all there after a reload while it saves).
    for (const renderer of RENDERERS) {
      await use(renderer);
      await page.goto("/");
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      const layers = await buildFile(page, 400, SHADOWS);
      expect(layers).toBe(10_000);
      await measure(renderer);
    }
  });

  async function measure(renderer: "canvas" | "engine"): Promise<void> {
    const page = instance.page;
    const ENGINE = renderer === "engine";
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
    // With the engine: who drew, on what adapter, and where a frame's time goes. Over a pan:
    // how each frame was made (from its tiles, with stand-ins, direct or unchanged), the tiles
    // drawn, its CPU breakdown and the GPU's time. Then exact frames drawn back to back, cold
    // (every tile dropped first: what the first exact frame of a view costs) and warm (from the
    // tiles kept): encoding, the renderer, submitting, the GPU (until its work is done) and the
    // read-back (a full frame through a buffer, as headless browsers present), each on its own.
    const engine = ENGINE
      ? await page.evaluate(async () => {
          type Ms = { encode: number; render: number; submit: number; total: number };
          type View = {
            last: {
              supported: boolean;
              plan: string;
              tiles: { drawn: number; pending: number; held: number };
              breakdown: { patch: number; encode: number; render: number; submit: number };
            };
            readsBack: boolean;
            engine: {
              gpu: { adapter: string; fallback: boolean } | null;
              gpuFinished(): Promise<{ ok: boolean }>;
              gpuPixels(): Promise<{ ok: boolean }>;
              clearTiles(): void;
              renderGpu(
                w: number,
                h: number,
                c: { zoom: number; x: number; y: number; dpr: number },
                bg: readonly [number, number, number, number],
                moving: boolean,
                budgetMs: number,
              ): {
                ok: boolean;
                value?: { ms: Ms; tiles: { drawn: number }; exact: boolean; records: number };
              };
            };
          };
          const w = window as unknown as {
            drawpaneEngineView?: View;
            engineFallback?: { reason: string };
            devicePixelRatio: number;
            drawpane: {
              s: {
                camera: { x: number; y: number; zoom: number; pan(x: number, y: number): unknown };
              };
              state: { set(p: object): void };
            };
          };
          const view = w.drawpaneEngineView;
          if (view && (view as unknown as { engine: { records: number } }).engine.records < 9_000)
            throw new Error(
              `the engine holds ${(view as unknown as { engine: { records: number } }).engine.records} records, not the file's 10,000`,
            );
          if (!view?.last.supported)
            return {
              drawnBy: "canvas",
              adapter: view?.engine.gpu?.adapter ?? null,
              reason: w.engineFallback?.reason ?? (view ? "the page isn't supported" : null),
            };
          const q = (xs: number[]) => {
            const v = [...xs].sort((a, b) => a - b);
            const at = (p: number) =>
              Math.round((v[Math.floor(p * (v.length - 1))] ?? 0) * 10) / 10;
            return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
          };
          const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
          const pan = {
            gpu: [] as number[],
            encode: [] as number[],
            render: [] as number[],
            tiles: [] as number[],
          };
          const plans: Record<string, number> = {};
          for (let i = 0; i < 60; i++) {
            w.drawpane.state.set({ camera: w.drawpane.s.camera.pan(i % 30 < 15 ? 6 : -6, 3) });
            await frame();
            const t = performance.now();
            await view.engine.gpuFinished();
            pan.gpu.push(performance.now() - t);
            pan.encode.push(view.last.breakdown.encode);
            pan.render.push(view.last.breakdown.render);
            pan.tiles.push(view.last.tiles.drawn);
            plans[view.last.plan] = (plans[view.last.plan] ?? 0) + 1;
          }
          const canvas = document.querySelector("canvas");
          const width = canvas?.width ?? 1440;
          const height = canvas?.height ?? 900;
          const c = w.drawpane.s.camera;
          const camera = { zoom: c.zoom, x: c.x, y: c.y, dpr: w.devicePixelRatio };
          const exactFrames = async (cold: boolean) => {
            const out = {
              encode: [] as number[],
              render: [] as number[],
              submit: [] as number[],
              gpu: [] as number[],
              readback: [] as number[],
              tiles: [] as number[],
              records: [] as number[],
            };
            for (let i = 0; i < 12; i++) {
              if (cold) view.engine.clearTiles();
              const r = view.engine.renderGpu(width, height, camera, [1, 1, 1, 1], false, 0);
              if (!r.ok || !r.value) break;
              out.encode.push(r.value.ms.encode);
              out.render.push(r.value.ms.render);
              out.submit.push(r.value.ms.submit);
              out.tiles.push(r.value.tiles.drawn);
              out.records.push(r.value.records);
              let t = performance.now();
              await view.engine.gpuFinished();
              out.gpu.push(performance.now() - t);
              // Every other frame read back, so both costs show on their own.
              if (i % 2 === 0) {
                t = performance.now();
                await view.engine.gpuPixels();
                out.readback.push(performance.now() - t);
              }
            }
            return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, q(v)]));
          };
          const cold = await exactFrames(true);
          const warm = await exactFrames(false);
          return {
            drawnBy: "engine",
            adapter: view.engine.gpu?.adapter ?? null,
            software: !!view.engine.gpu?.fallback,
            readsBack: view.readsBack,
            frame: { width, height },
            camera,
            gpuMs: q(pan.gpu),
            pan: {
              plans,
              tiles: q(pan.tiles),
              encode: q(pan.encode),
              render: q(pan.render),
              gpu: q(pan.gpu),
            },
            exact: { cold, warm },
          };
        })
      : null;
    console.log(
      `\n${ENGINE ? "Engine" : "Canvas"}, 10,000 layers, ${BUDGET_MS} ms budget\n${rows.join("\n")}${engine ? `\n${JSON.stringify(engine)}${engine.software ? " (software adapter: not representative)" : ""}` : ""}\n`,
    );
    test.info().annotations.push({
      type: "bench",
      description: JSON.stringify({ renderer, ...results, ...(engine ? { engine } : {}) }),
    });
    if (ENFORCE)
      for (const [name, r] of Object.entries(results))
        expect(r.content.p95 + r.overlay.p95, `${name} p95 frame time`).toBeLessThan(BUDGET_MS);
  }
});
