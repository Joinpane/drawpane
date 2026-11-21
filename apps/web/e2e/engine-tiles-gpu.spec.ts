/**
 * The engine's tiles on the GPU (decision 0040, phase 2), driven through the browser glue alone:
 * frames the native tests can't reach, because the GPU's tile loop spends a time budget where
 * the CPU's counts jobs. Each case failed before its fix.
 *
 * The page is served from an origin this spec answers itself (no server behind it), so it runs
 * beside the editor's suites on any port. It needs the browser build of the engine
 * (`pnpm --filter @drawpane/engine build`).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ListWriter, PathData, ROOT } from "@drawpane/engine/wire";
import { expect, type Page, test } from "@playwright/test";

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

type GpuBuild = "browser" | "webgl";
const ROOTS: Record<GpuBuild, string> = {
  browser: fileURLToPath(new URL("../../../packages/engine/dist/browser/", import.meta.url)),
  webgl: fileURLToPath(new URL("../../../packages/engine/dist/webgl/", import.meta.url)),
};
/** Answered by `page.route`, never connected to. */
const origin = `http://localhost:${process.env.ENGINE_TILES_ORIGIN_PORT ?? "8893"}`;
const red = [255, 0, 0, 255];

type Frame = {
  camera: [zoom: number, x: number, y: number, dpr: number];
  size: [width: number, height: number];
  pixel: [x: number, y: number];
  moving: boolean;
  budget: number;
  editorViewport?: boolean;
  /** Applied before the frame. */
  patch?: number[];
  /** Idle tile slice (`renderGpuAhead`) run before the frame. */
  aheadBudget?: number;
};

/** A square of `size` page units filled with `color`, as a fresh list or a patch on `base`. */
function solid(
  size: number,
  color: readonly [number, number, number, number] = [1, 0, 0, 1],
  base = 0xffffffff,
): number[] {
  const list = new ListWriter(base, base === 0xffffffff ? 1 : base + 1);
  if (base === 0xffffffff) list.reset();
  list.set(1, ROOT, {
    flags: 0,
    transform: [1, 0, 0, 1, 0, 0],
    opacity: 1,
    width: size,
    height: size,
    coarseBelow: 0,
    reach: 0,
    unsupported: 0,
    paths: [{ kind: "rect", w: size, h: size, radii: [0, 0, 0, 0], smoothing: 0 }],
    ops: [{ op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } }],
    coarse: [],
  });
  return [...list.finish()];
}

function directStripes(): number[] {
  const list = new ListWriter(0xffffffff, 1);
  list.reset();
  for (let i = 0; i < 12; i++) {
    list.set(i + 1, ROOT, {
      flags: 0,
      transform: [1, 0, 0, 1, 20 + i * 6, 24],
      opacity: 1,
      width: 2,
      height: 48,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w: 2, h: 48, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops: [{ op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 0, 0, 1] } }],
      coarse: [],
    });
  }
  return [...list.finish()];
}

async function openEngine(page: Page, build: GpuBuild) {
  const root = ROOTS[build];
  await page.route(`${origin}/**`, async (route) => {
    const filename = new URL(route.request().url()).pathname.slice(1);
    if (filename === "engine.js" || filename === "engine_bg.wasm") {
      await route.fulfill({
        body: await readFile(root + filename),
        contentType: filename.endsWith(".js") ? "text/javascript" : "application/wasm",
      });
    } else {
      await route.fulfill({ body: "<!doctype html>", contentType: "text/html" });
    }
  });
  await page.goto(origin);
}

