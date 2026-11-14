/**
 * Snapping to a frame's edges with a real mouse, at a fractional zoom.
 * Resizing: the dragged edge snaps flush every time, including when it
 * started on that edge (the drag works from its start, and coming back to it
 * once left the layer where the previous pointer move had it). Drawing: both
 * the corner you press and the one you drag snap.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: {
    pageId: string;
    selection: string[];
    camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } };
  };
  createLayer(t: string, r: object, parent: string, props?: object): string;
  select(ids: string[]): void;
  zoomTo(z: number): void;
  scene: { bounds(id: string): { x: number; y: number; width: number; height: number } };
  doc: { get(id: string): { props: Record<string, unknown> } };
};
type W = { drawpane: Debug };

test.describe
  .serial("Snapping to a frame's edges", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8835, inspectorPort: 9375 });
      page = instance.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
    });
    test.afterAll(() => instance?.stop());

    test("snaps flush to the frame's left edge on every drag", async () => {
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        e.createLayer("frame", { x: 0, y: 0, width: 420, height: 912 }, e.s.pageId, {
          name: "iPhone Air",
          fills: [{ type: "solid", color: "#ffffff" }],
        });
        e.select([]);
        // A zoom where a screen pixel is 1.6 units, as in the report.
        e.zoomTo(0.625);
      });
      const canvas = await page.locator(".canvas__overlay").boundingBox();
      if (!canvas) throw new Error("no canvas");
      const toScreen = async (p: { x: number; y: number }) => {
        const s = await page.evaluate(
          (p) => (window as unknown as W).drawpane.s.camera.toScreen(p),
          p,
        );
        return { x: canvas.x + s.x, y: canvas.y + s.y };
      };

      // Draw a bar across the top of the phone with the rectangle tool.
      await page.keyboard.press("r");
      const a = await toScreen({ x: 30, y: 0 });
      const b = await toScreen({ x: 420, y: 80 });
      await page.mouse.move(a.x, a.y + 2);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 6 });
      await page.mouse.up();
      const bar = await page.evaluate(
        () => (window as unknown as W).drawpane.s.selection[0] as string,
      );
      const geometry = () =>
        page.evaluate((id) => {
          const props = (window as unknown as W).drawpane.doc.get(id).props;
          return { x: props.x, width: props.width };
        }, bar);

      // Pull the left handle in, then let go a few pixels either side of the edge.
      for (const offset of [5, 3, 1, -2, 3]) {
        const box = await page.evaluate(
          (id) => (window as unknown as W).drawpane.scene.bounds(id),
          bar,
        );
        const handle = await toScreen({ x: box.x, y: box.y + box.height / 2 });
        const edge = await toScreen({ x: 0, y: 0 });
        await page.mouse.move(handle.x, handle.y);
        await page.mouse.down();
        await page.mouse.move(handle.x + 20, handle.y, { steps: 4 });
        await page.mouse.move(edge.x + offset, handle.y, { steps: 6 });
        await page.mouse.up();
        expect(await geometry(), `released ${offset}px from the edge`).toEqual({
          x: 0,
          width: 420,
        });
      }
    });

    test("holding Control mid-drag lets go of the snap at once, and releasing it snaps again", async () => {
      const canvas = await page.locator(".canvas__overlay").boundingBox();
      if (!canvas) throw new Error("no canvas");
      const toScreen = async (p: { x: number; y: number }) => {
        const s = await page.evaluate(
          (p) => (window as unknown as W).drawpane.s.camera.toScreen(p),
          p,
        );
        return { x: canvas.x + s.x, y: canvas.y + s.y };
      };
      const bar = await page.evaluate(
        () => (window as unknown as W).drawpane.s.selection[0] as string,
      );
      const x = () =>
        page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id).props.x, bar);
      const box = await page.evaluate(
        (id) => (window as unknown as W).drawpane.scene.bounds(id),
        bar,
      );
      const handle = await toScreen({ x: box.x, y: box.y + box.height / 2 });
      const edge = await toScreen({ x: 0, y: 0 });
      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      await page.mouse.move(handle.x + 20, handle.y, { steps: 4 });
      // 4 screen pixels inside the edge: snapped flush.
      await page.mouse.move(edge.x + 4, handle.y, { steps: 4 });
      expect(await x()).toBe(0);
      // Control, without moving: the edge goes where the pointer is (on the pixel grid).
      await page.keyboard.down("Control");
      await expect.poll(x).toBeGreaterThan(0);
      await page.keyboard.up("Control");
      await expect.poll(x).toBe(0);
      await page.mouse.up();
    });

    test("draws a shape from edge to edge of the frame", async () => {
      const canvas = await page.locator(".canvas__overlay").boundingBox();
      if (!canvas) throw new Error("no canvas");
      const toScreen = async (p: { x: number; y: number }) => {
        const s = await page.evaluate(
          (p) => (window as unknown as W).drawpane.s.camera.toScreen(p),
          p,
        );
        return { x: canvas.x + s.x, y: canvas.y + s.y };
      };
      // Pressed and released a few pixels inside the phone's left and right edges.
      const from = await toScreen({ x: 0, y: 200 });
      const to = await toScreen({ x: 420, y: 300 });
      await page.keyboard.press("r");
      await page.mouse.move(from.x + 4, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x - 40, to.y, { steps: 4 });
      await page.mouse.move(to.x - 3, to.y, { steps: 4 });
      await page.mouse.up();
      const drawn = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const props = e.doc.get(e.s.selection[0] as string).props;
        return { x: props.x, width: props.width };
      });
      expect(drawn).toEqual({ x: 0, width: 420 });
    });
  });
