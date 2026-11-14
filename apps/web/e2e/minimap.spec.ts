/**
 * The minimap in a real browser: it shows the page's boards, clicking it
 * moves the view there, dragging the outline carries the view, ⌥M hides it
 * (remembered), and it steps aside when the canvas is too narrow.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: { pageId: string };
  createLayer(
    t: string,
    r: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string;
  select(ids: string[]): void;
  zoomTo(z: number): void;
  centerOn(p: { x: number; y: number }): void;
  visibleArea(): { x: number; y: number; width: number; height: number } | null;
};
type W = { drawpane: Debug };

const centre = (page: Page) =>
  page.evaluate(() => {
    const v = (window as unknown as W).drawpane.visibleArea();
    if (!v) throw new Error("no view");
    return { x: v.x + v.width / 2, y: v.y + v.height / 2 };
  });

test.describe
  .serial("Minimap", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8837, inspectorPort: 9377 });
      page = instance.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        for (const [i, name] of ["Home", "Settings", "Profile"].entries())
          e.createLayer("frame", { x: i * 2000, y: 0, width: 400, height: 800 }, e.s.pageId, {
            name,
          });
        e.select([]);
        e.zoomTo(1);
        e.centerOn({ x: 200, y: 400 });
      });
    });
    test.afterAll(() => instance?.stop());

    test("shows the page and its boards", async () => {
      const minimap = page.getByRole("region", { name: "Minimap" });
      await expect(minimap).toBeVisible();
      await expect(minimap).toContainText("Page 1");
      await expect(minimap).toContainText("3 boards");
    });

    test("moves the view where you click, and carries it when you drag the outline", async () => {
      const map = page.locator(".minimap__map");
      const box = await map.boundingBox();
      if (!box) throw new Error("no map");
      // The right end of the map is the Profile board's side of the page.
      await page.mouse.click(box.x + box.width - 12, box.y + box.height / 2);
      const after = await centre(page);
      expect(after.x).toBeGreaterThan(3000);

      // Grab the outline (now at the right) and drag it left: the view follows, without a jump.
      const before = await centre(page);
      // Off the outline's centre (it's about 27px wide here), so a jump would show.
      const grab = { x: box.x + box.width - 18, y: box.y + box.height / 2 };
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      const first = await centre(page);
      expect(Math.abs(first.x - before.x)).toBeLessThan(1);
      await page.mouse.move(grab.x - 40, grab.y, { steps: 5 });
      await page.mouse.up();
      const dragged = await centre(page);
      expect(dragged.x).toBeLessThan(before.x - 500);
    });

    test("⌥M hides it, and it stays hidden after a reload", async () => {
      const minimap = page.getByRole("region", { name: "Minimap" });
      await page.locator(".canvas__overlay").click({ position: { x: 600, y: 400 } });
      await page.keyboard.press("Alt+m");
      await expect(minimap).toBeHidden();
      await page.reload();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await expect(minimap).toBeHidden();
      await page.keyboard.press("Alt+m");
      await expect(minimap).toBeVisible();
    });

    test("steps aside when the canvas is too narrow for it beside the zoom controls", async () => {
      const minimap = page.getByRole("region", { name: "Minimap" });
      await page.setViewportSize({ width: 1024, height: 768 });
      await expect(minimap).toBeHidden();
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(minimap).toBeVisible();
      // It never overlaps the zoom controls.
      const map = await minimap.boundingBox();
      const zoom = await page.getByRole("group", { name: "Zoom" }).boundingBox();
      if (!map || !zoom) throw new Error("not on screen");
      expect(map.x + map.width).toBeLessThan(zoom.x);
    });
  });