/** Draws `frames` in turn on a GPU engine given `list`; answers each one's stats and pixel. */
async function sample(
  page: Page,
  list: number[],
  frames: Frame[],
  tileBytes?: number,
  build: GpuBuild = "browser",
) {
  await openEngine(page, build);
  const expectedBackend = build === "webgl" ? "webgl2" : "webgpu";
  return page.evaluate(
    async ({ list, frames, tileBytes, expectedBackend }) => {
      const name = "/engine.js";
      const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
      await glue.default({ module_or_path: "/engine_bg.wasm" });
      const engine = new glue.Engine(0, 0);
      const requireOk = (out: { ok: boolean; message: string; free(): void }) => {
        const { ok, message } = out;
        out.free();
        if (!ok) throw new Error(message);
      };
      try {
        if (tileBytes !== undefined) requireOk(engine.setLimit("tile_bytes", tileBytes));
        const device = await glue.createGpu(null, 0);
        if (!device.ok) throw new Error(device.message);
        if (device.backend !== expectedBackend) {
          const got = device.backend;
          device.free();
          throw new Error(`expected backend ${expectedBackend}, got ${got}`);
        }
        if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels) {
          throw new Error("the browser glue has no GPU entry points");
        }
        try {
          requireOk(engine.attachGpu(device));
        } finally {
          device.free();
        }
        requireOk(engine.apply(new Uint8Array(list)));
        const sampled = [];
        for (const frame of frames) {
          if (frame.patch) requireOk(engine.apply(new Uint8Array(frame.patch)));
          let aheadDrawn = 0;
          if (frame.aheadBudget !== undefined && engine.renderGpuAhead) {
            const ahead = engine.renderGpuAhead(new Float32Array(4), frame.aheadBudget);
            aheadDrawn = ahead.tiles_drawn;
            requireOk(ahead);
          }
          const [width, height] = frame.size;
          const outcome = engine.renderGpu(
            width,
            height,
            ...frame.camera,
            new Float32Array(4),
            frame.moving,
            frame.budget,
            frame.editorViewport,
          );
          const stats = {
            exact: outcome.exact,
            drawn: outcome.tiles_drawn,
            pending: outcome.pending,
            aheadDrawn,
          };
          requireOk(outcome);
          const pixels = await engine.gpuPixels();
          if (!(pixels instanceof Uint8Array)) throw new Error(pixels.message);
          const at = (frame.pixel[1] * width + frame.pixel[0]) * 4;
          sampled.push({ ...stats, pixel: [...pixels.subarray(at, at + 4)] });
        }
        return sampled;
      } finally {
        engine.free();
      }
    },
    { list, frames, tileBytes, expectedBackend },
  );
}

