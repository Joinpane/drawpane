/**
 * Screenshots of paragraph spacing and truncation for design review, in both
 * themes, set from the inspector. Run with `pnpm --filter @drawpane/web tour`.
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
    s: { pageId: string };
    doc: { get(id: string): { props: Record<string, unknown> } | undefined };
  };
};

test("paragraphs and truncation tour", async ({ browser }) => {
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
    const card = e.createLayer("frame", { x: 0, y: 0, width: 360, height: 420 }, e.s.pageId, {
      name: "Card",
      fills: [{ type: "solid", color: "#ffffff" }],
    }) as string;
    const body = e.createLayer("text", { x: 24, y: 24, width: 312, height: 10 }, card, {
      characters:
        "Plan your week in one glance. Everything that matters, nothing that doesn't.\nMeetings, focus time and errands share one calendar, so the day reads at a glance.\nWorks offline, and syncs the moment you're back.",
      fontSize: 15,
      textAutoResize: "height",
    }) as string;
    const preview = e.createLayer("text", { x: 24, y: 300, width: 312, height: 10 }, card, {
      characters:
        "A long preview line that runs on past its box, the way a message list cuts a message short after a couple of lines so every row stays the same height.",
      fontSize: 15,
      textAutoResize: "height",
    }) as string;
    e.zoomTo(1);
    return { body, preview };
  });
  const prop = (id: string, name: string) =>
    page.evaluate(([id, name]) => (window as unknown as W).drawpane.doc.get(id)?.props[name], [
      id,
      name,
    ] as const);

  // Paragraph spacing, from the inspector.
  await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), ids.body);
  await page.keyboard.press("Shift+1");
  const spacing = page.getByLabel("Paragraph spacing");
  await spacing.fill("12");
  await spacing.press("Enter");
  await expect.poll(() => prop(ids.body, "paragraphSpacing")).toBe(12);
  await page.waitForTimeout(250);
  await shot(page, "150-paragraph-spacing");

  // Truncate the preview to two lines.
  await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), ids.preview);
  await page.getByRole("combobox", { name: "Truncate" }).selectOption("2");
  await expect.poll(() => prop(ids.preview, "maxLines")).toBe(2);
  await page.waitForTimeout(250);
  await shot(page, "151-truncate");
  await context.close();
});
