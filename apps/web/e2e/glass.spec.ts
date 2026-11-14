/**
 * Glass in a real browser (decision 0007): over a colour ramp, the flat
 * middle shows the backdrop as it is, the rim bends it, and the lit side of
 * the rim brightens; and the effect is added and set from the inspector.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Glass = {
  type: "glass";
  angle: number;
  intensity: number;
  refraction: number;
  depth: number;
  dispersion: number;
  frost: number;
  splay: number;
  visible?: boolean;
};
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
    doc: { get(id: string): { props: Record<string, unknown>; parent: string } | undefined };
  };
};

const BASE: Glass = {
  type: "glass",
  angle: -45,
  intensity: 0,
  refraction: 0,
  depth: 30,
  dispersion: 0,
  frost: 0,
  splay: 0,
};

/** The canvas's colour at a page point. */
function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  return page.evaluate(
    ([x, y]) => {
      const e = (window as unknown as W).drawpane;
      const p = e.s.camera.toScreen({ x, y });
      const canvas = document.querySelector(".canvas canvas") as HTMLCanvasElement;
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      const d = (canvas.getContext("2d") as CanvasRenderingContext2D).getImageData(
        Math.round(p.x * ratio),
        Math.round(p.y * ratio),
        1,
        1,
      ).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0] as [number, number, number];
    },
    [x, y] as const,
  );
}

const distance = (a: number[], b: number[]) =>
  Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? 0))));

test.describe
  .serial("Glass", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let glass: string;

    /** Sets the glass, then waits a couple of frames for it to draw. */
    const set = async (g: Glass) => {
      await page.evaluate(
        ({ id, g }) => (window as unknown as W).drawpane.setProp([id], "effects", [g], "Glass"),
        { id: glass, g },
      );
      await page.waitForTimeout(150);
    };

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8875, inspectorPort: 9415 });
      page = instance.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      glass = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        // A smooth left-to-right ramp: any bend sideways changes the colour seen.
        const f = e.createLayer("frame", { x: 0, y: 0, width: 400, height: 300 }, e.s.pageId, {
          fills: [
            {
              type: "linear",
              from: { x: 0, y: 0.5 },
              to: { x: 1, y: 0.5 },
              stops: [
                { position: 0, color: "#ff0000" },
                { position: 1, color: "#0000ff" },
              ],
            },
          ],
        }) as string;
        // No fill of its own: only the glass shows.
        const g = e.createLayer("rect", { x: 100, y: 75, width: 200, height: 150 }, f, {
          cornerRadius: 20,
          fills: [],
        }) as string;
        e.select([]);
        e.zoomTo(1);
        e.centerOn({ x: 200, y: 150 });
        return g;
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("bends the backdrop over the rim, and leaves the flat middle as it is", async () => {
      await set({ ...BASE, visible: false });
      const middle = await pixel(page, 205, 150);
      const rim = await pixel(page, 106, 150);
      await set({ ...BASE, refraction: 100 });
      // Flat in the middle: the same stripe.
      expect(distance(await pixel(page, 205, 150), middle)).toBeLessThan(12);
      await expect.poll(async () => distance(await pixel(page, 106, 150), rim)).toBeGreaterThan(15);
    });

    test("still bends with noise on the same layer, drawn behind it as it is alone", async () => {
      // Noise makes the layer draw alone first; its glass still reads what's behind it.
      const clear = {
        type: "noise",
        noiseType: "mono",
        size: 1,
        density: 0,
        color: "#000000ff",
        secondaryColor: "#ffffff40",
        opacity: 25,
      };
      await page.evaluate(
        ({ id, effects }) =>
          (window as unknown as W).drawpane.setProp([id], "effects", effects, "Glass"),
        { id: glass, effects: [{ ...BASE, visible: false }, clear] },
      );
      await page.waitForTimeout(150);
      const rim = await pixel(page, 106, 150);
      await page.evaluate(
        ({ id, effects }) =>
          (window as unknown as W).drawpane.setProp([id], "effects", effects, "Glass"),
        { id: glass, effects: [{ ...BASE, refraction: 100 }, clear] },
      );
      await expect.poll(async () => distance(await pixel(page, 106, 150), rim)).toBeGreaterThan(15);
    });

    test("lights the rim on the light's side", async () => {
      // Lit from the left (−90°), nothing bent: the left rim brightens, the middle doesn't.
      await set({ ...BASE, angle: -90, visible: false });
      const left = await pixel(page, 103, 150);
      await set({ ...BASE, angle: -90, intensity: 100 });
      const lit = await pixel(page, 103, 150);
      expect(lit.reduce((a, b) => a + b, 0)).toBeGreaterThan(left.reduce((a, b) => a + b, 0) + 120);
    });

    test("is added from the effects menu with Figma's defaults, and set with its sliders", async () => {
      await page.evaluate((id) => {
        const e = (window as unknown as W).drawpane;
        e.setProp([id], "effects", null, "Effects");
        e.select([id]);
      }, glass);
      const inspector = page.getByRole("complementary", { name: "Inspector" });
      await inspector.getByRole("button", { name: "Add effect" }).click();
      await page
        .getByRole("menu", { name: "Add effect" })
        .getByRole("menuitem", { name: "Glass" })
        .click();
      const editor = page.getByRole("dialog", { name: "Glass" });
      await expect(editor.getByRole("slider", { name: "Light angle" })).toHaveAttribute(
        "aria-valuenow",
        "-45",
      );
      await editor.getByLabel("Refraction value").fill("40");
      await editor.getByLabel("Refraction value").press("Enter");
      await editor.getByRole("slider", { name: "Light angle" }).focus();
      await page.keyboard.press("Shift+ArrowRight");
      const effects = () =>
        page.evaluate(
          (id) => (window as unknown as W).drawpane.doc.get(id)?.props.effects as Glass[],
          glass,
        );
      await expect.poll(effects).toEqual([
        {
          type: "glass",
          angle: -30,
          intensity: 80,
          refraction: 40,
          depth: 20,
          dispersion: 50,
          frost: 4,
          splay: 0,
        },
      ]);
      // Another layer with effects of its own: the editor closes, rather than open on its first.
      await page.evaluate((id) => {
        const e = (window as unknown as W).drawpane;
        const frame = e.doc.get(id)?.parent as string;
        e.setProp([frame], "effects", [{ type: "layer-blur", radius: 0 }], "Blur");
        e.select([frame]);
      }, glass);
      await expect(inspector.getByRole("button", { name: /^Layer blur/ })).toBeVisible();
      await expect(page.getByRole("dialog", { name: /Glass|Layer blur/ })).toHaveCount(0);
    });
  });
