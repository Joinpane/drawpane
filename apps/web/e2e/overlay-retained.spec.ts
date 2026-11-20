/**
 * End-to-end visual correctness tests for the retained artboard label layer and
 * dirty-region transient overlay (shared across Canvas and Engine renderers).
 */
import { expect, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

const PORT = Number(process.env.OVERLAY_E2E_PORT ?? 49141);

test.describe("Retained overlay labels and dirty-region chrome", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    instance = await freshInstance(browser, { port: PORT, inspectorPort: PORT + 540 });
  });

  test.afterAll(async () => {
    await instance?.stop();
  });

  test("renders artboard labels on the retained label layer, translates cleanly across overscan and rebake, and clears transient selection without ghosts", async () => {
    const page = instance.page;
    await page.evaluate(() => {
      localStorage.setItem("drawpane:debug", "1");
      localStorage.setItem("drawpane:renderer", "canvas");
    });
    await page.reload();
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 15_000,
    });

    // Build 30 labeled top-level frames so both CSS-translated panning within overscan and
    // re-anchoring past overscan are exercised with dense visible labels.
    await page.evaluate(() => {
      const e = (
        window as unknown as {
          drawpane: {
            s: { pageId: string };
            doc: { apply(ops: unknown[]): void };
            zoomTo(z: number): void;
          };
        }
      ).drawpane;
      const ops: unknown[] = [];
      const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 6; c++) {
          const id = `artboard_${r}_${c}`;
          ops.push({
            op: "create",
            id,
            type: "frame",
            parent: e.s.pageId,
            key: `a${digits[r * 6 + c]}`,
            props: {
              x: c * 220 + 60,
              y: r * 150 + 80,
              width: 180,
              height: 110,
              name: `Board ${r}-${c}`,
              fills: [{ type: "solid", color: "#ffffff", opacity: 1 }],
            },
          });
        }
      }
      e.doc.apply(ops);
      e.zoomTo(1);
    });
    await page.waitForTimeout(300);

    const checkCanvases = async () =>
      page.evaluate(() => {
        const countNonZero = (selector: string) => {
          const c = document.querySelector<HTMLCanvasElement>(selector);
          if (!c) return -1;
          const ctx = c.getContext("2d");
          if (!ctx) return -1;
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) > 0) n++;
          return n;
        };
        return {
          labelsInk: countNonZero('.canvas canvas[data-canvas-role="labels"]'),
          overlayInk: countNonZero('.canvas canvas[data-canvas-role="overlay"]'),
        };
      });

    // With no selection/hover, labels canvas has ink and transient overlay is completely clean.
    const initial = await checkCanvases();
    expect(initial.labelsInk).toBeGreaterThan(200);
    expect(initial.overlayInk).toBe(0);

    // 1. Pan 15 steps (-90, -45 CSS px, within overscan) -> verify CSS transform translation is active
    // and the visible viewport slice matches a fresh forced redraw pixel-for-pixel.
    // 2. Then pan 35 more steps (-210, -105 CSS px, past overscan) -> verify rebake re-anchors cleanly
    // and again matches a fresh forced redraw pixel-for-pixel.
    const panCheck = await page.evaluate(async () => {
      const w = window as unknown as {
        devicePixelRatio: number;
        drawpane: {
          s: { camera: { pan(dx: number, dy: number): unknown; zoom: number } };
          state: { set(p: { camera: unknown }): void };
        };
      };
      const next = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      const labelsCanvas = document.querySelector<HTMLCanvasElement>(
        '.canvas canvas[data-canvas-role="labels"]',
      );
      const overlayCanvas = document.querySelector<HTMLCanvasElement>(
        '.canvas canvas[data-canvas-role="overlay"]',
      );
      const dpr = w.devicePixelRatio || 1;
      const readViewportSlice = (c: HTMLCanvasElement | null) => {
        if (!c || !overlayCanvas) return null;
        const ctx = c.getContext("2d");
        if (!ctx) return null;
        const pad = Number(c.dataset.overscan ?? "0");
        const m = new DOMMatrix(getComputedStyle(c).transform);
        const sx = Math.round((pad - m.e) * dpr);
        const sy = Math.round((pad - m.f) * dpr);
        return ctx.getImageData(sx, sy, overlayCanvas.width, overlayCanvas.height).data;
      };
      const countInk = (d: Uint8ClampedArray | null) => {
        if (!d) return -1;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) > 0) n++;
        return n;
      };
      const diffData = (a: Uint8ClampedArray | null, b: Uint8ClampedArray | null) => {
        if (!a || !b || a.length !== b.length) return -1;
        let diff = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (
            Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 2 ||
            Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) > 2 ||
            Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)) > 2 ||
            Math.abs((a[i + 3] ?? 0) - (b[i + 3] ?? 0)) > 2
          ) {
            diff++;
          }
        }
        return diff;
      };
      const forceFreshRedraw = async () => {
        const prevTheme = document.documentElement.dataset.theme ?? "";
        document.documentElement.dataset.theme = prevTheme === "dark" ? "light" : "dark";
        await next();
        document.documentElement.dataset.theme = prevTheme;
        await next();
        await next();
      };

      // Phase 1: within overscan (CSS translate3d active).
      for (let i = 0; i < 15; i++) {
        w.drawpane.state.set({ camera: w.drawpane.s.camera.pan(-6, -3) });
        await next();
      }
      await next();
      const transformWhilePanned = labelsCanvas?.style.transform ?? "";
      const translatedSlice = readViewportSlice(labelsCanvas);
      const overlayInk1 = countInk(
        overlayCanvas
          ?.getContext("2d")
          ?.getImageData(0, 0, overlayCanvas.width, overlayCanvas.height).data ?? null,
      );
      await forceFreshRedraw();
      const freshSlice1 = readViewportSlice(labelsCanvas);
      const diffWithinOverscan = diffData(translatedSlice, freshSlice1);

      // Phase 2: pan past overscan to trigger rebake, then verify pixel parity again.
      for (let i = 0; i < 35; i++) {
        w.drawpane.state.set({ camera: w.drawpane.s.camera.pan(-6, -3) });
        await next();
      }
      await next();
      const rebakedSlice = readViewportSlice(labelsCanvas);
      await forceFreshRedraw();
      const freshSlice2 = readViewportSlice(labelsCanvas);
      const diffAfterRebake = diffData(rebakedSlice, freshSlice2);

      return {
        transformWhilePanned,
        ink1: countInk(translatedSlice),
        ink2: countInk(rebakedSlice),
        diffWithinOverscan,
        diffAfterRebake,
        overlayInk1,
      };
    });
    expect(panCheck.transformWhilePanned).toContain("translate3d");
    expect(panCheck.ink1).toBeGreaterThan(200);
    expect(panCheck.ink2).toBeGreaterThan(100);
    expect(panCheck.diffWithinOverscan).toBe(0);
    expect(panCheck.diffAfterRebake).toBe(0);
    expect(panCheck.overlayInk1).toBe(0);

    // Select an artboard, verify transient selection chrome paints on .canvas__overlay, then
    // deselect and verify dirty-region clearing leaves ZERO ghost pixels on .canvas__overlay.
    await page.evaluate(async () => {
      const w = window as unknown as {
        drawpane: { select(ids: string[]): void };
      };
      w.drawpane.select(["artboard_1_1"]);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    });
    const selected = await checkCanvases();
    expect(selected.overlayInk).toBeGreaterThan(100);

    await page.evaluate(async () => {
      const w = window as unknown as {
        drawpane: { select(ids: string[]): void };
      };
      w.drawpane.select([]);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    });
    const cleared = await checkCanvases();
    expect(cleared.overlayInk).toBe(0);
    expect(cleared.labelsInk).toBeGreaterThan(100);
  });

  test("clears wide collaborator name tags without leaving ghost pixels", async () => {
    const page = instance.page;
    await page.goto(instance.url);
    await page.evaluate(() => {
      localStorage.setItem("drawpane:debug", "1");
      localStorage.setItem("drawpane:renderer", "canvas");
    });
    await page.reload();
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 15_000,
    });

    const waitPaint = () =>
      page.evaluate(
        () =>
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );
    const inspectOverlay = () =>
      page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>(".canvas__overlay");
        if (!c) return { count: -1, right: 0 };
        const ctx = c.getContext("2d");
        if (!ctx) return { count: -1, right: 0 };
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let count = 0;
        let right = 0;
        for (let i = 3; i < data.length; i += 4) {
          if ((data[i] ?? 0) > 0) {
            count++;
            right = Math.max(right, ((i - 3) / 4) % c.width);
          }
        }
        return { count, right };
      });

    const meta = await page.evaluate(() => {
      const e = (
        window as unknown as {
          drawpane: {
            s: { pageId: string; camera: { toPage(p: { x: number; y: number }): unknown } };
            state: { set(p: object): void };
          };
        }
      ).drawpane;
      const font = getComputedStyle(document.documentElement).getPropertyValue("--font-ui");
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) throw new Error("no 2d ctx");
      ctx.font = `600 11px ${font}`;
      const samples = ["W", "Ｍ", "\ufdfd", "\ufdfa"].map((ch) => {
        const name = ch.repeat(80);
        return { name, width: ctx.measureText(name).width };
      });
      const wide = samples.sort((a, b) => b.width - a.width)[0] as { name: string; width: number };
      e.state.set({
        selection: [],
        hover: null,
        peers: new Map([
          [
            "wide-cursor",
            {
              sessionId: "wide-cursor",
              userId: "wide-user",
              name: wide.name,
              kind: "person",
              color: 1,
              presence: {
                pageId: e.s.pageId,
                cursor: e.s.camera.toPage({ x: 80, y: 120 }),
                selection: [],
              },
            },
          ],
        ]),
      });
      return { width: wide.width, oldHeuristicRight: 80 - 4 + wide.name.length * 10 + 36 };
    });
    await waitPaint();
    const drawn = await inspectOverlay();
    expect(drawn.count).toBeGreaterThan(0);
    expect(drawn.right).toBeGreaterThan(meta.oldHeuristicRight);

    await page.evaluate(() => {
      (window as unknown as { drawpane: { state: { set(p: object): void } } }).drawpane.state.set({
        peers: new Map(),
      });
    });
    await waitPaint();
    const removed = await inspectOverlay();
    expect(removed.count).toBe(0);
  });

  test("preserves and clears tall combining-mark labels across atlas bake, direct zoom, and rename", async () => {
    const page = instance.page;
    await page.goto(instance.url);
    await page.evaluate(() => {
      localStorage.setItem("drawpane:debug", "1");
      localStorage.setItem("drawpane:renderer", "canvas");
    });
    await page.reload();
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 15_000,
    });

    const waitPaint = () =>
      page.evaluate(
        () =>
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );

    const created = await page.evaluate(() => {
      const e = (
        window as unknown as {
          drawpane: {
            s: {
              pageId: string;
              camera: { constructor: new (x: number, y: number, z: number) => unknown };
            };
            createLayer(t: string, r: object, p: string, props?: object): string;
            state: { set(p: object): void };
          };
        }
      ).drawpane;
      const c = document.querySelector<HTMLCanvasElement>(".canvas__labels");
      const ctx = c?.getContext("2d");
      if (!ctx) throw new Error("no labels ctx");
      ctx.save();
      ctx.font = '500 11px "Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif';
      const candidates = ["\u030d", "\u030a", "\u0302", "\u0301", "\u0308"].map((mark) => {
        const text = `A${mark.repeat(12)}`;
        return { text, ascent: ctx.measureText(text).actualBoundingBoxAscent };
      });
      ctx.restore();
      const tallest = candidates.sort((a, b) => b.ascent - a.ascent)[0] as {
        text: string;
        ascent: number;
      };
      const label = tallest.text;
      const measuredAscent = tallest.ascent;
      const frame = e.createLayer(
        "frame",
        { x: 420, y: 300, width: 250, height: 100 },
        e.s.pageId,
        {
          name: label,
        },
      );
      e.state.set({ selection: [], hover: null, camera: new e.s.camera.constructor(0, 0, 1) });
      (window as unknown as { tallLabel: { frame: string; x: number; y: number } }).tallLabel = {
        frame,
        x: 420,
        y: 300,
      };
      return { measuredAscent, frame };
    });
    expect(created.measuredAscent).toBeGreaterThan(16);
    await waitPaint();

    const inspectAboveBox = () =>
      page.evaluate(() => {
        const w = window as unknown as {
          drawpane: { s: { camera: { zoom: number } } };
          tallLabel: { x: number; y: number };
        };
        const c = document.querySelector<HTMLCanvasElement>(".canvas__labels");
        const ctx = c?.getContext("2d");
        if (!c || !ctx) return -1;
        const p = Number(c.dataset.overscan ?? "0");
        const topOfRect = Math.round(p + w.tallLabel.y * w.drawpane.s.camera.zoom - 22);
        const px = ctx.getImageData(
          Math.round(p + w.tallLabel.x * w.drawpane.s.camera.zoom) - 4,
          topOfRect - 64,
          80,
          64,
        ).data;
        let count = 0;
        for (let i = 3; i < px.length; i += 4) if ((px[i] ?? 0) > 0) count++;
        return count;
      });

    // Baked atlas frame must render tall combining marks without clipping.
    const bakedOutside = await inspectAboveBox();
    expect(bakedOutside).toBeGreaterThan(0);

    // Direct zoom frame also renders them without clipping.
    await page.evaluate(() => {
      const e = (
        window as unknown as {
          drawpane: {
            s: { camera: { zoomAt(p: { x: number; y: number }, z: number): unknown } };
            setCamera(c: unknown): void;
          };
        }
      ).drawpane;
      e.setCamera(e.s.camera.zoomAt({ x: 0, y: 0 }, 1.25));
    });
    await waitPaint();
    const directOutside = await inspectAboveBox();
    expect(directOutside).toBeGreaterThan(0);

    // Opening frame rename hides the label and must clear ALL combining-mark pixels above the box.
    await page.evaluate(() => {
      const w = window as unknown as {
        drawpane: { state: { set(p: object): void } };
        tallLabel: { frame: string };
      };
      w.drawpane.state.set({ renamingFrame: w.tallLabel.frame });
    });
    await expect(page.getByRole("textbox", { name: "Frame name" })).toBeFocused();
    await waitPaint();
    const renamedOutside = await inspectAboveBox();
    expect(renamedOutside).toBe(0);
  });

  test("responds to DPR-only changes without CSS resize on Canvas and CPU engine and enforces the 4096px cap", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const storageState = await instance.context.storageState();
    for (const mode of ["canvas", "engine-cpu"] as const) {
      const ctx = await browser.newContext({
        baseURL: instance.url,
        storageState,
        viewport: { width: 1300, height: 850 },
      });
      const cdp = await ctx.newCDPSession(await ctx.newPage());
      const page = ctx.pages()[0];
      if (!page) throw new Error("missing page");
      try {
        await page.addInitScript((value) => {
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:renderer", value);
        }, mode);
        await page.goto("/");
        await page.getByRole("button", { name: "New file" }).first().click();
        await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
          timeout: 20_000,
        });
        await expect(page.locator(".canvas")).toHaveAttribute(
          "data-renderer",
          mode === "canvas" ? "canvas" : "cpu-worker",
          { timeout: 45_000 },
        );
        await page.evaluate(() => {
          const e = (
            window as unknown as {
              drawpane: {
                s: { pageId: string };
                createLayer(t: string, r: object, p: string, props?: object): string;
                zoomTo(z: number): void;
              };
            }
          ).drawpane;
          e.createLayer("frame", { x: 120, y: 120, width: 220, height: 140 }, e.s.pageId, {
            name: "Retina Frame",
            fills: [{ type: "solid", color: "#ffffff" }],
          });
          e.zoomTo(1);
        });

        // 1. Set explicit 1300x850 @ 1x DPR and let the editor become completely idle.
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: 1300,
          height: 850,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await expect
          .poll(() =>
            page.evaluate((expectEngine) => {
              const c = document.querySelector<HTMLCanvasElement>('[data-canvas-role="content"]');
              const o = document.querySelector<HTMLCanvasElement>(".canvas__overlay");
              const l = document.querySelector<HTMLCanvasElement>(".canvas__labels");
              const eng = document.querySelector<HTMLCanvasElement>('[data-canvas-role="engine"]');
              return {
                dpr: window.devicePixelRatio,
                contentRatio: c ? Math.round(c.width / c.getBoundingClientRect().width) : 0,
                overlayRatio: o ? Math.round(o.width / o.getBoundingClientRect().width) : 0,
                labelsRatio: l ? Math.round(l.width / l.getBoundingClientRect().width) : 0,
                engineRatio: expectEngine
                  ? eng
                    ? Math.round(eng.width / eng.getBoundingClientRect().width)
                    : 0
                  : 1,
              };
            }, mode === "engine-cpu"),
          )
          .toEqual({ dpr: 1, contentRatio: 1, overlayRatio: 1, labelsRatio: 1, engineRatio: 1 });

        // Wait until the editor is truly idle (no scheduled redraws or pending saves).
        await page.waitForTimeout(600);

        // 2. Change ONLY deviceScaleFactor (1 -> 2) with identical 1300x850 CSS dimensions and NO
        // user input or editor state changes. All backing stores (content, engine CPU, overlay,
        // and retained labels) must resize cleanly to 2x on their own.
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: 1300,
          height: 850,
          deviceScaleFactor: 2,
          mobile: false,
        });
        await expect
          .poll(
            () =>
              page.evaluate((expectEngine) => {
                const c = document.querySelector<HTMLCanvasElement>('[data-canvas-role="content"]');
                const o = document.querySelector<HTMLCanvasElement>(".canvas__overlay");
                const l = document.querySelector<HTMLCanvasElement>(".canvas__labels");
                const eng = document.querySelector<HTMLCanvasElement>(
                  '[data-canvas-role="engine"]',
                );
                return {
                  dpr: window.devicePixelRatio,
                  contentRatio: c ? Math.round(c.width / c.getBoundingClientRect().width) : 0,
                  overlayRatio: o ? Math.round(o.width / o.getBoundingClientRect().width) : 0,
                  labelsRatio: l ? Math.round(l.width / l.getBoundingClientRect().width) : 0,
                  engineRatio: expectEngine
                    ? eng
                      ? Math.round(eng.width / eng.getBoundingClientRect().width)
                      : 0
                    : 2,
                  retained: l?.dataset.retainedLabels ?? "",
                  labelsWithinCap: Math.max(l?.width ?? 0, l?.height ?? 0) <= 4096,
                };
              }, mode === "engine-cpu"),
            { timeout: 5_000 },
          )
          .toEqual({
            dpr: 2,
            contentRatio: 2,
            overlayRatio: 2,
            labelsRatio: 2,
            engineRatio: 2,
            retained: "enabled",
            labelsWithinCap: true,
          });

        // 3. On Canvas, also verify the strict 4096px cap disables the extra retained surface and
        // paints labels onto .canvas__overlay when viewport device pixels exceed 4096.
        if (mode === "canvas") {
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: 3000,
            height: 1440,
            deviceScaleFactor: 2,
            mobile: false,
          });
          await expect
            .poll(() =>
              page.evaluate(() => {
                const o = document.querySelector<HTMLCanvasElement>(".canvas__overlay");
                const l = document.querySelector<HTMLCanvasElement>(".canvas__labels");
                const octx = o?.getContext("2d");
                let overlayInk = 0;
                if (o && octx) {
                  const d = octx.getImageData(
                    0,
                    0,
                    Math.min(o.width, 1600),
                    Math.min(o.height, 1200),
                  ).data;
                  for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) > 0) overlayInk++;
                }
                return {
                  overlayExceedsCap: (o?.width ?? 0) > 4096,
                  labelsW: l?.width ?? -1,
                  labelsH: l?.height ?? -1,
                  retained: l?.dataset.retainedLabels ?? "",
                  overlayInkGtZero: overlayInk > 20,
                };
              }),
            )
            .toEqual({
              overlayExceedsCap: true,
              labelsW: 1,
              labelsH: 1,
              retained: "disabled",
              overlayInkGtZero: true,
            });
        }
      } finally {
        await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
        await cdp.detach().catch(() => {});
        await ctx.close();
      }
    }
  });
});
