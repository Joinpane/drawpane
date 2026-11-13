/**
 * Grid layout and wrap in a real browser, on a throwaway instance: switching
 * a frame of loose cards to a grid, editing its tracks, spanning and
 * dragging an item between cells, ⌥⇧A, and wrapping a row.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Node = { parent: string; type: string; props: Record<string, unknown> };
type Debug = {
  s: {
    pageId: string;
    selection: string[];
    camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } };
  };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  zoomTo(z: number): void;
  doc: { get(id: string): Node | undefined; childIds(id: string): string[] };
  scene: { bounds(id: string): { x: number; y: number; width: number; height: number } | null };
};

type W = { drawpane: Debug };

const props = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.props ?? {}, id);
const select = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as W).drawpane.select([id]), id);
const toScreen = (page: Page, p: { x: number; y: number }) =>
  page.evaluate((p) => (window as unknown as W).drawpane.s.camera.toScreen(p), p);
const panel = (page: Page) => page.getByRole("group", { name: "Properties" });

test.describe
  .serial("Grid layout", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let frame: string;
    let cards: string[];

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8791, inspectorPort: 9331 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      [frame, ...cards] = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const p = e.s.pageId;
        const f = e.createLayer("frame", { x: 0, y: 0, width: 420, height: 300 }, p, {
          name: "Dashboard",
        }) as string;
        const at = (name: string, x: number, y: number) =>
          e.createLayer("rect", { x, y, width: 120, height: 80 }, f, { name }) as string;
        const ids = [at("A", 20, 20), at("B", 160, 24), at("C", 20, 140), at("D", 164, 136)];
        e.zoomTo(1);
        e.select([f]);
        return [f, ...ids];
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("turns loose cards into the grid they form", async () => {
      await page.keyboard.press("Alt+Shift+a");
      await expect.poll(async () => (await props(page, frame)).layoutMode).toBe("grid");
      expect((await props(page, frame)).gridColumns).toEqual([
        { unit: "fr", value: 1 },
        { unit: "fr", value: 1 },
      ]);
      // The inspector lists both axes; the canvas lays the cards out in cells.
      await expect(panel(page).getByRole("group", { name: "Columns" })).toContainText(
        "Columns · 2",
      );
      await expect(panel(page).getByRole("group", { name: "Rows" })).toContainText("Rows · 2");
      const [a, b] = await Promise.all([
        props(page, cards[0] as string),
        props(page, cards[1] as string),
      ]);
      expect(a.y).toBe(b.y);
    });

    test("adds a column and fixes the first one's width", async () => {
      const columns = panel(page).getByRole("group", { name: "Columns" });
      await columns.getByRole("button", { name: "Add column" }).click();
      await expect
        .poll(async () => ((await props(page, frame)).gridColumns as unknown[]).length)
        .toBe(3);
      // Switching to px keeps the width it has now, then we type a new one.
      await columns.getByLabel("Column 1 unit").selectOption("px");
      await expect
        .poll(
          async () => ((await props(page, frame)).gridColumns as Array<{ unit: string }>)[0]?.unit,
        )
        .toBe("px");
      await columns.getByLabel("Column 1 size").fill("160");
      await columns.getByLabel("Column 1 size").press("Enter");
      await expect
        .poll(async () => ((await props(page, frame)).gridColumns as unknown[])[0])
        .toEqual({ unit: "px", value: 160 });
    });

    test("spans an item across columns from the inspector", async () => {
      await select(page, cards[0] as string);
      await expect(panel(page).getByRole("heading", { name: "A · grid item" })).toBeVisible();
      await panel(page).getByLabel("Column span").fill("3");
      await panel(page).getByLabel("Column span").press("Enter");
      await expect
        .poll(async () => (await props(page, cards[0] as string)).gridArea)
        .toEqual({ column: 1, row: 1, columnSpan: 3, rowSpan: 1 });
      await panel(page).getByRole("button", { name: "Place automatically" }).click();
      await expect
        .poll(async () => (await props(page, cards[0] as string)).gridArea ?? null)
        .toBeNull();
    });

    test("drags an item into another cell", async () => {
      const id = cards[3] as string;
      await select(page, id);
      const b = await page.evaluate((id) => (window as unknown as W).drawpane.scene.bounds(id), id);
      if (!b) throw new Error("no bounds");
      const from = await toScreen(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
      // Row one, column three: right of the frame's middle, near its top.
      const to = await toScreen(page, { x: 380, y: 40 });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(async () => (await props(page, id)).gridArea)
        .toEqual({ column: 3, row: 1, columnSpan: 1, rowSpan: 1 });
    });

    test("⌥⇧A frames loose layers in a grid", async () => {
      const ids = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const p = e.s.pageId;
        const a = e.createLayer("rect", { x: 600, y: 0, width: 60, height: 60 }, p) as string;
        const b = e.createLayer("rect", { x: 680, y: 0, width: 60, height: 60 }, p) as string;
        e.select([a, b]);
        return [a, b];
      });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Alt+Shift+a");
      await expect
        .poll(async () =>
          page.evaluate((id) => {
            const doc = (window as unknown as W).drawpane.doc;
            return doc.get(doc.get(id)?.parent ?? "")?.props.layoutMode;
          }, ids[0] as string),
        )
        .toBe("grid");
    });

    test("wraps a row onto new lines", async () => {
      const row = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const p = e.s.pageId;
        const r = e.createLayer("frame", { x: 0, y: 400, width: 260, height: 200 }, p, {
          gap: 10,
        }) as string;
        for (let i = 0; i < 3; i++)
          e.createLayer("rect", { x: i * 110, y: 0, width: 100, height: 40 }, r);
        e.select([r]);
        return r;
      });
      // Add auto layout from the inspector: a row, since the frame is wider than tall.
      await panel(page).getByRole("button", { name: "Add auto layout" }).click();
      await expect(panel(page).getByRole("radio", { name: "Horizontal" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await panel(page).getByRole("button", { name: "Wrap" }).click();
      await panel(page).getByLabel("Gap between lines").fill("16");
      await panel(page).getByLabel("Gap between lines").press("Enter");
      const third = await page.evaluate(
        (id) => (window as unknown as W).drawpane.doc.childIds(id)[2] as string,
        row,
      );
      await expect.poll(async () => (await props(page, third)).y).toBe(56);
    });
  });
