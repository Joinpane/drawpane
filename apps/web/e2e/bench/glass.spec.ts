/**
 * What glass costs to draw: six glass layers (rounded rectangles, a pill
 * and a circle, shallow and deep rims, frosted and clear) over a busy
 * backdrop, each frame redrawn in full. Prints content time per frame.
 *
 * This VM has no GPU, so compare against a baseline commit on the same
 * machine rather than against a budget. Run with
 * `pnpm --filter @drawpane/web exec playwright test --project=bench bench/glass`.
 */
import { expect, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";

type W = {
  drawpane: {
    s: { pageId: string };
    createLayer(t: string, r: object, parent: string, props?: object): string;
    zoomToFit(): void;
  };
  drawpaneFrames: {
    reset(): void;
    redraw(): void;
    summary(): { frames: number; content: { p50: number; p95: number; max: number } };
  };
};

const GLASS = (depth: number, frost: number, refraction = 80) => ({
  type: "glass",
  angle: -45,
  intensity: 80,
  refraction,
  depth,
  dispersion: 50,
  frost,
  splay: 0,
});

test.describe("Glass cost", () => {
  let instance: Instance;
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    instance = await freshInstance(browser, { port: 8935, inspectorPort: 9475 });
    await instance.page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("redraws six glass layers", async () => {
    test.setTimeout(180_000);
    const page = instance.page;
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press("ControlOrMeta+Shift+Backslash");
    await page.evaluate(
      (glass) => {
        const e = (window as unknown as W).drawpane;
        const page = e.s.pageId;
        // A busy backdrop: stripes both ways over a gradient.
        e.createLayer("rect", { x: 0, y: 0, width: 1200, height: 800 }, page, {
          fills: [
            {
              type: "linear",
              from: { x: 0, y: 0.5 },
              to: { x: 1, y: 0.5 },
              stops: [
                { position: 0, color: "#ff7a45" },
                { position: 1, color: "#3d7bf0" },
              ],
            },
          ],
        });
        for (let y = 0; y < 800; y += 24)
          e.createLayer("rect", { x: 0, y, width: 1200, height: 6 }, page, {
            fills: [{ type: "solid", color: "#1c1b1aa6" }],
          });
        for (let x = 0; x < 1200; x += 30)
          e.createLayer("rect", { x, y: 0, width: 4, height: 800 }, page, {
            fills: [{ type: "solid", color: "#0b3d918c" }],
          });
        const add = (type: string, r: object, props: object) =>
          e.createLayer(type, r, page, {
            fills: [{ type: "solid", color: "#ffffff00" }],
            ...props,
          });
        add(
          "rect",
          { x: 40, y: 40, width: 360, height: 240 },
          { cornerRadius: 36, effects: [glass[0]] },
        );
        add(
          "rect",
          { x: 440, y: 40, width: 360, height: 240 },
          { cornerRadius: 36, effects: [glass[1]] },
        );
        add(
          "rect",
          { x: 840, y: 40, width: 320, height: 120 },
          { cornerRadius: 60, effects: [glass[2]] },
        );
        add("ellipse", { x: 60, y: 360, width: 300, height: 300 }, { effects: [glass[0]] });
        add(
          "rect",
          { x: 440, y: 360, width: 360, height: 240 },
          { cornerRadius: 12, effects: [glass[3]] },
        );
        add(
          "rect",
          { x: 840, y: 360, width: 320, height: 400 },
          { cornerRadius: 48, effects: [glass[1]] },
        );
        e.zoomToFit();
      },
      [GLASS(20, 4), GLASS(60, 8), GLASS(40, 0, 100), GLASS(10, 16)],
    );
    await page.waitForTimeout(1500);

    const result = await page.evaluate(async () => {
      const w = window as unknown as W;
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      for (let i = 0; i < 10; i++) {
        w.drawpaneFrames.redraw();
        await frame();
      }
      w.drawpaneFrames.reset();
      for (let i = 0; i < 60; i++) {
        w.drawpaneFrames.redraw();
        await frame();
      }
      return w.drawpaneFrames.summary();
    });
    console.log(
      `glass: ${result.frames} full redraws · content p50 ${result.content.p50} ms · p95 ${result.content.p95} ms · max ${result.content.max} ms`,
    );
    expect(result.frames).toBeGreaterThan(30);
  });
});
