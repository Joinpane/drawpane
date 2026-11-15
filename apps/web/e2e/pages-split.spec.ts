/**
 * The line between the pages and the layers, in a real browser: dragged
 * like Figma's to show more pages or more layers, by pointer and keyboard,
 * remembered, reset with a double-click. It never leaves space below a short
 * list, always leaves the layers some room, and keeps the current page in view.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type W = {
  drawpane: {
    s: { pageId: string };
    addPage(): void;
    setPage(id: string): void;
    doc: { pageIds(): string[] };
  };
};

const ROW = 28;
const height = async (el: Locator) => Math.round((await el.boundingBox())?.height ?? 0);
const pageCount = (page: Page) =>
  page.evaluate(() => (window as unknown as W).drawpane.doc.pageIds().length);

/** Presses the line's middle and lets go `by` pixels lower, moving the way a hand does. */
async function drag(page: Page, line: Locator, by: number, during?: () => Promise<void>) {
  const box = await line.boundingBox();
  if (!box) throw new Error("no line to drag");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + by, { steps: 8 });
  await during?.();
  await page.mouse.up();
}

test.describe
  .serial("Resizing the pages list", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let list: Locator;
    let line: Locator;
    let layers: Locator;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8973, inspectorPort: 9513 });
      page = instance.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      list = page.getByRole("list", { name: "Pages" });
      line = page.getByRole("separator", { name: "Resize the pages list" });
      layers = page.locator(".layers");
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("a short list shows just its pages, however far it's dragged", async () => {
      const pages = await pageCount(page);
      expect(pages).toBeLessThan(4);
      expect(await height(list)).toBe(pages * ROW);
      await expect(line).toHaveAttribute("aria-orientation", "horizontal");
      await expect(line).toHaveAttribute("aria-valuemax", String(pages * ROW));
      await drag(page, line, 200);
      expect(await height(list)).toBe(pages * ROW);
      // Back to the default height (160px, five pages and a bit).
      await line.dblclick();
      expect(await height(list)).toBe(pages * ROW);

      // It grows with new pages, up to that height.
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        while (e.doc.pageIds().length < 4) e.addPage();
      });
      await expect.poll(() => height(list)).toBe(4 * ROW);
      await page.getByRole("button", { name: "Add page" }).click();
      await expect.poll(() => height(list)).toBe(5 * ROW);
    });

    test("drags to show more pages and fewer layers, stopping at the last page", async () => {
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        while (e.doc.pageIds().length < 20) e.addPage();
      });
      await expect.poll(() => height(list)).toBe(160);
      await expect(line).toHaveAttribute("aria-valuenow", "160");
      const layersBefore = await height(layers);

      // The resize cursor everywhere while dragging, and the line lit.
      await drag(page, line, 80, async () => {
        await expect(line).toHaveAttribute("data-dragging", "true");
        expect(await page.evaluate(() => document.documentElement.dataset.resizing)).toBe("y");
        expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe(
          "row-resize",
        );
      });
      expect(await page.evaluate(() => document.documentElement.dataset.resizing)).toBeUndefined();
      expect(await height(list)).toBe(240);
      await expect(line).toHaveAttribute("aria-valuenow", "240");
      expect(await height(layers)).toBe(layersBefore - 80);

      // Twenty pages are 560px: dragging further stops there (as far as the list shows).
      await drag(page, line, 600);
      expect(await height(list)).toBe(20 * ROW);
      await expect(line).toHaveAttribute("aria-valuemax", String(20 * ROW));
      await expect(line).toHaveAttribute("aria-valuenow", String(20 * ROW));
      // And up, to about one and a half rows.
      await drag(page, line, -800);
      expect(await height(list)).toBe(42);
      await expect(line).toHaveAttribute("aria-valuemin", "42");
    });

    test("works from the keyboard, and double-click or Enter resets it", async () => {
      await line.focus();
      await page.keyboard.press("ArrowDown");
      expect(await height(list)).toBe(50);
      await page.keyboard.press("Shift+ArrowDown");
      expect(await height(list)).toBe(82);
      await page.keyboard.press("ArrowUp");
      expect(await height(list)).toBe(74);
      await page.keyboard.press("End");
      expect(await height(list)).toBe(20 * ROW);
      await page.keyboard.press("Home");
      expect(await height(list)).toBe(42);
      await page.keyboard.press("Enter");
      expect(await height(list)).toBe(160);

      await drag(page, line, 100);
      expect(await height(list)).toBe(260);
      await line.dblclick();
      expect(await height(list)).toBe(160);
    });

    test("is remembered after a reload", async () => {
      await drag(page, line, 64);
      expect(await height(list)).toBe(224);
      await page.reload();
      await expect.poll(() => height(list)).toBe(224);
      await expect(line).toHaveAttribute("aria-valuenow", "224");
    });

    test("leaves the layers room in a short window, and the preference for a taller one", async () => {
      await line.focus();
      await page.keyboard.press("End");
      expect(await height(list)).toBe(20 * ROW);
      await page.setViewportSize({ width: 1440, height: 560 });
      await expect.poll(() => height(list)).toBeLessThan(20 * ROW);
      expect(Math.abs((await height(layers)) - 120)).toBeLessThanOrEqual(1);
      const max = await height(list);
      expect(max).toBeLessThan(20 * ROW);
      await expect(line).toHaveAttribute("aria-valuemax", String(max));
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect.poll(() => height(list)).toBe(20 * ROW);
    });

    test("keeps the current page in view as the list gets shorter", async () => {
      const last = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const id = e.doc.pageIds().at(-1) as string;
        e.setPage(id);
        return id;
      });
      expect(last).toBeTruthy();
      const current = list.locator('[aria-current="page"]');
      await line.focus();
      await page.keyboard.press("Home");
      expect(await height(list)).toBe(42);
      const view = (await list.boundingBox()) as { y: number; height: number };
      const row = (await current.boundingBox()) as { y: number; height: number };
      expect(row.y).toBeGreaterThanOrEqual(view.y - 0.5);
      expect(row.y + row.height).toBeLessThanOrEqual(view.y + view.height + 0.5);
    });

    test("leaves clicks next to the line to the rows", async () => {
      await page.keyboard.press("Enter");
      expect(await height(list)).toBe(160);
      // The last row in view, pressed 2px above the list's bottom edge.
      await list.evaluate((ul) => {
        ul.scrollTop = 0;
      });
      const view = (await list.boundingBox()) as { x: number; y: number; height: number };
      await page.mouse.click(view.x + 40, view.y + view.height - 2);
      const sixth = await page.evaluate(() => (window as unknown as W).drawpane.doc.pageIds()[5]);
      expect(await page.evaluate(() => (window as unknown as W).drawpane.s.pageId)).toBe(sixth);
      // The layers' buttons, just below the line, still take their clicks at their top edge.
      const find = (await page.getByRole("button", { name: "Find layers" }).boundingBox()) as {
        x: number;
        y: number;
        width: number;
      };
      await page.mouse.click(find.x + find.width / 2, find.y + 1);
      await expect(page.getByRole("button", { name: "Find layers" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.keyboard.press("Escape");
    });

    test("comes back with the panels after Minimize UI", async () => {
      const mod = process.platform === "darwin" ? "Meta" : "Control";
      await drag(page, line, 40);
      expect(await height(list)).toBe(200);
      await page.keyboard.press(`${mod}+Shift+Backslash`);
      await expect(list).toHaveCount(0);
      await page.keyboard.press(`${mod}+Shift+Backslash`);
      await expect.poll(() => height(list)).toBe(200);
    });
  });
