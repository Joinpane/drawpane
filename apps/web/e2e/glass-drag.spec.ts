/**
 * Glass and background blur never vanish while something moves. Frosted
 * glass over sharp black and white stripes evens them out; a plain
 * translucent fill shows them as they are. While a glass layer is dragged
 * among others, and while the view pans and zooms, every frame's pixels
 * inside the dragged layer, glass under it, over it and beside it, and a
 * background blur must stay evened out: a reader left out of a frame
 * (drawn as its fill alone) or drawn in part (a seam where a redrawn part
 * meets the rest) shows stripes.
 *
 * The canvas's budget is made tiny (`drawpaneFrames.budget`), so every frame
 * costs more than it, as a glass-heavy board does on a slow machine: readers
 * are then drawn coarse while moving, exactly once still.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type P = { x: number; y: number };
type W = {
  drawpane: {
    s: { pageId: string; camera: { toScreen(p: P): P; zoom: number } };
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
    zoomTo(z: number): void;
    centerOn(p: P): void;
    setCamera(c: unknown): void;
    scene: { bounds(id: string): { x: number; y: number; width: number; height: number } | null };
    state: { set(patch: { camera: unknown }): void };
  };
  drawpaneFrames: {
    budget: number | null;
    exact: boolean;
    record(content: number, overlay: number): void;
  };
  __stripes?: { probes: string[]; worst: Record<string, number>; frames: number; ms: number[] };
};

const FROST = {
  type: "glass",
  angle: -45,
  intensity: 40,
  refraction: 40,
  depth: 30,
  dispersion: 0,
  frost: 16,
  splay: 0,
};

/**
 * Starts watching: after every frame the canvas draws, how far apart the
 * lightest and darkest pixels are along a line across the middle of each
 * probe layer (as it is then), the worst seen kept per probe.
 */
async function watch(page: Page, probes: Record<string, string>): Promise<void> {
  await page.evaluate((probes) => {
    const w = window as unknown as W;
    const canvas = document.querySelector(".canvas canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    const state = {
      probes: Object.keys(probes),
      worst: {} as Record<string, number>,
      frames: 0,
      ms: [] as number[],
    };
    w.__stripes = state;
    const record = w.drawpaneFrames.record.bind(w.drawpaneFrames);
    w.drawpaneFrames.record = (content: number, overlay: number) => {
      record(content, overlay);
      state.frames++;
      state.ms.push(Math.round(content));
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      for (const [name, id] of Object.entries(probes)) {
        const b = w.drawpane.scene.bounds(id);
        if (!b) continue;
        // The middle half of the layer, across, at half height: away from the rim's bend.
        const a = w.drawpane.s.camera.toScreen({ x: b.x + b.width * 0.25, y: b.y + b.height / 2 });
        const z = w.drawpane.s.camera.toScreen({ x: b.x + b.width * 0.75, y: b.y + b.height / 2 });
        const x0 = Math.round(a.x * ratio);
        const width = Math.max(1, Math.round((z.x - a.x) * ratio));
        if (x0 < 0 || x0 + width > canvas.width) continue;
        const row = ctx.getImageData(x0, Math.round(a.y * ratio), width, 1).data;
        let lo = 255;
        let hi = 0;
        for (let i = 0; i < row.length; i += 4) {
          const l = ((row[i] ?? 0) + (row[i + 1] ?? 0) + (row[i + 2] ?? 0)) / 3;
          lo = Math.min(lo, l);
          hi = Math.max(hi, l);
        }
        state.worst[name] = Math.max(state.worst[name] ?? 0, hi - lo);
      }
    };
  }, probes);
}

async function result(
  page: Page,
): Promise<{ worst: Record<string, number>; frames: number; ms: number[] }> {
  return page.evaluate(() => {
    const s = (window as unknown as W).__stripes as NonNullable<W["__stripes"]>;
    return { worst: s.worst, frames: s.frames, ms: s.ms };
  });
}

const settle = (page: Page) =>
  page.waitForFunction(() => (window as unknown as W).drawpaneFrames.exact, undefined, {
    timeout: 120_000,
    polling: 100,
  });

