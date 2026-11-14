/**
 * Alt-hover measuring in a real browser: with a layer selected, holding Alt
 * shows the distances to what the pointer rests on, at the selection's level
 * (its parent, a sibling, a parent's sibling), and letting go ends it. The
 * rules have their own tests (packages/editor/test/measure.test.ts).
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: {
    pageId: string;
    hover: string | null;
    measure: boolean;
    camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } };
  };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  zoomTo(z: number): void;
  revealSelection(): void;
};
type W = { drawpane: Debug };

const state = (page: Page) =>
  page.evaluate(() => {
    const { measure, hover } = (window as unknown as W).drawpane.s;
    return { measure, hover };
  });

async function client(page: Page, x: number, y: number) {
  const box = await page.locator(".canvas").first().boundingBox();
  const p = await page.evaluate(
    ([x, y]) => (window as unknown as W).drawpane.s.camera.toScreen({ x, y }),
    [x, y] as const,
  );
  return { x: (box?.x ?? 0) + p.x, y: (box?.y ?? 0) + p.y };
}

test.describe
  .serial("Alt-hover measuring", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8863, inspectorPort: 9403 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("measures to the parent, a sibling and the parent's sibling, while Alt is held", async () => {
      const ids = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const card = e.createLayer("frame", { x: 0, y: 0, width: 600, height: 300 }, e.s.pageId, {
          name: "Card",
        }) as string;
        const row = e.createLayer("frame", { x: 40, y: 40, width: 400, height: 100 }, card, {
          name: "Row",
        }) as string;
        const icon = e.createLayer("rect", { x: 60, y: 60, width: 60, height: 60 }, row, {
          name: "Icon",
        }) as string;
        const label = e.createLayer("rect", { x: 160, y: 70, width: 200, height: 40 }, row, {
          name: "Label",
        }) as string;
        const footer = e.createLayer("frame", { x: 40, y: 200, width: 400, height: 60 }, card, {
          name: "Footer",
        }) as string;
        e.createLayer("rect", { x: 60, y: 210, width: 100, height: 40 }, footer, {
          name: "Button",
        });
        e.select([label]);
        e.zoomTo(1);
        e.revealSelection();
        return { card, row, icon, label, footer };
      });
      await page.waitForTimeout(300);

      // Resting on the row's bare area, then pressing Alt: measuring starts without a move.
      const onRow = await client(page, 420, 130);
      await page.mouse.move(onRow.x, onRow.y);
      expect(await state(page)).toEqual({ measure: false, hover: expect.anything() });
      await page.keyboard.down("Alt");
      await expect.poll(() => state(page)).toEqual({ measure: true, hover: ids.row });

      // A sibling, the parent's parent, and the parent's sibling (as a whole, not its button).
      const onIcon = await client(page, 90, 90);
      await page.mouse.move(onIcon.x, onIcon.y);
      await expect.poll(() => state(page)).toEqual({ measure: true, hover: ids.icon });
      const onCard = await client(page, 550, 20);
      await page.mouse.move(onCard.x, onCard.y);
      await expect.poll(() => state(page)).toEqual({ measure: true, hover: ids.card });
      const onButton = await client(page, 100, 230);
      await page.mouse.move(onButton.x, onButton.y);
      await expect.poll(() => state(page)).toEqual({ measure: true, hover: ids.footer });

      // Letting go ends it, where the pointer is.
      await page.keyboard.up("Alt");
      await expect.poll(async () => (await state(page)).measure).toBe(false);
    });
  });
