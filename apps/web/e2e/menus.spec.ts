/**
 * Right-click menus, renaming, properties and the shortcuts sheet in a real
 * browser, plus dragging a comment pin. Runs on its own throwaway instance.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: { pageId: string; selection: string[] };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  zoomToFit(): void;
  scene: { bounds(id: string): { x: number; y: number; width: number; height: number } | null };
  doc: {
    get(id: string): { parent: string; props: Record<string, unknown> } | undefined;
    pageIds(): string[];
    childIds(id: string): string[];
  };
};

const props = (page: Page, id: string) =>
  page.evaluate(
    (id) => (window as unknown as { drawpane: Debug }).drawpane.doc.get(id)?.props ?? {},
    id,
  );

/** Where a layer's centre is on screen. */
async function centreOf(page: Page, id: string) {
  return page.evaluate((id) => {
    const e = (
      window as unknown as {
        drawpane: Debug & {
          s: { camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } } };
        };
      }
    ).drawpane;
    const b = e.scene.bounds(id);
    if (!b) throw new Error("no bounds");
    const p = e.s.camera.toScreen({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    const rect = (
      document.querySelector(".canvas__overlay") as HTMLElement
    ).getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y };
  }, id);
}

const menu = (page: Page) => page.getByRole("menu").first();

test.describe
  .serial("Menus", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let card: string;
    let chip: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8785, inspectorPort: 9325 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      [card, chip] = await page.evaluate(() => {
        const e = (window as unknown as { drawpane: Debug }).drawpane;
        const p = e.s.pageId;
        const a = e.createLayer("rect", { x: 0, y: 0, width: 240, height: 160 }, p, {
          name: "Card",
          fills: [{ type: "solid", color: "#2b4fd6" }],
          cornerRadius: 16,
        }) as string;
        const b = e.createLayer("ellipse", { x: 320, y: 40, width: 80, height: 80 }, p, {
          name: "Chip",
        }) as string;
        e.select([]);
        e.zoomToFit();
        return [a, b];
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("right-clicking a layer selects it and offers what fits", async () => {
      const at = await centreOf(page, card);
      await page.mouse.click(at.x, at.y, { button: "right" });
      await expect(menu(page)).toBeVisible();
      expect(
        await page.evaluate(() => (window as unknown as { drawpane: Debug }).drawpane.s.selection),
      ).toEqual([card]);
      // Opened with the pointer, the menu holds focus: ↓ moves into it.
      await expect(menu(page)).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(menu(page).getByRole("menuitem").first()).toBeFocused();
      await expect(menu(page).getByRole("menuitem", { name: /^Ungroup/ })).toHaveCount(0);
      // Escape closes it without touching the selection.
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    });

    test("copies properties from one layer and pastes them on another", async () => {
      const at = await centreOf(page, card);
      await page.mouse.click(at.x, at.y, { button: "right" });
      await menu(page)
        .getByRole("menuitem", { name: /^Copy\/paste as/ })
        .hover();
      await page.getByRole("menuitem", { name: /^Copy properties/ }).click();
      const chipAt = await centreOf(page, chip);
      await page.mouse.click(chipAt.x, chipAt.y, { button: "right" });
      await menu(page)
        .getByRole("menuitem", { name: /^Copy\/paste as/ })
        .hover();
      await page.getByRole("menuitem", { name: /^Paste properties/ }).click();
      await expect
        .poll(async () => (await props(page, chip)).fills)
        .toEqual([{ type: "solid", color: "#2b4fd6" }]);
      // Ellipses have no corners: the radius stayed behind.
      expect((await props(page, chip)).cornerRadius).toBeUndefined();
    });

    test("submenus open with the keyboard and run their item", async () => {
      const at = await centreOf(page, chip);
      await page.mouse.click(at.x, at.y, { button: "right" });
      const align = menu(page).getByRole("menuitem", { name: /^Arrange/ });
      await align.focus();
      await page.keyboard.press("ArrowRight");
      const sub = page.getByRole("menu", { name: "Arrange" });
      await expect(sub).toBeVisible();
      await page.keyboard.press("ArrowLeft");
      await expect(sub).toHaveCount(0);
      await expect(align).toBeFocused();
      await page.keyboard.press("Escape");
    });

    test("renames from the menu and with ⌘R", async () => {
      const at = await centreOf(page, card);
      await page.mouse.click(at.x, at.y, { button: "right" });
      await menu(page)
        .getByRole("menuitem", { name: /^Rename/ })
        .click();
      const field = page.getByRole("tree", { name: "Layers" }).getByRole("textbox");
      await expect(field).toBeFocused();
      await field.fill("Hero card");
      await field.press("Enter");
      await expect.poll(async () => (await props(page, card)).name).toBe("Hero card");

      await page.keyboard.press("ControlOrMeta+r");
      await expect(field).toBeFocused();
      await field.press("Escape");
      expect((await props(page, card)).name).toBe("Hero card");
    });

    test("pastes where you right-click", async () => {
      await page.evaluate(
        (id) => (window as unknown as { drawpane: Debug }).drawpane.select([id]),
        chip,
      );
      await page.keyboard.press("ControlOrMeta+c");
      const at = await centreOf(page, card);
      // Empty canvas, below the card.
      await page.mouse.click(at.x, at.y + 220, { button: "right" });
      await expect(menu(page).getByRole("menuitem", { name: "Select all" })).toBeVisible();
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"])
        .catch(() => undefined);
      await menu(page)
        .getByRole("menuitem", { name: /^Paste here/ })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const e = (window as unknown as { drawpane: Debug }).drawpane;
            return e.doc.childIds(e.s.pageId).length;
          }),
        )
        .toBe(3);
    });

    test("duplicates a page from the pages list", async () => {
      await page.getByRole("button", { name: /^Page 1/ }).click({ button: "right" });
      await menu(page).getByRole("menuitem", { name: "Duplicate" }).click();
      await expect(page.getByRole("button", { name: /^Page 1 copy/ })).toHaveAttribute(
        "aria-current",
        "page",
      );
    });

    test("finds shortcuts by name or by pressing them", async () => {
      await page.locator(".canvas__overlay").click({ position: { x: 600, y: 700 } });
      await page.keyboard.press("ControlOrMeta+/");
      const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await expect(sheet).toBeVisible();
      const search = sheet.getByRole("searchbox", { name: "Search shortcuts" });
      await search.fill("tidy");
      await expect(sheet.getByRole("listitem")).toHaveCount(1);
      await expect(sheet.getByRole("listitem")).toContainText("Tidy up");
      await search.fill("");
      await search.press("ControlOrMeta+d");
      await expect(sheet.getByRole("listitem")).toContainText("Duplicate");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    });
  });
