/**
 * Screenshots of artboards and resizing for design review, in both themes:
 * renaming a frame on its label, and smart guides while resizing.
 * Run with `pnpm --filter @drawpane/web tour`.
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
    zoomTo(z: number): void;
    s: {
      pageId: string;
      camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } };
    };
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

test("artboards tour", async ({ browser }) => {
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

  const [card] = await page.evaluate(() => {
    const e = (window as unknown as W).drawpane;
    const p = e.s.pageId;
    const f = e.createLayer("frame", { x: 0, y: 0, width: 393, height: 852 }, p, {
      name: "iPhone 18 Pro",
      fills: [{ type: "solid", color: "#ffffff" }],
    }) as string;
    const a = e.createLayer("rect", { x: 24, y: 120, width: 200, height: 120 }, f, {
      cornerRadius: 16,
      fills: [{ type: "solid", color: "#e6ebfb" }],
    }) as string;
    e.createLayer("rect", { x: 24, y: 280, width: 345, height: 120 }, f, {
      cornerRadius: 16,
      fills: [{ type: "solid", color: "#f1f2f4" }],
    });
    e.zoomTo(1);
    e.select([a]);
    return [a, f];
  });
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(300);
  const canvas = await page.locator(".canvas__overlay").boundingBox();
  if (!canvas) throw new Error("no canvas");
  const screen = (x: number, y: number) =>
    page.evaluate((p) => (window as unknown as W).drawpane.s.camera.toScreen(p), { x, y });

  // Drag the card's right edge toward the wide card's right edge: it snaps, with a guide.
  const handle = await screen(224, 180);
  const near = await screen(366, 180);
  await page.mouse.move(canvas.x + handle.x, canvas.y + handle.y);
  await page.mouse.down();
  await page.mouse.move(canvas.x + near.x, canvas.y + near.y, { steps: 10 });
  await page.waitForTimeout(200);
  await shot(page, "108-resize-snap");
  await page.mouse.up();
  void card;

  // Double-click the frame's label to rename it in place.
  const label = await screen(0, 0);
  await page.mouse.dblclick(canvas.x + label.x + 10, canvas.y + label.y - 9);
  await page.keyboard.type("Home");
  await page.waitForTimeout(200);
  await shot(page, "109-rename-label");
  await context.close();
});
