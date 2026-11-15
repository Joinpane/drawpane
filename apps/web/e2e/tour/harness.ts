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

/**
 * Ports for tours' Workers, clear of the e2e specs'. TOUR_PORT and TOUR_INSPECTOR_PORT move them,
 * so two checkouts can run tours at once.
 */
const PORT = Number(process.env.TOUR_PORT) || 8851;
const INSPECTOR_PORT = Number(process.env.TOUR_INSPECTOR_PORT) || 9391;

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
  // Zooming to a layer or the selection glides: shoot where it lands, not on the way.
  await page.waitForFunction(
    () =>
      !(window as unknown as { drawpane?: { cameraAnimating?: boolean } }).drawpane
        ?.cameraAnimating,
  );
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => {
      if (t === "dark") document.documentElement.dataset.theme = "dark";
      else delete document.documentElement.dataset.theme;
    }, theme);
    await settle(page);
    const path = `${OUT}/${name}-${theme}.png`;
    await (target ? target.screenshot({ path }) : page.screenshot({ path }));
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/**
 * Waits for the screen to come to rest: past the Selection Lens's settle delay (it appears 350 ms
 * after a selection stops changing), then until every finite animation and transition (theme
 * changes, the Lens fading in, popovers opening) has finished. Endless ones (spinners) don't count.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(450);
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
      null,
      { timeout: 3000 },
    )
    .catch(() => {
      // Something keeps animating: shoot it as it is rather than fail the tour.
    });
}
