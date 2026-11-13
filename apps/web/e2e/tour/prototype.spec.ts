/**
 * Screenshots of prototyping for design review: the Prototype tab, canvas
 * connections, the timing editor and present mode, in both themes.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { buildMobileApp } from "../prototype-fixture";

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
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

test("prototype tour", async ({ browser }) => {
  test.setTimeout(180_000);
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
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });

  const ids = await buildMobileApp(page);
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(300);

  // The Prototype tab with the first event row selected: its connection, the handle and its interaction.
  await page.getByRole("radio", { name: "Prototype" }).click();
  await page.evaluate(
    (id) =>
      (window as unknown as { drawpane: { select(ids: string[]): void } }).drawpane.select([id]),
    ids.row,
  );
  await shot(page, "40-prototype-tab");

  // A spring on the transition.
  await page.getByRole("radio", { name: "Spring" }).click();
  await shot(page, "41-prototype-spring");
  await page.getByRole("radio", { name: "Bezier" }).click();
  await shot(page, "42-prototype-bezier");

  // An overlay interaction.
  await page.evaluate(
    (id) =>
      (window as unknown as { drawpane: { select(ids: string[]): void } }).drawpane.select([id]),
    ids.done,
  );
  await shot(page, "43-prototype-overlay");

  // Nothing selected: flows and device.
  await page.evaluate(() =>
    (window as unknown as { drawpane: { select(ids: string[]): void } }).drawpane.select([]),
  );
  await shot(page, "44-prototype-flows");

  // Present mode.
  await page.getByRole("button", { name: "Play prototype" }).click();
  await expect(page.getByRole("main", { name: "Prototype" })).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, "45-present-home");
  // Tap empty space: hotspots flash.
  const viewport = page.locator(".stage__viewport");
  const box = await viewport.boundingBox();
  if (!box) throw new Error("no viewport");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.62);
  await page.waitForTimeout(350);
  await shot(page, "46-present-hotspots");
  // Tap the first event row: navigates to the detail screen.
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await page.waitForTimeout(900);
  await shot(page, "47-present-detail");
  // Mark done: an overlay sheet from the bottom.
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.9);
  await page.waitForTimeout(900);
  await shot(page, "48-present-overlay");
  await context.close();
});
