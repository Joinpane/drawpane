/**
 * Screenshots of rulers, guides and layout grids for design review, in both
 * themes. Run with `pnpm --filter @drawpane/web tour`.
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
  select(ids: string[]): void;
  commit(ops: unknown[]): boolean;
  setGuide(
    owner: string,
    index: number | null,
    guide: { axis: string; offset: number } | null,
  ): boolean;
  s: { pageId: string };
};
const select = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as { drawpane: Debug }).drawpane.select([id]), id);

test("guides tour", async ({ browser }) => {
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

  // Columns on Home, a guide on the page and one inside Detail.
  await page.evaluate((ids) => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    e.commit([
      {
        op: "set",
        id: ids.home,
        prop: "layoutGrids",
        value: [
          {
            type: "columns",
            count: 4,
            gutter: 16,
            margin: 20,
            alignment: "stretch",
            size: 64,
            color: "#ff00001a",
          },
        ],
      },
    ]);
    e.setGuide(ids.detail, null, { axis: "y", offset: 120 });
  }, ids);
  await page.keyboard.press("Shift+r");
  await page.keyboard.press("Shift+1");
  await select(page, ids.row);
  await expect(page.locator(".rulers__top")).toBeVisible();
  await shot(page, "80-rulers-selection");

  // Dragging a new guide out of the left ruler.
  const side = await page.locator(".rulers__side").boundingBox();
  if (!side) throw new Error("no ruler");
  await page.mouse.move(side.x + 10, side.y + 300);
  await page.mouse.down();
  await page.mouse.move(side.x + 200, side.y + 300, { steps: 6 });
  await page.mouse.move(side.x + 260, side.y + 300, { steps: 4 });
  await shot(page, "81-guide-drag");
  await page.mouse.up();

  // The layout grids section on Home.
  await select(page, ids.home);
  await page.getByRole("button", { name: /^Columns/ }).click();
  await shot(page, "82-layout-grids");

  // A square grid, zoomed in.
  await page.evaluate((id) => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    e.commit([
      {
        op: "set",
        id,
        prop: "layoutGrids",
        value: [{ type: "grid", size: 8, color: "#2a5fe026" }],
      },
    ]);
  }, ids.detail);
  await select(page, ids.detail);
  await page.keyboard.press("Shift+2");
  await shot(page, "83-square-grid");

  // The guide menu.
  await page.keyboard.press("Shift+1");
  const top = await page.locator(".rulers__top").boundingBox();
  if (!top) throw new Error("no ruler");
  await page.mouse.move(top.x + 400, top.y + 10);
  await page.mouse.down();
  await page.mouse.move(top.x + 400, top.y + 500, { steps: 6 });
  await page.mouse.up();
  // Right on the new guide (it belongs to the board it was dropped on).
  await page.mouse.click(top.x + 420, top.y + 500, { button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Remove guide/ })).toBeVisible();
  await shot(page, "84-guide-menu");
});
