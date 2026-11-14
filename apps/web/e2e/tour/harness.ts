/**
 * What every design-review tour shares. Each tour gets an instance of its own
 * (its own Worker and database, not yet set up), so tours set it up as a new
 * self-hoster would and `pnpm --filter @drawpane/web tour` runs them all in
 * one go. Set E2E_BASE_URL to tour an instance you started yourself instead.
 *
 * Screenshots land in TOUR_OUT (default `tour-shots`), in both themes.
 */
import { test as base, type Locator, type Page } from "@playwright/test";
import { startWorker } from "../fresh-instance";

export { addPasskey as passkey } from "../fresh-instance";

export const OUT = process.env.TOUR_OUT ?? "tour-shots";

/** Ports for tours' Workers, clear of the e2e specs' (8785–8831). */
const PORT = 8851;
const INSPECTOR_PORT = 9391;

export const test = base.extend({
  baseURL: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
    async ({}, use, testInfo) => {
      const external = process.env.E2E_BASE_URL;
      if (external) return use(external);
      const worker = await startWorker({
        port: PORT + testInfo.workerIndex,
        inspectorPort: INSPECTOR_PORT + testInfo.workerIndex,
      });
      try {
        await use(worker.url);
      } finally {
        await worker.stop();
      }
    },
    // Starting a Worker isn't the tour's time.
    { scope: "test", timeout: 150_000 },
  ],
});

/** Screenshots the page (or just `target` in it) in the light theme, then the dark one. */
export async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => {
      if (t === "dark") document.documentElement.dataset.theme = "dark";
      else delete document.documentElement.dataset.theme;
    }, theme);
    // Let theme transitions settle.
    await page.waitForTimeout(300);
    const path = `${OUT}/${name}-${theme}.png`;
    await (target ? target.screenshot({ path }) : page.screenshot({ path }));
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}
