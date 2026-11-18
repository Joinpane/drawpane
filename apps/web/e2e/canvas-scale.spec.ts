/**
 * Drawing a large page a little at a time (decision 0028) ends where a
 * whole frame drawn at once does. A kit-shaped file big enough to be drawn
 * gradually is opened, fitted, panned, zoomed and edited; each time, once
 * the canvas settles, it's compared pixel for pixel with the same view
 * drawn afresh in full by a renderer of its own.
 */
import { generateKit } from "@drawpane/corpus";
import type { NodeRecord } from "@drawpane/model";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Camera = {
  pan(dx: number, dy: number): Camera;
  zoomAt(p: { x: number; y: number }, zoom: number): Camera;
  zoom: number;
};
type W = {
  drawpane: {
    state: { set(patch: { camera: Camera }): void };
    s: { camera: Camera; viewport: { width: number; height: number }; pageId: string };
    doc: {
      apply(ops: unknown[]): unknown;
      nodes(): Iterable<NodeRecord>;
      reset(nodes: Iterable<unknown>): void;
      get(id: string): NodeRecord | undefined;
      childIds(id: string): readonly string[];
      pageOf(id: string): NodeRecord | undefined;
    };
    scene: { bounds(id: string): { x: number; y: number; width: number; height: number } | null };
    visibleArea(): { x: number; y: number; width: number; height: number } | null;
    setPage(id: string): void;
    zoomToFit(): void;
    zoomTo(zoom: number): void;
    centerOn(p: { x: number; y: number }): void;
  };
  drawpaneFrames: {
    exact: boolean;
    compare(): { pixels: number; differing: number; max: number } | null;
  };
};

/** Waits until the canvas has been exact for a while: no stand-in, nothing left to draw. */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const f = (window as unknown as W).drawpaneFrames;
          if (!f.exact) return false;
          await new Promise((r) => setTimeout(r, 300));
          return f.exact;
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
}

/**
 * The canvas as it settled against the same view drawn whole, at once, on
 * the same canvas. Tiles, like the strips a pan uncovers, are drawn clipped
 * to their edges, and Chromium's software rasteriser antialiases a shape
 * crossing a clip edge a shade differently there: a few pixels along the
 * edges (measured: 40 pixels of 1.3 million, by at most 6 levels, for a
 * first frame drawn in tiles; about 2,400 by at most 25 after these 30 pans,
 * as before decision 0028; small icons on an edge by up to about 50). A tile
 * drawn wrong or left out, or a change not drawn, is far more.
 */
async function compare(page: Page): Promise<void> {
  const result = await page.evaluate(() => (window as unknown as W).drawpaneFrames.compare());
  expect(result).not.toBeNull();
  if (!result) return;
  const detail = JSON.stringify(result);
  expect(result.differing / result.pixels, detail).toBeLessThan(0.003);
  expect(result.max, detail).toBeLessThanOrEqual(80);
}

