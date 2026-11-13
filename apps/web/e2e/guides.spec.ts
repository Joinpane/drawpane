/**
 * Rulers, guides and layout grids in a real browser: drag a guide out of a
 * ruler onto a board, move it, remove it from its menu; add a layout grid
 * and see layers snap to it; view toggles survive a reload.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: { pageId: string; selection: string[]; rulers: boolean; layoutGrids: boolean };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  zoomTo(z: number): void;
  setCamera(c: unknown): void;
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
};
const debug = (page: Page) =>
  page.evaluate(() => (window as unknown as { drawpane: Debug }).drawpane.s);
const props = (page: Page, id: string) =>
  page.evaluate(
    (id) => (window as unknown as { drawpane: Debug }).drawpane.doc.get(id)?.props ?? {},
    id,
  );
const panel = (page: Page) => page.getByRole("group", { name: "Properties" });

/** Where a page point is on screen. */
const screenOf = (page: Page, p: { x: number; y: number }) =>
  page.evaluate((p) => {
    const e = (
      window as unknown as {
        drawpane: {
          s: { camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } } };
        };
      }
    ).drawpane;
    return e.s.camera.toScreen(p);
  }, p);

test.describe
  .serial("Rulers, guides and grids", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let board: string;
    let card: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8783, inspectorPort: 9323 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      [board, card] = await page.evaluate(() => {
        const e = (window as unknown as { drawpane: Debug }).drawpane;
        const b = e.createLayer("frame", { x: 0, y: 0, width: 400, height: 300 }, e.s.pageId, {
          name: "Board",
        }) as string;
        const c = e.createLayer("rect", { x: 40, y: 40, width: 60, height: 40 }, b, {
          name: "Card",
        }) as string;
        e.select([]);
        e.zoomTo(1);
        return [b, c];
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("⇧R shows rulers, and they stay on after a reload", async () => {
      await expect(page.locator(".rulers")).toHaveCount(0);
      await page.keyboard.press("Shift+R");
      await expect(page.locator(".rulers__top")).toBeVisible();
      await page.reload();
      await expect(page.locator(".rulers__top")).toBeVisible({ timeout: 15_000 });
      expect((await debug(page)).rulers).toBe(true);
    });

    test("drags a guide out of the ruler onto the board, moves it, and removes it", async () => {
      const side = await page.locator(".rulers__side").boundingBox();
      if (!side) throw new Error("no ruler");
      const at = await screenOf(page, { x: 200, y: 150 });
      await page.mouse.move(side.x + 10, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x - 30, at.y, { steps: 5 });
      await page.mouse.move(at.x, at.y, { steps: 3 });
      await page.mouse.up();
      await expect
        .poll(async () => (await props(page, board)).rulerGuides)
        .toEqual([{ axis: "x", offset: 200 }]);

      // Grab it on the canvas and drag it 60px right.
      await page.mouse.move(at.x, at.y + 40);
      await page.mouse.down();
      await page.mouse.move(at.x + 60, at.y + 40, { steps: 5 });
      await page.mouse.up();
      await expect
        .poll(async () => (await props(page, board)).rulerGuides)
        .toEqual([{ axis: "x", offset: 260 }]);

      // Undo puts it back; its menu removes it.
      await page.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(async () => (await props(page, board)).rulerGuides)
        .toEqual([{ axis: "x", offset: 200 }]);
      await page.mouse.click(at.x, at.y + 40, { button: "right" });
      await page.getByRole("menuitem", { name: /^Remove guide/ }).click();
      await expect.poll(async () => (await props(page, board)).rulerGuides).toBeUndefined();
    });

    test("adds a layout grid that layers snap to", async () => {
      await page.evaluate(
        (id) => (window as unknown as { drawpane: Debug }).drawpane.select([id]),
        board,
      );
      await panel(page).getByRole("button", { name: "Add layout grid" }).click();
      await expect
        .poll(async () => ((await props(page, board)).layoutGrids as unknown[])?.length)
        .toBe(1);
      await panel(page).getByLabel("Column count").fill("4");
      await panel(page).getByLabel("Column count").press("Enter");
      // 400 wide, 20 margins and gutters: columns 75 wide, the second starting at 115.
      await expect
        .poll(
          async () =>
            ((await props(page, board)).layoutGrids as Array<{ count: number }>)[0]?.count,
        )
        .toBe(4);

      // Drag the card so its left edge lands near the second column (x 120 → 115).
      await page.evaluate(
        (id) => (window as unknown as { drawpane: Debug }).drawpane.select([id]),
        card,
      );
      const from = await screenOf(page, { x: 70, y: 60 });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 40, from.y, { steps: 4 });
      await page.mouse.move(from.x + 80, from.y, { steps: 4 });
      await page.mouse.up();
      await expect.poll(async () => (await props(page, card)).x).toBe(115);

      // ⇧G hides grids, and then there's nothing to snap to.
      await page.keyboard.press("ControlOrMeta+z");
      await page.keyboard.press("Shift+G");
      expect((await debug(page)).layoutGrids).toBe(false);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 40, from.y, { steps: 4 });
      await page.mouse.move(from.x + 80, from.y, { steps: 4 });
      await page.mouse.up();
      await expect.poll(async () => (await props(page, card)).x).toBe(120);
      await page.keyboard.press("Shift+G");
    });
  });
