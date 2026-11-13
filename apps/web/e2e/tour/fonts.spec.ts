/**
 * Screenshots of the font picker for design review, in both themes: the
 * list with each family in its own face, previewing on the canvas, and the
 * fonts a file uses with a missing one.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const OUT = process.env.TOUR_OUT ?? "tour-shots";

type W = {
  drawpane: {
    s: { pageId: string };
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
    zoomTo(z: number): void;
  };
};

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

test("font picker tour", async ({ browser }) => {
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
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });

  await page.evaluate(() => {
    const e = (window as unknown as W).drawpane;
    const p = e.s.pageId;
    const t = e.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, p, {
      characters: "Plan your week in one glance",
      fontSize: 44,
      fontWeight: 600,
    }) as string;
    e.createLayer("text", { x: 0, y: 80, width: 10, height: 10 }, p, {
      characters: "Three things on today, nothing more.",
      fontSize: 20,
      fontFamily: "Frutiger",
    });
    e.zoomTo(1);
    e.select([t]);
  });
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(300);
  const panel = page.getByRole("group", { name: "Properties" });
  const dialog = page.getByRole("dialog", { name: "Fonts" });

  await panel.getByRole("button", { name: /^Font:/ }).click();
  await dialog.getByRole("radio", { name: "Google" }).click();
  // Let the visible rows' previews arrive.
  await page.waitForTimeout(2500);
  await shot(page, "105-font-picker");

  await page.keyboard.type("fra");
  await page.waitForTimeout(800);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(2500);
  await shot(page, "106-font-preview");
  await page.keyboard.press("Enter");

  await panel.getByRole("button", { name: /^Font:/ }).click();
  await dialog.getByRole("radio", { name: "In this file" }).click();
  await page.waitForTimeout(800);
  await shot(page, "107-font-in-file");
  await context.close();
});
