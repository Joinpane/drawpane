/**
 * Variable modes on frames, as Figma sets them: Appearance's "Apply variable
 * mode" picks a collection's mode for the selected frames, a row then shows it
 * with a way to stop, the frame's contents resolve in that mode, and the layers
 * panel tags the frame with it.
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
    createCollection(name: string): string | null;
    addMode(collection: string, name: string): string | null;
    createVariable(collection: string, name: string, type: string, value: unknown): string | null;
    setVariableValue(variable: string, mode: string, value: unknown): void;
    bindVariable(ids: string[], key: string, variable: string): void;
    select(ids: string[]): void;
    zoomTo(z: number): void;
    doc: { get(id: string): { props: Record<string, unknown> } | undefined };
  };
};

const properties = (page: Page) => page.getByRole("group", { name: "Properties" });
const fillOf = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      ((window as unknown as W).drawpane.doc.get(id)?.props.fills as Array<{ color: string }>)?.[0]
        ?.color,
    id,
  );

test.describe
  .serial("Variable modes", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let ids: { board: string; card: string };

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8999, inspectorPort: 9539 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      ids = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const theme = e.createCollection("Theme") as string;
        const dark = e.addMode(theme, "Dark") as string;
        const surface = e.createVariable(theme, "surface", "color", "#ffffff") as string;
        e.setVariableValue(surface, dark, "#1c1b1a");
        const board = e.createLayer(
          "frame",
          { x: 40, y: 40, width: 240, height: 160 },
          e.s.pageId,
          {
            name: "Player",
          },
        ) as string;
        const card = e.createLayer("rect", { x: 20, y: 20, width: 120, height: 80 }, board, {
          name: "Card",
        }) as string;
        e.bindVariable([card], "fill", surface);
        e.zoomTo(1);
        e.select([board]);
        return { board, card };
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("applies a mode from Appearance; the frame's contents and its layer tag follow", async () => {
      expect(await fillOf(page, ids.card)).toBe("#ffffff");
      // Nothing set yet: no row, only the button.
      await expect(properties(page).getByRole("combobox", { name: "Theme mode" })).toHaveCount(0);
      await properties(page).getByRole("button", { name: "Apply variable mode" }).click();
      const menu = page.getByRole("menu", { name: "Variable modes" });
      await menu.getByRole("menuitemcheckbox", { name: "Dark" }).click();

      await expect(properties(page).getByRole("combobox", { name: "Theme mode" })).toHaveValue(
        /.+/,
      );
      await expect.poll(() => fillOf(page, ids.card)).toBe("#1c1b1a");
      const row = page.locator(`[data-layer-id="${ids.board}"]`);
      await expect(row.locator(".dp-layer__badge")).toHaveText(/^Dark/);
      await expect(row.locator(".dp-layer__badge")).toHaveAttribute(
        "title",
        "Variable mode: Theme: Dark",
      );
    });

    test("stopping the mode takes the frame back to what it inherits", async () => {
      await properties(page).getByRole("button", { name: "Stop using a Theme mode" }).click();
      await expect.poll(() => fillOf(page, ids.card)).toBe("#ffffff");
      await expect(properties(page).getByRole("combobox", { name: "Theme mode" })).toHaveCount(0);
      await expect(page.locator(`[data-layer-id="${ids.board}"] .dp-layer__badge`)).toHaveCount(0);
    });
  });
