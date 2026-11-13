/**
 * Screenshots of context menus and the shortcuts sheet for design review, in
 * both themes. Run with `pnpm --filter @drawpane/web tour`.
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
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

type Debug = {
  scene: { bounds(id: string): { x: number; y: number; width: number; height: number } | null };
  s: { camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } } };
};

async function centreOf(page: Page, id: string) {
  return page.evaluate((id) => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    const b = e.scene.bounds(id);
    if (!b) throw new Error("no bounds");
    const p = e.s.camera.toScreen({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    const rect = (
      document.querySelector(".canvas__overlay") as HTMLElement
    ).getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y };
  }, id);
}

test("menus tour", async ({ browser }) => {
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

  // A layer's menu.
  const done = await centreOf(page, ids.done);
  await page.mouse.click(done.x, done.y, { button: "right" });
  await expect(page.getByRole("menu").first()).toBeVisible();
  await shot(page, "70-menu-layer");

  // A submenu.
  await page.getByRole("menuitem", { name: /^Arrange/ }).hover();
  await expect(page.getByRole("menu", { name: "Arrange" })).toBeVisible();
  await shot(page, "71-menu-submenu");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Select layer, from a point with layers stacked under it.
  await page.mouse.click(done.x, done.y, { button: "right" });
  await page.getByRole("menuitem", { name: /^Select layer/ }).hover();
  await expect(page.getByRole("menu", { name: "Select layer" })).toBeVisible();
  await shot(page, "72-menu-select-layer");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // The canvas menu.
  await page.mouse.click(1000, 820, { button: "right" });
  await expect(page.getByRole("menuitem", { name: "Select all" })).toBeVisible();
  await shot(page, "73-menu-canvas");
  await page.keyboard.press("Escape");

  // A page's menu.
  await page.getByRole("button", { name: /^Page 1/ }).click({ button: "right" });
  await shot(page, "74-menu-page");
  await page.keyboard.press("Escape");

  // The shortcuts sheet.
  await page.locator(".canvas__overlay").click({ position: { x: 900, y: 800 } });
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await shot(page, "75-shortcuts");
});
