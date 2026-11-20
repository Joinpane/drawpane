/**
 * How the editor holds up as files grow to the size of real UI kits
 * (decision 0026): a generated kit (`@drawpane/corpus`: icons, components
 * built of components, pages of screens made of copies) of each size in
 * BENCH_SCALE (default 100,000 layers; "10000,100000,500000" for a sweep) is
 * loaded into the editor the way opening a file loads it (one document
 * reset), then measured:
 *
 * - **load**: the reset, then its largest page shown (`opening`): when a
 *   useful image of it was first on screen, and when its exact frame was
 *   drawn, finished by the GPU and shown (a large page shows a stand-in
 *   first and is drawn a few tiles a frame, decision 0028);
 * - **memory**: the JS heap after a collection, file loaded;
 * - **canvas**: panning the largest page whole, at 25% and at 100%, and
 *   zooming it (content and overlay time per frame, as the canvas bench);
 * - **edit a main**: a fill change on the most used component, through the
 *   editor's own commit, so every copy follows as it does for a person.
 *
 * With BENCH_COMPACT=1 the file is loaded as a room storing compact copies
 * sends it (decision 0029, phase 4b): mains, instance roots and override
 * records, converted here first as the room converts it, and the editor
 * presents the copies. Without it, as a room storing them materialized
 * sends it. The table says how much the file stores.
 *
 * BENCH_RENDERER=engine draws with the render engine (decision 0040; BENCH_ENGINE_PRESENT=readback
 * where WebGPU canvases don't present): the first frame of the largest page is then also broken
 * down (the display list built and applied, the frame drawn), with who drew it.
 *
 * BENCH_NO_EFFECTS=1 strips every layer's effects before loading (the kit's screens carry drop
 * shadows, which the engine draws only from phase 3: without them its largest page is one the
 * engine draws, for its open time).
 *
 * Prints a table and attaches the numbers as JSON. Budgets aren't enforced
 * here: this VM draws without a GPU, so compare runs on one machine
 * (see the bench notes) and hold the targets on hardware like the PRD's.
 * Run with `pnpm --filter @drawpane/web bench -- scale`.
 */
import { generateKit } from "@drawpane/corpus";
import { compactByInstance, type NodeRecord } from "@drawpane/model";
import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { type Opening, opening, openingRow, pan, type Summary, summaryRow, zoom } from "./frames";

const SIZES = (process.env.BENCH_SCALE ?? "100000").split(",").map(Number);
const RENDERERS: Array<"canvas" | "engine"> =
  process.env.BENCH_RENDERER === "both"
    ? ["canvas", "engine"]
    : process.env.BENCH_RENDERER === "engine"
      ? ["engine"]
      : ["canvas"];
const NO_EFFECTS = process.env.BENCH_NO_EFFECTS === "1";
const COMPACT = process.env.BENCH_COMPACT === "1";
/** Nodes per request when the page fetches the generated file. */
const CHUNK = 20_000;

