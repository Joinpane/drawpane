/**
 * What glass and stacked glass cost to draw:
 *
 * 1. Six glass layers (rounded rectangles, a pill and a circle, shallow and deep rims,
 *    frosted and clear) over a busy backdrop.
 *    - Canvas mode measures 60 full redraws.
 *    - Engine mode separates cached frame reuse (`unchanged`) from forced exact and coarse
 *      redraws (alternating background forces every tile to redraw), verifying engine selection,
 *      reader counts, intact pixels, and hardware GPU budgets.
 * 2. Stacked glass cards over a busy backdrop with text and a background-blur panel:
 *    - Interactive pan (no-fence paced),
 *    - Interactive drag (no-fence paced for true frame intervals),
 *    - Separate GPU-fenced drag (pure GPU wait per drag frame),
 *    - Revision-verified settle timing from commit to exact drawn / GPU done / shown (all
 *      samples preserved, failing on timeout or fallback).
 *
 * BENCH_RENDERER=engine runs the same scenes through the render engine (decision 0040).
 * BENCH_RENDERER=engine-webgl selects WebGL2 explicitly. Set BENCH_ENGINE_PRESENT=readback
 * where headless WebGPU canvases cannot present.
 * Run with `pnpm --filter @drawpane/web exec playwright test --project=bench bench/glass`.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { pan, type Summary, summaryRow } from "./frames";

const WEBGL = process.env.BENCH_RENDERER === "engine-webgl";
const ENGINE = process.env.BENCH_RENDERER === "engine" || WEBGL;
const PRESENT = process.env.BENCH_ENGINE_PRESENT === "readback" ? "readback" : "webgpu";
const ALLOW_SOFTWARE = process.env.BENCH_ENGINE_SOFTWARE === "allow";
const FRAME_BUDGET_MS = 16.7;
const EXACT_FENCE_BUDGET_MS = 80;
const MOVING_CONTENT_BUDGET_MS = 8;
const SETTLE_BUDGET_MS = 250;

type Ms = { encode: number; render: number; submit: number; total: number };
type Quantiles = { p50: number; p95: number; max: number };
type Stamp = { n: number; at: number };

type EngineViewHandle = {
  canvas: HTMLCanvasElement;
  shown: Stamp;
  stamps: { drawn?: Stamp; gpu?: Stamp; shown?: Stamp } | null;
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
      camera: { x: number; y: number; zoom: number; pan(dx: number, dy: number): unknown };
    };
    state: { set(patch: object): void };
    createLayer(t: string, r: object, parent: string, props?: object): string;
    commit(ops: object[]): boolean;
    beginGesture(label: string): void;
    endGesture(): void;
    zoomToFit(): void;
  };
  drawpaneFrames: {
    reset(): void;
    redraw(): void;
    exact?: boolean;
    summary(): Summary;
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

/** Verifies the active renderer drew non-blank, varied pixels onto its canvas. */
async function verifyIntactPixels(page: Page): Promise<{ distinct: number; nonZeroAlpha: number }> {
  return page.evaluate(async (useEngine) => {
    const w = window as unknown as W;
    let pixels: Uint8Array | Uint8ClampedArray;
    let width: number;
    let height: number;
    if (useEngine) {
      const view = w.drawpaneEngineView;
      if (!view) throw new Error("engine view missing when verifying pixels");
      const px = await view.engine.gpuPixels();
      if (!px.ok || !px.value) throw new Error(`gpuPixels failed: ${px.message ?? "unknown"}`);
      pixels = px.value;
      width = view.canvas.width;
      height = view.canvas.height;
    } else {
      const c = document.querySelector<HTMLCanvasElement>(".canvas canvas.canvas__layer");
      if (!c) throw new Error("content canvas missing");
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("content 2D context missing");
      width = c.width;
      height = c.height;
      pixels = ctx.getImageData(0, 0, width, height).data;
    }
    const colors = new Set<number>();
    let nonZeroAlpha = 0;
    const step = Math.max(1, Math.floor((width * height) / 4096));
    for (let i = 0; i < width * height; i += step) {
      const off = i * 4;
      const r = pixels[off] ?? 0;
      const g = pixels[off + 1] ?? 0;
      const b = pixels[off + 2] ?? 0;
      const a = pixels[off + 3] ?? 0;
      if (a > 0) nonZeroAlpha++;
      colors.add(((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2));
    }
    return { distinct: colors.size, nonZeroAlpha };
  }, ENGINE);
}

/** Measures forced GPU whole-frame timings (exact and coarse) when the engine is active. */
async function measureEngineGpu(page: Page) {
  if (!ENGINE) return null;
  return page.evaluate(async () => {
    const w = window as unknown as W;
    const view = w.drawpaneEngineView;
    if (!view?.last.supported || w.engineFallback) {
      return {
        drawnBy: "canvas" as const,
        adapter: view?.engine.gpu?.adapter ?? null,
        software: !!view?.engine.gpu?.fallback,
        reason: w.engineFallback?.reason ?? (view ? "the page is unsupported" : "no engine view"),
      };
    }
    const q = (xs: number[]): Quantiles => {
      const v = [...xs].sort((a, b) => a - b);
      const at = (p: number) => Math.round((v[Math.floor(p * (v.length - 1))] ?? 0) * 10) / 10;
      return { p50: at(0.5), p95: at(0.95), max: at(1) };
    };
    const width = view.canvas.width || 1440;
    const height = view.canvas.height || 900;
    const c = w.drawpane.s.camera;
    const camera = { zoom: c.zoom, x: c.x, y: c.y, dpr: w.devicePixelRatio || 1 };
    const measure = async (detail: boolean, count: number, includeReadback: boolean) => {
      const encode: number[] = [];
      const render: number[] = [];
      const submit: number[] = [];
      const gpu: number[] = [];
      const total: number[] = [];
      const readback: number[] = [];
      const plans: Record<string, number> = {};
      let coarse = 0;
      let records = 0;
      let reads = 0;
      let tilesDrawn = 0;
      const bgFor = (step: number): readonly [number, number, number, number] =>
        step % 2 === 0 ? [1, 1, 1, 1] : [0.996, 0.996, 0.996, 1];
      // Warmup (alternating background invalidates cached tiles so every frame draws in full).
      for (let i = 0; i < 3; i++) {
        const wres = view.engine.renderGpu(width, height, camera, bgFor(i), detail, 0);
        if (!wres.ok) throw new Error(`warmup renderGpu failed (detail=${detail})`);
        if (!(await view.engine.gpuFinished()).ok) throw new Error("warmup GPU fence failed");
      }
      for (let i = 0; i < count; i++) {
        const began = performance.now();
        const r = view.engine.renderGpu(width, height, camera, bgFor(i + 3), detail, 0);
        if (!r.ok || !r.value) throw new Error(`renderGpu failed at sample ${i}`);
        if (r.value.exact === detail) throw new Error(`wrong frame quality at sample ${i}`);
        if (r.value.reads === 0) throw new Error(`no reader passes at sample ${i}`);
        if (r.value.plan !== "direct" && r.value.tiles.drawn === 0) {
          throw new Error(`no draw work at sample ${i}`);
        }
        coarse = r.value.coarse;
        records = r.value.records;
        reads = Math.max(reads, r.value.reads);
        tilesDrawn += r.value.tiles.drawn;
        plans[r.value.plan] = (plans[r.value.plan] ?? 0) + 1;
        encode.push(r.value.ms.encode);
        render.push(r.value.ms.render);
        submit.push(r.value.ms.submit);
        let t = performance.now();
        const done = await view.engine.gpuFinished();
        if (!done.ok) throw new Error(`gpuFinished failed at sample ${i}`);
        const finished = performance.now();
        gpu.push(finished - t);
        total.push(finished - began);
        if (includeReadback && i % 2 === 0) {
          t = performance.now();
          const px = await view.engine.gpuPixels();
          if (!px.ok) throw new Error(`gpuPixels failed at sample ${i}`);
          readback.push(performance.now() - t);
        }
      }
      return {
        samples: gpu.length,
        plans,
        records,
        reads,
        coarse,
        tilesDrawn,
        encode: q(encode),
        render: q(render),
        submit: q(submit),
        gpu: q(gpu),
        total: q(total),
        ...(includeReadback ? { readback: q(readback) } : {}),
      };
    };
    return {
      drawnBy: "engine" as const,
      adapter: view.engine.gpu?.adapter ?? null,
      backend: view.engine.gpu?.backend,
      software: !!view.engine.gpu?.fallback,
      readsBack: view.readsBack,
      frame: { width, height },
      exactWhole: await measure(false, 20, true),
      coarseWhole: await measure(true, 20, false),
    };
  });
}

async function openFreshFile(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
}

/**
 * Waits for the page's initial exact render. In engine mode, fails loudly if the engine
 * falls back or refuses the page instead of silently accepting a Canvas fallback.
 */
async function waitForReady(page: Page): Promise<{
  drawnBy: "engine" | "canvas";
  adapter: string | null;
  software: boolean;
  reads: number;
  records: number;
  plan: string;
}> {
  if (ENGINE) {
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
        exact: v?.last.exact ?? false,
        plan: v?.last.plan ?? "none",
        adapter: v?.engine.gpu?.adapter ?? null,
        software: !!v?.engine.gpu?.fallback,
        backend: v?.engine.gpu?.backend,
      };
    });
    expect(state.fallback, `engine fell back: ${JSON.stringify(state.fallback)}`).toBeNull();
    expect(state.supported, "page must be supported by the render engine").toBe(true);
    if (WEBGL) expect(state.backend).toBe("webgl2");
    expect(state.records).toBeGreaterThan(0);
    expect(state.exact).toBe(true);
    return {
      drawnBy: "engine",
      adapter: state.adapter,
      software: state.software,
      reads: state.reads,
      records: state.records,
      plan: state.plan,
    };
  }
  await page.waitForTimeout(1500);
  return {
    drawnBy: "canvas",
    adapter: null,
    software: false,
    reads: 0,
    records: 0,
    plan: "canvas",
  };
}

