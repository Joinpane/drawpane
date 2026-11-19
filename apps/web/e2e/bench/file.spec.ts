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
 * - **first frame**: the page shown whole, and how long until it's exact;
 * - **pan**: the whole page, and its busiest top-level frame at 50% and
 *   100% (BENCH_FRAMES animation frames each, default 120);
 * - **zoom**: in and out about the centre from the whole page.
 *
 * With BENCH_PROFILE set to a folder, each measurement is also profiled
 * (a `.cpuprofile` per page and measurement, which Chrome's performance
 * panel opens) and the functions taking the most time are printed.
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
import { pan, type Summary, summaryRow, zoom } from "./frames";
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

interface PageResult {
  page: PageInfo;
  firstFrameMs: number;
  exactMs: number;
  canvas: Record<string, Summary>;
}

/** Shows `pageId`, whole: how long until its first frame was drawn, and until it was exact. */
async function firstFrame(page: Page, pageId: string): Promise<{ first: number; exact: number }> {
  return page.evaluate(async (pageId) => {
    const w = window as unknown as {
      drawpane: { setPage(id: string): void; zoomToFit(): void };
      drawpaneFrames: { exact: boolean };
    };
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const t = performance.now();
    w.drawpane.setPage(pageId);
    w.drawpane.zoomToFit();
    await frame();
    await frame();
    const first = performance.now() - t;
    while (!w.drawpaneFrames.exact) await frame();
    return { first, exact: performance.now() - t };
  }, pageId);
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
    const cdp = await page.context().newCDPSession(page);
    if (PROFILE) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
    }
    page.on("pageerror", (error) => console.log(`page error: ${error.message}`));
    await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    const started = Date.now();
    const fileId = await importConverted(page, folder, "Bench");
    const importSeconds = Math.round((Date.now() - started) / 1000);
    const opening = Date.now();
    await page.goto(`/f/${fileId}`);
    await page.waitForFunction(
      () =>
        (window as unknown as { drawpane?: { s: { status: string } } }).drawpane?.s.status ===
        "live",
      undefined,
      { timeout: 30 * 60_000, polling: 1000 },
    );
    const openSeconds = Math.round((Date.now() - opening) / 1000);
    console.log(`Imported in ${importSeconds} s, opened in ${openSeconds} s.`);
    // Fonts and images arrive after the file opens.
    await page.waitForTimeout(5000);

    const results: PageResult[] = [];
    for (const info of pages) {
      const at = (what: string) => `${info.name} ${what}`;
      const shown = await profiled(cdp, PROFILE, at("first frame"), async () => {
        const shown = await firstFrame(page, info.id);
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
      const result = {
        page: info,
        firstFrameMs: Math.round(shown.first),
        exactMs: Math.round(shown.exact),
        canvas,
      };
      results.push(result);
      console.log(
        [
          `\n${info.name}: ${info.layers} layers, ${info.readers} reading the backdrop, ${info.shadows} shadows`,
          `first frame ${result.firstFrameMs} ms, exact after ${result.exactMs} ms`,
          ...Object.entries(canvas).map(([name, r]) => summaryRow(name, r)),
        ].join("\n"),
      );
    }
    const report = { import: importSeconds, open: openSeconds, frames: FRAMES, pages: results };
    test.info().annotations.push({ type: "bench", description: JSON.stringify(report) });
    if (process.env.BENCH_OUT)
      writeFileSync(process.env.BENCH_OUT, `${JSON.stringify(report, null, 1)}\n`);
    expect(results.length).toBeGreaterThan(0);
  });
});
