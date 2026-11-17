/**
 * How the layers panel scrolls a kit-sized tree: a generated kit
 * (`@drawpane/corpus`, BENCH_SCALE layers, default 100,000) is loaded as
 * opening it would, its largest page shown with every frame open, in the
 * narrowest left pane. Then the tree scrolls down a row a frame, and sideways
 * a few pixels a frame, and for each this counts React commits (through a
 * stand-in for the devtools hook, which production React also calls) and the
 * script time per frame.
 *
 * The canvas finishes drawing the page first, so its script time is the panel's.
 * Scrolling down draws the rows coming into view, so it commits each frame.
 * Scrolling sideways moves the drawn rows as they are (the toggles stick by
 * CSS), so it should commit nothing. Compare runs on one machine.
 * Run with `pnpm --filter @drawpane/web bench -- layers-panel`.
 */
import { generateKit } from "@drawpane/corpus";
import type { NodeRecord } from "@drawpane/model";
import { expect, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";

const LAYERS = Number((process.env.BENCH_SCALE ?? "100000").split(",")[0]);
const CHUNK = 20_000;
const FRAMES = 120;

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

test.describe("Layers panel", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const port = Number(process.env.BENCH_PORT ?? 8824);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test(`scrolls a ${LAYERS.toLocaleString("en")}-layer tree`, async () => {
    test.setTimeout(900_000);
    const kit = generateKit({ layers: LAYERS });
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
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");

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
    await page.evaluate(async (chunks) => {
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
      e.doc.resetStored(all, "materialized");
    }, chunks.length);
    chunks.length = 0;
    await page.evaluate(
      (id) =>
        (window as unknown as { drawpane: { setPage(id: string): void } }).drawpane.setPage(id),
      largestPage(kit.nodes),
    );
    // The canvas draws a large page a few tiles a frame: let it finish, so only the panel is measured.
    await page.waitForFunction(
      () => (window as unknown as { drawpaneFrames?: { exact: boolean } }).drawpaneFrames?.exact,
      null,
      { timeout: 300_000 },
    );
    await page.waitForTimeout(1500);
    await page.mouse.move(700, 450);

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
          el.scrollTop = 0;
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
        `\nLayers panel: ${kit.stats.layers.toLocaleString("en")} layers, ${tree.rows.toLocaleString("en")} rows open, ${tree.drawn} drawn${tree.wide ? ", scrolls sideways" : ""}`,
        row("down", down),
        row("sideways", sideways),
        "",
      ].join("\n"),
    );
    test.info().attachments.push({
      name: "layers-panel.json",
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ layers: LAYERS, tree, down, sideways }, null, 2)),
    });
  });
});
