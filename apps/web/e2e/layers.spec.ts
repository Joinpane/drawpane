/**
 * The layers panel in a real browser, on a throwaway instance: finding
 * layers with ⌘F and filters, selecting what was found, folding the tree
 * with ⌥-click and ⌥L, locking from a row, duplicating with ⌥-drag, and
 * dragging a layer out of its groups to the level the pointer is at (even
 * the last layer in a frame, over its own row), and into the empty space
 * below the list.
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

    test("moves focus with the selection from the keyboard", async () => {
      const rows = tree(page).getByRole("treeitem");
      await rows.first().click();
      const where = () =>
        page.evaluate((all) => {
          const doc = (window as unknown as W).drawpane.doc;
          return all.map((id) => [doc.get(id)?.props.x, doc.get(id)?.props.y]);
        }, Object.values(ids));
      const before = await where();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      const focused = await page.evaluate(() =>
        document.activeElement?.getAttribute("data-layer-id"),
      );
      const selected = await selection(page);
      expect(focused).toBe(selected[0]);
      // The arrows walk the list; they don't also nudge layers on the canvas.
      expect(await where()).toEqual(before);
      // And End lands focus on the last row.
      await page.keyboard.press("End");
      await expect(rows.last()).toBeFocused();
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

    test("drags a layer out below the last row, to the level the pointer is at", async () => {
      const source = row(page, "Title");
      // The last row in the panel: the bottom Event row, two levels into Home.
      const last = row(page, "Event row").last();
      const box = await last.boundingBox();
      if (!box) throw new Error("no row");
      const below = box.y + box.height * 0.85;
      await source.hover();
      await page.mouse.down();
      // One level in: below Event list, still inside Home.
      await page.mouse.move(box.x + 4 + 12 + 8, below, { steps: 4 });
      await page.mouse.move(box.x + 4 + 12 + 9, below);
      await expect(
        page.getByRole("status").filter({ hasText: "moving below Event list in Home" }),
      ).toBeVisible();
      // All the way left: below Home, on the page.
      await page.mouse.move(box.x + 2, below, { steps: 4 });
      await page.mouse.move(box.x + 3, below);
      await expect(page.getByRole("status").filter({ hasText: "moving below Home" })).toBeVisible();
      await expect(last).toHaveClass(/layers__row--drop-line-after/);
      await page.mouse.up();
      await expect
        .poll(() =>
          page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.parent, ids.title),
        )
        .toBe(await page.evaluate(() => (window as unknown as W).drawpane.s.pageId));
      // Below Home in the list: under it in the page's stack.
      const order = await page.evaluate(
        (p) => (window as unknown as W).drawpane.doc.childIds(p),
        await page.evaluate(() => (window as unknown as W).drawpane.s.pageId),
      );
      expect(order.indexOf(ids.title)).toBe(order.indexOf(ids.home) - 1);
    });
    test("drags the last layer in a frame out of it, over its own row", async () => {
      // A phone screen holding an auto layout row whose last layer is a screenshot.
      const made = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const phone = e.createLayer(
          "frame",
          { x: 600, y: 0, width: 402, height: 874 },
          e.s.pageId,
          {
            name: "Phone",
          },
        ) as string;
        const strip = e.createLayer("frame", { x: 620, y: 40, width: 300, height: 80 }, phone, {
          name: "Strip",
          layoutMode: "row",
        }) as string;
        const shot = e.createLayer("rect", { x: 0, y: 0, width: 60, height: 60 }, strip, {
          name: "Shot",
        }) as string;
        const label = e.createLayer("text", { x: 0, y: 0, width: 60, height: 20 }, strip, {
          name: "Label",
          characters: "Label",
        }) as string;
        return { phone, strip, shot, label };
      });
      ids.label = made.label;
      // Label isn't last (Shot is below it): over its own row it has nowhere to go.
      const label = row(page, "Label");
      const labelBox = await label.boundingBox();
      if (!labelBox) throw new Error("no row");
      await label.hover();
      await page.mouse.down();
      await page.mouse.move(labelBox.x + 6, labelBox.y + labelBox.height / 2, { steps: 4 });
      await page.mouse.move(labelBox.x + 5, labelBox.y + labelBox.height / 2);
      await expect(page.getByRole("status").filter({ hasText: /moving/ })).toHaveCount(0);
      await page.mouse.up();

      const shot = row(page, "Shot");
      const box = await shot.boundingBox();
      if (!box) throw new Error("no row");
      await shot.hover();
      await page.mouse.down();
      // Left by one level, still over its own row: below Strip, in Phone.
      await page.mouse.move(box.x + 4 + 12 + 8, box.y + box.height / 2, { steps: 4 });
      await page.mouse.move(box.x + 4 + 12 + 9, box.y + box.height / 2);
      await expect(
        page.getByRole("status").filter({ hasText: "moving below Strip in Phone" }),
      ).toBeVisible();
      await expect(shot).toHaveClass(/layers__row--drop-line-after/);
      await page.mouse.up();
      await expect
        .poll(() =>
          page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.parent, made.shot),
        )
        .toBe(made.phone);
      const order = await page.evaluate(
        (id) => (window as unknown as W).drawpane.doc.childIds(id),
        made.phone,
      );
      // Below Strip in the list: under it in Phone's stack.
      expect(order).toEqual([made.shot, made.strip]);
    });

    test("drops into the empty space below the list, at the level the pointer is at", async () => {
      const label = row(page, "Label");
      const scroll = await tree(page).boundingBox();
      const lastBox = await tree(page).getByRole("treeitem").last().boundingBox();
      if (!scroll || !lastBox) throw new Error("no tree");
      const empty = lastBox.y + lastBox.height + 40;
      expect(empty).toBeLessThan(scroll.y + scroll.height);
      await label.hover();
      await page.mouse.down();
      await page.mouse.move(lastBox.x + 3, empty, { steps: 4 });
      await page.mouse.move(lastBox.x + 2, empty);
      await expect(page.getByRole("status").filter({ hasText: /moving below/ })).toBeVisible();
      await page.mouse.up();
      const pageId = await page.evaluate(() => (window as unknown as W).drawpane.s.pageId);
      const labelId = ids.label as string;
      await expect
        .poll(() =>
          page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.parent, labelId),
        )
        .toBe(pageId);
      // At the very bottom of the page's stack.
      const order = await page.evaluate(
        (p) => (window as unknown as W).drawpane.doc.childIds(p),
        pageId,
      );
      expect(order[0]).toBe(labelId);
    });
  });
