/**
 * Masks in a real browser: ⌥⌘M groups a photo with a circle under it, the
 * canvas only shows the photo inside the circle, clicks outside it miss, the
 * layers panel says which is which, the inspector makes it mask by alpha
 * (a fading circle fades the photo), and the menu removes the mask again.
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
  setProp(ids: string[], prop: string, value: unknown, label: string): void;
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

    test("masks by alpha from the inspector: a fading mask fades what it masks", async () => {
      await page.evaluate(
        ({ id }) => {
          const e = (window as unknown as { drawpane: Debug }).drawpane;
          e.setProp(
            [id],
            "fills",
            [
              {
                type: "linear",
                from: { x: 0, y: 0.5 },
                to: { x: 1, y: 0.5 },
                stops: [
                  { position: 0, color: "#000000" },
                  { position: 1, color: "#00000000" },
                ],
              },
            ],
            "Fade",
          );
          e.select([id]);
        },
        { id: circle },
      );
      const left = await screenOf(page, { x: 115, y: 200 });
      const right = await screenOf(page, { x: 285, y: 200 });
      // By its outline (the default), the fill doesn't matter: the photo shows across it.
      await expect.poll(() => canvasColor(page, right)).toBe(BLUE);

      const inspector = page.getByRole("complementary", { name: "Inspector" });
      await inspector.getByLabel("Mask type").selectOption("alpha");
      await expect
        .poll(() =>
          page.evaluate(
            (id) => (window as unknown as { drawpane: Debug }).drawpane.doc.get(id)?.props.maskType,
            circle,
          ),
        )
        .toBe("alpha");
      // Where the mask is opaque the photo shows; where it has faded, hardly any of it.
      const blueness = (hex: string) =>
        Number.parseInt(hex.slice(5, 7), 16) - Number.parseInt(hex.slice(1, 3), 16);
      await expect.poll(async () => blueness(await canvasColor(page, left))).toBeGreaterThan(150);
      await expect.poll(async () => blueness(await canvasColor(page, right))).toBeLessThan(30);

      await inspector.getByLabel("Mask type").selectOption("outline");
      await expect.poll(() => canvasColor(page, right)).toBe(BLUE);
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
