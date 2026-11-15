/**
 * Where popovers and the Selection Lens land, in a real browser on a
 * throwaway instance: the inspector's pickers open over the canvas, clear
 * of the inspector and of the selection, and the Lens steps aside while
 * they're open; a picker opened from an effect's editor opens beside it,
 * not over it; the Lens's own fill picker keeps off the selection; and the
 * Lens keeps clear of the rulers.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Box = { x: number; y: number; width: number; height: number };
type Camera = { x: number; y: number; zoom: number; pan(dx: number, dy: number): Camera };
type Debug = {
  s: { pageId: string; camera: Camera };
  createLayer(type: string, rect: Box, parent: string, props?: Record<string, unknown>): string;
  select(ids: string[]): void;
  zoomTo(z: number): void;
  setCamera(camera: Camera): void;
  setProp(ids: string[], name: string, value: unknown, label: string): void;
  scene: { bounds(id: string): Box | null };
};
type W = { drawpane: Debug };

const lens = (page: Page) => page.getByRole("toolbar", { name: "Selection Lens" });
/** The design inspector, not the Lens (which repeats a few fields). */
const panel = (page: Page) => page.getByRole("group", { name: "Properties" });
const select = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as W).drawpane.select([id]), id);

const box = async (locator: Locator): Promise<Box> => {
  const b = await locator.boundingBox();
  if (!b) throw new Error("Not on screen");
  return b;
};
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** A layer's box on screen, in viewport pixels. */
const onScreen = (page: Page, id: string) =>
  page.evaluate((id) => {
    const e = (window as unknown as W).drawpane;
    const b = e.scene.bounds(id) as Box;
    const canvas = document.querySelector(".canvas")?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
    };
    const { x, y, zoom } = e.s.camera;
    return {
      x: canvas.left + b.x * zoom + x,
      y: canvas.top + b.y * zoom + y,
      width: b.width * zoom,
      height: b.height * zoom,
    };
  }, id);

/** Moves the view so the layer's top-left corner sits at (x, y) on screen. */
const moveTo = (page: Page, id: string, x: number, y: number) =>
  page.evaluate(
    ([id, x, y]) => {
      const e = (window as unknown as W).drawpane;
      const b = e.scene.bounds(id) as Box;
      const c = e.s.camera;
      e.setCamera(c.pan(x - (b.x * c.zoom + c.x), y - (b.y * c.zoom + c.y)));
    },
    [id, x, y] as const,
  );

test.describe
  .serial("Popover and Lens placement", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let rect: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8995, inspectorPort: 9535 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      rect = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const r = e.createLayer("rect", { x: 0, y: 0, width: 300, height: 300 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#e8590c" }],
          effects: [{ type: "drop-shadow", color: "#1c1b1a33", x: 0, y: 6, blur: 18, spread: -2 }],
        });
        e.zoomTo(1);
        return r;
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("opens the inspector's fill picker over the canvas, and the Lens steps aside", async () => {
      // Right beside the inspector, where a picker would otherwise sit on it.
      await moveTo(page, rect, 820, 300);
      await select(page, rect);
      await expect(lens(page)).toBeVisible();
      await panel(page).getByRole("button", { name: "Edit fill" }).click();
      const picker = page.getByRole("dialog", { name: "Fill paint" });
      await expect(picker).toBeVisible();
      const pane = await box(page.locator(".pane--right"));
      const placed = await box(picker);
      expect(placed.x + placed.width).toBeLessThanOrEqual(pane.x - 8 + 0.5);
      expect(overlaps(placed, await onScreen(page, rect))).toBe(false);
      await expect(lens(page)).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();
      await expect(lens(page)).toBeVisible();
    });

    test("opens a shadow's color picker beside the shadow's editor, not over it", async () => {
      await panel(page)
        .getByRole("button", { name: /^Drop shadow/ })
        .click();
      const editor = page.getByRole("dialog", { name: "Drop shadow" });
      await expect(editor).toBeVisible();
      await editor.getByRole("button", { name: "Edit shadow color" }).click();
      const picker = page.getByRole("dialog", { name: "Shadow color" });
      await expect(picker).toBeVisible();
      expect(overlaps(await box(picker), await box(editor))).toBe(false);
      expect(overlaps(await box(picker), await box(page.locator(".pane--right")))).toBe(false);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(editor).toBeHidden();
    });

    test("keeps the Lens's fill picker off the selection", async () => {
      // No room under the layer for the Lens, nor above the Lens for its picker.
      await moveTo(page, rect, 500, 480);
      await select(page, rect);
      await expect(lens(page)).toBeVisible();
      await expect(page.locator(".lens-anchor")).toHaveAttribute("data-side", "above");
      await lens(page).getByRole("button", { name: "Edit fill" }).click();
      const picker = page.getByRole("dialog", { name: "Fill paint" });
      await expect(picker).toBeVisible();
      const placed = await box(picker);
      expect(overlaps(placed, await onScreen(page, rect))).toBe(false);
      // Between the panes.
      const left = await box(page.locator(".pane--left"));
      const right = await box(page.locator(".pane--right"));
      expect(placed.x).toBeGreaterThanOrEqual(left.x + left.width);
      expect(placed.x + placed.width).toBeLessThanOrEqual(right.x);
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();
    });

    test("keeps the Lens clear of the rulers", async () => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Shift+R");
      const side = page.locator(".rulers__side");
      await expect(side).toBeVisible();
      // Tucked against the left ruler, where a centred Lens would run over it.
      const ruler = await box(side);
      await moveTo(page, rect, ruler.x + ruler.width - 200, 200);
      await select(page, rect);
      await page.mouse.move(700, 600);
      await expect(lens(page)).toBeVisible();
      const placed = await box(page.locator(".lens-anchor"));
      expect(overlaps(placed, ruler)).toBe(false);
      expect(overlaps(placed, await box(page.locator(".rulers__top")))).toBe(false);
      await page.keyboard.press("Shift+R");
    });
  });
