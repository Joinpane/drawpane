/**
 * The render engine in the editor, behind its switch (decision 0040, phase 1):
 *
 * - with `drawpane:renderer` set to "engine", the engine draws the page into its WebGPU canvas
 *   under the overlay, and the content canvas is hidden;
 * - after edits (patches) and camera moves, what's on screen equals a fresh engine's render of
 *   the same page and camera (read back through a buffer, never through the canvas);
 * - on the e2e scene, the engine agrees with the canvas renderer within a bound;
 * - a page holding a progressive layer blur is drawn by the canvas renderer,
 *   and the engine takes over again when it's gone;
 * - a lost device, and a browser without WebGPU, fall back to the canvas renderer with a
 *   console note and a `drawpane:renderer-fallback` event, never a blank canvas. A headless
 *   browser loses the device as soon as a WebGPU canvas presents, so the default presentation
 *   is that test here; the others read frames back through a buffer
 *   (`drawpane:engine-present` = "readback").
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RenderEngine } from "@drawpane/engine";
import { outsideTolerance, score } from "@drawpane/engine/compare";
import { loadNodeEngine } from "@drawpane/engine/node";
import { OP } from "@drawpane/engine/wire";
import { expect, type Page, test } from "@playwright/test";
import { dropImage, freshInstance, type Instance } from "./fresh-instance";
import { decodePng } from "./parity/pixels";

if (!process.env.ENGINE_BROWSER || process.env.ENGINE_BROWSER === "chromium") {
  test.use({
    launchOptions: {
      args: [
        "--enable-unsafe-webgpu",
        "--enable-unsafe-swiftshader",
        ...(process.env.ENGINE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
      ],
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    },
  });
}

type W = {
  drawpane: {
    s: {
      pageId: string;
      selection: readonly string[];
      camera: { x: number; y: number; zoom: number; pan(dx: number, dy: number): unknown };
    };
    state: { set(patch: object): void };
    createLayer(t: string, r: object, p: string, props?: object): string;
    commit(ops: object[]): boolean;
    select(ids: readonly string[]): void;
    group(): void;
    setProp(ids: string[], prop: string, value: unknown, label: string): void;
    zoomTo(z: number): void;
    centerOn(p: { x: number; y: number }): void;
  };
  drawpaneFrames: { redraw(): void };
  drawpaneEngineView?: {
    canvas: HTMLCanvasElement;
    backend: "webgpu" | "webgl2" | "cpu-worker";
    adapter: string;
    adapterClass: "hardware" | "software" | "unknown" | "unidentified";
    readsBack: boolean;
    last: {
      supported: boolean;
      records: number;
      exact: boolean;
      plan: string;
      tiles: {
        drawn: number;
        pending: number;
        queued: number;
        held: number;
        evicted: number;
        dragged: number;
      };
    };
    engine: {
      records: number;
      attachGpu(canvas: unknown, opts?: object): Promise<unknown>;
      gpuPixels(): Promise<{ ok: boolean; value?: Uint8Array; message?: string }>;
      loseGpu(): void;
      gpu: { adapter: string } | null;
    } | null;
    pixels(): Promise<{ ok: boolean; value?: Uint8Array; message?: string }>;
    unsupported(): Record<string, number>;
  };
  drawpaneEngine: {
    blurProbe: ReturnType<typeof import("../src/editor/engine-debug").engineDebug>["blurProbe"];
    readbackPair(w: number, h: number): Promise<Array<{ ok: boolean; code?: number }>>;
    render(o: object): Promise<{
      ok: boolean;
      code?: number;
      rgba?: string;
      error?: string;
      stats?: { records: number; reads: number };
      gpu?: { backend: "webgpu" | "webgl2" };
    }>;
    list(
      pageId: string,
      ids?: string[],
      context?: boolean,
    ): { list: string; unsupported: Record<string, string[]>; records: number };
    canvasRender(o: object): Promise<string>;
  };

  fallbacks?: Array<{
    from: string | null;
    to: string;
    reason: string;
    code: number | null;
    adapter: string | null;
  }>;
  recoveries?: Array<{ backend: string; adapter: string | null; attempt: number; reason: string }>;
  pageFallbacks?: Array<{ pageId: string; features: Record<string, number> }>;
};

const frames = (page: Page, n = 4) =>
  page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
  }, n);

/** Which canvas shows the page: the engine's, or the canvas renderer's. */
const showing = (page: Page) =>
  page.evaluate(() => {
    const [content, gpu] = [
      ...document.querySelectorAll<HTMLCanvasElement>(".canvas canvas.canvas__layer"),
    ];
    return {
      engine: gpu?.style.visibility === "visible",
      content: content?.style.visibility !== "hidden",
    };
  });

/** Checks that the visible editor canvas area actually displays varied composited pixels on screen. */
async function visibleCanvasPainted(page: Page): Promise<boolean> {
  const png = await page.locator(".canvas").screenshot();
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d");
    if (!ctx) {
      bmp.close();
      return false;
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const first = `${d[0]},${d[1]},${d[2]},${d[3]}`;
    for (let i = 0; i < d.length; i += 4 * 97) {
      if (`${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}` !== first) return true;
    }
    return false;
  }, png.toString("base64"));
}

/** Waits for the frame shown to be exact: a stand-in (a pan, a zoom, bars) gives way to one at rest. */
const settled = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => (window as unknown as W).drawpaneEngineView?.last.exact), {
      timeout: 10_000,
    })
    .toBe(true);

/**
 * The engine's on-screen frame, once exact, against a fresh engine's render of the same view, on
 * the GPU.
 */
