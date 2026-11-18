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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { importConverted } from "../import-converted";
import { pan, type Summary, summaryRow, zoom } from "./frames";

const FILE = process.env.BENCH_FILE;
const PAGE_COUNT = Number(process.env.BENCH_PAGE_COUNT ?? 3);
const FRAMES = Number(process.env.BENCH_FRAMES ?? 120);
const NAMED = process.env.BENCH_PAGES
  ? process.env.BENCH_PAGES.split(",").map((s) => s.trim())
  : null;
/** A folder for a CPU profile of each measurement (`.cpuprofile`, for Chrome's performance panel). */
const PROFILE = process.env.BENCH_PROFILE;

interface Effects {
  layers: number;
  readers: number;
  shadows: number;
  blurs: number;
}

interface PageInfo extends Effects {
  id: string;
  name: string;
  /** The top-level layer with the most effects under it: where the close-up pans are. */
  busiest: string | null;
}

interface PageResult {
  page: PageInfo;
  firstFrameMs: number;
  exactMs: number;
  canvas: Record<string, Summary>;
}

/** Each page's layers and effects, from the converted nodes, heaviest first. */
function pagesOf(folder: string): PageInfo[] {
  type Node = {
    id: string;
    type: string;
    parent: string;
    props?: { name?: string; effects?: Array<{ type: string; visible?: boolean }> };
  };
  const nodes: Node[] = [];
  // Split on "\n" only: text may hold "\r".
  for (const line of readFileSync(join(folder, "nodes.ndjson"), "utf8").split("\n"))
    if (line) nodes.push(JSON.parse(line) as Node);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pages = new Map<string, PageInfo>();
  const tops = new Map<string, number>();
  for (const n of nodes)
    if (n.type === "page")
      pages.set(n.id, {
        id: n.id,
        name: n.props?.name ?? n.id,
        layers: 0,
        readers: 0,
        shadows: 0,
        blurs: 0,
        busiest: null,
      });
  for (const n of nodes) {
    if (n.type === "page") continue;
    let top = n;
    let at = byId.get(n.parent);
    while (at && at.type !== "page") {
      top = at;
      at = byId.get(at.parent);
    }
    const page = at && pages.get(at.id);
    if (!page) continue;
    page.layers++;
    let weight = 0;
    for (const e of n.props?.effects ?? []) {
      if (e.visible === false) continue;
      if (e.type === "glass" || e.type === "background-blur") {
        page.readers++;
        weight += 4;
      } else if (e.type === "drop-shadow" || e.type === "inner-shadow") {
        page.shadows++;
        weight += 1;
      } else if (e.type === "layer-blur") {
        page.blurs++;
        weight += 2;
      }
    }
    if (weight > 0) tops.set(top.id, (tops.get(top.id) ?? 0) + weight);
  }
  for (const [id, weight] of tops) {
    const page = pages.get(byId.get(id)?.parent ?? "");
    if (page && (page.busiest === null || weight > (tops.get(page.busiest) ?? 0)))
      page.busiest = id;
  }
  return [...pages.values()].sort(
    (a, b) => b.readers - a.readers || b.shadows - a.shadows || b.layers - a.layers,
  );
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

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children?: number[];
}

/** Runs `work` under the CPU profiler when BENCH_PROFILE is set; saves the profile and prints where the time went. */
async function profiled<T>(cdp: CDPSession, name: string, work: () => Promise<T>): Promise<T> {
  if (!PROFILE) return work();
  await cdp.send("Profiler.start");
  const result = await work();
  const { profile } = (await cdp.send("Profiler.stop")) as {
    profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };
  };
  mkdirSync(PROFILE, { recursive: true });
  writeFileSync(
    join(PROFILE, `${name.replace(/[^\w.-]+/g, "_")}.cpuprofile`),
    JSON.stringify(profile),
  );
  // Self time by function, and time with callees (each function counted once per sample).
  const parent = new Map<number, number>();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const label = (n: ProfileNode) =>
    `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}:${n.callFrame.columnNumber + 1}`;
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  let all = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    all += dt;
    const leaf = byId.get(id);
    if (!leaf) return;
    self.set(label(leaf), (self.get(label(leaf)) ?? 0) + dt);
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const n = byId.get(at);
      if (!n) break;
      const l = label(n);
      if (seen.has(l)) continue;
      seen.add(l);
      total.set(l, (total.get(l) ?? 0) + dt);
    }
  });
  const top = (m: Map<string, number>, k: number) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([l, ms]) => `    ${String(Math.round(ms)).padStart(7)} ms  ${l}`)
      .join("\n");
  console.log(
    `Profile ${name}: ${Math.round(all)} ms\n  self:\n${top(self, 20)}\n  with callees:\n${top(total, 40)}`,
  );
  return result;
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
      const shown = await profiled(cdp, at("first frame"), async () => {
        const shown = await firstFrame(page, info.id);
        await settle(page);
        return shown;
      });
      const canvas: Record<string, Summary> = {};
      canvas["pan, whole"] = await profiled(cdp, at("pan whole"), () => pan(page, "fit", FRAMES));
      await settle(page);
      canvas["zoom, whole"] = await profiled(cdp, at("zoom whole"), () => zoom(page, FRAMES));
      await settle(page);
      if (info.busiest)
        for (const level of [0.5, 1]) {
          await focus(page, info.busiest);
          canvas[`pan, ${level * 100}%`] = await profiled(cdp, at(`pan ${level * 100}`), () =>
            pan(page, level, FRAMES),
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
