/**
 * What a designer does to a file, measured as named cases (see
 * `interactions.ts`): hover, select on the canvas and in the layers panel,
 * drag, resize, nudge, type, change a fill and an effect, undo, and pan and
 * zoom at fit, 100%, 200% and 400% on a busy board. On three files:
 *
 * - **simple**: 400 cards of 25 layers (10,000 layers, the canvas
 *   benchmark's file), the reference: an interaction on an effect-heavy
 *   file should cost no more than about twice what it costs here;
 * - **effects**: a generated file of phone screens full of glass,
 *   background blur, shadows, linear blends, masks and text drawn from
 *   saved glyph outlines in a missing font (`@drawpane/corpus`'s
 *   `generateEffectKit`), so runs without licensed data catch regressions;
 * - **a real file**, with BENCH_FILE (a folder kit-parity's convert step
 *   made): opening it, switching to its heaviest pages, and every case on
 *   the busiest board of each (BENCH_PAGES, BENCH_PAGE_COUNT as in
 *   `file.spec.ts`). Skipped without it.
 *
 * BENCH_RENDERER=engine draws with the render engine (decision 0040), the simple file without
 * the cards' shadows (the engine doesn't draw them yet); BENCH_RENDERER=both runs the simple file
 * with the canvas renderer and then the engine, each on its own copy, in one browser.
 * BENCH_ENGINE_PRESENT=readback where WebGPU canvases don't present (the GPU bench). A page the
 * engine doesn't draw (the effect-heavy file's glass and blurs) falls back to the canvas renderer,
 * which the results say (`drawnBy`).
 *
 * BENCH_PROFILE=<dir> saves a CPU profile per case and prints where the
 * time went; BENCH_OUT=<file> writes the numbers as JSON (the file's name
 * gets the case set's name). BENCH_ONLY=simple,effects,file picks files.
 * Compare runs of two commits on one machine, back to back.
 * Run with `pnpm --filter @drawpane/web bench -- bench/interactions`.
 */
import { writeFileSync } from "node:fs";
import { generateEffectKit } from "@drawpane/corpus";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { importConverted, importNodes } from "../import-converted";
import { benchShadows, buildFile } from "./cards";
import {
  captureRendererState,
  type DomRendererSnapshot,
  installFallbackRecorder,
  verifyEngineBenchmark,
  verifyScenarioCheckpoint,
} from "./engine-gate";
import {
  type CaseResult,
  caseDeadline,
  type GestureCheckpointSpec,
  type GestureGate,
  installProbe,
  interactions,
  pickTargets,
  profiler,
  settle,
  switchPage,
  table,
} from "./interactions";
import { pagesOf } from "./kit-pages";
import { summarizeProfile } from "./profile";

const FILE = process.env.BENCH_FILE;
const PROFILE = process.env.BENCH_PROFILE;
const ONLY = process.env.BENCH_ONLY?.split(",");
const PAGE_COUNT = Number(process.env.BENCH_PAGE_COUNT ?? 2);
const FRAMES = Number(process.env.BENCH_FRAMES ?? 60);
const NAMED = process.env.BENCH_PAGES
  ? process.env.BENCH_PAGES.split(",").map((s) => s.trim())
  : null;
const PORT = Number(process.env.BENCH_PORT ?? 8977);
const RENDERER_ENV = process.env.BENCH_RENDERER ?? "canvas";
const RENDERERS: string[] = RENDERER_ENV === "both" ? ["canvas", "engine"] : [RENDERER_ENV];
const SHADOWS = benchShadows();

/** Picks the renderer for pages opened from here on. */
async function useRenderer(page: Page, renderer: string): Promise<void> {
  await page.evaluate(
    ({ renderer, present }) => {
      localStorage.setItem("drawpane:renderer", renderer);
      localStorage.setItem("drawpane:engine-present", present);
    },
    {
      renderer,
      present: process.env.BENCH_ENGINE_PRESENT === "readback" ? "readback" : "webgpu",
    },
  );
}

