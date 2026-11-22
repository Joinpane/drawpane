/**
 * Panning and zooming a real file, too large or too private to commit: a
 * .fig converted by `tools/kit-parity` (its `convert` step writes the
 * folder: `meta.json`, `nodes.ndjson`, `images/`), named by BENCH_FILE.
 * It's imported into a fresh local instance the way the dashboard saves an
 * import and opened in the editor. Then, on its heaviest pages (the most
 * layers that read the backdrop, glass and background blur, then shadows;
 * or the pages named in BENCH_PAGES, comma separated), BENCH_PAGE_COUNT of
 * them (default 3):
 *
 * - **opening**: the page shown whole (`opening`): when a useful image of it
 *   was first on screen, and when its exact frame was drawn, finished by the
 *   GPU and shown;
 * - **pan**: the whole page, and its busiest top-level frame at 50% and
 *   100% (BENCH_FRAMES animation frames each, default 120);
 * - **zoom**: in and out about the centre from the whole page.
 *
 * With BENCH_PROFILE set to a folder, each measurement is also profiled
 * (a `.cpuprofile` per page and measurement, which Chrome's performance
 * panel opens) and the functions taking the most time are printed.
 *
 * With BENCH_RENDERER=engine the render engine draws (decision 0040, behind its switch; set
 * BENCH_ENGINE_PRESENT=readback where WebGPU canvases don't present, as on the GPU bench's
 * driver), and each page also records which renderer drew it (a page with what phase 1
 * doesn't draw falls back to the canvas renderer, with its features named), the adapter, and
 * the GPU's time per frame (`onSubmittedWorkDone`). On a hardware adapter, the heaviest page
 * measured is held to 0040's confirmed targets, as shown: a useful image within 1 s of opening
 * it, the exact picture within 3 s. When it falls back to the canvas renderer it isn't gated,
 * and the run says so (no lighter page stands in for it). On a software adapter (SwiftShader) nothing is gated and the
 * GPU timings are labelled not representative.
 *
 * Opt-in (skipped without BENCH_FILE), never in CI. Prints a table and
 * attaches the numbers as JSON, and writes them to BENCH_OUT when set, so
 * a change can be compared with its base commit on the same machine (see
 * the bench notes: this VM has no GPU). Run with
 * `BENCH_FILE=<folder> pnpm --filter @drawpane/web bench -- bench/file`.
 */
import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { importConverted } from "../import-converted";
import { cameraReplay, type ReplayScore } from "./camera-replay";
import { type Opening, opening, openingRow, pan, type Summary, summaryRow, zoom } from "./frames";
import { type PageInfo, pagesOf } from "./kit-pages";
import { profiled } from "./profile";

const FILE = process.env.BENCH_FILE;
const PAGE_COUNT = Number(process.env.BENCH_PAGE_COUNT ?? 3);
const FRAMES = Number(process.env.BENCH_FRAMES ?? 120);
const NAMED = process.env.BENCH_PAGES
  ? process.env.BENCH_PAGES.split(",").map((s) => s.trim())
  : null;
/** A folder for a CPU profile of each measurement (`.cpuprofile`, for Chrome's performance panel). */
const PROFILE = process.env.BENCH_PROFILE;
/** Which renderer draws: "canvas" (default) or "engine" (decision 0040's switch). */
const PRESENT = process.env.BENCH_ENGINE_PRESENT;
const VERIFIED = process.env.BENCH_VERIFIED_BACKENDS;
const READBACK = PRESENT === "readback" || (PRESENT === "auto" && VERIFIED === "webgpu");
const RENDERER = process.env.BENCH_RENDERER === "engine" ? "engine" : "canvas";
const REPLAY = RENDERER === "engine" && process.env.BENCH_W4_REPLAY === "1";
/** Decision 0040's confirmed targets on the heaviest page, on real GPU hardware. */
const USEFUL_IMAGE_MS = 1000;
const EXACT_MS = 3000;

