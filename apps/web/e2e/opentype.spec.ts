/**
 * OpenType features in a real browser (decision 0005): turning on tabular
 * figures from the inspector shapes the text with HarfBuzz, so it takes the
 * tabular widths and still draws; turning it back off, or a font whose file
 * can't be read, falls back to the canvas. The font is uploaded as a team
 * font (Instrument Sans, which has tabular figures), so nothing comes from
 * Google during the test.
 */
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

const SANS_TTF = fileURLToPath(new URL("./fixtures/InstrumentSans-Regular.ttf", import.meta.url));

type W = {
  drawpane: {
    s: {
      pageId: string;
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
};

const width = (page: Page, id: string) =>
  page.evaluate(
    (id) => Number((window as unknown as W).drawpane.doc.get(id)?.props.width ?? 0),
    id,
  );

/** Dark pixels where the text is on the canvas: something is drawn there. */
function inked(page: Page, id: string): Promise<number> {
  return page.evaluate((id) => {
    const e = (window as unknown as W).drawpane;
    const p = e.doc.get(id)?.props as { x: number; y: number; width: number; height: number };
    const a = e.s.camera.toScreen({ x: p.x, y: p.y });
    const b = e.s.camera.toScreen({ x: p.x + p.width, y: p.y + p.height });
    // The content layer (the first canvas), in device pixels.
    const canvas = document.querySelector(".canvas canvas") as HTMLCanvasElement;
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    const px = ctx.getImageData(
      Math.round(a.x * ratio),
      Math.round(a.y * ratio),
      Math.max(1, Math.round((b.x - a.x) * ratio)),
      Math.max(1, Math.round((b.y - a.y) * ratio)),
    ).data;
    let dark = 0;
    for (let i = 0; i < px.length; i += 4)
      if ((px[i + 3] ?? 0) > 200 && (px[i] ?? 255) < 100) dark++;
    return dark;
  }, id);
}

test.describe
  .serial("OpenType features", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let id: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8869, inspectorPort: 9409 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page
        .getByRole("complementary", { name: "Navigation" })
        .getByRole("link", { name: "Fonts" })
        .click();
      await page.getByLabel("Font files").setInputFiles([SANS_TTF]);
      await expect(page.locator(".team-fonts__upload--added")).toHaveCount(1, { timeout: 15_000 });
      await page
        .getByRole("complementary", { name: "Navigation" })
        .getByRole("link", { name: "Recent" })
        .click();
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      id = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const t = e.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, e.s.pageId, {
          characters: "1111",
          fontSize: 40,
          fontFamily: "Instrument Sans",
          fills: [{ type: "solid", color: "#000000" }],
        }) as string;
        e.select([t]);
        e.zoomTo(1);
        e.revealSelection();
        return t;
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("tabular figures from the inspector: wider, shaped, still drawn", async () => {
      // Proportional "1"s: 382 units each at 1000 per em.
      await expect.poll(() => width(page, id)).toBeLessThan(70);
      const inspector = page.getByRole("complementary", { name: "Inspector" });
      const trigger = inspector.getByRole("button", { name: /^OpenType features/ });
      await expect(trigger).toContainText("Font defaults");
      await trigger.click();
      const panel = page.getByRole("dialog", { name: "OpenType features" });
      const tabular = panel.getByRole("checkbox", { name: /Tabular figures/ });
      await expect(tabular).not.toBeChecked({ timeout: 15_000 });
      // Ligatures are on unless turned off.
      await expect(panel.getByRole("checkbox", { name: /^Ligatures/ })).toBeChecked();
      await tabular.check();
      // 600 units each, 4 × 40px × 0.6: measured from the shaped glyphs.
      await expect.poll(() => width(page, id), { timeout: 15_000 }).toBe(96);
      await expect(trigger).toContainText("Tabular figures");
      await page.keyboard.press("Escape");
      await expect.poll(() => inked(page, id)).toBeGreaterThan(200);

      // Off again: the canvas's widths.
      await trigger.click();
      await panel.getByRole("checkbox", { name: /Tabular figures/ }).uncheck();
      await expect.poll(() => width(page, id)).toBeLessThan(70);
      await panel.getByRole("checkbox", { name: /Tabular figures/ }).check();
      await expect.poll(() => width(page, id)).toBe(96);
      await panel.getByRole("button", { name: "Back to the font’s defaults" }).click();
      await expect.poll(() => width(page, id)).toBeLessThan(70);
      await expect(trigger).toContainText("Font defaults");
      await page.keyboard.press("Escape");
    });

    test("says so when a font's features can't be read", async () => {
      await page.evaluate((id) => {
        const e = (window as unknown as W).drawpane as unknown as {
          setProp(ids: string[], prop: string, value: unknown, label: string): void;
        };
        e.setProp([id], "fontFamily", "Georgia", "Font");
        (window as unknown as W).drawpane.select([id]);
      }, id);
      await page
        .getByRole("complementary", { name: "Inspector" })
        .getByRole("button", { name: /^OpenType features/ })
        .click();
      await expect(page.getByRole("dialog", { name: "OpenType features" })).toContainText(
        "Georgia isn’t a Google, team or built-in font",
      );
      await page.keyboard.press("Escape");
    });
  });
