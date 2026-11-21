/**
 * Screenshots of the pixel grid for design review, in both themes: zoomed
 * to 1600% on the seam between a white and a near-black half of a board,
 * so the lines can be judged on light and dark content at once, with a
 * small layer selected so its outline reads over the grid.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

type Debug = {
  s: { pageId: string };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  centerOn(point: { x: number; y: number }): void;
  zoomTo(zoom: number): void;
};

test("pixel grid tour", async ({ browser }) => {
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

  await page.evaluate(() => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    const board = e.createLayer("frame", { x: 0, y: 0, width: 400, height: 300 }, e.s.pageId, {
      name: "Icon",
    }) as string;
    e.createLayer("rect", { x: 200, y: 0, width: 200, height: 300 }, board, {
      name: "Dark half",
      fills: [{ type: "solid", color: "#1c1b1a" }],
    });
    const glyph = e.createLayer("rect", { x: 188, y: 138, width: 24, height: 24 }, board, {
      name: "Glyph",
      fills: [{ type: "solid", color: "#e0531f" }],
      cornerRadius: 6,
    }) as string;
    e.createLayer("ellipse", { x: 194, y: 144, width: 12, height: 12 }, board, {
      name: "Dot",
      fills: [{ type: "solid", color: "#ffffff" }],
    });
    e.select([glyph]);
    e.centerOn({ x: 200, y: 150 });
    e.zoomTo(16);
  });
  await shot(page, "189-pixel-grid");
});
