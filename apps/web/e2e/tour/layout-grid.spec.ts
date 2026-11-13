/**
 * Screenshots of grid layout and wrap for design review, in both themes: a
 * selected grid with its track headers and track editor, a selected grid
 * item, and a wrapping row.
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
    setLayoutMode(ids: string[], mode: string): void;
    fitTo?(ids: string[]): void;
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

test("grid layout tour", async ({ browser }) => {
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

  const [frame, header] = await page.evaluate(() => {
    const e = (window as unknown as W).drawpane;
    const p = e.s.pageId;
    const f = e.createLayer("frame", { x: 0, y: 0, width: 640, height: 440 }, p, {
      name: "Dashboard",
      cornerRadius: 16,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
      paddingLeft: 16,
      fills: [{ type: "solid", color: "#ffffff" }],
    }) as string;
    const card = (name: string, color: string) =>
      e.createLayer("rect", { x: 0, y: 0, width: 80, height: 60 }, f, {
        name,
        cornerRadius: 10,
        fills: [{ type: "solid", color }],
        sizingH: "fill",
        sizingV: "fill",
      }) as string;
    const nav = card("Sidebar", "#f1f2f4");
    const head = card("Header", "#e6ebfb");
    const a = card("Revenue", "#f7f8fa");
    const b = card("Signups", "#f7f8fa");
    const c = card("Footer", "#f7f8fa");
    e.setLayoutMode([f], "grid");
    // Tracks like the design: a fixed sidebar column, three flexible ones.
    const set = (id: string, prop: string, value: unknown) =>
      (e as unknown as { setProp(ids: string[], p: string, v: unknown): void }).setProp(
        [id],
        prop,
        value,
      );
    set(f, "gap", 16);
    set(f, "rowGap", 16);
    set(f, "gridColumns", [
      { unit: "px", value: 160 },
      { unit: "fr", value: 1 },
      { unit: "fr", value: 1 },
      { unit: "fr", value: 1 },
    ]);
    set(f, "gridRows", [
      { unit: "px", value: 96 },
      { unit: "fr", value: 1 },
      { unit: "px", value: 72 },
    ]);
    set(nav, "gridArea", { column: 1, row: 1, columnSpan: 1, rowSpan: 3 });
    set(head, "gridArea", { column: 2, row: 1, columnSpan: 3, rowSpan: 1 });
    set(a, "gridArea", { column: 2, row: 2, columnSpan: 1, rowSpan: 1 });
    set(b, "gridArea", { column: 3, row: 2, columnSpan: 2, rowSpan: 1 });
    set(c, "gridArea", { column: 2, row: 3, columnSpan: 3, rowSpan: 1 });
    e.zoomTo(1);
    e.select([f]);
    return [f, head];
  });
  await page.keyboard.press("Shift+2");
  await page.waitForTimeout(300);
  await shot(page, "102-grid-frame");

  await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), header as string);
  await page.waitForTimeout(200);
  await shot(page, "103-grid-item");

  await page.evaluate(() => {
    const e = (window as unknown as W).drawpane;
    const p = e.s.pageId;
    const r = e.createLayer("frame", { x: 720, y: 0, width: 360, height: 200 }, p, {
      name: "Tags",
      layoutMode: "row",
      layoutWrap: true,
      gap: 8,
      rowGap: 12,
      sizingV: "hug",
      paddingTop: 12,
      paddingRight: 12,
      paddingBottom: 12,
      paddingLeft: 12,
      cornerRadius: 12,
      fills: [{ type: "solid", color: "#ffffff" }],
    }) as string;
    const widths = [72, 96, 64, 120, 88, 56, 104, 80];
    for (const w of widths)
      e.createLayer("rect", { x: 0, y: 0, width: w, height: 28 }, r, {
        cornerRadius: 14,
        fills: [{ type: "solid", color: "#e6ebfb" }],
      });
    e.select([r]);
  });
  await page.keyboard.press("Shift+2");
  await page.waitForTimeout(300);
  await shot(page, "104-wrap");
  void frame;
  await context.close();
});
