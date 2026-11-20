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
import { benchShadows, buildFile } from "./cards";
import {
  captureRendererState,
  installFallbackRecorder,
  type ScenarioCheckpoint,
  verifyEngineBenchmark,
  verifyScenarioCheckpoint,
} from "./engine-gate";
import { pan, type Settles, type Summary, settles, settlesRow, summaryRow, zoom } from "./frames";

const BUDGET_MS = Number(process.env.BENCH_BUDGET_MS ?? 16);
const ENFORCE = process.env.BENCH_ENFORCE === "1";
const RENDERER_ENV = process.env.BENCH_RENDERER ?? "canvas";
const RENDERERS: string[] = RENDERER_ENV === "both" ? ["canvas", "engine"] : [RENDERER_ENV];
const SHADOWS = benchShadows();
const PORT = Number(process.env.BENCH_PORT ?? 8821);

// A trace captures full-viewport screencast frames during panning, which distorts frame
// intervals and can exhaust Firefox WebGPU/Xvfb memory over 960 high-DPR pan/zoom frames.
test.use({ trace: "off" });

test.describe("Canvas performance", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    instance = await freshInstance(browser, { port: PORT, inspectorPort: PORT + 540 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("pans a 10,000-layer file within budget", async () => {
    test.setTimeout(30 * 60_000);
    const page = instance.page;
    const use = (renderer: string) =>
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
    await installFallbackRecorder(page);
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
      await measure(renderer, layers);
    }
  });

  async function measure(renderer: string, layers: number): Promise<void> {
    const page = instance.page;
    const ENGINE = renderer !== "canvas";
    // Let fonts and the first full paint settle.
    await page.waitForTimeout(1500);
    const beforeRenderer = await captureRendererState(page);

    const results: Record<string, Summary> = {};
    const scenarioPresentation: Record<
      string,
      {
        submittedFramesDelta: number;
        presentedFramesDelta: number;
        fallbackFramesDelta: number;
        compositedNonBlank: boolean;
        compositedNonBackgroundRatio: number;
        deltaFromPrevious: number | null;
      }
    > = {};
    let lastCheckpoint: ScenarioCheckpoint | null = null;
    for (const level of ["fit", 0.25, 1] as const) {
      const name = level === "fit" ? "pan, whole" : `pan, ${level * 100}%`;
      const sBefore = ENGINE ? await captureRendererState(page, { sampleSurface: true }) : null;
      results[name] = await pan(page, level, 240);
      if (ENGINE && sBefore) {
        // Per-scenario presentation and pixel checkpoint runs outside the timed pan loop.
        // The very first scenario compares against its pre-pan baseline (`sBefore.engineSurface`).
        const cp = await verifyScenarioCheckpoint(page, sBefore, name, {
          minSubmitted: 200,
          minPresented: 60,
          previous: lastCheckpoint,
        });
        lastCheckpoint = cp;
        scenarioPresentation[name] = {
          submittedFramesDelta: cp.submittedFramesDelta,
          presentedFramesDelta: cp.presentedFramesDelta,
          fallbackFramesDelta: cp.fallbackFramesDelta,
          compositedNonBlank: cp.compositedNonBlank,
          compositedNonBackgroundRatio: cp.compositedNonBackgroundRatio,
          deltaFromPrevious: cp.deltaFromPrevious,
        };
      }
    }
    const zBefore = ENGINE ? await captureRendererState(page, { sampleSurface: true }) : null;
    results["zoom, whole"] = await zoom(page, 240);
    if (ENGINE && zBefore) {
      const cp = await verifyScenarioCheckpoint(page, zBefore, "zoom, whole", {
        minSubmitted: 200,
        minPresented: 60,
        previous: lastCheckpoint,
      });
      lastCheckpoint = cp;
      scenarioPresentation["zoom, whole"] = {
        submittedFramesDelta: cp.submittedFramesDelta,
        presentedFramesDelta: cp.presentedFramesDelta,
        fallbackFramesDelta: cp.fallbackFramesDelta,
        compositedNonBlank: cp.compositedNonBlank,
        compositedNonBackgroundRatio: cp.compositedNonBackgroundRatio,
        deltaFromPrevious: cp.deltaFromPrevious,
      };
    }

    const presentation = ENGINE
      ? await verifyEngineBenchmark(page, beforeRenderer, "bench/canvas.spec.ts", {
          minSubmittedFrames: 800,
          minFrames: 240,
          checkCameraDelta: true,
        })
      : null;

    const rows = Object.entries(results).map(([name, r]) => summaryRow(name, r));
    // Settling, gesture after gesture: from each one's latest input to the exact frame drawn,
    // finished on the GPU and shown (p50, p95, worst; timeouts counted apart).
    const settled: Record<string, Settles> = {};
    const card = await page.evaluate(() => {
      const e = (
        window as unknown as {
          drawpane: { s: { pageId: string }; doc: { childIds(id: string): string[] } };
        }
      ).drawpane;
      return e.doc.childIds(e.s.pageId)[0] as string;
    });
    for (const [name, kind, level] of [
      ["zoom at fit", "zoom", "fit"],
      ["pan at fit", "pan", "fit"],
      ["pan at 100%", "pan", 1],
      ["drag at 100%", "drag", 1],
    ] as const) {
      await page.evaluate(
        async ({ level, card }) => {
          const e = (
            window as unknown as {
              drawpane: {
                zoomToFit(): void;
                zoomTo(z: number): void;
                centerOn(p: { x: number; y: number }): void;
                doc: { get(id: string): { props: Record<string, unknown> } | undefined };
              };
            }
          ).drawpane;
          if (level === "fit") e.zoomToFit();
          else {
            e.zoomTo(level);
            const p = e.doc.get(card)?.props ?? {};
            e.centerOn({ x: Number(p.x ?? 0) + 160, y: Number(p.y ?? 0) + 110 });
          }
          const f = (window as unknown as { drawpaneFrames: { exact: boolean } }).drawpaneFrames;
          const t = performance.now();
          while (!f.exact && performance.now() - t < 10_000)
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
        },
        { level, card },
      );
      settled[name] = await settles(page, kind, 10, card);
      rows.push(settlesRow(settled[name]));
    }
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
            backend: "webgpu" | "webgl2" | "cpu-worker";
            adapter: string;
            last: {
              supported: boolean;
              plan: string;
              tiles: { drawn: number; pending: number; held: number };
              breakdown: { patch: number; encode: number; render: number; submit: number };
            };
            readsBack: boolean;
            engine: {
              gpu: { adapter: string; fallback: boolean } | null;
              records: number;
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
            } | null;
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
          if (view?.engine && view.engine.records < 9_000)
            throw new Error(
              `the engine holds ${view.engine.records} records, not the file's 10,000`,
            );
          if (!view?.last.supported)
            return {
              drawnBy: "canvas",
              backend: view?.backend ?? null,
              adapter: view?.adapter ?? view?.engine?.gpu?.adapter ?? null,
              reason: w.engineFallback?.reason ?? (view ? "the page isn't supported" : null),
            };
          if (!view.engine) {
            return {
              drawnBy: "engine",
              backend: view.backend,
              adapter: view.adapter,
              software: true,
              readsBack: false,
            };
          }
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
            const eng = view.engine;
            if (!eng) break;
            w.drawpane.state.set({ camera: w.drawpane.s.camera.pan(i % 30 < 15 ? 6 : -6, 3) });
            await frame();
            const t = performance.now();
            const fin = await eng.gpuFinished();
            if (!fin.ok) break;
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
            // Yield one animation frame before each whole-frame render so swapchain textures
            // presented by `renderGpu` are released by the browser compositor (avoids Firefox
            // WebGPU swapchain OOM when submitting many 2880x1800 frames inside one tick).
            for (let i = 0; i < 10; i++) {
              await frame();
              const eng = view.engine;
              if (!eng) break;
              if (cold) eng.clearTiles();
              const r = eng.renderGpu(width, height, camera, [1, 1, 1, 1], false, 0);
              if (!r.ok || !r.value) break;
              out.encode.push(r.value.ms.encode);
              out.render.push(r.value.ms.render);
              out.submit.push(r.value.ms.submit);
              out.tiles.push(r.value.tiles.drawn);
              out.records.push(r.value.records);
              let t = performance.now();
              const fin = await eng.gpuFinished();
              if (!fin.ok) break;
              out.gpu.push(performance.now() - t);
              // Every other frame read back, so both costs show on their own.
              if (i % 2 === 0) {
                t = performance.now();
                const px = await eng.gpuPixels();
                if (!px.ok) break;
                out.readback.push(performance.now() - t);
              }
            }
            return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, q(v)]));
          };
          const cold = await exactFrames(true);
          const warm = await exactFrames(false);
          return {
            drawnBy: "engine",
            backend: view.backend,
            adapter: view.engine?.gpu?.adapter ?? view.adapter,
            software: !!view.engine?.gpu?.fallback,
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

    // Optional frame-interval ablation (BENCH_FRAME_DIAG=1) to attribute interval cost outside
    // `content`: empty rAF, 2880x1800 2D/WebGPU standalone clears at 2x DPR, overlay hidden/1x1,
    // and direct engine pan without React or overlay updates.
    const frameDiag =
      process.env.BENCH_FRAME_DIAG === "1"
        ? await page.evaluate(async () => {
            type Camera = {
              x: number;
              y: number;
              zoom: number;
              pan(dx: number, dy: number): Camera;
            };
            const w = window as unknown as {
              devicePixelRatio: number;
              drawpane: {
                s: { camera: Camera; pageId: string };
                state: { set(p: { camera: Camera }): void };
                zoomTo(z: number): void;
              };
              drawpaneFrames: {
                reset(): void;
                summary(): {
                  content: { p50: number; p95: number };
                  overlay: { p50: number; p95: number };
                };
              };
              drawpaneEngineView?: {
                backend: string;
                draw(
                  pageId: string,
                  camera: Camera,
                  width: number,
                  height: number,
                  dpr: number,
                  bg: string,
                  opts: { hidden: Set<string>; whole: boolean },
                  exact: boolean,
                ): { drawn: boolean; ready: boolean };
                engine: { gpuFinished(): Promise<{ ok: boolean }> } | null;
              };
            };
            const q = (xs: number[]) => {
              const v = [...xs].sort((a, b) => a - b);
              const at = (p: number) =>
                Math.round((v[Math.floor(p * (v.length - 1))] ?? 0) * 10) / 10;
              return { p50: at(0.5), p95: at(0.95) };
            };
            const next = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
            const measureLoop = async (n: number, step: (i: number) => void | Promise<void>) => {
              await next();
              await next();
              w.drawpaneFrames.reset();
              const times: number[] = [];
              for (let i = 0; i < n; i++) {
                await step(i);
                await next();
                times.push(performance.now());
              }
              const gaps = times.slice(1).map((t, i) => t - (times[i] as number));
              return { interval: q(gaps), ...w.drawpaneFrames.summary() };
            };

            w.drawpane.zoomTo(0.25);
            await next();
            await next();
            const out: Record<string, unknown> = {
              viewport: { w: window.innerWidth, h: window.innerHeight, dpr: w.devicePixelRatio },
            };
            out.emptyRaf = await measureLoop(60, () => {});
            out.baseline = await measureLoop(60, (i) => {
              const d = i % 30 < 15 ? 6 : -6;
              w.drawpane.state.set({ camera: w.drawpane.s.camera.pan(d, d / 2) });
            });

            // Canvases inside `.canvas`: content, engine, retained labels, transient overlay.
            const canvases = [
              ...document.querySelectorAll(".canvas canvas"),
            ] as HTMLCanvasElement[];
            const overlayCanvas = document.querySelector(
              ".canvas .canvas__overlay",
            ) as HTMLCanvasElement | null;
            const contentCanvas = document.querySelector(
              '.canvas canvas[data-canvas-role="content"]',
            ) as HTMLCanvasElement | null;
            out.canvasSizes = canvases.map((c) => ({
              w: c.width,
              h: c.height,
              vis: getComputedStyle(c).visibility,
              disp: getComputedStyle(c).display,
            }));

            if (overlayCanvas) {
              const prevDisp = overlayCanvas.style.display;
              overlayCanvas.style.display = "none";
              out.overlayDisplayNone = await measureLoop(60, (i) => {
                const d = i % 30 < 15 ? 6 : -6;
                w.drawpane.state.set({ camera: w.drawpane.s.camera.pan(d, d / 2) });
              });
              const prevW = overlayCanvas.width;
              const prevH = overlayCanvas.height;
              overlayCanvas.width = 1;
              overlayCanvas.height = 1;
              out.overlay1x1Hidden = await measureLoop(60, (i) => {
                const d = i % 30 < 15 ? 6 : -6;
                w.drawpane.state.set({ camera: w.drawpane.s.camera.pan(d, d / 2) });
              });
              overlayCanvas.width = prevW;
              overlayCanvas.height = prevH;
              overlayCanvas.style.display = prevDisp;
            }

            const view = w.drawpaneEngineView;
            if (view && contentCanvas) {
              let cam = w.drawpane.s.camera;
              const drawMs: number[] = [];
              const res = await measureLoop(60, (i) => {
                const d = i % 30 < 15 ? 6 : -6;
                cam = cam.pan(d, d / 2);
                const t0 = performance.now();
                view.draw(
                  w.drawpane.s.pageId,
                  cam,
                  contentCanvas.width,
                  contentCanvas.height,
                  w.devicePixelRatio,
                  "#ebeae6",
                  { hidden: new Set<string>(), whole: false },
                  false,
                );
                drawMs.push(performance.now() - t0);
              });
              out.directEngineOnly = { interval: res.interval, drawMs: q(drawMs) };

              // Same direct engine pan, with an empty 2880x1800 transparent overlay cleared each frame.
              if (overlayCanvas) {
                const octx = overlayCanvas.getContext("2d");
                const clearMs: number[] = [];
                const res2 = await measureLoop(60, (i) => {
                  const d = i % 30 < 15 ? 6 : -6;
                  cam = cam.pan(d, d / 2);
                  view.draw(
                    w.drawpane.s.pageId,
                    cam,
                    contentCanvas.width,
                    contentCanvas.height,
                    w.devicePixelRatio,
                    "#ebeae6",
                    { hidden: new Set<string>(), whole: false },
                    false,
                  );
                  if (octx) {
                    const t0 = performance.now();
                    octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
                    clearMs.push(performance.now() - t0);
                  }
                });
                out.directEnginePlusClearOverlay = {
                  interval: res2.interval,
                  clearMs: q(clearMs),
                };
              }
            }
            return out;
          })
        : null;
    if (frameDiag) console.log(`FRAME_DIAG: ${JSON.stringify(frameDiag)}`);
    const workload = {
      renderer,
      layers,
      cards: 400,
      shadows: SHADOWS,
      shadowCount: SHADOWS ? 400 : 0,
    };
    console.log(
      `\n${ENGINE ? "Engine" : "Canvas"}, 10,000 layers (${workload.shadowCount} shadows), ${BUDGET_MS} ms budget\n${rows.join("\n")}${engine ? `\n${JSON.stringify(engine)}${engine.software ? " (software adapter: not representative)" : ""}` : ""}\n`,
    );
    test.info().annotations.push({
      type: "bench",
      description: JSON.stringify({
        renderer,
        workload,
        ...results,
        settled,
        ...(engine ? { engine } : {}),
        ...(presentation
          ? { presentation: { ...presentation, scenarios: scenarioPresentation } }
          : {}),
        ...(frameDiag ? { frameDiag } : {}),
      }),
    });
    if (ENFORCE)
      for (const [name, r] of Object.entries(results))
        expect(r.content.p95 + r.overlay.p95, `${name} p95 frame time`).toBeLessThan(BUDGET_MS);
  }
});
