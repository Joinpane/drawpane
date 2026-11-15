/**
 * Radial and angular gradients on strokes are laid out as on fills: in the
 * layer's unit square, so on a layer that isn't square a radial one is an
 * ellipse, as in Figma. A fill draws that exactly; an inside stroke as thick
 * as the layer covers it all, so the two must look the same, pixel for pixel
 * (to anti-aliasing). Before, strokes drew a circle in pixels instead.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

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
    centerOn(p: { x: number; y: number }): void;
  };
  drawpaneFrames: { redraw(): void };
};

const W_ = 240;
const H_ = 120;
const stops = [
  { position: 0, color: "#e8590c" },
  { position: 0.5, color: "#2b4fd6" },
  { position: 1, color: "#0b7a75" },
];

/** Mean RGB difference (0 to 255) between the fill and the stroke versions of `paint`. */
async function difference(page: Page, paint: Record<string, unknown>, y: number): Promise<number> {
  return page.evaluate(
    async ({ paint, y, w, h }) => {
      const e = (window as unknown as W).drawpane;
      const filled = e.createLayer("rect", { x: 0, y, width: w, height: h }, e.s.pageId, {
        fills: [paint],
      }) as string;
      const stroked = e.createLayer("rect", { x: w + 40, y, width: w, height: h }, e.s.pageId, {
        fills: [],
        strokes: [paint],
        strokeWeight: h,
        strokeAlign: "inside",
      }) as string;
      e.select([]);
      e.zoomTo(1);
      e.centerOn({ x: w + 20, y: y + h / 2 });
      (window as unknown as W).drawpaneFrames.redraw();
      for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
      const canvas = document.querySelector(".canvas canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      const read = (x: number) => {
        const at = e.s.camera.toScreen({ x, y });
        // Two pixels in from each edge: the anti-aliased edges differ by nature.
        return ctx.getImageData(
          Math.round(at.x * ratio) + 2,
          Math.round(at.y * ratio) + 2,
          Math.round(w * ratio) - 4,
          Math.round(h * ratio) - 4,
        ).data;
      };
      const a = read(0);
      const b = read(w + 40);
      let sum = 0;
      for (let i = 0; i < a.length; i += 4)
        for (let c = 0; c < 3; c++) sum += Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0));
      void filled;
      void stroked;
      return sum / ((a.length / 4) * 3);
    },
    { paint, y, w: W_, h: H_ },
  );
}

test.describe
  .serial("Gradient strokes", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8991, inspectorPort: 9531 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      // Panels away: the whole canvas is free to compare on.
      await page.keyboard.press("ControlOrMeta+Shift+Backslash");
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("a radial gradient on a wide layer's stroke is the ellipse its fill is", async () => {
      const paint = { type: "radial", from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 }, stops };
      expect(await difference(page, paint, 0)).toBeLessThan(1.5);
    });

    test("an angular gradient on a wide layer's stroke sweeps as its fill does", async () => {
      const paint = { type: "angular", from: { x: 0.4, y: 0.5 }, to: { x: 1, y: 0.2 }, stops };
      expect(await difference(page, paint, 400)).toBeLessThan(1.5);
    });
  });
