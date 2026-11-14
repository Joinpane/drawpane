/**
 * Changing keyboard shortcuts in Settings, in a real browser: record a new
 * one, take one another command has (asked first), keep it across a reload
 * (it's on the account), use it in the editor, and reset everything.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

const row = (page: Page, name: string) =>
  page.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
const keysOf = (page: Page, name: string) =>
  row(page, name).getByRole("button", { name: new RegExp(`shortcut for ${name}`) });

test.describe
  .serial("Keyboard shortcuts in Settings", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8839, inspectorPort: 9379 });
      page = instance.page;
    });
    test.afterAll(() => instance?.stop());

    test("records a new shortcut, and asks before taking one another command has", async () => {
      await page.getByRole("link", { name: /Ana Lima/ }).click();
      await page
        .getByRole("navigation", { name: "Settings" })
        .getByRole("link", {
          name: "Keyboard shortcuts",
        })
        .click();
      await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
      await page.getByRole("searchbox", { name: "Search commands" }).fill("rectangle");

      await keysOf(page, "Rectangle").click();
      await expect(row(page, "Rectangle")).toContainText("Press keys…");
      await page.keyboard.press("q");
      await expect(keysOf(page, "Rectangle")).toHaveAccessibleName(/now Q$/);

      // V is Move's: it asks, and Replace moves it.
      await keysOf(page, "Rectangle").click();
      await page.keyboard.press("v");
      const question = row(page, "Rectangle").getByRole("alert");
      await expect(question).toHaveText(/V is used by “Move”. Replace it\?/);
      await question.getByRole("button", { name: "Replace" }).click();
      await expect(keysOf(page, "Rectangle")).toHaveAccessibleName(/now V$/);
      await page.getByRole("searchbox", { name: "Search commands" }).fill("");
      await expect(keysOf(page, "Move")).toHaveAccessibleName(/now none$/);
      await expect(row(page, "Move").getByRole("button", { name: "Reset" })).toBeVisible();

      // Escape leaves a recording alone.
      await keysOf(page, "Ellipse").click();
      await page.keyboard.press("Escape");
      await expect(keysOf(page, "Ellipse")).toHaveAccessibleName(/now O$/);
    });

    test("keeps them on the account, and the editor uses them", async () => {
      await page.reload();
      await expect(keysOf(page, "Rectangle")).toHaveAccessibleName(/now V$/);
      await page.getByRole("link", { name: "Files" }).click();
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      const tool = () =>
        page.evaluate(
          () => (window as unknown as { drawpane: { s: { tool: string } } }).drawpane.s.tool,
        );
      await page.locator(".canvas__overlay").click({ position: { x: 600, y: 400 } });
      await page.keyboard.press("v");
      await expect.poll(tool).toBe("rect");
      // Its tooltip says so too.
      await page
        .getByRole("toolbar", { name: "Tools" })
        .getByRole("button", { name: "Rectangle" })
        .hover();
      // (An icon button's tooltip is visual: its label is the button's name.)
      await expect(page.locator(".dp-tooltip").filter({ hasText: "Rectangle" })).toContainText("V");
    });

    test("resets everything to the defaults", async () => {
      await page.goto("/settings/shortcuts");
      await page.getByRole("button", { name: "Reset all" }).click();
      await expect(keysOf(page, "Rectangle")).toHaveAccessibleName(/now R$/);
      await expect(keysOf(page, "Move")).toHaveAccessibleName(/now V$/);
      await expect(page.getByRole("button", { name: "Reset all" })).toBeDisabled();
    });
  });
