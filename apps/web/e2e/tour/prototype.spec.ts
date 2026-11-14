/**
 * Screenshots of prototyping for design review: the Prototype tab, canvas
 * connections, the timing editor and present mode, in both themes.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { buildMobileApp } from "../prototype-fixture";
import { passkey, shot, test } from "./harness";

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

  // Sharing: the dialog, then the link opened signed out.
  await page.getByRole("button", { name: "Share prototype" }).click();
  await shot(page, "49-share-off");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("switch", { name: "Anyone with the link can play the prototype" }).click();
  await expect(dialog.locator(".app-copy code")).toBeVisible();
  await shot(page, "50-share-on");
  const url = (await dialog.locator(".app-copy code").textContent()) as string;
  const guest = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guestPage = await guest.newPage();
  await guestPage.goto(url);
  await expect(guestPage.locator(".present__count")).toHaveText("Screen 1 of 3");
  await guestPage.waitForTimeout(600);
  await shot(guestPage, "51-shared-player");
  await guestPage.setViewportSize({ width: 390, height: 844 });
  await guestPage.waitForTimeout(400);
  await shot(guestPage, "52-shared-player-phone");
  await guest.close();
  await context.close();
});
