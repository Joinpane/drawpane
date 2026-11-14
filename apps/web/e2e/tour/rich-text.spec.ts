/**
 * Screenshots of rich text for design review, in both themes: a heading with
 * a bold, coloured word and a paragraph mixing sizes; editing with part of
 * it selected; the caret; and the inspector reading "Mixed" for the layer.
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
    createTextStyle(name: string, fromId?: string): string | null;
    startTextEdit(id: string): void;
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

test("rich text tour", async ({ browser }) => {
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
    const card = e.createLayer("frame", { x: 0, y: 0, width: 460, height: 300 }, e.s.pageId, {
      name: "Card",
      fills: [{ type: "solid", color: "#ffffff" }],
    }) as string;
    const heading = e.createLayer("text", { x: 32, y: 40, width: 10, height: 10 }, card, {
      characters: "Plan your week",
      fontSize: 40,
      fontWeight: 600,
      textRuns: [
        { start: 5, end: 9, fontWeight: 800, fills: [{ type: "solid", color: "#e8590c" }] },
      ],
    }) as string;
    const body = e.createLayer("text", { x: 32, y: 120, width: 396, height: 10 }, card, {
      characters: "Three things on today, nothing more. Pick the one that matters and do it first.",
      fontSize: 17,
      textAutoResize: "height",
      lineHeight: { unit: "percent", value: 150 },
      textRuns: [
        { start: 0, end: 12, fontWeight: 700 },
        { start: 37, end: 64, fontStyle: "italic", textDecoration: "underline" },
      ],
    }) as string;
    e.zoomTo(1);
    e.select([heading]);
    return { card, heading, body };
  });
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(300);
  await shot(page, "126-rich-text-mixed");

  // Editing the paragraph with "the one that matters" selected.
  await page.evaluate((id) => (window as unknown as W).drawpane.startTextEdit(id), ids.body);
  const textbox = page.getByRole("textbox", { name: "Text", exact: true });
  await expect(textbox).toBeFocused();
  // Placed, then nudged with the keyboard the way a person would, so it's reported.
  await textbox.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(42, 63));
  await page.keyboard.press("Shift+ArrowLeft");
  await page.waitForTimeout(200);
  await shot(page, "127-rich-text-selection");

  await textbox.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(13, 13));
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(150);
  await shot(page, "128-rich-text-caret");
  await context.close();
});
