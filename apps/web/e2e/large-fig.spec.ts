/**
 * Large .fig files in a real browser.
 *
 * - E2E_LARGE_FIG: a .fig under what one Drawpane file holds (1,000,000
 *   layers, instances filled in) but far past what one request carries,
 *   such as the shadcn/ui Pro kit (about 503,000 layers). It comes in whole,
 *   sent in parts (decision 0026). The browser's memory is sampled while it
 *   reads, converts and sends, and printed.
 * - E2E_HUGE_FIG: a .fig over 1,000,000 layers. Its pages are listed with
 *   their sizes (some chosen to start with, within what a file holds), a few
 *   chosen pages come in as a file named for them, and other pages can then
 *   be imported without reading the file again.
 *
 * Both are too large to commit.
 */
import { execFileSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

const LARGE_FIG = process.env.E2E_LARGE_FIG;
const HUGE_FIG = process.env.E2E_HUGE_FIG;
const dialog = (page: Page) => page.getByRole("dialog", { name: "Import" });

test.describe
  .serial("a .fig too large for one file", () => {
    test.skip(!HUGE_FIG, "Set E2E_HUGE_FIG to a .fig of more than 1,000,000 layers.");
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 9035, inspectorPort: 9575 });
      page = instance.page;
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("lists its pages to choose, within what one file holds", async () => {
      test.setTimeout(180_000);
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await dialog(page)
        .locator('input[type="file"][accept=".fig"]')
        .setInputFiles(HUGE_FIG as string);
      await expect(dialog(page).getByText("One Drawpane file holds about")).toBeVisible({
        timeout: 120_000,
      });
      const pages = dialog(page).getByRole("checkbox");
      expect(await pages.count()).toBeGreaterThan(1);
      // Some are chosen to start with, all of them fitting.
      await expect(dialog(page).getByText(/^About [\d.]+K of [\d.]+K layers$/)).toBeVisible();
      const start = await dialog(page).getByRole("button", { name: /^Import \d+ pages?$/ });
      await expect(start).toBeEnabled();
    });

    test("imports the pages chosen into a file named for them", async () => {
      test.setTimeout(600_000);
      await dialog(page).getByRole("button", { name: "Clear" }).click();
      await expect(dialog(page).getByRole("button", { name: "Import 0 pages" })).toBeDisabled();
      // Three small pages.
      const small = dialog(page)
        .locator("label")
        .filter({ hasNot: page.getByText("Empty") });
      for (let i = 0; i < 3; i++) await small.nth(i).getByRole("checkbox").check();
      await dialog(page).getByRole("button", { name: "Import 3 pages" }).click();
      await expect(dialog(page).getByRole("button", { name: "Open" })).toBeVisible({
        timeout: 540_000,
      });
      await expect(dialog(page).locator(".import-row__name")).toContainText("(3 of ");
      await expect(dialog(page).locator(".import-row__status")).toContainText("3 pages");
    });

    test("then imports other pages without reading the file again", async () => {
      await dialog(page).getByRole("button", { name: "Import other pages" }).click();
      await expect(dialog(page).getByText("Imported")).toHaveCount(3);
      // What's chosen to start with leaves out what came in.
      for (const done of await dialog(page).locator("label", { hasText: "Imported" }).all())
        await expect(done.getByRole("checkbox")).not.toBeChecked();
    });
  });

/** The browser's memory now: every Chrome process's resident set, in MB (Linux). */
function browserRss(): number {
  try {
    const out = execFileSync("ps", ["-eo", "rss=,comm="], { encoding: "utf8" });
    let kb = 0;
    for (const line of out.split("\n")) {
      const [rss, ...name] = line.trim().split(/\s+/);
      if (/chrom/i.test(name.join(" "))) kb += Number(rss) || 0;
    }
    return Math.round(kb / 1024);
  } catch {
    return 0;
  }
}

test.describe
  .serial("a large .fig imported whole", () => {
    test.skip(!LARGE_FIG, "Set E2E_LARGE_FIG to a .fig of a few hundred thousand layers.");
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 9036, inspectorPort: 9576 });
      page = instance.page;
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("comes in as one file, sent in parts", async () => {
      test.setTimeout(3_600_000);
      const parts: number[] = [];
      page.on("request", (request) => {
        if (/\/imports\/[^/]+\/parts$/.test(request.url()))
          parts.push(request.postDataBuffer()?.byteLength ?? 0);
      });
      let peak = browserRss();
      const sampler = setInterval(() => {
        peak = Math.max(peak, browserRss());
      }, 2_000);
      const started = Date.now();
      try {
        await page.getByRole("button", { name: "Import", exact: true }).click();
        await dialog(page)
          .locator('input[type="file"][accept=".fig"]')
          .setInputFiles(LARGE_FIG as string);
        // No pages to choose: it fits in one file.
        const row = dialog(page).getByRole("listitem").first();
        await expect(row.getByRole("button", { name: "Open" })).toBeVisible({
          timeout: 3_500_000,
        });
        const status = (await row.locator(".import-row__status").textContent()) ?? "";
        const layers = Number(status.match(/([\d,]+) layers/)?.[1]?.replaceAll(",", ""));
        console.log(
          `Imported ${status.trim()} in ${Math.round((Date.now() - started) / 1000)} s: ` +
            `${parts.length} parts, ${Math.round(parts.reduce((a, b) => a + b, 0) / 1024 / 1024)} MB sent, ` +
            `browser memory peaked at ${peak} MB (all Chrome processes).`,
        );
        expect(layers).toBeGreaterThan(100_000);
        expect(parts.length).toBeGreaterThan(1);
      } finally {
        clearInterval(sampler);
      }
    });
  });