/** Who drew the page: the engine (and on what), or the canvas renderer and why. */
async function drawnBy(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const w = window as unknown as {
      drawpaneEngineView?: {
        backend: string;
        adapter: string;
        last: { supported: boolean };
        engine: { gpu: { adapter: string } | null; records: number } | null;
        unsupported(): Record<string, number>;
      };
    };
    const v = w.drawpaneEngineView;
    if (!v) return { drawnBy: "canvas" };
    return v.last.supported
      ? {
          drawnBy: "engine",
          backend: v.backend,
          adapter: v.engine?.gpu?.adapter ?? v.adapter ?? null,
          records: v.engine?.records ?? null,
        }
      : {
          drawnBy: "canvas",
          reason: "the page holds what the engine doesn't draw yet",
          unsupported: v.unsupported(),
        };
  });
}

async function maybeCdp(page: Page) {
  if (!PROFILE || page.context().browser()?.browserType().name() !== "chromium") return null;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  return cdp;
}

// A trace snapshots the page on every action: that would be most of what a click measures.
test.use({ trace: "off" });

function report(name: string, results: Record<string, unknown>): void {
  test.info().annotations.push({ type: "bench", description: JSON.stringify(results) });
  const out = process.env.BENCH_OUT;
  if (out)
    writeFileSync(
      out.replace(/(\.json)?$/, `.${name}.json`),
      `${JSON.stringify(results, null, 1)}\n`,
    );
}

async function openFile(page: Page, fileId: string): Promise<number> {
  const t = Date.now();
  await page.goto(`/f/${fileId}`);
  await page.waitForFunction(
    () =>
      (window as unknown as { drawpane?: { s: { status: string } } }).drawpane?.s.status === "live",
    undefined,
    { timeout: 30 * 60_000, polling: 250 },
  );
  return Date.now() - t;
}

/** The top-level layer on the current page with the most effects under it. */
async function busiestBoard(page: Page): Promise<string> {
  return page.evaluate(() => {
    type Node = { id: string; props: Record<string, unknown> };
    const e = (
      window as unknown as {
        drawpane: {
          s: { pageId: string };
          doc: { get(id: string): Node | undefined; childIds(id: string): readonly string[] };
        };
      }
    ).drawpane;
    const weight = (id: string): number => {
      const n = e.doc.get(id);
      let w = 0;
      for (const x of (n?.props.effects as Array<{ type: string }> | undefined) ?? [])
        w += x.type === "glass" || x.type === "background-blur" ? 4 : 1;
      for (const c of e.doc.childIds(id)) w += weight(c);
      return w;
    };
    const tops = e.doc.childIds(e.s.pageId);
    return [...tops].sort((a, b) => weight(b) - weight(a))[0] as string;
  });
}

