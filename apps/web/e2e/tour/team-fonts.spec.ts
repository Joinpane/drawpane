/**
 * Screenshots of team fonts for design review, in both themes: the empty
 * Fonts page, the list after uploading (a family open to its faces), and the
 * font picker's Team tab.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

const fixture = (path: string) => fileURLToPath(new URL(path, import.meta.url));

test("team fonts tour", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await passkey(context, page);
  await page.goto("/setup");
  await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
  await page.getByLabel("Your name").fill("Ana Lima");
  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByLabel("Setup token").fill(process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token");
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();

  const nav = (name: string) =>
    page.getByRole("complementary", { name: "Navigation" }).getByRole("link", { name });
  await nav("Fonts").click();
  await expect(page.getByText("No team fonts yet")).toBeVisible();
  await shot(page, "114-team-fonts-empty");

  await page
    .getByLabel("Font files")
    .setInputFiles([
      fixture("../fixtures/InstrumentSans-Regular.ttf"),
      fixture("../../../worker/test/fixtures/InstrumentSans-Variable.woff2"),
      fixture("../../../worker/test/fixtures/InstrumentSerif-Regular.woff2"),
      fixture("../../../worker/test/fixtures/InstrumentSerif-Italic.woff"),
    ]);
  await expect(page.locator(".team-fonts__upload--added")).toHaveCount(4, { timeout: 20_000 });
  await page
    .locator(".team-fonts__list")
    .getByRole("button", { name: /^Instrument Serif/ })
    .click();
  await page.waitForTimeout(800);
  await shot(page, "115-team-fonts-list");

  await nav("Recent").click();
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });
  await page.evaluate(() => {
    const e = (
      window as unknown as {
        drawpane: {
          s: { pageId: string };
          createLayer(t: string, r: object, p: string, props?: object): string;
          select(ids: string[]): void;
          zoomTo(z: number): void;
        };
      }
    ).drawpane;
    const t = e.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, e.s.pageId, {
      characters: "Brand type, everywhere",
      fontSize: 40,
      fontFamily: "Instrument Serif",
      fontStyle: "italic",
    });
    e.zoomTo(1);
    e.select([t]);
  });
  await page.keyboard.press("Shift+1");
  const panel = page.getByRole("group", { name: "Properties" });
  await panel.getByRole("button", { name: /^Font:/ }).click();
  await page.getByRole("dialog", { name: "Fonts" }).getByRole("radio", { name: "Team" }).click();
  await page.waitForTimeout(800);
  await shot(page, "116-picker-team");
  await context.close();
});
