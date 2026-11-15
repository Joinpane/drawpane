/**
 * The chrome fits a small laptop window (1024 × 768): the dashboard header
 * doesn't push the page sideways, and the editor's top bar (file title, tools,
 * people and Share) never overlaps.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error("Not on screen.");
  return b;
};
/** The debug handle (drawpane:debug), as far as these tests use it. */
type W = {
  drawpane: { s: { pageId: string }; state: { set(patch: { peers: Map<string, unknown> }): void } };
};
const scrollWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);

test.describe
  .serial("At 1024 wide", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8831, inspectorPort: 9371 });
      page = instance.page;
      await page.setViewportSize({ width: 1024, height: 768 });
    });
    test.afterAll(() => instance?.stop());

    test("the dashboard header fits on one line, its actions still named", async () => {
      await page.goto(instance.url);
      const header = page.locator(".dash__header");
      await expect(header).toBeVisible();
      expect(await scrollWidth(page)).toBeLessThanOrEqual(1024);
      // The title stays whole: on one line, not cut short.
      const title = page.getByRole("heading", { level: 1 });
      expect((await box(title)).height).toBeLessThan(32);
      expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      for (const name of ["Templates", "Import", "New file"]) {
        const button = header.getByRole("button", { name, exact: true });
        await expect(button).toBeVisible();
        const b = await box(button);
        expect(b.x + b.width).toBeLessThanOrEqual(1024);
      }
      await page.screenshot({ path: "test-results/fit-dashboard-1024.png" });
    });

    test("the editor's top bar doesn't overlap", async () => {
      await page.getByRole("button", { name: "New file", exact: true }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      const title = await box(page.locator(".file-title"));
      const tools = await box(page.locator(".toolbar"));
      const right = await box(page.locator(".top-right"));
      expect(tools.x).toBeGreaterThanOrEqual(title.x + title.width + 8);
      expect(right.x).toBeGreaterThanOrEqual(tools.x + tools.width + 8);
      expect(await scrollWidth(page)).toBeLessThanOrEqual(1024);
      await page.screenshot({ path: "test-results/fit-editor-1024.png" });
    });

    test("the tools stay clear of the people and Share, panel open or closed", async () => {
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.reload();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      // Three people in the file widen the right side.
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const pageId = e.s.pageId;
        const person = (id: string, name: string, color: number) =>
          [
            id,
            {
              sessionId: id,
              userId: id,
              name,
              color,
              kind: "person",
              presence: {
                cursor: null,
                pageId,
                selection: [],
                viewport: null,
                following: null,
                spotlight: false,
              },
            },
          ] as const;
        e.state.set({
          peers: new Map([
            person("bo", "Bo Chen", 3),
            person("sam", "Sam Okafor", 6),
            person("lena", "Lena Park", 2),
          ]),
        });
      });
      await expect(page.locator(".top-right .dp-avatar")).toHaveCount(3);
      const layers = page.getByRole("complementary", { name: /Pages, layers/ });
      for (const width of [1024, 1280, 1440]) {
        await page.setViewportSize({ width, height: 768 });
        for (const panel of ["open", "closed"]) {
          if ((panel === "open") !== (await layers.isVisible())) {
            await page.keyboard.press("ControlOrMeta+\\");
          }
          await expect(layers).toBeVisible({ visible: panel === "open" });
          const title = await box(page.locator(".file-title"));
          const tools = await box(page.locator(".toolbar"));
          const right = await box(page.locator(".top-right"));
          const where = `${width} wide, layers ${panel}`;
          expect(tools.x, where).toBeGreaterThanOrEqual(title.x + title.width + 8);
          expect(right.x, where).toBeGreaterThanOrEqual(tools.x + tools.width + 8);
          // With room on both sides, the tools sit in the window's centre.
          if (width >= 1280)
            expect(Math.abs(tools.x + tools.width / 2 - width / 2), where).toBeLessThan(2);
          expect(await scrollWidth(page)).toBeLessThanOrEqual(width);
        }
      }
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.screenshot({ path: "test-results/fit-editor-1024-people.png" });
    });
  });