test.describe("Interactions", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;
  let benchPage: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    instance = await freshInstance(browser, { port: PORT, inspectorPort: PORT + 540 });
    const page = instance.page;
    benchPage = page;
    page.on("pageerror", (error) => console.log(`page error: ${error.message}`));
    await installFallbackRecorder(page);
    await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    await useRenderer(page, RENDERERS[0] ?? "canvas");
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  const save = (name: string, profile: unknown) => {
    if (PROFILE) console.log(summarizeProfile(PROFILE, name, profile));
  };

  const sessions = new WeakMap<Page, ReturnType<typeof maybeCdp>>();
  const profileFor =
    (prefix: string) =>
    (page: Page) =>
    async <T>(name: string, work: () => Promise<T>) => {
      let session = sessions.get(page);
      if (!session) {
        session = maybeCdp(page);
        sessions.set(page, session);
      }
      return profiler(await session, PROFILE, prefix, save)(name, work);
    };

  test("on a simple 10,000-layer file", async () => {
    test.skip(!!ONLY && !ONLY.includes("simple"), "Not in BENCH_ONLY.");
    test.setTimeout(60 * 60_000);
    let page = benchPage;
    for (const renderer of RENDERERS) {
      const isEngine = renderer !== "canvas";
      await useRenderer(page, renderer);
      await page.goto("/");
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      expect(await buildFile(page, 400, SHADOWS)).toBe(10_000);
      await page.waitForTimeout(1500);
      await settle(page);
      await installProbe(page);
      const beforeRenderer = await captureRendererState(page);
      const board = await page.evaluate(() => {
        const e = (
          window as unknown as {
            drawpane: { s: { pageId: string }; doc: { childIds(id: string): readonly string[] } };
          }
        ).drawpane;
        const tops = e.doc.childIds(e.s.pageId);
        return tops[Math.floor(tops.length / 2)] as string;
      });
      const targets = await pickTargets(page, board);
      const who = await drawnBy(page);
      const reportKey = RENDERERS.length > 1 ? `simple-${renderer}` : "simple";
      const gestureCheckpoints: Record<
        string,
        {
          submittedFramesDelta: number;
          presentedFramesDelta: number;
          confirmedFrame: number | null;
          fallbackFramesDelta: number;
          compositedNonBlank: boolean;
          compositedNonBackgroundRatio: number;
          deltaFromPrevious: number | null;
          changedCellsFromPrevious: number | null;
        }
      > = {};
      const gestureGate: GestureGate | undefined = isEngine
        ? {
            before: (page) => captureRendererState(page, { sampleSurface: true }),
            verify: async (
              page: Page,
              name: string,
              before: unknown,
              spec: GestureCheckpointSpec,
            ) => {
              const cp = await verifyScenarioCheckpoint(
                page,
                before as DomRendererSnapshot,
                `bench/interactions.spec.ts (${name})`,
                spec,
              );
              gestureCheckpoints[name] = {
                submittedFramesDelta: cp.submittedFramesDelta,
                presentedFramesDelta: cp.presentedFramesDelta,
                confirmedFrame: cp.confirmedFrame,
                fallbackFramesDelta: cp.fallbackFramesDelta,
                compositedNonBlank: cp.compositedNonBlank,
                compositedNonBackgroundRatio: cp.compositedNonBackgroundRatio,
                deltaFromPrevious: cp.deltaFromPrevious,
                changedCellsFromPrevious: cp.changedCellsFromPrevious,
              };
            },
          }
        : undefined;
      const measured = await interactions(page, targets, {
        frames: FRAMES,
        profile: profileFor(reportKey),
        gestureGate,
      });
      const results = measured.results;
      page = measured.page;
      benchPage = page;
      const presentation =
        isEngine && !Object.values(results).some((result) => "error" in result)
          ? await verifyEngineBenchmark(
              page,
              beforeRenderer,
              "bench/interactions.spec.ts (simple)",
              {
                minSubmittedFrames: 100,
                minFrames: 30,
                checkCameraDelta: true,
              },
            )
          : null;
      const workload = {
        renderer,
        layers: 10_000,
        cards: 400,
        shadows: SHADOWS,
        shadowCount: SHADOWS ? 400 : 0,
      };
      const engineMeta = isEngine
        ? {
            backend: presentation?.after.renderer ?? "unknown",
            adapter: presentation?.after.adapter ?? "unknown",
            adapterClass: presentation?.after.adapterClass ?? "unidentified",
            presentationPath: presentation?.after.presentationPath ?? "unknown",
            software: presentation?.after.software ?? false,
            presented: presentation?.after.presented ?? false,
            submittedFramesDelta: presentation?.submittedFramesDelta ?? 0,
            presentedFramesDelta: presentation?.presentedFramesDelta ?? 0,
            fallbackFramesDelta: presentation?.fallbackFramesDelta ?? 0,
            compositedNonBlank: presentation?.compositedNonBlank ?? false,
            cameraChangeRatio: presentation?.cameraChangeRatio ?? null,
            gestureCheckpoints,
          }
        : null;
      console.log(
        `${table(`Interactions, simple file (10,000 layers, ${workload.shadowCount} shadows), ${renderer}: ${JSON.stringify(who)}`, results)}${engineMeta ? `\nengine: ${JSON.stringify(engineMeta)}` : ""}`,
      );
      report(reportKey, {
        workload,
        who,
        ...results,
        ...(engineMeta ? { engine: engineMeta } : {}),
        ...(presentation ? { presentation } : {}),
      });
      expect(
        Object.entries(results).filter(([, result]) => "error" in result),
        "Failed interactions are listed in the benchmark report",
      ).toEqual([]);
    }
  });

  test("on a generated effect-heavy file", async () => {
    test.skip(!!ONLY && !ONLY.includes("effects"), "Not in BENCH_ONLY.");
    test.setTimeout(60 * 60_000);
    const page = benchPage;
    await useRenderer(page, RENDERERS.at(-1) ?? "canvas");
    await page.goto("/");
    const kit = generateEffectKit();
    const fileId = await importNodes(page, kit.nodes, "Effects");
    const open = await openFile(page, fileId);
    await page.waitForTimeout(3000);
    await settle(page);
    await installProbe(page);
    const results: Record<string, CaseResult | number> = { open };
    // From the light page to the heavy one, as a designer goes to work on it.
    await switchPage(page, kit.pages[1] as string);
    await settle(page);
    results["switch page"] = await switchPage(page, kit.pages[0] as string);
    await settle(page);
    const targets = await pickTargets(page, await busiestBoard(page));
    const who = await drawnBy(page);
    console.log(`Effect-heavy file drawn by: ${JSON.stringify(who)}`);
    const measured = await interactions(page, targets, {
      frames: FRAMES,
      profile: profileFor("effects"),
    });
    benchPage = measured.page;
    Object.assign(results, measured.results);
    const { open: _open, ...cases } = results;
    console.log(
      table(
        `Interactions, generated effect-heavy file (${kit.stats.layers} layers), opened in ${open} ms`,
        cases as Record<string, CaseResult>,
      ),
    );
    report("effects", results);
  });

  test("on a real file (BENCH_FILE)", async () => {
    test.skip(!FILE, "Opt-in: set BENCH_FILE to a folder kit-parity's convert step made.");
    test.skip(!!ONLY && !ONLY.includes("file"), "Not in BENCH_ONLY.");
    test.setTimeout(6 * 60 * 60_000);
    const folder = FILE as string;
    const all = pagesOf(folder);
    const pages = NAMED
      ? all.filter((p) => NAMED.includes(p.name) || NAMED.includes(p.id))
      : all.slice(0, PAGE_COUNT);
    let page = benchPage;
    await page.goto("/");
    const fileId = await importConverted(page, folder, "Bench");
    const open = await openFile(page, fileId);
    // Fonts and images arrive after the file opens.
    await page.waitForTimeout(5000);
    const out: Record<string, unknown> = { open };
    console.log(`Opened in ${open} ms.`);
    for (const info of pages) {
      const results: Record<string, CaseResult> = {};
      const profile = profileFor(info.name);
      try {
        results["switch page"] = await caseDeadline(
          profile(page)("switch page", () => switchPage(page, info.id)),
          60_000,
          "switch page",
        );
      } catch (error) {
        results["switch page"] = { error: String(error).split("\n")[0] ?? "Failed" };
      }
      const board = info.busiest ?? (await busiestBoard(page));
      const targets = await pickTargets(page, board);
      console.log(`${info.name}: targets ${JSON.stringify(targets)}`);
      const measured = await interactions(page, targets, { frames: FRAMES, profile });
      Object.assign(results, measured.results);
      page = measured.page;
      benchPage = page;
      console.log(
        table(
          `Interactions, ${info.name}: ${info.layers} layers, ${info.readers} reading the backdrop, ${info.shadows} shadows`,
          results,
        ),
      );
      out[info.name] = { ...results, renderer: await drawnBy(page) };
    }
    report("file", out);
  });
});
