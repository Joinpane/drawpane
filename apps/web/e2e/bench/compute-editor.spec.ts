/**
 * The editor's checked compute frames (decision 0040, P1-0) on a real GPU, through the editor
 * itself (`?renderer=engine&compute=1`, read-back presentation): a frame staged under one
 * background must never be shown, let alone reported exact, after the background changed while
 * it was being checked (the stack review's live T4 repro showed the old background as exact).
 * Moving frames stay on vello_gpu: a checked frame takes two or three display frames to show, so
 * motion must not wait for one. Both hold for checked frames and for the bump gate's
 * (`?gate=1`), whose re-check found the old background reported exact and motion drawn
 * through it. Runs only with `BENCH_COMPUTE_MATRIX=1`, on `pnpm gpu-bench --modes webgpu`.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";

test.use({ trace: "off" });

/**
 * A new file in the editor with one white board, on compute with read-back presentation, its
 * still frames checked or (`gated`, `?gate=1`) presented through the bump gate.
 */
async function openBoard(instance: Instance, gated: boolean): Promise<Page> {
  const p = await instance.context.newPage();
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.goto(`${instance.url}/`);
  await p.evaluate(() => {
    localStorage.setItem("drawpane:debug", "1");
    localStorage.setItem("drawpane:renderer", "engine");
    localStorage.setItem("drawpane:engine-present", "readback");
  });
  await p.getByRole("button", { name: "New file" }).first().click({ timeout: 20_000 });
  await p.waitForURL(/\/f\//, { timeout: 30_000 });
  await p.goto(`${p.url().split("?")[0]}?renderer=engine&compute=1${gated ? "&gate=1" : ""}`);
  await p.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { drawpaneEngineView?: { engine?: { gpu?: unknown } } })
          .drawpaneEngineView?.engine?.gpu,
      ),
    undefined,
    { timeout: 45_000 },
  );
  await p.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the editor's debug handles
    const w = window as any;
    const pageId = w.drawpane.s.pageId;
    const page = [...w.drawpane.doc.stored()].find((n: { id: string }) => n.id === pageId);
    w.drawpane.doc.resetStored(
      [
        page,
        {
          id: "board",
          type: "frame",
          parent: pageId,
          key: "a0",
          props: {
            name: "Board",
            x: 400,
            y: 300,
            width: 300,
            height: 200,
            fills: [{ type: "solid", color: "#ffffff" }],
          },
        },
      ],
      "materialized",
    );
    const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    for (let i = 0; i < 240 && !(w.drawpaneFrames?.exact && w.drawpaneEngineView?.last?.exact); i++)
      await raf();
  });
  return p;
}