async function screenMatchesFresh(
  page: Page,
  backend: "gpu" | "webgl" | "cpu" = "gpu",
): Promise<{ identical: boolean; mean: number; cpu: ReturnType<typeof score> }> {
  await settled(page);
  const r = await page.evaluate(async (backend) => {
    const w = window as unknown as W;
    const view = w.drawpaneEngineView;
    if (!view) throw new Error("no engine view");
    const shown = await view.pixels();
    if (!shown.ok) throw new Error(`read back: ${JSON.stringify(shown)}`);
    const canvas = document.querySelectorAll<HTMLCanvasElement>(
      ".canvas canvas.canvas__layer",
    )[1] as HTMLCanvasElement;
    const { x, y, zoom } = w.drawpane.s.camera;
    const dpr = window.devicePixelRatio || 1;
    // The editor presents retained tiles on the device-pixel grid. A fresh export
    // accepts arbitrary raster origins, so ask it for the same pixel grid.
    const snap = (offset: number) => Math.round(offset * dpr) / dpr;
    const at = {
      pageId: w.drawpane.s.pageId,
      rect: {
        x: -snap(x) / zoom,
        y: -snap(y) / zoom,
        width: canvas.width / (zoom * dpr),
        height: canvas.height / (zoom * dpr),
      },
      scale: zoom * dpr,
      width: canvas.width,
      height: canvas.height,
      background: ((css: string) => {
        const n = Number.parseInt(css.slice(1, 7), 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
      })(
        getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim() || "#ebeae6",
      ),
    };
    const fresh = await w.drawpaneEngine.render({ ...at, backend });
    // And the CPU's whole frame: tiles must hold the picture, not just agree with
    // themselves (a blank tile would match a blank fresh render).
    const cpu =
      backend === "cpu" ? fresh : await w.drawpaneEngine.render({ ...at, backend: "cpu" });
    let s = "";
    const px = shown.value as Uint8Array;
    for (let i = 0; i < px.length; i += 0x8000)
      s += String.fromCharCode(...px.subarray(i, i + 0x8000));
    return {
      shown: btoa(s),
      fresh: fresh.rgba ?? "",
      cpu: cpu.rgba ?? "",
      width: canvas.width,
      height: canvas.height,
    };
  }, backend);
  const a = Buffer.from(r.shown, "base64");
  const b = Buffer.from(r.fresh, "base64");
  // The background differs only if the page's canvas colour token differs: compare inside.
  const s = score(a, b, r.width, r.height);
  const cpu = score(a, Buffer.from(r.cpu, "base64"), r.width, r.height);
  // CPU against GPU (decision 0040, "Parity gates"): mean ≤ 0.25, p99 ≤ 4, worst tile ≤ 2,
  // at most 4 pixels more than 16 apart in any tile.
  expect(cpu.mean, "the GPU's frame against the CPU's").toBeLessThanOrEqual(0.25);
  expect(cpu.p99).toBeLessThanOrEqual(4);
  expect(cpu.worstTile).toBeLessThanOrEqual(2);
  expect(cpu.severeInTile).toBeLessThanOrEqual(4);
  return { identical: a.equals(b), mean: s.mean, cpu };
}

test.describe
  .serial("The render engine in the editor", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
    let instance: Instance;
    let page: Page;
    const notes: string[] = [];

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      const port = Number(process.env.ENGINE_E2E_PORT ?? 8973);
      instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
      page = instance.page;
      page.on("console", (m) => {
        if (m.text().includes("render engine")) notes.push(m.text());
      });
      await page.evaluate(() => {
        localStorage.setItem("drawpane:debug", "1");
        localStorage.setItem("drawpane:renderer", "engine");
        // Headless Chromium loses a WebGPU device that presents to a canvas (SwiftShader here,
        // NVIDIA on the GPU bench): frames come back through a buffer instead. Presentation
        // itself is checked on a real laptop.
        localStorage.setItem("drawpane:engine-present", "readback");
        // This VM's only WebGPU adapter is SwiftShader, which the editor refuses by default.
        localStorage.setItem("drawpane:engine-software", "allow");
      });
      await page.addInitScript(() => {
        (window as unknown as W).fallbacks = [];
        (window as unknown as W).recoveries = [];
        (window as unknown as W).pageFallbacks = [];
        window.addEventListener("drawpane:renderer-fallback", (e) =>
          (window as unknown as W).fallbacks?.push(
            (e as CustomEvent).detail as NonNullable<W["fallbacks"]>[number],
          ),
        );
        window.addEventListener("drawpane:renderer-recovered", (e) =>
          (window as unknown as W).recoveries?.push(
            (e as CustomEvent).detail as NonNullable<W["recoveries"]>[number],
          ),
        );
        window.addEventListener("drawpane:renderer-page-fallback", (e) =>
          (window as unknown as W).pageFallbacks?.push((e as CustomEvent).detail),
        );
      });
      await page.reload();
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        for (let i = 0; i < 12; i++) {
          const card = e.createLayer(
            "frame",
            { x: (i % 4) * 260, y: Math.floor(i / 4) * 200, width: 220, height: 160 },
            e.s.pageId,
            {
              cornerRadius: 12,
              clipContent: true,
              fills: [
                i % 3 === 0
                  ? {
                      type: "linear",
                      from: { x: 0, y: 0 },
                      to: { x: 1, y: 1 },
                      stops: [
                        { position: 0, color: "#fff4e6" },
                        { position: 1, color: "#e7f5ff" },
                      ],
                    }
                  : { type: "solid", color: "#ffffff" },
              ],
              strokes: [{ type: "solid", color: "#d2cfc8" }],
              strokeAlign: i % 2 ? "inside" : "outside",
              strokeWeight: 2,
            },
          );
          const cx = (i % 4) * 260;
          const cy = Math.floor(i / 4) * 200;
          e.createLayer("ellipse", { x: cx + 16, y: cy + 16, width: 40, height: 40 }, card, {
            fills: [
              {
                type: "radial",
                from: { x: 0.5, y: 0.5 },
                to: { x: 1, y: 0.5 },
                stops: [
                  { position: 0, color: i % 2 ? "#e8590c" : "#007ca5" },
                  { position: 1, color: "#222222" },
                ],
              },
            ],
          });
          e.createLayer("rect", { x: cx + 70, y: cy + 20, width: 120, height: 32 }, card, {
            cornerRadii: [16, 4, 16, 4],
            fills: [
              {
                type: "angular",
                from: { x: 0.5, y: 0.5 },
                to: { x: 1, y: 0 },
                stops: [
                  { position: 0, color: "#7048e8" },
                  { position: 1, color: "#20c997" },
                ],
              },
            ],
            strokes: [{ type: "solid", color: "#212529" }],
            strokeDashes: [6, 3],
            strokeWeight: 2,
            opacity: 0.8,
          });
          e.createLayer("text", { x: cx + 16, y: cy + 72, width: 10, height: 10 }, card, {
            characters: `Card ${i + 1}: plan the week`,
            fontSize: 16,
            fontWeight: 600,
            fills: [{ type: "solid", color: "#212529" }],
          });
        }
        e.zoomTo(1);
        e.centerOn({ x: 500, y: 300 });
      });
      // Fonts arrive, faces are shaped, then the engine draws the page. Not a frame's own count
      // of records drawn: tiles drawn between frames leave the exact frame nothing to encode.
      await page
        .waitForFunction(
          () => {
            const v = (window as unknown as W).drawpaneEngineView;
            return v?.last.supported === true && (v.engine?.records ?? 0) > 0 && v.last.exact;
          },
          undefined,
          { timeout: 120_000 },
        )
        .catch(async (err) => {
          const state = await page.evaluate(() => {
            const v = (window as unknown as W).drawpaneEngineView;
            return {
              view: !!v,
              last: v?.last,
              unsupported: v?.unsupported(),
              fallbacks: (window as unknown as W).fallbacks,
            };
          });
          throw new Error(`the engine never drew the page: ${JSON.stringify(state)} (${err})`);
        });
      await page.waitForTimeout(2000);
      await frames(page);
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("draws the page with the engine, under the overlay, without fetching the WebGL2 module", async () => {
      const fallbacks = await page.evaluate(() => (window as unknown as W).fallbacks);
      expect(fallbacks, "the engine fell back").toEqual([]);
      // Read back (headless), the engine's first frame shows once it lands.
      await expect
        .poll(() => showing(page), { timeout: 15_000 })
        .toEqual({ engine: true, content: false });
      const info = await page.evaluate(() => {
        const v = (window as unknown as W).drawpaneEngineView;
        const wasms = performance
          .getEntriesByType("resource")
          .map((e) => e.name)
          .filter((u) => /engine_bg.*\.wasm/i.test(u));
        return {
          backend: v?.backend,
          adapter: v?.engine?.gpu?.adapter,
          engineWasms: wasms,
        };
      });
      expect(info.backend).toBe("webgpu");
      // Only the WebGPU browser module is fetched; the lazy WebGL2 module stays untouched.
      expect(info.engineWasms).toHaveLength(1);
      test.info().annotations.push({ type: "adapter", description: String(info.adapter) });
      expect(notes.some((n) => n.includes("drawing with the render engine"))).toBe(true);
    });

    test("keeps the current content visible during an overlay-only redraw", async () => {
      expect(await showing(page)).toEqual({ engine: true, content: false });
      await page.evaluate(() => (window as unknown as W).drawpane.state.set({ selection: [] }));
      await frames(page);
      expect(await showing(page)).toEqual({ engine: true, content: false });
    });

    test("follows the camera and patches, equal to a fresh render", async () => {
      expect(await screenMatchesFresh(page)).toMatchObject({ identical: true });
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        e.state.set({ camera: e.s.camera.pan(-137.33, 41.33) });
      });
      await frames(page);
      expect(await screenMatchesFresh(page)).toMatchObject({ identical: true });
      await page.evaluate(() => (window as unknown as W).drawpane.zoomTo(1.7));
      await frames(page);
      expect(await screenMatchesFresh(page)).toMatchObject({ identical: true });
      // Edits: a new layer, a moved one, a restyled one.
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        e.createLayer("rect", { x: 300, y: 260, width: 180, height: 90 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#ff922b" }],
          rotation: 20,
        });
      });
      await frames(page);
      expect(await screenMatchesFresh(page)).toMatchObject({ identical: true });
    });

    test("stays equal to a fresh render through a seeded walk of pans, zooms and edits", async () => {
      // Board textures (decision 0040, phase 2): tiles kept across camera moves and edits must
      // never show a stale picture. Whole and fractional pans, zooms about a point, new, moved
      // and restyled layers; at each step, once exact, the screen is a fresh engine's frame.
      // About 25 s alone; twice that on a loaded machine.
      test.setTimeout(120_000);
      let seed = 0x0040_0002;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const made: string[] = [];
      for (let step = 0; step < 8; step++) {
        const kind = Math.floor(rand() * 4);
        const a = rand();
        const b = rand();
        const c = rand();
        await page
          .evaluate(
            ({ kind, a, b, c, made }) => {
              const e = (window as unknown as W).drawpane as W["drawpane"] & {
                s: { camera: { zoomAt(p: object, z: number): unknown; zoom: number } };
              };
              if (kind === 0) {
                // A pan: whole device pixels, or a fraction (another phase: tiles drawn afresh).
                const frac = c < 0.4 ? 0.37 : 0;
                e.state.set({
                  camera: e.s.camera.pan(
                    Math.round((a - 0.5) * 600) + frac,
                    Math.round((b - 0.5) * 400),
                  ),
                });
              } else if (kind === 1) {
                const z = Math.min(3, Math.max(0.15, e.s.camera.zoom * (0.6 + a * 0.9)));
                e.state.set({
                  camera: e.s.camera.zoomAt({ x: 200 + b * 900, y: 100 + c * 600 }, z),
                });
              } else if (kind === 2 || made.length === 0) {
                made.push(
                  e.createLayer(
                    "rect",
                    { x: a * 900, y: b * 500, width: 60 + c * 200, height: 40 + a * 100 },
                    e.s.pageId,
                    {
                      fills: [{ type: "solid", color: c < 0.5 ? "#2b8a3e" : "#c92a2a" }],
                      rotation: c * 40 - 20,
                    },
                  ),
                );
              } else {
                const id = made[Math.floor(a * made.length)] as string;
                e.commit([
                  { op: "set", id, prop: "x", value: b * 900 },
                  {
                    op: "set",
                    id,
                    prop: "fills",
                    value: [{ type: "solid", color: c < 0.5 ? "#1971c2" : "#f08c00" }],
                  },
                ]);
              }
              return made;
            },
            { kind, a, b, c, made },
          )
          .then((m) => {
            made.splice(0, made.length, ...m);
          });
        await frames(page, 2);
        expect(await screenMatchesFresh(page), `step ${step} (${kind})`).toMatchObject({
          identical: true,
        });
      }
    });

    test("drags a layer: composited while it moves, exact once dropped, into another board too", async () => {
      // Decision 0040, "Dragging": the page below the dragged layer and the page above it are
      // kept for the drag, the layer is drawn afresh at its real position between them, and the
      // frame is a stand-in until the drag rests; dropped into another board, the layer leaves
      // one and joins the other at its real place in paint order.
      const ids = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane as W["drawpane"] & {
          doc: { childIds(id: string): readonly string[] };
        };
        e.zoomTo(1);
        // The first card in view (the walk before left the camera anywhere).
        e.centerOn({ x: 260, y: 120 });
        const cards = e.doc.childIds(e.s.pageId);
        const from = cards[0] as string;
        const to = cards[1] as string;
        const id = e.createLayer("rect", { x: 30, y: 40, width: 70, height: 50 }, from, {
          fills: [{ type: "solid", color: "#7048e8" }],
          cornerRadius: 8,
        });
        return { id, to };
      });
      await settled(page);
      const seen: Array<{ exact: boolean; dragged: number; dragging: string }> = [];
      for (let i = 1; i <= 6; i++) {
        // Moved, and read in the frame that drew it (idle frames draw what's missing after).
        seen.push(
          await page.evaluate(
            async ({ id, i }) => {
              const e = (window as unknown as W).drawpane;
              e.commit([
                { op: "set", id, prop: "x", value: 30 + i * 9 },
                { op: "set", id, prop: "y", value: 40 + i * 4 },
              ]);
              await new Promise((r) => requestAnimationFrame(() => r(null)));
              const v = (window as unknown as W).drawpaneEngineView as unknown as {
                last: { exact: boolean; tiles: { dragged: number } };
                engine: { dragging: string };
              };
              return {
                exact: v.last.exact,
                dragged: v.last.tiles.dragged,
                dragging: v.engine.dragging,
              };
            },
            { id: ids.id, i },
          ),
        );
      }
      const fell = await page.evaluate(() => (window as unknown as W).fallbacks);
      expect(fell, "the engine fell back while dragging").toEqual([]);
      expect(
        seen.every((f) => f.dragging === "composited"),
        JSON.stringify(seen),
      ).toBe(true);
      expect(
        seen.some((f) => f.dragged > 0 && !f.exact),
        JSON.stringify(seen),
      ).toBe(true);
      expect(seen.every((f) => !(f.dragged > 0 && f.exact))).toBe(true);
      expect(await screenMatchesFresh(page)).toMatchObject({ identical: true });
      // Dropped into the next board, where it was on the page.
      await page.evaluate(({ id, to }) => {
        const e = (window as unknown as W).drawpane as W["drawpane"] & {
          reparentOps(id: string, parent: string, key: string): object[];
          topKey(parent: string): string;
        };
        e.commit(e.reparentOps(id, to, e.topKey(to)));
      }, ids);
      await frames(page, 2);
      expect(await screenMatchesFresh(page)).toMatchObject({ identical: true });
      // And dragged on inside it.
      for (let i = 1; i <= 3; i++) {
        await page.evaluate(
          ({ id, i }) => {
            const e = (window as unknown as W).drawpane;
            e.commit([{ op: "set", id, prop: "y", value: 20 + i * 6 }]);
          },
          { id: ids.id, i },
        );
        await frames(page, 1);
      }
      expect(await screenMatchesFresh(page)).toMatchObject({ identical: true });
    });

    test("never reports a stand-in exact", async () => {
      // A zoom to a scale never drawn: the first frame stands on the last one scaled.
      // Read in the frame that drew it: idle frames go on drawing what's missing right after.
      const first = await page.evaluate(async () => {
        const e = (window as unknown as W).drawpane;
        e.zoomTo(e.s.camera.zoom * 1.2345);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const v = (window as unknown as W).drawpaneEngineView;
        return v ? { exact: v.last.exact, plan: v.last.plan } : null;
      });
      expect(first?.exact, JSON.stringify(first)).toBe(false);
      await settled(page);
      expect(await screenMatchesFresh(page)).toMatchObject({ identical: true });
    });

    test("agrees with the canvas renderer on the scene", async () => {
      const r = await page.evaluate(async () => {
        const w = window as unknown as W;
        const rect = { x: 0, y: 0, width: 1000, height: 560 };
        const engine = await w.drawpaneEngine.render({
          pageId: w.drawpane.s.pageId,
          rect,
          scale: 1,
          width: 1000,
          height: 560,
          backend: "cpu",
          background: [1, 1, 1, 1],
        });
        const canvas = await w.drawpaneEngine.canvasRender({
          pageId: w.drawpane.s.pageId,
          rect,
          scale: 1,
          width: 1000,
          height: 560,
          background: "#ffffff",
        });
        return { engine: engine.rgba ?? "", canvas, error: engine.error };
      });
      expect(r.error).toBeUndefined();
      if (process.env.ENGINE_DUMP) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync("/tmp/engine-scene.rgba", Buffer.from(r.engine, "base64"));
        writeFileSync("/tmp/canvas-scene.rgba", Buffer.from(r.canvas, "base64"));
      }
      const s = score(Buffer.from(r.engine, "base64"), Buffer.from(r.canvas, "base64"), 1000, 560);
      const summary = {
        mean: s.mean,
        p99: s.p99,
        worstTile: s.worstTile,
        severeInTile: s.severeInTile,
        alphaMax: s.alphaMax,
      };
      test
        .info()
        .annotations.push({ type: "engine-vs-canvas", description: JSON.stringify(summary) });
      console.log("engine against the canvas renderer:", JSON.stringify(summary));
      // Two rasterisers: text and anti-aliasing differ a little, never a missing shape.
      expect(s.mean).toBeLessThan(1.5);
      expect(s.worstTile).toBeLessThan(12);
    });

    test("renders smoothed corners, diamond gradients, and outside text strokes across CPU, WebGPU, WebGL2, and Canvas", async () => {
      const ids = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const host = e.createLayer("frame", { x: 0, y: 700, width: 420, height: 180 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#e9ecef" }],
        });
        // 1. Smoothed squircle with asymmetric radii and inside stroke.
        e.createLayer("rect", { x: 16, y: 716, width: 110, height: 90 }, host, {
          cornerRadii: [32, 16, 32, 8],
          cornerSmoothing: 0.6,
          fills: [{ type: "solid", color: "#3b5bdb" }],
          strokes: [{ type: "solid", color: "#1864ab" }],
          strokeWeight: 2,
          strokeAlign: "inside",
        });
        // 2. Diamond gradient fill (L1 norm) with alpha stop and isolating opacity.
        e.createLayer("rect", { x: 146, y: 716, width: 110, height: 90 }, host, {
          cornerRadius: 16,
          cornerSmoothing: 0.8,
          opacity: 0.9,
          fills: [
            {
              type: "diamond",
              from: { x: 0.5, y: 0.5 },
              to: { x: 1, y: 0.5 },
              stops: [
                { position: 0, color: "#ff0000" },
                { position: 0.5, color: "#ffd43b80" },
                { position: 1, color: "#1c7ed6" },
              ],
            },
          ],
          strokes: [
            {
              type: "diamond",
              from: { x: 0.5, y: 0.5 },
              to: { x: 1, y: 0.5 },
              stops: [
                { position: 0, color: "#2b8a3e" },
                { position: 1, color: "#862e9c" },
              ],
            },
          ],
          strokeWeight: 4,
          strokeAlign: "outside",
        });
        // 3. Text with outside stroke (filled + hollow) over the grey backdrop.
        e.createLayer("text", { x: 274, y: 724, width: 130, height: 50 }, host, {
          characters: "Hi",
          fontSize: 42,
          fontWeight: 700,
          fills: [{ type: "solid", color: "#111827" }],
          strokes: [{ type: "solid", color: "#e03131" }],
          strokeWeight: 3,
          strokeAlign: "outside",
        });
        e.createLayer("text", { x: 274, y: 786, width: 130, height: 50 }, host, {
          characters: "Oo",
          fontSize: 42,
          fontWeight: 700,
          fills: [{ type: "solid", color: "#000000", visible: false }],
          strokes: [{ type: "solid", color: "#2f9e44" }],
          strokeWeight: 3,
          strokeAlign: "outside",
        });
        return [host];
      });
      try {
        const res = await page.evaluate(async () => {
          const w = window as unknown as W;
          const rect = { x: 0, y: 700, width: 420, height: 180 };
          const opts = {
            pageId: w.drawpane.s.pageId,
            rect,
            scale: 1,
            width: 420,
            height: 180,
            background: [1, 1, 1, 1] as [number, number, number, number],
          };
          const cpu = await w.drawpaneEngine.render({ ...opts, backend: "cpu" });
          const gpu = await w.drawpaneEngine.render({ ...opts, backend: "gpu" });
          const webgl = await w.drawpaneEngine.render({ ...opts, backend: "webgl" });
          const canvas = await w.drawpaneEngine.canvasRender({
            pageId: w.drawpane.s.pageId,
            rect,
            scale: 1,
            width: 420,
            height: 180,
            background: "#ffffff",
          });
          return { cpu, gpu, webgl, canvas };
        });
        expect(res.cpu.ok, res.cpu.error).toBe(true);
        expect(res.gpu.ok, res.gpu.error).toBe(true);
        expect(res.webgl.ok, res.webgl.error).toBe(true);
        const cpuPx = Buffer.from(res.cpu.rgba ?? "", "base64");
        const gpuPx = Buffer.from(res.gpu.rgba ?? "", "base64");
        const glPx = Buffer.from(res.webgl.rgba ?? "", "base64");
        const canvasPx = Buffer.from(res.canvas, "base64");
        const cpuVsGpu = score(gpuPx, cpuPx, 420, 180);
        const cpuVsGl = score(glPx, cpuPx, 420, 180);
        const cpuVsCanvas = score(cpuPx, canvasPx, 420, 180);
        expect(cpuVsGpu.mean).toBeLessThanOrEqual(0.25);
        expect(cpuVsGpu.p99).toBeLessThanOrEqual(4);
        expect(cpuVsGpu.worstTile).toBeLessThanOrEqual(2);
        expect(cpuVsGpu.severeInTile).toBeLessThanOrEqual(4);
        expect(cpuVsGl.mean).toBeLessThanOrEqual(0.25);
        expect(cpuVsGl.p99).toBeLessThanOrEqual(4);
        expect(cpuVsGl.worstTile).toBeLessThanOrEqual(2);
        expect(cpuVsGl.severeInTile).toBeLessThanOrEqual(4);
        expect(cpuVsCanvas.mean).toBeLessThan(2.5);
      } finally {
        await page.evaluate(
          (id) => (window as unknown as W).drawpane.commit([{ op: "delete", id }]),
          ids[0] as string,
        );
      }
    });

    test("settles a stand-in into an exact frame once the camera rests", async () => {
      // Zoomed far out: while the zoom moves, frames stand on the last one scaled and coarse
      // tiles (text as bars); once the camera rests, frames draw the exact tiles, a few a frame,
      // until every glyph is drawn exactly (decision 0040, phase 2).
      await page.evaluate(() => (window as unknown as W).drawpane.zoomTo(0.08));
      await frames(page, 1);
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const v = (window as unknown as W).drawpaneEngineView;
              return v
                ? { exact: v.last.exact, fromTiles: ["tiles", "unchanged"].includes(v.last.plan) }
                : null;
            }),
          { timeout: 10_000 },
        )
        .toEqual({ exact: true, fromTiles: true });
      expect(await screenMatchesFresh(page)).toMatchObject({ identical: true });
      await page.evaluate(() => (window as unknown as W).drawpane.zoomTo(1.7));
      await frames(page);
    });

    test("never lets a delayed read-back undo a fallback to the canvas", async () => {
      // A frame's read-back is held back; meanwhile the page gains a layer the engine doesn't
      // draw, so the canvas renderer draws it. Released late, the old frame must not show.
      await page.evaluate(() => {
        const w = window as unknown as W & { held: Array<() => void> };
        const engine = w.drawpaneEngineView?.engine as unknown as {
          gpuPixels(): Promise<unknown>;
        };
        const original = engine.gpuPixels.bind(engine);
        w.held = [];
        engine.gpuPixels = () =>
          new Promise((resolve) => {
            const p = original();
            w.held.push(() => void p.then(resolve));
          });
        w.drawpaneFrames.redraw();
      });
      await frames(page, 4);
      const unsupported = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        return e.createLayer("rect", { x: 40, y: 420, width: 100, height: 60 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#ffffff" }],
          effects: [
            {
              type: "layer-blur",
              radius: 12,
              blurType: "progressive",
              startRadius: 0,
              startOffset: { x: 0.5, y: 0 },
              endOffset: { x: 0.5, y: 1 },
            },
          ],
        });
      });
      await expect
        .poll(() => showing(page), { timeout: 10_000 })
        .toEqual({ engine: false, content: true });
      await page.evaluate(() => {
        const w = window as unknown as W & { held: Array<() => void> };
        for (const release of w.held) release();
      });
      await frames(page, 8);
      expect(await showing(page)).toEqual({ engine: false, content: true });
      // Put things back: the read-back as it was, the page drawable again.
      await page.evaluate((id) => {
        const w = window as unknown as W;
        const engine = w.drawpaneEngineView?.engine as unknown as
          | { gpuPixels?: unknown }
          | undefined;
        if (engine) delete engine.gpuPixels;
        w.drawpane.commit([{ op: "delete", id }]);
      }, unsupported);
      await expect
        .poll(() => showing(page), { timeout: 15_000 })
        .toEqual({ engine: true, content: false });
    });

    test("leaves a page it can't draw to the canvas renderer, and takes it back", async () => {
      const unsupported = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        return e.createLayer("rect", { x: 40, y: 420, width: 100, height: 60 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#ffffff" }],
          effects: [
            {
              type: "layer-blur",
              radius: 12,
              blurType: "progressive",
              startRadius: 0,
              startOffset: { x: 0.5, y: 0 },
              endOffset: { x: 0.5, y: 1 },
            },
          ],
        });
      });
      await frames(page);
      expect(await showing(page)).toEqual({ engine: false, content: true });
      expect(
        await page.evaluate(() => (window as unknown as W).drawpaneEngineView?.unsupported()),
      ).toEqual({ layerBlur: 1 });
      // The page's fallback is reported, with what it holds (an earlier one may be from while its
      // fonts loaded, when its text couldn't be outlined yet).
      expect(await page.evaluate(() => (window as unknown as W).pageFallbacks?.at(-1))).toEqual({
        pageId: expect.any(String),
        features: { layerBlur: 1 },
      });
      await page.evaluate(
        (id) => (window as unknown as W).drawpane.commit([{ op: "delete", id }]),
        unsupported,
      );
      // Read back (headless), the engine's frame shows once it lands, never before.
      await expect
        .poll(() => showing(page), { timeout: 15_000 })
        .toEqual({ engine: true, content: false });
    });

    test("reference Gaussian blur agrees across CPU reference, CPU pyramid, and GPU", async () => {
      test.setTimeout(120_000);
      const unpremul = (pre: Uint8Array): Uint8Array => {
        const out = new Uint8Array(pre.length);
        for (let i = 0; i < pre.length; i += 4) {
          const a = pre[i + 3] as number;
          out[i + 3] = a;
          if (a === 0) continue;
          if (a === 255) {
            out[i] = pre[i] as number;
            out[i + 1] = pre[i + 1] as number;
            out[i + 2] = pre[i + 2] as number;
          } else {
            out[i] = Math.min(255, Math.round(((pre[i] as number) * 255) / a));
            out[i + 1] = Math.min(255, Math.round(((pre[i + 1] as number) * 255) / a));
            out[i + 2] = Math.min(255, Math.round(((pre[i + 2] as number) * 255) / a));
          }
        }
        return out;
      };
      const makePattern = (w: number, h: number, kind: number): Uint8Array => {
        const px = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            let c: [number, number, number, number] = [0, 0, 0, 0];
            if (kind === 0) {
              if (x >= w / 4 && x < (3 * w) / 4 && y >= h / 4 && y < (3 * h) / 4)
                c = [220, 120, 40, 255];
            } else if (kind === 1) {
              if (x < w / 2 && y < h / 2) c = [255, 255, 255, 255];
              else if (x >= w / 2 && y < h / 2) c = [20, 40, 80, 255];
              else if (x < w / 2 && y >= h / 2) c = [120, 30, 10, 140];
            } else if (kind === 2) {
              c =
                x === 0 || y === 0 || x === w - 1 || y === h - 1
                  ? [255, 255, 255, 255]
                  : [16, 24, 32, 255];
            } else if (kind === 3) {
              c = Math.floor(x / 2) % 2 === 0 ? [240, 200, 100, 255] : [20, 30, 180, 255];
            } else {
              const r = Math.floor((x * 255) / w);
              const g = Math.floor((y * 255) / h);
              const a = 128 + Math.floor(((x + y) * 127) / (w + h));
              c = [
                Math.floor((r * a) / 255),
                Math.floor((g * a) / 255),
                Math.floor((180 * a) / 255),
                a,
              ];
            }
            px[i] = c[0];
            px[i + 1] = c[1];
            px[i + 2] = c[2];
            px[i + 3] = c[3];
          }
        }
        return px;
      };

      const w = 129;
      const h = 97;
      const edges = [
        { kind: "zero" as const },
        { kind: "clamp" as const },
        { kind: "border" as const, color: [0.15, 0.35, 0.55, 0.8] as const },
      ] as const;
      const cases: Array<{ kind: number; edge: (typeof edges)[number]; sigma: number }> = [
        { kind: 0, edge: edges[0], sigma: 0 },
        { kind: 0, edge: edges[0], sigma: 0.5 },
        { kind: 0, edge: edges[0], sigma: 4 },
        { kind: 0, edge: edges[0], sigma: 16 },
        { kind: 1, edge: edges[0], sigma: 8 },
        { kind: 1, edge: edges[0], sigma: 24 },
        { kind: 1, edge: edges[1], sigma: 14 },
        { kind: 1, edge: edges[2], sigma: 32 },
        { kind: 2, edge: edges[1], sigma: 6 },
        { kind: 2, edge: edges[1], sigma: 28 },
        { kind: 3, edge: edges[0], sigma: 18 },
        { kind: 4, edge: edges[1], sigma: 40 },
        { kind: 4, edge: edges[2], sigma: 16 },
      ];
      const pattern = (kind: number) => Buffer.from(makePattern(w, h, kind)).toString("base64");

      let worstGpuVsPyr = 0;
      let worstGpuVsRef = 0;
      for (const c of cases) {
        const res = await page.evaluate(
          (args) => (window as unknown as W).drawpaneEngine.blurProbe(args),
          { src: pattern(c.kind), srcWidth: w, srcHeight: h, sigma: c.sigma, edge: c.edge },
        );
        expect(res.ok, res.error).toBe(true);
        const gpu = unpremul(Buffer.from(res.gpu ?? "", "base64"));
        const cpuPyr = unpremul(Buffer.from(res.cpuPyr ?? "", "base64"));
        const cpuRef = unpremul(Buffer.from(res.cpuRef ?? "", "base64"));
        const sPyr = score(gpu, cpuPyr, w, h);
        const sRef = score(gpu, cpuRef, w, h);
        worstGpuVsPyr = Math.max(worstGpuVsPyr, sPyr.mean);
        worstGpuVsRef = Math.max(worstGpuVsRef, sRef.mean);
        expect(
          outsideTolerance(sPyr),
          `GPU vs CPU pyramid (kind=${c.kind} edge=${c.edge.kind} sigma=${c.sigma}): mean=${sPyr.mean.toFixed(4)} p99=${sPyr.p99} max=${sPyr.max} tile=${sPyr.worstTile.toFixed(3)}`,
        ).toEqual([]);
        expect(
          outsideTolerance(sRef),
          `GPU vs CPU reference (kind=${c.kind} edge=${c.edge.kind} sigma=${c.sigma}): mean=${sRef.mean.toFixed(4)} p99=${sRef.p99} max=${sRef.max} tile=${sRef.worstTile.toFixed(3)}`,
        ).toEqual([]);
      }

      // Dirty subrect + offset destination matches BOTH cropped full GPU blur AND offset CPU.
      const cb = { x0: 11, y0: 9, x1: 117, y1: 87 };
      const dirty = { x0: 21, y0: 17, x1: 103, y1: 79 };
      const dw = dirty.x1 - dirty.x0;
      const dh = dirty.y1 - dirty.y0;
      const full = await page.evaluate(
        (args) => (window as unknown as W).drawpaneEngine.blurProbe(args),
        {
          src: pattern(1),
          srcWidth: w,
          srcHeight: h,
          sigma: 20,
          edge: edges[1],
          clampBounds: cb,
        },
      );
      expect(full.ok, full.error).toBe(true);
      const fullGpu = unpremul(Buffer.from(full.gpu ?? "", "base64"));
      const croppedFullGpu = new Uint8Array(dw * dh * 4);
      for (let y = 0; y < dh; y++) {
        const srcOff = ((dirty.y0 + y) * w + dirty.x0) * 4;
        croppedFullGpu.set(fullGpu.subarray(srcOff, srcOff + dw * 4), y * dw * 4);
      }
      const sub = await page.evaluate(
        (args) => (window as unknown as W).drawpaneEngine.blurProbe(args),
        {
          src: pattern(1),
          srcWidth: w,
          srcHeight: h,
          dstWidth: dw,
          dstHeight: dh,
          dstOriginX: dirty.x0,
          dstOriginY: dirty.y0,
          sigma: 20,
          edge: edges[1],
          clampBounds: cb,
          dirty,
        },
      );
      expect(sub.ok, sub.error).toBe(true);
      const subGpu = unpremul(Buffer.from(sub.gpu ?? "", "base64"));
      const subVsCpu = score(subGpu, unpremul(Buffer.from(sub.cpuPyr ?? "", "base64")), dw, dh);
      expect(
        outsideTolerance(subVsCpu),
        `offset GPU vs offset CPU: mean=${subVsCpu.mean.toFixed(4)} max=${subVsCpu.max}`,
      ).toEqual([]);
      const subVsFull = score(subGpu, croppedFullGpu, dw, dh);
      expect(
        outsideTolerance(subVsFull),
        `offset GPU vs cropped full GPU: mean=${subVsFull.mean.toFixed(4)} max=${subVsFull.max}`,
      ).toEqual([]);

      // Shared GPU blur pyramid across two blurs with the same sourceId gets a cache hit.
      const s1 = await page.evaluate(
        (args) => (window as unknown as W).drawpaneEngine.blurProbe(args),
        {
          src: pattern(4),
          srcWidth: w,
          srcHeight: h,
          sigma: 22,
          edge: edges[1],
          dirty: { x0: 8, y0: 8, x1: 80, y1: 80 },
          sourceId: 77,
        },
      );
      expect(s1.ok, s1.error).toBe(true);
      const hitsBefore = s1.stats?.hits ?? 0;
      const s2 = await page.evaluate(
        (args) => (window as unknown as W).drawpaneEngine.blurProbe(args),
        {
          src: pattern(4),
          srcWidth: w,
          srcHeight: h,
          sigma: 30,
          edge: edges[1],
          dirty: { x0: 16, y0: 16, x1: 72, y1: 72 },
          sourceId: 77,
        },
      );
      expect(s2.ok, s2.error).toBe(true);
      expect(s2.stats?.hits ?? 0).toBeGreaterThan(hitsBefore);
      expect(
        outsideTolerance(
          score(
            unpremul(Buffer.from(s2.gpu ?? "", "base64")),
            unpremul(Buffer.from(s2.cpuPyr ?? "", "base64")),
            w,
            h,
          ),
        ),
      ).toEqual([]);
      // Extreme sigmas on GPU: 1x1 Clamp succeeds at sigma=1e9; 2x2 at sigma=1e9 refuses cleanly.
      const onePx = Buffer.from([255, 255, 255, 255]).toString("base64");
      const oneHuge = await page.evaluate(
        (args) => (window as unknown as W).drawpaneEngine.blurProbe(args),
        { src: onePx, srcWidth: 1, srcHeight: 1, sigma: 1e9, edge: edges[1] },
      );
      expect(oneHuge.ok, oneHuge.error).toBe(true);
      expect(Array.from(Buffer.from(oneHuge.gpu ?? "", "base64"))).toEqual([255, 255, 255, 255]);

      console.log(
        `reference Gaussian blur conformance: worst GPU vs CPU pyramid mean=${worstGpuVsPyr.toFixed(4)}, worst GPU vs CPU reference mean=${worstGpuVsRef.toFixed(4)}`,
      );
    });

    test("drop and inner shadows (0031 cut-out, text, spread, faded frame) agree across CPU and GPU", async () => {
      const ids = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const ox = 1200;
        const oy = 0;
        const wrap = e.createLayer("frame", { x: ox, y: oy, width: 420, height: 260 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#f4f3ef" }],
          clipContent: true,
        });
        // Decision 0031 cut-out shadow on a translucent rect (`showBehind: false`): interior stays clear.
        e.createLayer("rect", { x: ox + 24, y: oy + 24, width: 120, height: 80 }, wrap, {
          cornerRadius: 12,
          fills: [{ type: "solid", color: "#ffffff40" }],
          effects: [
            {
              type: "drop-shadow",
              color: "#1c1b1a99",
              x: 0,
              y: 6,
              blur: 16,
              spread: 4,
              showBehind: false,
            },
          ],
        });
        // Text drop shadow with decoration bar.
        e.createLayer("text", { x: ox + 180, y: oy + 30, width: 200, height: 48 }, wrap, {
          characters: "Shadow Text",
          fontSize: 28,
          fontWeight: 700,
          textDecoration: "underline",
          fills: [{ type: "solid", color: "#1c1b1a" }],
          effects: [{ type: "drop-shadow", color: "#3d7bf080", x: 2, y: 4, blur: 8, spread: 0 }],
        });
        // Faded isolated frame holding drop + inner shadows.
        const faded = e.createLayer(
          "frame",
          { x: ox + 24, y: oy + 136, width: 160, height: 96 },
          wrap,
          {
            cornerRadius: 14,
            opacity: 0.65,
            fills: [{ type: "solid", color: "#ffffff" }],
            effects: [
              { type: "drop-shadow", color: "#00000050", x: 0, y: 8, blur: 20, spread: 0 },
              { type: "inner-shadow", color: "#2b4fd670", x: 4, y: 4, blur: 10, spread: 3 },
            ],
          },
        );
        e.createLayer("ellipse", { x: ox + 124, y: oy + 160, width: 40, height: 40 }, faded, {
          fills: [{ type: "solid", color: "#ff7a45" }],
        });
        // Zero-blur hard inner shadow with spread + hard drop shadow.
        e.createLayer("rect", { x: ox + 220, y: oy + 136, width: 140, height: 80 }, wrap, {
          cornerRadius: 10,
          fills: [{ type: "solid", color: "#e9e7e1" }],
          effects: [
            { type: "inner-shadow", color: "#00000040", x: 6, y: 6, blur: 0, spread: 4 },
            { type: "drop-shadow", color: "#00000033", x: 0, y: 2, blur: 0, spread: 0 },
          ],
        });
        return [wrap];
      });
      await frames(page, 4);
      const r = await page.evaluate(async (wrapIds) => {
        const w = window as unknown as W;
        const opts = {
          pageId: w.drawpane.s.pageId,
          ids: wrapIds,
          rect: { x: 1200, y: 0, width: 420, height: 260 },
          scale: 2,
          width: 840,
          height: 520,
          background: [1, 1, 1, 1] as const,
        };
        const cpu = await w.drawpaneEngine.render({ ...opts, backend: "cpu" });
        const gpu = await w.drawpaneEngine.render({ ...opts, backend: "gpu" });
        const canvas = await w.drawpaneEngine.canvasRender({
          pageId: w.drawpane.s.pageId,
          rect: opts.rect,
          scale: 2,
          width: 840,
          height: 520,
          background: "#ffffff",
        });
        return { cpu, gpu, canvas };
      }, ids);
      await page.evaluate(
        (id) => (window as unknown as W).drawpane.commit([{ op: "delete", id }]),
        ids[0],
      );
      expect(r.cpu.ok, r.cpu.error).toBe(true);
      expect(r.gpu.ok, r.gpu.error).toBe(true);
      const cpuPx = Buffer.from(r.cpu.rgba ?? "", "base64");
      const gpuPx = Buffer.from(r.gpu.rgba ?? "", "base64");
      const canvasPx = Buffer.from(r.canvas, "base64");
      const cg = score(cpuPx, gpuPx, 840, 520);
      expect(
        outsideTolerance(cg),
        `shadows CPU vs GPU: mean=${cg.mean.toFixed(4)} p99=${cg.p99} tile=${cg.worstTile.toFixed(3)} sev=${cg.severeInTile}`,
      ).toEqual([]);
      // Decision 0031 cut-out check: interior of translucent rect at local (84, 64) -> device (168, 128)
      // must blend #ffffff40 over #f4f3ef (~[247, 246, 243]), NOT darkened by the #1c1b1a99 drop shadow,
      // while just below it at local (84, 112) -> device (168, 224) the drop shadow darkens #f4f3ef.
      const at = (buf: Buffer, x: number, y: number) => {
        const i = (y * 840 + x) * 4;
        return [buf[i] ?? 0, buf[i + 1] ?? 0, buf[i + 2] ?? 0];
      };
      const inside = at(gpuPx, 168, 128);
      const below = at(gpuPx, 168, 224);
      expect(inside[0], `cut-out interior should stay bright: ${inside}`).toBeGreaterThanOrEqual(
        242,
      );
      expect(below[0], `drop shadow below translucent rect should darken: ${below}`).toBeLessThan(
        210,
      );
      const vsCanvas = score(gpuPx, canvasPx, 840, 520);
      expect(vsCanvas.mean).toBeLessThan(1.5);
      console.log(
        `shadow rules conformance: CPU vs GPU mean=${cg.mean.toFixed(4)} p99=${cg.p99} tile=${cg.worstTile.toFixed(3)}, GPU vs canvas mean=${vsCanvas.mean.toFixed(2)}, inside=${inside.join("/")}, below=${below.join("/")}`,
      );
    });

    test("shadow edge cases (open stroke, evenodd inner, rotated cutout, mixed text, multiplied shadow)", async () => {
      const scenes = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const ox = 1800;
        const defs: Array<[string, string, Record<string, unknown>]> = [
          [
            "open-stroke",
            "line",
            {
              strokes: [{ type: "solid", color: "#ff0000" }],
              strokeWeight: 12,
              fills: [],
              effects: [
                { type: "drop-shadow", x: 0, y: 12, blur: 12, spread: 0, color: "#000000ff" },
              ],
            },
          ],
          [
            "evenodd-inner",
            "path",
            {
              pathData: "M0 0 H124 V72 H0 Z M24 18 H100 V54 H24 Z",
              windingRule: "evenodd",
              fills: [{ type: "solid", color: "#ffffff" }],
              effects: [
                { type: "inner-shadow", x: 4, y: 4, blur: 12, spread: 0, color: "#000000ff" },
              ],
            },
          ],
          [
            "fractional-rotated",
            "rect",
            {
              rotation: 24,
              cornerRadius: 8,
              fills: [{ type: "solid", color: "#ffffff60" }],
              effects: [
                {
                  type: "drop-shadow",
                  showBehind: false,
                  x: 4.3,
                  y: -7.4,
                  spread: 3.5,
                  blur: 16,
                  color: "#000000ff",
                },
              ],
            },
          ],
          [
            "multiplied-shadow",
            "rect",
            {
              fills: [{ type: "solid", color: "#50506090" }],
              effects: [
                {
                  type: "drop-shadow",
                  x: 0,
                  y: 12,
                  blur: 12,
                  spread: 0,
                  blendMode: "multiply",
                  color: "#ff000088",
                },
              ],
            },
          ],
        ];
        return defs.map(([name, type, props], i) => {
          const x = ox + i * 260;
          const frame = e.createLayer("frame", { x, y: 0, width: 220, height: 150 }, e.s.pageId, {
            fills: [{ type: "solid", color: "#ffffff" }],
            clipContent: true,
          });
          e.createLayer(type, { x: x + 40, y: 32, width: 124, height: 72 }, frame, props);
          return { name, frame, x };
        });
      });
      await frames(page, 4);
      try {
        for (const item of scenes) {
          const res = await page.evaluate(async ({ frame, x }) => {
            const w = window as unknown as W;
            const opts = {
              pageId: w.drawpane.s.pageId,
              rect: { x, y: 0, width: 220, height: 150 },
              scale: 1.35,
              width: 297,
              height: 203,
            };
            const cpu = await w.drawpaneEngine.render({
              ...opts,
              backend: "cpu",
              background: [1, 1, 1, 1],
              ids: [frame],
            });
            const gpu = await w.drawpaneEngine.render({
              ...opts,
              backend: "gpu",
              background: [1, 1, 1, 1],
              ids: [frame],
            });
            const canvas = await w.drawpaneEngine.canvasRender({ ...opts, background: "#ffffff" });
            return { cpu, gpu, canvas };
          }, item);
          expect(res.cpu.ok, `${item.name} cpu: ${res.cpu.error}`).toBe(true);
          expect(res.gpu.ok, `${item.name} gpu: ${res.gpu.error}`).toBe(true);
          const cpuPx = Buffer.from(res.cpu.rgba ?? "", "base64");
          const gpuPx = Buffer.from(res.gpu.rgba ?? "", "base64");
          const canPx = Buffer.from(res.canvas, "base64");
          const cg = score(cpuPx, gpuPx, 297, 203);
          expect(
            outsideTolerance(cg),
            `${item.name} CPU vs GPU: mean=${cg.mean.toFixed(4)} p99=${cg.p99} tile=${cg.worstTile.toFixed(3)}`,
          ).toEqual([]);
          if (item.name === "open-stroke") {
            // Line at y=32+36=68, strokeWeight=12, shadow offset y=+12 -> shadow centered at y=80 (108 dev).
            const idx = (Math.round(80 * 1.35) * 297 + Math.round(100 * 1.35)) * 4;
            expect(cpuPx[idx], "open stroked line must cast a visible drop shadow").toBeLessThan(
              180,
            );
            expect(gpuPx[idx], "open stroked line GPU shadow must be visible").toBeLessThan(180);
          }
          if (item.name === "evenodd-inner") {
            // Donut hole center at local (62, 36) -> (102, 68) -> dev (138, 92) stays white.
            const idx = (Math.round(68 * 1.35) * 297 + Math.round(102 * 1.35)) * 4;
            expect(cpuPx[idx], "evenodd inner shadow must not paint inside hole").toBeGreaterThan(
              250,
            );
            expect(canPx[idx], "canvas evenodd inner shadow must match engine").toBeGreaterThan(
              250,
            );
          }
          const vsCan = score(gpuPx, canPx, 297, 203);
          expect(
            vsCan.mean,
            `${item.name} GPU vs canvas mean=${vsCan.mean.toFixed(3)} tile=${vsCan.worstTile.toFixed(2)}`,
          ).toBeLessThan(1.2);
        }
      } finally {
        await page.evaluate(
          (ids) =>
            (window as unknown as W).drawpane.commit(ids.map((id) => ({ op: "delete", id }))),
          scenes.map((s) => s.frame),
        );
      }
    });

    test("renders the phase 3A effect substack across CPU, GPU, and canvas", async () => {
      // Composes layer blur, separable blend (multiply), linear blend (linear-dodge),
      // alpha and luminance masks, noise (mono, duo, and multi), and texture (unclipped + clipped)
      // together inside a translucent faded frame over visible backdrops at fractional DPR.
      // Backdrop readers (background blur and glass) arrive in phase 3B (#237 / #240).
      const scene = await page.evaluate(() => {
        const w = window as unknown as W;
        const e = w.drawpane;
        const ox = 8200;
        const root = e.createLayer("frame", { x: ox, y: 0, width: 260, height: 180 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#223b66" }],
          clipContent: true,
        });
        const faded = e.createLayer("frame", { x: ox + 12, y: 12, width: 236, height: 156 }, root, {
          // White premultiplies to the alpha byte exactly on both Vello backends. The
          // frame still leaves the parent backdrop visible through its fill.
          fills: [{ type: "solid", color: "#ffffff80" }],
          cornerRadius: 12,
          opacity: 0.85,
          clipContent: true,
        });
        // Alpha mask with layer blur gating a backdrop card plus a multiply-blended noisy textured card.
        e.createLayer("ellipse", { x: ox + 22, y: 24, width: 126, height: 126 }, faded, {
          fills: [{ type: "solid", color: "#ffffffdd" }],
          isMask: true,
          maskType: "alpha",
          effects: [{ type: "layer-blur", radius: 10 }],
        });
        e.createLayer("rect", { x: ox + 26, y: 28, width: 118, height: 112 }, faded, {
          fills: [{ type: "solid", color: "#44a08d" }],
          cornerRadius: 10,
          effects: [
            {
              type: "noise",
              noiseType: "mono",
              size: 1.8,
              density: 55,
              color: "#1a1a1a70",
              secondaryColor: "#ffffff",
              opacity: 100,
            },
          ],
        });
        const mulCard = e.createLayer(
          "rect",
          { x: ox + 36, y: 36, width: 118, height: 96 },
          faded,
          {
            fills: [{ type: "solid", color: "#e54d38" }],
            cornerRadius: 10,
            blendMode: "multiply",
            effects: [
              {
                type: "noise",
                noiseType: "duo",
                size: 1.6,
                density: 65,
                color: "#00000080",
                secondaryColor: "#ffffff88",
                opacity: 100,
              },
              { type: "texture", size: 4, radius: 6, clipToShape: false },
            ],
          },
        );
        // Luminance gradient mask gating a backdrop plus a linear-dodge blurred clipped-texture badge.
        e.createLayer("rect", { x: ox + 116, y: 26, width: 118, height: 122 }, faded, {
          fills: [
            {
              type: "linear",
              from: { x: 0, y: 0 },
              to: { x: 1, y: 1 },
              stops: [
                { position: 0, color: "#ffffff" },
                { position: 1, color: "#242424" },
              ],
            },
          ],
          cornerRadius: 12,
          isMask: true,
          maskType: "luminance",
        });
        e.createLayer("rect", { x: ox + 118, y: 30, width: 110, height: 112 }, faded, {
          fills: [{ type: "solid", color: "#3d2c6d" }],
          cornerRadius: 12,
        });
        const dodgeCard = e.createLayer(
          "rect",
          { x: ox + 126, y: 40, width: 96, height: 92 },
          faded,
          {
            fills: [{ type: "solid", color: "#4e96f0dd" }],
            cornerRadius: 14,
            blendMode: "linear-dodge",
            effects: [
              { type: "layer-blur", radius: 6 },
              {
                type: "noise",
                noiseType: "multi",
                size: 1.4,
                density: 70,
                color: "#000000",
                secondaryColor: "#ffffff",
                opacity: 65,
              },
              { type: "texture", size: 3.5, radius: 5, clipToShape: true },
            ],
          },
        );
        return { root, mulCard, dodgeCard, ox };
      });
      await frames(page, 4);
      try {
        const res = await page.evaluate(async ({ root, mulCard, dodgeCard, ox }) => {
          const w = window as unknown as W;
          const opts = {
            pageId: w.drawpane.s.pageId,
            rect: { x: ox, y: 0, width: 260, height: 180 },
            scale: 1.25,
            width: 325,
            height: 225,
          };
          const cpu = await w.drawpaneEngine.render({
            ...opts,
            backend: "cpu",
            background: [1, 1, 1, 1],
            ids: [root],
          });
          const gpu = await w.drawpaneEngine.render({
            ...opts,
            backend: "gpu",
            background: [1, 1, 1, 1],
            ids: [root],
          });
          const canvas = await w.drawpaneEngine.canvasRender({ ...opts, background: "#ffffff" });
          // Temporarily switch both blends to normal to confirm blends materially alter pixels.
          w.drawpane.commit([
            { op: "set", id: mulCard, prop: "blendMode", value: "normal" },
            { op: "set", id: dodgeCard, prop: "blendMode", value: "normal" },
          ]);
          const unblended = await w.drawpaneEngine.render({
            ...opts,
            backend: "gpu",
            background: [1, 1, 1, 1],
            ids: [root],
          });
          return { cpu, gpu, canvas, unblended };
        }, scene);
        expect(res.cpu.ok, `phase-3a-substack cpu: ${res.cpu.error}`).toBe(true);
        expect(res.gpu.ok, `phase-3a-substack gpu: ${res.gpu.error}`).toBe(true);
        expect(res.unblended.ok, `phase-3a-substack unblended: ${res.unblended.error}`).toBe(true);
        const cpuPx = Buffer.from(res.cpu.rgba ?? "", "base64");
        const gpuPx = Buffer.from(res.gpu.rgba ?? "", "base64");
        const canPx = Buffer.from(res.canvas, "base64");
        const unblendedPx = Buffer.from(res.unblended.rgba ?? "", "base64");
        const cg = score(cpuPx, gpuPx, 325, 225);
        expect(
          outsideTolerance(cg),
          `phase-3a-substack CPU vs GPU: mean=${cg.mean.toFixed(4)} p99=${cg.p99} tile=${cg.worstTile.toFixed(3)}`,
        ).toEqual([]);
        const vsCan = score(gpuPx, canPx, 325, 225);
        expect(
          vsCan.mean,
          `phase-3a-substack GPU vs canvas: mean=${vsCan.mean.toFixed(3)} tile=${vsCan.worstTile.toFixed(2)}`,
        ).toBeLessThan(2.5);
        const blendDelta = score(gpuPx, unblendedPx, 325, 225);
        expect(
          blendDelta.mean,
          `phase-3a-substack blends must visibly change pixels (mean=${blendDelta.mean.toFixed(3)})`,
        ).toBeGreaterThan(2.0);
      } finally {
        await page.evaluate(
          (id) => (window as unknown as W).drawpane.commit([{ op: "delete", id }]),
          scene.root,
        );
      }
    });

    test("blends masked content over glass without feeding glass into the next lens", async () => {
      test.skip(!Object.hasOwn(OP, "glass"), "The glass display-list reader lands in PR #237.");
      const result = await page.evaluate(async () => {
        const { drawpane: e, drawpaneEngine: engine } = window as unknown as W;
        const x = 10_400;
        const width = 96;
        const height = 64;
        const root = e.createLayer("frame", { x, y: 0, width, height }, e.s.pageId, {
          fills: [{ type: "solid", color: "#d0d0d0" }],
          clipContent: true,
        });
        try {
          const faded = e.createLayer("frame", { x, y: 0, width, height }, root, {
            opacity: 0.75,
            fills: [],
          });
          const rect = (left: number, top: number, w: number, h: number, props: object) =>
            e.createLayer("rect", { x: x + left, y: top, width: w, height: h }, faded, props);
          const glass = (frost: number) => ({
            type: "glass",
            angle: 0,
            intensity: 0,
            refraction: 80,
            depth: 8,
            dispersion: 0,
            frost,
            splay: 0,
          });
          const mask = rect(4, 4, 88, 56, {
            isMask: true,
            maskType: "alpha",
            fills: [{ type: "solid", color: "#ffffff" }],
          });
          rect(0, 8, 4, 48, { fills: [{ type: "solid", color: "#203040" }] });
          for (let left = 4; left < 92; left += 8) {
            rect(left, 4, 8, 56, {
              fills: [{ type: "solid", color: left % 16 === 4 ? "#203040" : "#b4b8be" }],
            });
          }
          const lower = rect(8, 8, 68, 48, { fills: [], cornerRadius: 8, effects: [glass(18)] });
          const multiply = rect(12, 10, 64, 42, {
            fills: [{ type: "solid", color: "#70a6d0a0" }],
            blendMode: "multiply",
          });
          const dodge = rect(38, 13, 40, 28, {
            fills: [{ type: "solid", color: "#24102660" }],
            blendMode: "linear-dodge",
            effects: [{ type: "layer-blur", radius: 4 }],
          });
          e.createLayer("frame", { x, y: 0, width, height }, faded, {
            clipContent: true,
            fills: [],
          });
          const upper = rect(24, 16, 36, 32, { fills: [], cornerRadius: 6, effects: [glass(4)] });
          const render = (backend: "cpu" | "gpu" | "webgl") =>
            engine.render({
              pageId: e.s.pageId,
              ids: [root],
              rect: { x, y: 0, width, height },
              scale: 1,
              width,
              height,
              background: [1, 1, 1, 1],
              backend,
            });
          const full = await render("cpu");
          if (!full.ok) return { full, width, height };
          const gpu = await render("gpu");
          const webgl = await render("webgl");
          e.setProp([lower], "effects", [], "Disable lower glass");
          const withoutLower = await render("cpu");
          e.setProp([lower], "effects", [glass(18)], "Restore lower glass");
          e.setProp([upper], "effects", [], "Disable upper glass");
          const withoutUpper = await render("cpu");
          e.setProp([upper], "effects", [glass(4)], "Restore upper glass");
          e.setProp([multiply, dodge], "blendMode", "normal", "Disable layer blends");
          const withoutBlends = await render("cpu");
          e.setProp([multiply], "blendMode", "multiply", "Restore multiply");
          e.setProp([dodge], "blendMode", "linear-dodge", "Restore linear dodge");
          e.setProp([mask], "isMask", false, "Disable the alpha mask");
          const withoutMask = await render("cpu");
          return {
            full,
            gpu,
            webgl,
            withoutLower,
            withoutUpper,
            withoutBlends,
            withoutMask,
            width,
            height,
          };
        } finally {
          e.commit([{ op: "delete", id: root }]);
        }
      });
      const pixels = (render: typeof result.full | undefined) => {
        expect(render?.ok, render?.error).toBe(true);
        return Buffer.from(render?.rgba ?? "", "base64");
      };
      const { width, height } = result;
      const full = pixels(result.full);
      const lower = pixels(result.withoutLower);
      const upper = pixels(result.withoutUpper);
      const normal = pixels(result.withoutBlends);
      const unmasked = pixels(result.withoutMask);
      for (const render of [result.gpu, result.webgl]) {
        expect(outsideTolerance(score(full, pixels(render), width, height))).toEqual([]);
      }
      for (let y = 22; y < 42; y++) {
        const start = (y * width + 30) * 4;
        expect(full.subarray(start, start + 24 * 4)).toEqual(lower.subarray(start, start + 24 * 4));
      }
      expect(score(full, lower, width, height).mean).toBeGreaterThan(1);
      expect(score(full, upper, width, height).mean).toBeGreaterThan(0.25);
      expect(score(full, normal, width, height).mean).toBeGreaterThan(1);
      const outsideMask = (12 * width + 1) * 4;
      expect([...full.subarray(outsideMask, outsideMask + 4)]).toEqual([208, 208, 208, 255]);
      expect(unmasked[outsideMask]).toBeLessThan(100);
    });

    test("retires evicted GPU noise tiles cleanly across 9 distinct mono noise effects on one layer", async () => {
      const scene = await page.evaluate(() => {
        const w = window as unknown as W;
        const e = w.drawpane;
        const ox = 8600;
        const root = e.createLayer("frame", { x: ox, y: 0, width: 64, height: 64 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#808080" }],
          clipContent: true,
          effects: Array.from({ length: 9 }, (_, i) => ({
            type: "noise" as const,
            noiseType: "mono" as const,
            size: 1.5,
            density: 20 + i * 8,
            color: `#${((i * 23) & 255).toString(16).padStart(2, "0")}${(((i + 3) * 29) & 255).toString(16).padStart(2, "0")}${(((i + 6) * 31) & 255).toString(16).padStart(2, "0")}80`,
            secondaryColor: "#ffffff",
            opacity: 100,
          })),
        });
        return { root, ox };
      });
      await frames(page, 4);
      try {
        const res = await page.evaluate(async ({ root, ox }) => {
          const w = window as unknown as W;
          const opts = {
            pageId: w.drawpane.s.pageId,
            rect: { x: ox, y: 0, width: 64, height: 64 },
            scale: 1,
            width: 64,
            height: 64,
          };
          const cpu = await w.drawpaneEngine.render({
            ...opts,
            backend: "cpu",
            background: [1, 1, 1, 1],
            ids: [root],
          });
          const gpu = await w.drawpaneEngine.render({
            ...opts,
            backend: "gpu",
            background: [1, 1, 1, 1],
            ids: [root],
          });
          return { cpu, gpu };
        }, scene);
        expect(res.cpu.ok, `9-noise cpu: ${res.cpu.error}`).toBe(true);
        expect(res.gpu.ok, `9-noise gpu: ${res.gpu.error}`).toBe(true);
        const cpuPx = Buffer.from(res.cpu.rgba ?? "", "base64");
        const gpuPx = Buffer.from(res.gpu.rgba ?? "", "base64");
        const cg = score(cpuPx, gpuPx, 64, 64);
        expect(
          outsideTolerance(cg),
          `9-noise CPU vs GPU: mean=${cg.mean.toFixed(4)} p99=${cg.p99} tile=${cg.worstTile.toFixed(3)}`,
        ).toEqual([]);
      } finally {
        await page.evaluate(
          (id) => (window as unknown as W).drawpane.commit([{ op: "delete", id }]),
          scene.root,
        );
      }
    });

    test("isolates non-normal blended groups across CPU, GPU, and canvas (Figma parity)", async () => {
      // Two overlapping opaque #808080 rects inside a group with blendMode=multiply over #808080
      // backdrop: isolated group multiplies once -> ~64 (not 32).
      const scene = await page.evaluate(() => {
        const w = window as unknown as W;
        const e = w.drawpane;
        const ox = 8800;
        const root = e.createLayer("frame", { x: ox, y: 0, width: 80, height: 80 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#808080" }],
          clipContent: true,
        });
        const left = e.createLayer("rect", { x: ox + 10, y: 10, width: 45, height: 60 }, root, {
          fills: [{ type: "solid", color: "#808080" }],
        });
        const right = e.createLayer("rect", { x: ox + 25, y: 10, width: 45, height: 60 }, root, {
          fills: [{ type: "solid", color: "#808080" }],
        });
        e.select([left, right]);
        e.group();
        const group = e.s.selection[0];
        if (!group || group === left || group === right)
          throw new Error("Could not group the rectangles");
        e.setProp([group], "blendMode", "multiply", "Set multiply blend");
        return { root, ox };
      });
      await frames(page, 4);
      try {
        const res = await page.evaluate(async ({ root, ox }) => {
          const w = window as unknown as W;
          const opts = {
            pageId: w.drawpane.s.pageId,
            rect: { x: ox, y: 0, width: 80, height: 80 },
            scale: 1,
            width: 80,
            height: 80,
          };
          const cpu = await w.drawpaneEngine.render({
            ...opts,
            backend: "cpu",
            background: [1, 1, 1, 1],
            ids: [root],
          });
          const gpu = await w.drawpaneEngine.render({
            ...opts,
            backend: "gpu",
            background: [1, 1, 1, 1],
            ids: [root],
          });
          const canvas = await w.drawpaneEngine.canvasRender({ ...opts, background: "#ffffff" });
          return { cpu, gpu, canvas };
        }, scene);
        expect(res.cpu.ok, res.cpu.error).toBe(true);
        expect(res.gpu.ok, res.gpu.error).toBe(true);
        const cpuPx = Buffer.from(res.cpu.rgba ?? "", "base64");
        const gpuPx = Buffer.from(res.gpu.rgba ?? "", "base64");
        const canPx = Buffer.from(res.canvas, "base64");
        // Overlap center at (40, 40) must be ~64 on all three renderers.
        const idx = (40 * 80 + 40) * 4;
        for (const [label, px] of [
          ["cpu", cpuPx],
          ["gpu", gpuPx],
          ["canvas", canPx],
        ] as const) {
          expect(px[(5 * 80 + 5) * 4], `${label} untouched backdrop`).toBe(128);
          expect(px[(40 * 80 + 15) * 4], `${label} single child`).toBe(64);
          expect(px[idx], `${label} isolated multiply overlap`).toBeGreaterThanOrEqual(62);
          expect(px[idx], `${label} isolated multiply overlap`).toBeLessThanOrEqual(66);
        }
      } finally {
        await page.evaluate(
          (id) => (window as unknown as W).drawpane.commit([{ op: "delete", id }]),
          scene.root,
        );
      }
    });

    test("export context follows a lower blur to its backdrop inputs", async ({ browser }) => {
      test.setTimeout(120_000);
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.goto("/");
        await p.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
        await p.getByRole("button", { name: "New file" }).first().click();
        await expect(p.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
          timeout: 15_000,
        });
        const m = await p.evaluate(async () => {
          const w = window as unknown as W;
          const editor = w.drawpane;
          const engine = w.drawpaneEngine;
          const parent = editor.s.pageId;
          const add = (x: number, width: number, props: object) =>
            editor.createLayer("rect", { x, y: 0, width, height: 100 }, parent, props);
          const solid = (color: string) => [{ type: "solid", color }];
          add(0, 160, { fills: solid("#000000") });
          add(52, 12, { fills: solid("#ffffff") });
          add(68, 25, {
            fills: solid("#00000001"),
            effects: [{ type: "background-blur", radius: 44 }],
          });
          const id = add(80, 60, {
            fills: solid("#00000001"),
            effects: [{ type: "background-blur", radius: 6 }],
          });
          const args = {
            pageId: parent,
            rect: { x: 0, y: 0, width: 160, height: 100 },
            scale: 1,
            width: 160,
            height: 100,
            background: [0, 0, 0, 0],
          };
          const at = (b64: string) =>
            [...atob(b64).slice((50 * 160 + 81) * 4, (50 * 160 + 81) * 4 + 4)].map((byte) =>
              byte.charCodeAt(0),
            );
          const run = async (backend: "cpu" | "gpu") => {
            const whole = await engine.render({ ...args, backend });
            const crop = await engine.render({ ...args, backend, ids: [id], context: true });
            return {
              whole: whole.ok && whole.rgba ? at(whole.rgba) : whole.error,
              crop: crop.ok && crop.rgba ? at(crop.rgba) : crop.error,
              wholeRecords: whole.stats?.records,
              cropRecords: crop.stats?.records,
            };
          };
          return { cpu: await run("cpu"), gpu: await run("gpu") };
        });
        expect(m.cpu.wholeRecords).toBe(4);
        expect(m.cpu.cropRecords).toBe(4);
        expect(Array.isArray(m.cpu.whole) && (m.cpu.whole[0] ?? 0) > 10).toBe(true);
        expect(m.cpu.crop).toEqual(m.cpu.whole);
        expect(m.gpu.cropRecords).toBeGreaterThanOrEqual(4);
        expect(Array.isArray(m.gpu.whole) && Array.isArray(m.gpu.crop)).toBe(true);
        if (Array.isArray(m.gpu.whole) && Array.isArray(m.gpu.crop)) {
          expect(m.gpu.whole[0]).toBeGreaterThan(10);
          for (let c = 0; c < 4; c++) {
            expect(Math.abs((m.gpu.crop[c] ?? 0) - (m.gpu.whole[c] ?? 0))).toBeLessThanOrEqual(2);
          }
        }
      } finally {
        await context.close();
      }
    });

    test("background and progressive blur conform across CPU, GPU, and Worker with direction, clip, and uniform controls", async () => {
      test.setTimeout(120_000);
      const scale = 2;
      const w = 320;
      const h = 240;
      // Helper to measure horizontal stripe contrast (std-dev of luminance) inside a box (device px).
      const regionContrast = (
        px: Buffer,
        imgW: number,
        x0: number,
        y0: number,
        rw: number,
        rh: number,
      ) => {
        let sum = 0;
        let sum2 = 0;
        const n = rw * rh;
        for (let y = y0; y < y0 + rh; y++) {
          for (let x = x0; x < x0 + rw; x++) {
            const i = (y * imgW + x) * 4;
            const lum = 0.299 * (px[i] ?? 0) + 0.587 * (px[i + 1] ?? 0) + 0.114 * (px[i + 2] ?? 0);
            sum += lum;
            sum2 += lum * lum;
          }
        }
        const mean = sum / n;
        return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      };
      const cropBox = (
        px: Buffer,
        imgW: number,
        x0: number,
        y0: number,
        rw: number,
        rh: number,
      ) => {
        const out = Buffer.alloc(rw * rh * 4);
        for (let y = 0; y < rh; y++) {
          const off = ((y0 + y) * imgW + x0) * 4;
          px.copy(out, y * rw * 4, off, off + rw * 4);
        }
        return out;
      };

      const ids = await page.evaluate(
        ({ w, h }) => {
          const e = (window as unknown as W).drawpane;
          const x0 = 2400;
          const y0 = 0;
          const frame = e.createLayer("frame", { x: x0, y: y0, width: w, height: h }, e.s.pageId, {
            cornerRadius: 16,
            clipContent: true,
            fills: [
              {
                type: "linear",
                from: { x: 0, y: 0 },
                to: { x: 1, y: 1 },
                stops: [
                  { position: 0, color: "#ff7a45" },
                  { position: 1, color: "#2b6cb0" },
                ],
              },
            ],
          });
          // High-contrast stripes so blur kernel and progressive direction discriminate sharply.
          for (let y = 0; y < h; y += 12)
            e.createLayer("rect", { x: x0, y: y0 + y, width: w, height: 6 }, frame, {
              fills: [{ type: "solid", color: "#111111" }],
            });
          for (let x = 0; x < w; x += 20)
            e.createLayer("rect", { x: x0 + x, y: y0, width: 4, height: h }, frame, {
              fills: [{ type: "solid", color: "#ffffffcc" }],
            });
          // 1. Uniform background blur (legacy absent blurType/offsets).
          const uniformLayer = e.createLayer(
            "rect",
            { x: x0 + 12, y: y0 + 12, width: 120, height: 80 },
            frame,
            {
              cornerRadius: 12,
              fills: [{ type: "solid", color: "#ffffff26" }],
              effects: [{ type: "background-blur", radius: 24 }],
            },
          );
          // 2. Vertical progressive background blur: sharp top (startRadius 0 at y=0) to blurred bottom (radius 24 at y=1).
          const progLayer = e.createLayer(
            "rect",
            { x: x0 + 150, y: y0 + 12, width: 158, height: 80 },
            frame,
            {
              cornerRadius: 12,
              fills: [{ type: "solid", color: "#ffffff26" }],
              effects: [
                {
                  type: "background-blur",
                  blurType: "progressive",
                  startRadius: 0,
                  radius: 24,
                  startOffset: { x: 0.5, y: 0 },
                  endOffset: { x: 0.5, y: 1 },
                },
              ],
            },
          );
          // 3. Large diagonal progressive background blur (2 -> 36; 592 x 256 device px at 2x).
          e.createLayer("rect", { x: x0 + 12, y: y0 + 104, width: 296, height: 124 }, frame, {
            cornerRadius: 18,
            fills: [{ type: "solid", color: "#ffffff26" }],
            effects: [
              {
                type: "background-blur",
                blurType: "progressive",
                startRadius: 2,
                radius: 36,
                startOffset: { x: 0, y: 0 },
                endOffset: { x: 1, y: 1 },
              },
            ],
          });
          // 4. Foreground badge painted AFTER the progressive blur (paint-order control: stays sharp).
          e.createLayer("rect", { x: x0 + 200, y: y0 + 40, width: 40, height: 20 }, frame, {
            fills: [{ type: "solid", color: "#00ff44" }],
          });
          return { frame, uniformLayer, progLayer };
        },
        { w, h },
      );
      try {
        const rect = { x: 2400, y: 0, width: w, height: h };
        const width = w * scale;
        const height = h * scale;
        const background: [number, number, number, number] = [1, 1, 1, 1];
        const renderAll = async () =>
          page.evaluate(
            async ({ frameId, rect, scale, width, height, background }) => {
              const w = window as unknown as W;
              const opts = {
                pageId: w.drawpane.s.pageId,
                rect,
                scale,
                width,
                height,
                background,
                ids: [frameId],
              };
              const cpu = await w.drawpaneEngine.render({ ...opts, backend: "cpu" });
              const gpu = await w.drawpaneEngine.render({ ...opts, backend: "gpu" });
              const webgl = await w.drawpaneEngine.render({ ...opts, backend: "webgl" });
              const list = w.drawpaneEngine.list(w.drawpane.s.pageId, [frameId]);
              return { cpu, gpu, webgl, list };
            },
            { frameId: ids.frame, rect, scale, width, height, background },
          );

        const main = await renderAll();
        expect(main.cpu.ok, main.cpu.error).toBe(true);
        expect(main.gpu.ok, main.gpu.error).toBe(true);
        const cpuPx = Buffer.from(main.cpu.rgba ?? "", "base64");
        expect(main.gpu.gpu?.backend).toBe("webgpu");
        expect(main.webgl.ok, main.webgl.error).toBe(true);
        expect(main.webgl.gpu?.backend).toBe("webgl2");
        const cg = score(cpuPx, Buffer.from(main.gpu.rgba ?? "", "base64"), width, height);
        const gl = score(cpuPx, Buffer.from(main.webgl.rgba ?? "", "base64"), width, height);
        expect(outsideTolerance(gl), "progressive blur CPU vs WebGL2").toEqual([]);
        expect(
          outsideTolerance(cg),
          `progressive blur CPU vs GPU: mean=${cg.mean.toFixed(4)} p99=${cg.p99} max=${cg.max} tile=${cg.worstTile.toFixed(3)} severe=${cg.severeInTile}`,
        ).toEqual([]);

        // Figma exported this scene at 2x, with both panes using its progressive blur.
        const figma = await decodePng(
          page,
          fileURLToPath(
            new URL(
              "../../../tools/figma-parity/goldens/progressive-background.png",
              import.meta.url,
            ),
          ),
        );
        expect([figma.width, figma.height]).toEqual([width, height]);
        const figmaPx = Buffer.from(figma.data, "base64");
        for (const [direction, x, y, rw, rh, meanCap] of [
          ["vertical", 324, 30, 120, 148, 1.6],
          ["diagonal", 88, 232, 464, 192, 1.2],
        ] as const) {
          const comparison = score(
            cropBox(cpuPx, width, x, y, rw, rh),
            cropBox(figmaPx, width, x, y, rw, rh),
            rw,
            rh,
          );
          expect(
            comparison.mean,
            `${direction} progressive blur vs Figma mean`,
          ).toBeLessThanOrEqual(meanCap);
          expect(comparison.p99, `${direction} progressive blur vs Figma p99`).toBeLessThanOrEqual(
            6,
          );
          expect(
            comparison.worstTile,
            `${direction} progressive blur vs Figma worst tile`,
          ).toBeLessThanOrEqual(2.5);
        }

        // Worker CPU matches browser CPU bit-for-bit.
        const worker = new RenderEngine(await loadNodeEngine("worker"));
        const applied = worker.apply(Uint8Array.from(Buffer.from(main.list.list, "base64")));
        expect(applied.ok, applied.ok ? "" : applied.message).toBe(true);
        const wr = worker.renderCpu(
          width,
          height,
          { zoom: scale, x: -rect.x * scale, y: -rect.y * scale, dpr: 1 },
          background,
          false,
        );
        expect(wr.ok).toBe(true);
        expect(wr.ok && Buffer.from(wr.value.pixels).equals(cpuPx)).toBe(true);
        worker.dispose();

        // Paint-order control: foreground green badge above progressive blur stays pure #00ff44.
        const badgeIdx = (50 * scale * width + 220 * scale) * 4;
        expect([cpuPx[badgeIdx], cpuPx[badgeIdx + 1], cpuPx[badgeIdx + 2]]).toEqual([0, 255, 68]);
        // Clip control: corner outside the rounded clip frame stays pure white background.
        expect([cpuPx[0], cpuPx[1], cpuPx[2]]).toEqual([255, 255, 255]);

        // Direction oracle on the vertical progressive blur (x=150..308, y=12..92 -> device 300..616, 24..184):
        // Symmetric 6 px inset bands at top (30..58) and bottom (150..178).
        // Top band near startOffset (y=0, r=0) must stay crisp; bottom band near endOffset (y=1, r=24) must blur strongly.
        const topContrast = regionContrast(cpuPx, width, 324, 30, 120, 28);
        const botContrast = regionContrast(cpuPx, width, 324, 150, 120, 28);
        expect(topContrast, "progressive start end must stay sharp").toBeGreaterThan(45);
        expect(botContrast, "progressive end must blur stripes heavily").toBeLessThan(
          topContrast * 0.45,
        );

        // Reversed endpoints control: flipping startOffset/endOffset reverses sharp and blurred bands.
        await page.evaluate((progId) => {
          (window as unknown as W).drawpane.commit([
            {
              op: "set",
              id: progId,
              prop: "effects",
              value: [
                {
                  type: "background-blur",
                  blurType: "progressive",
                  startRadius: 0,
                  radius: 24,
                  startOffset: { x: 0.5, y: 1 },
                  endOffset: { x: 0.5, y: 0 },
                },
              ],
            },
          ]);
        }, ids.progLayer);
        const flipped = await renderAll();
        expect(flipped.cpu.ok, flipped.cpu.error).toBe(true);
        const flipPx = Buffer.from(flipped.cpu.rgba ?? "", "base64");
        const flipTop = regionContrast(flipPx, width, 324, 30, 120, 28);
        const flipBot = regionContrast(flipPx, width, 324, 150, 120, 28);
        expect(flipBot, "flipped progressive start (bottom) must stay sharp").toBeGreaterThan(35);
        expect(
          flipBot,
          "flipped bottom must be much sharper than unflipped bottom",
        ).toBeGreaterThan(botContrast * 1.8);
        expect(flipTop, "flipped progressive end (top) must blur stripes heavily").toBeLessThan(
          flipBot * 0.45,
        );
        expect(flipTop, "flipped top must be much blurrier than unflipped top").toBeLessThan(
          topContrast * 0.45,
        );

        // Sharp control (radius 0.01) vs uniform-when-absent (radius 24) proves nonzero blur.
        await page.evaluate(
          ({ uniformId, progId }) => {
            (window as unknown as W).drawpane.commit([
              {
                op: "set",
                id: uniformId,
                prop: "effects",
                value: [{ type: "background-blur", radius: 0.01 }],
              },
              {
                op: "set",
                id: progId,
                prop: "effects",
                value: [{ type: "background-blur", radius: 0.01 }],
              },
            ]);
          },
          { uniformId: ids.uniformLayer, progId: ids.progLayer },
        );
        const sharp = await renderAll();
        expect(sharp.cpu.ok, sharp.cpu.error).toBe(true);
        const sharpPx = Buffer.from(sharp.cpu.rgba ?? "", "base64");
        const uniformDiff = score(
          cropBox(cpuPx, width, 40, 40, 200, 120),
          cropBox(sharpPx, width, 40, 40, 200, 120),
          200,
          120,
        );
        expect(
          uniformDiff.mean,
          "uniform blur must differ strongly from sharp control",
        ).toBeGreaterThan(20);
        // Top of original progressive blur (near startOffset y=0) closely tracks the sharp control;
        // bottom (near endOffset y=1) diverges strongly.
        const progTopVsSharp = score(
          cropBox(cpuPx, width, 324, 24, 120, 20),
          cropBox(sharpPx, width, 324, 24, 120, 20),
          120,
          20,
        );
        const progBotVsSharp = score(
          cropBox(cpuPx, width, 324, 160, 120, 20),
          cropBox(sharpPx, width, 324, 160, 120, 20),
          120,
          20,
        );
        expect(progBotVsSharp.mean).toBeGreaterThan(progTopVsSharp.mean * 3);

        console.log(
          `progressive background blur conformance: CPU vs GPU mean=${cg.mean.toFixed(4)} p99=${cg.p99} max=${cg.max} worstTile=${cg.worstTile.toFixed(3)} · contrast top=${topContrast.toFixed(1)} bot=${botContrast.toFixed(1)} flippedTop=${flipTop.toFixed(1)} flippedBot=${flipBot.toFixed(1)} · uniformVsSharp=${uniformDiff.mean.toFixed(1)} (Worker bit-identical)`,
        );
      } finally {
        await page.evaluate(
          (id) => (window as unknown as W).drawpane.commit([{ op: "delete", id }]),
          ids.frame,
        );
      }
    });

    test("recovers from device loss without losing edits, then steps down to WebGL2 on the 3rd loss", async () => {
      // 1st loss: recovers on WebGPU without losing edits.
      await page.evaluate(() => {
        const w = window as unknown as W;
        w.drawpaneEngineView?.engine?.loseGpu();
        w.drawpaneFrames.redraw();
      });
      await expect
        .poll(() => page.evaluate(() => (window as unknown as W).recoveries?.length ?? 0), {
          timeout: 15_000,
        })
        .toBe(1);
      // Add an edit right after recovery and verify pixels match a fresh render.
      await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        e.createLayer("rect", { x: 180, y: 120, width: 90, height: 60 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#12b886" }],
        });
      });
      await expect
        .poll(() => showing(page), { timeout: 25_000 })
        .toEqual({ engine: true, content: false });
      expect(await page.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend)).toBe(
        "webgpu",
      );
      expect(await page.evaluate(() => (window as unknown as W).fallbacks)).toEqual([]);
      expect(await screenMatchesFresh(page, "gpu")).toMatchObject({ identical: true });

      // 2nd loss within 60 s: recovers on WebGPU again.
      await page.evaluate(() => {
        const w = window as unknown as W;
        w.drawpaneEngineView?.engine?.loseGpu();
        w.drawpaneFrames.redraw();
      });
      await expect
        .poll(() => page.evaluate(() => (window as unknown as W).recoveries?.length ?? 0), {
          timeout: 15_000,
        })
        .toBe(2);
      await expect
        .poll(() => showing(page), { timeout: 25_000 })
        .toEqual({ engine: true, content: false });
      expect(await page.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend)).toBe(
        "webgpu",
      );

      // 3rd loss within 60 s: disables WebGPU for this session and steps down to WebGL2.
      await page.evaluate(() => {
        const w = window as unknown as W;
        w.drawpaneEngineView?.engine?.loseGpu();
        w.drawpaneFrames.redraw();
      });
      await expect
        .poll(() => page.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend), {
          timeout: 20_000,
        })
        .toBe("webgl2");
      await expect
        .poll(() => showing(page), { timeout: 15_000 })
        .toEqual({ engine: true, content: false });
      const fallbacks = await page.evaluate(() => (window as unknown as W).fallbacks);
      expect(fallbacks?.length).toBeGreaterThanOrEqual(1);
      expect(fallbacks?.[0]).toMatchObject({ from: "webgpu", to: "webgl2" });
      expect(notes.some((n) => n.includes("fell back from webgpu to webgl2"))).toBe(true);
      // Every prior edit survives on WebGL2 and matches a fresh WebGL2 render.
      expect(await screenMatchesFresh(page, "webgl")).toMatchObject({ identical: true });
    });

    test("renders directly on forced WebGL2 and steps down to CPU view mode after repeated context loss", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.addInitScript(() => {
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:renderer", "engine-webgl");
          localStorage.setItem("drawpane:engine-software", "allow");
          // Direct canvas presentation (no readback).
          localStorage.removeItem("drawpane:engine-present");
          (window as unknown as W).fallbacks = [];
          (window as unknown as W).recoveries = [];
          window.addEventListener("drawpane:renderer-fallback", (e) =>
            (window as unknown as W).fallbacks?.push(
              (e as CustomEvent).detail as NonNullable<W["fallbacks"]>[number],
            ),
          );
          window.addEventListener("drawpane:renderer-recovered", (e) =>
            (window as unknown as W).recoveries?.push(
              (e as CustomEvent).detail as NonNullable<W["recoveries"]>[number],
            ),
          );
        });
        await p.goto(page.url());
        await expect
          .poll(
            () =>
              p.evaluate(() => {
                const v = (window as unknown as W).drawpaneEngineView;
                return v
                  ? { backend: v.backend, records: v.last.records, readsBack: v.readsBack }
                  : null;
              }),
            { timeout: 60_000 },
          )
          .toMatchObject({ backend: "webgl2", readsBack: false });
        await expect
          .poll(() => showing(p), { timeout: 15_000 })
          .toEqual({ engine: true, content: false });
        expect(await p.evaluate(() => (window as unknown as W).fallbacks)).toEqual([]);

        // Lose WebGL2 context 3 times: recovers twice, then steps down to CPU view mode.
        for (let i = 1; i <= 2; i++) {
          await p.evaluate(() => {
            const w = window as unknown as W;
            w.drawpaneEngineView?.engine?.loseGpu();
            w.drawpaneFrames.redraw();
          });
          await expect
            .poll(() => p.evaluate(() => (window as unknown as W).recoveries?.length ?? 0), {
              timeout: 20_000,
            })
            .toBe(i);
          expect(await p.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend)).toBe(
            "webgl2",
          );
        }
        await p.evaluate(() => {
          const w = window as unknown as W;
          w.drawpaneEngineView?.engine?.loseGpu();
          w.drawpaneFrames.redraw();
        });
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend), {
            timeout: 20_000,
          })
          .toBe("cpu-worker");
        await expect(p.locator("[data-renderer-mode='cpu-worker']")).toBeVisible();
        const fbs = await p.evaluate(() => (window as unknown as W).fallbacks);
        expect(fbs?.some((f) => f.from === "webgl2" && f.to === "cpu-worker")).toBe(true);
      } finally {
        await context.close();
      }
    });

    test("falls back to WebGL2 when WebGPU surface acquisition fails without device loss", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.addInitScript(() => {
          localStorage.setItem("drawpane:engine-present", "webgpu");
          const canvas = document.createElement("canvas");
          const gpuCanvas = canvas.getContext("webgpu");
          if (!gpuCanvas) throw new Error("the test requires WebGPU");
          const prototype = Object.getPrototypeOf(gpuCanvas);
          prototype.getCurrentTexture = () => {
            throw new DOMException("test surface loss", "InvalidStateError");
          };
          (window as unknown as W).fallbacks = [];
          window.addEventListener("drawpane:renderer-fallback", (e) =>
            (window as unknown as W).fallbacks?.push(
              (e as CustomEvent).detail as NonNullable<W["fallbacks"]>[number],
            ),
          );
        });
        await p.goto(page.url());
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend), {
            timeout: 60_000,
          })
          .toBe("webgl2");
        await expect
          .poll(() => showing(p), { timeout: 15_000 })
          .toEqual({ engine: true, content: false });
        const fbs = await p.evaluate(() => (window as unknown as W).fallbacks);
        expect(fbs?.some((f) => f.from === "webgpu" && f.to === "webgl2")).toBe(true);
      } finally {
        await context.close();
      }
    });

    test("falls back when presenting loses the WebGPU device (headless), never blank", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.addInitScript(() => {
          localStorage.setItem("drawpane:engine-present", "webgpu");
          (window as unknown as W).fallbacks = [];
          window.addEventListener("drawpane:renderer-fallback", (e) =>
            (window as unknown as W).fallbacks?.push(
              (e as CustomEvent).detail as NonNullable<W["fallbacks"]>[number],
            ),
          );
        });
        await p.goto(page.url());
        await p.waitForFunction(
          () => ((window as unknown as W).fallbacks?.length ?? 0) > 0,
          undefined,
          { timeout: 60_000 },
        );
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend), {
            timeout: 20_000,
          })
          .toBe("webgl2");
        await expect
          .poll(() => showing(p), { timeout: 15_000 })
          .toEqual({ engine: true, content: false });
        // Verify the visible WebGL2 canvas actually painted varied pixels, and stays painted across resize.
        await expect.poll(() => visibleCanvasPainted(p), { timeout: 10_000 }).toBe(true);
        await p.setViewportSize({ width: 960, height: 640 });
        await frames(p, 4);
        await expect.poll(() => visibleCanvasPainted(p), { timeout: 10_000 }).toBe(true);
        const fbs = await p.evaluate(() => (window as unknown as W).fallbacks);
        expect(fbs?.some((f) => f.from === "webgpu" && f.to === "webgl2")).toBe(true);
        expect(JSON.stringify(fbs)).toMatch(/lost/);
      } finally {
        await context.close();
      }
    });

    test("counts read-backs in flight against the GPU budget", async () => {
      const r = await page.evaluate(() =>
        (window as unknown as W).drawpaneEngine.readbackPair(640, 480),
      );
      // The second exceeds the budget only while the first buffer is in flight.
      expect(r).toEqual([{ ok: true }, { ok: false, code: 4 }, { ok: true }]);
    });

    test("preserves translucent backdrop alpha for neutral glass inside a faded frame on CPU and GPU", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.goto("/");
        await p.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
        await p.getByRole("button", { name: "New file" }).first().click();
        await expect(p.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
          timeout: 15_000,
        });
        const m = await p.evaluate(async () => {
          const w = window as unknown as W;
          const editor = w.drawpane;
          const engine = w.drawpaneEngine;
          const pageId = editor.s.pageId;
          editor.createLayer("rect", { x: 0, y: 0, width: 64, height: 64 }, pageId, {
            fills: [{ type: "solid", color: "#ff0000", opacity: 0.3 }],
          });
          const parent = editor.createLayer(
            "frame",
            { x: 0, y: 0, width: 64, height: 64 },
            pageId,
            {
              opacity: 0.5,
              fills: [],
              clipContent: false,
            },
          );
          // Sibling inside the faded frame (top-left of frame, outside glass) must still fade by 0.5.
          editor.createLayer("rect", { x: 2, y: 2, width: 8, height: 8 }, parent, {
            fills: [{ type: "solid", color: "#00ff00", opacity: 1 }],
          });
          editor.createLayer("rect", { x: 12, y: 12, width: 40, height: 40 }, parent, {
            fills: [],
            effects: [
              {
                type: "glass",
                angle: -45,
                intensity: 0,
                refraction: 0,
                depth: 8,
                dispersion: 0,
                frost: 0,
                splay: 0,
              },
            ],
          });
          const args = {
            pageId,
            rect: { x: 0, y: 0, width: 64, height: 64 },
            scale: 1,
            width: 64,
            height: 64,
            background: [0, 0, 0, 0],
          };
          const at = (decoded: string, x: number, y: number) => {
            const start = (y * 64 + x) * 4;
            return [...decoded.slice(start, start + 4)].map((byte) => byte.charCodeAt(0));
          };
          const capture = async (backend: "cpu" | "gpu") => {
            const r = await engine.render({ ...args, backend });
            if (!r.ok || !r.rgba) return { error: r.error };
            const px = atob(r.rgba);
            return {
              corner: at(px, 0, 0),
              centre: at(px, 32, 32),
              sibling: at(px, 5, 5),
            };
          };
          return { cpu: await capture("cpu"), gpu: await capture("gpu") };
        });
        expect(m.cpu.corner).toEqual([255, 0, 0, 77]);
        expect(m.gpu.corner).toEqual([255, 0, 0, 77]);
        expect(m.cpu.centre).toEqual(m.cpu.corner);
        expect(m.gpu.centre).toEqual(m.gpu.corner);
        // Sibling inside the 50% faded frame blends 50% green over 30% red (not 100% opaque green).
        expect(m.cpu.sibling?.[1]).toBeGreaterThan(100);
        expect(m.cpu.sibling?.[1]).toBeLessThan(220);
        expect(m.gpu.sibling?.[1]).toBeGreaterThan(100);
        expect(m.gpu.sibling?.[1]).toBeLessThan(220);
      } finally {
        await context.close();
      }
    });

    test("falls back from WebGPU to WebGL2 without WebGPU, and to CPU view mode without WebGL2", async ({
      browser,
    }) => {
      // 1. Without WebGPU: lazy-loads WebGL2 and renders accurately.
      const glContext = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await glContext.newPage();
        await p.addInitScript(() => {
          Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
          localStorage.removeItem("drawpane:engine-present");
          (window as unknown as W).fallbacks = [];
          window.addEventListener("drawpane:renderer-fallback", (e) =>
            (window as unknown as W).fallbacks?.push(
              (e as CustomEvent).detail as NonNullable<W["fallbacks"]>[number],
            ),
          );
        });
        await p.goto(page.url());
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend), {
            timeout: 60_000,
          })
          .toBe("webgl2");
        await expect
          .poll(() => showing(p), { timeout: 15_000 })
          .toEqual({ engine: true, content: false });
        const fbs = await p.evaluate(() => (window as unknown as W).fallbacks);
        expect(fbs?.some((f) => f.from === "webgpu" && f.to === "webgl2")).toBe(true);
      } finally {
        await glContext.close();
      }

      // 2. Without WebGPU or WebGL2: falls back to CPU view mode in a Worker, renders tiles matching fresh CPU.
      const cpuContext = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await cpuContext.newPage();
        await p.addInitScript(() => {
          Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
          const orig = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (
            this: HTMLCanvasElement,
            type: string,
            ...args: unknown[]
          ) {
            if (type === "webgl2" || type === "webgl") return null;
            return (orig as (this: HTMLCanvasElement, t: string, ...a: unknown[]) => unknown).call(
              this,
              type,
              ...args,
            );
          } as typeof HTMLCanvasElement.prototype.getContext;
          (window as unknown as W).fallbacks = [];
          window.addEventListener("drawpane:renderer-fallback", (e) =>
            (window as unknown as W).fallbacks?.push(
              (e as CustomEvent).detail as NonNullable<W["fallbacks"]>[number],
            ),
          );
        });
        await p.goto(page.url());
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend), {
            timeout: 60_000,
          })
          .toBe("cpu-worker");
        await expect
          .poll(() => showing(p), { timeout: 20_000 })
          .toEqual({ engine: true, content: false });
        await expect(p.locator("[data-renderer-mode='cpu-worker']")).toBeVisible();
        await expect(p.locator(".canvas")).toHaveAttribute("data-renderer", "cpu-worker");
        const cmp = await screenMatchesFresh(p, "cpu");
        expect(cmp.mean).toBeLessThan(0.05);
        // Pan in CPU view mode: received tiles shift immediately and settle to exact match.
        await p.evaluate(() => {
          const e = (window as unknown as W).drawpane;
          e.state.set({ camera: e.s.camera.pan(-80, 32) });
        });
        await frames(p, 4);
        const afterPan = await screenMatchesFresh(p, "cpu");
        expect(afterPan.mean).toBeLessThan(0.05);
        const fbs = await p.evaluate(() => (window as unknown as W).fallbacks);
        // Only one transition is reported directly to the adopted backend (cpu-worker), recording
        // both failed candidates without claiming an unpresented webgl2 transition.
        expect(
          fbs?.some(
            (f) => f.from === "webgpu" && f.to === "cpu-worker" && /webgl2/i.test(f.reason),
          ),
        ).toBe(true);
      } finally {
        await cpuContext.close();
      }
    });

    test("refuses software GPU adapters by default and steps down to CPU view mode", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.addInitScript(() => {
          localStorage.setItem("drawpane:renderer", "engine");
          localStorage.removeItem("drawpane:engine-software");
          (window as unknown as W).fallbacks = [];
          window.addEventListener("drawpane:renderer-fallback", (e) =>
            (window as unknown as W).fallbacks?.push(
              (e as CustomEvent).detail as NonNullable<W["fallbacks"]>[number],
            ),
          );
        });
        await p.goto(page.url());
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend), {
            timeout: 60_000,
          })
          .toBe("cpu-worker");
        await expect.poll(() => visibleCanvasPainted(p), { timeout: 15_000 }).toBe(true);
        const fbs = await p.evaluate(() => (window as unknown as W).fallbacks);
        expect(fbs).toHaveLength(1);
        expect(fbs?.[0]).toMatchObject({ from: "webgpu", to: "cpu-worker" });
        expect(fbs?.[0]?.reason).toMatch(/webgpu:.*software/i);
        expect(fbs?.[0]?.reason).toMatch(/webgl2:.*software/i);
        // Because the WebGL2 pre-check refused SwiftShader, only the browser WASM (for CPU worker)
        // was fetched; the lazy WebGL2 WASM module was never downloaded.
        const engineWasms = await p.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .map((e) => e.name)
            .filter((u) => /engine_bg.*\.wasm/i.test(u)),
        );
        expect(engineWasms.length).toBeLessThanOrEqual(1);
        expect(engineWasms.every((u) => !/webgl/i.test(u))).toBe(true);
      } finally {
        await context.close();
      }
    });

    test("does not restart slow unchanged CPU worker exact jobs on the settle timer", async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
        viewport: { width: 1400, height: 900 },
      });
      try {
        const p = await context.newPage();
        await p.route(/engine-cpu\.worker-[^/]+\.js(?:\?|$)/, async (route) => {
          const response = await route.fetch();
          const prefix = `
            const createOriginal = globalThis.createImageBitmap;
            globalThis.createImageBitmap = async (...args) => {
              await new Promise((resolve) => setTimeout(resolve, 85));
              return createOriginal(...args);
            };
          `;
          await route.fulfill({ response, body: `${prefix}\n${await response.text()}` });
        });
        await p.addInitScript(() => {
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:renderer", "engine-cpu");
          const w = window as unknown as { cpuJobs: Array<{ jobId: number; detail: boolean }> };
          w.cpuJobs = [];
          const post = Worker.prototype.postMessage;
          Worker.prototype.postMessage = function (message: unknown, ...args: unknown[]) {
            const m = message as {
              type?: string;
              tileSize?: number;
              jobId?: number;
              detail?: boolean;
            };
            if (m?.type === "render" && m.tileSize) {
              w.cpuJobs.push({ jobId: m.jobId ?? 0, detail: !!m.detail });
            }
            return Reflect.apply(post, this, [message, ...args]);
          };
        });
        await p.goto(page.url());
        await expect
          .poll(
            () =>
              p.evaluate(() => {
                const v = (window as unknown as W).drawpaneEngineView;
                return v ? { backend: v.backend, exact: v.last.exact } : null;
              }),
            { timeout: 40_000 },
          )
          .toEqual({ backend: "cpu-worker", exact: true });
        // Once settled, sitting idle must submit zero additional jobs.
        const countAtRest = await p.evaluate(
          () => (window as unknown as { cpuJobs: unknown[] }).cpuJobs.length,
        );
        await p.waitForTimeout(800);
        const countLater = await p.evaluate(
          () => (window as unknown as { cpuJobs: unknown[] }).cpuJobs.length,
        );
        expect(countLater).toBe(countAtRest);
      } finally {
        await context.close();
      }
    });

    test("preserves cached images across three real WEBGL_lose_context losses into CPU view mode", async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.addInitScript(() => {
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:renderer", "engine-webgl");
          localStorage.setItem("drawpane:engine-software", "allow");
          localStorage.removeItem("drawpane:engine-present");
          const w = window as unknown as W & { contextLosses: number };
          w.recoveries = [];
          w.contextLosses = 0;
          window.addEventListener("drawpane:renderer-recovered", (e) =>
            w.recoveries?.push((e as CustomEvent).detail as NonNullable<W["recoveries"]>[number]),
          );
          window.addEventListener(
            "webglcontextlost",
            (e) => {
              if (e.target === w.drawpaneEngineView?.canvas) w.contextLosses++;
            },
            true,
          );
        });
        await p.goto("/");
        await p.getByRole("button", { name: "New file" }).first().click();
        await expect(p.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
          timeout: 15_000,
        });
        await expect
          .poll(
            () =>
              p.evaluate(() => {
                const v = (window as unknown as W).drawpaneEngineView;
                return v ? { backend: v.backend, shown: v.canvas.style.visibility } : null;
              }),
            { timeout: 40_000 },
          )
          .toEqual({ backend: "webgl2", shown: "visible" });

        const box = await p.locator(".canvas__overlay").boundingBox();
        if (!box) throw new Error("No editor canvas");
        await dropImage(
          p,
          { x: box.x + 180, y: box.y + 180 },
          { width: 140, height: 100, colors: ["#ff00ff"], name: "magenta.png" },
        );

        const magentaCount = () =>
          p.evaluate(async () => {
            const view = (window as unknown as W).drawpaneEngineView;
            if (!view) return -1;
            const res = await view.pixels();
            if (!res.ok || !res.value) return -1;
            let count = 0;
            for (let i = 0; i < res.value.length; i += 4) {
              if (
                (res.value[i] ?? 0) > 245 &&
                (res.value[i + 1] ?? 255) < 10 &&
                (res.value[i + 2] ?? 0) > 245
              ) {
                count++;
              }
            }
            return count;
          });

        await expect.poll(magentaCount, { timeout: 20_000 }).toBeGreaterThan(1000);
        for (let i = 1; i <= 3; i++) {
          await p.evaluate(() => {
            const view = (window as unknown as W).drawpaneEngineView;
            const gl = view?.canvas.getContext("webgl2");
            const ext = gl?.getExtension("WEBGL_lose_context");
            if (!ext) throw new Error("No WEBGL_lose_context");
            ext.loseContext();
          });
          if (i < 3) {
            await expect
              .poll(() => p.evaluate(() => (window as unknown as W).recoveries?.length ?? 0), {
                timeout: 20_000,
              })
              .toBe(i);
            await expect.poll(magentaCount, { timeout: 20_000 }).toBeGreaterThan(1000);
          }
        }
        await expect
          .poll(
            () =>
              p.evaluate(() => {
                const v = (window as unknown as W).drawpaneEngineView;
                return v ? { backend: v.backend, shown: v.canvas.style.visibility } : null;
              }),
            { timeout: 25_000 },
          )
          .toEqual({ backend: "cpu-worker", shown: "visible" });
        await expect.poll(magentaCount, { timeout: 20_000 }).toBeGreaterThan(1000);
        const losses = await p.evaluate(
          () => (window as unknown as { contextLosses: number }).contextLosses,
        );
        expect(losses).toBe(3);
      } finally {
        await context.close();
      }
    });

    test("rejects masked software WebGL2 adapters via failIfMajorPerformanceCaveat", async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.addInitScript(() => {
          Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:renderer", "engine");
          localStorage.removeItem("drawpane:engine-software");
          const proto = WebGL2RenderingContext.prototype;
          const getExtension = proto.getExtension;
          const getSupportedExtensions = proto.getSupportedExtensions;
          proto.getExtension = function (this: WebGL2RenderingContext, name: string) {
            return name === "WEBGL_debug_renderer_info"
              ? null
              : Reflect.apply(getExtension, this, [name]);
          } as typeof proto.getExtension;
          proto.getSupportedExtensions = function (this: WebGL2RenderingContext) {
            return (
              getSupportedExtensions.call(this)?.filter((x) => x !== "WEBGL_debug_renderer_info") ??
              null
            );
          };
        });
        await p.goto(page.url());
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend), {
            timeout: 45_000,
          })
          .toBe("cpu-worker");
      } finally {
        await context.close();
      }
    });

    test("renders translucent CPU view backgrounds once without darkening on redraws", async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.addInitScript(() => {
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:renderer", "engine-cpu");
        });
        await p.goto("/");
        await p.getByRole("button", { name: "New file" }).first().click();
        await expect(p.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
          timeout: 15_000,
        });
        await expect
          .poll(
            () =>
              p.evaluate(() => {
                const v = (window as unknown as W).drawpaneEngineView;
                return v ? { backend: v.backend, exact: v.last.exact } : null;
              }),
            { timeout: 35_000 },
          )
          .toEqual({ backend: "cpu-worker", exact: true });
        await p.evaluate(() => {
          const e = (window as unknown as W).drawpane;
          e.setProp([e.s.pageId], "backgroundColor", "#ff000080", "Translucent background");
        });
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).drawpaneEngineView?.last.exact), {
            timeout: 15_000,
          })
          .toBe(true);
        // Trigger a second redraw on the same translucent background to verify no accumulation.
        await p.evaluate(() => (window as unknown as W).drawpaneFrames.redraw());
        await p.waitForTimeout(400);
        const result = await p.evaluate(async () => {
          const w = window as unknown as W;
          const v = w.drawpaneEngineView;
          if (!v) throw new Error("no engine view");
          const px = await v.pixels();
          const fresh = await w.drawpaneEngine.render({
            pageId: w.drawpane.s.pageId,
            rect: { x: 0, y: 0, width: 1, height: 1 },
            scale: 1,
            width: 1,
            height: 1,
            background: [1, 0, 0, 128 / 255],
            backend: "cpu",
          });
          if (!px.ok || !px.value || !fresh.ok || !fresh.rgba) throw new Error("read failed");
          return {
            shown: Array.from(px.value.slice(0, 4)),
            rendered: [...atob(fresh.rgba)].map((c) => c.charCodeAt(0)),
          };
        });
        expect(result.rendered).toEqual([255, 0, 0, 128]);
        for (let ch = 0; ch < 4; ch++) {
          expect(
            Math.abs((result.shown[ch] ?? 0) - (result.rendered[ch] ?? 0)),
          ).toBeLessThanOrEqual(2);
        }
      } finally {
        await context.close();
      }
    });

    test("preserves edits made while GPU rebuild is gated and renders them after recovery", async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.addInitScript(() => {
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:renderer", "engine-webgl");
          localStorage.setItem("drawpane:engine-software", "allow");
          localStorage.removeItem("drawpane:engine-present");
          (window as unknown as W).recoveries = [];
          window.addEventListener("drawpane:renderer-recovered", (e) =>
            (window as unknown as W).recoveries?.push(
              (e as CustomEvent).detail as NonNullable<W["recoveries"]>[number],
            ),
          );
        });
        await p.goto(page.url());
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend), {
            timeout: 45_000,
          })
          .toBe("webgl2");
        await expect
          .poll(() => showing(p), { timeout: 15_000 })
          .toEqual({ engine: true, content: false });

        // Gate attachGpu during recovery, trigger real context loss, make an edit WHILE recovering,
        // verify the 2D cover renders non-blank content, then release recovery.
        await p.evaluate(() => {
          const w = window as unknown as W & { releaseRebuild?: () => void };
          const eng = w.drawpaneEngineView?.engine;
          if (!eng) throw new Error("no engine");
          const origAttach = eng.attachGpu.bind(eng);
          eng.attachGpu = (...args: Parameters<typeof origAttach>) =>
            new Promise((resolve) => {
              w.releaseRebuild = () => void origAttach(...args).then(resolve);
            });
          const gl = w.drawpaneEngineView?.canvas.getContext("webgl2");
          gl?.getExtension("WEBGL_lose_context")?.loseContext();
        });
        // Wait for recovery cover to take over, then create a vivid cyan rectangle during rebuild.
        await expect
          .poll(() => showing(p), { timeout: 10_000 })
          .toEqual({ engine: false, content: true });
        await expect.poll(() => visibleCanvasPainted(p), { timeout: 10_000 }).toBe(true);
        await p.evaluate(() => {
          const e = (window as unknown as W).drawpane;
          e.createLayer("rect", { x: 240, y: 180, width: 220, height: 140 }, e.s.pageId, {
            fills: [{ type: "solid", color: "#00ffff" }],
          });
        });
        await frames(p, 2);
        // Release recovery and verify the edit created mid-rebuild is visibly rendered on WebGL2.
        await p.evaluate(() => {
          (window as unknown as { releaseRebuild?: () => void }).releaseRebuild?.();
        });
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).recoveries?.length ?? 0), {
            timeout: 20_000,
          })
          .toBe(1);
        await expect
          .poll(() => showing(p), { timeout: 15_000 })
          .toEqual({ engine: true, content: false });
        const cyanVisible = await p.evaluate(async () => {
          const res = await (window as unknown as W).drawpaneEngineView?.pixels();
          if (!res?.ok || !res.value) return 0;
          let count = 0;
          for (let i = 0; i < res.value.length; i += 4) {
            if (
              (res.value[i] ?? 255) < 10 &&
              (res.value[i + 1] ?? 0) > 245 &&
              (res.value[i + 2] ?? 0) > 245
            ) {
              count++;
            }
          }
          return count;
        });
        expect(cyanVisible).toBeGreaterThan(1000);
      } finally {
        await context.close();
      }
    });

    test("falls back cleanly to canvas when engine WASM chunks fail to load at startup", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.route(/\.wasm(?:\?|$)/, (route) => route.abort("failed"));
        await p.addInitScript(() => {
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:renderer", "engine");
          localStorage.setItem("drawpane:engine-software", "allow");
          (window as unknown as W).fallbacks = [];
          window.addEventListener("drawpane:renderer-fallback", (e) =>
            (window as unknown as W).fallbacks?.push(
              (e as CustomEvent).detail as NonNullable<W["fallbacks"]>[number],
            ),
          );
        });
        await p.goto(page.url());
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).fallbacks?.length ?? 0), {
            timeout: 45_000,
          })
          .toBeGreaterThan(0);
        const fbs = await p.evaluate(() => (window as unknown as W).fallbacks);
        expect(fbs?.at(-1)?.to).toBe("canvas");
        expect(await showing(p)).toEqual({ engine: false, content: true });
        await expect.poll(() => visibleCanvasPainted(p), { timeout: 10_000 }).toBe(true);
      } finally {
        await context.close();
      }
    });

    test("falls back to WebGL2 instead of terminal Canvas when WebGPU device request fails after canvas claim", async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.addInitScript(() => {
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:renderer", "engine");
          localStorage.setItem("drawpane:engine-software", "allow");
          localStorage.removeItem("drawpane:engine-present");
          (window as unknown as W).fallbacks = [];
          window.addEventListener("drawpane:renderer-fallback", (e) =>
            (window as unknown as W).fallbacks?.push(
              (e as CustomEvent).detail as NonNullable<W["fallbacks"]>[number],
            ),
          );
          if (navigator.gpu) {
            const origRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
            navigator.gpu.requestAdapter = async (...args) => {
              const adapter = await origRequestAdapter(...args);
              if (adapter) {
                adapter.requestDevice = async () => {
                  throw new Error("fixture device request rejected");
                };
              }
              return adapter;
            };
          }
        });
        await p.goto(page.url());
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).drawpaneEngineView?.backend), {
            timeout: 45_000,
          })
          .toBe("webgl2");
        await expect
          .poll(() => showing(p), { timeout: 15_000 })
          .toEqual({ engine: true, content: false });
        await expect(p.locator(".canvas")).toHaveAttribute("data-renderer", "webgl2");
        await expect.poll(() => visibleCanvasPainted(p), { timeout: 10_000 }).toBe(true);
        const fbs = await p.evaluate(() => (window as unknown as W).fallbacks);
        expect(fbs).toMatchObject([{ from: "webgpu", to: "webgl2" }]);
      } finally {
        await context.close();
      }
    });

    test("runs phase 2 tile caching, edit invalidation, and drag settling in CPU worker mode", async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      try {
        const p = await context.newPage();
        await p.addInitScript(() => {
          localStorage.setItem("drawpane:debug", "1");
          localStorage.setItem("drawpane:renderer", "engine-cpu");
        });
        await p.goto(page.url());
        await expect
          .poll(
            () =>
              p.evaluate(() => {
                const v = (window as unknown as W).drawpaneEngineView;
                return v
                  ? {
                      backend: v.backend,
                      exact: v.last.exact,
                      held: v.last.tiles.held,
                      pending: v.last.tiles.pending,
                    }
                  : null;
              }),
            { timeout: 45_000 },
          )
          .toMatchObject({ backend: "cpu-worker", exact: true, pending: 0 });
        const initialTiles = await p.evaluate(
          () => (window as unknown as W).drawpaneEngineView?.last.tiles,
        );
        expect(initialTiles?.held ?? 0).toBeGreaterThan(0);
        expect((await screenMatchesFresh(p, "cpu")).mean).toBeLessThan(0.05);

        // Create and drag a vivid layer through several moves: dirty tiles invalidate and settle
        // exact, matching a fresh full CPU render.
        const movedId = await p.evaluate(() => {
          const e = (window as unknown as W).drawpane;
          e.zoomTo(1);
          e.centerOn({ x: 260, y: 160 });
          return e.createLayer("rect", { x: 160, y: 120, width: 110, height: 70 }, e.s.pageId, {
            fills: [{ type: "solid", color: "#e64980" }],
            cornerRadius: 8,
          });
        });
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).drawpaneEngineView?.last.exact), {
            timeout: 20_000,
          })
          .toBe(true);
        for (let step = 1; step <= 4; step++) {
          await p.evaluate(
            ({ id, step }) => {
              const e = (window as unknown as W).drawpane;
              e.commit([
                { op: "set", id, prop: "x", value: 160 + step * 28 },
                { op: "set", id, prop: "y", value: 120 + step * 14 },
              ]);
            },
            { id: movedId, step },
          );
          await frames(p, 2);
        }
        await expect
          .poll(
            () =>
              p.evaluate(() => {
                const v = (window as unknown as W).drawpaneEngineView;
                return v ? { exact: v.last.exact, dragged: v.last.tiles.dragged } : null;
              }),
            { timeout: 25_000 },
          )
          .toEqual({ exact: true, dragged: 0 });
        expect((await screenMatchesFresh(p, "cpu")).mean).toBeLessThan(0.05);

        // Recoloring invalidates only touched tiles and settles exact.
        await p.evaluate((id) => {
          const e = (window as unknown as W).drawpane;
          e.commit([
            { op: "set", id, prop: "fills", value: [{ type: "solid", color: "#2b8a3e" }] },
          ]);
        }, movedId);
        await expect
          .poll(() => p.evaluate(() => (window as unknown as W).drawpaneEngineView?.last.exact), {
            timeout: 20_000,
          })
          .toBe(true);
        expect((await screenMatchesFresh(p, "cpu")).mean).toBeLessThan(0.05);
      } finally {
        await context.close();
      }
    });
  });

