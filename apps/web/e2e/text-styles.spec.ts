/**
 * Text styles in a real browser, on a throwaway instance: making a style
 * from a text layer, applying it from the picker, editing it so every layer
 * follows, ⌘B detaching a layer, ⌥⌘T, and the contrast note on the fill.
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
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
};
type W = { drawpane: Debug };

const props = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.props ?? {}, id);
const select = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as W).drawpane.select([id]), id);
const panel = (page: Page) => page.getByRole("group", { name: "Properties" });
const picker = (page: Page) => page.getByRole("dialog", { name: "Text styles" });

test.describe
  .serial("Text styles", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let title: string;
    let subtitle: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8811, inspectorPort: 9351 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      [title, subtitle] = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const card = e.createLayer("frame", { x: 0, y: 0, width: 400, height: 300 }, e.s.pageId, {
          name: "Card",
          fills: [{ type: "solid", color: "#ffffff" }],
        }) as string;
        const t = e.createLayer("text", { x: 20, y: 20, width: 10, height: 10 }, card, {
          characters: "Plan your week",
          fontSize: 28,
          fontWeight: 600,
        }) as string;
        const s = e.createLayer("text", { x: 20, y: 80, width: 10, height: 10 }, card, {
          characters: "Three things on today",
        }) as string;
        e.select([t]);
        return [t, s];
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("makes a style from a text layer", async () => {
      await panel(page).getByRole("button", { name: "Text style: None" }).click();
      await expect(picker(page)).toContainText("No text styles yet");
      await picker(page).getByRole("button", { name: "Create style" }).click();
      const name = picker(page).getByLabel("Name");
      await expect(name).toHaveValue("Text 28");
      await name.fill("heading/xl");
      await name.press("Enter");
      await expect(picker(page)).toBeHidden();
      await expect(
        panel(page).getByRole("button", { name: "Text style: heading/xl" }),
      ).toBeVisible();
      expect((await props(page, title)).textStyle).toBeTruthy();
    });

    test("applies it to another layer from the picker", async () => {
      await select(page, subtitle);
      await panel(page).getByRole("button", { name: "Text style: None" }).click();
      const group = picker(page).getByRole("group", { name: "heading" });
      const row = group.getByRole("option", { name: /xl/ });
      await expect(row).toContainText("28 / Auto · Semibold");
      await expect(row).toContainText("1 use");
      await row.click();
      await expect.poll(async () => (await props(page, subtitle)).fontSize).toBe(28);
      expect((await props(page, subtitle)).fontWeight).toBe(600);
    });

    test("edits the style, and every layer follows", async () => {
      await panel(page).getByRole("button", { name: "Text style: heading/xl" }).click();
      const row = picker(page).getByRole("option", { name: /xl/ });
      await row.hover();
      await row.getByRole("button", { name: "Edit heading/xl" }).click();
      await expect(picker(page)).toContainText("2 uses");
      const size = picker(page).getByLabel("Font size");
      await size.fill("40");
      await size.press("Enter");
      await expect.poll(async () => (await props(page, title)).fontSize).toBe(40);
      expect((await props(page, subtitle)).fontSize).toBe(40);
      await page.keyboard.press("Escape");
      await expect(picker(page)).toBeHidden();
    });

    test("⌘B detaches a layer, and ⌥⌘T opens the picker", async () => {
      await select(page, subtitle);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("ControlOrMeta+b");
      // Back to regular, which is the default, so it's stored as absent.
      await expect.poll(async () => (await props(page, subtitle)).fontWeight ?? 400).toBe(400);
      expect((await props(page, subtitle)).textStyle ?? null).toBeNull();
      await expect(panel(page).getByRole("button", { name: "Text style: None" })).toBeVisible();

      await page.keyboard.press("ControlOrMeta+Alt+t");
      await expect(picker(page)).toBeVisible();
      await page.keyboard.press("Escape");
    });

    test("rates the text's contrast against its card", async () => {
      await select(page, title);
      // The default text colour (#1C1B1A) on the white card.
      await expect(panel(page).locator(".contrast-note")).toContainText("17.2:1 on #FFFFFF");
      await expect(panel(page).locator(".contrast-note")).toContainText("AAA");
    });
  });