for (const build of ["browser", "webgl"] as const) {
  test.describe(`GPU tiles (${build})`, () => {
    test("a rejected hardware-budget resize preserves the directly presented front buffer", async ({
      page,
      browserName,
    }) => {
      test.skip(browserName !== "chromium", "Requires the Chromium GPU canvas");
      test.skip(
        build === "browser" && process.env.GPU_BENCH_XVFB !== "1",
        "Headless Chromium loses its WebGPU device when a canvas presents.",
      );
      await openEngine(page, build);
      const state = await page.evaluate(
        async ({ list, expectedBackend }) => {
          const url = "/engine.js";
          const glue = (await import(url)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const engine = new glue.Engine(0, 0);
          const requireOk = (result: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = result;
            result.free();
            if (!ok) throw new Error(message);
          };
          try {
            requireOk(engine.setLimit("gpu_bytes", 22 << 20));
            const canvas = document.createElement("canvas");
            document.body.append(canvas);
            const gpu = await glue.createGpu(canvas, 0);
            if (
              !gpu.ok ||
              gpu.backend !== expectedBackend ||
              !engine.attachGpu ||
              !engine.renderGpu ||
              !engine.gpuPixels
            )
              throw new Error(gpu.message || `expected ${expectedBackend}, got ${gpu.backend}`);
            try {
              requireOk(engine.attachGpu(gpu));
            } finally {
              gpu.free();
            }
            requireOk(engine.apply(new Uint8Array(list)));
            const bg = new Float32Array([0, 0, 0, 1]);
            const first = engine.renderGpu(160, 96, 1, 0, 0, 1, bg, false, 0, true);
            const presented = first.presented;
            requireOk(first);
            // Large window with no padded readers, so this uses the actual GPU byte
            // budget even on SwiftShader. The failed draw must leave the surface alone.
            const rejected = engine.renderGpu(1024, 1024, 1, 0, 0, 1, bg, false, 0, true);
            const error = { code: rejected.code, message: rejected.message };
            rejected.free();
            const pixels = await engine.gpuPixels();
            if (!(pixels instanceof Uint8Array)) throw new Error(pixels.message);
            const at = (48 * 160 + 80) * 4;
            return {
              presented,
              error,
              size: [canvas.width, canvas.height],
              bytes: pixels.length,
              stripe: [...pixels.subarray(at, at + 4)],
              background: [...pixels.subarray(0, 4)],
            };
          } finally {
            engine.free();
          }
        },
        { list: directStripes(), expectedBackend: build === "browser" ? "webgpu" : "webgl2" },
      );
      expect(state.presented).toBe(true);
      expect(state.error).toMatchObject({
        code: 4,
        message: expect.stringContaining("GPU memory"),
      });
      expect(state.size).toEqual([160, 96]);
      expect(state.bytes).toBe(160 * 96 * 4);
      expect(state.stripe).toEqual(red);
      expect(state.background).toEqual([0, 0, 0, 255]);
    });

    test("a zoom with one GPU page of tile slots still covers the view", async ({ page }) => {
      // 16 slots, 16 tiles in view: the coarse tiles the zoom draws must fit, or the view's own
      // tiles are drawn straight into the frame; the far corner is never left blank.
      const [, frame] = await sample(
        page,
        solid(3500),
        [
          {
            size: [1536, 1536],
            pixel: [32, 32],
            camera: [1, 4000, 4000, 1],
            moving: false,
            budget: 0,
          },
          {
            size: [1536, 1536],
            pixel: [1200, 1200],
            camera: [2, -0.25, -0.25, 1],
            moving: true,
            budget: 4,
          },
        ],
        16 << 20,
        build,
      );
      expect(frame?.pixel).toEqual(red);
    });

    test("a spent time budget still draws what nothing stands in for", async ({ page }) => {
      // A pan with an edit: the tile nearest the centre is only stale (it stands in for itself),
      // the one entering on the right has nothing. Past the budget, the first waits; the second
      // never.
      const [, frame] = await sample(
        page,
        solid(6000),
        [
          { size: [2560, 512], pixel: [32, 32], camera: [1, 0, 0, 1], moving: false, budget: 0 },
          {
            size: [2560, 512],
            pixel: [2480, 256],
            camera: [1, -1024, 0, 1],
            moving: false,
            budget: 0.000001,
            patch: solid(6000, [0, 1, 0, 1], 1),
          },
        ],
        16 << 20,
        build,
      );
      expect(frame?.pixel).toEqual([0, 255, 0, 255]);
    });

    test("a drag of a selection over more than 4,096 tiles keeps the view drawn", async ({
      page,
    }) => {
      // A 34,000 px square moved, with no frame before at this place: the tiles under it are left
      // to the drag's composite, which must cover every one on screen.
      const patch = new ListWriter(1, 2);
      patch.transform(1, [1, 0, 0, 1, 1, 0]);
      const [, frame] = await sample(
        page,
        solid(34_000),
        [
          { size: [64, 64], pixel: [32, 32], camera: [1, 6000, 0, 1], moving: false, budget: 0 },
          {
            size: [64, 64],
            pixel: [32, 32],
            camera: [1, 0, 0, 1],
            moving: false,
            budget: 0.000001,
            patch: [...patch.finish()],
          },
        ],
        undefined,
        build,
      );
      expect(frame?.pixel).toEqual(red);
    });

    test("a drag erases its selection where only the last frame showed it", async ({ page }) => {
      // The view opens elsewhere, so no tile is kept where the selection is moved in; moved out,
      // the last frame's pixels are all that show it there, and a moving frame with no budget for
      // optional tiles must still erase it.
      const shift = (revision: number, x: number) => {
        const patch = new ListWriter(revision - 1, revision);
        patch.transform(1, [1, 0, 0, 1, x, 8]);
        return [...patch.finish()];
      };
      const moved = (revision: number, x: number): Frame => ({
        size: [64, 64],
        pixel: [32, 16],
        camera: [1, 0, 0, 1],
        moving: true,
        budget: 0.000001,
        patch: shift(revision, x),
      });
      const [, movedIn, movedOut] = await sample(
        page,
        solid(16),
        [
          { size: [64, 64], pixel: [32, 16], camera: [1, 4096, 0, 1], moving: false, budget: 0 },
          moved(2, 24),
          moved(3, 600),
        ],
        16 << 20,
        build,
      );
      expect(movedIn?.pixel).toEqual(red);
      expect(movedOut?.pixel).toEqual([0, 0, 0, 0]);
    });

    test("a page opened at a fractional device pixel ratio shows the coarse frame it draws and settles via renderGpuAhead", async ({
      page,
    }) => {
      // The opening frame draws a coarser level first: at 1.25 it must still be one the composite
      // lays (at most 4x coarser), never a frame of background only; then `renderGpuAhead` draws
      // exact tiles ahead so the next frame lands exact with zero new tile work.
      const [coarse, exact] = await sample(
        page,
        solid(512),
        [
          { size: [64, 64], pixel: [32, 32], camera: [1, 0, 0, 1.25], moving: false, budget: 12 },
          {
            size: [64, 64],
            pixel: [32, 32],
            camera: [1, 0, 0, 1.25],
            moving: false,
            budget: 0,
            aheadBudget: 0,
          },
        ],
        undefined,
        build,
      );
      expect(coarse?.exact).toBe(false);
      expect(coarse?.drawn).toBeGreaterThan(0);
      expect(coarse?.pixel).toEqual(red);
      expect(exact?.aheadDrawn).toBeGreaterThan(0);
      expect(exact?.exact).toBe(true);
      expect(exact?.drawn).toBe(0);
      expect(exact?.pixel).toEqual(red);
    });

    test("a see-through glyph run covers its overlaps once, on the GPU, the CPU and in a PNG", async ({
      page,
    }) => {
      // One glyph, a disjoint one, then the first again in the same place, at half alpha: covered
      // once, as Figma covers a text layer's overlaps (alpha 128). The CPU and its PNG export laid
      // the masks one over another (192) while the GPU laid them into one image.
      const list = (glyphs: number[], opacity: number) => {
        const writer = new ListWriter(0xffffffff, 1);
        writer.reset();
        writer.glyph(
          1,
          new PathData().moveTo(0, 0).lineTo(16, 0).lineTo(16, 16).lineTo(0, 16).close(),
        );
        writer.set(1, ROOT, {
          flags: 0,
          transform: [1, 0, 0, 1, 8, 8],
          opacity: 1,
          width: 64,
          height: 48,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [{ kind: "glyphs", scale: 1, glyphs }],
          ops: [
            {
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: { kind: "solid", color: [1, 0, 0, opacity] },
            },
          ],
          coarse: [],
        });
        return [...writer.finish()];
      };
      const cases = [
        list([1, 0, 24, 1, 32, 24, 1, 0, 24], 0.5),
        list([1, 0, 24, 1, 32, 24, 1, 0, 24], 1),
        list([1, 0, 24, 1, 32, 24], 0.5),
      ];
      const root = ROOTS[build];
      await page.route(`${origin}/**`, async (route) => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (name === "engine.js" || name === "engine_bg.wasm") {
          await route.fulfill({
            body: await readFile(root + name),
            contentType: name.endsWith(".js") ? "text/javascript" : "application/wasm",
          });
        } else {
          await route.fulfill({ body: "<!doctype html>", contentType: "text/html" });
        }
      });
      await page.goto(origin);
      const results = await page.evaluate(async (cases) => {
        const name = "/engine.js";
        const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
        await glue.default({ module_or_path: "/engine_bg.wasm" });
        const out = [];
        const bg = new Float32Array(4);
        for (const [i, bytes] of cases.entries()) {
          const device = await glue.createGpu(null, 0);
          if (!device.ok) throw new Error(device.message);
          const e = new glue.Engine(0, 0);
          try {
            const check = (r: { ok: boolean; message: string; free(): void }) => {
              try {
                if (!r.ok) throw new Error(r.message);
              } finally {
                r.free();
              }
            };
            if (!e.attachGpu || !e.renderGpu || !e.gpuPixels)
              throw new Error("no GPU entry points");
            check(e.apply(new Uint8Array(bytes)));
            check(e.attachGpu(device));
            check(e.renderBand(96, 64, 1, 0, 0, 1, bg, 0, 64));
            const cpu = e.pixels();
            const frame = e.renderGpu(96, 64, 1, 0, 0, 1, bg, false, 0);
            const exact = frame.exact;
            check(frame);
            const gpu = await e.gpuPixels();
            if (!(gpu instanceof Uint8Array)) throw new Error(gpu.message);
            const at = (24 * 96 + 16) * 4;
            let worstAlpha = 0;
            for (let k = 3; k < cpu.length; k += 4)
              worstAlpha = Math.max(worstAlpha, Math.abs((cpu[k] ?? 0) - (gpu[k] ?? 0)));
            let png: number[] | null = null;
            if (i === 0) {
              check(e.pngBegin(96, 64, 1, 0, 0, 1, 64));
              check(e.pngBand(bg));
              const img = await createImageBitmap(
                new Blob([new Uint8Array(e.pngTake()), new Uint8Array(e.pngEnd())], {
                  type: "image/png",
                }),
              );
              const ctx = new OffscreenCanvas(96, 64).getContext("2d");
              if (!ctx) throw new Error("no 2D context");
              ctx.drawImage(img, 0, 0);
              png = Array.from(ctx.getImageData(16, 24, 1, 1).data);
              img.close();
            }
            out.push({
              exact,
              worstAlpha,
              cpu: [...cpu.slice(at, at + 4)],
              gpu: [...gpu.slice(at, at + 4)],
              png,
            });
          } finally {
            e.free();
            device.free();
          }
        }
        return out;
      }, cases);
      expect(results.every((r) => r.exact)).toBe(true);
      for (const r of results) expect(r.worstAlpha, JSON.stringify(r)).toBeLessThanOrEqual(2);
      const [overlap] = results;
      expect(Math.abs((overlap?.gpu[3] ?? 0) - 128)).toBeLessThanOrEqual(1);
      expect(Math.abs((overlap?.cpu[3] ?? 0) - 128)).toBeLessThanOrEqual(1);
      // A PNG is straight (unpremultiplied) red at the run's alpha.
      expect(Math.abs((overlap?.png?.[3] ?? 0) - 128)).toBeLessThanOrEqual(1);
    });
  });
}

