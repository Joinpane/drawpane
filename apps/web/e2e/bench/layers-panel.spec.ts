/**
 * How the layers panel handles a kit-sized tree: a generated kit
 * (`@drawpane/corpus`, BENCH_SCALE layers, default 100,000) is loaded as
 * opening it would, its largest page shown with every frame open, in the
 * narrowest left pane. BENCH_NODES, the path of a file of nodes (one JSON
 * node a line, as the kit-parity harness caches an import), loads that file
 * instead, for a real kit's shape. BENCH_COPIES=compact keeps copies as
 * overrides (decision 0029), as a file imported that way opens.
 *
 * - **Scrolling**: the tree scrolls down a row a frame, and sideways a few
 *   pixels a frame, and for each this counts React commits (through a
 *   stand-in for the devtools hook, which production React also calls) and
 *   the script time per frame. Scrolling down draws the rows coming into
 *   view, so it commits each frame; scrolling sideways moves the drawn rows as
 *   they are (the toggles stick by CSS), so it should commit nothing. Neither
 *   should commit for the rows pinned at the top (they move by CSS too).
 * - **Clicking to select**: rows of different kinds are clicked with the
 *   mouse (the largest top-level frame, an instance, a leaf deep in the tree),
 *   and for each this measures, from the pointerdown, when the row shows
 *   selected (the frame it's painted in), when the canvas draws the selection
 *   and when the inspector has settled (its export preview aside, which waits
 *   for the selection to settle on purpose), and the longest task in between.
 *
 * The canvas finishes drawing the page first, so its script time is the panel's.
 * Compare runs on one machine. BENCH_PROFILE=1 also records a CPU profile of
 * the clicks and prints the functions that took the most time.
 * Run with `pnpm --filter @drawpane/web bench -- layers-panel`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { generateKit } from "@drawpane/corpus";
import type { NodeRecord } from "@drawpane/model";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";

const LAYERS = Number((process.env.BENCH_SCALE ?? "100000").split(",")[0]);
const NODES = process.env.BENCH_NODES;
const COPIES: "compact" | "materialized" =
  process.env.BENCH_COPIES === "compact" ? "compact" : "materialized";
const CHUNK = 20_000;
const FRAMES = 120;
const ROUNDS = 4;

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

function loadNodes(): { nodes: NodeRecord[]; label: string } {
  if (NODES) {
    const nodes = readFileSync(NODES, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as NodeRecord);
    return { nodes, label: `${nodes.length.toLocaleString("en")} nodes from a file` };
  }
  const kit = generateKit({ layers: LAYERS });
  return { nodes: kit.nodes, label: `${kit.stats.layers.toLocaleString("en")} layers` };
}

type Handle = {
  drawpane: {
    s: { selection: readonly string[] };
    doc: {
      get(id: string): NodeRecord | undefined;
      childIds(id: string): readonly string[];
    };
  };
};

// A trace snapshots the page on every action: that would be most of what a click measures.
test.use({ trace: "off" });

test.describe("Layers panel", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;
  let page: Page;
  let label = "";
  let pageId = "";

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(900_000);
    const port = Number(process.env.BENCH_PORT ?? 8824);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
    page = instance.page;
    const loaded = loadNodes();
    label = loaded.label;
    pageId = largestPage(loaded.nodes);
    const chunks: string[] = [];
    for (let i = 0; i < loaded.nodes.length; i += CHUNK)
      chunks.push(JSON.stringify(loaded.nodes.slice(i, i + CHUNK)));
    loaded.nodes.length = 0;
    await page.route("**/__corpus/*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: chunks[Number(route.request().url().split("/").pop())] ?? "[]",
      }),
    );
    // Counts React commits: production React reports each to the devtools hook.
    await page.addInitScript(() => {
      const w = window as unknown as { __commits: number; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
      w.__commits = 0;
      let next = 1;
      w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => next++,
        onCommitFiberRoot: () => {
          w.__commits++;
        },
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        checkDCE: () => {},
      };
    });

    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("drawpane:debug", "1");
      localStorage.setItem(
        "drawpane:panels",
        JSON.stringify({ left: 240, right: 264, pages: 42, minimized: false }),
      );
    });
    await page.reload();
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 30_000,
    });
    await page.evaluate(
      async ({ chunks, copies }) => {
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
        e.doc.resetStored(all, copies);
      },
      { chunks: chunks.length, copies: COPIES },
    );
    chunks.length = 0;
    await page.evaluate(
      (id) =>
        (window as unknown as { drawpane: { setPage(id: string): void } }).drawpane.setPage(id),
      pageId,
    );
    // The canvas draws a large page a few tiles a frame: let it finish, so only the panel is measured.
    await page.waitForFunction(
      () => (window as unknown as { drawpaneFrames?: { exact: boolean } }).drawpaneFrames?.exact,
      null,
      { timeout: 300_000 },
    );
    await page.waitForTimeout(1500);
    await page.mouse.move(700, 450);
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("scrolls the tree", async () => {
    test.setTimeout(300_000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const tree = await page.locator(".layers__scroll").evaluate((el) => ({
      rows: Math.round(el.scrollHeight / 28),
      drawn: el.querySelectorAll('[role="treeitem"]').length,
      wide: el.scrollWidth > el.clientWidth,
    }));

    const scriptMs = async () => {
      const { metrics } = await cdp.send("Performance.getMetrics");
      return (metrics.find((m) => m.name === "ScriptDuration")?.value ?? 0) * 1000;
    };
    const run = async (axis: "down" | "sideways") => {
      const script = await scriptMs();
      const { commits, ms } = await page.evaluate(
        async ({ axis, frames }) => {
          const w = window as unknown as { __commits: number };
          const el = document.querySelector(".layers__scroll") as HTMLElement;
          el.scrollTop = axis === "sideways" ? 28 * 40 : 0;
          el.scrollLeft = 0;
          const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
          await frame();
          await frame();
          const before = w.__commits;
          const t = performance.now();
          for (let i = 0; i < frames; i++) {
            if (axis === "down") el.scrollTop += 28;
            else el.scrollLeft = (i % 40) * 3;
            await frame();
          }
          return { commits: w.__commits - before, ms: performance.now() - t };
        },
        { axis, frames: FRAMES },
      );
      return { commits, frameMs: ms / FRAMES, scriptMs: ((await scriptMs()) - script) / FRAMES };
    };
    const down = await run("down");
    const sideways = await run("sideways");
    const row = (name: string, r: typeof down) =>
      `${name.padEnd(10)} ${String(r.commits).padStart(4)} commits in ${FRAMES} frames · ${r.scriptMs.toFixed(2)} ms script a frame · ${r.frameMs.toFixed(1)} ms a frame`;
    console.log(
      [
        `\nLayers panel: ${label}, ${tree.rows.toLocaleString("en")} rows open, ${tree.drawn} drawn${tree.wide ? ", scrolls sideways" : ""}`,
        row("down", down),
        row("sideways", sideways),
        "",
      ].join("\n"),
    );
    test.info().attachments.push({
      name: "layers-panel.json",
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ label, tree, down, sideways }, null, 2)),
    });
  });

  test("clicks to select", async () => {
    test.setTimeout(600_000);
    // The rows to click: the top-level layer with the most layers inside it,
    // an instance and a leaf, both deep and far down the tree.
    const targets = await page.evaluate((pageId) => {
      const { doc } = (window as unknown as Handle).drawpane;
      const size = (id: string): number => {
        let n = 1;
        for (const c of doc.childIds(id)) n += size(c);
        return n;
      };
      const tops = doc.childIds(pageId);
      let frame = tops[0] as string;
      let most = 0;
      for (const id of tops) {
        const n = size(id);
        if (n > most) [frame, most] = [id, n];
      }
      // Walk down the middle of the page for an instance and a leaf, a few levels deep.
      let instance: string | null = null;
      let leaf: string | null = null;
      let at = tops[Math.floor(tops.length / 2)] as string;
      for (let depth = 0; depth < 12; depth++) {
        const kids = doc.childIds(at);
        if (kids.length === 0) break;
        at = kids[Math.floor(kids.length / 2)] as string;
        const node = doc.get(at);
        if (depth >= 1 && !instance && node && (node.props as { instanceOf?: unknown }).instanceOf)
          instance = at;
        if (doc.childIds(at).length === 0) leaf = at;
      }
      return [
        { name: "largest frame", id: frame, layers: most },
        ...(instance ? [{ name: "instance", id: instance, layers: size(instance) }] : []),
        ...(leaf ? [{ name: "deep leaf", id: leaf, layers: 1 }] : []),
      ];
    }, pageId);

    // Brings a row into view (selecting it once from outside expands and reveals it), then clears the selection.
    const reveal = async (id: string) => {
      await page.evaluate((id) => {
        const e = (window as unknown as { drawpane: { select(ids: string[]): void } }).drawpane;
        e.select([id]);
      }, id);
      await page.waitForTimeout(800);
    };

    type Times = {
      row: number;
      rowFrame: number;
      canvas: number;
      inspector: number;
      longest: number;
    };
    // Listens first and resolves once all of it has happened and the inspector has
    // been still for a while (or after 20 s, with what happened by then).
    const listen = (id: string) =>
      page.evaluate((id) => {
        (window as unknown as { __probe: Promise<Times> }).__probe = new Promise<Times>(
          (resolve) => {
            const t = { down: 0, row: 0, rowFrame: 0, canvas: 0, inspector: 0, longest: 0 };
            const w = window as unknown as Handle & {
              drawpaneFrames: { record: (...a: number[]) => void };
            };
            document.addEventListener(
              "pointerdown",
              (e) => {
                t.down = e.timeStamp;
              },
              { capture: true, once: true },
            );
            const scroller = document.querySelector(".layers__scroll") as HTMLElement;
            const rowSeen = () => {
              if (t.row) return;
              const el = scroller.querySelector(`[data-layer-id="${CSS.escape(id)}"]`);
              if (el?.getAttribute("aria-selected") === "true") {
                t.row = performance.now();
                requestAnimationFrame(() => {
                  t.rowFrame = performance.now();
                });
              }
            };
            const rows = new MutationObserver(rowSeen);
            rows.observe(scroller, {
              subtree: true,
              childList: true,
              attributes: true,
              attributeFilter: ["aria-selected"],
            });
            const right = document.querySelector('aside[aria-label="Inspector"]') ?? document.body;
            let lastChange = 0;
            // The export preview redraws a beat after the selection settles, on purpose: not the inspector's time.
            const preview = (n: Node) =>
              !!(n instanceof Element ? n : n.parentElement)?.closest(".export-section__preview");
            const inspector = new MutationObserver((records) => {
              const own = (r: MutationRecord) =>
                preview(r.target) ||
                (r.type === "childList" &&
                  [...r.addedNodes, ...r.removedNodes].length > 0 &&
                  [...r.addedNodes, ...r.removedNodes].every(preview));
              if (records.every(own)) return;
              lastChange = performance.now();
              requestAnimationFrame(() => {
                t.inspector = performance.now();
              });
            });
            inspector.observe(right, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
            const frames = w.drawpaneFrames;
            const record = frames.record;
            frames.record = function (this: unknown, ...a: number[]) {
              if (!t.canvas && t.down && w.drawpane.s.selection.includes(id))
                t.canvas = performance.now();
              return record.apply(this, a);
            };
            const tasks = new PerformanceObserver((list) => {
              for (const e of list.getEntries())
                if (t.down && e.startTime + e.duration >= t.down)
                  t.longest = Math.max(t.longest, e.duration);
            });
            tasks.observe({ type: "longtask" });
            const started = performance.now();
            const check = () => {
              const now = performance.now();
              const settled =
                t.down && t.rowFrame && t.canvas && now - lastChange > 600 && now - t.down > 800;
              if (settled || now - started > 20_000) {
                rows.disconnect();
                inspector.disconnect();
                tasks.disconnect();
                frames.record = record;
                const at = (v: number) => Math.round((v - t.down) * 10) / 10;
                resolve({
                  row: at(t.row),
                  rowFrame: at(t.rowFrame),
                  canvas: at(t.canvas),
                  inspector: at(Math.max(t.inspector, t.rowFrame)),
                  longest: Math.round(t.longest),
                });
              } else setTimeout(check, 50);
            };
            setTimeout(check, 50);
          },
        );
      }, id);

    const profiling = process.env.BENCH_PROFILE === "1";
    const cdp = await page.context().newCDPSession(page);
    if (profiling) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    }
    const results = new Map<
      string,
      { row: number[]; canvas: number[]; inspector: number[]; longest: number[] }
    >();
    for (let round = 0; round < ROUNDS; round++) {
      for (const target of targets) {
        await reveal(target.id);
        await page.evaluate(() =>
          (window as unknown as { drawpane: { select(ids: string[]): void } }).drawpane.select([]),
        );
        await page.waitForTimeout(600);
        const box = await page
          .locator(`.layers__scroll [data-layer-id="${target.id}"] .dp-layer__name`)
          .first()
          .boundingBox();
        if (!box) throw new Error(`${target.name}'s row isn't drawn`);
        if (profiling && round === ROUNDS - 1) await cdp.send("Profiler.start");
        await listen(target.id);
        await page.mouse.click(box.x + Math.min(20, box.width / 2), box.y + box.height / 2);
        const r = await page.evaluate(
          () => (window as unknown as { __probe: Promise<Times> }).__probe,
        );
        if (profiling && round === ROUNDS - 1) {
          const { profile } = await cdp.send("Profiler.stop");
          const file = test
            .info()
            .outputPath(`click-${target.name.replace(/\W+/g, "-")}.cpuprofile`);
          writeFileSync(file, JSON.stringify(profile));
          console.log(`${target.name}: profile in ${file}\n${topFunctions(profile)}`);
        }
        const into = results.get(target.name) ?? {
          row: [],
          canvas: [],
          inspector: [],
          longest: [],
        };
        into.row.push(r.rowFrame);
        into.canvas.push(r.canvas);
        into.inspector.push(r.inspector);
        into.longest.push(r.longest);
        results.set(target.name, into);
        await page.mouse.move(700, 450);
      }
    }
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
    const max = (v: number[]) => Math.max(...v);
    const fmt = (v: number[]) => `${median(v).toFixed(0)} (${max(v).toFixed(0)})`.padStart(12);
    console.log(
      [
        `\nClick to select: ${label}, ms from pointerdown, median (worst) of ${ROUNDS}`,
        `${"".padEnd(24)}${"row shown".padStart(12)}${"canvas".padStart(12)}${"inspector".padStart(12)}${"long task".padStart(12)}`,
        ...targets.map((t) => {
          const r = results.get(t.name);
          if (!r) return "";
          return `${`${t.name} (${t.layers.toLocaleString("en")})`.padEnd(24)}${fmt(r.row)}${fmt(r.canvas)}${fmt(r.inspector)}${fmt(r.longest)}`;
        }),
        "",
      ].join("\n"),
    );
    test.info().attachments.push({
      name: "layers-click.json",
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({ label, targets, results: Object.fromEntries(results) }, null, 2),
      ),
    });
  });
});

interface CpuProfile {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: number[];
  }[];
  samples?: number[];
  timeDeltas?: number[];
}

/** The functions a CPU profile spent the most time in, self and total. */
function topFunctions(profile: CpuProfile, count = 25): string {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const self = new Map<number, number>();
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i] as number;
    self.set(id, (self.get(id) ?? 0) + (deltas[i] ?? 0) / 1000);
  }
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const keyOf = (id: number) => {
    const f = byId.get(id)?.callFrame;
    return f
      ? `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`
      : "?";
  };
  const selfBy = new Map<string, number>();
  const totalBy = new Map<string, number>();
  for (const [id, ms] of self) {
    selfBy.set(keyOf(id), (selfBy.get(keyOf(id)) ?? 0) + ms);
    // Each function on the stack once, however often it recurses.
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const k = keyOf(at);
      if (seen.has(k)) continue;
      seen.add(k);
      totalBy.set(k, (totalBy.get(k) ?? 0) + ms);
    }
  }
  const top = (m: Map<string, number>) =>
    [...m]
      .filter(
        ([k]) => !k.startsWith("(idle)") && !k.startsWith("(program)") && !k.startsWith("(root)"),
      )
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([k, ms]) => `  ${ms.toFixed(1).padStart(8)} ms  ${k}`)
      .join("\n");
  return `self:\n${top(selfBy)}\ntotal:\n${top(totalBy)}`;
}
