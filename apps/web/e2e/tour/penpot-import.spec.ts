import { resolve } from "node:path";
/**
 * Screenshots of importing from Penpot for design review, in both themes:
 * the dialog, an import finished with notes, and the imported file in the
 * editor. Run with `pnpm --filter @drawpane/web tour`.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const OUT = process.env.TOUR_OUT ?? "tour-shots";

async function passkey(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function shot(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => {
      if (t === "dark") document.documentElement.dataset.theme = "dark";
      else delete document.documentElement.dataset.theme;
    }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

const fixture = (name: string) =>
  resolve(import.meta.dirname, "../../../../packages/penpot/test/fixtures", name);

test("penpot import tour", async ({ browser }) => {
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
  await shot(page, "129-dashboard-empty-import");

  await page.getByRole("button", { name: "Import", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import from Penpot" });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(200);
  await shot(page, "130-import-choose");

  await dialog.locator('input[type="file"]').setInputFiles(fixture("file-with-library.penpot"));
  await expect(dialog.getByRole("button", { name: "Done" })).toBeEnabled({ timeout: 30_000 });
  await dialog.locator("summary").first().click();
  await page.waitForTimeout(200);
  await shot(page, "131-import-done");
  await dialog.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await dialog.locator('input[type="file"]').setInputFiles(fixture("showcase.penpot"));
  const row = dialog.getByRole("listitem").filter({ hasText: "Showcase" });
  await row.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("tree", { name: "Layers" })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(800);
  await shot(page, "132-imported-showcase");
  await context.close();
});