interface EngineFacts {
  /** Who drew the page: the engine, or the canvas renderer (the page holds what phase 1 doesn't draw). */
  renderer: "engine" | "canvas";
  unsupported: Record<string, number>;
  adapter: string | null;
  backend?: string;
  software: boolean;
  /** GPU time per frame while panning, from submit to `onSubmittedWorkDone` (ms). */
  gpuMs: { p50: number; p95: number; max: number } | null;
  note?: string;
}

interface PageResult {
  page: PageInfo;
  /** The page shown: a useful image, and the exact frame drawn, finished and shown (`opening`). */
  open: Opening;
  canvas: Record<string, Summary>;
  engine?: EngineFacts;
  replay?: Record<string, ReplayScore>;
}

/** What the engine did on the page shown, and its GPU's time per frame over a pan. */
async function engineFacts(page: Page, frames: number): Promise<EngineFacts> {
  return page.evaluate(async (frames) => {
    type View = {
      last: { supported: boolean };
      unsupported(): Record<string, number>;
      engine: {
        gpu: { adapter: string; fallback: boolean; backend: string } | null;
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
    if (!view)
      return {
        renderer: "canvas" as const,
        unsupported: {},
        adapter: null,
        software: false,
        gpuMs: null,
        note: "the engine didn't start (see the console)",
      };
    const gpu = view.engine.gpu;
    const unsupported = view.unsupported();
    if (!view.last.supported)
      return {
        renderer: "canvas" as const,
        unsupported,
        adapter: gpu?.adapter ?? null,
        software: !!gpu?.fallback,
        gpuMs: null,
      };
    const times: number[] = [];
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    for (let i = 0; i < frames; i++) {
      w.drawpane.state.set({ camera: w.drawpane.s.camera.pan(i % 60 < 30 ? 6 : -6, 3) });
      await frame();
      const t = performance.now();
      await view.engine.gpuFinished();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const at = (q: number) =>
      Math.round((times[Math.floor(q * (times.length - 1))] ?? 0) * 10) / 10;
    return {
      renderer: "engine" as const,
      unsupported,
      adapter: gpu?.adapter ?? null,
      ...(gpu ? { backend: gpu.backend } : {}),
      software: !!gpu?.fallback,
      gpuMs: { p50: at(0.5), p95: at(0.95), max: at(1) },
      ...(gpu?.fallback ? { note: "software adapter: GPU timings not representative" } : {}),
    };
  }, frames);
}

/** Centres the view on a layer, at most at 100%, and waits until the canvas is exact. */
async function focus(page: Page, id: string): Promise<void> {
  await page.evaluate(async (id) => {
    type Camera = { fit(b: unknown, v: unknown, m: number, max: number, i: unknown): Camera };
    const w = window as unknown as {
      drawpane: {
        s: { camera: Camera; viewport: unknown; insets: unknown };
        scene: { bounds(id: string): unknown };
        setCamera(c: Camera): void;
      };
      drawpaneFrames: { exact: boolean };
    };
    const e = w.drawpane;
    const bounds = e.scene.bounds(id);
    if (bounds) e.setCamera(e.s.camera.fit(bounds, e.s.viewport, 64, 1, e.s.insets));
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    await frame();
    while (!w.drawpaneFrames.exact) await frame();
  }, id);
}

/** Waits for the canvas to be exact (a zoom settles a moment after it stops). */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(400);
  await page.waitForFunction(
    () => (window as unknown as { drawpaneFrames: { exact: boolean } }).drawpaneFrames.exact,
    undefined,
    { timeout: 600_000, polling: 100 },
  );
}

test.describe("A real file", () => {
  test.skip(!FILE, "Opt-in: set BENCH_FILE to a folder kit-parity's convert step made.");
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const port = Number(process.env.BENCH_PORT ?? 8829);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("pans and zooms its heaviest pages", async () => {
    test.setTimeout(6 * 60 * 60_000);
    const folder = FILE as string;
    const all = pagesOf(folder);
    const pages = NAMED
      ? all.filter((p) => NAMED.includes(p.name) || NAMED.includes(p.id))
      : all.slice(0, PAGE_COUNT);
    console.log(
      `Pages, heaviest first:\n${all
        .map(
          (p) =>
            `  ${p.name}: ${p.layers} layers, ${p.readers} glass or background blur, ${p.shadows} shadows, ${p.blurs} layer blurs`,
        )
        .join("\n")}`,
    );
    const page = instance.page;
    const cdp =
      PROFILE && page.context().browser()?.browserType().name() === "chromium"
        ? await page.context().newCDPSession(page)
        : null;
    if (cdp) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
    }
    page.on("pageerror", (error) => console.log(`page error: ${error.message}`));
    await page.evaluate(
      ({ renderer, present, software }) => {
        localStorage.setItem("drawpane:debug", "1");
        localStorage.setItem("drawpane:renderer", renderer);
        localStorage.setItem("drawpane:engine-present", present);
        if (software) localStorage.setItem("drawpane:engine-software", "allow");
      },
      {
        renderer: RENDERER,
        present: READBACK ? "readback" : "webgpu",
        software: process.env.BENCH_ALLOW_SOFTWARE === "1",
      },
    );
    const started = Date.now();
    const fileId = await importConverted(page, folder, "Bench");
    const importSeconds = Math.round((Date.now() - started) / 1000);
    const openingAt = Date.now();
    await page.goto(`/f/${fileId}`);
    await page.waitForFunction(
      () =>
        (window as unknown as { drawpane?: { s: { status: string } } }).drawpane?.s.status ===
        "live",
      undefined,
      { timeout: 30 * 60_000, polling: 1000 },
    );
    const openSeconds = Math.round((Date.now() - openingAt) / 1000);
    console.log(`Imported in ${importSeconds} s, opened in ${openSeconds} s.`);
    // Fonts and images arrive after the file opens.
    await page.waitForTimeout(5000);

    const results: PageResult[] = [];
    for (const info of pages) {
      const at = (what: string) => `${info.name} ${what}`;
      const shown = await profiled(cdp, PROFILE, at("first frame"), async () => {
        const shown = await opening(page, info.id);
        await settle(page);
        return shown;
      });
      const canvas: Record<string, Summary> = {};
      canvas["pan, whole"] = await profiled(cdp, PROFILE, at("pan whole"), () =>
        pan(page, "fit", FRAMES),
      );
      await settle(page);
      canvas["zoom, whole"] = await profiled(cdp, PROFILE, at("zoom whole"), () =>
        zoom(page, FRAMES),
      );
      await settle(page);
      if (info.busiest)
        for (const level of [0.5, 1]) {
          await focus(page, info.busiest);
          canvas[`pan, ${level * 100}%`] = await profiled(
            cdp,
            PROFILE,
            at(`pan ${level * 100}`),
            () => pan(page, level, FRAMES),
          );
          await settle(page);
        }
      const result: PageResult = {
        page: info,
        open: shown,
        canvas,
        ...(RENDERER === "engine" ? { engine: await engineFacts(page, Math.min(FRAMES, 60)) } : {}),
      };
      if (REPLAY) {
        const replay: Record<string, ReplayScore> = {};
        for (const gesture of Object.keys(canvas)) {
          const kind = gesture.startsWith("zoom") ? "zoom" : "pan";
          const level = gesture.endsWith("100%") ? 1 : gesture.endsWith("50%") ? 0.5 : "fit";
          if (typeof level === "number" && info.busiest) await focus(page, info.busiest);
          await settle(page);
          replay[gesture] = await cameraReplay(page, kind, level, FRAMES);
        }
        result.replay = replay;
      }
      results.push(result);
      console.log(
        [
          `\n${info.name}: ${info.layers} layers, ${info.readers} reading the backdrop, ${info.shadows} shadows`,
          openingRow(result.open),
          ...(result.engine
            ? [
                `drawn by ${result.engine.renderer}${result.engine.renderer === "canvas" ? ` (${JSON.stringify(result.engine.unsupported)})` : ""} on ${result.engine.adapter}${result.engine.gpuMs ? `, GPU ${result.engine.gpuMs.p50} / ${result.engine.gpuMs.p95} ms per frame` : ""}${result.engine.note ? ` (${result.engine.note})` : ""}`,
              ]
            : []),
          ...Object.entries(canvas).map(([name, r]) => summaryRow(name, r)),
        ].join("\n"),
      );
    }
    const report = { import: importSeconds, open: openSeconds, frames: FRAMES, pages: results };
    test.info().annotations.push({ type: "bench", description: JSON.stringify(report) });
    if (process.env.BENCH_OUT)
      writeFileSync(process.env.BENCH_OUT, `${JSON.stringify(report, null, 1)}\n`);
    expect(results.length).toBeGreaterThan(0);
    if (REPLAY) {
      for (const result of results) {
        for (const [gesture, score] of Object.entries(result.replay ?? {})) {
          const detail = "error" in score ? `: ${score.error}` : "";
          expect
            .soft(score.pass, `${result.page.name}, ${gesture} pixel fidelity${detail}`)
            .toBe(true);
        }
      }
    }
    if (RENDERER === "engine" && process.env.BENCH_W4_CAMERA_GATE === "1") {
      for (const result of results) {
        expect.soft(result.engine?.renderer, result.page.name).toBe("engine");
        if (VERIFIED === "webgl2" || VERIFIED === "webgpu")
          expect.soft(result.engine?.backend, result.page.name).toBe(VERIFIED);
        if (process.env.BENCH_ALLOW_SOFTWARE !== "1")
          expect.soft(result.engine?.software, result.page.name).toBe(false);
        for (const [gesture, summary] of Object.entries(result.canvas)) {
          const label = `${result.page.name}, ${gesture}`;
          const motion = summary.motion;
          expect.soft(motion, `${label} motion samples`).toBeDefined();
          if (!motion) continue;
          if (!REPLAY) {
            expect.soft(motion.degradedConfirmed, `${label} degraded presentations`).toBe(0);
            expect.soft(motion.degradedSubmitted, `${label} degraded submissions`).toBe(0);
          }
          expect.soft(motion.fallback, `${label} renderer fallbacks`).toBe(0);
          expect.soft(motion.missed, `${label} camera requests without a frame`).toBe(0);
          expect.soft(motion.confirmed, `${label} confirmed presentations`).toBeGreaterThan(1);
          if (!READBACK && process.env.BENCH_ALLOW_SOFTWARE !== "1") {
            expect
              .soft(summary.presentedInterval?.p95, `${label} confirmed presentation interval p95`)
              .toBeLessThanOrEqual(16.7);
            expect
              .soft(summary.presentedInterval?.p99, `${label} confirmed presentation interval p99`)
              .toBeLessThanOrEqual(20);
            expect
              .soft(summary.interval?.p95, `${label} frame interval p95`)
              .toBeLessThanOrEqual(16.7);
            expect
              .soft(summary.interval?.p99, `${label} frame interval p99`)
              .toBeLessThanOrEqual(20);
          }
        }
      }
    }
    // Decision 0040's confirmed targets, on the heaviest page measured, on real hardware: shown
    // (the frame on screen), never a lighter page in its place.
    const gated = results[0];
    if (RENDERER === "engine" && gated?.engine?.renderer === "engine") {
      if (process.env.BENCH_ALLOW_SOFTWARE !== "1") {
        expect(
          gated.engine.software,
          `${gated.page.name}: engine benchmark ran on a software adapter (${gated.engine.adapter})`,
        ).toBe(false);
      }
      if (!gated.engine.software) {
        expect(
          gated.open.useful?.shown ?? Number.POSITIVE_INFINITY,
          `${gated.page.name}: a useful image within ${USEFUL_IMAGE_MS} ms`,
        ).toBeLessThanOrEqual(USEFUL_IMAGE_MS);
        expect(
          gated.open.exact.shown ?? Number.POSITIVE_INFINITY,
          `${gated.page.name}: exact within ${EXACT_MS} ms`,
        ).toBeLessThanOrEqual(EXACT_MS);
      } else {
        test.info().annotations.push({
          type: "engine-gate",
          description: "not gated: software adapter",
        });
      }
    } else if (RENDERER === "engine") {
      test.info().annotations.push({
        type: "engine-gate",
        description: !gated
          ? "not gated: no page measured"
          : `not gated: the heaviest page, ${gated.page.name}, falls back to the canvas renderer (${JSON.stringify(gated.engine?.unsupported ?? {})})`,
      });
    }
  });
});