for (const build of ["browser", "webgl"] as const) {
  test(`glass scratch budget and moving reader frames (${build})`, async ({ page }) => {
    test.setTimeout(180_000);
    const root = ROOTS[build];
    const expectedBackend = build === "webgl" ? "webgl2" : "webgpu";
    const glassScene = (
      base = 0xffffffff,
      revision = 1,
      kind: "glass" | "deep-frost" | "uniform" | "progressive" | "plain" = "glass",
    ) => {
      const w = new ListWriter(base, revision);
      w.reset();
      w.set(1, ROOT, {
        flags: 0,
        transform: [1, 0, 0, 1, 0, 0],
        opacity: 1,
        width: 512,
        height: 512,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [
          { kind: "rect", w: 512, h: 512, radii: [0, 0, 0, 0], smoothing: 0 },
          {
            kind: "path",
            path: new PathData().moveTo(4, 0).lineTo(5, 0).lineTo(5, 512).lineTo(4, 512).close(),
          },
        ],
        ops: [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.1, 0.4, 0.9, 1] },
          },
          { op: "fill", path: 1, evenOdd: false, paint: { kind: "solid", color: [1, 0, 0, 1] } },
        ],
        coarse: [],
      });
      if (kind !== "plain") {
        w.set(2, ROOT, {
          flags: 0,
          transform: [1, 0, 0, 1, 64, 64],
          opacity: 1,
          width: 320,
          height: 240,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [{ kind: "rect", w: 320, h: 240, radii: [24, 24, 24, 24], smoothing: 0 }],
          ops:
            kind === "glass" || kind === "deep-frost"
              ? [
                  {
                    op: "glass",
                    paths: [0],
                    evenOdd: false,
                    kind: 0,
                    inradius: 120,
                    angle: -45,
                    intensity: 80,
                    refraction: 75,
                    depth: 20,
                    dispersion: 50,
                    frost: kind === "deep-frost" ? 100 : 4,
                    splay: 0,
                    boxRadii: [24, 24, 24, 24],
                    boxSmoothing: [0, 0, 0, 0],
                  },
                ]
              : kind === "uniform"
                ? [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius: 24 }]
                : [
                    {
                      op: "progressiveBlur",
                      paths: [0],
                      evenOdd: false,
                      startRadius: 2,
                      endRadius: 36,
                      start: [0, 0],
                      end: [1, 1],
                    },
                  ],
          coarse: [],
        });
      }
      return [...w.finish()];
    };

    await page.route(`${origin}/**`, async (route) => {
      const filename = new URL(route.request().url()).pathname.slice(1);
      if (filename === "engine.js" || filename === "engine_bg.wasm") {
        await route.fulfill({
          body: await readFile(root + filename),
          contentType: filename.endsWith(".js") ? "text/javascript" : "application/wasm",
        });
      } else {
        await route.fulfill({ body: "<!doctype html>", contentType: "text/html" });
      }
    });
    await page.goto(origin);

    const res = await page.evaluate(
      async ({ withGlass, deepFrost, uniform, progressive, withoutGlass, expectedBackend }) => {
        const name = "/engine.js";
        const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
        await glue.default({ module_or_path: "/engine_bg.wasm" });
        if (glue.gpuBackend() !== expectedBackend) throw new Error("wrong GPU backend");
        const bg = new Float32Array([1, 1, 1, 1]);
        const width = 513;
        const height = 511;

        const attach = async () => {
          let device = await glue.createGpu(null, 0);
          if (!device.ok && device.code === 12) {
            device.free();
            device = await glue.createGpu(null, 0);
          }
          if (!device.ok) {
            const message = device.message;
            device.free();
            throw new Error(message);
          }
          return device;
        };
        const measure = async (list: number[], mib: number, dpr = 1) => {
          const device = await attach();
          const engine = new glue.Engine(0, 0);
          const check = (out: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = out;
            out.free();
            if (!ok) throw new Error(message);
          };
          try {
            check(engine.setLimit("gpu_bytes", mib << 20));
            check(engine.apply(new Uint8Array(list)));
            if (!engine.attachGpu) throw new Error("no attachGpu");
            check(engine.attachGpu(device));
            const draw = engine.renderGpu?.(width, height, 1, 0, 0, dpr, bg, false, 0);
            if (!draw) throw new Error("no renderGpu");
            const result = { mib, ok: draw.ok, code: draw.code, message: draw.message };
            draw.free();
            return result;
          } finally {
            engine.free();
            device.free();
          }
        };
        const budgets = {
          plain: await measure(withoutGlass, 21),
          // Thick frost at DPR 4 exceeds the tile halo. The whole-frame target
          // fits at 21 MiB, leaving the glass mask itself to exercise admission.
          glassLimited: await measure(deepFrost, 21, 4),
          glassFits: await measure(deepFrost, 128, 4),
          // A first draw holds one frame texture, leaving one MiB more for
          // the Gaussian working set than the old eager two-frame setup.
          uniformLimited: await measure(uniform, 21),
          uniformFits: await measure(uniform, 24),
          progressiveLimited: await measure(progressive, 22),
          progressiveFits: await measure(progressive, 28),
        };

        // 2. Normal budget: moving frame draws analytic coarse glass (reads > 0), settles to exact,
        // then switching to a readerless list evicts scratch and renders cleanly.
        const dev = await attach();
        const e = new glue.Engine(0, 0);
        try {
          e.apply(new Uint8Array(withGlass)).free();
          e.attachGpu?.(dev).free();
          const moving = e.renderGpu?.(width, height, 1, 0, 0, 1, bg, true, 0);
          if (!moving) throw new Error("no renderGpu");
          const movingInfo = { ok: moving.ok, exact: moving.exact, reads: moving.reads };
          moving.free();
          const movingPx = await e.gpuPixels?.();
          if (!(movingPx instanceof Uint8Array)) throw new Error("moving gpuPixels failed");
          const cAt = (180 * width + 200) * 4;
          const accentAt = (180 * width + 4) * 4;
          const movingCentre = [...movingPx.subarray(cAt, cAt + 4)];

          const settled = e.renderGpu?.(width, height, 1, 0, 0, 1, bg, false, 0);
          if (!settled) throw new Error("no renderGpu");
          const settledInfo = { ok: settled.ok, exact: settled.exact, reads: settled.reads };
          settled.free();
          const settledPx = await e.gpuPixels?.();
          if (!(settledPx instanceof Uint8Array)) throw new Error("settled gpuPixels failed");

          const pan = (x: number) => {
            // Both moving cameras remain inside the same tile at 800%.
            const draw = e.renderGpu?.(160, 96, 8, x, -548, 1, bg, true, 80, true);
            if (!draw) throw new Error("no renderGpu");
            const stats = { drawn: draw.tiles_drawn, held: draw.held };
            if (!draw.ok) {
              const message = draw.message;
              draw.free();
              throw new Error(message);
            }
            draw.free();
            return stats;
          };
          pan(-548); // Change zoom and stop on the new tile grid.
          await e.gpuPixels?.();
          const panning = pan(-550);
          await e.gpuPixels?.();
          const reused = pan(-552);
          await e.gpuPixels?.();

          e.apply(new Uint8Array(withoutGlass)).free();
          const plain = e.renderGpu?.(width, height, 1, 0, 0, 1, bg, false, 0);
          if (!plain) throw new Error("no renderGpu");
          const plainInfo = { ok: plain.ok, exact: plain.exact, reads: plain.reads };
          plain.free();
          const plainPx = await e.gpuPixels?.();
          if (!(plainPx instanceof Uint8Array)) throw new Error("plain gpuPixels failed");
          const plainCentre = [...plainPx.subarray(cAt, cAt + 4)];

          return {
            budgets,
            movingInfo,
            movingCentre,
            movingPixelCount: movingPx.length / 4,
            movingAccent: movingPx[accentAt] ?? 0,
            settledAccent: settledPx[accentAt] ?? 0,
            settledInfo,
            panning,
            reused,
            plainInfo,
            plainCentre,
          };
        } finally {
          e.free();
          dev.free();
        }
      },
      {
        withGlass: glassScene(),
        deepFrost: glassScene(0xffffffff, 1, "deep-frost"),
        uniform: glassScene(0xffffffff, 1, "uniform"),
        progressive: glassScene(0xffffffff, 1, "progressive"),
        withoutGlass: glassScene(0xffffffff, 2, "plain"),
        expectedBackend,
      },
    );

    expect(res.budgets.plain.ok).toBe(true);
    expect(res.budgets.glassLimited).toMatchObject({ ok: false, code: 4 });
    expect(res.budgets.glassLimited.message).toContain("reader mask");
    expect(res.budgets.glassFits.ok).toBe(true);
    expect(res.budgets.uniformLimited).toMatchObject({ ok: false, code: 4 });
    expect(res.budgets.uniformFits.ok).toBe(true);
    expect(res.budgets.progressiveLimited).toMatchObject({ ok: false, code: 4 });
    expect(res.budgets.progressiveLimited.message).toContain("reader blur_out");
    expect(res.budgets.progressiveFits.ok).toBe(true);
    expect(res.movingInfo).toMatchObject({ ok: true, exact: false });
    expect(res.movingPixelCount).toBe(513 * 511);
    expect(res.movingAccent).toBe(255);
    expect(res.settledAccent).toBe(255);
    expect(res.movingInfo.reads).toBeGreaterThan(0);
    expect(res.movingCentre[3]).toBe(255);
    expect(res.settledInfo).toEqual({ ok: true, exact: true, reads: expect.any(Number) });
    expect(res.settledInfo.reads).toBeGreaterThan(0);
    expect(res.panning).toEqual({ drawn: 1, held: 1 });
    expect(res.reused).toEqual({ drawn: 0, held: 1 });
    expect(res.plainInfo).toEqual({ ok: true, exact: true, reads: 0 });
    expect(res.plainCentre[2]).toBeGreaterThan(200);
  });
}

