/**
 * The render engine in the editor, behind its switch (decision 0040, phase 1):
 *
 * - with `drawpane:renderer` set to "engine", the engine draws the page into its WebGPU canvas
 *   under the overlay, and the content canvas is hidden;
 * - after edits (patches) and camera moves, what's on screen equals a fresh engine's render of
 *   the same page and camera (read back through a buffer, never through the canvas);
 * - on the e2e scene, the engine agrees with the canvas renderer within a bound;
 * - a page holding what the engine doesn't draw yet (a shadow) is drawn by the canvas renderer,
 *   and the engine takes over again when it's gone;
 * - a lost device, and a browser without WebGPU, fall back to the canvas renderer with a
 *   console note and a `drawpane:renderer-fallback` event, never a blank canvas. A headless
 *   browser loses the device as soon as a WebGPU canvas presents, so the default presentation
 *   is that test here; the others read frames back through a buffer
 *   (`drawpane:engine-present` = "readback").
 */
import { score } from "@drawpane/engine/compare";
import { expect, type Page, test } from "@playwright/test";
import { dropImage, freshInstance, type Instance } from "./fresh-instance";

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
      camera: { x: number; y: number; zoom: number; pan(dx: number, dy: number): unknown };
    };
    state: { set(patch: object): void };
    createLayer(t: string, r: object, p: string, props?: object): string;
    commit(ops: object[]): boolean;
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
    readbackPair(w: number, h: number): Promise<Array<{ ok: boolean; code?: number }>>;
    render(o: object): Promise<{ ok: boolean; rgba?: string; error?: string }>;
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
    const at = {
      pageId: w.drawpane.s.pageId,
      rect: {
        x: -x / zoom,
        y: -y / zoom,
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
        e.state.set({ camera: e.s.camera.pan(-137, 41) });
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
      const shadow = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        return e.createLayer("rect", { x: 40, y: 420, width: 100, height: 60 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#ffffff" }],
          effects: [{ type: "drop-shadow", x: 0, y: 4, blur: 12, spread: 0, color: "#00000040" }],
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
      }, shadow);
      await expect
        .poll(() => showing(page), { timeout: 15_000 })
        .toEqual({ engine: true, content: false });
    });

    test("leaves a page it can't draw to the canvas renderer, and takes it back", async () => {
      const shadow = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        return e.createLayer("rect", { x: 40, y: 420, width: 100, height: 60 }, e.s.pageId, {
          fills: [{ type: "solid", color: "#ffffff" }],
          effects: [{ type: "drop-shadow", x: 0, y: 4, blur: 12, spread: 0, color: "#00000040" }],
        });
      });
      await frames(page);
      expect(await showing(page)).toEqual({ engine: false, content: true });
      expect(
        await page.evaluate(() => (window as unknown as W).drawpaneEngineView?.unsupported()),
      ).toEqual({ shadow: 1 });
      // The page's fallback is reported, with what it holds (an earlier one may be from while its
      // fonts loaded, when its text couldn't be outlined yet).
      expect(await page.evaluate(() => (window as unknown as W).pageFallbacks?.at(-1))).toEqual({
        pageId: expect.any(String),
        features: { shadow: 1 },
      });
      await page.evaluate(
        (id) => (window as unknown as W).drawpane.commit([{ op: "delete", id }]),
        shadow,
      );
      // Read back (headless), the engine's frame shows once it lands, never before.
      await expect
        .poll(() => showing(page), { timeout: 15_000 })
        .toEqual({ engine: true, content: false });
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
      // The first is admitted; the second, beside it, is past the budget (Limit, 4).
      expect(r).toEqual([{ ok: true }, { ok: false, code: 4 }]);
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
