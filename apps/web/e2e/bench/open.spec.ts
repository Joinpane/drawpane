/**
 * Opening a big file against the PRD's budget: under 1.5 s to the first
 * interactive canvas for a 5 MB file on a warm cache (under 3 s cold). The
 * file is filled through the import endpoint, then opened twice: once cold
 * (fresh context) and once warm (same context, app assets cached).
 *
 * Prints the numbers always; fails over budget only with BENCH_ENFORCE=1.
 * Run with `pnpm --filter @drawpane/web bench`.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";

const ENFORCE = process.env.BENCH_ENFORCE === "1";
const WARM_BUDGET_MS = 1500;
const COLD_BUDGET_MS = 3000;

/** About `bytes` of nodes: cards of text and shapes, as a real file has. */
function nodesOfSize(pageId: string, bytes: number) {
  const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const key = (i: number) =>
    i < 62 ? `a${DIGITS[i]}` : `b${DIGITS[Math.floor(i / 62)]}${DIGITS[i % 62]}`;
  const nodes: Array<Record<string, unknown>> = [
    { id: pageId, type: "page", parent: "root", key: "a0", props: { name: "Big" } },
  ];
  let size = 0;
  let n = 0;
  for (let c = 0; size < bytes; c++) {
    const card = `card${c}`;
    nodes.push({
      id: card,
      type: "frame",
      parent: pageId,
      key: key(c),
      props: {
        name: `Card ${c}`,
        x: (c % 40) * 360,
        y: Math.floor(c / 40) * 260,
        width: 320,
        height: 220,
        fills: [{ type: "solid", color: "#ffffff" }],
      },
    });
    for (let i = 0; i < 24; i++) {
      const node = {
        id: `n${n++}`,
        type: i % 3 === 0 ? "text" : "rect",
        parent: card,
        key: key(i),
        props:
          i % 3 === 0
            ? {
                x: 16,
                y: 16 + i * 8,
                width: 288,
                height: 18,
                characters: `Line ${i} of card ${c}: three things on today, nothing more.`,
                textAutoResize: "height",
              }
            : {
                x: 16 + (i % 6) * 48,
                y: 120 + (i % 4) * 20,
                width: 40,
                height: 16,
                cornerRadius: 4,
                fills: [{ type: "solid", color: "#e9e7e2" }],
              },
      };
      nodes.push(node);
      size += JSON.stringify(node).length;
    }
  }
  return nodes;
}

/** Milliseconds from navigating to the file until it's live and its first frame is drawn. */
async function open(page: Page, url: string): Promise<number> {
  const start = Date.now();
  await page.goto(url);
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        drawpane?: { s: { status: string } };
        drawpaneFrames?: { summary(): { frames: number } };
      };
      return w.drawpane?.s.status === "live" && (w.drawpaneFrames?.summary().frames ?? 0) > 0;
    },
    undefined,
    { timeout: 60_000, polling: "raf" },
  );
  return Date.now() - start;
}

test.describe("Opening a file", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    instance = await freshInstance(browser, { port: 8825, inspectorPort: 9365 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("opens a 5 MB file within budget", async ({ browser }) => {
    const page = instance.page;
    // A file filled through the import endpoint with about 5 MB of nodes.
    const fileId = await page.evaluate(async () => {
      const { teams } = await (await fetch("/api/teams")).json();
      const { projects } = await (await fetch(`/api/teams/${teams[0].id}/projects`)).json();
      const response = await fetch(`/api/projects/${projects[0].id}/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Big file" }),
      });
      return (await response.json()).file.id as string;
    });
    const nodes = nodesOfSize("bigpage", 5_000_000);
    const body = JSON.stringify({ nodes });
    const imported = await page.evaluate(
      async ({ fileId, body }) => {
        const response = await fetch(`/api/files/${fileId}/import`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        return { status: response.status, text: (await response.text()).slice(0, 200) };
      },
      { fileId, body },
    );
    expect(imported.status, imported.text).toBe(200);
    const megabytes = Math.round((body.length / 1_000_000) * 10) / 10;

    // Cold: a new browser context, nothing cached.
    const cold = await browser.newContext({ storageState: await instance.context.storageState() });
    const coldPage = await cold.newPage();
    await coldPage.addInitScript(() => localStorage.setItem("drawpane:debug", "1"));
    const url = `${instance.url}/f/${fileId}`;
    const coldMs = await open(coldPage, url);
    // Warm: the same context again, app assets cached.
    const warmMs = await open(coldPage, url);
    await cold.close();

    console.log(
      `\nOpening a ${megabytes} MB file (${nodes.length} nodes): cold ${coldMs} ms (budget ${COLD_BUDGET_MS}), warm ${warmMs} ms (budget ${WARM_BUDGET_MS})\n`,
    );
    if (ENFORCE) {
      expect(coldMs).toBeLessThan(COLD_BUDGET_MS);
      expect(warmMs).toBeLessThan(WARM_BUDGET_MS);
    }
  });
});
