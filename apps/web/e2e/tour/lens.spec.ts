/**
 * Screenshots of the Selection Lens for design review, in both themes: on a
 * styled heading (moving above, clear of the paragraph), plain text, a shape,
 * an auto layout frame, a frame bigger than the screen, and with its fill
 * picker open. Run with `pnpm --filter @drawpane/web tour`.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const OUT = process.env.TOUR_OUT ?? "tour-shots";

type W = {
  drawpane: {
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
    createTextStyle(name: string, fromId?: string): string | null;
    zoomTo(z: number): void;
    s: { pageId: string };
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

test("selection lens tour", async ({ browser }) => {
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

  const ids = await page.evaluate(() => {
    const e = (window as unknown as W).drawpane;
    const card = e.createLayer("frame", { x: 0, y: 0, width: 420, height: 320 }, e.s.pageId, {
      name: "Card",
      fills: [{ type: "solid", color: "#ffffff" }],
    }) as string;
    const heading = e.createLayer("text", { x: 24, y: 96, width: 10, height: 10 }, card, {
      characters: "Plan your week",
      fontSize: 32,
      fontWeight: 700,
    }) as string;
    e.select([heading]);
    e.createTextStyle("heading/xl");
    const body = e.createLayer("text", { x: 24, y: 152, width: 10, height: 10 }, card, {
      characters: "Three things on today, nothing more.",
      fontSize: 15,
    }) as string;
    const shape = e.createLayer("rect", { x: 480, y: 0, width: 160, height: 120 }, e.s.pageId, {
      fills: [{ type: "solid", color: "#e8590c" }],
      cornerRadius: 16,
    }) as string;
    const stack = e.createLayer("frame", { x: 480, y: 180, width: 160, height: 140 }, e.s.pageId, {
      name: "Stack",
      layoutMode: "column",
      gap: 8,
      paddingTop: 12,
      paddingRight: 12,
      paddingBottom: 12,
      paddingLeft: 12,
      fills: [{ type: "solid", color: "#f1efe9" }],
    }) as string;
    for (let i = 0; i < 3; i++)
      e.createLayer("rect", { x: 0, y: 0, width: 136, height: 28 }, stack, {
        fills: [{ type: "solid", color: "#d9d9d6" }],
        cornerRadius: 6,
      });
    e.zoomTo(1);
    return { card, heading, body, shape, stack };
  });
  const view = async (id: string, name: string) => {
    await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), id);
    await expect(page.getByRole("toolbar", { name: "Selection Lens" })).toBeVisible();
    await page.waitForTimeout(250);
    await shot(page, name);
  };
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(300);
  await view(ids.heading, "120-lens-text-style");
  await view(ids.body, "121-lens-text");
  await view(ids.shape, "122-lens-shape");
  await view(ids.stack, "123-lens-auto-layout");

  await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), ids.shape);
  const lens = page.getByRole("toolbar", { name: "Selection Lens" });
  await lens.getByRole("button", { name: "Edit fill" }).click();
  await page.waitForTimeout(300);
  await shot(page, "124-lens-fill-picker");
  await page.keyboard.press("Escape");

  // Zoomed in on the card until it's bigger than the screen.
  await page.evaluate((id) => {
    const e = (window as unknown as W).drawpane;
    e.select([id]);
    e.zoomTo(4);
  }, ids.card);
  await expect(lens).toBeVisible();
  await page.waitForTimeout(250);
  await shot(page, "125-lens-inside");
  await context.close();
});
