/**
 * The canvas's shortcuts draw what a full redraw would: a pan moves the last
 * frame and draws only the uncovered strips, and a zoom scales a snapshot
 * until it settles. After each, the pixels are compared with a frame drawn
 * from nothing at the same camera, over plain layers and over layers that
 * read the pixels around them (glass, background blur, layer blur).
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
    centerOn(p: { x: number; y: number }): void;
  };
  drawpaneFrames: { redraw(): void; exact: boolean };
};

/**
 * Waits until the canvas says it's exact: a frame too costly for the
 * budget is drawn a tile at a time, and glass and background blur after
 * the tiles (decision 0028), over the frames that follow.
 */
async function exact(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as W).drawpaneFrames.exact, undefined, {
    timeout: 60_000,
    polling: 50,
  });
}

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

/** Share of sampled pixels that differ between two frames by more than `within` in a channel. */
function difference(a: number[], b: number[], within = 24): number {
  let differ = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    const d = Math.max(
      Math.abs((x & 255) - (y & 255)),
      Math.abs(((x >> 8) & 255) - ((y >> 8) & 255)),
      Math.abs(((x >> 16) & 255) - ((y >> 16) & 255)),
    );
    if (d > within) differ++;
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
        // Below the cards: stripes under glass, a background blur and a layer blur.
        for (let i = 0; i < 40; i++)
          e.createLayer("rect", { x: i * 40, y: 900, width: 20, height: 600 }, e.s.pageId, {
            fills: [{ type: "solid", color: i % 2 ? "#e8590c" : "#2b4fd6" }],
          });
        const GLASS = {
          type: "glass",
          angle: -45,
          intensity: 80,
          refraction: 80,
          depth: 20,
          dispersion: 50,
          frost: 4,
          splay: 0,
        };
        for (let i = 0; i < 5; i++)
          e.createLayer(
            "rect",
            { x: 60 + i * 300, y: 960 + (i % 2) * 180, width: 240, height: 160 },
            e.s.pageId,
            {
              cornerRadius: 36,
              rotation: i * 9,
              fills: [{ type: "solid", color: "#ffffff22" }],
              effects: [{ ...GLASS, depth: 12 + i * 8 }],
            },
          );
        e.createLayer("rect", { x: 200, y: 1300, width: 400, height: 140 }, e.s.pageId, {
          cornerRadius: 24,
          fills: [{ type: "solid", color: "#ffffff55" }],
          effects: [{ type: "background-blur", radius: 24 }],
        });
        const blurred = e.createLayer(
          "frame",
          { x: 800, y: 1300, width: 400, height: 140 },
          e.s.pageId,
          {
            fills: [{ type: "solid", color: "#ffffff" }],
            effects: [{ type: "layer-blur", radius: 12 }],
          },
        );
        e.createLayer("ellipse", { x: 40, y: 20, width: 100, height: 100 }, blurred, {
          fills: [{ type: "solid", color: "#111111" }],
        });
        // Masked by a fading picture, across the bottom of the view: stripes, and over them a
        // background blur and glass, which read only what the mask's layers draw.
        const masked = e.createLayer(
          "frame",
          { x: 640, y: 1480, width: 600, height: 320 },
          e.s.pageId,
          { fills: [] },
        );
        e.createLayer("ellipse", { x: 0, y: 0, width: 600, height: 320 }, masked, {
          isMask: true,
          maskType: "alpha",
          fills: [
            {
              type: "linear",
              from: { x: 0, y: 0.5 },
              to: { x: 1, y: 0.5 },
              stops: [
                { position: 0, color: "#000000" },
                { position: 1, color: "#00000022" },
              ],
            },
          ],
        });
        for (let i = 0; i < 15; i++)
          e.createLayer("rect", { x: i * 40, y: 0, width: 20, height: 320 }, masked, {
            fills: [{ type: "solid", color: i % 2 ? "#0b8a3e" : "#7a2bd6" }],
          });
        e.createLayer("rect", { x: 60, y: 60, width: 220, height: 120 }, masked, {
          cornerRadius: 20,
          fills: [{ type: "solid", color: "#ffffff44" }],
          effects: [{ type: "background-blur", radius: 16 }],
        });
        e.createLayer("rect", { x: 320, y: 120, width: 220, height: 140 }, masked, {
          cornerRadius: 30,
          fills: [{ type: "solid", color: "#ffffff22" }],
          effects: [GLASS],
        });
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
      await exact(page);
      const panned = await pixels(page);
      const full = await redrawn(page);
      expect(difference(panned, full)).toBeLessThan(0.002);
    });

    test("a pan over glass and blurs draws what a full redraw would", async () => {
      await page.evaluate(() => (window as unknown as W).drawpane.centerOn({ x: 500, y: 1150 }));
      await redrawn(page);
      await page.evaluate(async () => {
        const e = (window as unknown as W).drawpane;
        const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        // Across the glass and back, in small steps and in big ones (a fast flick), so
        // every layer is cut by an uncovered strip on the way.
        for (const [dx, dy] of [
          ...Array.from({ length: 12 }, (_, i) => [-17.3, i % 2 ? 6.1 : -9.7]),
          [-310.4, 123.7],
          [287.9, -201.3],
          [-153.1, 77.7],
          ...Array.from({ length: 12 }, (_, i) => [17.3, i % 2 ? -6.1 : 9.7]),
        ] as const) {
          e.state.set({ camera: e.s.camera.pan(dx, dy) });
          await frame();
        }
      });
      await exact(page);
      const panned = await pixels(page);
      const full = await redrawn(page);
      // Strict: a seam, or a rim along the screen's edge carried in by the pan, is faint.
      expect(difference(panned, full, 8)).toBeLessThan(0.0005);
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
      await exact(page);
      const settled = await pixels(page);
      const full = await redrawn(page);
      expect(difference(settled, full)).toBeLessThan(0.002);
    });
  });
