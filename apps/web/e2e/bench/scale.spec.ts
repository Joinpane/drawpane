/**
 * How the editor holds up as files grow to the size of real UI kits
 * (decision 0026): a generated kit (`@drawpane/corpus`: icons, components
 * built of components, pages of screens made of copies) of each size in
 * BENCH_SCALE (default 100,000 layers; "10000,100000,500000" for a sweep) is
 * loaded into the editor the way opening a file loads it (one document
 * reset), then measured:
 *
 * - **load**: the reset, then the first frame of its largest page;
 * - **memory**: the JS heap after a collection, file loaded;
 * - **canvas**: panning the largest page whole, at 25% and at 100%, and
 *   zooming it (content and overlay time per frame, as the canvas bench);
 * - **edit a main**: a fill change on the most used component, through the
 *   editor's own commit, so every copy follows as it does for a person.
 *
 * With BENCH_COMPACT=1 the editor keeps copies compact (decision 0029: the
 * file stored as mains, instance roots and override records, copies
 * presented), and the table says how much the file stores.
 *
 * Prints a table and attaches the numbers as JSON. Budgets aren't enforced
 * here: this VM draws without a GPU, so compare runs on one machine
 * (see the bench notes) and hold the targets on hardware like the PRD's.
 * Run with `pnpm --filter @drawpane/web bench -- scale`.
 */
import { generateKit } from "@drawpane/corpus";
import type { NodeRecord } from "@drawpane/model";
import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { pan, type Summary, summaryRow, zoom } from "./frames";

const SIZES = (process.env.BENCH_SCALE ?? "100000").split(",").map(Number);
const COMPACT = process.env.BENCH_COMPACT === "1";
/** Nodes per request when the page fetches the generated file. */
const CHUNK = 20_000;

interface Result {
  layers: number;
  bytes: number;
  copies: number;
  load: { resetMs: number; firstFrameMs: number };
  heapMb: number;
  canvas: Record<string, Summary>;
  editMain: { ms: number; copies: number };
  compact: boolean;
  /** What the document stores once loaded (with compact copies, far fewer than it shows). */
  stored: { nodes: number; bytes: number };
}

async function heapMb(cdp: CDPSession): Promise<number> {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  return Math.round(used / 1048576);
}

/** Loads `nodes` into the open file as opening it would: one reset, the file's own page kept. */
async function load(page: Page, chunks: number): Promise<number> {
  return page.evaluate(async (chunks) => {
    const e = (
      window as unknown as {
        drawpane: { doc: { nodes(): Iterable<unknown>; reset(nodes: Iterable<unknown>): void } };
      }
    ).drawpane;
    const all: unknown[] = [...e.doc.nodes()];
    for (let i = 0; i < chunks; i++)
      for (const n of (await (await fetch(`/__corpus/${i}`)).json()) as unknown[]) all.push(n);
    const t = performance.now();
    e.doc.reset(all);
    return performance.now() - t;
  }, chunks);
}

/** What the loaded document stores: nodes and JSON bytes. */
async function stored(page: Page): Promise<{ nodes: number; bytes: number }> {
  return page.evaluate(() => {
    const doc = (window as unknown as { drawpane: { doc: { stored(): unknown[] } } }).drawpane.doc;
    const nodes = doc.stored();
    let bytes = 0;
    for (const n of nodes) bytes += JSON.stringify(n).length + 1;
    return { nodes: nodes.length, bytes };
  });
}

/** Shows `pageId`, whole, and returns how long until its first frame was drawn. */
async function firstFrame(page: Page, pageId: string): Promise<number> {
  return page.evaluate(async (pageId) => {
    const e = (window as unknown as { drawpane: { setPage(id: string): void; zoomToFit(): void } })
      .drawpane;
    const t = performance.now();
    e.setPage(pageId);
    e.zoomToFit();
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return performance.now() - t;
  }, pageId);
}

