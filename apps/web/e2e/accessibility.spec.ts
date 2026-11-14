/**
 * Accessibility at selection, in a real browser: a tapped icon on a phone
 * board that's smaller than 44 × 44 says so in the inspector, and "Grow"
 * fixes it around its centre (one undo puts it back).
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: { pageId: string };
  createLayer(t: string, r: object, parent: string, props?: object): string;
  select(ids: string[]): void;
  zoomToFit(): void;
  doc: { get(id: string): { props: Record<string, unknown> } };
};
type W = { drawpane: Debug };

test.describe
  .serial("Tap targets", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let icon: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8843, inspectorPort: 9383 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      icon = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const board = e.createLayer("frame", { x: 0, y: 0, width: 393, height: 852 }, e.s.pageId, {
          name: "Home",
          fills: [{ type: "solid", color: "#ffffff" }],
        });
        const id = e.createLayer("rect", { x: 40, y: 790, width: 22, height: 22 }, board, {
          name: "Close",
          reactions: [
            {
              id: "tapback000000000",
              trigger: { type: "tap" },
              action: { type: "back" },
              transition: {
                type: "dissolve",
                direction: "left",
                duration: 240,
                easing: { type: "ease-out" },
              },
            },
          ],
        });
        e.select([id]);
        e.zoomToFit();
        return id;
      });
    });
    test.afterAll(() => instance?.stop());

    test("warns about a tapped icon smaller than 44 × 44, and grows it around its centre", async () => {
      const section = page.getByRole("region", { name: "Accessibility" });
      await expect(section).toContainText("Tapped, but 22 × 22");
      await section.getByRole("button", { name: "Grow to 44 × 44" }).click();
      await expect(section).toHaveCount(0);
      const size = await page.evaluate((id) => {
        const p = (window as unknown as W).drawpane.doc.get(id).props;
        return [p.x, p.y, p.width, p.height];
      }, icon);
      expect(size).toEqual([29, 779, 44, 44]);
      // One undo, and it's back.
      await page.keyboard.press("ControlOrMeta+z");
      await expect(section).toContainText("Tapped, but 22 × 22");
    });
  });
