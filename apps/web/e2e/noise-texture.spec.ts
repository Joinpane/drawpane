/**
 * Noise and texture in a real browser (decision 0008): noise grains a
 * layer only where it paints and holds still as the view pans; texture
 * roughens the edge, past it unless clipped to the shape; and both are
 * added and set from the inspector.
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
    setProp(ids: string[], prop: string, value: unknown, label: string): void;
    select(ids: string[]): void;
    zoomTo(z: number): void;
    centerOn(p: { x: number; y: number }): void;
    doc: { get(id: string): { props: Record<string, unknown> } | undefined };
  };
};

const NOISE = {
  type: "noise",
  noiseType: "mono",
  size: 4,
  density: 50,
  color: "#000000ff",
  secondaryColor: "#ffffff40",
  opacity: 25,
};
const TEXTURE = { type: "texture", size: 1, radius: 6, clipToShape: false };

/** The canvas's colours at page points. */
function pixels(page: Page, points: Array<{ x: number; y: number }>): Promise<number[][]> {
  return page.evaluate((points) => {
    const e = (window as unknown as W).drawpane;
    const canvas = document.querySelector(".canvas canvas") as HTMLCanvasElement;
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    return points.map((point) => {
      const p = e.s.camera.toScreen(point);
      const d = ctx.getImageData(Math.round(p.x * ratio), Math.round(p.y * ratio), 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
    });
  }, points);
}

const BLUE = [0x2b, 0x4f, 0xd6];
const near = (a: number[], b: number[], within = 40) =>
  a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= within);
/** Grain darkens the blue: clearly darker than the layer, toward black. */
const isGrain = (c: number[]) => (c[2] ?? 0) < BLUE[2] - 60 && !near(c, BLUE);
const isWhite = (c: number[]) => near(c, [255, 255, 255]);
const isBlue = (c: number[]) => near(c, BLUE);

test.describe
  .serial("Noise and texture", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let layer: string;

    /** Sets the layer's effects, then waits a couple of frames for them to draw. */
    const set = async (effects: unknown[]) => {
      await page.evaluate(
        ({ id, effects }) =>
          (window as unknown as W).drawpane.setProp([id], "effects", effects, "Effects"),
        { id: layer, effects },
      );
      await page.waitForTimeout(150);
    };

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8877, inspectorPort: 9417 });
      page = instance.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      layer = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const f = e.createLayer("frame", { x: 0, y: 0, width: 400, height: 300 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#ffffff" }],
        }) as string;
        const r = e.createLayer("rect", { x: 100, y: 75, width: 200, height: 150 }, f, {
          fills: [{ type: "solid", color: "#2b4fd6" }],
        }) as string;
        e.select([]);
        e.zoomTo(1);
        e.centerOn({ x: 200, y: 150 });
        return r;
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("grains the layer only where it paints, and holds still as the view pans", async () => {
      // Dense grain: blobs over about a third of the layer (Figma's coverage at 85%).
      await set([{ ...NOISE, density: 85 }]);
      // A grid of points over the layer, clear of its edges.
      const cells = Array.from({ length: 300 }, (_, k) => ({
        x: 103 + 7 * (k % 25) + 0.5,
        y: 78 + 12 * Math.floor(k / 25) + 0.5,
      }));
      const before = await pixels(page, cells);
      const grain = before.filter(isGrain).length;
      const blue = before.filter(isBlue).length;
      // Grain covers some, not most; everything else is the layer's own blue.
      expect(grain).toBeGreaterThan(cells.length * 0.15);
      expect(grain).toBeLessThan(cells.length * 0.6);
      expect(blue).toBeGreaterThan(cells.length * 0.3);
      // Nothing outside the layer.
      const outside = await pixels(page, [
        { x: 60, y: 150 },
        { x: 340, y: 150 },
        { x: 200, y: 40 },
      ]);
      expect(outside.every(isWhite)).toBe(true);
      // Panned, the same page points have the same grain.
      await page.evaluate(() => (window as unknown as W).drawpane.centerOn({ x: 237, y: 131 }));
      await page.waitForTimeout(150);
      expect((await pixels(page, cells)).map(isGrain)).toEqual(before.map(isGrain));
      await page.evaluate(() => (window as unknown as W).drawpane.centerOn({ x: 200, y: 150 }));
    });

    test("roughens the edge past it, or only inward when clipped to the shape", async () => {
      const column = (x: number) => Array.from({ length: 70 }, (_, k) => ({ x, y: 80 + 2 * k }));
      await set([{ ...TEXTURE, visible: false }]);
      // Plain: 2 units outside the left edge is all white, 2 inside all blue.
      expect((await pixels(page, column(98))).every(isWhite)).toBe(true);
      expect((await pixels(page, column(102))).every(isBlue)).toBe(true);

      await set([TEXTURE]);
      const spread = (await pixels(page, column(98))).filter(isBlue).length;
      const eaten = (await pixels(page, column(102))).filter(isWhite).length;
      expect(spread).toBeGreaterThan(3);
      expect(eaten).toBeGreaterThan(3);

      await set([{ ...TEXTURE, clipToShape: true }]);
      expect((await pixels(page, column(98))).every(isWhite)).toBe(true);
      expect((await pixels(page, column(102))).filter(isWhite).length).toBeGreaterThan(3);
    });

    test("are added from the effects menu and set in their editor", async () => {
      await page.evaluate((id) => {
        const e = (window as unknown as W).drawpane;
        e.setProp([id], "effects", null, "Effects");
        e.select([id]);
      }, layer);
      const effects = () =>
        page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.props.effects, layer);
      const inspector = page.getByRole("complementary", { name: "Inspector" });
      await inspector.getByRole("button", { name: "Add effect" }).click();
      await page
        .getByRole("menu", { name: "Add effect" })
        .getByRole("menuitem", { name: "Noise" })
        .click();
      const noise = page.getByRole("dialog", { name: "Noise" });
      await expect(noise.getByRole("radio", { name: "Mono" })).toBeChecked();
      await noise.getByRole("radio", { name: "Duo" }).click();
      await expect(noise.getByText("Colors", { exact: true })).toBeVisible();
      await noise.getByLabel("Density value").fill("30");
      await noise.getByLabel("Density value").press("Enter");
      await expect(inspector.getByRole("button", { name: /^Noise/ })).toContainText("Duo · 30%");
      await expect.poll(effects).toEqual([
        {
          type: "noise",
          noiseType: "duo",
          size: 1,
          density: 30,
          color: "#00000040",
          secondaryColor: "#ffffff40",
          opacity: 25,
        },
      ]);

      // The kind switches in the editor's header, to texture with its own values.
      await noise.getByRole("button", { name: "Effect type: Noise" }).click();
      await page
        .getByRole("menu", { name: "Effect type" })
        .getByRole("menuitemcheckbox", { name: "Texture" })
        .click();
      const texture = page.getByRole("dialog", { name: "Texture" });
      await texture.getByRole("switch", { name: "Clip to shape" }).click();
      await expect
        .poll(effects)
        .toEqual([{ type: "texture", size: 2, radius: 4, clipToShape: true }]);
    });
  });