test.describe("Glass cost", () => {
  let instance: Instance;
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const port = Number(
      process.env.BENCH_GLASS_PORT ??
        process.env.PARITY_PORT ??
        (process.env.E2E_PORT ? Number(process.env.E2E_PORT) + 100 : 8935),
    );
    const inspectorPort = Number(
      process.env.BENCH_GLASS_INSPECTOR_PORT ??
        (process.env.E2E_INSPECTOR_PORT
          ? Number(process.env.E2E_INSPECTOR_PORT) + 100
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
        (window as unknown as W).engineFallback = (e as CustomEvent).detail;
      });
    });
    await instance.page.reload();
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("six glass layers", async () => {
    // Without a GPU (this VM, CI), each frame takes seconds.
    test.setTimeout(600_000);
    const page = instance.page;
    await openFreshFile(page);
    await page.evaluate(
      (glass) => {
        const e = (window as unknown as W).drawpane;
        const pageId = e.s.pageId;
        // A busy backdrop: stripes both ways over a gradient.
        e.createLayer("rect", { x: 0, y: 0, width: 1200, height: 800 }, pageId, {
          fills: [
            {
              type: "linear",
              from: { x: 0, y: 0.5 },
              to: { x: 1, y: 0.5 },
              stops: [
                { position: 0, color: "#ff7a45" },
                { position: 1, color: "#3d7bf0" },
              ],
            },
          ],
        });
        for (let y = 0; y < 800; y += 24)
          e.createLayer("rect", { x: 0, y, width: 1200, height: 6 }, pageId, {
            fills: [{ type: "solid", color: "#1c1b1aa6" }],
          });
        for (let x = 0; x < 1200; x += 30)
          e.createLayer("rect", { x, y: 0, width: 4, height: 800 }, pageId, {
            fills: [{ type: "solid", color: "#0b3d918c" }],
          });
        const add = (type: string, r: object, props: object) =>
          e.createLayer(type, r, pageId, {
            fills: [{ type: "solid", color: "#ffffff00" }],
            ...props,
          });
        add(
          "rect",
          { x: 40, y: 40, width: 360, height: 240 },
          { cornerRadius: 36, effects: [glass[0]] },
        );
        add(
          "rect",
          { x: 440, y: 40, width: 360, height: 240 },
          { cornerRadius: 36, effects: [glass[1]] },
        );
        add(
          "rect",
          { x: 840, y: 40, width: 320, height: 120 },
          { cornerRadius: 60, effects: [glass[2]] },
        );
        add("ellipse", { x: 60, y: 360, width: 300, height: 300 }, { effects: [glass[0]] });
        add(
          "rect",
          { x: 440, y: 360, width: 360, height: 240 },
          { cornerRadius: 12, effects: [glass[3]] },
        );
        add(
          "rect",
          { x: 840, y: 360, width: 320, height: 400 },
          { cornerRadius: 48, effects: [glass[1]] },
        );
        e.zoomToFit();
      },
      [GLASS(20, 4), GLASS(60, 8), GLASS(40, 0, 100), GLASS(10, 16)] as const,
    );
    const ready = await waitForReady(page);
    const intact = await verifyIntactPixels(page);
    expect(intact.nonZeroAlpha).toBeGreaterThan(100);
    expect(intact.distinct).toBeGreaterThan(20);

    if (ENGINE) {
      // Keep engine cached reuse strictly separate from forced full draws.
      const reuse = await page.evaluate(async () => {
        const w = window as unknown as W;
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        const plans: Record<string, number> = {};
        for (let i = 0; i < 5; i++) {
          w.drawpaneFrames.redraw();
          await frame();
        }
        w.drawpaneFrames.reset();
        for (let i = 0; i < 30; i++) {
          w.drawpaneFrames.redraw();
          await frame();
          const p = w.drawpaneEngineView?.last.plan ?? "none";
          plans[p] = (plans[p] ?? 0) + 1;
        }
        return { summary: w.drawpaneFrames.summary(), plans };
      });
      const engine = await measureEngineGpu(page);
      expect(engine?.drawnBy).toBe("engine");
      if (engine?.drawnBy === "engine") {
        expect(engine.exactWhole.reads).toBeGreaterThan(0);
        expect(engine.coarseWhole.reads).toBeGreaterThan(0);
        expect(engine.exactWhole.plans.unchanged ?? 0).toBe(0);
        expect(engine.coarseWhole.plans.unchanged ?? 0).toBe(0);
        if (!engine.software) {
          expect
            .soft(engine.coarseWhole.gpu.p95, "six-glass coarse GPU fence p95")
            .toBeLessThanOrEqual(FRAME_BUDGET_MS);
          expect
            .soft(engine.exactWhole.gpu.p95, "six-glass exact GPU fence p95")
            .toBeLessThanOrEqual(EXACT_FENCE_BUDGET_MS);
        }
      }
      console.log(
        `glass (engine): adapter=${ready.adapter} reads=${ready.reads} intact=${intact.distinct} colors · cached reuse p50/p95 ${reuse.summary.content.p50}/${reuse.summary.content.p95} ms (${JSON.stringify(reuse.plans)})\n${JSON.stringify(engine)}`,
      );
      test.info().annotations.push({
        type: "bench",
        description: JSON.stringify({
          "engine: six glass cached reuse": { ...reuse.summary, plans: reuse.plans },
          "engine: six glass forced whole": engine,
          intact,
        }),
      });
    } else {
      const result = await page.evaluate(async () => {
        const w = window as unknown as W;
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        for (let i = 0; i < 10; i++) {
          w.drawpaneFrames.redraw();
          await frame();
        }
        w.drawpaneFrames.reset();
        for (let i = 0; i < 60; i++) {
          w.drawpaneFrames.redraw();
          await frame();
        }
        return w.drawpaneFrames.summary();
      });
      console.log(
        `glass (canvas): ${result.frames} full redraws · content p50 ${result.content.p50} ms · p95 ${result.content.p95} ms · max ${result.content.max} ms · intact=${intact.distinct} colors`,
      );
      test.info().annotations.push({
        type: "bench",
        description: JSON.stringify({
          "canvas: six glass full redraw": result,
          intact,
        }),
      });
      expect(result.frames).toBeGreaterThan(30);
    }
  });

  test("stacked glass cards interactive pan, drag, and settle", async () => {
    test.setTimeout(600_000);
    const page = instance.page;
    await openFreshFile(page);
    const topCard = await page.evaluate(
      (glass) => {
        const e = (window as unknown as W).drawpane;
        const pageId = e.s.pageId;
        // Busy striped backdrop with text.
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
        for (let y = 0; y < 800; y += 24)
          e.createLayer("rect", { x: 0, y, width: 1200, height: 6 }, pageId, {
            fills: [{ type: "solid", color: "#1c1b1ab0" }],
          });
        for (let x = 0; x < 1200; x += 32)
          e.createLayer("rect", { x, y: 0, width: 4, height: 800 }, pageId, {
            fills: [{ type: "solid", color: "#0b3d9190" }],
          });
        for (let i = 0; i < 4; i++)
          e.createLayer("text", { x: 60, y: 80 + i * 170, width: 900, height: 48 }, pageId, {
            characters: `Stacked glass backdrop line ${i + 1}: crisp typography behind frosted sheets`,
            fontSize: 28,
            fontWeight: 600,
            fills: [{ type: "solid", color: "#111111" }],
          });
        // Frosted background-blur sheet behind the stacked glass cards.
        e.createLayer("rect", { x: 120, y: 110, width: 560, height: 340 }, pageId, {
          cornerRadius: 28,
          fills: [{ type: "solid", color: "#ffffff44" }],
          effects: [{ type: "background-blur", radius: 24 }],
        });
        // Four overlapping stacked glass cards (frosted + clear, b* dual-target path).
        const card = (x: number, y: number, w: number, h: number, g: object) =>
          e.createLayer("rect", { x, y, width: w, height: h }, pageId, {
            cornerRadius: 32,
            fills: [{ type: "solid", color: "#ffffff18" }],
            strokes: [{ type: "solid", color: "#ffffff55" }],
            strokeWeight: 1,
            effects: [g],
          });
        const [g0, g1, g2, g3] = glass;
        card(180, 150, 420, 280, g0);
        card(340, 230, 420, 280, g1);
        card(500, 170, 420, 280, g2);
        const top = card(420, 310, 440, 290, g3);
        e.zoomToFit();
        return top;
      },
      [GLASS(24, 6), GLASS(40, 12), GLASS(28, 0, 95), GLASS(32, 8)] as const,
    );
    const ready = await waitForReady(page);
    const intact = await verifyIntactPixels(page);
    expect(intact.nonZeroAlpha).toBeGreaterThan(100);
    expect(intact.distinct).toBeGreaterThan(20);

    // 1. Paced no-fence pan.
    const panSummary = await pan(page, "fit", 60);
    if (ENGINE) {
      expect(panSummary.exactMs, "stacked pan must settle to exact").not.toBeNull();
    }

    // 2. Paced no-fence drag: measures real frame intervals without stalling on gpuFinished().
    const dragNoFence = await page.evaluate(async (cardId) => {
      const w = window as unknown as W;
      const view = w.drawpaneEngineView;
      const useEngine = !!view?.last.supported;
      const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
      await frame();
      await frame();
      w.drawpaneFrames.reset();
      const times: number[] = [];
      const shownTimes: number[] = [];
      let lastShown = view?.shown.n ?? 0;
      let lastDrawn = view?.last.n ?? 0;
      const samples: Array<EngineViewHandle["last"]["breakdown"] & { tiles: number }> = [];
      const plans: Record<string, number> = {};
      let coarseFrames = 0;
      let maxReads = 0;
      let x = 420;
      let y = 310;
      w.drawpane.beginGesture("Drag glass card");
      try {
        for (let i = 0; i < 60; i++) {
          const d = i % 30 < 15 ? 8 : -8;
          x += d;
          y += d / 2;
          w.drawpane.commit([
            { op: "set", id: cardId, prop: "x", value: x },
            { op: "set", id: cardId, prop: "y", value: y },
          ]);
          const presentedAt = await frame();
          times.push(presentedAt);
          if (useEngine && view) {
            if (view.shown.n > lastShown) {
              lastShown = view.shown.n;
              // The first animation frame that observes GPU completion. The browser's
              // frame clock excludes variation in when main-thread callbacks execute.
              shownTimes.push(presentedAt);
            }
            if (view.last.n > lastDrawn) {
              lastDrawn = view.last.n;
              samples.push({ ...view.last.breakdown, tiles: view.last.tiles.drawn });
            }
            if (!view.last.exact && view.last.coarse > 0) coarseFrames++;
            maxReads = Math.max(maxReads, view.last.reads);
            plans[view.last.plan] = (plans[view.last.plan] ?? 0) + 1;
          }
        }
      } finally {
        w.drawpane.endGesture();
      }
      const q = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        const at = (p: number) =>
          Math.round((sorted[Math.floor(p * (sorted.length - 1))] ?? 0) * 10) / 10;
        return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
      };
      const gaps = (stamps: number[]) => stamps.slice(1).map((t, i) => t - (stamps[i] as number));
      return {
        summary: { ...w.drawpaneFrames.summary(), interval: q(gaps(times)) },
        shownCount: shownTimes.length,
        shownInterval: q(gaps(shownTimes)),
        sampledFrameCount: samples.length,
        work: {
          patch: q(samples.map((s) => s.patch)),
          encode: q(samples.map((s) => s.encode)),
          render: q(samples.map((s) => s.render)),
          submit: q(samples.map((s) => s.submit)),
          tiles: q(samples.map((s) => s.tiles)),
        },
        coarseFrames,
        maxReads,
        plans,
        fallback: w.engineFallback ?? null,
      };
    }, topCard);
    if (ENGINE) {
      expect(dragNoFence.fallback).toBeNull();
      expect(dragNoFence.maxReads).toBeGreaterThan(0);
    }

    // 3. Separate GPU-fenced drag (engine only): isolates pure GPU completion cost per drag frame.
    const dragGpuFenced = ENGINE
      ? await page.evaluate(async (cardId) => {
          const w = window as unknown as W;
          const view = w.drawpaneEngineView;
          if (!view?.last.supported) throw new Error("engine lost before GPU-fenced drag");
          const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
          const q = (xs: number[]): Quantiles => {
            const v = [...xs].sort((a, b) => a - b);
            const at = (p: number) =>
              Math.round((v[Math.floor(p * (v.length - 1))] ?? 0) * 10) / 10;
            return { p50: at(0.5), p95: at(0.95), max: at(1) };
          };
          const gpuMs: number[] = [];
          const plans: Record<string, number> = {};
          let coarseFrames = 0;
          let maxReads = 0;
          let x = 420;
          let y = 310;
          w.drawpane.beginGesture("Drag glass card");
          try {
            for (let i = 0; i < 30; i++) {
              const d = i % 16 < 8 ? 8 : -8;
              x += d;
              y += d / 2;
              w.drawpane.commit([
                { op: "set", id: cardId, prop: "x", value: x },
                { op: "set", id: cardId, prop: "y", value: y },
              ]);
              await frame();
              if (!view.last.exact && view.last.coarse > 0) coarseFrames++;
              maxReads = Math.max(maxReads, view.last.reads);
              plans[view.last.plan] = (plans[view.last.plan] ?? 0) + 1;
              const t = performance.now();
              const done = await view.engine.gpuFinished();
              if (!done.ok) throw new Error("gpuFinished failed during fenced drag");
              gpuMs.push(performance.now() - t);
            }
          } finally {
            w.drawpane.endGesture();
          }
          return {
            samples: gpuMs.length,
            gpuMs: q(gpuMs),
            coarseFrames,
            maxReads,
            plans,
          };
        }, topCard)
      : null;

    // 4. Honest settle timing: start clock at commit (before any rAF), use distinct coordinates on
    //    every trial (including trial 0), require revision advancement + exact drawn/gpu/shown
    //    stamps, fail on timeout or fallback, and preserve every sample.
    const settle = await page.evaluate(
      async ({ cardId, useEngine }) => {
        const w = window as unknown as W;
        const view = w.drawpaneEngineView;
        const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        const waitInitialExact = async () => {
          const deadline = performance.now() + 10_000;
          while (performance.now() < deadline) {
            if (useEngine) {
              if (w.engineFallback || !view?.last.supported) return false;
              if (view.last.exact && view.shown.n >= view.last.n) {
                const done = await view.engine.gpuFinished();
                return done.ok;
              }
            } else if (w.drawpaneFrames.exact !== false) {
              return true;
            }
            await frame();
          }
          return false;
        };
        const spread = (xs: number[]) => {
          const s = [...xs].sort((a, b) => a - b);
          const at = (q: number) =>
            s.length ? Math.round((s[Math.ceil(q * (s.length - 1))] as number) * 10) / 10 : null;
          return { p50: at(0.5), p95: at(0.95), max: at(1) };
        };
        const drawn: number[] = [];
        const gpu: number[] = [];
        const shown: number[] = [];
        let timeouts = 0;
        let fallbacks = 0;
        const trials = 5;
        for (let trial = 0; trial < trials; trial++) {
          const ok0 = await waitInitialExact();
          if (!ok0) {
            timeouts++;
            continue;
          }
          const prevRev = useEngine && view ? view.engine.revision : 0;
          // Distinct coordinates from drag end (420, 310) on every trial, including trial 0.
          const nx = 445 + trial * 14;
          const ny = 325 + trial * 8;
          const t0 = performance.now();
          w.drawpane.commit([
            { op: "set", id: cardId, prop: "x", value: nx },
            { op: "set", id: cardId, prop: "y", value: ny },
          ]);
          if (useEngine && view) view.stamps = {};
          let finished = false;
          const deadline = t0 + 10_000;
          while (performance.now() < deadline) {
            await frame();
            if (useEngine) {
              if (w.engineFallback || !view?.last.supported) {
                fallbacks++;
                break;
              }
              const st = view.stamps;
              if (
                view.last.revision > prevRev &&
                view.last.exact &&
                st?.drawn &&
                st.gpu &&
                st.shown &&
                st.gpu.n === st.drawn.n &&
                st.shown.n >= st.drawn.n
              ) {
                drawn.push(Math.round((st.drawn.at - t0) * 10) / 10);
                gpu.push(Math.round((st.gpu.at - t0) * 10) / 10);
                shown.push(Math.round((st.shown.at - t0) * 10) / 10);
                finished = true;
                break;
              }
            } else if (w.drawpaneFrames.exact !== false) {
              shown.push(Math.round((performance.now() - t0) * 10) / 10);
              finished = true;
              break;
            }
          }
          if (useEngine && view) view.stamps = null;
          if (!finished && fallbacks === 0) timeouts++;
        }
        return {
          trials,
          timeouts,
          fallbacks,
          readsBack: useEngine ? !!view?.readsBack : false,
          drawn: spread(drawn),
          gpu: spread(gpu),
          shown: spread(shown),
          samples: { drawn, gpu, shown },
        };
      },
      { cardId: topCard, useEngine: ENGINE },
    );
    expect(settle.fallbacks, "engine fell back during settle").toBe(0);
    expect(settle.timeouts, "settle timed out waiting for exact presented frame").toBe(0);
    expect(settle.samples.shown).toHaveLength(settle.trials);

    const engine = await measureEngineGpu(page);
    const label = ENGINE ? "engine" : "canvas";
    console.log(
      `\nStacked glass (${label}, adapter=${ready.adapter ?? "canvas"}, readsBack=${settle.readsBack}):\n${summaryRow(`${label}: pan`, panSummary)}\n${summaryRow(`${label}: drag (no-fence)`, dragNoFence.summary)}\nsettle (${settle.trials} trials, 0 timeouts): drawn p50/max ${settle.drawn.p50 ?? "-"}/${settle.drawn.max ?? "-"} ms · gpu ${settle.gpu.p50 ?? "-"}/${settle.gpu.max ?? "-"} ms · shown ${settle.shown.p50 ?? "-"}/${settle.shown.max ?? "-"} ms · coarseFrames=${dragNoFence.coarseFrames}${dragGpuFenced ? ` · drag GPU-fenced p50/p95 ${dragGpuFenced.gpuMs.p50}/${dragGpuFenced.gpuMs.p95} ms` : ""}${engine ? `\n${JSON.stringify(engine)}` : ""}\n`,
    );
    if (ENGINE) {
      expect(engine?.drawnBy).toBe("engine");
      if (engine?.drawnBy === "engine") {
        expect(engine.exactWhole.reads).toBeGreaterThan(0);
        expect(engine.coarseWhole.reads).toBeGreaterThan(0);
        expect(engine.exactWhole.plans.unchanged ?? 0).toBe(0);
        expect(engine.coarseWhole.plans.unchanged ?? 0).toBe(0);
        if (!engine.software) {
          expect
            .soft(engine.coarseWhole.gpu.p95, "stacked coarse GPU fence p95")
            .toBeLessThanOrEqual(FRAME_BUDGET_MS);
          expect
            .soft(engine.exactWhole.gpu.p95, "stacked exact GPU fence p95")
            .toBeLessThanOrEqual(EXACT_FENCE_BUDGET_MS);
        }
      }
    }
    test.info().annotations.push({
      type: "bench",
      description: JSON.stringify({
        [`${label}: stacked pan`]: panSummary,
        [`${label}: stacked drag (no-fence)`]: dragNoFence.summary,
        [`${label}: stacked drag meta`]: {
          coarseFrames: dragNoFence.coarseFrames,
          maxReads: dragNoFence.maxReads,
          plans: dragNoFence.plans,
          shownCount: dragNoFence.shownCount,
          shownInterval: dragNoFence.shownInterval,
          sampledFrameCount: dragNoFence.sampledFrameCount,
          work: dragNoFence.work,
        },
        ...(dragGpuFenced ? { "engine: stacked drag (gpu-fenced)": dragGpuFenced } : {}),
        [`${label}: settle`]: settle,
        ...(engine ? { "engine: stacked forced whole": engine } : {}),
        intact,
      }),
    });
    expect(dragNoFence.summary.frames).toBeGreaterThan(30);
    if (engine?.drawnBy === "engine") {
      expect(dragNoFence.coarseFrames, "drag must execute coarse reader passes").toBeGreaterThan(0);
      if (!engine.software) {
        expect
          .soft(dragNoFence.summary.content.p95, "drag main-thread p95")
          .toBeLessThanOrEqual(MOVING_CONTENT_BUDGET_MS);
        if (!engine.readsBack) {
          expect(dragNoFence.shownCount).toBeGreaterThan(30);
          expect
            .soft(dragNoFence.shownInterval.p95, "drag presentation interval p95")
            .toBeLessThanOrEqual(FRAME_BUDGET_MS);
          expect
            .soft(dragNoFence.shownInterval.p99, "drag presentation interval p99")
            .toBeLessThanOrEqual(20);
        }
        expect
          .soft(settle.shown.max ?? Infinity, "latest revision shown after settle")
          .toBeLessThanOrEqual(SETTLE_BUDGET_MS);
      }
    }
  });
});
