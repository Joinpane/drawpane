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
import { freshInstance, type Instance } from "./fresh-instance";

test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      ...(process.env.ENGINE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
    ],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

type W = {
  drawpane: {
    s: {
      pageId: string;
      camera: { x: number; y: number; zoom: number; pan(dx: number, dy: number): unknown };
    };
    state: { set(patch: object): void };
    createLayer(t: string, r: object, p: string, props?: object): string;
    commit(ops: object[]): boolean;
    zoomTo(z: number): void;
    centerOn(p: { x: number; y: number }): void;
  };
  drawpaneFrames: { redraw(): void };
  drawpaneEngineView?: {
    last: { supported: boolean; records: number; exact: boolean; plan: string };
    engine: {
      records: number;
      gpuPixels(): Promise<{ ok: boolean; value?: Uint8Array; message?: string }>;
      loseGpu(): void;
      gpu: { adapter: string } | null;
    };
    unsupported(): Record<string, number>;
  };
  drawpaneEngine: {
    readbackPair(w: number, h: number): Promise<Array<{ ok: boolean; code?: number }>>;
    render(o: object): Promise<{ ok: boolean; rgba?: string; error?: string }>;
    canvasRender(o: object): Promise<string>;
  };

  fallbacks?: unknown[];
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
): Promise<{ identical: boolean; mean: number; cpu: ReturnType<typeof score> }> {
  await settled(page);
  const r = await page.evaluate(async () => {
    const w = window as unknown as W;
    const view = w.drawpaneEngineView;
    if (!view) throw new Error("no engine view");
    const shown = await view.engine.gpuPixels();
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
    const fresh = await w.drawpaneEngine.render({ ...at, backend: "gpu" });
    // And the CPU's whole frame: the GPU's tiles must hold the picture, not just agree with
    // themselves (a blank tile would match a blank fresh render).
    const cpu = await w.drawpaneEngine.render({ ...at, backend: "cpu" });
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
  });
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
        (window as unknown as W).pageFallbacks = [];
        window.addEventListener("drawpane:renderer-fallback", (e) =>
          (window as unknown as W).fallbacks?.push((e as CustomEvent).detail),
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
            return v?.last.supported === true && v.engine.records > 0 && v.last.exact;
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

    test("draws the page with the engine, under the overlay", async () => {
      const fallbacks = await page.evaluate(() => (window as unknown as W).fallbacks);
      expect(fallbacks, "the engine fell back").toEqual([]);
      // Read back (headless), the engine's first frame shows once it lands.
      await expect
        .poll(() => showing(page), { timeout: 15_000 })
        .toEqual({ engine: true, content: false });
      const adapter = await page.evaluate(
        () => (window as unknown as W).drawpaneEngineView?.engine.gpu?.adapter,
      );
      test.info().annotations.push({ type: "adapter", description: String(adapter) });
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

    test("falls back to the canvas renderer when the device is lost", async () => {
      await page.evaluate(() => (window as unknown as W).drawpaneEngineView?.engine.loseGpu());
      await page.evaluate(() => (window as unknown as W).drawpaneFrames.redraw());
      await frames(page, 8);
      expect(await showing(page)).toEqual({ engine: false, content: true });
      const fallbacks = await page.evaluate(() => (window as unknown as W).fallbacks);
      expect(fallbacks?.length).toBe(1);
      expect(JSON.stringify(fallbacks)).toMatch(/lost|8/);
      expect(notes.some((n) => n.includes("is off for this session"))).toBe(true);
      // And the canvas renderer drew the page: not blank.
      const painted = await page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>(
          ".canvas canvas.canvas__layer",
        ) as HTMLCanvasElement;
        const d = (c.getContext("2d") as CanvasRenderingContext2D).getImageData(
          0,
          0,
          c.width,
          c.height,
        ).data;
        const first = d.slice(0, 4).join();
        for (let i = 0; i < d.length; i += 4 * 97)
          if (d.slice(i, i + 4).join() !== first) return true;
        return false;
      });
      expect(painted).toBe(true);
    });

    test("falls back when surface acquisition fails without device loss", async ({ browser }) => {
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
            (window as unknown as W).fallbacks?.push((e as CustomEvent).detail),
          );
        });
        await p.goto(page.url());
        await p.waitForFunction(
          () => {
            const w = window as unknown as W;
            return (w.fallbacks?.length ?? 0) > 0 || (w.drawpaneEngineView?.last.records ?? 0) > 0;
          },
          undefined,
          { timeout: 60_000 },
        );
        await frames(p, 8);
        expect(await showing(p)).toEqual({ engine: false, content: true });
        expect(await p.evaluate(() => (window as unknown as W).fallbacks)).toHaveLength(1);
      } finally {
        await context.close();
      }
    });

    test("falls back when presenting loses the device (headless), never blank", async ({
      browser,
    }) => {
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      const p = await context.newPage();
      await p.addInitScript(() => {
        localStorage.setItem("drawpane:engine-present", "webgpu");
        (window as unknown as W).fallbacks = [];
        window.addEventListener("drawpane:renderer-fallback", (e) =>
          (window as unknown as W).fallbacks?.push((e as CustomEvent).detail),
        );
      });
      await p.goto(page.url());
      await p.waitForFunction(
        () => ((window as unknown as W).fallbacks?.length ?? 0) > 0,
        undefined,
        { timeout: 60_000 },
      );
      await frames(p, 8);
      expect(await showing(p)).toEqual({ engine: false, content: true });
      expect(JSON.stringify(await p.evaluate(() => (window as unknown as W).fallbacks))).toMatch(
        /lost/,
      );
      await context.close();
    });

    test("counts read-backs in flight against the GPU budget", async () => {
      const r = await page.evaluate(() =>
        (window as unknown as W).drawpaneEngine.readbackPair(640, 480),
      );
      // The first is admitted; the second, beside it, is past the budget (Limit, 4).
      expect(r).toEqual([{ ok: true }, { ok: false, code: 4 }]);
    });

    test("falls back without WebGPU", async ({ browser }) => {
      const context = await browser.newContext({
        baseURL: instance.url,
        storageState: await instance.context.storageState(),
      });
      const p = await context.newPage();
      await p.addInitScript(() => {
        Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
        (window as unknown as W).fallbacks = [];
        window.addEventListener("drawpane:renderer-fallback", (e) =>
          (window as unknown as W).fallbacks?.push((e as CustomEvent).detail),
        );
      });
      await p.goto(page.url());
      await p.waitForFunction(
        () => ((window as unknown as W).fallbacks?.length ?? 0) > 0,
        undefined,
        { timeout: 60_000 },
      );
      await frames(p);
      expect(await showing(p)).toEqual({ engine: false, content: true });
      await context.close();
    });
  });
