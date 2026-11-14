/**
 * Variable fonts (decision 0009) in a real browser: a team's variable font
 * (Instrument Sans, with width and weight axes) offers its axes in the
 * inspector; setting width narrows the text, measured and drawn from the
 * shaped glyphs; weight is the text's weight; and resetting brings it back.
 */
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

const VARIABLE_TTF = fileURLToPath(
  new URL("./fixtures/InstrumentSans-Variable.ttf", import.meta.url),
);

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

const prop = (page: Page, id: string, name: string) =>
  page.evaluate(({ id, name }) => (window as unknown as W).drawpane.doc.get(id)?.props[name], {
    id,
    name,
  });
const width = async (page: Page, id: string) => Number((await prop(page, id, "width")) ?? 0);

/** Dark pixels where the text is on the canvas: something is drawn there. */
function inked(page: Page, id: string): Promise<number> {
  return page.evaluate((id) => {
    const e = (window as unknown as W).drawpane;
    const p = e.doc.get(id)?.props as { x: number; y: number; width: number; height: number };
    const a = e.s.camera.toScreen({ x: p.x, y: p.y });
    const b = e.s.camera.toScreen({ x: p.x + p.width, y: p.y + p.height });
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
  .serial("Variable fonts", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let id: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8879, inspectorPort: 9419 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page
        .getByRole("complementary", { name: "Navigation" })
        .getByRole("link", { name: "Fonts" })
        .click();
      await page.getByLabel("Font files").setInputFiles([VARIABLE_TTF]);
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
          characters: "Wonderful",
          fontSize: 48,
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

    test("sets width from the font's axes: narrower, shaped, still drawn", async () => {
      await expect.poll(() => width(page, id)).toBeGreaterThan(100);
      const wide = await width(page, id);
      const inspector = page.getByRole("complementary", { name: "Inspector" });
      const trigger = inspector.getByRole("button", { name: /^Variable axes/ });
      await expect(trigger).toContainText("Font defaults");
      await trigger.click();
      const panel = page.getByRole("dialog", { name: "Variable axes" });
      // The font's own axes, by its names for them.
      await expect(panel.getByRole("slider", { name: "Width" })).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByRole("slider", { name: "Weight" })).toBeVisible();
      await panel.getByLabel("Width value").fill("75");
      await panel.getByLabel("Width value").press("Enter");
      await expect.poll(() => prop(page, id, "fontVariations")).toEqual({ wdth: 75 });
      // Measured from the shaped glyphs: condensed, the line is clearly narrower.
      await expect.poll(() => width(page, id), { timeout: 15_000 }).toBeLessThan(wide * 0.92);
      await expect(trigger).toContainText("Width 75");
      await page.keyboard.press("Escape");
      await expect.poll(() => inked(page, id)).toBeGreaterThan(300);
    });

    test("sets the weight as the text's weight, and resets the axes", async () => {
      const inspector = page.getByRole("complementary", { name: "Inspector" });
      const trigger = inspector.getByRole("button", { name: /^Variable axes/ });
      await trigger.click();
      const panel = page.getByRole("dialog", { name: "Variable axes" });
      const condensed = await width(page, id);
      await panel.getByLabel("Weight value").fill("700");
      await panel.getByLabel("Weight value").press("Enter");
      await expect.poll(() => prop(page, id, "fontWeight")).toBe(700);
      await expect.poll(() => width(page, id)).toBeGreaterThan(condensed);
      // Weight isn't an axis in the file's model: it stays the text's weight.
      expect(await prop(page, id, "fontVariations")).toEqual({ wdth: 75 });

      await panel.getByRole("button", { name: "Back to the font’s defaults" }).click();
      await expect.poll(() => prop(page, id, "fontVariations")).toBeUndefined();
      await expect(trigger).toContainText("Font defaults");
    });
  });
