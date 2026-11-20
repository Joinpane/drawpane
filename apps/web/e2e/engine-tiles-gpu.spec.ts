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
      ...(process.env.ENGINE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
    ],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

const root = fileURLToPath(new URL("../../../packages/engine/dist/browser/", import.meta.url));
/** Answered by `page.route`, never connected to. */
const origin = `http://localhost:${process.env.ENGINE_TILES_ORIGIN_PORT ?? "8893"}`;
const red = [255, 0, 0, 255];

type Frame = {
  camera: [zoom: number, x: number, y: number, dpr: number];
  size: [width: number, height: number];
  pixel: [x: number, y: number];
  moving: boolean;
  budget: number;
  /** Applied before the frame. */
  patch?: number[];
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

/** Draws `frames` in turn on a GPU engine given `list`; answers each one's stats and pixel. */
async function sample(page: Page, list: number[], frames: Frame[], tileBytes?: number) {
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
  return page.evaluate(
    async ({ list, frames, tileBytes }) => {
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
          const [width, height] = frame.size;
          const outcome = engine.renderGpu(
            width,
            height,
            ...frame.camera,
            new Float32Array(4),
            frame.moving,
            frame.budget,
          );
          const stats = {
            exact: outcome.exact,
            drawn: outcome.tiles_drawn,
            pending: outcome.pending,
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
    { list, frames, tileBytes },
  );
}

test("a zoom with one GPU page of tile slots still covers the view", async ({ page }) => {
  // 16 slots, 16 tiles in view: the coarse tiles the zoom draws must fit, or the view's own
  // tiles are drawn straight into the frame; the far corner is never left blank.
  const [, frame] = await sample(
    page,
    solid(3500),
    [
      { size: [1536, 1536], pixel: [32, 32], camera: [1, 4000, 4000, 1], moving: false, budget: 0 },
      {
        size: [1536, 1536],
        pixel: [1200, 1200],
        camera: [2, -0.25, -0.25, 1],
        moving: true,
        budget: 4,
      },
    ],
    16 << 20,
  );
  expect(frame?.pixel).toEqual(red);
});

test("a spent time budget still draws what nothing stands in for", async ({ page }) => {
  // A pan with an edit: the tile nearest the centre is only stale (it stands in for itself), the
  // one entering on the right has nothing. Past the budget, the first waits; the second never.
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
  );
  expect(frame?.pixel).toEqual([0, 255, 0, 255]);
});

test("a drag of a selection over more than 4,096 tiles keeps the view drawn", async ({ page }) => {
  // A 34,000 px square moved, with no frame before at this place: the tiles under it are left to
  // the drag's composite, which must cover every one on screen.
  const patch = new ListWriter(1, 2);
  patch.transform(1, [1, 0, 0, 1, 1, 0]);
  const [, frame] = await sample(page, solid(34_000), [
    { size: [64, 64], pixel: [32, 32], camera: [1, 6000, 0, 1], moving: false, budget: 0 },
    {
      size: [64, 64],
      pixel: [32, 32],
      camera: [1, 0, 0, 1],
      moving: false,
      budget: 0.000001,
      patch: [...patch.finish()],
    },
  ]);
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
  );
  expect(movedIn?.pixel).toEqual(red);
  expect(movedOut?.pixel).toEqual([0, 0, 0, 0]);
});

test("a page opened at a fractional device pixel ratio shows the coarse frame it draws", async ({
  page,
}) => {
  // The opening frame draws a coarser level first: at 1.25 it must still be one the composite
  // lays (at most 4× coarser), never a frame of background only.
  const [frame] = await sample(page, solid(512), [
    { size: [64, 64], pixel: [32, 32], camera: [1, 0, 0, 1.25], moving: false, budget: 12 },
  ]);
  expect(frame?.exact).toBe(false);
  expect(frame?.drawn).toBeGreaterThan(0);
  expect(frame?.pixel).toEqual(red);
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
    writer.glyph(1, new PathData().moveTo(0, 0).lineTo(16, 0).lineTo(16, 16).lineTo(0, 16).close());
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
        if (!e.attachGpu || !e.renderGpu || !e.gpuPixels) throw new Error("no GPU entry points");
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
          check(e.pngBegin(96, 64, 1, 0, 0, 1));
          check(e.pngBand(1, 0, 0, 1, bg, 64));
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
