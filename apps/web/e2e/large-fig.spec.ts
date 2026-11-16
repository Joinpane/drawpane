/**
 * A .fig too large for one Drawpane file, in a real browser: its pages are
 * listed with their sizes (some chosen to start with, within what a file
 * holds), a few chosen pages come in as a file named for them, and other
 * pages can then be imported without reading the file again.
 *
 * Needs a file larger than one Drawpane file takes (about 105,000 layers,
 * instances filled in), which is too large to commit: set E2E_LARGE_FIG to
 * the path of one.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

const LARGE_FIG = process.env.E2E_LARGE_FIG;
const dialog = (page: Page) => page.getByRole("dialog", { name: "Import" });

test.describe
  .serial("a .fig too large for one file", () => {
    test.skip(!LARGE_FIG, "Set E2E_LARGE_FIG to a .fig of more than 105,000 layers.");
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
        .setInputFiles(LARGE_FIG as string);
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
