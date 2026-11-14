/**
 * Scrubbing a bounded number in a real browser: flicking the Lens's corner
 * radius far to the left lands exactly on 0, the property's minimum, with no
 * complaint (it used to stop just short and say "must be zero or more").
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type W = {
  drawpane: {
    s: { pageId: string };
    doc: { get(id: string): { props: Record<string, unknown> } | undefined };
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
    zoomTo(z: number): void;
    revealSelection(): void;
  };
};

test.describe
  .serial("Scrubbing", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8867, inspectorPort: 9407 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("a fast drag past the minimum lands exactly on it", async () => {
      const id = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const frame = e.createLayer("frame", { x: 0, y: 0, width: 402, height: 874 }, e.s.pageId, {
          cornerRadius: 0.5,
          fills: [{ type: "solid", color: "#ffffff" }],
        }) as string;
        e.select([frame]);
        e.zoomTo(0.7);
        e.revealSelection();
        return frame;
      });
      // The Lens's field, beside the selection (the inspector has its own).
      const lens = page.getByRole("toolbar", { name: "Selection Lens" });
      const radius = lens.getByRole("spinbutton", { name: "Corner radius" });
      await expect(radius).toHaveValue("0.5");
      // The field's glyph is its drag handle.
      const handle = lens
        .locator(".dp-field")
        .filter({ has: page.getByRole("spinbutton", { name: "Corner radius" }) })
        .locator(".dp-field__label")
        .first();
      const box = (await handle.boundingBox()) as { x: number; y: number; height: number };
      await page.mouse.move(box.x + 4, box.y + box.height / 2);
      await page.mouse.down();
      // A quick flick: two big moves, far past 0.
      await page.mouse.move(box.x - 150, box.y + box.height / 2);
      await page.mouse.move(box.x - 400, box.y + box.height / 2);
      await page.mouse.up();
      await expect(radius).toHaveValue("0");
      // The inspector agrees.
      await expect(
        page.getByRole("complementary", { name: "Inspector" }).getByRole("spinbutton", {
          name: "Corner radius",
        }),
      ).toHaveValue("0");
      const stored = await page.evaluate(
        (id) => (window as unknown as W).drawpane.doc.get(id)?.props.cornerRadius ?? 0,
        id,
      );
      expect(stored).toBe(0);
      await expect(page.getByText("must be zero or more")).toHaveCount(0);
    });
  });