for (const build of ["browser", "webgl"] as const) {
  test(`reader fallback samples the same backdrop beyond the view edge (${build})`, async ({
    page,
  }) => {
    const list = new ListWriter(0xffffffff, 1);
    list.reset();
    const paint = (id: number, x: number, width: number, color: [number, number, number, number]) =>
      list.set(id, ROOT, {
        flags: 0,
        transform: [1, 0, 0, 1, x, 0],
        opacity: 1,
        width,
        height: 224,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w: width, h: 224, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops: [{ op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } }],
        coarse: [],
      });
    paint(1, 0, 80, [1, 0.2, 0.1, 1]);
    paint(2, 80, 304, [0, 0.1, 1, 1]);
    list.set(3, ROOT, {
      flags: 0,
      transform: [1, 0, 0, 1, 60, 32],
      opacity: 1,
      width: 156,
      height: 160,
      coarseBelow: 0,
      reach: 128,
      unsupported: 0,
      paths: [{ kind: "rect", w: 156, h: 160, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops: [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius: 48 }],
      coarse: [],
    });
    const frame: Frame = {
      camera: [1, -80, 0, 1],
      size: [224, 224],
      pixel: [4, 110],
      moving: false,
      budget: 200,
      editorViewport: true,
    };
    const bytes = [...list.finish()];
    const [, tiled] = await sample(page, bytes, [frame, frame], undefined, build);
    const [moving, whole, crop] = await sample(
      page,
      bytes,
      [
        { ...frame, budget: 0, moving: true },
        { ...frame, budget: 0 },
        { ...frame, budget: 0, editorViewport: false },
      ],
      undefined,
      build,
    );
    expect(moving?.exact).toBe(false);
    expect(moving?.pixel[0]).toBeGreaterThan(40);
    expect(tiled?.exact).toBe(true);
    expect(whole?.exact).toBe(true);
    expect(tiled?.pixel[0]).toBeGreaterThan(40);
    expect(whole?.pixel).toEqual(tiled?.pixel);
    expect(crop?.exact).toBe(true);
    expect(crop?.pixel[0]).toBeLessThanOrEqual(1);
  });
}

