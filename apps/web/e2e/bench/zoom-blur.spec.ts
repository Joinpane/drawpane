/**
 * Zoom-sweep GPU benchmark up to 25,600% on a heavy glass + progressive blur scene (decision 0040):
 *
 * 1. Interactive paced zoom sweep from 100% to 25,600% and back (120 animation frames),
 *    recording frame intervals, presentation intervals, content/overlay timings, plans,
 *    zero fallbacks, and zero whole-view raster downscaling.
 * 2. Forced exact (full-quality) GPU-fenced timing across discrete zoom stops
 *    (100%, 1000%, 2500%, 4300%, 10000%, 25600%), measuring encode, render, submit,
 *    GPU fence, and total ms with alternating background to prevent frame cache reuse.
 *
 * Run on Modal via `pnpm gpu-bench --modes gpu,webgpu --env BENCH_RENDERER=engine -- bench/zoom-blur.spec.ts`.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";

const WEBGL = process.env.BENCH_RENDERER === "engine-webgl";
const ENGINE = process.env.BENCH_RENDERER === "engine" || WEBGL;
const VERIFIED = process.env.BENCH_VERIFIED_BACKENDS;
const PRESENT =
  process.env.BENCH_ENGINE_PRESENT === "readback" ||
  (process.env.BENCH_ENGINE_PRESENT === "auto" && VERIFIED === "webgpu")
    ? "readback"
    : "webgpu";
const ALLOW_SOFTWARE = process.env.BENCH_ENGINE_SOFTWARE === "allow";
const FRAME_BUDGET_MS = 16.7;

type Ms = { encode: number; render: number; submit: number; total: number };
type Quantiles = { p50: number; p95: number; p99?: number; max: number };
type Stamp = { n: number; at: number };

type EngineViewHandle = {
  canvas: HTMLCanvasElement;
  shown: Stamp;
  stamps: { drawn?: Stamp; gpu?: Stamp; shown?: Stamp } | null;
  limitReason: string | null;
  last: {
    pageId: string;
    n: number;
    revision: number;
    supported: boolean;
    records: number;
    reads: number;
    coarse: number;
    exact: boolean;
    plan: string;
    tiles: { drawn: number; pending: number; queued: number; held: number; dragged: number };
    breakdown: { patch: number; encode: number; render: number; submit: number; readback: number };
  };
  readsBack: boolean;
  engine: {
    revision: number;
    records: number;
    gpu: { adapter: string; fallback: boolean; backend: "webgpu" | "webgl2" } | null;
    gpuFinished(): Promise<{ ok: boolean }>;
    gpuPixels(): Promise<{ ok: boolean; value?: Uint8Array; message?: string }>;
    renderGpu(
      w: number,
      h: number,
      c: { zoom: number; x: number; y: number; dpr: number },
      bg: readonly [number, number, number, number],
      detail: boolean,
      budgetMs?: number,
      editorViewport?: boolean,
    ): {
      ok: boolean;
      value?: {
        ms: Ms;
        exact: boolean;
        coarse: number;
        plan: string;
        records: number;
        reads: number;
        tiles: { drawn: number; pending: number };
      };
    };
  };
};

type W = {
  drawpane: {
    s: {
      pageId: string;
      viewport: { width: number; height: number };
      camera: {
        x: number;
        y: number;
        zoom: number;
        pan(
          dx: number,
          dy: number,
        ): { zoomAt(screen: { x: number; y: number }, zoom: number): unknown };
        zoomAt(screen: { x: number; y: number }, zoom: number): unknown;
      };
    };
    state: { set(patch: object): void };
    createLayer(t: string, r: object, parent: string, props?: object): string;
    zoomToFit(): void;
  };
  drawpaneFrames: {
    reset(): void;
    summary(): {
      frames: number;
      content: Quantiles;
      overlay: Quantiles;
    };
  };
  drawpaneEngineView?: EngineViewHandle;
  engineFallback?: { reason: string };
  devicePixelRatio: number;
};

const GLASS = (depth: number, frost: number, refraction = 80) => ({
  type: "glass",
  angle: -45,
  intensity: 80,
  refraction,
  depth,
  dispersion: 50,
  frost,
  splay: 0,
});

async function openFreshFile(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
}

async function waitForReady(page: Page) {
  await page.waitForFunction(
    () => {
      const w = window as unknown as W;
      if (w.engineFallback) return true;
      const v = w.drawpaneEngineView;
      if (!v) return false;
      if (v.last.n > 0 && !v.last.supported) return true;
      return v.last.supported === true && v.engine.records > 0 && v.last.exact === true;
    },
    undefined,
    { timeout: 60_000 },
  );
  const state = await page.evaluate(() => {
    const w = window as unknown as W;
    const v = w.drawpaneEngineView;
    return {
      fallback: w.engineFallback ?? null,
      supported: v?.last.supported ?? false,
      records: v?.engine.records ?? 0,
      reads: v?.last.reads ?? 0,
      adapter: v?.engine.gpu?.adapter ?? null,
      backend: v?.engine.gpu?.backend ?? null,
      software: !!v?.engine.gpu?.fallback,
      readsBack: !!v?.readsBack,
    };
  });
  expect(state.fallback, `engine fell back: ${JSON.stringify(state.fallback)}`).toBeNull();
  expect(state.supported).toBe(true);
  // An exact frame can be a composite of cached tiles that draws no reader itself, so `reads`
  // is recorded, not required.
  return state;
}

test.describe("High-zoom glass and progressive blur sweep", () => {
  let instance: Instance;
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const port = Number(
      process.env.BENCH_ZOOM_BLUR_PORT ??
        process.env.PARITY_PORT ??
        (process.env.E2E_PORT ? Number(process.env.E2E_PORT) + 120 : 8955),
    );
    const inspectorPort = Number(
      process.env.BENCH_ZOOM_BLUR_INSPECTOR_PORT ??
        (process.env.E2E_INSPECTOR_PORT
          ? Number(process.env.E2E_INSPECTOR_PORT) + 120
          : port + 540),
    );
    instance = await freshInstance(browser, { port, inspectorPort });
    await instance.page.evaluate(
      ({ renderer, present, allowSoftware }) => {
        localStorage.setItem("drawpane:debug", "1");
        localStorage.setItem("drawpane:renderer", renderer);
        localStorage.setItem("drawpane:engine-present", present);
        if (allowSoftware) localStorage.setItem("drawpane:engine-software", "allow");
      },
      {
        renderer: WEBGL ? "engine-webgl" : ENGINE ? "engine" : "canvas",
        present: PRESENT,
        allowSoftware: ALLOW_SOFTWARE,
      },
    );
    await instance.page.addInitScript(() => {
      window.addEventListener("drawpane:renderer-fallback", (e) => {
        const detail = (e as CustomEvent<{ from?: string; to?: string; reason: string }>).detail;
        // Handing off from unavailable/software WebGPU to hardware WebGL2 is normal backend selection.
        if (detail.to === "webgl2") return;
        (window as unknown as W).engineFallback = detail;
      });
    });
    await instance.page.reload();
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("zoom sweep up to 25,600% over heavy glass and progressive blur", async () => {
    test.skip(!ENGINE, "Zoom-blur engine benchmark requires BENCH_RENDERER=engine or engine-webgl");
    test.setTimeout(600_000);
    const page = instance.page;
    await openFreshFile(page);

    // Build a dense glass + progressive blur + uniform blur + isolated scope scene centered on (600, 400).
    await page.evaluate(
      (glass) => {
        const e = (window as unknown as W).drawpane;
        const pageId = e.s.pageId;
        e.createLayer("rect", { x: 0, y: 0, width: 1200, height: 800 }, pageId, {
          fills: [
            {
              type: "linear",
              from: { x: 0, y: 0 },
              to: { x: 1, y: 1 },
              stops: [
                { position: 0, color: "#ff7a45" },
                { position: 0.5, color: "#ffd43b" },
                { position: 1, color: "#2b6cb0" },
              ],
            },
          ],
        });
        for (let y = 0; y < 800; y += 16) {
          e.createLayer("rect", { x: 0, y, width: 1200, height: 5 }, pageId, {
            fills: [{ type: "solid", color: "#1c1b1ab0" }],
          });
        }
        for (let x = 0; x < 1200; x += 24) {
          e.createLayer("rect", { x, y: 0, width: 4, height: 800 }, pageId, {
            fills: [{ type: "solid", color: "#0b3d9190" }],
          });
        }
        for (let i = 0; i < 6; i++) {
          e.createLayer("text", { x: 80, y: 60 + i * 120, width: 1000, height: 40 }, pageId, {
            characters: `High-zoom glass & progressive blur detail line ${i + 1}: 25,600% sharpness check`,
            fontSize: 24,
            fontWeight: 600,
            fills: [{ type: "solid", color: "#101010" }],
          });
        }
        // 1. Wide uniform background blur sheet (left half, avoids triple-stacking all three
        // native reaches at 300% while still overlapping the focus area).
        e.createLayer("rect", { x: 80, y: 100, width: 540, height: 600 }, pageId, {
          cornerRadius: 28,
          fills: [{ type: "solid", color: "#ffffff20" }],
          effects: [{ type: "background-blur", radius: 36 }],
        });
        // 2. Wide progressive background blur centered on (600, 400).
        e.createLayer("rect", { x: 260, y: 180, width: 680, height: 440 }, pageId, {
          cornerRadius: 24,
          fills: [{ type: "solid", color: "#ffffff14" }],
          effects: [
            {
              type: "background-blur",
              radius: 40,
              blurType: "progressive",
              startRadius: 0,
              startOffset: { x: 0, y: 0.45 },
              endOffset: { x: 0, y: 0.9 },
            },
          ],
        });
        // 3. Isolated opacity=0.75 group with clipped progressive blur (solid fill border).
        const iso = e.createLayer("frame", { x: 420, y: 240, width: 420, height: 320 }, pageId, {
          opacity: 0.75,
          clipContent: true,
          fills: [{ type: "solid", color: "#f8fafc" }],
          cornerRadius: 20,
        });
        for (let i = 0; i < 14; i++) {
          e.createLayer("rect", { x: 0, y: i * 22, width: 420, height: 8 }, iso, {
            fills: [{ type: "solid", color: i % 2 ? "#1e293b" : "#0ea5e9" }],
          });
        }
        e.createLayer("rect", { x: 0, y: 0, width: 420, height: 320 }, iso, {
          fills: [{ type: "solid", color: "#ffffff08" }],
          effects: [
            {
              type: "background-blur",
              radius: 28,
              blurType: "progressive",
              startRadius: 0,
              startOffset: { x: 0, y: 0 },
              endOffset: { x: 0, y: 1 },
            },
          ],
        });
        // 4. Four overlapping glass lenses across (600, 400).
        const card = (x: number, y: number, w: number, h: number, g: object) =>
          e.createLayer("rect", { x, y, width: w, height: h }, pageId, {
            cornerRadius: 32,
            fills: [{ type: "solid", color: "#ffffff12" }],
            strokes: [{ type: "solid", color: "#ffffff55" }],
            strokeWeight: 1,
            effects: [g],
          });
        card(360, 240, 480, 320, glass[0]);
        card(440, 270, 400, 280, glass[1]);
        card(500, 310, 320, 220, glass[2]);
        card(520, 340, 260, 180, glass[3]);
        e.zoomToFit();
      },
      [GLASS(20, 4), GLASS(40, 8), GLASS(28, 0, 95), GLASS(18, 12)] as const,
    );

    const ready = await waitForReady(page);

    // 1. Paced interactive zoom sweep: 100% -> 25,600% -> 100% over 120 rAF frames.
    const interactiveSweep = await page.evaluate(async () => {
      const w = window as unknown as W;
      const e = w.drawpane;
      const view = w.drawpaneEngineView;
      if (!view) throw new Error("engine view missing");
      const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
      const vp = e.s.viewport;
      const focus = { x: 600, y: 400 };
      const centre = { x: vp.width / 2, y: vp.height / 2 };
      const setZoom = (z: number) => {
        const cam = e.s.camera;
        const centered = cam.pan(
          centre.x - focus.x * cam.zoom - cam.x,
          centre.y - focus.y * cam.zoom - cam.y,
        );
        e.state.set({ camera: centered.zoomAt(centre, z) });
      };
      setZoom(1);
      await frame();
      await frame();
      w.drawpaneFrames.reset();
      const times: number[] = [];
      const shownTimes: number[] = [];
      let lastShown = view.shown.n;
      const plans: Record<string, number> = {};
      let minCanvasWidth = view.canvas.width;
      const limitReasons = new Set<string>();
      const steps = 120;
      const logMax = Math.log(256);
      for (let i = 0; i < steps; i++) {
        const u = i < steps / 2 ? i / (steps / 2 - 1) : (steps - 1 - i) / (steps / 2 - 1);
        setZoom(Math.exp(u * logMax));
        const ts = await frame();
        times.push(ts);
        if (view.shown.n > lastShown) {
          lastShown = view.shown.n;
          shownTimes.push(ts);
        }
        const p = view.last.plan;
        plans[p] = (plans[p] ?? 0) + 1;
        minCanvasWidth = Math.min(minCanvasWidth, view.canvas.width);
        const lr = (view as unknown as { limitReason?: string | null }).limitReason;
        if (lr) limitReasons.add(lr);
      }
      const q = (xs: number[]) => {
        const v = [...xs].sort((a, b) => a - b);
        const at = (p: number) => Math.round((v[Math.floor(p * (v.length - 1))] ?? 0) * 10) / 10;
        return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
      };
      const gaps = (xs: number[]) => xs.slice(1).map((t, i) => t - (xs[i] as number));
      return {
        summary: { ...w.drawpaneFrames.summary(), interval: q(gaps(times)) },
        shownCount: shownTimes.length,
        shownInterval: q(gaps(shownTimes)),
        plans,
        minCanvasWidth,
        expectedCanvasWidth: Math.round(vp.width * (w.devicePixelRatio || 1)),
        limitReasons: [...limitReasons],
        fallback: w.engineFallback ?? null,
      };
    });

    // 2. Forced exact (full-quality) GPU-fenced sweep at key zoom stops up to 25,600%.
    const stops = [1, 10, 25, 43, 100, 256];
    const stopSweep = await page.evaluate(async (zoomStops) => {
      const w = window as unknown as W;
      const e = w.drawpane;
      const view = w.drawpaneEngineView;
      if (!view?.last.supported) throw new Error("engine lost before zoom-stop sweep");
      const dpr = w.devicePixelRatio || 2;
      const vp = e.s.viewport;
      const width = Math.round(vp.width * dpr) || 2880;
      const height = Math.round(vp.height * dpr) || 1800;
      const cssW = width / dpr;
      const cssH = height / dpr;
      const focusX = 600;
      const focusY = 400;
      const q = (xs: number[]): Quantiles => {
        const v = [...xs].sort((a, b) => a - b);
        const at = (p: number) => Math.round((v[Math.floor(p * (v.length - 1))] ?? 0) * 10) / 10;
        return { p50: at(0.5), p95: at(0.95), max: at(1) };
      };
      const bgFor = (step: number): readonly [number, number, number, number] =>
        step % 2 === 0 ? [1, 1, 1, 1] : [0.996, 0.996, 0.996, 1];
      const results: Record<string, object> = {};
      for (const z of zoomStops) {
        const cam = { zoom: z, x: cssW / 2 - focusX * z, y: cssH / 2 - focusY * z, dpr };
        // 3 warmup frames (record Limit per stop instead of aborting so both refs report every stop).
        let warmupErr: string | null = null;
        for (let i = 0; i < 3; i++) {
          const wr = view.engine.renderGpu(width, height, cam, bgFor(i), false, 0, true);
          if (!wr.ok) {
            const msg = (wr as { code?: number; message?: string }).message ?? "";
            const code = (wr as { code?: number }).code ?? -1;
            warmupErr = `code=${code} ${msg}`;
            break;
          }
          if (!(await view.engine.gpuFinished()).ok) {
            warmupErr = "warmup gpuFinished failed";
            break;
          }
        }
        if (warmupErr) {
          results[`zoom ${z * 100}%`] = { error: warmupErr };
          continue;
        }
        const encode: number[] = [];
        const render: number[] = [];
        const submit: number[] = [];
        const gpu: number[] = [];
        const total: number[] = [];
        const plans: Record<string, number> = {};
        let reads = 0;
        let sampleErr: string | null = null;
        for (let i = 0; i < 15; i++) {
          const t0 = performance.now();
          const r = view.engine.renderGpu(width, height, cam, bgFor(i + 3), false, 0, true);
          if (!r.ok || !r.value) {
            const msg = (r as { code?: number; message?: string }).message ?? "";
            const code = (r as { code?: number }).code ?? -1;
            sampleErr = `sample ${i}: code=${code} ${msg}`;
            break;
          }
          plans[r.value.plan] = (plans[r.value.plan] ?? 0) + 1;
          reads = Math.max(reads, r.value.reads);
          encode.push(r.value.ms.encode);
          render.push(r.value.ms.render);
          submit.push(r.value.ms.submit);
          const tf = performance.now();
          if (!(await view.engine.gpuFinished()).ok) {
            sampleErr = `sample ${i}: gpuFinished failed`;
            break;
          }
          const done = performance.now();
          gpu.push(done - tf);
          total.push(done - t0);
        }
        if (sampleErr) {
          results[`zoom ${z * 100}%`] = { error: sampleErr, plans, samples: total.length };
          continue;
        }
        // Intact pixel check at 25,600%.
        let intactColors: number | undefined;
        if (z === 256) {
          const px = await view.engine.gpuPixels();
          if (!px.ok || !px.value) throw new Error(`gpuPixels failed at 25600%`);
          const colors = new Set<number>();
          const step = Math.max(1, Math.floor((width * height) / 4096));
          for (let i = 0; i < width * height; i += step) {
            const o = i * 4;
            const r = px.value[o] ?? 0;
            const g = px.value[o + 1] ?? 0;
            const b = px.value[o + 2] ?? 0;
            colors.add(((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2));
          }
          intactColors = colors.size;
        }
        results[`zoom ${z * 100}%`] = {
          plans,
          reads,
          encode: q(encode),
          render: q(render),
          submit: q(submit),
          gpu: q(gpu),
          total: q(total),
          ...(intactColors !== undefined ? { intactColors } : {}),
        };
      }
      return {
        frame: { width, height },
        adapter: view.engine.gpu?.adapter ?? null,
        backend: view.engine.gpu?.backend ?? null,
        software: !!view.engine.gpu?.fallback,
        readsBack: view.readsBack,
        stops: results,
      };
    }, stops);

    // 3. Time to exact after the camera stops, the way the editor settles (decision 0040, Figma's
    //    windows: 0.1 to 0.5 s after a continuous zoom, 0.3 to 2.1 s after a jump). Exact means
    //    the engine stamped a frame exact with no limit reason: every visible tile at the current
    //    scale landed with full-quality readers. `lastShown` is the last frame presented in the
    //    window (a view that never turns exact still stops changing), and `maxFrame` the longest
    //    animation-frame gap while settling (frames must not block the main thread).
    const SETTLE_DEADLINE_MS = Number(process.env.BENCH_SETTLE_DEADLINE_MS ?? 6000);
    const settleStops = await page.evaluate(async (deadlineMs) => {
      const w = window as unknown as W;
      const e = w.drawpane;
      const view = w.drawpaneEngineView;
      if (!view?.last.supported) throw new Error("engine lost before settle measurement");
      const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
      const vp = e.s.viewport;
      const focus = { x: 600, y: 400 };
      const centre = { x: vp.width / 2, y: vp.height / 2 };
      const setZoom = (z: number) => {
        const cam = e.s.camera;
        const centered = cam.pan(
          centre.x - focus.x * cam.zoom - cam.x,
          centre.y - focus.y * cam.zoom - cam.y,
        );
        e.state.set({ camera: centered.zoomAt(centre, z) });
      };
      const settle = async (stopAt: number) => {
        let lastShownN = view.shown.n;
        let lastShownAt = stopAt;
        let prev = performance.now();
        let maxFrame = 0;
        const deadline = stopAt + deadlineMs;
        while (performance.now() < deadline) {
          const st = view.stamps;
          if (st?.drawn && st.gpu && st.shown) break;
          const t = await frame();
          maxFrame = Math.max(maxFrame, t - prev);
          prev = t;
          if (view.shown.n !== lastShownN) {
            lastShownN = view.shown.n;
            lastShownAt = performance.now();
          }
        }
        const st = view.stamps;
        view.stamps = null;
        const r = (x: number) => Math.round(x * 10) / 10;
        return {
          exact:
            st?.drawn && st.gpu && st.shown
              ? {
                  drawn: r(st.drawn.at - stopAt),
                  gpu: r(st.gpu.at - stopAt),
                  shown: r(st.shown.at - stopAt),
                }
              : null,
          lastShown: r(lastShownAt - stopAt),
          maxFrame: r(maxFrame),
          plan: view.last.plan,
          exactFlag: view.last.exact,
          limitReason: view.limitReason,
          canvasWidth: view.canvas.width,
        };
      };
      const med = (xs: number[]) => {
        if (!xs.length) return null;
        const v = [...xs].sort((a, b) => a - b);
        return v[Math.floor(0.5 * (v.length - 1))] ?? null;
      };
      const summarise = (runs: Awaited<ReturnType<typeof settle>>[]) => {
        const exact = runs.flatMap((x) => (x.exact ? [x.exact] : []));
        const last = runs[runs.length - 1];
        return {
          gestures: runs.length,
          neverExact: runs.length - exact.length,
          drawnMs: med(exact.map((x) => x.drawn)),
          gpuMs: med(exact.map((x) => x.gpu)),
          shownMs: med(exact.map((x) => x.shown)),
          lastShownMs: med(runs.map((x) => x.lastShown)),
          maxFrameMs: Math.max(...runs.map((x) => x.maxFrame)),
          plan: last?.plan,
          exact: last?.exactFlag,
          limitReason: last?.limitReason,
          canvasWidth: last?.canvasWidth,
          samples: runs.map((x) => ({
            exact: x.exact,
            lastShown: x.lastShown,
            maxFrame: x.maxFrame,
          })),
        };
      };
      // A continuous zoom: 15 frames from 0.55x (or 1.45x) of the target, stopping on it.
      const continuous = async (target: number, gestures: number) => {
        const runs = [];
        for (let g = 0; g < gestures; g++) {
          const start = target * (g % 2 === 0 ? 0.55 : 1.45);
          setZoom(start);
          await frame();
          await frame();
          let stopAt = 0;
          for (let i = 0; i < 15; i++) {
            setZoom(start * (target / start) ** ((i + 1) / 15));
            stopAt = performance.now();
            if (i === 14) view.stamps = {};
            await frame();
          }
          runs.push(await settle(stopAt));
        }
        return summarise(runs);
      };
      // A jump: settle at 0.25x (or 4x) of the target, then set the target in one step.
      const jump = async (target: number, gestures: number) => {
        const runs = [];
        for (let g = 0; g < gestures; g++) {
          setZoom(target * (g % 2 === 0 ? 0.25 : 4));
          for (let i = 0; i < 30; i++) await frame();
          view.stamps = {};
          setZoom(target);
          runs.push(await settle(performance.now()));
        }
        return summarise(runs);
      };
      const out: Record<string, object> = {};
      for (const z of [1, 10, 25, 100]) {
        out[`${z * 100}% continuous`] = await continuous(z, 3);
        out[`${z * 100}% jump`] = await jump(z, 3);
      }
      // A radius 30 layer blur over the focus (sigma 2,700 at 10,000% and DPR 2, like the iOS
      // kit's Examples page).
      e.createLayer("rect", { x: 460, y: 280, width: 280, height: 240 }, e.s.pageId, {
        cornerRadius: 24,
        fills: [{ type: "solid", color: "#3b82f680" }],
        effects: [{ type: "layer-blur", radius: 30 }],
      });
      await frame();
      out["10000% + layer blur continuous"] = await continuous(100, 3);
      out["10000% + layer blur jump"] = await jump(100, 3);
      return out;
    }, SETTLE_DEADLINE_MS);

    // 4. The same settle on a single wide reader: a radius 36 background blur over the striped
    //    page. At 1,000% its reach (about 1,410 px) is past what one padded native pass of the
    //    2,880 x 1,800 view holds but fits apron tiles, so this measures the apron path.
    await openFreshFile(page);
    await page.evaluate(() => {
      const e = (window as unknown as W).drawpane;
      const pageId = e.s.pageId;
      e.createLayer("rect", { x: 0, y: 0, width: 1200, height: 800 }, pageId, {
        fills: [{ type: "solid", color: "#f4f1ea" }],
      });
      for (let y = 0; y < 800; y += 16)
        e.createLayer("rect", { x: 0, y, width: 1200, height: 5 }, pageId, {
          fills: [{ type: "solid", color: "#1c1b1ab0" }],
        });
      for (let x = 0; x < 1200; x += 24)
        e.createLayer("rect", { x, y: 0, width: 4, height: 800 }, pageId, {
          fills: [{ type: "solid", color: "#0b3d9190" }],
        });
      e.createLayer("rect", { x: 300, y: 200, width: 600, height: 400 }, pageId, {
        cornerRadius: 28,
        fills: [{ type: "solid", color: "#ffffff30" }],
        effects: [{ type: "background-blur", radius: 36 }],
      });
      e.zoomToFit();
    });
    await waitForReady(page);
    const singleBlur = await page.evaluate(async (deadlineMs) => {
      const w = window as unknown as W;
      const e = w.drawpane;
      const view = w.drawpaneEngineView;
      if (!view?.last.supported) throw new Error("engine lost before the single-blur settle");
      const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
      const vp = e.s.viewport;
      const centre = { x: vp.width / 2, y: vp.height / 2 };
      const setZoom = (z: number) => {
        const cam = e.s.camera;
        const centered = cam.pan(
          centre.x - 600 * cam.zoom - cam.x,
          centre.y - 400 * cam.zoom - cam.y,
        );
        e.state.set({ camera: centered.zoomAt(centre, z) });
      };
      const out: Record<string, object> = {};
      for (const kind of ["continuous", "jump"] as const) {
        const runs = [];
        for (let g = 0; g < 3; g++) {
          const target = 10;
          let stopAt = 0;
          if (kind === "continuous") {
            const start = target * (g % 2 === 0 ? 0.55 : 1.45);
            setZoom(start);
            await frame();
            await frame();
            for (let i = 0; i < 15; i++) {
              setZoom(start * (target / start) ** ((i + 1) / 15));
              stopAt = performance.now();
              if (i === 14) view.stamps = {};
              await frame();
            }
          } else {
            setZoom(target * (g % 2 === 0 ? 0.25 : 4));
            for (let i = 0; i < 30; i++) await frame();
            view.stamps = {};
            setZoom(target);
            stopAt = performance.now();
          }
          let prev = performance.now();
          let maxFrame = 0;
          let lastShownN = view.shown.n;
          let lastShownAt = stopAt;
          while (performance.now() < stopAt + deadlineMs) {
            const st = view.stamps;
            if (st?.drawn && st.gpu && st.shown) break;
            const t = await frame();
            maxFrame = Math.max(maxFrame, t - prev);
            prev = t;
            if (view.shown.n !== lastShownN) {
              lastShownN = view.shown.n;
              lastShownAt = performance.now();
            }
          }
          const st = view.stamps;
          view.stamps = null;
          const r = (x: number) => Math.round(x * 10) / 10;
          runs.push({
            exact:
              st?.drawn && st.gpu && st.shown
                ? {
                    drawn: r(st.drawn.at - stopAt),
                    gpu: r(st.gpu.at - stopAt),
                    shown: r(st.shown.at - stopAt),
                  }
                : null,
            lastShown: r(lastShownAt - stopAt),
            maxFrame: r(maxFrame),
            plan: view.last.plan,
            exactFlag: view.last.exact,
            limitReason: view.limitReason,
          });
        }
        out[`1000% single blur ${kind}`] = runs;
      }
      return out;
    }, SETTLE_DEADLINE_MS);

    console.log(
      `\nZoom-blur sweep (${ready.backend}, adapter=${ready.adapter}, readsBack=${ready.readsBack}):\n` +
        `  interactive 100%..25600%: interval p50/p95/p99 ${interactiveSweep.summary.interval.p50}/${interactiveSweep.summary.interval.p95}/${interactiveSweep.summary.interval.p99} ms · content p50/p95 ${interactiveSweep.summary.content.p50}/${interactiveSweep.summary.content.p95} ms · minCanvasW=${interactiveSweep.minCanvasWidth}/${interactiveSweep.expectedCanvasWidth} · plans=${JSON.stringify(interactiveSweep.plans)} · limits=${JSON.stringify(interactiveSweep.limitReasons)}\n` +
        `  exact zoom stops (${stopSweep.frame.width}x${stopSweep.frame.height}): ${JSON.stringify(stopSweep.stops)}\n` +
        `  time-to-exact after zoom stop: ${JSON.stringify(settleStops)}\n` +
        `  single blur settle: ${JSON.stringify(singleBlur)}\n`,
    );
    test.info().annotations.push({
      type: "bench",
      description: JSON.stringify({
        "engine: zoom sweep 100%..25600% (interactive)": interactiveSweep.summary,
        "engine: zoom sweep meta": {
          shownCount: interactiveSweep.shownCount,
          shownInterval: interactiveSweep.shownInterval,
          plans: interactiveSweep.plans,
          minCanvasWidth: interactiveSweep.minCanvasWidth,
          expectedCanvasWidth: interactiveSweep.expectedCanvasWidth,
          limitReasons: interactiveSweep.limitReasons,
          frame: stopSweep.frame,
        },
        "engine: exact zoom stops": stopSweep.stops,
        "engine: time-to-exact after zoom stop": settleStops,
        "engine: single blur settle": singleBlur,
      }),
    });
    expect(interactiveSweep.fallback).toBeNull();
    if (process.env.BENCH_ENFORCE === "1") {
      expect.soft(interactiveSweep.minCanvasWidth).toBe(interactiveSweep.expectedCanvasWidth);
      if (!ready.software && !ready.readsBack) {
        expect
          .soft(interactiveSweep.summary.interval.p95, "zoom sweep frame interval p95")
          .toBeLessThanOrEqual(FRAME_BUDGET_MS);
      }
    }
  });
});
