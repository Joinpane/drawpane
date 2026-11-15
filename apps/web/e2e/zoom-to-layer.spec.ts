/**
 * Zoom to a layer from the Layers panel, as in Figma: double-clicking a row's
 * kind icon selects the layer and glides the canvas to fit it (what Shift+2
 * does), over several frames, landing exactly on the fit. It doesn't rename;
 * double-clicking the name still does. A wheel mid-glide stops it where it
 * is, and with reduced motion it jumps.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

interface Cam {
  x: number;
  y: number;
  zoom: number;
}
type Rect = { x: number; y: number; width: number; height: number };
type W = {
  drawpane: {
    s: {
      pageId: string;
      selection: string[];
      camera: Cam & {
        fit(r: Rect, v: unknown, padding: number, max: number, insets: unknown): Cam;
      };
      viewport: unknown;
      insets: unknown;
    };
    cameraAnimating: boolean;
    createLayer(type: string, rect: Rect, parent: string): string | null;
    select(ids: string[]): void;
    zoomTo(z: number): void;
    scene: { bounds(id: string): Rect | null };
    state: { subscribe(fn: () => void): () => void };
  };
  cameras?: Cam[];
};

const icon = (page: Page, id: string) => page.locator(`[data-layer-id="${id}"] .dp-layer__icon`);

/** The camera now, and the one Shift+2 would fit `id` with. */
const cameras = (page: Page, id: string) =>
  page.evaluate((id) => {
    const e = (window as unknown as W).drawpane;
    const b = e.scene.bounds(id);
    if (!b) throw new Error("no bounds");
    const { x, y, zoom } = e.s.camera;
    const fit = e.s.camera.fit(b, e.s.viewport, 64, 8, e.s.insets);
    return { now: { x, y, zoom }, fit: { x: fit.x, y: fit.y, zoom: fit.zoom } };
  }, id);

/** Starts recording every camera the canvas is given. */
const record = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as W;
    w.cameras = [];
    // Only real moves: other state changes (selection, hover) leave the camera as it was.
    let last = w.drawpane.s.camera;
    w.drawpane.state.subscribe(() => {
      const camera = w.drawpane.s.camera;
      if (camera === last) return;
      last = camera;
      w.cameras?.push({ x: camera.x, y: camera.y, zoom: camera.zoom });
    });
  });
const recorded = (page: Page) =>
  page.evaluate(() => (window as unknown as W).cameras?.splice(0) ?? []);
const animating = (page: Page) =>
  page.evaluate(() => (window as unknown as W).drawpane.cameraAnimating);
const settled = (page: Page) =>
  page.waitForFunction(() => !(window as unknown as W).drawpane.cameraAnimating);
const home = (page: Page) =>
  page.evaluate(() => {
    const e = (window as unknown as W).drawpane;
    e.select([]);
    e.zoomTo(1);
  });

test.describe
  .serial("Zoom to a layer from the Layers panel", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let near: string;
    let far: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8975, inspectorPort: 9515 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      [near, far] = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const a = e.createLayer("rect", { x: 40, y: 40, width: 120, height: 80 }, e.s.pageId);
        const b = e.createLayer("rect", { x: 4000, y: 3000, width: 60, height: 40 }, e.s.pageId);
        return [a as string, b as string];
      });
      await home(page);
      await record(page);
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("double-clicking the icon selects the layer and glides to fit it", async () => {
      await recorded(page);
      await icon(page, far).dblclick();
      await settled(page);
      const { now, fit } = await cameras(page, far);
      // Lands exactly on what Shift+2 fits, not a float's breadth off.
      expect(now).toEqual(fit);
      // ...by way of the cameras in between, not a jump. (How many depends on how fast frames
      // come: the glide takes its time, not a number of frames.)
      const path = await recorded(page);
      expect(path.length).toBeGreaterThanOrEqual(2);
      expect(path[0]).not.toEqual(fit);
      expect(path.at(-1)).toEqual(fit);
      expect(await page.evaluate(() => (window as unknown as W).drawpane.s.selection)).toEqual([
        far,
      ]);
      // It didn't start renaming.
      await expect(page.getByRole("textbox", { name: "Layer name" })).toHaveCount(0);
    });

    test("double-clicking the name still renames", async () => {
      await page.locator(`[data-layer-id="${near}"] .dp-layer__name`).dblclick();
      await expect(page.getByRole("textbox", { name: "Layer name" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("textbox", { name: "Layer name" })).toHaveCount(0);
    });

    test("a wheel mid-glide stops it where it is", async () => {
      await home(page);
      await recorded(page);
      // Two frames in, the canvas is scrolled: sent from the page, so it lands mid-glide however
      // busy the machine is (from the test, the glide can be over before the wheel arrives).
      const wheeled = page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const e = (window as unknown as W).drawpane;
            let frames = 0;
            const off = e.state.subscribe(() => {
              if (!e.cameraAnimating || ++frames < 2) return;
              off();
              queueMicrotask(() => {
                const canvas = document.querySelector(".canvas__overlay") as HTMLElement;
                const r = canvas.getBoundingClientRect();
                canvas.dispatchEvent(
                  new WheelEvent("wheel", {
                    deltaY: 120,
                    clientX: r.left + r.width / 2,
                    clientY: r.top + r.height / 2,
                    bubbles: true,
                    cancelable: true,
                  }),
                );
                resolve(e.cameraAnimating);
              });
            });
          }),
      );
      await icon(page, far).dblclick();
      expect(await wheeled).toBe(false);
      const stopped = (await cameras(page, far)).now;
      // Nothing moves it after that.
      await page.waitForTimeout(700);
      const { now, fit } = await cameras(page, far);
      expect(now).toEqual(stopped);
      expect(now).not.toEqual(fit);
    });

    test("Shift+2 glides too", async () => {
      await home(page);
      await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), far);
      await recorded(page);
      await page.locator(".canvas").focus();
      await page.mouse.move(720, 450);
      await page.keyboard.press("Shift+2");
      await settled(page);
      const { now, fit } = await cameras(page, far);
      expect(now).toEqual(fit);
      const path = await recorded(page);
      expect(path.length).toBeGreaterThanOrEqual(2);
      expect(path[0]).not.toEqual(fit);
    });

    test("with reduced motion it jumps straight there", async () => {
      await home(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await recorded(page);
      await icon(page, near).dblclick();
      expect(await animating(page)).toBe(false);
      const { now, fit } = await cameras(page, near);
      expect(now).toEqual(fit);
      expect(await recorded(page)).toEqual([fit]);
      await page.emulateMedia({ reducedMotion: "no-preference" });
    });
  });