test.describe
  .serial("Glass while moving", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
    let instance: Instance;
    let page: Page;
    let ids: { dragged: string; neighbour: string; under: string; over: string; blur: string };

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8997, inspectorPort: 9537 });
      page = instance.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      ids = await page.evaluate((frost) => {
        const e = (window as unknown as W).drawpane;
        const board = e.createLayer("frame", { x: 0, y: 0, width: 1200, height: 700 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#ffffff" }],
        }) as string;
        // Sharp stripes, 12 wide: frost evens them out, a plain fill doesn't.
        for (let i = 0; i < 50; i++)
          e.createLayer("rect", { x: i * 24, y: 0, width: 12, height: 700 }, board, {
            fills: [{ type: "solid", color: "#000000" }],
          });
        const glass = (x: number, y: number) =>
          e.createLayer("rect", { x, y, width: 240, height: 200 }, board, {
            cornerRadius: 40,
            fills: [{ type: "solid", color: "#ffffff", opacity: 0.2 }],
            effects: [frost],
          }) as string;
        const under = glass(300, 120);
        // Glass all over the board, overlapping: what a drag passes by reads them.
        for (const [x, y] of [
          [40, 60],
          [60, 380],
          [620, 80],
          [860, 360],
          [900, 60],
        ])
          glass(x as number, y as number);
        const neighbour = glass(560, 330);
        const blur = e.createLayer("rect", { x: 320, y: 420, width: 220, height: 180 }, board, {
          cornerRadius: 24,
          fills: [{ type: "solid", color: "#ffffff", opacity: 0.2 }],
          effects: [{ type: "background-blur", radius: 24 }],
        }) as string;
        const dragged = glass(380, 200);
        // One over the dragged layer, across its path.
        const over = glass(600, 160);
        e.select([]);
        e.zoomTo(1);
        e.centerOn({ x: 600, y: 350 });
        return { dragged, neighbour, under, over, blur };
      }, FROST);
      await settle(page);
      await page.waitForTimeout(500);
      await settle(page);
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    const probes = () => ({
      dragged: ids.dragged,
      neighbour: ids.neighbour,
      under: ids.under,
      over: ids.over,
      blur: ids.blur,
    });
    // Black and white stripes under a 20% white fill: about 200 apart; frosted, far less.
    const PLAIN = 120;

    test("still, every reader evens the stripes out", async () => {
      await watch(page, probes());
      await page.evaluate(() =>
        (window as unknown as { drawpaneFrames: { redraw(): void } }).drawpaneFrames.redraw(),
      );
      await settle(page);
      const { worst } = await result(page);
      for (const name of Object.keys(probes()))
        expect(worst[name], `${name} when still`).toBeLessThan(PLAIN);
    });

    test("never loses glass or blur while a layer is dragged", async () => {
      test.setTimeout(300_000);
      await page.evaluate(() => {
        (window as unknown as W).drawpaneFrames.budget = 0.5;
      });
      await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), ids.dragged);
      const at = await page.evaluate((id) => {
        const e = (window as unknown as W).drawpane;
        const b = e.scene.bounds(id) as { x: number; y: number; width: number; height: number };
        const p = e.s.camera.toScreen({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
        const r = (
          document.querySelector(".canvas canvas") as HTMLCanvasElement
        ).getBoundingClientRect();
        return { x: r.left + p.x, y: r.top + p.y };
      }, ids.dragged);
      await watch(page, probes());
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      for (let i = 1; i <= 16; i++) {
        await page.mouse.move(at.x + i * 9, at.y + i * 4);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      }
      const moving = await result(page);
      console.log(`drag: content ms per frame ${moving.ms.join(" ")}`);
      await page.mouse.up();
      await settle(page);
      const still = await result(page);
      await page.evaluate(() => {
        (window as unknown as W).drawpaneFrames.budget = null;
      });
      expect(moving.frames).toBeGreaterThan(8);
      for (const name of Object.keys(probes())) {
        expect(moving.worst[name], `${name} while dragging`).toBeLessThan(PLAIN);
        expect(still.worst[name], `${name} after`).toBeLessThan(PLAIN);
      }
    });

    test("never loses glass or blur while the view pans and zooms", async () => {
      test.setTimeout(300_000);
      await page.evaluate(() => {
        (window as unknown as W).drawpaneFrames.budget = 0.5;
      });
      await watch(page, probes());
      await page.evaluate(async () => {
        type C = { pan(dx: number, dy: number): C; zoomAt(p: P, z: number): C; zoom: number };
        const e = (window as unknown as W).drawpane as unknown as {
          s: { camera: C; viewport: { width: number; height: number } };
          state: { set(patch: { camera: C }): void };
        };
        const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
        for (let i = 0; i < 20; i++) {
          const d = i < 10 ? 7 : -7;
          e.state.set({ camera: e.s.camera.pan(d, d / 2) });
          await frame();
        }
        const c = { x: e.s.viewport.width / 2, y: e.s.viewport.height / 2 };
        for (let i = 0; i < 10; i++) {
          e.state.set({
            camera: e.s.camera.zoomAt(c, e.s.camera.zoom * (i < 5 ? 1.04 : 1 / 1.04)),
          });
          await frame();
        }
      });
      const moving = await result(page);
      await page.evaluate(() => {
        (window as unknown as W).drawpaneFrames.budget = null;
      });
      await settle(page);
      for (const name of Object.keys(probes()))
        expect(moving.worst[name], `${name} while panning and zooming`).toBeLessThan(PLAIN);
    });
  });