test.describe("GPU blur memory budget (PR #234)", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Serves local dist/browser/ engine directly.");

  test("admits Gaussian pyramid peak work against the GPU memory budget before allocating", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const root = fileURLToPath(new URL("../../../packages/engine/dist/browser/", import.meta.url));
    const origin = "http://localhost:51389";
    await page.route(`${origin}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.substring(1);
      if (!path) return route.fulfill({ body: "<!doctype html>", contentType: "text/html" });
      return route.fulfill({
        body: await readFile(root + path),
        contentType: path.endsWith(".js") ? "text/javascript" : "application/wasm",
      });
    });
    await page.goto(origin);
    const reports = await page.evaluate(async () => {
      const url = "/engine.js";
      const glue = (await import(url)) as typeof import("@drawpane/engine/browser-glue");
      await glue.default({ module_or_path: "/engine_bg.wasm" });
      const limits = [20 * 1048576 + 131072, 192 * 1048576];
      const out = [];
      for (const budget of limits) {
        const engine = new glue.Engine(0, 0);
        const set = engine.setLimit("gpu_bytes", budget);
        if (!set.ok) throw new Error(set.message);
        set.free();
        let device = await glue.createGpu(null, 0);
        // As in the editor, let a cold shader probe retry once on a slow software adapter.
        if (!device.ok && device.code === 12) {
          device.free();
          device = await glue.createGpu(null, 0);
        }
        if (!device.ok || !engine.attachGpu || !engine.blurGpu || !engine.blurGpuStats) {
          throw new Error(device.message);
        }
        const attach = engine.attachGpu(device);
        device.free();
        if (!attach.ok) throw new Error(attach.message);
        attach.free();
        const side = budget === limits[0] ? 1024 : 2048;
        const source = new Uint8Array(side * side * 4);
        for (let i = 0, seed = 179; i < source.length; i += 4) {
          seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
          source[i] = seed >>> 24;
          source[i + 1] = seed >>> 16;
          source[i + 2] = seed >>> 8;
          source[i + 3] = 255;
        }
        const border = new Float32Array(4);
        const blur = engine.blurGpu.bind(engine);
        const window = (x: number, y: number, id: number, sigma = 16) =>
          blur(
            source,
            side,
            side,
            8,
            8,
            x,
            y,
            sigma,
            1,
            border,
            0,
            0,
            side,
            side,
            x,
            y,
            x + 8,
            y + 8,
            id,
          );
        const full = (id: number) =>
          blur(
            source,
            side,
            side,
            1280,
            1840,
            0,
            0,
            16,
            1,
            border,
            0,
            0,
            side,
            side,
            0,
            0,
            1280,
            1840,
            id,
          );
        const stats = engine.blurGpuStats.bind(engine);
        const samples = [];
        for (let i = 1; i <= (budget === limits[0] ? 2 : 8); i++) {
          // A wide kernel needs the whole source even when the output is tiny.
          const rendered = await window(side / 2, side / 2, i, 400);
          const outcome =
            rendered instanceof Uint8Array
              ? "OK"
              : { code: rendered.code, message: rendered.message };
          if (!(rendered instanceof Uint8Array)) rendered.free();
          samples.push({ outcome, cache: [...stats()] });
        }
        const cropped = [];
        if (budget === limits[1]) {
          const reference = await full(9);
          if (!(reference instanceof Uint8Array)) throw new Error(reference.message);
          for (const [x, y] of [
            [57, 79],
            [411, 603],
            [819, 1133],
          ] as const) {
            const bytesBefore = stats()[3] ?? 0;
            const rendered = await window(x, y, 10);
            if (!(rendered instanceof Uint8Array)) throw new Error(rendered.message);
            let maxDifference = 0;
            for (let j = 0; j < rendered.length; j++) {
              const at = ((y + (j >>> 5)) * 1280 + x) * 4 + (j % 32);
              maxDifference = Math.max(
                maxDifference,
                Math.abs((rendered[j] ?? 0) - (reference[at] ?? 0)),
              );
            }
            cropped.push({ maxDifference, bytesAdded: (stats()[3] ?? 0) - bytesBefore });
          }
        }
        engine.free();
        out.push({ budget, side, samples, cropped });
      }
      return out;
    });
    // The atlas and source leave too little space for the wide kernel's pyramid and readback.
    expect(reports[0]?.samples[0]?.outcome).toMatchObject({ code: 4 });
    expect(reports[0]?.samples[0]?.cache[3]).toBe(0);
    expect(reports[0]?.samples[1]?.outcome).toMatchObject({ code: 4 });
    expect(reports[0]?.samples[1]?.cache[3]).toBe(0);
    // Under a 192 MiB budget, 8 distinct 2048x2048 sources all succeed within the 32 MiB pyramid cap.
    expect(
      reports[1]?.samples.every((s) => s.outcome === "OK" && (s.cache[3] ?? 0) <= 32 * 1048576),
    ).toBe(true);
    expect(reports[1]?.samples.at(-1)?.cache[2]).toBeGreaterThan(0);
    expect(reports[1]?.cropped).toHaveLength(3);
    for (const sample of reports[1]?.cropped ?? []) {
      expect(sample.maxDifference).toBeLessThanOrEqual(1);
      expect(sample.bytesAdded).toBeLessThan(1 << 20);
    }
  });
});
