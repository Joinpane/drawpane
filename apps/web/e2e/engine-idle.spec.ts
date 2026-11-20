/**
 * The engine's drawing between frames (decision 0040, phase 2) never swallows a change: an edit
 * that lands after the last moving frame, while a face is still loading and the time between
 * frames has nothing left to draw, is still sent to the engine. It failed before its fix (the
 * re-check of #224, N1): the camera came to rest, the last moving frame stayed on screen, and
 * the idle slice that found nothing to do ended the loop with the edit unsent.
 */
import { expect, test } from "@playwright/test";
import { freshInstance } from "./fresh-instance";

test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      ...(process.env.ENGINE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
    ],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

type Draw = { drawn: boolean; exact: boolean; settled: boolean };
type Ahead = { progressed: boolean; tiles: number; queued: number; text: number };
type View = {
  ahead(pageId: string, background: string, budgetMs: number): Ahead | null;
  draw(...args: unknown[]): Draw;
  last: { tiles: { pending: number } };
  builder: { revision: number; waiting: number; pending: number };
};
type W = {
  drawpane: {
    s: { pageId: string; camera: { pan(dx: number, dy: number): unknown } };
    state: { set(patch: object): void };
    createLayer(type: string, box: object, page: string, props: object): string;
    setProp(ids: string[], name: string, value: unknown): void;
    zoomToFit(): void;
  };
  drawpaneEngineView?: View;
};

test("an edit after the last moving frame is sent while a face is still loading", async ({
  browser,
}) => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  test.setTimeout(120_000);
  const port = Number(process.env.ENGINE_IDLE_PORT ?? 8977);
  const instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const { page } = instance;
    await page.evaluate(() => {
      localStorage.setItem("drawpane:debug", "1");
      localStorage.setItem("drawpane:renderer", "engine");
      localStorage.setItem("drawpane:engine-present", "readback");
      localStorage.setItem("drawpane:engine-software", "allow");
      // The face stays loading for the whole test, past the shaper's deadline.
      localStorage.setItem("drawpane:face-deadline-ms", "600000");
    });
    await page.reload();
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect
      .poll(() => page.evaluate(() => Boolean((window as unknown as W).drawpaneEngineView)), {
        timeout: 30_000,
      })
      .toBe(true);
    // The text's face never arrives while the test runs (its record stays provisional), nor does
    // the page's CSS face for it: nothing but the edit wakes the editor.
    await page.route(
      (url) => url.pathname.endsWith("/google.css"),
      async (route) => {
        await hold;
        await route.abort().catch(() => {});
      },
    );
    const rect = await page.evaluate(() => {
      const e = (window as unknown as W).drawpane;
      const id = e.createLayer("rect", { x: 0, y: 0, width: 256, height: 256 }, e.s.pageId, {
        fills: [{ type: "solid", color: "#ff0000" }],
      });
      e.createLayer("text", { x: 24, y: 24, width: 180, height: 32 }, e.s.pageId, {
        characters: "Pending face",
        fontFamily: "Inter",
        fontSize: 24,
      });
      e.zoomToFit();
      return id;
    });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const v = (window as unknown as W).drawpaneEngineView;
            return (
              !!v && v.builder.waiting > 0 && v.builder.pending === 0 && v.last.tiles.pending === 0
            );
          }),
        { timeout: 30_000 },
      )
      .toBe(true);
    const out = await page.evaluate(async (rect) => {
      const w = window as unknown as W;
      const view = w.drawpaneEngineView as View;
      const e = w.drawpane;
      const next = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      for (let i = 0; i < 12; i++) await next();
      const start = view.builder.revision;
      const draw = view.draw.bind(view);
      let warm: Ahead | null = null;
      let moving: Draw | undefined;
      view.draw = (...args) => {
        const result = draw(...args);
        if (!moving && args[7] === false) {
          moving = result;
          // Nothing left for the time between frames: every optional tile drawn now.
          for (let i = 0; i < 20; i++) {
            warm = view.ahead(e.s.pageId, args[5] as string, 0);
            if (!warm?.progressed) break;
          }
          // The edit lands after the moving frame, before the next animation frame.
          queueMicrotask(() => e.setProp([rect], "fills", [{ type: "solid", color: "#00ff00" }]));
        }
        return result;
      };
      e.state.set({ camera: e.s.camera.pan(1, 0) });
      for (let i = 0; i < 15; i++) await next();
      view.draw = draw;
      return { start, end: view.builder.revision, moving, warm, waiting: view.builder.waiting };
    }, rect);
    expect(out.warm).toMatchObject({ progressed: false, tiles: 0 });
    expect(out.moving).toMatchObject({ drawn: true, exact: false, settled: true });
    expect(out.waiting).toBeGreaterThan(0);
    expect(out.end, JSON.stringify(out)).toBeGreaterThan(out.start);
  } finally {
    release();
    await instance.stop();
  }
});
