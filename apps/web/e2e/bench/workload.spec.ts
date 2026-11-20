/**
 * Regression tests for benchmark workload parity and context geometry:
 * - Canvas and Engine fixtures build the exact same shadow-free scene by default (0 drop-shadows).
 * - Manual benchmark contexts keep the configured 1440 x 900 viewport at 2x DPR.
 */
import { expect, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { benchShadows, buildFile } from "./cards";
import {
  captureRendererState,
  verifyEngineBenchmark,
  verifyScenarioCheckpoint,
} from "./engine-gate";

test.describe("Benchmark workload parity", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const port = Number(process.env.WORKLOAD_PORT ?? 47471);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("uses the configured 1440x900 @ 2x DPR benchmark viewport", async () => {
    const observed = await instance.page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
    }));
    expect(observed).toEqual({ width: 1440, height: 900, dpr: 2 });
  });

  test("builds matched shadow-free scenes for both Canvas and Engine by default", async () => {
    expect(benchShadows({ BENCH_RENDERER: "canvas" })).toBe(false);
    expect(benchShadows({ BENCH_RENDERER: "engine" })).toBe(false);
    expect(benchShadows({ BENCH_RENDERER: "canvas", BENCH_NO_EFFECTS: "1" })).toBe(false);
    expect(
      benchShadows({ BENCH_RENDERER: "canvas", BENCH_SHADOWS: "1", BENCH_NO_EFFECTS: "1" }),
    ).toBe(false);
    expect(benchShadows({ BENCH_RENDERER: "canvas", BENCH_SHADOWS: "1" })).toBe(true);
    expect(benchShadows({ BENCH_RENDERER: "engine", BENCH_SHADOWS: "1" })).toBe(true);

    const countShadows = async (shadows: boolean) => {
      const page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await page.evaluate(() => {
        type Op = { props?: { effects?: Array<{ type: string }> } };
        const doc = (window as unknown as { drawpane: { doc: { apply(ops: Op[]): void } } })
          .drawpane.doc;
        const apply = doc.apply.bind(doc);
        (window as unknown as { benchShadowCount: number }).benchShadowCount = -1;
        doc.apply = (ops: Op[]) => {
          if (ops.length === 10_000) {
            (window as unknown as { benchShadowCount: number }).benchShadowCount = ops
              .flatMap((op) => op.props?.effects ?? [])
              .filter((effect) => effect.type === "drop-shadow").length;
          }
          return apply(ops);
        };
      });
      expect(await buildFile(page, 400, shadows)).toBe(10_000);
      const count = await page.evaluate(
        () => (window as unknown as { benchShadowCount: number }).benchShadowCount,
      );
      await page.goto("/");
      return count;
    };

    const canvasCount = await countShadows(benchShadows({ BENCH_RENDERER: "canvas" }));
    const engineCount = await countShadows(benchShadows({ BENCH_RENDERER: "engine" }));
    expect(canvasCount).toBe(0);
    expect(engineCount).toBe(0);
    expect(engineCount).toBe(canvasCount);
  });

  test("in-app presentation gate rejects a transparent engine layer under a painted overlay and unidentified adapters", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 240 } });
    try {
      const page = await ctx.newPage();
      await page.setContent(`
        <div class="canvas"
          data-renderer="webgpu"
          data-renderer-adapter="unidentified"
          data-renderer-adapter-class="unidentified"
          data-renderer-presentation="direct"
          data-renderer-software="false"
          data-renderer-presented="true"
          data-renderer-frames="1"
          data-renderer-fallback-frames="0"
          style="width:240px;height:180px;position:relative;background:white">
          <canvas class="canvas__layer" data-canvas-role="content" width="240" height="180" style="visibility:hidden;position:absolute"></canvas>
          <canvas id="engineLayer" class="canvas__layer" data-canvas-role="engine" width="240" height="180" style="visibility:visible;position:absolute"></canvas>
          <canvas id="overlayLayer" class="canvas__layer canvas__overlay" data-canvas-role="overlay" width="240" height="180" style="position:absolute"></canvas>
        </div>
      `);
      const before = await captureRendererState(page);
      await page.evaluate(() => {
        const ctx2 = (document.querySelector("#overlayLayer") as HTMLCanvasElement).getContext(
          "2d",
        );
        if (ctx2) {
          ctx2.fillStyle = "#f00";
          ctx2.fillRect(30, 30, 180, 100);
        }
        (document.querySelector(".canvas") as HTMLElement).dataset.rendererFrames = "2";
      });

      // 1. Transparent engine canvas + painted overlay + unidentified adapter must FAIL.
      await expect(
        verifyEngineBenchmark(page, before, "transparent engine + unidentified"),
      ).rejects.toThrow(/unidentified|blank/i);

      // 2. Even with a hardware adapter label, a transparent engine canvas under a red overlay must FAIL.
      await page.evaluate(() => {
        const host = document.querySelector(".canvas") as HTMLElement;
        host.dataset.rendererAdapter = "NVIDIA Tesla T4";
        host.dataset.rendererAdapterClass = "hardware";
      });
      await expect(
        verifyEngineBenchmark(page, before, "transparent engine + hardware label"),
      ).rejects.toThrow(/blank/i);

      // 3. Once the engine canvas itself paints content, verification PASSES and restores overlay visibility.
      await page.evaluate(() => {
        const ectx = (document.querySelector("#engineLayer") as HTMLCanvasElement).getContext("2d");
        if (ectx) {
          ectx.fillStyle = "#ebeae6";
          ectx.fillRect(0, 0, 240, 180);
          ectx.fillStyle = "#2b4fd6";
          ectx.fillRect(40, 40, 120, 80);
        }
      });
      const ok = await verifyEngineBenchmark(page, before, "painted engine layer");
      expect(ok.compositedNonBlank).toBe(true);
      const overlayVis = await page
        .locator("#overlayLayer")
        .evaluate((el) => getComputedStyle(el).visibility);
      expect(overlayVis).toBe("visible");

      // 4. Backend binding: when the standalone gate only verified webgl2, running on webgpu fails.
      await expect(
        verifyEngineBenchmark(page, before, "backend mismatch", {
          expectedBackends: ["webgl2"],
        }),
      ).rejects.toThrow(/not verified by the standalone GPU gate/i);

      // 5. Unverified "unknown" WebGPU adapter is rejected unless webgpu is in expectedBackends.
      await page.evaluate(() => {
        const host = document.querySelector(".canvas") as HTMLElement;
        host.dataset.renderer = "webgpu";
        host.dataset.rendererAdapter = "WebGPU";
        host.dataset.rendererAdapterClass = "unknown";
      });
      await expect(
        verifyEngineBenchmark(page, before, "unverified unknown webgpu"),
      ).rejects.toThrow(/refusing unverified WebGPU adapter/i);
      const verifiedUnknown = await verifyEngineBenchmark(page, before, "gate-verified webgpu", {
        expectedBackends: ["webgpu"],
      });
      expect(verifiedUnknown.after.renderer).toBe("webgpu");

      // 6. Submission vs confirmed presentation counter separation + per-scenario pixel checkpoint.
      const cpBeforeNoSurface = await captureRendererState(page, { sampleSurface: false });
      await page.evaluate(() => {
        const host = document.querySelector(".canvas") as HTMLElement;
        host.dataset.rendererSubmittedFrames = "50";
        // Confirmed presentation counter stays unchanged!
        host.dataset.rendererFrames = "2";
        host.dataset.rendererConfirmedFrame = "2";
      });
      await expect(
        verifyScenarioCheckpoint(
          page,
          cpBeforeNoSurface,
          "submissions without confirmed presentations",
          {
            minSubmitted: 10,
            minPresented: 5,
          },
        ),
      ).rejects.toThrow(/confirmed engine presentations/i);

      // First scenario with NO pre-scenario baseline surface and NO previous checkpoint must FAIL.
      await page.evaluate(() => {
        const host = document.querySelector(".canvas") as HTMLElement;
        host.dataset.rendererFrames = "12";
        host.dataset.rendererConfirmedFrame = "50";
      });
      await expect(
        verifyScenarioCheckpoint(page, cpBeforeNoSurface, "missing baseline surface", {
          minSubmitted: 10,
          minPresented: 5,
        }),
      ).rejects.toThrow(/requires a pre-scenario baseline surface/i);

      // First scenario WITH pre-scenario baseline surface must REJECT frozen engine pixels.
      const cpBefore = await captureRendererState(page, { sampleSurface: true });
      await page.evaluate(() => {
        const host = document.querySelector(".canvas") as HTMLElement;
        host.dataset.rendererSubmittedFrames = "65";
        host.dataset.rendererFrames = "20";
        host.dataset.rendererConfirmedFrame = "65";
      });
      await expect(
        verifyScenarioCheckpoint(page, cpBefore, "first scenario frozen surface", {
          minSubmitted: 10,
          minPresented: 5,
        }),
      ).rejects.toThrow(/did not change/i);

      // Late pre-gesture frame completion (confirmedFrame <= before.submittedFrames) must FAIL
      // even when confirmed presentation count incremented and engine pixels repainted.
      await page.evaluate(() => {
        const host = document.querySelector(".canvas") as HTMLElement;
        host.dataset.rendererSubmittedFrames = "70";
        host.dataset.rendererFrames = "18";
        // Frame 40 was submitted BEFORE cpBefore.submittedFrames (50): belongs to an earlier gesture.
        host.dataset.rendererConfirmedFrame = "40";
        const ectx = (document.querySelector("#engineLayer") as HTMLCanvasElement).getContext("2d");
        if (ectx) {
          ectx.fillStyle = "#ebeae6";
          ectx.fillRect(0, 0, 240, 180);
          ectx.fillStyle = "#2f9e44";
          ectx.fillRect(20, 20, 160, 120);
        }
      });
      await expect(
        verifyScenarioCheckpoint(page, cpBefore, "stale pre-gesture confirmed frame", {
          minSubmitted: 10,
          minPresented: 5,
        }),
      ).rejects.toThrow(/stale pre-gesture completion/i);

      // Confirming a frame submitted during this gesture passes scenario 1 checkpoint.
      await page.evaluate(() => {
        const host = document.querySelector(".canvas") as HTMLElement;
        host.dataset.rendererConfirmedFrame = "70";
      });
      const cp1 = await verifyScenarioCheckpoint(page, cpBefore, "scenario 1 painted", {
        minSubmitted: 10,
        minPresented: 5,
      });
      expect(cp1.compositedNonBlank).toBe(true);
      expect(cp1.deltaFromPrevious).toBeGreaterThanOrEqual(0.05);

      // Scenario 2 with frozen pixels fails even when counters advance.
      const cpMid = await captureRendererState(page, { sampleSurface: true });
      await page.evaluate(() => {
        const host = document.querySelector(".canvas") as HTMLElement;
        host.dataset.rendererSubmittedFrames = "90";
        host.dataset.rendererFrames = "28";
        host.dataset.rendererConfirmedFrame = "90";
      });
      await expect(
        verifyScenarioCheckpoint(page, cpMid, "scenario 2 frozen surface", {
          minSubmitted: 10,
          minPresented: 5,
          previous: cp1,
        }),
      ).rejects.toThrow(/did not change/i);

      // Localized interaction checkpoint ("fine" mode) rejects frozen pixels and passes once even
      // a small region updates (simulating type / fill / drag edits).
      await expect(
        verifyScenarioCheckpoint(page, cpMid, "localized interaction frozen", {
          minSubmitted: 1,
          minPresented: 1,
          pixelMatchMode: "fine",
          minChangedCells: 1,
        }),
      ).rejects.toThrow(/did not change/i);

      await page.evaluate(() => {
        const ectx = (document.querySelector("#engineLayer") as HTMLCanvasElement).getContext("2d");
        if (ectx) {
          ectx.fillStyle = "#e03131";
          ectx.fillRect(100, 80, 16, 16);
        }
      });
      const fineCp = await verifyScenarioCheckpoint(page, cpMid, "localized interaction painted", {
        minSubmitted: 1,
        minPresented: 1,
        pixelMatchMode: "fine",
        minChangedCells: 1,
      });
      expect(fineCp.changedCellsFromPrevious).toBeGreaterThanOrEqual(1);

      // Repainting a larger region passes coarse checkpoint 2 as well.
      await page.evaluate(() => {
        const ectx = (document.querySelector("#engineLayer") as HTMLCanvasElement).getContext("2d");
        if (ectx) {
          ectx.fillStyle = "#ebeae6";
          ectx.fillRect(0, 0, 240, 180);
          ectx.fillStyle = "#e03131";
          ectx.fillRect(10, 10, 200, 140);
        }
      });
      const cp2 = await verifyScenarioCheckpoint(page, cpMid, "scenario 2 updated surface", {
        minSubmitted: 10,
        minPresented: 5,
        previous: cp1,
      });
      expect(cp2.deltaFromPrevious).toBeGreaterThanOrEqual(0.05);
    } finally {
      await ctx.close();
    }
  });

  test("does not increment confirmed engine presentations for a late direct-GPU completion after Canvas covers the surface", async ({
    browser,
  }) => {
    const storageState = await instance.context.storageState();
    const ctx = await browser.newContext({
      baseURL: instance.url,
      storageState,
      viewport: { width: 1280, height: 800 },
    });
    try {
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        localStorage.setItem("drawpane:debug", "1");
        localStorage.setItem("drawpane:engine-software", "allow");
      });
      await page.goto("/?renderer=engine-webgl&present=webgpu");
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 30_000,
      });
      const host = page.locator(".canvas");
      await expect(host).toHaveAttribute("data-renderer", "webgl2", { timeout: 45_000 });
      await expect(host).toHaveAttribute("data-renderer-presentation", "direct");

      const counters = () =>
        host.evaluate((el: HTMLElement) => {
          const content = el.querySelector<HTMLCanvasElement>('[data-canvas-role="content"]');
          const engine = el.querySelector<HTMLCanvasElement>('[data-canvas-role="engine"]');
          return {
            renderer: el.dataset.renderer,
            presentation: el.dataset.rendererPresentation,
            submitted: Number(el.dataset.rendererSubmittedFrames ?? "0"),
            confirmed: Number(el.dataset.rendererFrames ?? "0"),
            confirmedFrame: Number(el.dataset.rendererConfirmedFrame ?? "0"),
            contentVis: content ? getComputedStyle(content).visibility : "missing",
            engineVis: engine ? getComputedStyle(engine).visibility : "missing",
          };
        });

      await expect.poll(async () => (await counters()).confirmed).toBeGreaterThan(0);

      // Hold gpuFinished() on the active WebGL2 engine so the next pan submits without confirming.
      const plainPageId = await page.evaluate(() => {
        const w = window as unknown as {
          drawpane: { s: { pageId: string } };
          drawpaneEngineView: {
            engine: { gpuFinished(): Promise<{ ok: true; value: undefined }> };
          };
          __finishedHold?: Array<() => void>;
          __releaseFinished?: () => void;
        };
        let unblock = false;
        w.__finishedHold = [];
        w.__releaseFinished = () => {
          unblock = true;
          for (const resolve of w.__finishedHold?.splice(0) ?? []) resolve();
        };
        w.drawpaneEngineView.engine.gpuFinished = async () => {
          if (!unblock) {
            await new Promise<void>((resolve) => w.__finishedHold?.push(resolve));
          }
          return { ok: true, value: undefined };
        };
        return w.drawpane.s.pageId;
      });

      const before = await counters();
      await page.evaluate(() => {
        const e = (
          window as unknown as {
            drawpane: {
              s: { camera: { pan(dx: number, dy: number): unknown } };
              setCamera(c: unknown): void;
            };
          }
        ).drawpane;
        e.setCamera(e.s.camera.pan(41, 27));
      });
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { __finishedHold?: unknown[] }).__finishedHold?.length ?? 0,
          ),
        )
        .toBeGreaterThan(0);
      const submitted = await counters();
      expect(submitted.submitted).toBeGreaterThan(before.submitted);
      expect(submitted.confirmed).toBe(before.confirmed);

      // Switch to an unsupported drop-shadow page so Canvas covers the hidden WebGL2 surface.
      await page.evaluate(() => {
        const e = (
          window as unknown as {
            drawpane: {
              s: { pageId: string };
              addPage(): void;
              createLayer(t: string, r: object, p: string, props?: object): string;
            };
          }
        ).drawpane;
        e.addPage();
        e.createLayer("rect", { x: 300, y: 220, width: 180, height: 100 }, e.s.pageId, {
          effects: [{ type: "drop-shadow", x: 0, y: 4, blur: 12, spread: 0, color: "#00000040" }],
        });
      });
      await expect(host).toHaveAttribute("data-renderer", "canvas", { timeout: 15_000 });
      const covered = await counters();
      expect(covered.contentVis).toBe("visible");
      expect(covered.engineVis).toBe("hidden");

      // Release the held GPU completion while Canvas is visible: confirmed count MUST NOT advance.
      await page.evaluate(() => {
        (window as unknown as { __releaseFinished?: () => void }).__releaseFinished?.();
      });
      await page.evaluate(
        () =>
          new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))),
          ),
      );
      const afterLateRelease = await counters();
      expect(afterLateRelease.renderer).toBe("canvas");
      expect(afterLateRelease.engineVis).toBe("hidden");
      expect(afterLateRelease.confirmed).toBe(covered.confirmed);
      expect(afterLateRelease.confirmedFrame).toBe(covered.confirmedFrame);

      // Returning to the plain page resumes direct WebGL2 confirmed presentations cleanly.
      await page.evaluate((id) => {
        const e = (window as unknown as { drawpane: { setPage(id: string): void } }).drawpane;
        e.setPage(id);
      }, plainPageId);
      await expect(host).toHaveAttribute("data-renderer", "webgl2", { timeout: 15_000 });
      await expect
        .poll(async () => (await counters()).confirmed)
        .toBeGreaterThan(covered.confirmed);
      const resumed = await counters();
      expect(resumed.confirmedFrame).toBeGreaterThan(covered.submitted);
    } finally {
      await ctx.close();
    }
  });
});
