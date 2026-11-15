/**
 * Reordering a layer's fills and effects in the inspector, as in Figma: a
 * row dragged past others takes their place, as one step to undo, and a
 * press that doesn't move is still a click; Alt+↑/↓ moves the focused row,
 * keeping the keyboard on it and an open editor on its item.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type W = {
  drawpane: {
    s: { pageId: string };
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
    zoomTo(z: number): void;
    doc: { get(id: string): { props: Record<string, unknown> } | undefined };
  };
};

const panel = (page: Page) => page.getByRole("group", { name: "Properties" });
const section = (page: Page, name: string) => panel(page).getByRole("region", { name });

/** A list prop of the layer, each item by `key`, in the model's order (bottom first). */
const listed = (page: Page, id: string, prop: string, key: string) =>
  page.evaluate(
    ({ id, prop, key }) =>
      (
        ((window as unknown as W).drawpane.doc.get(id)?.props[prop] ?? []) as Array<
          Record<string, unknown>
        >
      ).map((item) => String(item[key])),
    { id, prop, key },
  );

/** Presses `from`'s middle and lets go over `to`'s, moving the way a hand does. */
async function drag(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("no row to drag");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, b.y + b.height / 2 + 2, { steps: 12 });
  await page.mouse.up();
}

test.describe
  .serial("Reordering paints and effects", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let id: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8887, inspectorPort: 9427 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      id = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const r = e.createLayer("rect", { x: 40, y: 40, width: 120, height: 80 }, e.s.pageId, {
          fills: [
            { type: "solid", color: "#ff0000" },
            { type: "solid", color: "#00ff00" },
            { type: "solid", color: "#0000ff" },
          ],
          effects: [
            { type: "drop-shadow", x: 0, y: 4, blur: 8, spread: 0, color: "#00000040" },
            { type: "layer-blur", radius: 4 },
          ],
        }) as string;
        e.zoomTo(1);
        e.select([r]);
        return r;
      });
      await expect(section(page, "Fill").locator(".paint-row")).toHaveCount(3);
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("drags the top fill to the bottom, as one step to undo", async () => {
      const rows = section(page, "Fill").locator(".paint-row");
      // Topmost first: blue, green, red.
      await drag(page, rows.nth(0).getByRole("button", { name: "Edit fill" }), rows.nth(2));
      await expect
        .poll(() => listed(page, id, "fills", "color"))
        .toEqual(["#0000ff", "#ff0000", "#00ff00"]);
      // The drag wasn't a click: the swatch's picker stayed shut.
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // Rows sit back in place, nothing left lifted.
      await expect(rows.nth(0)).not.toHaveAttribute("data-reorder");
      await page.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(() => listed(page, id, "fills", "color"))
        .toEqual(["#ff0000", "#00ff00", "#0000ff"]);
    });

    test("a press that doesn't move still opens the picker", async () => {
      const swatch = section(page, "Fill")
        .locator(".paint-row")
        .nth(0)
        .getByRole("button", { name: "Edit fill" });
      await swatch.click();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("Alt+↑ moves the focused effect, keeping focus and its open editor with it", async () => {
      const toggles = section(page, "Effects").locator(".item-row__toggle");
      await expect(toggles).toHaveCount(2);
      await toggles.nth(1).click();
      await expect(page.getByRole("dialog", { name: "Layer blur" })).toBeVisible();
      await toggles.nth(1).focus();
      await page.keyboard.press("Alt+ArrowUp");
      await expect
        .poll(() => listed(page, id, "effects", "type"))
        .toEqual(["layer-blur", "drop-shadow"]);
      await expect(toggles.nth(0)).toBeFocused();
      await expect(toggles.nth(0)).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("dialog", { name: "Layer blur" })).toBeVisible();
      await page.keyboard.press("Alt+ArrowDown");
      await expect
        .poll(() => listed(page, id, "effects", "type"))
        .toEqual(["drop-shadow", "layer-blur"]);
      await expect(toggles.nth(1)).toBeFocused();
    });
  });
