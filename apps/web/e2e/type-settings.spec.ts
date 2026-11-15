/**
 * Type settings in a real browser: the Text section keeps what's set most,
 * and a button opens the rest in tabs (Basics, Details, Variable), as in
 * Figma. It's reachable by keyboard, remembers its tab, says on its button
 * what's set in it, and offers Variable only for a font that varies.
 */
import { expect, type Page, test } from "@playwright/test";
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
    setProp(ids: string[], prop: string, value: unknown, label: string): void;
    zoomTo(z: number): void;
    doc: { get(id: string): { props: Record<string, unknown> } | undefined };
  };
};

const properties = (page: Page) => page.getByRole("group", { name: "Properties" });
const button = (page: Page) => properties(page).getByRole("button", { name: /^Type settings/ });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Type settings" });
const prop = (page: Page, id: string, name: string) =>
  page.evaluate(([id, name]) => (window as unknown as W).drawpane.doc.get(id)?.props[name], [
    id,
    name,
  ] as const);

test.describe
  .serial("Type settings", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let id: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8889, inspectorPort: 9429 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      id = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const t = e.createLayer("text", { x: 40, y: 40, width: 10, height: 10 }, e.s.pageId, {
          characters: "Quarterly report",
          fontSize: 24,
        }) as string;
        e.zoomTo(1);
        e.select([t]);
        return t;
      });
      await expect(button(page)).toBeVisible();
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("keeps the less used settings out of the Text section until asked for", async () => {
      await expect(properties(page).getByRole("radiogroup", { name: "Decoration" })).toHaveCount(0);
      await expect(properties(page).getByLabel("Paragraph spacing")).toHaveCount(0);
      await expect(button(page)).toHaveAccessibleName("Type settings");
    });

    test("opens from the keyboard on its tab, moves between tabs with arrows, and closes back to its button", async () => {
      await button(page).focus();
      await page.keyboard.press("Enter");
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).getByRole("tab", { name: "Basics" })).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(dialog(page).getByRole("tab", { name: "Details" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByRole("tabpanel", { name: "Details" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      await expect(button(page)).toBeFocused();
    });

    test("opens on the tab last shown, sets decoration, and marks its button", async () => {
      await button(page).click();
      await expect(page.getByRole("tabpanel", { name: "Details" })).toBeVisible();
      await dialog(page).getByRole("tab", { name: "Basics" }).click();
      await dialog(page).getByRole("radio", { name: "Underline" }).click();
      await expect.poll(() => prop(page, id, "textDecoration")).toBe("underline");
      await dialog(page).getByRole("radio", { name: "Cap height to baseline" }).click();
      await expect.poll(() => prop(page, id, "leadingTrim")).toBe("cap-height");
      await page.keyboard.press("Escape");
      await expect(button(page)).toHaveAccessibleName("Type settings: Underline, Cap height trim");
      await expect(button(page)).toHaveAttribute("data-set", "true");
    });

    test("offers Variable only for a font that varies", async () => {
      await page.evaluate((id) => {
        const e = (window as unknown as W).drawpane;
        e.setProp([id], "fontFamily", "Georgia", "Font");
      }, id);
      await button(page).click();
      await expect(dialog(page).getByRole("tab", { name: "Variable" })).toBeDisabled();
      await page.keyboard.press("Escape");
    });
  });