/** Changes a main component's fill through the editor's commit; how long until it's drawn. */
async function editMain(page: Page, mainId: string): Promise<number> {
  return page.evaluate(async (mainId) => {
    const e = (
      window as unknown as {
        drawpane: { setProp(ids: string[], prop: string, value: unknown): void };
      }
    ).drawpane;
    const t = performance.now();
    e.setProp([mainId], "fills", [{ type: "solid", color: "#e8590c" }]);
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return performance.now() - t;
  }, mainId);
}

/** The page with the most layers under it. */
function largestPage(nodes: readonly NodeRecord[]): string {
  const parent = new Map(nodes.map((n) => [n.id, n.parent]));
  const pages = new Set(nodes.filter((n) => n.type === "page").map((n) => n.id));
  const count = new Map<string, number>();
  for (const n of nodes) {
    let at = n.parent;
    while (at && !pages.has(at)) at = parent.get(at) ?? "";
    if (at) count.set(at, (count.get(at) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] as string;
}

test.describe("Scale", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    instance = await freshInstance(browser, { port: 8823, inspectorPort: 9363 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  for (const layers of SIZES)
    test(`${layers.toLocaleString("en")} layers`, async () => {
      test.setTimeout(1_800_000);
      const kit = generateKit({ layers });
      const chunks: string[] = [];
      for (let i = 0; i < kit.nodes.length; i += CHUNK)
        chunks.push(JSON.stringify(kit.nodes.slice(i, i + CHUNK)));
      const page = instance.page;
      await page.route("**/__corpus/*", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: chunks[Number(route.request().url().split("/").pop())] ?? "[]",
        }),
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");

      await page.goto("/");
      await page.evaluate((compact) => {
        localStorage.setItem("drawpane:debug", "1");
        if (compact) localStorage.setItem("drawpane:compact-copies", "1");
        else localStorage.removeItem("drawpane:compact-copies");
      }, COMPACT);
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 30_000,
      });
      const before = await heapMb(cdp);
      const resetMs = await load(page, chunks.length);
      chunks.length = 0;
      const storedNow = await stored(page);
      const firstFrameMs = await firstFrame(page, largestPage(kit.nodes));
      // Let fonts and the first full paint settle.
      await page.waitForTimeout(1500);
      const heap = (await heapMb(cdp)) - before;

      const canvas: Record<string, Summary> = {};
      for (const level of ["fit", 0.25, 1] as const)
        canvas[level === "fit" ? "pan, whole" : `pan, ${level * 100}%`] = await pan(
          page,
          level,
          120,
        );
      canvas["zoom, whole"] = await zoom(page, 120);
      const busiest = kit.busiestMains[0] as { id: string; copies: number };
      const editMs = await editMain(page, busiest.id);

      const result: Result = {
        layers: kit.stats.layers,
        bytes: kit.stats.bytes,
        copies: kit.stats.instances,
        load: { resetMs: Math.round(resetMs), firstFrameMs: Math.round(firstFrameMs) },
        heapMb: heap,
        canvas,
        editMain: { ms: Math.round(editMs), copies: busiest.copies },
        compact: COMPACT,
        stored: storedNow,
      };
      console.log(
        [
          `\nScale: ${result.layers.toLocaleString("en")} layers, ${(result.bytes / 1048576).toFixed(0)} MB of nodes, ${result.copies.toLocaleString("en")} copies${COMPACT ? ", compact copies" : ""}`,
          `stored      ${result.stored.nodes.toLocaleString("en")} nodes, ${(result.stored.bytes / 1048576).toFixed(0)} MB`,
          `load        reset ${result.load.resetMs} ms · first frame of the largest page ${result.load.firstFrameMs} ms`,
          `memory      ${result.heapMb} MB of JS heap for the file`,
          ...Object.entries(canvas).map(([name, r]) => summaryRow(name, r)),
          `edit main   ${result.editMain.ms} ms to change a fill on a main with ${result.editMain.copies.toLocaleString("en")} copies`,
          "",
        ].join("\n"),
      );
      test.info().annotations.push({ type: "bench", description: JSON.stringify(result) });
      await page.unroute("**/__corpus/*");
    });
});
