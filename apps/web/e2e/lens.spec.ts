/**
 * The Selection Lens in a real browser, on a throwaway instance: the
 * controls each layer type gets, keeping clear of the layer below, a
 * popover that keeps the Lens open while it's in use, and turning the Lens
 * off (and back on) from the command bar.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
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
type W = { drawpane: Debug };

const props = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.props ?? {}, id);
const select = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as W).drawpane.select([id]), id);
const lens = (page: Page) => page.getByRole("toolbar", { name: "Selection Lens" });

test.describe
  .serial("Selection Lens", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let heading: string;
    let card: string;
    let swatch: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8813, inspectorPort: 9353 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      [heading, card, swatch] = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const c = e.createLayer("frame", { x: 0, y: 0, width: 400, height: 300 }, e.s.pageId, {
          name: "Card",
          fills: [{ type: "solid", color: "#ffffff" }],
        }) as string;
        const h = e.createLayer("text", { x: 24, y: 120, width: 10, height: 10 }, c, {
          characters: "Plan your week",
          fontSize: 28,
          fontWeight: 600,
        }) as string;
        // A paragraph under the heading, where the Lens would go: it shouldn't cover it.
        e.createLayer("text", { x: 24, y: 180, width: 10, height: 10 }, c, {
          characters: "Three things on today, nothing more.",
        });
        const s = e.createLayer("rect", { x: 500, y: 0, width: 120, height: 80 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#e8590c" }],
        }) as string;
        e.zoomTo(1);
        return [h, c, s];
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("gives text its font, weight, size and fill, clear of the next line", async () => {
      await select(page, heading);
      await expect(lens(page)).toBeVisible();
      await expect(lens(page).getByRole("button", { name: "Font: Instrument Sans" })).toBeVisible();
      await expect(lens(page).getByLabel("Font size")).toHaveValue("28");
      await expect(lens(page).getByRole("button", { name: "Edit fill" })).toBeVisible();
      // Above the heading, since below would sit on the paragraph.
      await expect(page.locator(".lens-anchor")).toHaveAttribute("data-side", "above");

      await lens(page).getByLabel("Weight").selectOption({ label: "Bold" });
      await expect.poll(async () => (await props(page, heading)).fontWeight).toBe(700);
    });

    test("keeps the fill picker open while it's in use", async () => {
      await lens(page).getByRole("button", { name: "Edit fill" }).click();
      const picker = page.getByRole("dialog", { name: "Fill paint" });
      await expect(picker).toBeVisible();
      // Dragging in the colour area is a gesture; the Lens (and its picker) stay.
      const box = await picker.locator(".dp-color-picker__area").boundingBox();
      if (!box) throw new Error("No colour area");
      await page.mouse.move(box.x + 10, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect
        .poll(async () => JSON.stringify((await props(page, heading)).fills))
        .not.toContain("#1c1b1a");
      await expect(picker).toBeVisible();
      await expect(lens(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();
    });

    test("gives a shape its size, fill and radius", async () => {
      await select(page, swatch);
      await expect(lens(page)).toContainText("Rectangle");
      for (const name of ["Width", "Height", "Corner radius"])
        await expect(lens(page).getByLabel(name, { exact: true })).toBeVisible();
      await expect(lens(page).getByRole("button", { name: "Edit fill" })).toBeVisible();
      const radius = lens(page).getByLabel("Corner radius");
      await radius.fill("12");
      await radius.press("Enter");
      await expect.poll(async () => (await props(page, swatch)).cornerRadius).toBe(12);
    });

    test("turns off and on from the command bar, and remembers", async () => {
      await select(page, card);
      await expect(lens(page)).toBeVisible();
      const toggle = async () => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press("ControlOrMeta+k");
        await page
          .getByRole("combobox", { name: "Type a command or a property" })
          .fill("Selection Lens");
        await page.keyboard.press("Enter");
      };
      await toggle();
      await expect(lens(page)).toBeHidden();
      expect(await page.evaluate(() => localStorage.getItem("drawpane:view"))).toContain(
        '"lens":false',
      );
      await toggle();
      await expect(lens(page)).toBeVisible();
    });
  });
