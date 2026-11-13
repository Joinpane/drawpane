/**
 * The layers panel in a real browser, on a throwaway instance: finding
 * layers with ⌘F and filters, selecting what was found, folding the tree
 * with ⌥-click and ⌥L, locking from a row, and duplicating with ⌥-drag.
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
  doc: {
    get(id: string): { parent: string; props: Record<string, unknown> } | undefined;
    childIds(id: string): string[];
  };
};
type W = { drawpane: Debug };

const tree = (page: Page) => page.getByRole("tree", { name: "Layers" });
const row = (page: Page, name: string | RegExp) =>
  tree(page).getByRole("treeitem", {
    name: typeof name === "string" ? new RegExp(`^${name}`) : name,
  });
const selection = (page: Page) =>
  page.evaluate(() => (window as unknown as W).drawpane.s.selection);

test.describe
  .serial("Layers panel", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let ids: Record<string, string>;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8805, inspectorPort: 9345 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      ids = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const p = e.s.pageId;
        const home = e.createLayer("frame", { x: 0, y: 0, width: 400, height: 600 }, p, {
          name: "Home",
        }) as string;
        const list = e.createLayer("frame", { x: 20, y: 100, width: 360, height: 300 }, home, {
          name: "Event list",
        }) as string;
        const rowA = e.createLayer("text", { x: 40, y: 120, width: 100, height: 20 }, list, {
          name: "Event row",
          characters: "Standup",
        }) as string;
        const rowB = e.createLayer("text", { x: 40, y: 160, width: 100, height: 20 }, list, {
          name: "Event row",
          characters: "Review",
        }) as string;
        const title = e.createLayer("text", { x: 20, y: 20, width: 200, height: 40 }, home, {
          name: "Title",
          characters: "Today",
        }) as string;
        const other = e.createLayer("frame", { x: 500, y: 0, width: 400, height: 600 }, p, {
          name: "Settings",
        }) as string;
        e.select([]);
        return { home, list, rowA, rowB, title, other };
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("⌘F finds layers by name, inside folded frames, and selects them all", async () => {
      // Fold the tree first: results still show, under their frames.
      await page.locator(".canvas__overlay").click({ position: { x: 700, y: 760 } });
      await page.keyboard.press("Alt+l");
      await expect(row(page, "Event row")).toHaveCount(0);

      await page.keyboard.press("ControlOrMeta+f");
      const field = page.getByRole("searchbox", { name: "Find layers" });
      await expect(field).toBeFocused();
      await field.fill("event row");
      await expect(page.getByText("2 found")).toBeVisible();
      await expect(row(page, "Event row")).toHaveCount(2);
      // The frames above them stay, muted, to show where they are.
      await expect(row(page, "Home")).toHaveClass(/is-context/);
      await expect(row(page, "Settings")).toHaveCount(0);
      await expect(row(page, "Event row").first().locator("mark")).toHaveText("Event row");

      await field.press("Enter");
      expect((await selection(page)).sort()).toEqual([ids.rowA, ids.rowB].sort());
    });

    test("filters by kind, and Esc puts the tree back", async () => {
      const field = page.getByRole("searchbox", { name: "Find layers" });
      await field.fill("");
      await page.getByRole("radio", { name: "Text" }).click();
      await expect(page.getByText("3 found")).toBeVisible();
      await page.getByRole("radio", { name: "Frames" }).click();
      await expect(page.getByText("3 found")).toBeVisible();
      await expect(field).toBeFocused();
      await field.press("Escape");
      await expect(field).toBeHidden();
      await expect(row(page, "Settings")).toBeVisible();
    });

    test("⌥-click on a caret opens everything inside", async () => {
      await page.keyboard.press("Alt+l");
      await expect(row(page, "Event list")).toHaveCount(0);
      await row(page, "Home")
        .locator(".dp-layer__caret")
        .click({ modifiers: ["Alt"] });
      await expect(row(page, "Event list")).toBeVisible();
      await expect(row(page, "Event row")).toHaveCount(2);
    });

    test("locks a layer from its row, and unlocks it again", async () => {
      const title = row(page, "Title");
      await title.hover();
      await title.getByRole("button", { name: "Lock layer" }).click();
      await expect
        .poll(() =>
          page.evaluate(
            (id) => (window as unknown as W).drawpane.doc.get(id)?.props.locked,
            ids.title,
          ),
        )
        .toBe(true);
      await title.getByRole("button", { name: "Unlock layer" }).click();
      await expect
        .poll(() =>
          page.evaluate(
            (id) => (window as unknown as W).drawpane.doc.get(id)?.props.locked ?? false,
            ids.title,
          ),
        )
        .toBe(false);
    });

    test("drags a layer into another frame, saying where it goes", async () => {
      const source = row(page, "Title");
      const target = row(page, "Settings");
      // Native drag and drop: press on the source, then move over the target twice.
      await source.hover();
      await page.mouse.down();
      await target.hover();
      await target.hover();
      await expect(
        page.getByRole("status").filter({ hasText: "moving into Settings" }),
      ).toBeVisible();
      await page.mouse.up();
      await expect
        .poll(() =>
          page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.parent, ids.title),
        )
        .toBe(ids.other);
    });
  });
