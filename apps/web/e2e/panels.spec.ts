/**
 * Room for the canvas, in a real browser: side panels resized at their
 * edges (by pointer and keyboard, remembered), Minimize UI (⇧⌘\), and the
 * minimap showing while you move around, pinned with ⌥M, or off.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type W = {
  drawpane: {
    s: { pageId: string };
    doc: { childIds(id: string): string[] };
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
    zoomTo(z: number): void;
    centerOn(p: { x: number; y: number }): void;
  };
};

const width = async (page: Page, label: string) =>
  Math.round((await page.getByRole("complementary", { name: label }).boundingBox())?.width ?? 0);
const LAYERS = "Pages, layers, assets and history";
const mod = process.platform === "darwin" ? "Meta" : "Control";

test.describe
  .serial("Canvas room", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8865, inspectorPort: 9405 });
      page = instance.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        for (const x of [0, 500, 2400])
          e.createLayer("frame", { x, y: 0, width: 393, height: 852 }, e.s.pageId);
        e.zoomTo(0.6);
        e.centerOn({ x: 450, y: 420 });
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("resizes a panel at its edge, remembers it, and double-click resets it", async () => {
      expect(await width(page, LAYERS)).toBe(264);
      const edge = page.getByRole("separator", { name: "Resize the layers panel" });
      const box = (await edge.boundingBox()) as { x: number; y: number; width: number };
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + 200, { steps: 6 });
      await page.mouse.up();
      expect(await width(page, LAYERS)).toBe(344);
      await expect(edge).toHaveAttribute("aria-valuenow", "344");
      // The inspector's edge grows it leftwards.
      const right = page.getByRole("separator", { name: "Resize the inspector" });
      await right.focus();
      await page.keyboard.press("ArrowLeft");
      expect(await width(page, "Inspector")).toBe(272);

      await page.reload();
      expect(await width(page, LAYERS)).toBe(344);
      expect(await width(page, "Inspector")).toBe(272);

      await edge.dblclick();
      expect(await width(page, LAYERS)).toBe(264);
      await right.focus();
      await page.keyboard.press("Home");
      expect(await width(page, "Inspector")).toBe(240);
      await page.keyboard.press("Enter");
      expect(await width(page, "Inspector")).toBe(264);
    });

    test("minimizes the UI: layers tucked away, the inspector only for a selection", async () => {
      await page.keyboard.press(`${mod}+Shift+Backslash`);
      await expect(page.getByRole("complementary", { name: LAYERS })).toHaveCount(0);
      await expect(page.getByRole("complementary", { name: "Inspector" })).toHaveCount(0);
      const button = page.getByRole("button", { name: "Show panels" });
      await expect(button).toHaveAttribute("aria-pressed", "true");

      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        e.select([e.doc.childIds(e.s.pageId)[0] as string]);
      });
      await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
      await page.evaluate(() => (window as unknown as W).drawpane.select([]));
      await expect(page.getByRole("complementary", { name: "Inspector" })).toHaveCount(0);

      // Remembered, like the widths.
      await page.reload();
      await expect(page.getByRole("button", { name: "Show panels" })).toBeVisible();
      // Asking for the layers (⌘\) brings the panels back.
      await page.keyboard.press(`${mod}+Backslash`);
      await expect(page.getByRole("complementary", { name: LAYERS })).toBeVisible();
      await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Minimize UI" })).toBeVisible();
      // And the title's button does it too.
      await page.getByRole("button", { name: "Minimize UI" }).click();
      await expect(page.getByRole("complementary", { name: LAYERS })).toHaveCount(0);
      await page.getByRole("button", { name: "Show panels" }).click();
      await expect(page.getByRole("complementary", { name: LAYERS })).toBeVisible();
    });

    test("shows the minimap while moving around, pins it with ⌥M, or keeps it off", async () => {
      const minimap = page.locator("section.minimap");
      await expect(minimap).toHaveAttribute("data-asleep", "true");
      // Everything in view: moving around has nothing to show.
      await page.mouse.move(720, 450);
      await page.mouse.wheel(40, 0);
      await page.waitForTimeout(300);
      await expect(minimap).toHaveAttribute("data-asleep", "true");
      // Closer in, part of the page is out of view.
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        e.zoomTo(0.6);
        e.centerOn({ x: 450, y: 420 });
      });
      await page.waitForTimeout(1_800);
      // Panning, with some of the page out of view: it shows, then steps away.
      await page.mouse.move(720, 450);
      for (let i = 0; i < 5; i++) await page.mouse.wheel(80, 0);
      await expect(minimap).not.toHaveAttribute("data-asleep");
      await expect(minimap).toHaveAttribute("data-asleep", "true", { timeout: 5_000 });

      // ⌥M pins it.
      await page.keyboard.press("Alt+m");
      await expect(minimap).not.toHaveAttribute("data-asleep");
      await page.waitForTimeout(2_000);
      await expect(minimap).not.toHaveAttribute("data-asleep");

      // Never, from the canvas menu.
      await page.mouse.click(1000, 800, { button: "right" });
      await page.getByRole("menuitem", { name: "Minimap" }).hover();
      await page.getByRole("menuitemcheckbox", { name: "Never" }).click();
      await expect(minimap).toHaveCount(0);
      for (let i = 0; i < 5; i++) await page.mouse.wheel(-80, 0);
      await page.waitForTimeout(300);
      await expect(minimap).toHaveCount(0);
    });
  });
