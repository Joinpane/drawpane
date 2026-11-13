/**
 * Masks in a real browser: ⌥⌘M groups a photo with a circle under it, the
 * canvas only shows the photo inside the circle, clicks outside it miss, the
 * layers panel says which is which, and the menu removes the mask again.
 */
import { expect, type Page, test } from "@playwright/test";
import { canvasColor, freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: { pageId: string; selection: string[] };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  reorder(d: string): void;
  zoomTo(z: number): void;
  setCamera(c: unknown): void;
  doc: {
    get(id: string): { parent: string; type: string; props: Record<string, unknown> } | undefined;
  };
};
const BLUE = "#2b4fd6";

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
  .serial("Masks", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let photo: string;
    let circle: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8779, inspectorPort: 9319 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      [photo, circle] = await page.evaluate((blue) => {
        const e = (window as unknown as { drawpane: Debug }).drawpane;
        const p = e.s.pageId;
        const c = e.createLayer("ellipse", { x: 100, y: 100, width: 200, height: 200 }, p, {
          name: "Circle",
        }) as string;
        const ph = e.createLayer("rect", { x: 0, y: 0, width: 400, height: 400 }, p, {
          name: "Photo",
          fills: [{ type: "solid", color: blue }],
        }) as string;
        e.zoomTo(1);
        return [ph, c];
      }, BLUE);
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("⌥⌘M masks the photo with the circle under it", async () => {
      await page.evaluate(
        (ids) => (window as unknown as { drawpane: Debug }).drawpane.select(ids),
        [photo, circle],
      );
      await page.keyboard.press("ControlOrMeta+Alt+m");
      await expect
        .poll(() =>
          page.evaluate(
            (id) => (window as unknown as { drawpane: Debug }).drawpane.doc.get(id)?.props.isMask,
            circle,
          ),
        )
        .toBe(true);

      // Inside the circle, the photo; in the photo's corner, outside the circle, nothing.
      const centre = await screenOf(page, { x: 200, y: 200 });
      const corner = await screenOf(page, { x: 20, y: 20 });
      await expect.poll(() => canvasColor(page, centre)).toBe(BLUE);
      await expect.poll(() => canvasColor(page, corner)).not.toBe(BLUE);

      // The layers panel names the parts.
      const tree = page.getByRole("tree", { name: "Layers" });
      await expect(tree.getByRole("treeitem", { name: /Mask group/ })).toBeVisible();
      await expect(tree.getByRole("treeitem", { name: /Circle/ })).toContainText("mask");
      await expect(tree.getByRole("treeitem", { name: /Photo/ })).toContainText("clipped");

      // A click outside the circle doesn't pick the hidden part of the photo.
      await page.mouse.click(corner.x, corner.y);
      expect(
        await page.evaluate(() => (window as unknown as { drawpane: Debug }).drawpane.s.selection),
      ).toEqual([]);
    });

    test("removes the mask from the menu", async () => {
      await page.evaluate(
        (id) => (window as unknown as { drawpane: Debug }).drawpane.select([id]),
        circle,
      );
      const centre = await screenOf(page, { x: 200, y: 200 });
      await page
        .getByRole("tree", { name: "Layers" })
        .getByRole("treeitem", { name: /Circle/ })
        .click({
          button: "right",
        });
      await page.getByRole("menuitem", { name: /^Remove mask/ }).click();
      const corner = await screenOf(page, { x: 20, y: 20 });
      await expect.poll(() => canvasColor(page, corner)).toBe(BLUE);
      await expect.poll(() => canvasColor(page, centre)).toBe(BLUE);
    });
  });