test.describe
  .serial("A large page drawn a little at a time", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
    let instance: Instance;
    let page: Page;
    let kit: ReturnType<typeof generateKit>;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(240_000);
      instance = await freshInstance(browser, { port: 8853, inspectorPort: 9393 });
      page = instance.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 30_000,
      });
      // Big enough (over 30,000 layers) that a page's first frame is drawn gradually.
      kit = generateKit({ layers: 45_000 });
      const body = JSON.stringify(kit.nodes);
      await page.route("**/__kit", (route) =>
        route.fulfill({ contentType: "application/json", body }),
      );
      await page.evaluate(async () => {
        const e = (window as unknown as W).drawpane;
        const nodes = (await (await fetch("/__kit")).json()) as unknown[];
        e.doc.reset([...e.doc.nodes(), ...nodes]);
      });
      await page.unroute("**/__kit");
    });
    test.afterAll(async () => {
      await instance?.stop();
    });

    test("the first frame of the largest page, fitted", async () => {
      const counts = new Map<string, number>();
      const parent = new Map(kit.nodes.map((n) => [n.id, n.parent]));
      const pages = new Set(kit.nodes.filter((n) => n.type === "page").map((n) => n.id));
      for (const n of kit.nodes) {
        let at = n.parent;
        while (at && !pages.has(at)) at = parent.get(at) ?? "";
        if (at) counts.set(at, (counts.get(at) ?? 0) + 1);
      }
      const largest = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] as string;
      const first = await page.evaluate(async (id) => {
        const e = (window as unknown as W).drawpane;
        e.setPage(id);
        e.zoomToFit();
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );
        return (window as unknown as W).drawpaneFrames.exact;
      }, largest);
      // Drawn gradually: the first frames are stand-ins.
      expect(first).toBe(false);
      await settled(page);
      await compare(page);
    });

    test("panned while it's still being drawn", async () => {
      await page.evaluate(async () => {
        const e = (window as unknown as W).drawpane;
        const c = e.s.viewport;
        e.state.set({
          camera: e.s.camera.zoomAt({ x: c.width / 2, y: c.height / 2 }, e.s.camera.zoom * 3),
        });
        for (let i = 0; i < 30; i++) {
          e.state.set({ camera: e.s.camera.pan(i % 2 ? 37 : -11, 23) });
          await new Promise((r) => requestAnimationFrame(r));
        }
      });
      await settled(page);
      await compare(page);
    });

    test("zoomed far out and back in", async () => {
      await page.evaluate(async () => {
        const e = (window as unknown as W).drawpane;
        const c = { x: e.s.viewport.width / 2, y: e.s.viewport.height / 2 };
        for (let i = 0; i < 40; i++) {
          const factor = i < 20 ? 1 / 1.15 : 1.12;
          e.state.set({ camera: e.s.camera.zoomAt(c, e.s.camera.zoom * factor) });
          await new Promise((r) => requestAnimationFrame(r));
        }
      });
      await settled(page);
      await compare(page);
    });

    test("edited: a main whose copies are everywhere, then layers moved up close", async () => {
      await page.evaluate(() => (window as unknown as W).drawpane.zoomToFit());
      await settled(page);
      // The main with the most copies on this page that are big enough to see whole: a change all
      // over the canvas, drawn a little at a time.
      const main = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const count = new Map<string, number>();
        for (const n of e.doc.nodes()) {
          const of = n.props.instanceOf as string | undefined;
          if (!of || e.doc.pageOf(n.id)?.id !== e.s.pageId) continue;
          if (((e.doc.get(of)?.props.width as number) ?? 0) < 150) continue;
          count.set(of, (count.get(of) ?? 0) + 1);
        }
        return [...count].sort((a, b) => b[1] - a[1])[0] ?? null;
      });
      expect(main?.[1]).toBeGreaterThan(20);
      // Applied to the document as the main's edit is, with every copy following it. (Not
      // committed: the server never had this file, and would turn the edit back.)
      await page.evaluate((id) => {
        const e = (window as unknown as W).drawpane;
        const fills = [{ type: "solid", color: "#e8590c" }];
        const ops = [{ op: "set", id, prop: "fills", value: fills }];
        for (const n of e.doc.nodes())
          if (n.props.instanceOf === id)
            ops.push({ op: "set", id: n.id, prop: "fills", value: fills });
        e.doc.apply(ops);
      }, main?.[0] as string);
      await settled(page);
      await compare(page);

      // Up close on a screen: a change drawn where it was and is, in the same frame.
      const screen = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const ids = e.doc.childIds(e.s.pageId);
        const id = ids[Math.floor(ids.length / 2)] as string;
        const b = e.scene.bounds(id) as { x: number; y: number; width: number; height: number };
        e.zoomTo(0.5);
        e.centerOn({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
        return id;
      });
      await settled(page);
      await page.evaluate(async (id) => {
        const e = (window as unknown as W).drawpane;
        // Dragged a little way, frame by frame, then filled.
        const x = e.doc.get(id)?.props.x as number;
        for (let i = 1; i <= 5; i++) {
          e.doc.apply([{ op: "set", id, prop: "x", value: x + i * 12 }]);
          await new Promise((r) => requestAnimationFrame(r));
        }
        e.doc.apply([
          { op: "set", id, prop: "fills", value: [{ type: "solid", color: "#1f2a6b" }] },
        ]);
      }, screen);
      await settled(page);
      await compare(page);
    });

    test("with glass and background blur on its screens: drawn in tiles, then the readers", async () => {
      // Layers that read the backdrop read what's drawn around them: tiles draw them without it,
      // and each is drawn again with all it reads once the tiles are done.
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const ops: unknown[] = [];
        e.doc.childIds(e.s.pageId).forEach((id, i) => {
          if (i % 3 === 2) return;
          const effect =
            i % 3 === 0
              ? {
                  type: "glass",
                  angle: -45,
                  intensity: 80,
                  refraction: 80,
                  depth: 20,
                  dispersion: 50,
                  frost: 4,
                  splay: 0,
                }
              : { type: "background-blur", radius: 12 };
          ops.push({ op: "set", id, prop: "effects", value: [effect] });
          ops.push({
            op: "set",
            id,
            prop: "fills",
            value: [{ type: "solid", color: "#ffffff", opacity: 0.4 }],
          });
        });
        e.doc.apply(ops);
        e.zoomToFit();
      });
      await settled(page);
      await compare(page);
      // Closer, panned while it's still being drawn, then far out and back in.
      await page.evaluate(async () => {
        const e = (window as unknown as W).drawpane;
        const c = { x: e.s.viewport.width / 2, y: e.s.viewport.height / 2 };
        e.state.set({ camera: e.s.camera.zoomAt(c, e.s.camera.zoom * 3) });
        for (let i = 0; i < 30; i++) {
          e.state.set({ camera: e.s.camera.pan(i % 2 ? 37 : -11, 23) });
          await new Promise((r) => requestAnimationFrame(r));
        }
      });
      await settled(page);
      await compare(page);
      await page.evaluate(async () => {
        const e = (window as unknown as W).drawpane;
        const c = { x: e.s.viewport.width / 2, y: e.s.viewport.height / 2 };
        for (let i = 0; i < 30; i++) {
          const factor = i < 15 ? 1 / 1.15 : 1.15;
          e.state.set({ camera: e.s.camera.zoomAt(c, e.s.camera.zoom * factor) });
          await new Promise((r) => requestAnimationFrame(r));
        }
      });
      await settled(page);
      await compare(page);
    });
  });