interface Result {
  layers: number;
  bytes: number;
  copies: number;
  load: { resetMs: number; firstFrameMs: number; exactMs: number };
  /** The largest page shown: a useful image, and the exact frame drawn, finished and shown. */
  open: Opening;
  /** The engine's first frame of the largest page: building and applying the list, drawing. */
  engine?: Record<string, unknown>;
  heapMb: number;
  canvas: Record<string, Summary>;
  editMain: { ms: number; commitMs: number; copies: number };
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

/**
 * Loads the stored nodes into the open file as opening it would: one reset
 * with what the room sends, in the form it stores, the file's own page kept.
 */
async function load(page: Page, chunks: number, compact: boolean): Promise<number> {
  return page.evaluate(
    async ({ chunks, compact }) => {
      const e = (
        window as unknown as {
          drawpane: {
            doc: {
              stored(): unknown[];
              resetStored(nodes: Iterable<unknown>, copies: "materialized" | "compact"): void;
            };
          };
        }
      ).drawpane;
      const all: unknown[] = [...e.doc.stored()];
      for (let i = 0; i < chunks; i++)
        for (const n of (await (await fetch(`/__corpus/${i}`)).json()) as unknown[]) all.push(n);
      const t = performance.now();
      e.doc.resetStored(all, compact ? "compact" : "materialized");
      return performance.now() - t;
    },
    { chunks, compact },
  );
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

/**
 * Shows `pageId`, whole (`opening`): when a useful image was first on screen, and when the
 * exact frame was drawn, finished and shown, stamped with who drew it. With the engine, also
 * where the time went until then (frames, text sent between them, tiles drawn between them) and
 * any page left to the canvas renderer (`fallbacks`). At most 60 s.
 */
async function firstFrame(
  page: Page,
  pageId: string,
): Promise<{
  open: Opening;
  engine: Record<string, unknown> | null;
}> {
  await page.evaluate(() => {
    const w = window as unknown as {
      drawpaneEngineView?: { trace: unknown[] | null };
      benchFallbacks?: unknown[];
    };
    const fallbacks: unknown[] = [];
    w.benchFallbacks = fallbacks;
    window.addEventListener("drawpane:renderer-page-fallback", (e) =>
      fallbacks.push((e as CustomEvent).detail),
    );
    if (w.drawpaneEngineView) w.drawpaneEngineView.trace = [];
  });
  const open = await opening(page, pageId);
  const engine = await page.evaluate(
    ({ t, until }) => {
      type Ev = {
        t: number;
        k: string;
        ms: number;
        tiles: number;
        pending: number;
        encode: number;
        render: number;
        misses: number;
        masked: number;
        outlined: number;
        records: number;
      };
      const w = window as unknown as {
        benchFallbacks?: unknown[];
        drawpaneEngineView?: {
          last: { supported: boolean };
          trace: Ev[] | null;
          engine: { records: number; gpu: { adapter: string } | null };
          opened: object | null;
          unsupported(): Record<string, number>;
        };
      };
      const v = w.drawpaneEngineView;
      if (!v) return null;
      // Where the time went until the exact frame: frames, text sent between them, tiles drawn
      // between them (count, ms, and when the first and last of each ended).
      const spent: Record<
        string,
        { n: number; ms: number; items: number; from: number; to: number }
      > = {};
      const upTo = (v.trace ?? []).filter((ev) => until === null || ev.t - t <= until + 1);
      for (const ev of upTo) {
        const at = ev.t - t;
        const k = spent[ev.k] ?? { n: 0, ms: 0, items: 0, from: at, to: at };
        spent[ev.k] = k;
        k.n++;
        k.ms += ev.ms;
        k.items += ev.k === "text" ? ev.pending : ev.tiles;
        k.to = at;
      }
      for (const k of Object.values(spent)) {
        k.ms = Math.round(k.ms);
        k.from = Math.round(k.from);
        k.to = Math.round(k.to);
      }
      const timeline = upTo
        .map((ev) => {
          const at = `${ev.k[0]}${Math.round(ev.t - t)}:${Math.round(ev.ms)}`;
          if (ev.k === "text") return `${at}/${ev.pending}`;
          if (ev.k === "frame") return `${at}(patch ${Math.round(ev.render)})/${ev.tiles}`;
          if (ev.k === "idle")
            return `${at}(${Math.round(ev.encode)}+${Math.round(ev.render)})/${ev.tiles}/r${ev.records}/g${ev.masked}+${ev.outlined}/m${ev.misses}`;
          return at;
        })
        .join(" ");
      v.trace = null;
      return {
        supported: v.last.supported,
        records: v.engine.records,
        adapter: v.engine.gpu?.adapter ?? null,
        fallbacks: w.benchFallbacks ?? [],
        spent,
        timeline,
        opened: v.opened,
        ...(v.last.supported ? {} : { unsupported: v.unsupported() }),
      };
    },
    { t: open.t0, until: open.exact.drawn },
  );
  return { open, engine };
}

/**
 * Changes a main component's fill through the editor's commit: how long the
 * commit takes (the document, copies and layout), and how long until it's drawn.
 */
async function editMain(
  page: Page,
  mainId: string,
): Promise<{ commitMs: number; drawnMs: number }> {
  return page.evaluate(async (mainId) => {
    const e = (
      window as unknown as {
        drawpane: { setProp(ids: string[], prop: string, value: unknown): void };
      }
    ).drawpane;
    const t = performance.now();
    e.setProp([mainId], "fills", [{ type: "solid", color: "#e8590c" }]);
    const commitMs = performance.now() - t;
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return { commitMs, drawnMs: performance.now() - t };
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
    // BENCH_PORT when another run (another checkout's) has the usual one.
    const port = Number(process.env.BENCH_PORT ?? 8823);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  for (const layers of SIZES)
    test(`${layers.toLocaleString("en")} layers`, async () => {
      test.setTimeout(1_800_000);
      const kit = generateKit({ layers });
      // What the room stores and sends: compact, converted as the room converts it.
      const nodes = NO_EFFECTS
        ? kit.nodes.map((n) => {
            if (!("effects" in n.props)) return n;
            const { effects: _effects, ...props } = n.props as Record<string, unknown>;
            return { ...n, props } as NodeRecord;
          })
        : kit.nodes;
      const sent = COMPACT ? compactByInstance(nodes).nodes : nodes;
      const chunks: string[] = [];
      for (let i = 0; i < sent.length; i += CHUNK)
        chunks.push(JSON.stringify(sent.slice(i, i + CHUNK)));
      const page = instance.page;
      await page.route("**/__corpus/*", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: chunks[Number(route.request().url().split("/").pop())] ?? "[]",
        }),
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");

      for (const renderer of RENDERERS) {
        const engine = renderer === "engine";
        await page.goto("/");
        await page.evaluate(
          ({ engine, present }) => {
            localStorage.setItem("drawpane:debug", "1");
            localStorage.setItem("drawpane:renderer", engine ? "engine" : "canvas");
            localStorage.setItem("drawpane:engine-present", present);
          },
          {
            engine,
            present: process.env.BENCH_ENGINE_PRESENT === "readback" ? "readback" : "webgpu",
          },
        );
        await page.reload();
        await page.getByRole("button", { name: "New file" }).first().click();
        await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
          timeout: 30_000,
        });
        const before = await heapMb(cdp);
        const resetMs = await load(page, chunks.length, COMPACT);
        const storedNow = await stored(page);
        const shown = await firstFrame(page, largestPage(kit.nodes));
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
        const edit = await editMain(page, busiest.id);

        const result: Result = {
          layers: kit.stats.layers,
          bytes: kit.stats.bytes,
          copies: kit.stats.instances,
          load: {
            resetMs: Math.round(resetMs),
            firstFrameMs: shown.open.twoFrames,
            exactMs: shown.open.exactAny,
          },
          open: shown.open,
          ...(shown.engine ? { engine: shown.engine } : {}),
          heapMb: heap,
          canvas,
          editMain: {
            ms: Math.round(edit.drawnMs),
            commitMs: Math.round(edit.commitMs),
            copies: busiest.copies,
          },
          compact: COMPACT,
          stored: storedNow,
        };
        console.log(
          [
            `\nScale: ${result.layers.toLocaleString("en")} layers, ${(result.bytes / 1048576).toFixed(0)} MB of nodes, ${result.copies.toLocaleString("en")} copies${COMPACT ? ", compact copies" : ""}${NO_EFFECTS ? ", effects stripped" : ""}, ${renderer}`,
            `stored      ${result.stored.nodes.toLocaleString("en")} nodes, ${(result.stored.bytes / 1048576).toFixed(0)} MB`,
            `load        reset ${result.load.resetMs} ms, then the largest page shown`,
            openingRow(shown.open),
            ...(result.engine ? [`engine      ${JSON.stringify(result.engine)}`] : []),
            `memory      ${result.heapMb} MB of JS heap for the file`,
            ...Object.entries(canvas).map(([name, r]) => summaryRow(name, r)),
            `edit main   ${result.editMain.ms} ms to change a fill on a main with ${result.editMain.copies.toLocaleString("en")} copies, drawn (the commit ${result.editMain.commitMs} ms)`,
            "",
          ].join("\n"),
        );
        test.info().annotations.push({
          type: "bench",
          description: JSON.stringify({ renderer, ...result }),
        });
      }
      await page.unroute("**/__corpus/*");
    });
});
