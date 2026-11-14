/**
 * The canvas's shortcuts draw what a full redraw would: a pan moves the last
 * frame and draws only the uncovered strips, and a zoom scales a snapshot
 * until it settles. After each, the pixels are compared with a frame drawn
 * from nothing at the same camera.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Camera = {
  pan(dx: number, dy: number): Camera;
  zoomAt(p: { x: number; y: number }, zoom: number): Camera;
  zoom: number;
};
type W = {
  drawpane: {
    s: { pageId: string; camera: Camera; viewport: { width: number; height: number } };
    state: { set(patch: { camera: Camera }): void };
    createLayer(t: string, r: object, p: string, props?: object): string;
    zoomTo(z: number): void;
  };
  drawpaneFrames: { redraw(): void };
};

/** The content canvas's pixels, as a compact fingerprint per 4×4 block. */
async function pixels(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    await frame();
    await frame();
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.canvas__layer");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) throw new Error("no canvas");
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const out: number[] = [];
    for (let y = 0; y < height; y += 4)
      for (let x = 0; x < width; x += 4) {
        const i = (y * width + x) * 4;
        out.push(
          (data[i] as number) + (data[i + 1] as number) * 256 + (data[i + 2] as number) * 65536,
        );
      }
    return out;
  });
}

/** Share of sampled pixels that differ noticeably between two frames. */
function difference(a: number[], b: number[]): number {
  let differ = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    const d = Math.max(
      Math.abs((x & 255) - (y & 255)),
      Math.abs(((x >> 8) & 255) - ((y >> 8) & 255)),
      Math.abs(((x >> 16) & 255) - ((y >> 16) & 255)),
    );
    if (d > 24) differ++;
  }
  return differ / a.length;
}

const redrawn = async (page: Page) => {
  await page.evaluate(() => (window as unknown as W).drawpaneFrames.redraw());
  return pixels(page);
};

test.describe
  .serial("Canvas rendering shortcuts", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8823, inspectorPort: 9363 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        for (let i = 0; i < 24; i++) {
          const card = e.createLayer(
            "frame",
            { x: (i % 6) * 260, y: Math.floor(i / 6) * 200, width: 220, height: 160 },
            e.s.pageId,
            {
              cornerRadius: 12,
              fills: [{ type: "solid", color: "#ffffff" }],
              strokes: [{ type: "solid", color: "#d2cfc8" }],
              effects: [
                { type: "drop-shadow", color: "#00000033", x: 0, y: 6, blur: 16, spread: 0 },
              ],
            },
          );
          e.createLayer("ellipse", { x: 16, y: 16, width: 40, height: 40 }, card, {
            fills: [{ type: "solid", color: i % 2 ? "#e8590c" : "#007ca5" }],
          });
          e.createLayer("text", { x: 16, y: 72, width: 10, height: 10 }, card, {
            characters: `Card ${i + 1}: plan the week`,
            fontSize: 16,
            fontWeight: 600,
          });
        }
        e.zoomTo(1);
      });
      await page.waitForTimeout(800);
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("a pan draws what a full redraw would", async () => {
      await page.evaluate(async () => {
        const e = (window as unknown as W).drawpane;
        const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        // Awkward steps, so the snapping to whole pixels is exercised.
        for (let i = 0; i < 40; i++) {
          e.state.set({ camera: e.s.camera.pan(-13.37, i % 2 ? 7.71 : -4.13) });
          await frame();
        }
      });
      const panned = await pixels(page);
      const full = await redrawn(page);
      expect(difference(panned, full)).toBeLessThan(0.002);
    });

    test("a zoom settles to what a full redraw would", async () => {
      await page.evaluate(async () => {
        const e = (window as unknown as W).drawpane;
        const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        const centre = { x: e.s.viewport.width / 2, y: e.s.viewport.height / 2 };
        for (let i = 0; i < 20; i++) {
          e.state.set({ camera: e.s.camera.zoomAt(centre, e.s.camera.zoom * 1.04) });
          await frame();
        }
      });
      // After the pause, the stand-in frames give way to an exact one.
      await page.waitForTimeout(400);
      const settled = await pixels(page);
      const full = await redrawn(page);
      expect(difference(settled, full)).toBeLessThan(0.002);
    });
  });
