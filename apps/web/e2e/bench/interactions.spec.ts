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
import { buildFile } from "./cards";
import {
  type CaseResult,
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
const RENDERERS: Array<"canvas" | "engine"> =
  process.env.BENCH_RENDERER === "both"
    ? ["canvas", "engine"]
    : process.env.BENCH_RENDERER === "engine"
      ? ["engine"]
      : ["canvas"];

/** Picks the renderer for pages opened from here on. */
async function useRenderer(page: Page, renderer: "canvas" | "engine"): Promise<void> {
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
        last: { supported: boolean };
        engine: { gpu: { adapter: string } | null; records: number };
        unsupported(): Record<string, number>;
      };
    };
    const v = w.drawpaneEngineView;
    if (!v) return { drawnBy: "canvas" };
    return v.last.supported
      ? { drawnBy: "engine", adapter: v.engine.gpu?.adapter ?? null, records: v.engine.records }
      : {
          drawnBy: "canvas",
          reason: "the page holds what the engine doesn't draw yet",
          unsupported: v.unsupported(),
        };
  });
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

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    instance = await freshInstance(browser, { port: PORT, inspectorPort: PORT + 540 });
    const page = instance.page;
    page.on("pageerror", (error) => console.log(`page error: ${error.message}`));
    await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  const save = (name: string, profile: unknown) => {
    if (PROFILE) console.log(summarizeProfile(PROFILE, name, profile));
  };

  test("on a simple 10,000-layer file", async () => {
    test.skip(!!ONLY && !ONLY.includes("simple"), "Not in BENCH_ONLY.");
    test.setTimeout(60 * 60_000);
    const page = instance.page;
    for (const renderer of RENDERERS) {
      await useRenderer(page, renderer);
      await page.goto("/");
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      expect(await buildFile(page, 400, !RENDERERS.includes("engine"))).toBe(10_000);
      await page.waitForTimeout(1500);
      await settle(page);
      await installProbe(page);
      const cdp = await page.context().newCDPSession(page);
      if (PROFILE) await cdp.send("Profiler.enable");
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
      const results = await interactions(page, targets, {
        frames: FRAMES,
        profile: profiler(cdp, PROFILE, `simple-${renderer}`, save),
      });
      console.log(
        table(
          `Interactions, simple file (10,000 layers), ${renderer}: ${JSON.stringify(who)}`,
          results,
        ),
      );
      report(`simple-${renderer}`, { ...results, who } as unknown as Record<string, unknown>);
    }
  });

  test("on a generated effect-heavy file", async () => {
    test.skip(!!ONLY && !ONLY.includes("effects"), "Not in BENCH_ONLY.");
    test.setTimeout(60 * 60_000);
    const page = instance.page;
    await useRenderer(page, RENDERERS.at(-1) ?? "canvas");
    await page.goto("/");
    const kit = generateEffectKit();
    const fileId = await importNodes(page, kit.nodes, "Effects");
    const open = await openFile(page, fileId);
    await page.waitForTimeout(3000);
    await settle(page);
    await installProbe(page);
    const cdp = await page.context().newCDPSession(page);
    if (PROFILE) await cdp.send("Profiler.enable");
    const results: Record<string, CaseResult | number> = { open };
    // From the light page to the heavy one, as a designer goes to work on it.
    await switchPage(page, kit.pages[1] as string);
    await settle(page);
    results["switch page"] = await switchPage(page, kit.pages[0] as string);
    await settle(page);
    const targets = await pickTargets(page, await busiestBoard(page));
    const who = await drawnBy(page);
    console.log(`Effect-heavy file drawn by: ${JSON.stringify(who)}`);
    Object.assign(
      results,
      await interactions(page, targets, {
        frames: FRAMES,
        profile: profiler(cdp, PROFILE, "effects", save),
      }),
    );
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
    const page = instance.page;
    await page.goto("/");
    const fileId = await importConverted(page, folder, "Bench");
    const open = await openFile(page, fileId);
    // Fonts and images arrive after the file opens.
    await page.waitForTimeout(5000);
    await settle(page);
    await installProbe(page);
    const cdp = await page.context().newCDPSession(page);
    if (PROFILE) await cdp.send("Profiler.enable");
    const out: Record<string, unknown> = { open };
    console.log(`Opened in ${open} ms.`);
    for (const info of pages) {
      const results: Record<string, CaseResult> = {};
      results["switch page"] = await profiler(
        cdp,
        PROFILE,
        info.name,
        save,
      )("switch page", () => switchPage(page, info.id));
      await settle(page);
      const board = info.busiest ?? (await busiestBoard(page));
      const targets = await pickTargets(page, board);
      console.log(`${info.name}: targets ${JSON.stringify(targets)}`);
      Object.assign(
        results,
        await interactions(page, targets, {
          frames: FRAMES,
          profile: profiler(cdp, PROFILE, info.name, save),
        }),
      );
      console.log(
        table(
          `Interactions, ${info.name}: ${info.layers} layers, ${info.readers} reading the backdrop, ${info.shadows} shadows`,
          results,
        ),
      );
      out[info.name] = results;
    }
    report("file", out);
  });
});
