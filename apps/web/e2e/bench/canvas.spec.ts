/**
 * Canvas performance against the PRD's budget: p95 frame time under 16 ms
 * while panning a 10,000-layer file. Builds a realistic file (400 cards of
 * 25 layers: boards, text, shapes, icons) on a throwaway instance, pans it
 * for 240 frames at three zoom levels, and reports what drawing took.
 *
 * Prints the numbers always; fails over budget only with BENCH_ENFORCE=1,
 * since headless browsers without a GPU are far slower than a laptop.
 * Run with `pnpm --filter @drawpane/web bench`.
 */
import { expect, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { buildFile } from "./cards";
import { pan, type Summary, summaryRow, zoom } from "./frames";

const BUDGET_MS = Number(process.env.BENCH_BUDGET_MS ?? 16);
const ENFORCE = process.env.BENCH_ENFORCE === "1";

test.describe("Canvas performance", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    instance = await freshInstance(browser, { port: 8821, inspectorPort: 9361 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("pans a 10,000-layer file within budget", async () => {
    const page = instance.page;
    await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 15_000,
    });
    const layers = await buildFile(page, 400);
    expect(layers).toBe(10_000);
    // Let fonts and the first full paint settle.
    await page.waitForTimeout(1500);

    const results: Record<string, Summary> = {};
    for (const level of ["fit", 0.25, 1] as const)
      results[level === "fit" ? "pan, whole" : `pan, ${level * 100}%`] = await pan(
        page,
        level,
        240,
      );
    results["zoom, whole"] = await zoom(page, 240);

    const rows = Object.entries(results).map(([name, r]) => summaryRow(name, r));
    console.log(`\nCanvas, 10,000 layers, ${BUDGET_MS} ms budget\n${rows.join("\n")}\n`);
    test.info().annotations.push({ type: "bench", description: JSON.stringify(results) });
    if (ENFORCE)
      for (const [name, r] of Object.entries(results))
        expect(r.content.p95 + r.overlay.p95, `${name} p95 frame time`).toBeLessThan(BUDGET_MS);
  });
});
