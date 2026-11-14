/**
 * Layout Explain and X-ray in a real browser, on a throwaway instance:
 * clicking the size pill explains that number, switching to the other axis,
 * a fix from the card, Esc and ⌥E, selecting the layers a term counts, and
 * dragging a gap wider while Alt is held.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: {
    pageId: string;
    selection: string[];
    explain: { id: string; axis: string } | null;
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
  revealSelection(): void;
  doc: { get(id: string): { props: Record<string, unknown> } | undefined };
};
type W = { drawpane: Debug };

const props = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.props ?? {}, id);
const select = (page: Page, ids: string[]) =>
  page.evaluate((ids) => (window as unknown as W).drawpane.select(ids), ids);
const card = (page: Page) => page.getByRole("dialog", { name: /^Why is/ });

/** A page point in the browser window. */
async function client(page: Page, x: number, y: number) {
  const box = await page.locator(".canvas").first().boundingBox();
  const p = await page.evaluate(
    ([x, y]) => (window as unknown as W).drawpane.s.camera.toScreen({ x, y }),
    [x, y] as const,
  );
  return { x: (box?.x ?? 0) + p.x, y: (box?.y ?? 0) + p.y };
}

test.describe
  .serial("Layout Explain and X-ray", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let upcoming: string;
    let rows: string[];

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8829, inspectorPort: 9369 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      [upcoming, rows] = await page
        .evaluate(() => {
          const e = (window as unknown as W).drawpane;
          const home = e.createLayer("frame", { x: 0, y: 0, width: 340, height: 400 }, e.s.pageId, {
            name: "Home",
            layoutMode: "column",
            paddingLeft: 20,
            paddingRight: 20,
            paddingTop: 20,
            fills: [{ type: "solid", color: "#ffffff" }],
          }) as string;
          const up = e.createLayer("frame", { x: 0, y: 0, width: 100, height: 100 }, home, {
            name: "Upcoming",
            layoutMode: "column",
            gap: 8,
            paddingTop: 12,
            paddingBottom: 12,
            sizingH: "fill",
            sizingV: "hug",
          }) as string;
          const rs = [0, 1, 2].map(
            (i) =>
              e.createLayer("rect", { x: 0, y: i * 60, width: 300, height: 52 }, up, {
                name: "Event row",
                fills: [{ type: "solid", color: "#f1f0ec" }],
              }) as string,
          );
          // At 1:1 and in the middle of the canvas, so screen distances are page distances.
          e.zoomTo(1);
          e.select([home]);
          e.revealSelection();
          e.select([]);
          return [up, rs] as const;
        })
        .then(([u, r]) => [u, [...r]] as [string, string[]]);
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("clicking the height in the size pill explains it, term by term", async () => {
      await select(page, [upcoming]);
      // Upcoming spans x 20..320 and ends at y 216: the pill sits just under it.
      const pill = await client(page, 170, 216);
      await page.mouse.click(pill.x + 24, pill.y + 17);
      const c = card(page);
      await expect(c).toBeVisible();
      await expect(c.getByRole("heading")).toHaveText("Why is Upcoming 196 px tall?");
      await expect(c.getByText("Height hugs its children in a vertical stack.")).toBeVisible();
      await expect(c.getByRole("listitem")).toHaveCount(4);
      await expect(c.getByText("12 + 3 × 52 + 2 × 8 + 12")).toBeVisible();
      await expect(c.getByText("= 196")).toBeVisible();
      // The selection didn't move: the pill isn't the canvas.
      expect(await page.evaluate(() => (window as unknown as W).drawpane.s.selection)).toEqual([
        upcoming,
      ]);
    });

    test("switches to the width, and fixes it from the card", async () => {
      const c = card(page);
      await c.getByRole("button", { name: /^Width is Fill: Home is 340/ }).click();
      await expect(c.getByRole("heading")).toHaveText("Why is Upcoming 300 px wide?");
      await expect(c.getByText("340 − 20 − 20")).toBeVisible();
      await c.getByRole("button", { name: "Set fixed width" }).click();
      expect((await props(page, upcoming)).sizingH).toBe("fixed");
      await expect(c.getByText("Width is fixed at 300: set by hand.")).toBeVisible();
    });

    test("Esc closes it, keeping the selection; ⌥E opens it again", async () => {
      await page.keyboard.press("Escape");
      await expect(card(page)).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as W).drawpane.s.selection)).toEqual([
        upcoming,
      ]);
      // The Lens is back while Explain is closed.
      await expect(page.getByRole("toolbar", { name: "Selection Lens" })).toBeVisible();
      await page.keyboard.press("Alt+KeyE");
      await expect(card(page).getByRole("heading")).toHaveText("Why is Upcoming 196 px tall?");
      await expect(page.getByRole("toolbar", { name: "Selection Lens" })).toHaveCount(0);
    });

    test("a term made of layers selects them", async () => {
      await card(page)
        .getByRole("button", { name: /3 × Event row/ })
        .click();
      expect(await page.evaluate(() => (window as unknown as W).drawpane.s.selection)).toEqual(
        rows,
      );
      // A new selection closes Explain.
      await expect(card(page)).toHaveCount(0);
    });

    test("holding Alt shows the X-ray key, and a gap drags wider", async () => {
      await select(page, [upcoming]);
      // The first gap: under the first row, at y 84..92 on the page.
      const gap = await client(page, 170, 88);
      await page.mouse.move(gap.x, gap.y);
      await page.keyboard.down("Alt");
      const legend = page.getByRole("complementary", { name: "Layout X-ray" });
      await expect(legend).toBeVisible();
      await expect(legend).toContainText("Gap · drag to change");
      await page.mouse.down();
      await page.mouse.move(gap.x, gap.y + 4, { steps: 2 });
      await page.mouse.move(gap.x, gap.y + 6, { steps: 2 });
      await page.mouse.up();
      await page.keyboard.up("Alt");
      expect((await props(page, upcoming)).gap).toBe(14);
      expect((await props(page, upcoming)).height).toBe(208);
      await expect(legend).toHaveCount(0);
      // One step to undo.
      await page.keyboard.press("ControlOrMeta+z");
      expect((await props(page, upcoming)).gap).toBe(8);
    });

    test("the inspector's X-ray button keeps it on without Alt", async () => {
      await select(page, [upcoming]);
      const toggle = page.getByRole("button", { name: "Layout X-ray" });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("complementary", { name: "Layout X-ray" })).toContainText(
        "X-ray stays on",
      );
      await toggle.click();
      await expect(page.getByRole("complementary", { name: "Layout X-ray" })).toHaveCount(0);
    });
  });