for (const build of ["browser", "webgl"] as const) {
  test(`resident image levels rebuild identically on ${build}`, async ({ page }) => {
    const makeList = (revision: number, base: number, x: number) => {
      const list = new ListWriter(base, revision);
      if (base === 0xffffffff) list.reset();
      list.set(1, ROOT, {
        flags: 0,
        transform: [1, 0, 0, 1, x, 0],
        opacity: 1,
        width: 64,
        height: 64,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w: 64, h: 64, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops: [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: {
              kind: "image",
              image: 1,
              matrix: [64, 0, 0, 64, 0, 0],
              tile: false,
              opacity: 1,
            },
          },
        ],
        coarse: [],
      });
      return [...list.finish()];
    };
    await page.route(`${origin}/**`, async (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (name === "engine.js" || name === "engine_bg.wasm") {
        await route.fulfill({
          body: await readFile(ROOTS[build] + name),
          contentType: name.endsWith(".js") ? "text/javascript" : "application/wasm",
        });
      } else {
        await route.fulfill({ body: "<!doctype html>", contentType: "text/html" });
      }
    });
    await page.goto(origin);
    const result = await page.evaluate(
      async ({ initial, patch, fresh }) => {
        const name = "/engine.js";
        const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
        await glue.default({ module_or_path: "/engine_bg.wasm" });
        const engine = new glue.Engine(0, 0);
        const checked = (outcome: { ok: boolean; message: string; free(): void }) => {
          const { ok, message } = outcome;
          outcome.free();
          if (!ok) throw new Error(message);
        };
        const device = await glue.createGpu(null, 0);
        const canvas = new OffscreenCanvas(64, 64);
        const ctx = canvas.getContext("2d");
        if (
          !ctx ||
          !engine.attachGpu ||
          !engine.putGpuImageLevel ||
          !engine.renderGpu ||
          !engine.gpuPixels
        )
          throw new Error("GPU image upload is unavailable");
        ctx.fillStyle = "rgba(255, 0, 0, 0.5)";
        ctx.fillRect(0, 0, 64, 32);
        ctx.fillStyle = "#0080ff";
        ctx.fillRect(0, 32, 64, 32);
        const rgba = new Uint8Array(ctx.getImageData(0, 0, 64, 64).data.buffer);
        const bitmap = await createImageBitmap(canvas, { premultiplyAlpha: "premultiply" });
        const bg = new Float32Array(4);
        const equal = (a: Uint8Array, b: Uint8Array) =>
          a.length === b.length && a.every((value, i) => value === b[i]);
        let drawnTiles = 0;
        const drawGpu = async () => {
          const outcome = engine.renderGpu?.(96, 64, 1, 0, 0, 1, bg, false, 0);
          if (!outcome) throw new Error("GPU drawing is unavailable");
          drawnTiles = outcome.tiles_drawn;
          checked(outcome);
          const pixels = await engine.gpuPixels?.();
          if (!(pixels instanceof Uint8Array)) throw new Error(pixels?.message ?? "no GPU pixels");
          return pixels;
        };
        try {
          if (!device.ok) throw new Error(device.message);
          checked(engine.attachGpu(device));
          device.free();
          engine.enableViewImages();
          checked(engine.apply(new Uint8Array(initial)));
          checked(engine.putGpuImageLevel(1, bitmap));
          bitmap.close();
          const heldBeforeCpuUpload = engine.imageBytes;
          checked(engine.putCpuImageLevel(1, 64, 64, rgba));
          const before = await drawGpu();
          const finer = await createImageBitmap(canvas, {
            premultiplyAlpha: "premultiply",
            resizeWidth: 128,
            resizeHeight: 128,
          });
          try {
            checked(engine.putGpuImageLevel(1, finer));
          } finally {
            finer.close();
          }
          const withPrefetch = await drawGpu();
          const prefetchRepainted = drawnTiles;
          checked(engine.dropImageLevel(1, 128));
          checked(engine.apply(new Uint8Array(patch)));
          const patched = await drawGpu();
          checked(engine.apply(new Uint8Array(fresh)));
          const rebuilt = await drawGpu();
          checked(engine.renderCpu(96, 64, 1, 0, 0, 1, bg, true));
          const cpu = engine.pixels();
          checked(engine.dropImageLevel(1, 64));
          engine.clearViewCaches();
          await drawGpu();
          const restored = await createImageBitmap(canvas, { premultiplyAlpha: "premultiply" });
          try {
            checked(engine.putGpuImageLevel(1, restored));
          } finally {
            restored.close();
          }
          const afterPressure = await drawGpu();
          return {
            heldBeforeCpuUpload,
            prefetchRepainted,
            prefetchChanged: !equal(before, withPrefetch),
            moved: !equal(before, patched),
            freshMatches: equal(patched, rebuilt) && equal(rebuilt, afterPressure),
            top: [...rebuilt.subarray((16 * 96 + 32) * 4, (16 * 96 + 32) * 4 + 4)],
            bottom: [...rebuilt.subarray((48 * 96 + 32) * 4, (48 * 96 + 32) * 4 + 4)],
            maxDelta: rebuilt.reduce(
              (max, value, i) => Math.max(max, Math.abs(value - (cpu[i] ?? 0))),
              0,
            ),
          };
        } finally {
          bitmap.close();
          engine.free();
        }
      },
      {
        initial: makeList(1, 0xffffffff, 0),
        patch: makeList(2, 1, 16),
        fresh: makeList(3, 0xffffffff, 16),
      },
    );
    expect(result.heldBeforeCpuUpload).toBe(0);
    expect(result.prefetchRepainted).toBe(0);
    expect(result.prefetchChanged).toBe(false);
    expect(result.moved).toBe(true);
    expect(result.freshMatches).toBe(true);
    expect(result.top).toEqual([255, 0, 0, 128]);
    expect(result.bottom).toEqual([0, 128, 255, 255]);
    expect(result.maxDelta).toBeLessThanOrEqual(1);
  });
}
