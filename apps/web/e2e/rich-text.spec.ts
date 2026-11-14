/**
 * Rich text in a real browser, on a throwaway instance: selecting characters
 * while typing and styling just those (⌘B, the inspector's size and fill),
 * typing on after a styled word, dragging a selection with the mouse, and
 * the inspector reading "Mixed" for the layer afterwards.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: {
    pageId: string;
    editingText: string | null;
    textSelection: { start: number; end: number } | null;
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
  startTextEdit(id: string): void;
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
};
type W = { drawpane: Debug };

const props = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.props ?? {}, id);
const panel = (page: Page) => page.getByRole("group", { name: "Properties" });
const editing = (page: Page) => page.getByRole("textbox", { name: "Text", exact: true });

test.describe
  .serial("Rich text", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let id: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8815, inspectorPort: 9355 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      id = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const t = e.createLayer("text", { x: 40, y: 40, width: 10, height: 10 }, e.s.pageId, {
          characters: "Plan your week",
          fontSize: 32,
        }) as string;
        e.zoomTo(1);
        e.select([t]);
        e.startTextEdit(t);
        return t;
      });
      await expect(editing(page)).toBeFocused();
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("bolds the selected word with ⌘B, leaving the rest", async () => {
      await page.keyboard.press("Home");
      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
      for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
      await expect
        .poll(() => page.evaluate(() => (window as unknown as W).drawpane.s.textSelection))
        .toEqual({ start: 5, end: 9 });
      // The selection is drawn from the canvas's layout.
      await expect(page.locator(".canvas__text-selection")).toHaveCount(1);
      await page.keyboard.press("ControlOrMeta+b");
      await expect
        .poll(async () => (await props(page, id)).textRuns)
        .toEqual([{ start: 5, end: 9, fontWeight: 700 }]);
      expect((await props(page, id)).fontWeight ?? 400).toBe(400);
      // The inspector shows the selected characters.
      await expect(panel(page).getByLabel("Weight")).toHaveValue("700");
    });

    test("sizes and colours just the selection from the inspector", async () => {
      const size = panel(page).getByLabel("Font size");
      await size.fill("40");
      await size.press("Enter");
      await expect
        .poll(async () => (await props(page, id)).textRuns)
        .toEqual([{ start: 5, end: 9, fontWeight: 700, fontSize: 40 }]);
      expect((await props(page, id)).fontSize).toBe(32);

      const hex = panel(page).getByLabel("Fill hex");
      await hex.fill("E8590C");
      await hex.press("Enter");
      await expect
        .poll(async () => (await props(page, id)).textRuns)
        .toEqual([
          {
            start: 5,
            end: 9,
            fontWeight: 700,
            fontSize: 40,
            fills: [{ type: "solid", color: "#e8590c" }],
          },
        ]);
      // The layer's own fill stays.
      expect(JSON.stringify((await props(page, id)).fills)).not.toContain("e8590c");
    });

    test("types on after the styled word in the layer's own style", async () => {
      await editing(page).focus();
      await page.keyboard.press("End");
      await page.keyboard.type(" ahead");
      await expect
        .poll(async () => (await props(page, id)).characters)
        .toBe("Plan your week ahead");
      expect((await props(page, id)).textRuns).toEqual([
        {
          start: 5,
          end: 9,
          fontWeight: 700,
          fontSize: 40,
          fills: [{ type: "solid", color: "#e8590c" }],
        },
      ]);
    });

    test("selects by dragging across the text", async () => {
      const [from, to] = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const canvas = document.querySelector(".canvas__layer")?.getBoundingClientRect();
        const a = e.s.camera.toScreen({ x: 41, y: 60 });
        const b = e.s.camera.toScreen({ x: 120, y: 60 });
        return [
          { x: a.x + (canvas?.left ?? 0), y: a.y + (canvas?.top ?? 0) },
          { x: b.x + (canvas?.left ?? 0), y: b.y + (canvas?.top ?? 0) },
        ];
      });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 5 });
      await page.mouse.up();
      const sel = await page.evaluate(() => (window as unknown as W).drawpane.s.textSelection);
      expect(sel?.start).toBe(0);
      expect(sel?.end ?? 0).toBeGreaterThan(2);
    });

    test("selects a word with a double-click, and the line with a triple-click", async () => {
      const at = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const canvas = document.querySelector(".canvas__layer")?.getBoundingClientRect();
        const p = e.s.camera.toScreen({ x: 120, y: 60 });
        return { x: p.x + (canvas?.left ?? 0), y: p.y + (canvas?.top ?? 0) };
      });
      const selected = async () => {
        const sel = await page.evaluate(() => (window as unknown as W).drawpane.s.textSelection);
        return "Plan your week".slice(sel?.start ?? 0, sel?.end ?? 0);
      };
      await page.mouse.dblclick(at.x, at.y);
      // A whole word, nothing more.
      expect(["Plan", "your", "week"]).toContain(await selected());
      await page.mouse.click(at.x, at.y, { clickCount: 3 });
      expect(await selected()).toBe("Plan your week");
    });

    test("Escape after the colour picker finishes editing, keeping the layer selected", async () => {
      // Select one plain word ("ahead", near the end), so the inspector has one fill to edit.
      const word = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const canvas = document.querySelector(".canvas__layer")?.getBoundingClientRect();
        const p = e.s.camera.toScreen({ x: 340, y: 60 });
        return { x: p.x + (canvas?.left ?? 0), y: p.y + (canvas?.top ?? 0) };
      });
      await page.mouse.dblclick(word.x, word.y);
      await panel(page)
        .getByRole("button", { name: /^Edit fill/ })
        .first()
        .click();
      await expect(page.getByRole("dialog", { name: /fill/i })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: /fill/i })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect
        .poll(() => page.evaluate(() => (window as unknown as W).drawpane.s.editingText))
        .toBeNull();
      expect(await page.evaluate(() => (window as unknown as W).drawpane.s.selection)).toEqual([
        id,
      ]);
      // Back to the canvas: R is the rectangle tool again, not a letter typed somewhere.
      await page.keyboard.press("r");
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { drawpane: { s: { tool: string } } }).drawpane.s.tool,
          ),
        )
        .toBe("rect");
      await page.keyboard.press("v");
      await page.evaluate((id) => (window as unknown as W).drawpane.startTextEdit(id), id);
      await expect(editing(page)).toBeFocused();
    });

    test("reads Mixed for the layer once editing ends", async () => {
      await page.keyboard.press("Escape");
      await expect
        .poll(() => page.evaluate(() => (window as unknown as W).drawpane.s.editingText))
        .toBeNull();
      await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), id);
      await expect(panel(page).getByLabel("Font size")).toHaveValue("");
      await expect(panel(page).getByLabel("Font size")).toHaveAttribute("placeholder", "Mixed");
    });
  });
