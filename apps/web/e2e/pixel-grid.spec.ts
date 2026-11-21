/**
 * The pixel grid in a real browser: nothing below 400%, whole-pixel lines
 * above it on their own retained canvas (translated, not redrawn, on a
 * pan), the canvas menu's toggle, ⇧' and ⇧⌘' for snapping, and the
 * choice surviving a reload.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

const PORT = Number(process.env.PIXEL_GRID_E2E_PORT ?? 49261);

type Debug = {
  s: {
    pageId: string;
    pixelGrid: boolean;
    pixelSnap: boolean;
    camera: { x: number; y: number; zoom: number };
  };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
};
const state = (page: Page) =>
  page.evaluate(() => (window as unknown as { drawpane: Debug }).drawpane.s);
const waitPaint = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
/** Moves the camera exactly (no glide), so line positions are predictable. */
const setCamera = (page: Page, x: number, y: number, zoom: number) =>
  page.evaluate(
    ([x, y, zoom]) => {
      const e = (
        window as unknown as {
          drawpane: {
            s: { camera: { constructor: new (x: number, y: number, z: number) => unknown } };
            setCamera(c: unknown): void;
          };
        }
      ).drawpane;
      e.setCamera(new e.s.camera.constructor(x as number, y as number, zoom as number));
    },
    [x, y, zoom],
  );
/** Grid ink on its retained canvas, plus one line and one cell-middle sample. */
const gridPixels = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-canvas-role="pixel-grid"]');
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return { ink: -1, line: -1, middle: -1, transform: "" };
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    const dpr = window.devicePixelRatio || 1;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) ink++;
    const pad = Number(c.dataset.overscan ?? "0");
    const { x, y, zoom } = e.s.camera;
    const alpha = (px: number, py: number) => data[(py * c.width + px) * 4 + 3] ?? -1;
    const boundaryX = Math.ceil(-x / zoom) + 1;
    const boundaryY = Math.ceil(-y / zoom) + 1;
    const lineX = Math.round((boundaryX * zoom + x + pad) * dpr);
    const lineY = Math.round((boundaryY * zoom + y + pad) * dpr);
    // Half a cell in from the line, where no line of either direction runs.
    const half = Math.round((zoom * dpr) / 2);
    return {
      ink,
      line: alpha(lineX, lineY + half),
      middle: alpha(lineX + half, lineY + half),
      transform: c.style.transform,
    };
  });

test.describe
  .serial("Pixel grid", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: PORT, inspectorPort: PORT + 540 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await page.evaluate(() => {
        const e = (window as unknown as { drawpane: Debug }).drawpane;
        const board = e.createLayer("frame", { x: 0, y: 0, width: 200, height: 200 }, e.s.pageId, {
          name: "Board",
        }) as string;
        e.createLayer("rect", { x: 100, y: 0, width: 100, height: 200 }, board, {
          name: "Dark half",
          fills: [{ type: "solid", color: "#111111" }],
        });
        e.select([]);
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("is on by default, shows only from 400%, and its lines sit on whole pixels", async () => {
      expect((await state(page)).pixelGrid).toBe(true);

      await setCamera(page, 100, 100, 2);
      await waitPaint(page);
      expect((await gridPixels(page)).ink).toBe(0);

      await setCamera(page, 100, 100, 3.9);
      await waitPaint(page);
      expect((await gridPixels(page)).ink).toBe(0);

      await setCamera(page, 100, 100, 16);
      await expect.poll(async () => (await gridPixels(page)).ink).toBeGreaterThan(1000);
      const atLine = await gridPixels(page);
      expect(atLine.line).toBeGreaterThan(0);
      expect(atLine.middle).toBe(0);

      // A same-zoom pan translates the retained grid canvas instead of redrawing it.
      await setCamera(page, 108, 104, 16);
      await waitPaint(page);
      expect((await gridPixels(page)).transform).toContain("translate3d(8px, 4px");
    });

    test("the menu toggles it, ⇧' toggles it back, ⇧⌘' is snapping's, and off survives a reload", async () => {
      // Back out so the right-click lands on empty canvas and opens its menu.
      await setCamera(page, 0, 0, 1);
      await waitPaint(page);
      await page.mouse.click(620, 420, { button: "right" });
      const item = page.getByRole("menuitemcheckbox", { name: "Show pixel grid" });
      await expect(item).toBeVisible();
      await expect(item).toBeChecked();
      await item.click();
      expect((await state(page)).pixelGrid).toBe(false);

      await setCamera(page, 100, 100, 16);
      await waitPaint(page);
      expect((await gridPixels(page)).ink).toBe(0);

      await page.keyboard.press("Shift+'");
      await expect.poll(async () => (await state(page)).pixelGrid).toBe(true);
      await expect.poll(async () => (await gridPixels(page)).ink).toBeGreaterThan(1000);

      // Snapping keeps its own shortcut and does not disturb the grid.
      expect((await state(page)).pixelSnap).toBe(true);
      await page.keyboard.press("ControlOrMeta+Shift+'");
      await expect.poll(async () => (await state(page)).pixelSnap).toBe(false);
      expect((await state(page)).pixelGrid).toBe(true);

      await page.keyboard.press("Shift+'");
      await expect.poll(async () => (await state(page)).pixelGrid).toBe(false);
      await page.reload();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await expect.poll(async () => (await state(page)).pixelGrid, { timeout: 15_000 }).toBe(false);
      expect((await state(page)).pixelSnap).toBe(false);
    });
  });