test.describe("Checked compute frames in the editor", () => {
  test.skip(process.env.BENCH_COMPUTE_MATRIX !== "1", "set BENCH_COMPUTE_MATRIX=1 on a real GPU");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const port = Number(process.env.BENCH_PORT ?? 8927);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
  });

  test.afterAll(async () => {
    await instance?.stop();
  });

  for (const mode of ["checked", "gated"] as const) {
    test(`${mode}: a background change while a frame is checked shows the new background`, async () => {
      test.setTimeout(6 * 60_000);
      const p = await openBoard(instance, mode === "gated");
      const result = await p.evaluate(async () => {
        // biome-ignore lint/suspicious/noExplicitAny: the editor's debug handles
        const w = window as any;
        const pageId = w.drawpane.s.pageId;
        const view = w.drawpaneEngineView;
        // Quiet the editor's own loop, then drive the view by hand.
        const editorChange = view.onChange;
        let landed = false;
        view.onChange = () => {
          landed = true;
        };
        const canvas = view.canvas as HTMLCanvasElement;
        const cam = w.drawpane.s.camera;
        const dpr = window.devicePixelRatio || 1;
        const state = { hidden: new Set(), whole: null };
        const draw = (bg: string) =>
          view.draw(pageId, cam, canvas.width, canvas.height, dpr, bg, state, true, 0);
        // Put a compute frame under #112233 in flight (the first draw of a new background is
        // vello_gpu's; the next one stages a checked frame, or presents a gated one), and let
        // its check land.
        let staged = false;
        for (let i = 0; i < 30 && !staged; i++) {
          staged = Boolean(draw("#112233").awaitingPreview) || view.engine.computeUsed();
          if (!staged) await new Promise((r) => setTimeout(r, 16));
        }
        landed = false;
        for (let t = 0; t < 300 && !landed; t++) await new Promise((r) => setTimeout(r, 10));
        // The page now asks for #ff00ff at the same camera. Draw until compute shows an exact
        // frame; nothing exact may show the old background on the way.
        const frames = [];
        let computeUsed = false;
        for (let i = 0; i < 120; i++) {
          const frame = draw("#ff00ff");
          computeUsed = view.engine.computeUsed();
          frames.push({ ...frame, compute: computeUsed });
          if (frame.exact && computeUsed) break;
          await new Promise((r) => setTimeout(r, 16));
        }
        // Let the read-back of that frame land on the canvas.
        await new Promise((r) => setTimeout(r, 400));
        view.onChange = editorChange;
        const pixel = Array.from(canvas.getContext("2d")?.getImageData(5, 5, 1, 1).data ?? []);
        return {
          staged,
          frames,
          exact: view.last.exact,
          computeUsed,
          fallback: view.computeFallbackReason,
          pixel,
        };
      });
      test.info().annotations.push({ type: "bench", description: JSON.stringify(result) });
      console.log(JSON.stringify(result));
      expect(result.fallback).toBeNull();
      expect(result.staged).toBe(true);
      expect(result.computeUsed).toBe(true);
      // After the first frame (vello_gpu's, for the new background), only compute's own frame
      // for #ff00ff may be reported exact: a check from under #112233 settling as exact was the
      // gate's re-check bug.
      expect(
        result.frames
          .slice(1)
          .filter((f: { exact: boolean; compute: boolean }) => f.exact && !f.compute),
      ).toEqual([]);
      // Whatever was reported exact shows the background asked for.
      expect(result.exact).toBe(true);
      expect(result.pixel.slice(0, 3)).toEqual([255, 0, 255]);
      await p.close();
    });
    test(`${mode}: moving frames stay on vello_gpu and drop the candidate being checked`, async () => {
      test.setTimeout(6 * 60_000);
      const p = await openBoard(instance, mode === "gated");
      const result = await p.evaluate(async () => {
        // biome-ignore lint/suspicious/noExplicitAny: the editor's debug handles
        const w = window as any;
        const pageId = w.drawpane.s.pageId;
        const view = w.drawpaneEngineView;
        const editorChange = view.onChange;
        view.onChange = () => {};
        const canvas = view.canvas as HTMLCanvasElement;
        const cam = w.drawpane.s.camera;
        const dpr = window.devicePixelRatio || 1;
        const state = { hidden: new Set(), whole: null };
        const draw = (c: { x: number; y: number; zoom: number }, exact: boolean) =>
          view.draw(pageId, c, canvas.width, canvas.height, dpr, "#f4f4f2", state, exact, 0);
        const wait = () => new Promise((r) => setTimeout(r, 16));
        // A still view: compute shows it once its check lands.
        let still = false;
        for (let i = 0; i < 120 && !still; i++) {
          still = Boolean(draw(cam, true).exact) && view.engine.computeUsed();
          if (!still) await wait();
        }
        // Stage a candidate for a new still camera, then start moving before it lands.
        let staged = false;
        for (let i = 0; i < 30 && !staged; i++) {
          // A checked candidate waits; a gated frame was presented and its check is in flight.
          const f = draw({ ...cam, x: cam.x + 40 }, true);
          staged = Boolean(f.awaitingPreview) || (view.engine.computeUsed() && !f.exact);
          if (!staged) await wait();
        }
        const motion = [];
        for (let i = 0; i < 8; i++) {
          const frame = draw({ ...cam, x: cam.x + 40 + 6 * (i + 1) }, false);
          motion.push({
            drawn: frame.drawn,
            waiting: Boolean(frame.awaitingPreview),
            compute: view.engine.computeUsed(),
          });
          await wait();
        }
        view.onChange = editorChange;
        return { still, staged, motion, fallback: view.computeFallbackReason };
      });
      test.info().annotations.push({ type: "bench", description: JSON.stringify(result) });
      console.log(JSON.stringify(result));
      expect(result.fallback).toBeNull();
      expect(result.still).toBe(true);
      expect(result.staged).toBe(true);
      // Every moving frame drew at once on vello_gpu: none waited for a check, none used compute.
      expect(result.motion).toEqual(
        Array.from({ length: 8 }, () => ({ drawn: true, waiting: false, compute: false })),
      );
      await p.close();
    });
  }
});
