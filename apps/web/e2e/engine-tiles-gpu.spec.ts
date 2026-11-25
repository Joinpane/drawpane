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
import { GPU_FLUSH_CAUSES, GPU_RENDER_KINDS } from "@drawpane/engine";
import {
  BLEND,
  CAP,
  FLAG,
  JOIN,
  ListWriter,
  PathData,
  ROOT,
  type WireRecord,
} from "@drawpane/engine/wire";
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
  repeatUntilExact?: number;
  freshReference?: boolean;
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

/** A patch on `base`: 30 green 1,600 x 512 rectangles over the page, 150 path verbs in all. */
function denseGreen(base: number): number[] {
  const list = new ListWriter(base, base + 1);
  for (let id = 1; id <= 30; id++) {
    list.set(id, ROOT, {
      flags: 0,
      transform: [1, 0, 0, 1, 0, 0],
      opacity: 1,
      width: 1600,
      height: 512,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w: 1600, h: 512, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops: [{ op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [0, 1, 0, 1] } }],
      coarse: [],
    });
  }
  return [...list.finish()];
}

/** Two 128 x 32 rects at x 16 and 640, y 16, in `color`: a fresh list, or a patch on `base`. */
function spacedFills(
  color: readonly [number, number, number, number],
  base = 0xffffffff,
): number[] {
  const list = new ListWriter(base, base === 0xffffffff ? 1 : base + 1);
  if (base === 0xffffffff) list.reset();
  for (const [i, x] of [16, 640].entries()) {
    list.set(i + 1, ROOT, {
      flags: 0,
      transform: [1, 0, 0, 1, x, 16],
      opacity: 1,
      width: 128,
      height: 32,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w: 128, h: 32, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops: [{ op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } }],
      coarse: [],
    });
  }
  return [...list.finish()];
}

/**
 * A 1,600 x 512 layer over the page: a red fill (`red`), a green one as a patch (`green`), red
 * again as the patch after that (`undo`), an image fill (`image`), provisional text with red bars
 * (`provisional`), or green glyphs replacing it (`glyph`).
 */
function wideLayer(
  kind: "red" | "green" | "undo" | "image" | "provisional" | "glyph",
  base = 0xffffffff,
): number[] {
  const list = new ListWriter(base, base === 0xffffffff ? 1 : base + 1);
  if (base === 0xffffffff) list.reset();
  if (kind === "glyph")
    list.glyph(
      1,
      new PathData().moveTo(0, 0).lineTo(1600, 0).lineTo(1600, 512).lineTo(0, 512).close(),
    );
  const color: [number, number, number, number] =
    kind === "green" || kind === "glyph" ? [0, 1, 0, 1] : [1, 0, 0, 1];
  const fill: WireRecord["ops"][number] =
    kind === "image"
      ? {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: {
            kind: "image",
            image: 1,
            matrix: [1600, 0, 0, 512, 0, 0],
            tile: false,
            opacity: 1,
          },
        }
      : { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } };
  list.set(1, ROOT, {
    flags: kind === "provisional" ? FLAG.provisional : 0,
    transform: [1, 0, 0, 1, 0, 0],
    opacity: 1,
    width: 1600,
    height: 512,
    coarseBelow: 0,
    reach: 0,
    unsupported: 0,
    paths:
      kind === "glyph"
        ? [{ kind: "glyphs", scale: 1, glyphs: [1, 0, 512] }]
        : [{ kind: "rect", w: 1600, h: 512, radii: [0, 0, 0, 0], smoothing: 0 }],
    ops: kind === "provisional" ? [] : [fill],
    coarse: kind === "provisional" ? [fill] : [],
  });
  return [...list.finish()];
}

/** A step of `presented`: an edit, an image level, or a frame drawn and read back. */
type Step =
  | { apply: number[] }
  | { image: { id: number; side: number; color: string } }
  /**
   * Rows `from` to `to` of a level in strips of `strip` (`putGpuImageRows`), in bands of
   * `colors`, from one bitmap per upload (steps with the same `id`, `side` and `colors` share
   * it, as the editor's strips do). `refused`: the first strip must be refused.
   */
  | {
      rows: {
        id: number;
        side: number;
        colors: string[];
        from: number;
        to: number;
        strip: number;
        refused?: boolean;
      };
    }
  /** Lets go of a level part uploaded in strips (`cancelGpuImageRows`). */
  | { cancel: { id: number; width: number } }
  /** `times` slices of the time between frames (`renderGpuAhead`), `budget` ms each. */
  | { ahead: { times: number; budget: number } }
  /** Waits `ms` (the camera still): the overview's refined tiles wait for a still camera. */
  | { wait: number }
  | {
      name: string;
      size: [number, number];
      scale: number;
      x?: number;
      moving: boolean;
      budget: number;
      /** Device pixels read once the frame is drawn. */
      samples: [number, number][];
    };

/**
 * Runs `steps` on one GPU engine given `list` and reads every frame back: what each presented,
 * in order, to check that what's shown never goes back to something older.
 */
async function presented(
  page: Page,
  build: GpuBuild,
  list: number[],
  steps: Step[],
  options: { tileBytes?: number; viewImages?: boolean } = {},
) {
  await openEngine(page, build);
  return page.evaluate(
    async ({ list, steps, options }) => {
      const name = "/engine.js";
      const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
      await glue.default({ module_or_path: "/engine_bg.wasm" });
      const engine = new glue.Engine(0, 0);
      /** Bitmaps of strip uploads (`rows` steps), one per upload. */
      const uploads = new Map<string, ImageBitmap>();
      const requireOk = (out: { ok: boolean; message: string; free(): void }) => {
        const { ok, message } = out;
        out.free();
        if (!ok) throw new Error(message);
      };
      try {
        if (options.tileBytes !== undefined)
          requireOk(engine.setLimit("tile_bytes", options.tileBytes));
        const gpu = await glue.createGpu(null, 0);
        const attached = engine.attachGpu?.(gpu);
        gpu.free();
        if (!attached) throw new Error("no GPU entry points");
        requireOk(attached);
        if (options.viewImages) engine.enableViewImages();
        requireOk(engine.apply(new Uint8Array(list)));
        const bg = new Float32Array([0, 0, 0, 1]);
        const rows = [];
        for (const step of steps) {
          if ("apply" in step) {
            requireOk(engine.apply(new Uint8Array(step.apply)));
            continue;
          }
          if ("image" in step) {
            const canvas = new OffscreenCanvas(step.image.side, step.image.side);
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("no 2D context");
            ctx.fillStyle = step.image.color;
            ctx.fillRect(0, 0, step.image.side, step.image.side);
            const bitmap = await createImageBitmap(canvas);
            try {
              const put = engine.putGpuImageLevel?.(step.image.id, bitmap);
              if (!put) throw new Error("no putGpuImageLevel");
              requireOk(put);
            } finally {
              bitmap.close();
            }
            continue;
          }
          if ("rows" in step) {
            const { id, side, colors, from, to, strip, refused } = step.rows;
            const key = `${id}/${side}/${colors.join()}`;
            let bitmap = uploads.get(key);
            if (!bitmap) {
              const canvas = new OffscreenCanvas(side, side);
              const ctx = canvas.getContext("2d");
              if (!ctx) throw new Error("no 2D context");
              const band = side / colors.length;
              colors.forEach((c, k) => {
                ctx.fillStyle = c;
                ctx.fillRect(0, k * band, side, band);
              });
              bitmap = await createImageBitmap(canvas);
              uploads.set(key, bitmap);
            }
            for (let y = from; y < to; y += strip) {
              const put = engine.putGpuImageRows?.(id, bitmap, y, Math.min(strip, to - y));
              if (!put) throw new Error("no putGpuImageRows");
              if (refused) {
                const { ok } = put;
                put.free();
                if (ok) throw new Error(`rows ${y} of ${key} were taken`);
                break;
              }
              requireOk(put);
            }
            continue;
          }
          if ("ahead" in step) {
            for (let k = 0; k < step.ahead.times; k++) {
              const a = engine.renderGpuAhead?.(bg, step.ahead.budget);
              if (!a) throw new Error("no renderGpuAhead");
              a.free();
            }
            continue;
          }
          if ("wait" in step) {
            await new Promise((done) => setTimeout(done, step.wait));
            continue;
          }
          if ("cancel" in step) {
            const out = engine.cancelGpuImageRows?.(step.cancel.id, step.cancel.width);
            if (!out) throw new Error("no cancelGpuImageRows");
            requireOk(out);
            continue;
          }
          const out = engine.renderGpu?.(
            step.size[0],
            step.size[1],
            step.scale,
            step.x ?? 0,
            0,
            1,
            bg,
            step.moving,
            step.budget,
          );
          if (!out) throw new Error("no renderGpu");
          const row = {
            ok: out.ok,
            message: out.message,
            exact: out.exact,
            pending: out.pending,
            drawn: out.tiles_drawn,
          };
          out.free();
          if (!row.ok) throw new Error(row.message);
          const pixels = await engine.gpuPixels?.();
          if (!(pixels instanceof Uint8Array))
            throw new Error(
              `no read-back after ${step.name}: ${pixels?.message ?? "no entry point"}`,
            );
          const samples = step.samples.map(([x, y]) => {
            const at = (y * step.size[0] + x) * 4;
            return [...pixels.subarray(at, at + 4)];
          });
          rows.push({
            name: step.name,
            exact: row.exact,
            pending: row.pending,
            drawn: row.drawn,
            samples,
          });
        }
        return rows;
      } finally {
        for (const bitmap of uploads.values()) bitmap.close();
        engine.free();
      }
    },
    { list, steps, options },
  );
}

/**
 * Display never goes back: at each sample, once `colour` (an image's, say) was shown, nothing
 * else is shown there again, whatever shade a placeholder would come back in.
 */
function stays(rows: { name: string; samples: number[][] }[], colour: number[]) {
  const count = Math.max(...rows.map((r) => r.samples.length));
  for (let k = 0; k < count; k++) {
    let seen = false;
    for (const row of rows) {
      const sample = row.samples[k];
      if (!sample) continue;
      if (seen) expect(sample, `${row.name} sample ${k} went back`).toEqual(colour);
      if (sample.join() === colour.join()) seen = true;
    }
  }
}

/**
 * Display never goes back: at each sample (one region of the page across `rows`), once `fresh`
 * was shown, `old` never is again.
 */
function neverBack(rows: { name: string; samples: number[][] }[], old: number[], fresh: number[]) {
  const count = Math.max(...rows.map((r) => r.samples.length));
  for (let k = 0; k < count; k++) {
    let seen = false;
    for (const row of rows) {
      const sample = row.samples[k];
      if (!sample) continue;
      if (seen)
        expect(sample, `${row.name} sample ${k} went back to what was shown before`).not.toEqual(
          old,
        );
      if (sample.join() === fresh.join()) seen = true;
    }
  }
}

/**
 * A `color` board of 1,024 x 256 under a dark square every 8 px (4,096 of them, so a tile takes
 * longer than a 1 ms slice): a fresh list, or (with `base`) a patch recolouring the board only.
 * "placeholder" fills the board with image 1's placeholder, and "loaded" with image 1 clipped to
 * the board, as the editor does once the image is there.
 */
function slowBoard(
  color: readonly [number, number, number, number] | "image" | "placeholder" | "loaded",
  base = 0xffffffff,
): number[] {
  const list = new ListWriter(base, base === 0xffffffff ? 1 : base + 1);
  if (base === 0xffffffff) list.reset();
  const rect = (
    id: number,
    x: number,
    y: number,
    w: number,
    h: number,
    c: readonly number[] | "image" | "placeholder" | "loaded",
  ) => {
    const image = {
      kind: "image",
      image: 1,
      matrix: [w, 0, 0, h, 0, 0],
      tile: false,
      opacity: 1,
    } as const;
    const fill = {
      op: "fill",
      path: 0,
      evenOdd: false,
      paint:
        c === "image" || c === "loaded"
          ? image
          : c === "placeholder"
            ? ({ kind: "placeholder", opacity: 1 } as const)
            : ({ kind: "solid", color: c as [number, number, number, number] } as const),
    } as const;
    list.set(id, ROOT, {
      flags: 0,
      transform: [1, 0, 0, 1, x, y],
      opacity: 1,
      width: w,
      height: h,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w, h, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops:
        c === "loaded" ? [{ op: "clip", path: 0, evenOdd: false }, fill, { op: "unclip" }] : [fill],
      coarse: [],
    });
  };
  rect(1, 0, 0, 1024, 256, color);
  if (base === 0xffffffff) {
    let id = 2;
    for (let y = 0; y < 256; y += 8) {
      for (let x = 0; x < 1024; x += 8) rect(id++, x + 1, y + 1, 5, 5, [0.2, 0.2, 0.2, 1]);
    }
  }
  return [...list.finish()];
}

/**
 * A 1,024 x 256 board filled with image 1's placeholder, or with the image once loaded, and (in
 * a fresh list) a speck far to the right, so the page is wide and its overview coarse.
 */
function farBoard(kind: "placeholder" | "loaded", base = 0xffffffff): number[] {
  const list = new ListWriter(base, base === 0xffffffff ? 1 : base + 1);
  if (base === 0xffffffff) list.reset();
  const fill = {
    op: "fill",
    path: 0,
    evenOdd: false,
    paint:
      kind === "loaded"
        ? ({
            kind: "image",
            image: 1,
            matrix: [1024, 0, 0, 256, 0, 0],
            tile: false,
            opacity: 1,
          } as const)
        : ({ kind: "placeholder", opacity: 1 } as const),
  } as const;
  list.set(1, ROOT, {
    flags: 0,
    transform: [1, 0, 0, 1, 0, 0],
    opacity: 1,
    width: 1024,
    height: 256,
    coarseBelow: 0,
    reach: 0,
    unsupported: 0,
    paths: [{ kind: "rect", w: 1024, h: 256, radii: [0, 0, 0, 0], smoothing: 0 }],
    ops:
      kind === "loaded"
        ? [{ op: "clip", path: 0, evenOdd: false }, fill, { op: "unclip" }]
        : [fill],
    coarse: [],
  });
  if (base === 0xffffffff)
    list.set(2, ROOT, {
      flags: 0,
      transform: [1, 0, 0, 1, 16000, 0],
      opacity: 1,
      width: 8,
      height: 8,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w: 8, h: 8, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops: [{ op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [0, 0, 1, 1] } }],
      coarse: [],
    });
  return [...list.finish()];
}

/** Image 1 stretched over a 1,024 x 256 board. */
function imageBoard(): number[] {
  const list = new ListWriter(0xffffffff, 1);
  list.reset();
  list.set(1, ROOT, {
    flags: 0,
    transform: [1, 0, 0, 1, 0, 0],
    opacity: 1,
    width: 1024,
    height: 256,
    coarseBelow: 0,
    reach: 0,
    unsupported: 0,
    paths: [{ kind: "rect", w: 1024, h: 256, radii: [0, 0, 0, 0], smoothing: 0 }],
    ops: [
      {
        op: "fill",
        path: 0,
        evenOdd: false,
        paint: {
          kind: "image",
          image: 1,
          matrix: [1024, 0, 0, 256, 0, 0],
          tile: false,
          opacity: 1,
        },
      },
    ],
    coarse: [],
  });
  return [...list.finish()];
}

type HeldFrame = {
  name: string;
  size: [number, number];
  scale: number;
  moving: boolean;
  budget: number;
  /** Device pixels sampled once the frame is drawn. */
  samples: [number, number][];
};

/**
 * Draws `frames` in turn with GPU completions held back (nothing is drawn while moving), the
 * list edited by `patch` before the second. Each frame's pixels are read in an engine of its own
 * that drew the frames before it the same way (a read-back waits for the GPU).
 */
async function heldFrames(
  page: Page,
  build: GpuBuild,
  before: number[],
  patch: number[],
  frames: HeldFrame[],
) {
  await openEngine(page, build);
  return page.evaluate(
    async ({ build, before, patch, frames }) => {
      const name = "/engine.js";
      const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
      await glue.default({ module_or_path: "/engine_bg.wasm" });
      let hold = false;
      if (build === "browser") {
        const proto = (window as unknown as { GPUQueue: { prototype: GPUQueue } }).GPUQueue
          .prototype;
        const done = proto.onSubmittedWorkDone;
        proto.onSubmittedWorkDone = function (this: GPUQueue) {
          return hold ? new Promise<undefined>(() => {}) : done.call(this);
        };
      } else {
        const proto = WebGL2RenderingContext.prototype;
        const status = proto.getSyncParameter;
        const wait = proto.clientWaitSync;
        proto.getSyncParameter = function (
          this: WebGL2RenderingContext,
          sync: WebGLSync,
          pname: GLenum,
        ) {
          return hold && pname === this.SYNC_STATUS
            ? this.UNSIGNALED
            : status.call(this, sync, pname);
        };
        proto.clientWaitSync = function (
          this: WebGL2RenderingContext,
          sync: WebGLSync,
          flags: GLbitfield,
          timeout: GLuint64,
        ) {
          return hold ? this.TIMEOUT_EXPIRED : wait.call(this, sync, flags, timeout);
        };
      }
      const bg = new Float32Array([0, 0, 0, 1]);
      const rows = [];
      for (let through = 0; through < frames.length; through++) {
        const engine = new glue.Engine(0, 0);
        const requireOk = (out: { ok: boolean; message: string; free(): void }) => {
          const { ok, message } = out;
          out.free();
          if (!ok) throw new Error(message);
        };
        try {
          const gpu = await glue.createGpu(null, 0);
          const attached = engine.attachGpu?.(gpu);
          gpu.free();
          if (!attached) throw new Error("no GPU entry points");
          requireOk(attached);
          requireOk(engine.apply(new Uint8Array(before)));
          hold = true;
          let last = { exact: false, pending: 0, drawn: 0 };
          for (const [i, f] of frames.slice(0, through + 1).entries()) {
            if (i === 1) requireOk(engine.apply(new Uint8Array(patch)));
            const out = engine.renderGpu?.(
              f.size[0],
              f.size[1],
              f.scale,
              0,
              0,
              1,
              bg,
              f.moving,
              f.budget,
            );
            if (!out) throw new Error("no renderGpu");
            const row = {
              ok: out.ok,
              message: out.message,
              exact: out.exact,
              pending: out.pending,
              drawn: out.tiles_drawn,
            };
            out.free();
            if (!row.ok) throw new Error(row.message);
            last = { exact: row.exact, pending: row.pending, drawn: row.drawn };
          }
          hold = false;
          const f = frames[through];
          if (!f) throw new Error("no frame");
          const pixels = await engine.gpuPixels?.();
          if (!(pixels instanceof Uint8Array)) throw new Error("no read-back");
          const samples = f.samples.map(([x, y]) => {
            const at = (y * f.size[0] + x) * 4;
            return [...pixels.subarray(at, at + 4)];
          });
          rows.push({ name: f.name, ...last, samples });
        } finally {
          hold = false;
          engine.free();
        }
      }
      return rows;
    },
    { build, before, patch, frames },
  );
}

function directStripes(count = 12): number[] {
  const list = new ListWriter(0xffffffff, 1);
  list.reset();
  for (let i = 0; i < count; i++) {
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

/**
 * A grid of small squares every 8 px over `width` x `height`: tiles that take a while each. A
 * fresh list at `revision`.
 */
function denseSquares(width: number, height: number, revision = 1): number[] {
  const list = new ListWriter(0xffffffff, revision);
  list.reset();
  let id = 1;
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      list.set(id++, ROOT, {
        flags: 0,
        transform: [1, 0, 0, 1, x + 1, y + 1],
        opacity: 1,
        width: 5,
        height: 5,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w: 5, h: 5, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops: [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [((x / 8) % 5) / 4, ((y / 8) % 3) / 2, 0.5, 1] },
          },
        ],
        coarse: [],
      });
    }
  }
  return [...list.finish()];
}

/** A `width` x `height` fill over the page at revision `base`, record `id`: a patch. */
function cover(
  base: number,
  id: number,
  color: [number, number, number, number],
  width = 2048,
  height = 1024,
  at: [number, number] = [0, 0],
): number[] {
  const list = new ListWriter(base, base + 1);
  list.set(id, ROOT, {
    flags: 0,
    transform: [1, 0, 0, 1, at[0], at[1]],
    opacity: 1,
    width,
    height,
    coarseBelow: 0,
    reach: 0,
    unsupported: 0,
    paths: [{ kind: "rect", w: width, h: height, radii: [0, 0, 0, 0], smoothing: 0 }],
    ops: [{ op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } }],
    coarse: [],
  });
  return [...list.finish()];
}

function checkpointScene(neighbour: "green" | "empty" | "none" | "clipped"): number[] {
  const list = new ListWriter(0xffffffff, 1);
  list.reset();
  // "clipped": the overlapping stars under a rounded clip at a fractional place, so a slice
  // pauses with the clip open and resumes under it.
  const clipped = neighbour === "clipped";
  const parent = clipped ? 1000 : ROOT;
  if (clipped)
    list.set(parent, ROOT, {
      flags: 0,
      transform: [1, 0, 0, 1, 3.5, 2.25],
      opacity: 1,
      width: 230,
      height: 58,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w: 230, h: 58, radii: [17, 17, 17, 17], smoothing: 0 }],
      ops: [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
      coarse: [],
    });
  const add = (id: number, path: PathData, color: [number, number, number, number]) =>
    list.set(id, parent, {
      flags: 0,
      transform: [1, 0, 0, 1, 0, 0],
      opacity: 1,
      width: 1024,
      height: 1024,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "path", path }],
      ops: [{ op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } }],
      coarse: [],
    });
  const overlap = neighbour === "none" || clipped;
  const count = overlap ? 48 : 120;
  for (let i = 0; i < count; i++) {
    const cx = overlap ? 40 + (i % 20) * 9 : 8 + (i % 30) * 16;
    const cy = overlap ? 30 + ((i * 7) % 11) * 2 : 10 + Math.floor(i / 30) * 14;
    const radius = overlap ? 30 : 6;
    const vertices = overlap ? 3000 : i < 16 ? 4000 : 64;
    const path = new PathData();
    for (let vertex = 0; vertex < vertices; vertex++) {
      const angle = (vertex / vertices) * Math.PI * 2;
      const r = vertex % 2 ? radius * 0.82 : radius;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (vertex === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    add(
      i + 1,
      path.close(),
      overlap
        ? [(i % 3) / 2, ((i + 1) % 4) / 3, ((i + 2) % 5) / 4, 0.23 + (i % 7) * 0.05]
        : [1, 0, 0, 1],
    );
  }
  if (neighbour === "green") {
    const path = new PathData()
      .moveTo(520, 0)
      .lineTo(1000, 0)
      .lineTo(1000, 64)
      .lineTo(520, 64)
      .close();
    add(count + 1, path, [0, 0.8, 0, 1]);
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
      const requireOk = (out: { ok: boolean; message: string; free(): void }) => {
        const { ok, message } = out;
        out.free();
        if (!ok) throw new Error(message);
      };
      const makeEngine = async () => {
        const engine = new glue.Engine(0, 0);
        try {
          if (tileBytes !== undefined) requireOk(engine.setLimit("tile_bytes", tileBytes));
          const device = await glue.createGpu(null, 0);
          try {
            if (!device.ok) throw new Error(device.message);
            if (device.backend !== expectedBackend)
              throw new Error(`expected backend ${expectedBackend}, got ${device.backend}`);
            if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels)
              throw new Error("the browser glue has no GPU entry points");
            requireOk(engine.attachGpu(device));
          } finally {
            device.free();
          }
          requireOk(engine.apply(new Uint8Array(list)));
          return engine;
        } catch (error) {
          engine.free();
          throw error;
        }
      };
      let engine = await makeEngine();
      let previousPixels: Uint8Array | undefined;
      try {
        const sampled = [];
        for (const frame of frames) {
          if (frame.freshReference) {
            const fresh = await makeEngine();
            engine.free();
            engine = fresh;
          }
          if (frame.patch) requireOk(engine.apply(new Uint8Array(frame.patch)));
          let aheadDrawn = 0;
          if (frame.aheadBudget !== undefined && engine.renderGpuAhead) {
            const ahead = engine.renderGpuAhead(new Float32Array(4), frame.aheadBudget);
            aheadDrawn = ahead.tiles_drawn;
            requireOk(ahead);
          }
          const [width, height] = frame.size;
          let sawPause = false;
          let attempts = 0;
          let maxMs = 0;
          let stats: { exact: boolean; drawn: number; pending: number };
          do {
            const started = performance.now();
            const outcome = engine.renderGpu?.(
              width,
              height,
              ...frame.camera,
              new Float32Array(4),
              frame.moving,
              frame.budget,
              frame.editorViewport,
            );
            maxMs = Math.max(maxMs, performance.now() - started);
            if (!outcome) throw new Error("no GPU renderer");
            stats = { exact: outcome.exact, drawn: outcome.tiles_drawn, pending: outcome.pending };
            sawPause ||= outcome.in_progress;
            attempts++;
            requireOk(outcome);
            if (frame.repeatUntilExact && engine.gpuFinished) {
              const finished = await engine.gpuFinished();
              if (finished && typeof finished === "object" && "ok" in finished)
                requireOk(finished as never);
            }
          } while (!stats.exact && attempts < (frame.repeatUntilExact ?? 1));
          const pixels = await engine.gpuPixels?.();
          if (!(pixels instanceof Uint8Array))
            throw new Error(pixels?.message ?? "no GPU readback");
          const reference = frame.freshReference ? previousPixels : undefined;
          const differingBytes = reference
            ? pixels.reduce(
                (count, byte, at) => count + Number(byte !== reference[at]),
                Math.abs(pixels.length - reference.length),
              )
            : null;
          previousPixels = pixels;
          const at = (frame.pixel[1] * width + frame.pixel[0]) * 4;
          sampled.push({
            ...stats,
            aheadDrawn,
            sawPause,
            attempts,
            maxMs: Math.round(maxMs * 10) / 10,
            differingBytes,
            bytes: pixels.length,
            pixel: [...pixels.subarray(at, at + 4)],
          });
        }
        return sampled;
      } finally {
        // After a trap the engine is still borrowed and can't be freed: keep the trap's error.
        try {
          engine.free();
        } catch {}
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

    test("an edit on a view without tile slots never goes back while moving", async ({ page }) => {
      // No slot holds a tile, so every frame is drawn straight into a frame texture. The fill
      // turns from red to green, then the camera moves: a moving frame shows what's on screen
      // (red) or the new fill, never the background where the screen showed content, and once
      // green is shown somewhere, never red there again; at rest it's exact green.
      const green = [0, 255, 0, 255];
      const at = (name: string, x: number, moving: boolean): Step => ({
        name,
        size: [1024, 512],
        scale: 1,
        x,
        moving,
        budget: moving ? 4 : 0,
        // Two places on the page, at 128 and 800 page units.
        samples: [
          [128 + x, 128],
          [800 + x, 128],
        ],
      });
      const rows = await presented(
        page,
        build,
        solid(6000),
        [
          at("initial", 0, false),
          { apply: solid(6000, [0, 1, 0, 1], 1) },
          at("moving 1", -16, true),
          at("moving 2", -32, true),
          at("moving 3", -48, true),
          at("rest", -48, false),
        ],
        { tileBytes: 0 },
      );
      expect(rows[0]).toMatchObject({ exact: true, samples: [red, red] });
      for (const moving of rows.slice(1, 4)) {
        expect(moving.exact).toBe(false);
        for (const sample of moving.samples)
          expect([red.join(), green.join()]).toContain(sample.join());
      }
      // Moving frames still draw (rough, the nearest the middle first): green shows before rest.
      expect(rows.slice(1, 4).some((f) => f.samples.some((p) => p.join() === green.join()))).toBe(
        true,
      );
      neverBack(rows, red, green);
      expect(rows[4]).toMatchObject({ exact: true, pending: 0, samples: [green, green] });
    });

    test("a second limited moving frame after an edit leaves the older frame out", async ({
      page,
    }) => {
      // No tile slots and a 6-verb limit: after the edit (150 verbs) every moving frame hits the
      // limit and shows a frame warped. The first warps the frame on screen. The next ones keep
      // warping that same frame, which by then is older than the screen (a stand-in was shown
      // since), so where it changed since, they leave it out (re-checks of #345).
      await openEngine(page, build);
      const rows = await page.evaluate(
        async ({ before, patch }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const engine = new glue.Engine(0, 0);
          const read = (out: {
            ok: boolean;
            message: string;
            exact: boolean;
            standin: boolean;
            tiles_drawn: number;
            free(): void;
          }) => {
            const row = {
              ok: out.ok,
              message: out.message,
              exact: out.exact,
              standin: out.standin,
            };
            const drawn = out.tiles_drawn;
            out.free();
            if (!row.ok) throw new Error(row.message);
            return { exact: row.exact, standin: row.standin, drawn };
          };
          const requireOk = (out: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = out;
            out.free();
            if (!ok) throw new Error(message);
          };
          try {
            requireOk(engine.setLimit("tile_bytes", 0));
            requireOk(engine.setLimit("frame_verbs", 6));
            const gpu = await glue.createGpu(null, 0);
            const attached = engine.attachGpu?.(gpu);
            gpu.free();
            if (!attached) throw new Error("no GPU entry points");
            requireOk(attached);
            const draw = async (scale: number, moving: boolean) => {
              const out = engine.renderGpu?.(
                1024,
                256,
                scale,
                0,
                0,
                1,
                new Float32Array([0, 0, 0, 1]),
                moving,
                moving ? 4 : 0,
              );
              if (!out) throw new Error("no renderGpu");
              const row = read(out as never);
              const pixels = await engine.gpuPixels?.();
              if (!(pixels instanceof Uint8Array)) throw new Error("no read-back");
              const at = (96 * 1024 + 250) * 4;
              return { ...row, pixel: [...pixels.subarray(at, at + 4)] };
            };
            requireOk(engine.apply(new Uint8Array(before)));
            const initial = await draw(1, false);
            requireOk(engine.apply(new Uint8Array(patch)));
            const first = await draw(0.99, true);
            const second = await draw(0.98, true);
            const third = await draw(0.97, true);
            return { initial, first, second, third };
          } finally {
            engine.free();
          }
        },
        { before: solid(6000), patch: denseGreen(1) },
      );
      expect(rows.initial).toMatchObject({ exact: true, pixel: red });
      // The first warps the frame on screen: what the screen shows (red) may show again.
      expect(rows.first).toMatchObject({ exact: false, standin: true, drawn: 0, pixel: red });
      // The next ones warp that same older frame, not what's on screen (the first stand-in):
      // where it changed since, it's left out.
      for (const moving of [rows.second, rows.third]) {
        expect(moving).toMatchObject({ exact: false, standin: true, drawn: 0 });
        expect(
          moving.pixel,
          "a limited moving frame showed the fill from before the edit",
        ).not.toEqual(red);
      }
    });

    test("a pinch restarted after an inexact frame at rest never goes back", async ({ page }) => {
      // GPU completions held back, so nothing is drawn while moving. After the edit: a pinch
      // frame, a composite-only frame at rest, then the pinch again. Green is never shown before
      // the exact frame, so each shows what's on screen (red): never the stale red tile, never
      // the background (re-checks of #345).
      await openEngine(page, build);
      const rows = await page.evaluate(
        async ({ before, patch, build }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          let hold = false;
          if (build === "browser") {
            const proto = (window as unknown as { GPUQueue: { prototype: GPUQueue } }).GPUQueue
              .prototype;
            const done = proto.onSubmittedWorkDone;
            proto.onSubmittedWorkDone = function (this: GPUQueue) {
              return hold ? new Promise<undefined>(() => {}) : done.call(this);
            };
          } else {
            const proto = WebGL2RenderingContext.prototype;
            const status = proto.getSyncParameter;
            const wait = proto.clientWaitSync;
            proto.getSyncParameter = function (
              this: WebGL2RenderingContext,
              sync: WebGLSync,
              pname: GLenum,
            ) {
              return hold && pname === this.SYNC_STATUS
                ? this.UNSIGNALED
                : status.call(this, sync, pname);
            };
            proto.clientWaitSync = function (
              this: WebGL2RenderingContext,
              sync: WebGLSync,
              flags: GLbitfield,
              timeout: GLuint64,
            ) {
              return hold ? this.TIMEOUT_EXPIRED : wait.call(this, sync, flags, timeout);
            };
          }
          const engine = new glue.Engine(0, 0);
          const requireOk = (out: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = out;
            out.free();
            if (!ok) throw new Error(message);
          };
          try {
            const gpu = await glue.createGpu(null, 0);
            const attached = engine.attachGpu?.(gpu);
            gpu.free();
            if (!attached) throw new Error("no GPU entry points");
            requireOk(attached);
            const bg = new Float32Array([0, 0, 0, 1]);
            const draw = (scale: number, moving: boolean, budget: number) => {
              const out = engine.renderGpu?.(256, 256, scale, 0, 0, 1, bg, moving, budget);
              if (!out) throw new Error("no renderGpu");
              const row = {
                ok: out.ok,
                message: out.message,
                exact: out.exact,
                pending: out.pending,
                drawn: out.tiles_drawn,
              };
              out.free();
              if (!row.ok) throw new Error(row.message);
              return { exact: row.exact, pending: row.pending, drawn: row.drawn };
            };
            const pixel = async () => {
              const rgba = await engine.gpuPixels?.();
              if (!(rgba instanceof Uint8Array)) throw new Error("no read-back");
              const at = (100 * 256 + 100) * 4;
              return [...rgba.subarray(at, at + 4)];
            };
            requireOk(engine.apply(new Uint8Array(before)));
            hold = true;
            const initial = draw(1, false, 0);
            requireOk(engine.apply(new Uint8Array(patch)));
            const pinch = draw(0.99, true, 4);
            const settle = draw(1, false, -1);
            const restart = draw(0.98, true, 4);
            const again = draw(0.97, true, 4);
            hold = false;
            const restarted = await pixel();
            const exact = draw(0.97, false, 0);
            return {
              initial,
              pinch,
              settle,
              restart,
              again,
              restarted,
              exact,
              final: await pixel(),
            };
          } finally {
            engine.free();
          }
        },
        { before: solid(6000), patch: solid(6000, [0, 1, 0, 1], 1), build },
      );
      expect(rows.initial).toMatchObject({ exact: true });
      for (const frame of [rows.pinch, rows.settle, rows.restart, rows.again]) {
        expect(frame).toMatchObject({ exact: false, drawn: 0 });
      }
      expect(
        [red.join(), [0, 255, 0, 255].join()],
        "a restarted pinch showed neither the screen nor the new fill",
      ).toContain(rows.restarted.join());
      expect(rows.exact).toMatchObject({ exact: true, pending: 0 });
      expect(rows.final).toEqual([0, 255, 0, 255]);
    });

    for (const [label, exactLeft] of [
      // Finer than the frame that follows, as in the final re-check of #345.
      ["finer", { size: [2048, 640], scale: 12, samples: [[1140, 384]] }],
      // Coarser: what the stale tiles (scale 1) would stand in for is laid at a lower scale.
      ["coarser", { size: [160, 40], scale: 0.5, samples: [[40, 16]] }],
    ] as const) {
      test(`an exact frame (${label}) over one of two changes is never undone at another zoom`, async ({
        page,
      }) => {
        // Two red rects turn green. An exact frame at another scale covers only the left one;
        // then a frame at rest at scale 1 (composite-only, so laid from what's kept), and the
        // pinch again. Once green was shown on the left, red never comes back there: not from
        // the stale scale 1 tiles drawn before the edit, nor from a frame laid from them (final
        // re-checks of #345).
        const wide: [number, number][] = [
          [95, 32],
          [715, 32],
        ];
        const rows = await heldFrames(
          page,
          build,
          spacedFills([1, 0, 0, 1]),
          spacedFills([0, 1, 0, 1], 1),
          [
            {
              name: "initial",
              size: [1024, 256],
              scale: 1,
              moving: false,
              budget: 0,
              samples: wide,
            },
            {
              name: "exactLeft",
              size: [exactLeft.size[0], exactLeft.size[1]],
              scale: exactLeft.scale,
              moving: false,
              budget: 0,
              samples: exactLeft.samples.map(([x, y]) => [x, y] as [number, number]),
            },
            {
              name: "atRest",
              size: [1024, 256],
              scale: 1,
              moving: false,
              budget: -1,
              samples: wide,
            },
            {
              name: "restart",
              size: [1024, 256],
              scale: 0.98,
              moving: true,
              budget: 4,
              samples: wide,
            },
            {
              name: "exact",
              size: [1024, 256],
              scale: 0.98,
              moving: false,
              budget: 0,
              samples: wide,
            },
          ],
        );
        const green = [0, 255, 0, 255];
        expect(rows[0]).toMatchObject({ exact: true, samples: [red, red] });
        expect(rows[1]).toMatchObject({ exact: true, samples: [green] });
        for (const row of [rows[2], rows[3]]) expect(row?.exact).toBe(false);
        // The left rect was shown green (the exact frame): never red there again, whatever the
        // zoom. The right one was never shown green before the end.
        neverBack(rows, red, green);
        expect(rows[2]?.samples[0], "the frame at rest went back to the old fill").toEqual(green);
        expect(rows[4]).toMatchObject({ exact: true, pending: 0, samples: [green, green] });
      });
    }

    test("an edit at rest on tiles slower than a slice shows the old fill, then the new, never a hole", async ({
      page,
    }) => {
      // The board under 4,096 squares turns from red to green at rest, drawn under a 1 ms budget
      // a frame: its tiles take several frames. Until they're in, the frame on screen (red)
      // stays where they are, never the background; then green, never red again.
      const green = [0, 255, 0, 255];
      const rest = (name: string, budget: number): Step => ({
        name,
        size: [1024, 256],
        scale: 1,
        moving: false,
        budget,
        // Between squares, on the board.
        samples: [
          [87, 47],
          [607, 199],
        ],
      });
      const rows = await presented(page, build, slowBoard([1, 0, 0, 1]), [
        rest("initial", 0),
        { apply: slowBoard([0, 1, 0, 1], 1) },
        ...Array.from({ length: 30 }, (_, i) => rest(`slice ${i}`, 1)),
        rest("exact", 0),
      ]);
      expect(rows[0]).toMatchObject({ exact: true, samples: [red, red] });
      expect(
        rows.slice(1, -1).some((r) => !r.exact),
        "the redraw took more than one frame",
      ).toBe(true);
      for (const row of rows) {
        for (const sample of row.samples)
          expect(
            [red.join(), green.join()],
            `${row.name} showed neither the old fill nor the new`,
          ).toContain(sample.join());
      }
      neverBack(rows, red, green);
      expect(rows.at(-1)).toMatchObject({ exact: true, pending: 0, samples: [green, green] });
    });

    test("a sharper image level arriving at rest never shows a hole", async ({ page }) => {
      // A red image at 16 px under 4,096 squares, then a 64 px level of the same image: the same
      // picture at another resolution, not an edit. Its tiles take several 1 ms frames to draw
      // again; meanwhile they stand in, so no frame shows the background where the image was,
      // and the view gets exact.
      const rest = (name: string, budget: number): Step => ({
        name,
        size: [1024, 256],
        scale: 1,
        moving: false,
        budget,
        samples: [
          [87, 47],
          [607, 199],
        ],
      });
      const rows = await presented(
        page,
        build,
        slowBoard("image"),
        [
          { image: { id: 1, side: 16, color: "#ff0000" } },
          rest("initial", 0),
          { image: { id: 1, side: 64, color: "#ff0000" } },
          ...Array.from({ length: 30 }, (_, i) => rest(`slice ${i}`, 1)),
          rest("exact", 0),
        ],
        { viewImages: true },
      );
      expect(rows[0]).toMatchObject({ exact: true });
      expect(
        rows.slice(1, -1).some((r) => !r.exact),
        "the refinement took more than one frame",
      ).toBe(true);
      for (const row of rows) {
        expect(row.samples, `${row.name} showed a hole where the image was`).toEqual([red, red]);
      }
      expect(rows.at(-1)).toMatchObject({ exact: true, pending: 0 });
    });

    test("image rows uploaded in strips land where they belong", async ({ page }) => {
      // A 512 px level in 8 bands, in strips of 48 rows (not a band's multiple), stretched over
      // the 1,024 x 256 board: each band's middle shows its colour.
      const bands = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff"];
      const rgba = [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255],
        [255, 0, 255, 255],
        [0, 255, 255, 255],
      ];
      const band = 256 / bands.length;
      const rows = await presented(
        page,
        build,
        imageBoard(),
        [
          { rows: { id: 1, side: 512, colors: bands, from: 0, to: 512, strip: 48 } },
          {
            name: "after the strips",
            size: [1024, 256],
            scale: 1,
            moving: false,
            budget: 0,
            samples: bands.map((_, k) => [512, Math.floor(k * band + band / 2)]),
          },
        ],
        { viewImages: true },
      );
      expect(rows[0]).toMatchObject({ exact: true });
      rows[0]?.samples.forEach((got, k) => {
        for (let c = 0; c < 4; c++)
          expect(Math.abs((got[c] ?? -999) - (rgba[k]?.[c] ?? 0)), `band ${k}`).toBeLessThanOrEqual(
            2,
          );
      });
    });

    test("a level replaced at its width in strips shows the old one until its last strip", async ({
      page,
    }) => {
      // A red 512 px level, then a green one of that width in strips of 64 rows. Until the last
      // strip is in, frames show the red level (never less) and none is exact; then green, and
      // once green is shown, never red again. A cancelled upload keeps the red level, exact.
      const green = [0, 255, 0, 255];
      const rest = (name: string, budget = 0): Step => ({
        name,
        size: [1024, 256],
        scale: 1,
        moving: false,
        budget,
        samples: [
          [100, 40],
          [700, 200],
        ],
      });
      const strips = (from: number, to: number): Step => ({
        rows: { id: 1, side: 512, colors: ["#00ff00"], from, to, strip: 64 },
      });
      const rows = await presented(
        page,
        build,
        imageBoard(),
        [
          { image: { id: 1, side: 512, color: "#ff0000" } },
          rest("whole level"),
          strips(0, 64),
          rest("after the first strip"),
          strips(64, 448),
          rest("before the last strip"),
          strips(448, 512),
          ...Array.from({ length: 6 }, (_, i) => rest(`after the last strip ${i}`, 1)),
          rest("exact"),
        ],
        { viewImages: true },
      );
      expect(rows[0]).toMatchObject({ exact: true, samples: [red, red] });
      for (const row of rows.slice(1, 3)) {
        expect(row.samples, `${row.name} showed less than the red level`).toEqual([red, red]);
        expect(row.exact, `${row.name} was exact mid-upload`).toBe(false);
      }
      for (const row of rows) {
        for (const sample of row.samples)
          expect([red.join(), green.join()], `${row.name}`).toContain(sample.join());
      }
      neverBack(rows, red, green);
      expect(rows.at(-1)).toMatchObject({ exact: true, pending: 0, samples: [green, green] });

      const cancelled = await presented(
        page,
        build,
        imageBoard(),
        [
          { image: { id: 1, side: 512, color: "#ff0000" } },
          rest("whole level"),
          strips(0, 128),
          { cancel: { id: 1, width: 512 } },
          rest("cancelled"),
        ],
        { viewImages: true },
      );
      expect(cancelled.at(-1)).toMatchObject({ exact: true, pending: 0, samples: [red, red] });
    });

    test("strips of two uploads of one width never mix", async ({ page }) => {
      // A second strip upload of the same width starts (rows from 0) while a first is part
      // done: the first's later rows are refused, never landing in the second's texture, and
      // once the second is in, the level is all its colour (#352 re-check 2, probe R).
      const blue = [0, 0, 255, 255];
      const green = [0, 255, 0, 255];
      const rest = (name: string): Step => ({
        name,
        size: [1024, 256],
        scale: 1,
        moving: false,
        budget: 0,
        samples: [
          [500, 8],
          [500, 200],
        ],
      });
      const rows = await presented(
        page,
        build,
        imageBoard(),
        [
          { image: { id: 1, side: 512, color: "#ff0000" } },
          { rows: { id: 1, side: 512, colors: ["#0000ff"], from: 0, to: 64, strip: 64 } },
          { rows: { id: 1, side: 512, colors: ["#00ff00"], from: 0, to: 64, strip: 64 } },
          {
            rows: {
              id: 1,
              side: 512,
              colors: ["#0000ff"],
              from: 64,
              to: 128,
              strip: 64,
              refused: true,
            },
          },
          rest("the second part done"),
          { rows: { id: 1, side: 512, colors: ["#00ff00"], from: 64, to: 512, strip: 64 } },
          rest("the second in"),
        ],
        { viewImages: true },
      );
      expect(rows[0]).toMatchObject({ exact: false, samples: [red, red] });
      expect(rows[1]).toMatchObject({ exact: true, samples: [green, green] });
      for (const row of rows) expect(row.samples, row.name).not.toContainEqual(blue);
    });

    test("a level's placeholder tiles never lie over an overview drawn with the image", async ({
      page,
    }) => {
      // Zoom 2 drawn with the placeholder; the image loads, and once the camera has been still
      // a while the overview is drawn again with it. A moving frame at zoom 12 shows page
      // (40, 10) as the image through the overview; at zoom 2.5, zoom 2's placeholder tiles stand
      // in there too, beneath the overview, never over it (#352 re-check 2, probe H).
      const frame = (
        name: string,
        scale: number,
        x: number,
        moving: boolean,
        budget: number,
      ): Step => {
        const at: [number, number] = [Math.floor(40 * scale + x), Math.floor(10 * scale)];
        const inside = at[0] >= 0 && at[0] < 1024 && at[1] >= 0 && at[1] < 256;
        return { name, size: [1024, 256], scale, x, moving, budget, samples: inside ? [at] : [] };
      };
      const rows = await presented(
        page,
        build,
        farBoard("placeholder"),
        [
          frame("zoom 2 left, placeholder", 2, 0, false, 0),
          frame("zoom 2 right, placeholder", 2, -1024, false, 0),
          { ahead: { times: 40, budget: 50 } },
          { image: { id: 1, side: 64, color: "#ff0000" } },
          { apply: farBoard("loaded", 1) },
          frame("zoom 2 right, image", 2, -1024, false, 0),
          { wait: 1100 },
          { ahead: { times: 40, budget: 50 } },
          frame("zoom 12 left, moving", 12, 0, true, 1),
          frame("zoom 12 panned, moving", 12, -1200, true, 1),
          frame("zoom 2.5 left, moving", 2.5, 0, true, 1),
          frame("zoom 2.5 left, rest", 2.5, 0, false, 0),
        ],
        { viewImages: true },
      );
      expect(rows[0]?.samples[0], "the placeholder first").not.toEqual(red);
      expect(
        rows.find((r) => r.name === "zoom 12 left, moving")?.samples[0],
        "the overview shows the image",
      ).toEqual(red);
      stays(rows, red);
      expect(rows.at(-1)).toMatchObject({ exact: true, samples: [red] });
    });

    test("an image once shown never goes back to its placeholder at another zoom", async ({
      page,
    }) => {
      // The board drawn at zoom 1 with its image's placeholder; the image arrives (the same
      // picture: zoom 1's tiles stand in until drawn again); zoom 2 drawn exact with it; then
      // back to zoom 1, moving and at rest, 1 ms at a time. Where zoom 2 showed the image, no
      // frame shows the placeholder again: tiles drawn with it lie beneath the frame on screen
      // and zoom 2's tiles (#352 re-check).
      const frame = (name: string, scale: number, moving: boolean, budget: number): Step => ({
        name,
        size: [1024, 256],
        scale,
        moving,
        budget,
        // Page (103.5, 47.5) and (399.5, 103.5), between the dark squares, shown at zoom 2.
        samples: [
          [Math.floor(103.5 * scale), Math.floor(47.5 * scale)],
          [Math.floor(399.5 * scale), Math.floor(103.5 * scale)],
        ],
      });
      const rows = await presented(
        page,
        build,
        slowBoard("placeholder"),
        [
          frame("zoom 1", 1, false, 0),
          { image: { id: 1, side: 64, color: "#ff0000" } },
          { apply: slowBoard("loaded", 1) },
          frame("zoom 2", 2, false, 0),
          frame("zooming 1.6", 1.6, true, 1),
          frame("zooming 1.25", 1.25, true, 1),
          frame("zooming 1", 1, true, 1),
          ...Array.from({ length: 20 }, (_, i) => frame(`zoom 1 slice ${i}`, 1, false, 1)),
          frame("zoom 1 exact", 1, false, 0),
        ],
        { viewImages: true },
      );
      expect(rows[0]).toMatchObject({ exact: true });
      expect(rows[0]?.samples[0], "the placeholder first").not.toEqual(red);
      expect(rows[1]).toMatchObject({ exact: true, samples: [red, red] });
      for (const row of rows.slice(1)) {
        expect(row.samples, `${row.name} went back to the placeholder`).toEqual([red, red]);
      }
      expect(
        rows.slice(2, -1).some((r) => !r.exact),
        "zoom 1 took more than one frame to draw again",
      ).toBe(true);
      expect(rows.at(-1)).toMatchObject({ exact: true, pending: 0 });
    });

    for (const kind of ["edit", "image", "glyph"] as const) {
      test(`content arriving while pinching (${kind}) never goes back`, async ({ page }) => {
        // A remote fill edit (then its undo), an image replaced at the size it had, or shaped
        // text replacing provisional bars, while pinching with no tile slots. Each frame shows
        // what's on screen or the new content: once the new content was shown somewhere, the
        // old never is there again (before an undo makes it current again), and the view
        // settles exact (re-checks of #345).
        const green = [0, 255, 0, 255];
        const frame = (
          name: string,
          scale: number,
          moving: boolean,
          budget = moving ? 4 : 0,
        ): Step => ({
          name,
          size: [1280, 256],
          scale,
          x: -12,
          moving,
          budget,
          samples: [
            [120, 128],
            [600, 128],
            [1120, 128],
          ],
        });
        const list =
          kind === "edit"
            ? wideLayer("red")
            : kind === "image"
              ? wideLayer("image")
              : wideLayer("provisional");
        const change: Step =
          kind === "edit"
            ? { apply: wideLayer("green", 1) }
            : kind === "image"
              ? { image: { id: 1, side: 16, color: "#00ff00" } }
              : { apply: wideLayer("glyph", 1) };
        const steps: Step[] = [
          ...(kind === "image" ? [{ image: { id: 1, side: 16, color: "#ff0000" } }] : []),
          frame("initial", 1, false),
          frame("pinch", 0.99, true),
          change,
          frame("updated", 0.98, true),
          frame("next", 0.97, true),
          ...(kind === "edit" ? [{ apply: wideLayer("undo", 2) }, frame("undo", 0.96, true)] : []),
          frame("settled", 0.96, false, 4),
          frame("exact", 0.96, false),
        ];
        const rows = await presented(page, build, list, steps, {
          tileBytes: 0,
          viewImages: kind === "image",
        });
        expect(rows[0]?.samples).toEqual([red, red, red]);
        // Moving after the change: inexact.
        for (const row of rows.filter((r) => ["updated", "next", "undo"].includes(r.name)))
          expect(row.exact).toBe(false);
        // Before an undo makes red current again.
        neverBack(
          rows.filter((r) => r.name !== "undo" && r.name !== "settled" && r.name !== "exact"),
          red,
          green,
        );
        if (kind !== "edit") neverBack(rows, red, green);
        const settled = rows.find((r) => r.name === "settled");
        for (const sample of settled?.samples ?? [])
          expect([red.join(), green.join()], "the frame at rest showed a hole").toContain(
            sample.join(),
          );
        const color = kind === "edit" ? red : green;
        expect(rows.at(-1)).toMatchObject({
          exact: true,
          pending: 0,
          samples: [color, color, color],
        });
      });
    }

    test("a whole frame done in its first call reports the overview still to draw", async ({
      page,
    }) => {
      // A wide backdrop blur makes the view a whole frame; a long budget finishes it in its
      // first call. That first presentation must report the overview's tiles as queued, or the
      // editor's time between frames never wakes to draw them (re-check of #345).
      await openEngine(page, build);
      const list = new ListWriter(0xffffffff, 1);
      list.reset();
      for (const [id, size, blur] of [
        [1, 6000, false],
        [2, 240, true],
      ] as const) {
        list.set(id, ROOT, {
          flags: 0,
          transform: [1, 0, 0, 1, 0, 0],
          opacity: 1,
          width: size,
          height: size,
          coarseBelow: 0,
          reach: blur ? 320 : 0,
          unsupported: 0,
          paths: [{ kind: "rect", w: size, h: size, radii: [0, 0, 0, 0], smoothing: 0 }],
          ops: blur
            ? [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius: 160 }]
            : [
                {
                  op: "fill",
                  path: 0,
                  evenOdd: false,
                  paint: { kind: "solid", color: [1, 0, 0, 1] },
                },
              ],
          coarse: [],
        });
      }
      const rows = await page.evaluate(
        async (bytes) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const engine = new glue.Engine(0, 0);
          const read = (out: {
            ok: boolean;
            message: string;
            in_progress: boolean;
            pending: number;
            queued: number;
            free(): void;
          }) => {
            const row = {
              ok: out.ok,
              message: out.message,
              inProgress: out.in_progress,
              pending: out.pending,
              queued: out.queued,
            };
            out.free();
            if (!row.ok) throw new Error(row.message);
            return row;
          };
          try {
            const gpu = await glue.createGpu(null, 0);
            const attached = engine.attachGpu?.(gpu);
            gpu.free();
            if (!attached) throw new Error("no GPU entry points");
            attached.free();
            const applied = engine.apply(new Uint8Array(bytes));
            applied.free();
            const frame = (budget: number) => {
              const out = engine.renderGpu?.(
                256,
                256,
                2,
                0,
                0,
                1,
                new Float32Array([0, 0, 0, 1]),
                false,
                budget,
              );
              if (!out) throw new Error("no renderGpu");
              return read(out as never);
            };
            return { first: frame(10_000), again: frame(-1) };
          } finally {
            engine.free();
          }
        },
        [...list.finish()],
      );
      expect(rows.first).toMatchObject({ inProgress: false, pending: 0 });
      expect(rows.again.queued).toBeGreaterThan(0);
      expect(
        rows.first.queued,
        "the first presentation must wake the time between frames",
      ).toBeGreaterThan(0);
    });

    test("a view without tile slots settles at rest, the same as drawn at once", async ({
      page,
    }) => {
      // No slot holds a tile, so the frame is drawn straight into a frame texture. Under a
      // budget at rest (or composite-only) it's drawn over as many frames as it takes, each
      // laying the last unchanged beneath it; once settled it's exactly what one drawn at once
      // (no budget, a fresh engine) shows.
      const frame = {
        size: [1024, 64],
        pixel: [560, 32],
        camera: [1, 0, 0, 1],
        moving: false,
      } satisfies Omit<Frame, "budget">;
      for (const budget of [-1, 1, 8]) {
        const results = await sample(
          page,
          directStripes(100),
          [
            { ...frame, budget, repeatUntilExact: 40 },
            // At rest and exact: shown again as it is, nothing drawn.
            { ...frame, budget },
            { ...frame, budget: 0, freshReference: true },
          ],
          0,
          build,
        );
        expect(results[0]).toMatchObject({ exact: true, pending: 0, pixel: red });
        expect(results[1]).toMatchObject({ exact: true, pending: 0, drawn: 0, pixel: red });
        expect(results[2]).toMatchObject({ exact: true, differingBytes: 0 });
      }
    });

    test("an exact frame no slot can hold is drawn over several frames at rest", async ({
      page,
    }) => {
      // Up to 40 frames of 32,768 squares and a fresh reference: 40-50 s on SwiftShader.
      test.setTimeout(120_000);
      // 32,768 squares over a 2,048 x 1,024 view: eight direct tiles that take more than the
      // 1 ms budget each. The view settles over several calls, never one stall, inexact until
      // the last tile is in, and then matches a frame drawn at once byte for byte.
      const frame = {
        size: [2048, 1024],
        pixel: [1, 1],
        camera: [1, 0, 0, 1],
        moving: false,
      } satisfies Omit<Frame, "budget">;
      const results = await sample(
        page,
        denseSquares(2048, 1024),
        [
          { ...frame, budget: 1 },
          { ...frame, budget: 1, repeatUntilExact: 40 },
          { ...frame, budget: 0, freshReference: true },
        ],
        0,
        build,
      );
      expect(results[0]?.exact, "the first slice can't hold every tile").toBe(false);
      expect(results[0]?.pending).toBeGreaterThan(0);
      expect(results[0]?.drawn).toBeLessThan(8);
      expect(results[1]).toMatchObject({ exact: true, pending: 0 });
      expect(results[1]?.attempts).toBeGreaterThan(1);
      expect(results[2]).toMatchObject({ exact: true, differingBytes: 0 });
    });

    test("an edit while a frame no slot can hold is drawn at rest never goes back", async ({
      page,
    }) => {
      // The fill turns from red to green between slices of a frame no slot can hold: each frame
      // shows the frame on screen (red) or the new fill, never the background, and once green
      // shows somewhere, never red there again; the view settles exact green.
      const green = [0, 255, 0, 255];
      const rest = (name: string, budget: number): Step => ({
        name,
        size: [1536, 512],
        scale: 1,
        moving: false,
        budget,
        samples: [
          [100, 256],
          [800, 256],
          [1400, 256],
        ],
      });
      const rows = await presented(
        page,
        build,
        solid(6000),
        [
          rest("initial", 0),
          { apply: solid(6000, [0, 1, 0, 1], 1) },
          ...Array.from({ length: 12 }, (_, i) => rest(`slice ${i}`, 1)),
          rest("exact", 0),
        ],
        { tileBytes: 0 },
      );
      expect(rows[0]).toMatchObject({ exact: true, samples: [red, red, red] });
      for (const row of rows) {
        for (const sample of row.samples)
          expect(
            [red.join(), green.join()],
            `${row.name} showed neither the old fill nor the new`,
          ).toContain(sample.join());
      }
      neverBack(rows, red, green);
      expect(rows.at(-2)).toMatchObject({
        exact: true,
        pending: 0,
        samples: [green, green, green],
      });
      expect(rows.at(-1)).toMatchObject({ exact: true, samples: [green, green, green] });
    });

    for (const budget of [1, 8, -1]) {
      test(`text replacing provisional bars between slices settles exact (budget ${budget})`, async ({
        page,
      }) => {
        // Provisional bars draw a sliced frame inexact; the real glyphs arrive between slices
        // and redraw those tiles exact. One inexact tile once must not keep the frame inexact
        // for good (#358 review, P1).
        const green = [0, 255, 0, 255];
        const rest = (name: string): Step => ({
          name,
          size: [1536, 512],
          scale: 1,
          moving: false,
          budget,
          samples: [
            [100, 256],
            [800, 256],
            [1400, 256],
          ],
        });
        const rows = await presented(
          page,
          build,
          wideLayer("provisional"),
          [
            ...Array.from({ length: 10 }, (_, i) => rest(`bars ${i}`)),
            { apply: wideLayer("glyph", 1) },
            ...Array.from({ length: 20 }, (_, i) => rest(`glyphs ${i}`)),
          ],
          { tileBytes: 0 },
        );
        expect(
          rows.slice(0, 10).every((r) => !r.exact),
          "bars are never exact",
        ).toBe(true);
        expect(rows.at(-1)).toMatchObject({
          exact: true,
          pending: 0,
          samples: [green, green, green],
        });
      });
    }

    test("an image's first level arriving between slices shows, and the view settles exact", async ({
      page,
    }) => {
      // The placeholder is drawn into finished tiles of a sliced frame; the image's first level
      // arrives between slices. Those tiles are drawn again (an image level records where it
      // shows for sliced frames), never reported exact with the placeholder (#358 review, P2).
      const green = [0, 255, 0, 255];
      const rest = (name: string, budget: number): Step => ({
        name,
        size: [1536, 512],
        scale: 1,
        moving: false,
        budget,
        samples: [
          [100, 256],
          [800, 256],
          [1400, 256],
        ],
      });
      const rows = await presented(
        page,
        build,
        wideLayer("image"),
        [
          ...Array.from({ length: 10 }, (_, i) => rest(`no image ${i}`, 1)),
          { image: { id: 1, side: 16, color: "#00ff00" } },
          ...Array.from({ length: 20 }, (_, i) => rest(`image ${i}`, 1)),
        ],
        { tileBytes: 0, viewImages: true },
      );
      const after = rows.slice(10);
      for (const row of after)
        if (row.exact)
          expect(row.samples, `${row.name} exact with the placeholder`).toEqual([
            green,
            green,
            green,
          ]);
      // Once the image shows at a sample, it stays.
      for (let k = 0; k < 3; k++) {
        const first = after.findIndex((r) => r.samples[k]?.join() === green.join());
        if (first >= 0)
          for (const row of after.slice(first))
            expect(row.samples[k], `${row.name} sample ${k} went back`).toEqual(green);
      }
      expect(rows.at(-1)).toMatchObject({
        exact: true,
        pending: 0,
        samples: [green, green, green],
      });
    });

    test("an image's first level arriving mid-series on slow tiles shows, and settles exact", async ({
      page,
    }) => {
      // As above, with tiles slower than a 1 ms slice (#358 review, P2b).
      const green = [0, 255, 0, 255];
      const frame = (name: string): Step => ({
        name,
        size: [1024, 256],
        scale: 1,
        moving: false,
        budget: 1,
        samples: [
          [0, 0],
          [512, 0],
          [1020, 0],
        ],
      });
      const rows = await presented(
        page,
        build,
        slowBoard("image"),
        [
          frame("first"),
          { image: { id: 1, side: 16, color: "#00ff00" } },
          ...Array.from({ length: 20 }, (_, i) => frame(`image ${i}`)),
        ],
        { tileBytes: 0, viewImages: true },
      );
      for (const row of rows.slice(1))
        if (row.exact)
          expect(row.samples, `${row.name} exact with the placeholder`).toEqual([
            green,
            green,
            green,
          ]);
      expect(rows.at(-1)).toMatchObject({
        exact: true,
        pending: 0,
        samples: [green, green, green],
      });
    });

    test("after a wide edit, edits near the middle before every slice never starve the rest", async ({
      page,
    }) => {
      // The frame is done, then a wide edit drops all eight tiles, then a 20 px square near the
      // middle changes before every 1 ms slice. Tiles to draw again go longest dropped first, one
      // drawn and dropped again to the back, so every tile shows green within 20 slices (#358
      // re-check 2, P6).
      test.setTimeout(150_000);
      const green = [0, 255, 0, 255];
      const points: [number, number][] = [];
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 4; i++) points.push([258 + 512 * i, 258 + 512 * j]);
      const frame = (name: string): Step => ({
        name,
        size: [2048, 1024],
        scale: 1,
        moving: false,
        budget: 1,
        samples: points,
      });
      const steps: Step[] = Array.from({ length: 14 }, (_, i) => frame(`warm ${i}`));
      steps.push({ apply: cover(1, 999999, [0, 1, 0, 1]) });
      for (let i = 0; i < 20; i++) {
        steps.push({ apply: cover(2 + i, 1000000, [0, 0, 1, 1], 20, 20, [1000 + (i % 2), 500]) });
        steps.push(frame(`slice ${i}`));
      }
      const rows = await presented(page, build, denseSquares(2048, 1024), steps, { tileBytes: 0 });
      expect(rows.find((r) => r.name === "warm 13")?.exact, "the first series finished").toBe(true);
      const greenAt = (name: string) =>
        rows.find((r) => r.name === name)?.samples.filter((s) => s.join() === green.join()).length;
      expect(greenAt("slice 19"), "tiles away from the edits were starved").toBe(points.length);
    });

    test("a cheap page's slices never make the next page's frame be drawn at once", async ({
      page,
    }) => {
      // A light page's frame no slot can hold settles over cheap slices; then a dense page is
      // loaded. Its first frame at rest is still sliced, never drawn whole in one call on an
      // estimate from the cheap tiles (#358 re-check 2, P7).
      test.setTimeout(150_000);
      const frame = (name: string): Step => ({
        name,
        size: [2048, 1024],
        scale: 1,
        moving: false,
        budget: 8,
        samples: [[1, 1]],
      });
      const rows = await presented(
        page,
        build,
        solid(6000),
        [
          ...Array.from({ length: 20 }, (_, i) => frame(`light ${i}`)),
          { apply: denseSquares(2048, 1024, 2) },
          frame("dense, first"),
        ],
        { tileBytes: 0 },
      );
      expect(rows[19]).toMatchObject({ exact: true });
      const first = rows.at(-1);
      expect(first?.exact, "the dense frame was drawn at once").toBe(false);
      expect(first?.drawn).toBeLessThan(8);
    });

    test("edits near the middle before every slice never starve the rest", async ({ page }) => {
      // 32 frames of 32,768 squares take 40-55 s on SwiftShader.
      test.setTimeout(120_000);
      // Eight slow direct tiles are drawn green, while a small square near the middle changes
      // before every 1 ms slice (a collaborator dragging). Tiles drawn again take turns with those never
      // drawn, so every tile shows green within 20 slices, and the view settles once the
      // edits stop (#358 review, P4).
      const green = [0, 255, 0, 255];
      const points: [number, number][] = [];
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 4; i++) points.push([258 + 512 * i, 258 + 512 * j]);
      const frame = (name: string, budget = 1): Step => ({
        name,
        size: [2048, 1024],
        scale: 1,
        moving: false,
        budget,
        samples: points,
      });
      // No frame drawn at once first: 32,768 squares in one call can outlast a read-back's wait
      // on SwiftShader.
      const steps: Step[] = [{ apply: cover(1, 999999, [0, 1, 0, 1]) }];
      for (let i = 0; i < 20; i++) {
        steps.push({ apply: cover(2 + i, 1000000, [0, 0, 1, 1], 20, 20, [1000 + (i % 2), 500]) });
        steps.push(frame(`slice ${i}`));
      }
      steps.push(...Array.from({ length: 12 }, (_, i) => frame(`quiet ${i}`)));
      const rows = await presented(page, build, denseSquares(2048, 1024), steps, { tileBytes: 0 });
      const greenAt = (name: string) =>
        rows.find((r) => r.name === name)?.samples.filter((s) => s.join() === green.join()).length;
      expect(greenAt("slice 19"), "tiles away from the edits were starved").toBe(points.length);
      expect(rows.at(-1)).toMatchObject({ exact: true, pending: 0 });
    });

    for (const neighbour of ["green", "empty", "none", "clipped"] as const) {
      test(`a paused tile completes with identical pixels with ${neighbour} neighbour`, async ({
        page,
      }) => {
        // Full geometry and a second device for the fresh reference can be slow in SwiftShader.
        test.setTimeout(180_000);
        const frame: Frame = {
          camera: [1, 0, 0, 1],
          size: [neighbour === "none" || neighbour === "clipped" ? 256 : 1000, 64],
          pixel: [32, 32],
          moving: false,
          budget: 8,
          editorViewport: true,
        };
        const [_, interrupted, settled, fresh] = await sample(
          page,
          checkpointScene(neighbour),
          [
            { ...frame, camera: [1, -5000, 0, 1], budget: 0 },
            { ...frame, budget: neighbour === "none" || neighbour === "clipped" ? 8 : 1 },
            { ...frame, repeatUntilExact: 80 },
            { ...frame, budget: 0, freshReference: true },
          ],
          undefined,
          build,
        );
        expect(interrupted).toMatchObject({ exact: false, sawPause: true });
        expect(settled).toMatchObject({ exact: true, pending: 0 });
        expect(fresh).toMatchObject({ exact: true, differingBytes: 0 });
        console.log(
          `Checkpoint ${build}/${neighbour} settled in ${settled?.attempts} further frames, max draw ${Math.max(interrupted?.maxMs ?? 0, settled?.maxMs ?? 0)} ms`,
        );
      });
    }

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
                ? [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius: 160 }]
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
          plainDpr2: await measure(withoutGlass, 21, 2),
          // Thick frost at DPR 4 exceeds the tile halo. The whole-frame target
          // fits at 21 MiB, leaving the glass mask itself to exercise admission.
          glassLimited: await measure(deepFrost, 21, 4),
          glassFits: await measure(deepFrost, 128, 4),
          // Radius 160 at DPR 2 exceeds the tile halo so whole-frame reader
          // admission is observed directly instead of retrying on tiles. Both
          // the frame target (plainDpr2) and shape mask fit at 21 MiB, leaving
          // `reader blur_out` to refuse admission.
          uniformLimited: await measure(uniform, 21, 2),
          uniformFits: await measure(uniform, 24, 2),
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
    expect(res.budgets.plainDpr2.ok).toBe(true);
    expect(res.budgets.glassLimited).toMatchObject({ ok: false, code: 4 });
    expect(res.budgets.glassLimited.message).toContain("reader mask");
    expect(res.budgets.glassFits.ok).toBe(true);
    expect(res.budgets.uniformLimited).toMatchObject({ ok: false, code: 4 });
    expect(res.budgets.uniformLimited.message).toContain("reader blur_out");
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
  test(`wide progressive and isolated backdrop blur keep device pixels (${build})`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const list = new ListWriter(0xffffffff, 1);
    list.reset();
    let id = 1;
    const rect = (
      parent: number,
      x: number,
      width: number,
      ops: WireRecord["ops"],
      flags = 0,
      opacity = 1,
    ) => {
      const key = id++;
      list.set(key, parent, {
        flags,
        transform: [1, 0, 0, 1, x, 0],
        opacity,
        width,
        height: 200,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w: width, h: 200, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops,
        coarse: [],
      });
      return key;
    };
    const fill = (color: readonly [number, number, number, number]): WireRecord["ops"] => [
      { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } },
    ];
    rect(ROOT, 0, 1_200, fill([1, 0, 0, 1]));
    for (const [offset, isolated, progressive] of [
      [0, false, true],
      [500, true, false],
      [1_000, true, true],
    ] as const) {
      const parent = isolated
        ? rect(ROOT, offset, 200, [{ op: "children" }], FLAG.isolate, 0.75)
        : ROOT;
      const x = isolated ? 0 : offset;
      rect(parent, x, 200, fill([1, 1, 1, 1]));
      rect(parent, x, 100, fill([0, 0, 0, 1]));
      rect(
        parent,
        x,
        200,
        progressive
          ? [
              {
                op: "progressiveBlur",
                paths: [0],
                evenOdd: false,
                startRadius: 0,
                endRadius: 40,
                start: [0, 0.25],
                end: [0, 0.75],
              },
            ]
          : [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius: 40 }],
      );
    }

    const frame = (x: number, y: number, pixelX = 320, zoom = 100): Frame => ({
      camera: [zoom, 160 - x * zoom, 96 - y * zoom, 2],
      size: [640, 384],
      pixel: [pixelX, 192],
      moving: false,
      budget: 0,
      editorViewport: true,
    });
    const points = await sample(
      page,
      [...list.finish()],
      [
        frame(100, 25, 319),
        frame(100, 25),
        frame(100, 125),
        frame(600, 125),
        frame(1_100, 125, 320, 256),
      ],
      undefined,
      build,
    );
    expect(points.map((point) => point.bytes)).toEqual(Array(5).fill(640 * 384 * 4));
    expect(points[0]?.pixel).toEqual([0, 0, 0, 255]);
    expect(points[1]?.pixel).toEqual([255, 255, 255, 255]);
    for (const [point, reference] of [
      [points[2], [128, 128, 128, 255]],
      [points[3], [160, 96, 96, 255]],
      [points[4], [160, 96, 96, 255]],
    ] as const) {
      expect(point?.pixel).toHaveLength(4);
      for (const [i, channel] of reference.entries())
        expect(
          Math.abs((point?.pixel[i] ?? 0) - channel),
          `pixel ${point?.pixel}`,
        ).toBeLessThanOrEqual(3);
    }
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

for (const build of ["browser", "webgl"] as const) {
  test(`inner shadow inversion matches uninverted blur byte-for-byte (${build})`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const root = ROOTS[build];
    const expectedBackend = build === "webgl" ? "webgl2" : "webgpu";
    const width = 640;
    const height = 448;

    type InnerCase = {
      name: "canonical" | "direct" | "pyramid" | "reduced";
      w: number;
      h: number;
      radii: [number, number, number, number];
      smoothing: number;
      blur: number;
      count: number;
    };
    const cases: InnerCase[] = [
      {
        name: "canonical",
        w: 184,
        h: 125,
        radii: [13, 13, 13, 13],
        smoothing: 0,
        blur: 14,
        count: 2,
      },
      {
        name: "direct",
        w: 184,
        h: 125,
        radii: [4, 30, 13, 40],
        smoothing: 0.6,
        blur: 14,
        count: 2,
      },
      {
        name: "pyramid",
        w: 184,
        h: 125,
        radii: [4, 30, 13, 40],
        smoothing: 0.6,
        blur: 30,
        count: 2,
      },
      {
        name: "reduced",
        w: 560,
        h: 370,
        radii: [4, 30, 13, 40],
        smoothing: 0.6,
        blur: 125,
        count: 1,
      },
    ];

    const buildLists = (c: InnerCase) => {
      const make = (mode: "shape" | "inner" | "drop") => {
        const w = new ListWriter(0xffffffff, 1);
        w.reset();
        let nextId = 0;
        const paths: WireRecord["paths"] = [
          { kind: "rect", w: c.w, h: c.h, radii: c.radii, smoothing: c.smoothing },
        ];
        for (let i = 0; i < c.count; i++) {
          const x = 12.25 + i * 205;
          const y = 21.5 + i * 72;
          if (mode === "drop") {
            const parentId = ++nextId;
            w.set(parentId, ROOT, {
              flags: 0,
              opacity: 1,
              transform: [1, 0, 0, 1, x, y],
              width: c.w,
              height: c.h,
              coarseBelow: 0,
              reach: 0,
              unsupported: 0,
              paths,
              ops: [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
              coarse: [],
            });
            w.set(++nextId, parentId, {
              flags: 0,
              opacity: 1,
              transform: [1, 0, 0, 1, 0, 0],
              width: c.w,
              height: c.h,
              coarseBelow: 0,
              reach: 0,
              unsupported: 0,
              paths,
              ops: [
                {
                  op: "dropShadow",
                  paths: [0],
                  evenOdd: false,
                  dx: 8.5,
                  dy: -4.75,
                  blur: c.blur,
                  color: [1, 1, 1, 1],
                  blend: 0,
                },
              ],
              coarse: [],
            });
          } else {
            w.set(++nextId, ROOT, {
              flags: 0,
              opacity: 1,
              transform: [1, 0, 0, 1, x, y],
              width: c.w,
              height: c.h,
              coarseBelow: 0,
              reach: 0,
              unsupported: 0,
              paths,
              ops:
                mode === "shape"
                  ? [
                      {
                        op: "fill",
                        path: 0,
                        evenOdd: false,
                        paint: { kind: "solid", color: [1, 1, 1, 1] },
                      },
                    ]
                  : [
                      {
                        op: "innerShadow",
                        shape: 0,
                        hole: 0,
                        evenOdd: false,
                        dx: 8.5,
                        dy: -4.75,
                        blur: c.blur,
                        color: [1, 1, 1, 1],
                        blend: 0,
                      },
                    ],
              coarse: [],
            });
          }
        }
        return [...w.finish()];
      };
      return {
        name: c.name,
        shape: make("shape"),
        inner: make("inner"),
        drop: make("drop"),
      };
    };

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

    const results = await page.evaluate(
      async ({ scenes, width, height, expectedBackend }) => {
        const mod = "/engine.js";
        const glue = (await import(mod)) as typeof import("@drawpane/engine/browser-glue");
        await glue.default({ module_or_path: "/engine_bg.wasm" });
        if (glue.gpuBackend() !== expectedBackend) throw new Error("wrong GPU backend");
        const check = (out: { ok: boolean; message: string; free(): void } | undefined) => {
          if (!out) throw new Error("missing GPU API");
          const { ok, message } = out;
          out.free();
          if (!ok) throw new Error(message);
        };
        const black = new Float32Array([0, 0, 0, 1]);
        const render = async (list: number[]) => {
          let device = await glue.createGpu(null, 0);
          for (let attempt = 0; attempt < 3 && !device.ok; attempt++) {
            device.free();
            await new Promise((r) => setTimeout(r, 300));
            device = await glue.createGpu(null, 0);
          }
          if (!device.ok) {
            const msg = device.message;
            device.free();
            throw new Error(msg);
          }
          const engine = new glue.Engine(0, 0);
          try {
            check(engine.attachGpu?.(device));
            check(engine.apply(new Uint8Array(list)));
            const draw = engine.renderGpu?.(width, height, 1, 0, 0, 1, black, false, 0);
            if (!draw) throw new Error("no renderGpu");
            const shadowHits = draw.shadow_hits;
            const shadowOps = draw.shadow_ops;
            check(draw);
            const pixels = await engine.gpuPixels?.();
            if (!(pixels instanceof Uint8Array)) throw new Error("gpuPixels failed");
            return { pixels, shadowHits, shadowOps };
          } finally {
            engine.free();
            device.free();
          }
        };

        const summary = [];
        for (const s of scenes) {
          const shape = await render(s.shape);
          const inner = await render(s.inner);
          const drop = await render(s.drop);
          let interior = 0;
          let graded = 0;
          let diffCount = 0;
          let maxDiff = 0;
          for (let i = 0; i < shape.pixels.length; i += 4) {
            if (shape.pixels[i] !== 255) continue;
            interior++;
            const iv = inner.pixels[i] ?? 0;
            const dv = drop.pixels[i] ?? 0;
            if (iv > 0 && iv < 255) graded++;
            const err = Math.abs(iv + dv - 255);
            if (err > 0) {
              diffCount++;
              if (err > maxDiff) maxDiff = err;
            }
          }
          summary.push({
            name: s.name,
            interior,
            graded,
            diffCount,
            maxDiff,
            innerHits: inner.shadowHits,
            innerOps: inner.shadowOps,
          });
        }
        return summary;
      },
      { scenes: cases.map(buildLists), width, height, expectedBackend },
    );

    for (const row of results) {
      expect(row.interior).toBeGreaterThan(10_000);
      expect(row.graded).toBeGreaterThan(1_000);
      if (row.name === "canonical") {
        expect(row.innerHits).toBeGreaterThanOrEqual(1);
        expect(row.diffCount).toBe(0);
      } else if (row.name === "direct" || row.name === "pyramid") {
        expect(row.innerHits).toBe(0);
        expect(row.diffCount).toBe(0);
      } else {
        // Reduced shadows invert after bilinear upsampling in shadow.wgsl::fs_upsample_mask.
        expect(row.innerHits).toBe(0);
        expect(row.maxDiff).toBeLessThanOrEqual(1);
      }
    }
  });
}

const SCOPE_CLIP_COUNTER = GPU_RENDER_KINDS.indexOf("scopeClip");
const BLUR_CLIP_COUNTER = GPU_RENDER_KINDS.indexOf("blurClip");
const READER_CLIP_COUNTER = GPU_RENDER_KINDS.indexOf("readerClip");
const SCOPES_COUNTER = GPU_RENDER_KINDS.length + GPU_FLUSH_CAUSES.length;
const PAUSES_COUNTER = GPU_RENDER_KINDS.length + GPU_FLUSH_CAUSES.length + 3;

function hwBlendWarmupLists(): number[][] {
  const modes = [
    BLEND.multiply,
    BLEND.screen,
    BLEND["linear-dodge"],
    BLEND["linear-burn"],
  ] as const;
  return modes.map((blend, i) => {
    const w = new ListWriter(0xffffffff, i + 1);
    w.reset();
    w.set(1, ROOT, {
      flags: 0,
      transform: [1, 0, 0, 1, 0, 0],
      opacity: 1,
      width: 16,
      height: 16,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w: 16, h: 16, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops: [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: { kind: "solid", color: [0.5, 0.4, 0.3, 0.7], blend },
        },
      ],
      coarse: [],
    });
    return [...w.finish()];
  });
}

function hwBlendShowcaseScene(base = 0xffffffff, revision = 10, shiftX = 0, offsetX = 0): number[] {
  const list = new ListWriter(base, revision);
  if (base === 0xffffffff) list.reset();
  let nextId = 1;
  const rect = (
    parent: number,
    x: number,
    y: number,
    w: number,
    h: number,
    ops: WireRecord["ops"],
    opts?: {
      flags?: number;
      blend?: number;
      opacity?: number;
      radii?: readonly [number, number, number, number];
      reach?: number;
      id?: number;
    },
  ) => {
    const id = opts?.id ?? nextId++;
    const tx = parent === ROOT ? x + offsetX : x;
    list.set(id, parent, {
      flags: opts?.flags ?? 0,
      transform: [1, 0, 0, 1, tx, y],
      opacity: opts?.opacity ?? 1,
      width: w,
      height: h,
      coarseBelow: 0,
      reach: opts?.reach ?? 0,
      unsupported: 0,
      paths: [
        {
          kind: "rect",
          w,
          h,
          radii: opts?.radii ?? [0, 0, 0, 0],
          smoothing: 0,
        },
      ],
      ops,
      coarse: [],
      ...(opts?.blend !== undefined ? { blend: opts.blend } : {}),
    });
    return id;
  };

  // Varied opaque backdrop stripes covering [384..640, 64..256] (straddling the x=512 tile seam).
  const stripes: readonly [number, number, readonly [number, number, number, number]][] = [
    [384, 64, [0.2, 0.4, 0.8, 1]],
    [448, 64, [0.95, 128 / 255, 10 / 255, 1]],
    [512, 64, [127 / 255, 64 / 255, 200 / 255, 1]],
    [576, 64, [1, 0.5, 0, 1]],
  ];
  for (const [x, w, color] of stripes) {
    rect(ROOT, x, 64, w, 192, [
      { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } },
    ]);
  }

  // Row 1 (y=68..106): Direct blended fills across all 4 HW modes with full and partial alpha,
  // spanning backdrop stripes and crossing the x=512 tile boundary.
  const fourModes = [
    BLEND.multiply,
    BLEND.screen,
    BLEND["linear-dodge"],
    BLEND["linear-burn"],
  ] as const;
  const directAlphas = [1, 0.5, 0.37, 0.75] as const;
  for (const [m, blend] of fourModes.entries()) {
    const alpha = directAlphas[m] ?? 0.5;
    rect(ROOT, 392 + m * 58, 68, 56, 38, [
      {
        op: "fill",
        path: 0,
        evenOdd: false,
        paint: {
          kind: "solid",
          color: [(m * 53 + 47) / 255, (m * 71 + 61) / 255, (m * 43 + 31) / 255, alpha],
          blend,
        },
      },
    ]);
  }

  // Row 2 (y=112..152): Layer-blended leaves under AA-rect and rounded-rect clips. Each leaf
  // overhangs its clip edges so offscreen isolation rasterizes `scopeClip` masks while the HW path
  // clips inside Vello's strip pass with zero `scopeClip` renders.
  const aaClip = rect(ROOT, 392, 112, 112, 40, [
    { op: "clip", path: 0, evenOdd: false },
    { op: "children" },
    { op: "unclip" },
  ]);
  const roundClip = rect(
    ROOT,
    516,
    112,
    116,
    40,
    [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
    { radii: [14, 14, 14, 14] },
  );
  rect(
    aaClip,
    -8,
    -8,
    60,
    56,
    [
      {
        op: "fill",
        path: 0,
        evenOdd: false,
        paint: { kind: "solid", color: [0.35, 0.75, 0.5, 0.65] },
      },
    ],
    { flags: FLAG.blend, blend: BLEND.multiply },
  );
  rect(
    aaClip,
    60,
    -8,
    60,
    56,
    [
      {
        op: "fill",
        path: 0,
        evenOdd: false,
        paint: { kind: "solid", color: [0.85, 0.45, 0.3, 0.75] },
      },
    ],
    { flags: FLAG.blend, blend: BLEND.screen },
  );
  rect(
    roundClip,
    -10,
    -10,
    66,
    60,
    [
      {
        op: "fill",
        path: 0,
        evenOdd: false,
        paint: { kind: "solid", color: [0.75, 0.3, 0.55, 0.8] },
      },
    ],
    { flags: FLAG.blend, blend: BLEND["linear-dodge"] },
  );
  rect(
    roundClip,
    62,
    -10,
    66,
    60,
    [
      {
        op: "fill",
        path: 0,
        evenOdd: false,
        paint: { kind: "solid", color: [0.4, 0.65, 0.8, 0.55] },
      },
    ],
    { flags: FLAG.blend, blend: BLEND["linear-burn"] },
  );

  // Row 3 (straddling x=512): Disjoint-child blended frame moved by transform patch.
  const disjointFrameId = 900;
  const disjoint = rect(ROOT, 462 + shiftX, 158, 100, 36, [{ op: "children" }], {
    id: disjointFrameId,
    flags: FLAG.blend,
    blend: BLEND["linear-burn"],
  });
  rect(disjoint, 2, 4, 42, 28, [
    { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [0.6, 0.3, 0.2, 0.7] } },
  ]);
  rect(disjoint, 54, 4, 42, 28, [
    { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [0.2, 0.5, 0.8, 0.85] } },
  ]);

  // Row 4 (y=200..248): Blended stroke, zero-blur drop/inner shadows, and an opaque normal
  // occluder over a HW-blended rect (verifies painter's-order depth testing).
  rect(
    ROOT,
    394,
    202,
    48,
    40,
    [
      {
        op: "stroke",
        path: 0,
        style: { width: 6, join: JOIN.round, cap: CAP.round, miter: 4, dashes: [], dashOffset: 0 },
        paint: { kind: "solid", color: [0.8, 0.4, 0.2, 0.75], blend: BLEND["linear-dodge"] },
      },
    ],
    { reach: 8 },
  );
  rect(
    ROOT,
    464,
    202,
    56,
    36,
    [
      {
        op: "dropShadow",
        paths: [0],
        evenOdd: false,
        dx: 4,
        dy: 4,
        blur: 0,
        color: [0, 0, 0, 0.5],
        blend: BLEND["linear-burn"],
      },
      {
        op: "innerShadow",
        shape: 0,
        hole: null,
        evenOdd: false,
        dx: 3,
        dy: 3,
        blur: 0,
        color: [0.9, 0.85, 0.7, 0.5],
        blend: BLEND["linear-dodge"],
      },
    ],
    { reach: 12 },
  );
  rect(ROOT, 548, 200, 76, 44, [
    {
      op: "fill",
      path: 0,
      evenOdd: false,
      paint: { kind: "solid", color: [0.8, 0.2, 0.1, 1], blend: BLEND.multiply },
    },
  ]);
  rect(ROOT, 568, 210, 36, 24, [
    { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [0.1, 0.85, 0.3, 1] } },
  ]);

  return [...list.finish()];
}

function hwBlendBlurredShadowsScene(revision = 20, offsetX = 0): number[] {
  const list = new ListWriter(0xffffffff, revision);
  list.reset();
  let nextId = 1;
  const rect = (
    x: number,
    y: number,
    w: number,
    h: number,
    ops: WireRecord["ops"],
    opts?: { radii?: readonly [number, number, number, number]; reach?: number },
  ) => {
    const id = nextId++;
    list.set(id, ROOT, {
      flags: 0,
      transform: [1, 0, 0, 1, x + offsetX, y],
      opacity: 1,
      width: w,
      height: h,
      coarseBelow: 0,
      reach: opts?.reach ?? 0,
      unsupported: 0,
      paths: [
        {
          kind: "rect",
          w,
          h,
          radii: opts?.radii ?? [0, 0, 0, 0],
          smoothing: 0,
        },
      ],
      ops,
      coarse: [],
    });
  };
  const stripes: readonly [number, number, readonly [number, number, number, number]][] = [
    [384, 64, [0.2, 0.4, 0.8, 1]],
    [448, 64, [0.95, 128 / 255, 10 / 255, 1]],
    [512, 64, [127 / 255, 64 / 255, 200 / 255, 1]],
    [576, 64, [1, 0.5, 0, 1]],
  ];
  for (const [x, w, color] of stripes) {
    rect(x, 64, w, 192, [{ op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } }]);
  }
  // Rounded-rect zero-blur linear-dodge inner shadow (exercises AA corner coverage).
  rect(
    396,
    80,
    56,
    36,
    [
      {
        op: "innerShadow",
        shape: 0,
        hole: null,
        evenOdd: false,
        dx: 3,
        dy: 3,
        blur: 0,
        color: [0.9, 0.85, 0.7, 0.5],
        blend: BLEND["linear-dodge"],
      },
    ],
    { radii: [10, 10, 10, 10], reach: 12 },
  );
  // Blurred linear-burn drop shadow straddling the x=512 tile seam.
  rect(
    484,
    80,
    56,
    36,
    [
      {
        op: "dropShadow",
        paths: [0],
        evenOdd: false,
        dx: 0,
        dy: 6,
        blur: 6,
        color: [0, 0, 0, 0.45],
        blend: BLEND["linear-burn"],
      },
    ],
    { radii: [10, 10, 10, 10], reach: 24 },
  );
  // Blurred linear-burn inner shadow.
  rect(
    396,
    152,
    60,
    40,
    [
      {
        op: "innerShadow",
        shape: 0,
        hole: null,
        evenOdd: false,
        dx: -2,
        dy: -2,
        blur: 5,
        color: [0, 0, 0, 0.4],
        blend: BLEND["linear-burn"],
      },
    ],
    { radii: [10, 10, 10, 10], reach: 16 },
  );
  // Blurred linear-dodge inner shadow.
  rect(
    480,
    152,
    60,
    40,
    [
      {
        op: "innerShadow",
        shape: 0,
        hole: null,
        evenOdd: false,
        dx: 2,
        dy: 2,
        blur: 4,
        color: [0.9, 0.85, 0.7, 0.5],
        blend: BLEND["linear-dodge"],
      },
    ],
    { radii: [10, 10, 10, 10], reach: 16 },
  );
  // Pixel-aligned solid linear-dodge and linear-burn fills (exact 0-byte match against CPU and
  // offscreen across all drivers).
  rect(556, 80, 20, 24, [
    {
      op: "fill",
      path: 0,
      evenOdd: false,
      paint: { kind: "solid", color: [0.4, 0.6, 0.3, 0.7], blend: BLEND["linear-dodge"] },
    },
  ]);
  rect(584, 80, 24, 24, [
    {
      op: "fill",
      path: 0,
      evenOdd: false,
      paint: { kind: "solid", color: [0.6, 0.4, 0.2, 0.7], blend: BLEND["linear-burn"] },
    },
  ]);
  // Boundary multiply case: s8=230 * b8=127 / 255 = 114.549 -> 115 on CPU; GPU fixed-function
  // and offscreen rounding can differ by 1 level depending on driver (e.g. Chrome vs Firefox GL).
  rect(556, 152, 56, 40, [
    {
      op: "fill",
      path: 0,
      evenOdd: false,
      paint: { kind: "solid", color: [0.9, 0.2, 0.1, 1], blend: BLEND.multiply },
    },
  ]);
  return [...list.finish()];
}

function hwBlendGlyphScene(
  blend: number,
  kind: "uniform" | "mixed",
  revision: number,
  offsetX = 0,
): number[] {
  const list = new ListWriter(0xffffffff, revision);
  list.reset();
  // Curved arch glyph (24x28) so quantized 1/8-px masks and unquantized outlines differ clearly
  // if a run ever splits mask-vs-outline across a tile seam.
  const smallGlyph = new PathData()
    .moveTo(2, 0)
    .lineTo(22, 0)
    .quadTo(24, 14, 18, 28)
    .lineTo(6, 28)
    .quadTo(0, 14, 2, 0)
    .close();
  // Oversize glyph (> 160 px glyph_mask_side) that must be outlined.
  const tallGlyph = new PathData()
    .moveTo(2, 0)
    .lineTo(22, 0)
    .quadTo(24, 102, 18, 204)
    .lineTo(6, 204)
    .quadTo(0, 102, 2, 0)
    .close();
  list.glyph(1, smallGlyph);
  list.glyph(2, tallGlyph);

  // Opaque varied backdrop straddling x=512 (shifted by offsetX).
  const stripes: readonly [number, number, readonly [number, number, number, number]][] = [
    [384, 128, [0.22, 0.48, 0.78, 1]],
    [512, 128, [0.86, 0.54, 0.28, 1]],
  ];
  let id = 1;
  for (const [x, w, color] of stripes) {
    list.set(id++, ROOT, {
      flags: 0,
      transform: [1, 0, 0, 1, x + offsetX, 32],
      opacity: 1,
      width: w,
      height: 280,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w, h: 280, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops: [{ op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } }],
      coarse: [],
    });
  }

  // Non-overlapping glyph run straddling x=512 at fractional coordinates.
  // In "mixed" mode, glyph 1 straddles x=512 while oversize glyph 2 sits strictly in tile x>=512.
  const glyphs =
    kind === "mixed" ? [1, 500.3, 270.4, 2, 560.3, 270.4] : [1, 500.3, 180.4, 1, 540.3, 180.4];
  list.set(id++, ROOT, {
    flags: 0,
    transform: [1, 0, 0, 1, offsetX, 0],
    opacity: 1,
    width: 640,
    height: 312,
    coarseBelow: 0,
    reach: 0,
    unsupported: 0,
    paths: [{ kind: "glyphs", scale: 1, glyphs }],
    ops: [
      {
        op: "fill",
        path: 0,
        evenOdd: false,
        paint: { kind: "solid", color: [0.35, 0.65, 0.45, 0.8], blend },
      },
    ],
    coarse: [],
  });
  return [...list.finish()];
}

function hwBlendDualPlaneScene(includeBlends = true, revision = 1, offsetX = 0): number[] {
  const list = new ListWriter(0xffffffff, revision);
  list.reset();
  let nextId = 1;
  const setRect = (
    parent: number,
    x: number,
    y: number,
    w: number,
    h: number,
    ops: WireRecord["ops"],
    radii: readonly [number, number, number, number] = [0, 0, 0, 0],
  ) => {
    const id = nextId++;
    const tx = parent === ROOT ? x + offsetX : x;
    list.set(id, parent, {
      flags: 0,
      transform: [1, 0, 0, 1, tx, y],
      opacity: 1,
      width: w,
      height: h,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w, h, radii, smoothing: 0 }],
      ops,
      coarse: [],
    });
    return id;
  };
  const glassOp = (): WireRecord["ops"] => [
    {
      op: "glass",
      paths: [0],
      evenOdd: false,
      kind: 0,
      inradius: 36,
      angle: -45,
      intensity: 60,
      refraction: 50,
      depth: 14,
      dispersion: 20,
      frost: 4,
      splay: 0,
      boxRadii: [14, 14, 14, 14],
      boxSmoothing: [0, 0, 0, 0],
    },
  ];
  // Opaque striped backdrop.
  setRect(ROOT, 0, 0, 160, 256, [
    { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [0.22, 0.44, 0.82, 1] } },
  ]);
  setRect(ROOT, 160, 0, 160, 256, [
    { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [0.88, 0.56, 0.24, 1] } },
  ]);
  // Lens 1 enables dual-plane tracking (main + backdrop) on the tile.
  setRect(ROOT, 12, 16, 100, 80, glassOp(), [14, 14, 14, 14]);
  if (includeBlends) {
    // 4 HW-blended rects drawn while dual-plane is active, positioned under Lens 2.
    const modes = [
      BLEND.multiply,
      BLEND.screen,
      BLEND["linear-dodge"],
      BLEND["linear-burn"],
    ] as const;
    for (const [i, blend] of modes.entries()) {
      setRect(ROOT, 120 + (i % 2) * 86, 20 + Math.floor(i / 2) * 96, 80, 88, [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: {
            kind: "solid",
            color: [0.35 + i * 0.15, 0.8 - i * 0.15, 0.45, 0.7],
            blend,
          },
        },
      ]);
    }
  }
  // Lens 2 samples the backdrop written by the dual-plane replay of the 4 HW-blended rects.
  setRect(ROOT, 136, 44, 148, 168, glassOp(), [14, 14, 14, 14]);
  return [...list.finish()];
}

function hwBlendFallbackScenes(
  offsetX = 0,
  baseRev = 1,
  step = 1,
): Record<
  "overlappingSiblings" | "partialLayerOpacity" | "nonHwMode" | "nonOpaqueTarget",
  { list: number[]; size: [number, number]; bg: [number, number, number, number] }
> {
  let nextRev = baseRev;
  const make = (
    buildList: (w: ListWriter) => void,
    size: [number, number],
    bg: [number, number, number, number],
  ) => {
    const w = new ListWriter(0xffffffff, nextRev);
    nextRev += step;
    w.reset();
    buildList(w);
    return { list: [...w.finish()], size, bg };
  };
  const rect = (
    w: ListWriter,
    id: number,
    parent: number,
    x: number,
    y: number,
    width: number,
    height: number,
    ops: WireRecord["ops"],
    opts?: { flags?: number; blend?: number; opacity?: number },
  ) => {
    const tx = parent === ROOT ? x + offsetX : x;
    w.set(id, parent, {
      flags: opts?.flags ?? 0,
      transform: [1, 0, 0, 1, tx, y],
      opacity: opts?.opacity ?? 1,
      width,
      height,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w: width, h: height, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops,
      coarse: [],
      ...(opts?.blend !== undefined ? { blend: opts.blend } : {}),
    });
  };
  return {
    overlappingSiblings: make(
      (w) => {
        rect(w, 1, ROOT, 0, 0, 640, 256, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.7, 0.55, 0.4, 1] },
          },
        ]);
        // Overlapping siblings straddling the x=512 tile seam under linear-burn.
        rect(w, 2, ROOT, 460, 40, 120, 160, [{ op: "children" }], {
          flags: FLAG.blend,
          blend: BLEND["linear-burn"],
        });
        rect(w, 3, 2, 0, 0, 80, 120, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.8, 0.2, 0.3, 0.6] },
          },
        ]);
        rect(w, 4, 2, 30, 30, 80, 120, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.2, 0.4, 0.9, 0.6] },
          },
        ]);
      },
      [640, 256],
      [0.2, 0.3, 0.4, 1],
    ),
    partialLayerOpacity: make(
      (w) => {
        rect(w, 1, ROOT, 0, 0, 160, 160, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.6, 0.7, 0.8, 1] },
          },
        ]);
        rect(
          w,
          2,
          ROOT,
          20,
          20,
          120,
          120,
          [
            {
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: { kind: "solid", color: [0.9, 0.3, 0.2, 0.8] },
            },
          ],
          { flags: FLAG.blend, blend: BLEND.multiply, opacity: 0.5 },
        );
      },
      [160, 160],
      [0.1, 0.2, 0.3, 1],
    ),
    nonHwMode: make(
      (w) => {
        rect(w, 1, ROOT, 0, 0, 160, 160, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.3, 0.6, 0.9, 1] },
          },
        ]);
        rect(w, 2, ROOT, 20, 20, 120, 120, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.85, 0.4, 0.15, 0.7], blend: BLEND.luminosity },
          },
        ]);
      },
      [160, 160],
      [0.1, 0.2, 0.3, 1],
    ),
    nonOpaqueTarget: make(
      (w) => {
        rect(w, 1, ROOT, 10, 10, 140, 140, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.4, 0.6, 0.8, 0.6] },
          },
        ]);
        const modes = [
          BLEND.multiply,
          BLEND.screen,
          BLEND["linear-dodge"],
          BLEND["linear-burn"],
        ] as const;
        for (const [i, blend] of modes.entries()) {
          rect(w, 2 + i, ROOT, 20 + (i % 2) * 56, 20 + Math.floor(i / 2) * 56, 48, 48, [
            {
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: { kind: "solid", color: [0.8, 0.3, 0.5, 0.7], blend },
            },
          ]);
        }
      },
      [160, 160],
      [0.2, 0.4, 0.6, 0.5],
    ),
  };
}

for (const build of ["browser", "webgl"] as const) {
  test.describe(`fixed-function hardware blending (${build})`, () => {
    test("matches offscreen isolation across all 4 modes, clips, strokes, zero-blur shadows, tile shifts and patches", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openEngine(page, build);
      const tileShiftPx = 128;
      const patch = new ListWriter(10, 11);
      patch.transform(900, [1, 0, 0, 1, 482, 158]);
      const result = await page.evaluate(
        async ({
          warmups,
          initial,
          shifted,
          tileShiftPx,
          patchBytes,
          fresh,
          expectedBackend,
          scopeClipIdx,
          scopesIdx,
        }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const check = (out: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = out;
            out.free();
            if (!ok) throw new Error(message);
          };
          const diffStats = (a: Uint8Array, b: Uint8Array) => {
            let bytes = Math.abs(a.length - b.length);
            let maxDelta = 0;
            let firstDiff: { px: number; a: number[]; b: number[] } | null = null;
            const n = Math.min(a.length, b.length);
            for (let i = 0; i < n; i++) {
              const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
              if (d !== 0) {
                bytes++;
                if (d > maxDelta) maxDelta = d;
                if (!firstDiff) {
                  const p = Math.floor(i / 4) * 4;
                  firstDiff = {
                    px: p / 4,
                    a: [a[p] ?? 0, a[p + 1] ?? 0, a[p + 2] ?? 0, a[p + 3] ?? 0],
                    b: [b[p] ?? 0, b[p + 1] ?? 0, b[p + 2] ?? 0, b[p + 3] ?? 0],
                  };
                }
              }
            }
            return { bytes, maxDelta, firstDiff };
          };
          const diffRect = (
            a: Uint8Array,
            b: Uint8Array,
            width: number,
            x0: number,
            y0: number,
            x1: number,
            y1: number,
          ) => {
            let bytes = 0;
            for (let y = y0; y < y1; y++) {
              for (let x = x0; x < x1; x++) {
                const off = (y * width + x) * 4;
                for (let c = 0; c < 4; c++) {
                  if (a[off + c] !== b[off + c]) bytes++;
                }
              }
            }
            return bytes;
          };
          const open = async () => {
            let device = await glue.createGpu(null, 0);
            for (let attempt = 0; attempt < 3 && !device.ok; attempt++) {
              device.free();
              await new Promise((r) => setTimeout(r, 300));
              device = await glue.createGpu(null, 0);
            }
            if (!device.ok || device.backend !== expectedBackend)
              throw new Error(device.message || `expected ${expectedBackend}`);
            const engine = new glue.Engine(0, 0);
            try {
              if (
                !engine.attachGpu ||
                !engine.renderGpu ||
                !engine.gpuPixels ||
                !engine.gpuCounters ||
                !engine.setGpuHwBlend
              )
                throw new Error("missing GPU entry points");
              check(engine.attachGpu(device));
              // Warm each HW-blend pipeline separately so SwiftShader JIT does not pile four
              // first-time shader compiles into a single 12 s readback window.
              const warmBg = new Float32Array([0.5, 0.5, 0.5, 1]);
              for (const list of warmups) {
                check(engine.apply(new Uint8Array(list)));
                check(engine.renderGpu(16, 16, 1, 0, 0, 1, warmBg, false, 0, true));
                const px = await engine.gpuPixels();
                if (!(px instanceof Uint8Array)) throw new Error(px.message);
              }
              engine.clearTiles?.();
              return { engine, device };
            } catch (err) {
              engine.free();
              device.free();
              throw err;
            }
          };
          const draw = async (
            engine: InstanceType<typeof glue.Engine>,
            list: number[] | null,
            hwBlend: boolean,
            camX = -384,
            clearTiles = true,
          ) => {
            if (!engine.renderGpu || !engine.gpuPixels || !engine.gpuCounters)
              throw new Error("missing GPU entry points");
            engine.setGpuHwBlend?.(hwBlend);
            if (clearTiles) engine.clearTiles?.();
            if (list) check(engine.apply(new Uint8Array(list)));
            const before = engine.gpuCounters();
            const bg = new Float32Array([0.15, 0.25, 0.35, 1]);
            check(engine.renderGpu(256, 192, 1, camX, -64, 1, bg, false, 0, true));
            const pixels = await engine.gpuPixels();
            if (!(pixels instanceof Uint8Array)) throw new Error(pixels.message);
            const after = engine.gpuCounters();
            return {
              pixels: new Uint8Array(pixels),
              scopes: (after[scopesIdx] ?? 0) - (before[scopesIdx] ?? 0),
              scopeClip: (after[scopeClipIdx] ?? 0) - (before[scopeClipIdx] ?? 0),
            };
          };

          const primary = await open();
          let hwTiled: Awaited<ReturnType<typeof draw>>;
          let offscreenTiled: Awaited<ReturnType<typeof draw>>;
          let hwPatched: Awaited<ReturnType<typeof draw>>;
          let hwShifted: Awaited<ReturnType<typeof draw>>;
          try {
            hwTiled = await draw(primary.engine, initial, true, -384);
            offscreenTiled = await draw(primary.engine, null, false, -384);
            // Warm tiled state at revision 10, then apply the transform patch (revision 11).
            await draw(primary.engine, null, true, -384);
            hwPatched = await draw(primary.engine, patchBytes, true, -384, false);
            // Real tile-shift check: shift content +128 px in page space and camera -128 px so
            // every shape lands at a different offset relative to the 512 px tile grid.
            hwShifted = await draw(primary.engine, shifted, true, -384 - tileShiftPx);
          } finally {
            primary.engine.free();
            primary.device.free();
          }
          const secondary = await open();
          let hwFresh: Awaited<ReturnType<typeof draw>>;
          try {
            hwFresh = await draw(secondary.engine, fresh, true, -384);
          } finally {
            secondary.engine.free();
            secondary.device.free();
          }
          // Row 1 pixel-aligned solid rects for linear-dodge (page x=508..564, y=68..106) and
          // linear-burn (page x=566..622, y=68..106) in viewport-local coordinates (-384, -64).
          const linearDodgeSolidDiff = diffRect(
            hwTiled.pixels,
            offscreenTiled.pixels,
            256,
            124,
            4,
            180,
            42,
          );
          const linearBurnSolidDiff = diffRect(
            hwTiled.pixels,
            offscreenTiled.pixels,
            256,
            182,
            4,
            238,
            42,
          );
          return {
            hwTiled: { scopes: hwTiled.scopes, scopeClip: hwTiled.scopeClip },
            offscreenTiled: { scopes: offscreenTiled.scopes, scopeClip: offscreenTiled.scopeClip },
            hwVsOffscreen: diffStats(hwTiled.pixels, offscreenTiled.pixels),
            linearDodgeSolidDiff,
            linearBurnSolidDiff,
            tileShift: diffStats(hwTiled.pixels, hwShifted.pixels),
            patchedVsFresh: diffStats(hwPatched.pixels, hwFresh.pixels),
          };
        },
        {
          warmups: hwBlendWarmupLists(),
          initial: hwBlendShowcaseScene(0xffffffff, 10, 0, 0),
          shifted: hwBlendShowcaseScene(0xffffffff, 12, 0, tileShiftPx),
          tileShiftPx,
          patchBytes: [...patch.finish()],
          fresh: hwBlendShowcaseScene(0xffffffff, 11, 20, 0),
          expectedBackend: build === "webgl" ? "webgl2" : "webgpu",
          scopeClipIdx: SCOPE_CLIP_COUNTER,
          scopesIdx: SCOPES_COUNTER,
        },
      );

      expect(result.hwTiled.scopes).toBe(0);
      expect(result.hwTiled.scopeClip).toBe(0);
      expect(result.offscreenTiled.scopes).toBeGreaterThan(0);
      expect(result.offscreenTiled.scopeClip).toBeGreaterThan(0);
      // Pixel-aligned solid linear-dodge and linear-burn match offscreen with 0 differing bytes
      // across every driver; AA edges and multiply/screen stay within 2 levels.
      expect(result.linearDodgeSolidDiff).toBe(0);
      expect(result.linearBurnSolidDiff).toBe(0);
      expect(
        result.hwVsOffscreen.maxDelta,
        JSON.stringify(result.hwVsOffscreen),
      ).toBeLessThanOrEqual(2);
      expect(result.tileShift.bytes, JSON.stringify(result.tileShift)).toBe(0);
      expect(result.patchedVsFresh.bytes, JSON.stringify(result.patchedVsFresh)).toBe(0);
    });

    test("blurred blended shadows and boundary multiply/linear modes match CPU within driver rounding with zero scopes and tile shift consistency", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openEngine(page, build);
      const tileShiftPx = 128;
      const result = await page.evaluate(
        async ({ warmups, list, shiftedList, tileShiftPx, expectedBackend, scopesIdx }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const check = (out: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = out;
            out.free();
            if (!ok) throw new Error(message);
          };
          let device = await glue.createGpu(null, 0);
          for (let attempt = 0; attempt < 3 && !device.ok; attempt++) {
            device.free();
            await new Promise((r) => setTimeout(r, 300));
            device = await glue.createGpu(null, 0);
          }
          if (!device.ok || device.backend !== expectedBackend)
            throw new Error(device.message || `expected ${expectedBackend}`);
          const engine = new glue.Engine(0, 0);
          try {
            if (
              !engine.attachGpu ||
              !engine.renderGpu ||
              !engine.gpuPixels ||
              !engine.gpuCounters ||
              !engine.setGpuHwBlend
            )
              throw new Error("missing GPU entry points");
            check(engine.attachGpu(device));
            const warmBg = new Float32Array([0.5, 0.5, 0.5, 1]);
            for (const warmup of warmups) {
              check(engine.apply(new Uint8Array(warmup)));
              check(engine.renderGpu(16, 16, 1, 0, 0, 1, warmBg, false, 0, true));
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
            }
            const bg = new Float32Array([0.15, 0.25, 0.35, 1]);
            const drawGpu = async (srcList: number[] | null, hwBlend: boolean, camX: number) => {
              if (!engine.renderGpu || !engine.gpuPixels || !engine.gpuCounters)
                throw new Error("missing GPU entry points");
              engine.setGpuHwBlend?.(hwBlend);
              engine.clearTiles?.();
              if (srcList) check(engine.apply(new Uint8Array(srcList)));
              const before = engine.gpuCounters()[scopesIdx] ?? 0;
              check(engine.renderGpu(256, 192, 1, camX, -64, 1, bg, false, 0, true));
              const pixels = await engine.gpuPixels();
              if (!(pixels instanceof Uint8Array)) throw new Error(pixels.message);
              const after = engine.gpuCounters()[scopesIdx] ?? 0;
              return { pixels: new Uint8Array(pixels), scopes: after - before };
            };
            const hwTiled = await drawGpu(list, true, -384);
            const offscreenTiled = await drawGpu(null, false, -384);
            check(engine.renderCpu(256, 192, 1, -384, -64, 1, bg, true));
            const cpuPixels = new Uint8Array(engine.pixels());
            const hwShifted = await drawGpu(shiftedList, true, -384 - tileShiftPx);

            let tileShiftDiffBytes = 0;
            let offMaxDelta = 0;
            let offSumDelta = 0;
            for (let i = 0; i < hwTiled.pixels.length; i++) {
              if (hwTiled.pixels[i] !== hwShifted.pixels[i]) tileShiftDiffBytes++;
              const d = Math.abs((hwTiled.pixels[i] ?? 0) - (offscreenTiled.pixels[i] ?? 0));
              if (d > offMaxDelta) offMaxDelta = d;
              offSumDelta += d;
            }
            const pickAt = (buf: Uint8Array, lx: number, ly: number) => {
              const off = (ly * 256 + lx) * 4;
              return [buf[off] ?? 0, buf[off + 1] ?? 0, buf[off + 2] ?? 0, buf[off + 3] ?? 0];
            };
            // Boundary multiply rect: page (564, 160) -> local (180, 96).
            // Pixel-aligned solid linear-dodge: page (564, 92) -> local (180, 28).
            // Pixel-aligned solid linear-burn: page (596, 92) -> local (212, 28).
            return {
              hwScopes: hwTiled.scopes,
              offScopes: offscreenTiled.scopes,
              tileShiftDiffBytes,
              offMaxDelta,
              offMeanDelta: offSumDelta / hwTiled.pixels.length,
              hwMultiplyPixel: pickAt(hwTiled.pixels, 180, 96),
              cpuMultiplyPixel: pickAt(cpuPixels, 180, 96),
              hwLinearDodgePixel: pickAt(hwTiled.pixels, 180, 28),
              offLinearDodgePixel: pickAt(offscreenTiled.pixels, 180, 28),
              cpuLinearDodgePixel: pickAt(cpuPixels, 180, 28),
              hwLinearBurnPixel: pickAt(hwTiled.pixels, 212, 28),
              offLinearBurnPixel: pickAt(offscreenTiled.pixels, 212, 28),
              cpuLinearBurnPixel: pickAt(cpuPixels, 212, 28),
            };
          } finally {
            engine.free();
            device.free();
          }
        },
        {
          warmups: hwBlendWarmupLists(),
          list: hwBlendBlurredShadowsScene(20, 0),
          shiftedList: hwBlendBlurredShadowsScene(21, tileShiftPx),
          tileShiftPx,
          expectedBackend: build === "webgl" ? "webgl2" : "webgpu",
          scopesIdx: SCOPES_COUNTER,
        },
      );

      expect(result.hwScopes).toBe(0);
      expect(result.offScopes).toBeGreaterThanOrEqual(7);
      expect(result.tileShiftDiffBytes).toBe(0);
      expect(result.cpuMultiplyPixel).toEqual([115, 13, 20, 255]);
      // Multiply/screen rounding against CPU is driver-dependent (Chrome/WebKit HW matches CPU;
      // Firefox NVIDIA GL rounds off by 1 level); require within 1 level per channel.
      for (let c = 0; c < 4; c++) {
        expect(
          Math.abs((result.hwMultiplyPixel[c] ?? 0) - (result.cpuMultiplyPixel[c] ?? 0)),
          `multiply channel ${c}: hw=${result.hwMultiplyPixel} cpu=${result.cpuMultiplyPixel}`,
        ).toBeLessThanOrEqual(1);
      }
      // Quantized linear-dodge and linear-burn solid fills match both CPU and offscreen exactly.
      expect(result.hwLinearDodgePixel).toEqual(result.cpuLinearDodgePixel);
      expect(result.hwLinearDodgePixel).toEqual(result.offLinearDodgePixel);
      expect(result.hwLinearBurnPixel).toEqual(result.cpuLinearBurnPixel);
      expect(result.hwLinearBurnPixel).toEqual(result.offLinearBurnPixel);
      expect(result.offMaxDelta).toBeLessThanOrEqual(1);
      expect(result.offMeanDelta).toBeLessThan(0.01);
    });

    test("blended glyph runs keep zero tile-edge seam across uniform maskable and mixed outline runs", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openEngine(page, build);
      const tileShiftPx = 128;
      const modes = [
        { name: "multiply", blend: BLEND.multiply },
        { name: "screen", blend: BLEND.screen },
        { name: "linear-dodge", blend: BLEND["linear-dodge"] },
        { name: "linear-burn", blend: BLEND["linear-burn"] },
      ] as const;
      let rev = 30;
      const cases = modes.flatMap((m) =>
        (["uniform", "mixed"] as const).map((kind) => ({
          label: `${m.name}/${kind}`,
          kind,
          base: hwBlendGlyphScene(m.blend, kind, rev++, 0),
          shifted: hwBlendGlyphScene(m.blend, kind, rev++, tileShiftPx),
        })),
      );
      const result = await page.evaluate(
        async ({ warmups, cases, tileShiftPx, expectedBackend, scopesIdx }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const check = (out: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = out;
            out.free();
            if (!ok) throw new Error(message);
          };
          let device = await glue.createGpu(null, 0);
          for (let attempt = 0; attempt < 3 && !device.ok; attempt++) {
            device.free();
            await new Promise((r) => setTimeout(r, 300));
            device = await glue.createGpu(null, 0);
          }
          if (!device.ok || device.backend !== expectedBackend)
            throw new Error(device.message || `expected ${expectedBackend}`);
          const engine = new glue.Engine(0, 0);
          try {
            if (
              !engine.attachGpu ||
              !engine.renderGpu ||
              !engine.gpuPixels ||
              !engine.gpuCounters ||
              !engine.setGpuHwBlend
            )
              throw new Error("missing GPU entry points");
            check(engine.attachGpu(device));
            const warmBg = new Float32Array([0.5, 0.5, 0.5, 1]);
            for (const warmup of warmups) {
              check(engine.apply(new Uint8Array(warmup)));
              check(engine.renderGpu(16, 16, 1, 0, 0, 1, warmBg, false, 0, true));
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
            }
            const bg = new Float32Array([0.15, 0.25, 0.35, 1]);
            const drawAt = async (list: number[], camX: number) => {
              if (!engine.renderGpu || !engine.gpuPixels || !engine.gpuCounters)
                throw new Error("missing GPU entry points");
              engine.setGpuHwBlend?.(true);
              engine.clearTiles?.();
              check(engine.apply(new Uint8Array(list)));
              const before = engine.gpuCounters()[scopesIdx] ?? 0;
              const out = engine.renderGpu(256, 280, 1, camX, -32, 1, bg, false, 0, true);
              const glyphsMasked = out.glyphs_masked;
              const glyphsOutlined = out.glyphs_outlined;
              check(out);
              const pixels = await engine.gpuPixels();
              if (!(pixels instanceof Uint8Array)) throw new Error(pixels.message);
              const after = engine.gpuCounters()[scopesIdx] ?? 0;
              return {
                pixels: new Uint8Array(pixels),
                scopes: after - before,
                glyphsMasked,
                glyphsOutlined,
              };
            };
            const report: Record<
              string,
              {
                kind: "uniform" | "mixed";
                scopes: number;
                glyphsMasked: number;
                glyphsOutlined: number;
                tileShiftDiffBytes: number;
                tileShiftMaxDelta: number;
              }
            > = {};
            for (const entry of cases) {
              const a = await drawAt(entry.base, -384);
              const b = await drawAt(entry.shifted, -384 - tileShiftPx);
              let diffBytes = 0;
              let maxDelta = 0;
              for (let i = 0; i < a.pixels.length; i++) {
                const d = Math.abs((a.pixels[i] ?? 0) - (b.pixels[i] ?? 0));
                if (d !== 0) {
                  diffBytes++;
                  if (d > maxDelta) maxDelta = d;
                }
              }
              report[entry.label] = {
                kind: entry.kind,
                scopes: a.scopes,
                glyphsMasked: a.glyphsMasked,
                glyphsOutlined: a.glyphsOutlined,
                tileShiftDiffBytes: diffBytes,
                tileShiftMaxDelta: maxDelta,
              };
            }
            return report;
          } finally {
            engine.free();
            device.free();
          }
        },
        {
          warmups: hwBlendWarmupLists(),
          cases,
          tileShiftPx,
          expectedBackend: build === "webgl" ? "webgl2" : "webgpu",
          scopesIdx: SCOPES_COUNTER,
        },
      );

      for (const [label, entry] of Object.entries(result)) {
        const info = `${label}: ${JSON.stringify(entry)}`;
        expect(entry.scopes, info).toBe(0);
        expect(entry.tileShiftDiffBytes, info).toBe(0);
        if (entry.kind === "uniform") {
          expect(entry.glyphsMasked, info).toBeGreaterThan(0);
          expect(entry.glyphsOutlined, info).toBe(0);
        } else {
          // Left exact tile outlines glyph 1 (1) + right exact tile outlines glyph 1 & glyph 2 (2)
          // = 3 outlined instances at 1x scale (a coarse zoom-out ladder tile may still mask when
          // the scaled tall glyph fits within glyph_mask_side).
          expect(entry.glyphsOutlined, info).toBe(3);
        }
      }
    });

    test("dual-plane tiles replay hardware-blended strips onto main and backdrop identically", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openEngine(page, build);
      const tileShiftPx = 128;
      const result = await page.evaluate(
        async ({
          warmups,
          withBlends,
          withBlendsShifted,
          withoutBlends,
          tileShiftPx,
          expectedBackend,
          scopesIdx,
        }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const check = (out: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = out;
            out.free();
            if (!ok) throw new Error(message);
          };
          let device = await glue.createGpu(null, 0);
          for (let attempt = 0; attempt < 3 && !device.ok; attempt++) {
            device.free();
            await new Promise((r) => setTimeout(r, 300));
            device = await glue.createGpu(null, 0);
          }
          if (!device.ok || device.backend !== expectedBackend)
            throw new Error(device.message || `expected ${expectedBackend}`);
          const engine = new glue.Engine(0, 0);
          try {
            if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels || !engine.gpuCounters)
              throw new Error("missing GPU entry points");
            check(engine.attachGpu(device));
            const warmBg = new Float32Array([0.5, 0.5, 0.5, 1]);
            for (const list of warmups) {
              check(engine.apply(new Uint8Array(list)));
              check(engine.renderGpu(16, 16, 1, 0, 0, 1, warmBg, false, 0, true));
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
            }
            const render = async (list: number[] | null, hwBlend: boolean, camX = 0) => {
              if (!engine.renderGpu || !engine.gpuPixels || !engine.gpuCounters)
                throw new Error("missing GPU entry points");
              engine.setGpuHwBlend?.(hwBlend);
              engine.clearTiles?.();
              if (list) check(engine.apply(new Uint8Array(list)));
              const before = engine.gpuCounters()[scopesIdx] ?? 0;
              const bg = new Float32Array([0.18, 0.36, 0.72, 1]);
              check(engine.renderGpu(320, 256, 1, camX, 0, 1, bg, false, 0, true));
              const pixels = await engine.gpuPixels();
              if (!(pixels instanceof Uint8Array)) throw new Error(pixels.message);
              const after = engine.gpuCounters()[scopesIdx] ?? 0;
              return { pixels: new Uint8Array(pixels), scopes: after - before };
            };
            const hw = await render(withBlends, true, 0);
            const off = await render(null, false, 0);
            const hwShifted = await render(withBlendsShifted, true, -tileShiftPx);
            const base = await render(withoutBlends, true, 0);
            let diffMaxDelta = 0;
            let tileShiftBytes = 0;
            let lensChangedBytes = 0;
            for (let i = 0; i < hw.pixels.length; i++) {
              const d = Math.abs((hw.pixels[i] ?? 0) - (off.pixels[i] ?? 0));
              if (d > diffMaxDelta) diffMaxDelta = d;
              if (hw.pixels[i] !== hwShifted.pixels[i]) tileShiftBytes++;
              if (hw.pixels[i] !== base.pixels[i]) lensChangedBytes++;
            }
            return {
              hwScopes: hw.scopes,
              offScopes: off.scopes,
              diffMaxDelta,
              tileShiftBytes,
              lensChangedBytes,
            };
          } finally {
            engine.free();
            device.free();
          }
        },
        {
          warmups: hwBlendWarmupLists(),
          withBlends: hwBlendDualPlaneScene(true, 10, 0),
          withBlendsShifted: hwBlendDualPlaneScene(true, 11, tileShiftPx),
          withoutBlends: hwBlendDualPlaneScene(false, 12, 0),
          tileShiftPx,
          expectedBackend: build === "webgl" ? "webgl2" : "webgpu",
          scopesIdx: SCOPES_COUNTER,
        },
      );

      expect(result.hwScopes).toBe(0);
      expect(result.offScopes).toBeGreaterThanOrEqual(4);
      expect(result.diffMaxDelta).toBeLessThanOrEqual(1);
      expect(result.tileShiftBytes).toBe(0);
      expect(result.lensChangedBytes).toBeGreaterThan(0);
    });

    test("overlapping siblings, partial layer opacity, non-HW modes and translucent targets fall back cleanly", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openEngine(page, build);
      const tileShiftPx = 128;
      const scenes = hwBlendFallbackScenes(0, 1, 2);
      const shiftedScenes = hwBlendFallbackScenes(tileShiftPx, 2, 2);
      const result = await page.evaluate(
        async ({ scenes, shiftedScenes, tileShiftPx, expectedBackend, scopesIdx }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const check = (out: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = out;
            out.free();
            if (!ok) throw new Error(message);
          };
          let device = await glue.createGpu(null, 0);
          for (let attempt = 0; attempt < 3 && !device.ok; attempt++) {
            device.free();
            await new Promise((r) => setTimeout(r, 300));
            device = await glue.createGpu(null, 0);
          }
          if (!device.ok || device.backend !== expectedBackend)
            throw new Error(device.message || `expected ${expectedBackend}`);
          const engine = new glue.Engine(0, 0);
          try {
            if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels || !engine.gpuCounters)
              throw new Error("missing GPU entry points");
            check(engine.attachGpu(device));
            const run = async (
              list: number[] | null,
              size: [number, number],
              bg: [number, number, number, number],
              hwBlend: boolean,
              camX: number,
            ) => {
              if (!engine.renderGpu || !engine.gpuPixels || !engine.gpuCounters)
                throw new Error("missing GPU entry points");
              engine.setGpuHwBlend?.(hwBlend);
              engine.clearTiles?.();
              if (list) check(engine.apply(new Uint8Array(list)));
              const before = engine.gpuCounters()[scopesIdx] ?? 0;
              check(
                engine.renderGpu(
                  size[0],
                  size[1],
                  1,
                  camX,
                  0,
                  1,
                  new Float32Array(bg),
                  false,
                  0,
                  true,
                ),
              );
              const pixels = await engine.gpuPixels();
              if (!(pixels instanceof Uint8Array)) throw new Error(pixels.message);
              const after = engine.gpuCounters()[scopesIdx] ?? 0;
              return { pixels: new Uint8Array(pixels), scopes: after - before };
            };
            const out: Record<
              string,
              { hwScopes: number; offScopes: number; diffBytes: number; tileShiftBytes: number }
            > = {};
            for (const key of Object.keys(scenes) as Array<keyof typeof scenes>) {
              const scene = scenes[key];
              const shifted = shiftedScenes[key];
              const hw = await run(scene.list, scene.size, scene.bg, true, 0);
              const off = await run(null, scene.size, scene.bg, false, 0);
              const hwShifted = await run(
                shifted.list,
                shifted.size,
                shifted.bg,
                true,
                -tileShiftPx,
              );
              let diffBytes = 0;
              let tileShiftBytes = 0;
              for (let i = 0; i < hw.pixels.length; i++) {
                if (hw.pixels[i] !== off.pixels[i]) diffBytes++;
                if (hw.pixels[i] !== hwShifted.pixels[i]) tileShiftBytes++;
              }
              out[key] = {
                hwScopes: hw.scopes,
                offScopes: off.scopes,
                diffBytes,
                tileShiftBytes,
              };
            }
            return out;
          } finally {
            engine.free();
            device.free();
          }
        },
        {
          scenes,
          shiftedScenes,
          tileShiftPx,
          expectedBackend: build === "webgl" ? "webgl2" : "webgpu",
          scopesIdx: SCOPES_COUNTER,
        },
      );

      for (const [key, entry] of Object.entries(result)) {
        expect(entry.hwScopes, key).toBeGreaterThan(0);
        expect(entry.hwScopes, key).toBe(entry.offScopes);
        expect(entry.diffBytes, key).toBe(0);
        expect(entry.tileShiftBytes, key).toBe(0);
      }
    });

    test("idle HW-blend pipeline warmup precompiles without validation errors", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openEngine(page, build);
      const result = await page.evaluate(
        async ({ warmups, expectedBackend }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const check = (out: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = out;
            out.free();
            if (!ok) throw new Error(message);
          };
          let device = await glue.createGpu(null, 0);
          for (let attempt = 0; attempt < 3 && !device.ok; attempt++) {
            device.free();
            await new Promise((r) => setTimeout(r, 300));
            device = await glue.createGpu(null, 0);
          }
          if (!device.ok || device.backend !== expectedBackend)
            throw new Error(device.message || `expected ${expectedBackend}`);
          const engine = new glue.Engine(0, 0);
          try {
            if (
              !engine.attachGpu ||
              !engine.renderGpu ||
              !engine.gpuPixels ||
              !engine.gpuCheck ||
              !engine.warmGpuHwBlendPipeline ||
              !engine.gpuWebgpuHwBlendWarmup
            ) {
              throw new Error("missing GPU warmup entry points");
            }
            check(engine.attachGpu(device));
            const warmupInfo = engine.gpuWebgpuHwBlendWarmup();
            let asyncOk: boolean | null = null;
            if (expectedBackend === "webgpu") {
              if (!Array.isArray(warmupInfo) || warmupInfo.length < 3) {
                throw new Error("expected WebGPU HW-blend warmup tuple");
              }
              const [rawDevice, wgsl, externalTextures] = warmupInfo as [
                {
                  createBindGroupLayout(d: Record<string, unknown>): unknown;
                  createPipelineLayout(d: Record<string, unknown>): unknown;
                  createShaderModule(d: Record<string, unknown>): unknown;
                  createRenderPipelineAsync(d: Record<string, unknown>): Promise<unknown>;
                  pushErrorScope(f: string): void;
                  popErrorScope(): Promise<unknown>;
                },
                string,
                boolean,
              ];
              rawDevice.pushErrorScope("validation");
              const stripBgl = rawDevice.createBindGroupLayout({
                entries: [
                  {
                    binding: 0,
                    visibility: 2,
                    texture: { sampleType: "uint", viewDimension: "2d", multisampled: false },
                  },
                  {
                    binding: 1,
                    visibility: 3,
                    buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 32 },
                  },
                  {
                    binding: 2,
                    visibility: 2,
                    texture: {
                      sampleType: "unfilterable-float",
                      viewDimension: "2d",
                      multisampled: false,
                    },
                  },
                ],
              });
              const extEntries: Record<string, unknown>[] = [
                {
                  binding: 0,
                  visibility: 2,
                  texture: { sampleType: "float", viewDimension: "2d", multisampled: false },
                },
                { binding: 1, visibility: 2, sampler: { type: "filtering" } },
              ];
              if (externalTextures) {
                extEntries.push({ binding: 2, visibility: 2, externalTexture: {} });
              }
              const extBgl = rawDevice.createBindGroupLayout({ entries: extEntries });
              const paintsBgl = rawDevice.createBindGroupLayout({
                entries: [
                  {
                    binding: 0,
                    visibility: 3,
                    texture: { sampleType: "uint", viewDimension: "2d", multisampled: false },
                  },
                ],
              });
              const gradBgl = rawDevice.createBindGroupLayout({
                entries: [
                  {
                    binding: 0,
                    visibility: 2,
                    texture: { sampleType: "float", viewDimension: "2d", multisampled: false },
                  },
                ],
              });
              const layout = rawDevice.createPipelineLayout({
                bindGroupLayouts: [stripBgl, extBgl, paintsBgl, gradBgl],
              });
              const module = rawDevice.createShaderModule({ code: wgsl });
              const vertexBuffers = [
                {
                  arrayStride: 24,
                  stepMode: "instance",
                  attributes: [0, 1, 2, 3, 4, 5].map((loc) => ({
                    format: "uint32",
                    offset: loc * 4,
                    shaderLocation: loc,
                  })),
                },
              ];
              const specs = [
                {
                  entryPoint: "fs_main",
                  color: { srcFactor: "dst", dstFactor: "one-minus-src-alpha", operation: "add" },
                },
                {
                  entryPoint: "fs_main",
                  color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" },
                },
                {
                  entryPoint: "fs_main_linear_dodge",
                  color: { srcFactor: "one", dstFactor: "one", operation: "add" },
                },
                {
                  entryPoint: "fs_main_linear_burn",
                  color: { srcFactor: "one", dstFactor: "one", operation: "reverse-subtract" },
                },
              ];
              const promises = specs.flatMap((spec) =>
                [true, false].map((withDepth) =>
                  rawDevice.createRenderPipelineAsync({
                    layout,
                    vertex: { module, entryPoint: "vs_main", buffers: vertexBuffers },
                    fragment: {
                      module,
                      entryPoint: spec.entryPoint,
                      targets: [
                        {
                          format: "rgba8unorm",
                          blend: {
                            color: spec.color,
                            alpha: {
                              srcFactor: "one",
                              dstFactor: "one-minus-src-alpha",
                              operation: "add",
                            },
                          },
                          writeMask: 0xf,
                        },
                      ],
                    },
                    primitive: { topology: "triangle-strip" },
                    ...(withDepth
                      ? {
                          depthStencil: {
                            format: "depth24plus",
                            depthWriteEnabled: false,
                            depthCompare: "less-equal",
                          },
                        }
                      : {}),
                    multisample: { count: 1 },
                  }),
                ),
              );
              const settled = await Promise.allSettled(promises);
              const err = await rawDevice.popErrorScope();
              asyncOk = err === null && settled.every((s) => s.status === "fulfilled");
            } else {
              asyncOk = warmupInfo === undefined;
            }
            const slotMore: boolean[] = [];
            for (let slot = 0; slot < 8; slot++) {
              slotMore.push(engine.warmGpuHwBlendPipeline(slot));
            }
            // Render all 4 modes using the warmed pipelines and check GPU health.
            const bg = new Float32Array([0.5, 0.5, 0.5, 1]);
            for (const list of warmups) {
              check(engine.apply(new Uint8Array(list)));
              check(engine.renderGpu(16, 16, 1, 0, 0, 1, bg, false, 0, true));
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
            }
            const health = engine.gpuCheck();
            const healthOk = health.ok;
            const healthMsg = health.message;
            health.free();
            return { asyncOk, slotMore, healthOk, healthMsg };
          } finally {
            engine.free();
            device.free();
          }
        },
        {
          warmups: hwBlendWarmupLists(),
          expectedBackend: build === "webgl" ? "webgl2" : "webgpu",
        },
      );

      expect(result.asyncOk).toBe(true);
      expect(result.slotMore).toEqual([true, true, true, true, true, true, true, false]);
      expect(result.healthOk, result.healthMsg).toBe(true);
    });
  });

  test.describe(`clip mask cache and AA-rect scissor (${build})`, () => {
    const clipWarmupLists = (): number[][] => {
      const make = (
        rev: number,
        ops: WireRecord["ops"],
        radii: readonly [number, number, number, number] = [0, 0, 0, 0],
      ): number[] => {
        const w = new ListWriter(0xffffffff, rev);
        w.reset();
        w.set(1, ROOT, {
          flags: 0,
          transform: [1, 0, 0, 1, 0, 0],
          opacity: 1,
          width: 16,
          height: 16,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [{ kind: "rect", w: 16, h: 16, radii, smoothing: 0 }],
          ops,
          coarse: [],
        });
        return [...w.finish()];
      };
      return [
        make(1, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.5, 0.4, 0.3, 0.7], blend: BLEND.luminosity },
          },
        ]),
        make(2, [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius: 6 }]),
        make(3, [
          {
            op: "progressiveBlur",
            paths: [0],
            evenOdd: false,
            startRadius: 2,
            endRadius: 8,
            start: [0, 0],
            end: [0, 1],
          },
        ]),
        make(
          4,
          [
            {
              op: "glass",
              paths: [0],
              evenOdd: false,
              kind: 0,
              inradius: 8,
              angle: -45,
              intensity: 40,
              refraction: 40,
              depth: 8,
              dispersion: 10,
              frost: 2,
              splay: 0,
              boxRadii: [4, 4, 4, 4],
              boxSmoothing: [0, 0, 0, 0],
            },
          ],
          [4, 4, 4, 4],
        ),
      ];
    };

    const clipAaRectScissorScene = (revision: number, offsetX = 0): number[] => {
      const list = new ListWriter(0xffffffff, revision);
      list.reset();
      let nextId = 1;
      const setBox = (
        parent: number,
        transform: readonly [number, number, number, number, number, number],
        w: number,
        h: number,
        ops: WireRecord["ops"],
        opts?: {
          id?: number;
          flags?: number;
          blend?: number;
          opacity?: number;
          radii?: readonly [number, number, number, number];
        },
      ) => {
        const id = opts?.id ?? nextId++;
        list.set(id, parent, {
          flags: opts?.flags ?? 0,
          transform: [...transform],
          opacity: opts?.opacity ?? 1,
          ...(opts?.blend !== undefined ? { blend: opts.blend } : {}),
          width: w,
          height: h,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [
            {
              kind: "rect",
              w,
              h,
              radii: [...(opts?.radii ?? [0, 0, 0, 0])],
              smoothing: 0,
            },
          ],
          ops,
          coarse: [],
        });
        return id;
      };
      const glassOp = (): WireRecord["ops"] => [
        {
          op: "glass",
          paths: [0],
          evenOdd: false,
          kind: 0,
          inradius: 24,
          angle: -45,
          intensity: 55,
          refraction: 45,
          depth: 12,
          dispersion: 18,
          frost: 4,
          splay: 0,
          boxRadii: [10, 10, 10, 10],
          boxSmoothing: [0, 0, 0, 0],
        },
      ];
      // Varied opaque backdrop straddling tile boundary x = 512.
      for (let i = 0; i < 8; i++) {
        setBox(ROOT, [1, 0, 0, 1, 384 + offsetX + i * 32, 64], 32, 192, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: {
              kind: "solid",
              color: [0.18 + (i % 4) * 0.2, 0.25 + ((i + 1) % 3) * 0.24, 0.78 - i * 0.07, 1],
            },
          },
        ]);
      }
      // 1. Plain integer AA-rect clip straddling x = 512.
      const clipA = setBox(
        ROOT,
        [1, 0, 0, 1, 396 + offsetX, 76],
        156,
        88,
        [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
        { flags: 0 },
      );
      // Non-HW blends extending past the clip edge (triggers scopeClip without fast path).
      setBox(clipA, [1, 0, 0, 1, -12, -10], 70, 54, [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: { kind: "solid", color: [0.92, 0.35, 0.2, 0.85], blend: BLEND.luminosity },
        },
      ]);
      setBox(clipA, [1, 0, 0, 1, 98, -8], 76, 52, [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: { kind: "solid", color: [0.25, 0.82, 0.65, 0.75], blend: BLEND["color-dodge"] },
        },
      ]);
      // Background blur, progressive blur, and glass crossing clipA edges.
      setBox(clipA, [1, 0, 0, 1, 34, 48], 60, 56, [
        { op: "backgroundBlur", paths: [0], evenOdd: false, radius: 14 },
      ]);
      setBox(clipA, [1, 0, 0, 1, 108, 42], 64, 58, [
        {
          op: "progressiveBlur",
          paths: [0],
          evenOdd: false,
          startRadius: 2,
          endRadius: 18,
          start: [0, 0],
          end: [0, 1],
        },
      ]);
      setBox(clipA, [1, 0, 0, 1, -8, 40], 54, 58, glassOp(), { radii: [10, 10, 10, 10] });
      // Completely clipped-out children (must contribute 0 pixels and 0 masks).
      setBox(clipA, [1, 0, 0, 1, 220, 10], 40, 40, [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: { kind: "solid", color: [1, 0, 0, 1], blend: BLEND.difference },
        },
      ]);
      setBox(clipA, [1, 0, 0, 1, 220, 10], 40, 40, [
        { op: "backgroundBlur", paths: [0], evenOdd: false, radius: 12 },
      ]);

      // 2. Nested 90-degree rotated + horizontally flipped integer AA-rect clips.
      const clipRot = setBox(
        ROOT,
        [0, 1, -1, 0, 560 + offsetX, 174],
        64,
        140,
        [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
        { flags: 0 },
      );
      const clipFlip = setBox(
        clipRot,
        [-1, 0, 0, 1, 56, 12],
        48,
        112,
        [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
        { flags: 0 },
      );
      setBox(clipFlip, [1, 0, 0, 1, -10, -10], 70, 72, [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: { kind: "solid", color: [0.85, 0.72, 0.18, 0.8], blend: BLEND.difference },
        },
      ]);
      setBox(clipFlip, [1, 0, 0, 1, 4, 56], 54, 68, glassOp(), { radii: [8, 8, 8, 8] });
      return [...list.finish()];
    };

    const clipChainCacheScene = (
      revision: number,
      offsetX = 0,
      opts?: { radius?: number; clipShiftX?: number },
    ): number[] => {
      const list = new ListWriter(0xffffffff, revision);
      list.reset();
      let nextId = 1;
      const setBox = (
        parent: number,
        transform: readonly [number, number, number, number, number, number],
        w: number,
        h: number,
        ops: WireRecord["ops"],
        extra?: {
          id?: number;
          flags?: number;
          radii?: readonly [number, number, number, number];
        },
      ) => {
        const id = extra?.id ?? nextId++;
        list.set(id, parent, {
          flags: extra?.flags ?? 0,
          transform: [...transform],
          opacity: 1,
          width: w,
          height: h,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [
            {
              kind: "rect",
              w,
              h,
              radii: [...(extra?.radii ?? [0, 0, 0, 0])],
              smoothing: 0,
            },
          ],
          ops,
          coarse: [],
        });
        return id;
      };
      const glassOp = (): WireRecord["ops"] => [
        {
          op: "glass",
          paths: [0],
          evenOdd: false,
          kind: 0,
          inradius: 20,
          angle: -35,
          intensity: 50,
          refraction: 40,
          depth: 10,
          dispersion: 16,
          frost: 3,
          splay: 0,
          boxRadii: [8, 8, 8, 8],
          boxSmoothing: [0, 0, 0, 0],
        },
      ];
      // Varied opaque backdrop.
      for (let i = 0; i < 8; i++) {
        setBox(ROOT, [1, 0, 0, 1, 384 + offsetX + i * 32, 64], 32, 192, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: {
              kind: "solid",
              color: [0.22 + (i % 3) * 0.25, 0.72 - (i % 4) * 0.14, 0.3 + (i % 5) * 0.12, 1],
            },
          },
        ]);
      }
      // Card A: shared rounded clip (id=500) straddling x = 512.
      const rad = opts?.radius ?? 24;
      const shiftX = opts?.clipShiftX ?? 0;
      const cardA = setBox(
        ROOT,
        [1, 0, 0, 1, 392 + offsetX + shiftX, 72],
        136,
        164,
        [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
        { id: 500, flags: 0, radii: [rad, rad, rad, rad] },
      );
      const modes = [
        BLEND.luminosity,
        BLEND["color-dodge"],
        BLEND.saturation,
        BLEND.difference,
        BLEND.exclusion,
        BLEND["hard-light"],
      ] as const;
      for (const [i, blend] of modes.entries()) {
        setBox(cardA, [1, 0, 0, 1, (i % 2) * 70 - 6, Math.floor(i / 2) * 52 - 6], 78, 56, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: {
              kind: "solid",
              color: [0.3 + i * 0.1, 0.85 - i * 0.1, 0.45 + (i % 3) * 0.2, 0.78],
              blend,
            },
          },
        ]);
      }
      // Inner integer AA-rect clip inside Card A: collapses onto Card A's cached rounded mask.
      const innerAa = setBox(
        cardA,
        [1, 0, 0, 1, 6, 8],
        124,
        148,
        [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
        { flags: 0 },
      );
      for (let i = 0; i < 3; i++) {
        setBox(innerAa, [1, 0, 0, 1, -8 + i * 44, -8], 52, 48, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.9, 0.4, 0.7, 0.65], blend: BLEND.overlay },
          },
        ]);
      }
      setBox(innerAa, [1, 0, 0, 1, -4, 96], 62, 60, [
        { op: "backgroundBlur", paths: [0], evenOdd: false, radius: 12 },
      ]);
      setBox(innerAa, [1, 0, 0, 1, 66, 92], 64, 64, [
        {
          op: "progressiveBlur",
          paths: [0],
          evenOdd: false,
          startRadius: 2,
          endRadius: 16,
          start: [0, 0],
          end: [0, 1],
        },
      ]);
      setBox(innerAa, [1, 0, 0, 1, 32, 46], 60, 56, glassOp(), { radii: [8, 8, 8, 8] });

      // Card B: fractional-offset AA rect clip (must NOT fold into integer scissor).
      const fracClip = setBox(
        ROOT,
        [1, 0, 0, 1, 536.25 + offsetX, 74.5],
        88,
        74,
        [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
        { flags: 0 },
      );
      setBox(fracClip, [1, 0, 0, 1, -8, -8], 104, 48, [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: { kind: "solid", color: [0.95, 0.25, 0.55, 0.82], blend: BLEND.luminosity },
        },
      ]);
      setBox(fracClip, [1, 0, 0, 1, -4, 34], 96, 48, [
        { op: "backgroundBlur", paths: [0], evenOdd: false, radius: 10 },
      ]);

      // Card C: 15-degree rotated rect clip (must NOT fold into integer scissor).
      const c = Math.cos(Math.PI / 12);
      const s = Math.sin(Math.PI / 12);
      const rotClip = setBox(
        ROOT,
        [c, s, -s, c, 554 + offsetX, 166],
        68,
        56,
        [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
        { flags: 0 },
      );
      setBox(rotClip, [1, 0, 0, 1, -8, -8], 84, 72, [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: { kind: "solid", color: [0.2, 0.85, 0.9, 0.78], blend: BLEND.difference },
        },
      ]);
      setBox(rotClip, [1, 0, 0, 1, 4, 6], 56, 44, glassOp(), { radii: [8, 8, 8, 8] });

      return [...list.finish()];
    };

    const clipPausedWalkScene = (revision: number, radius = 28): number[] => {
      const list = new ListWriter(0xffffffff, revision);
      list.reset();
      let nextId = 1;
      const setBox = (
        parent: number,
        x: number,
        y: number,
        w: number,
        h: number,
        ops: WireRecord["ops"],
        extra?: {
          id?: number;
          flags?: number;
          radii?: readonly [number, number, number, number];
        },
      ) => {
        const id = extra?.id ?? nextId++;
        list.set(id, parent, {
          flags: extra?.flags ?? 0,
          transform: [1, 0, 0, 1, x, y],
          opacity: 1,
          width: w,
          height: h,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [
            {
              kind: "rect",
              w,
              h,
              radii: [...(extra?.radii ?? [0, 0, 0, 0])],
              smoothing: 0,
            },
          ],
          ops,
          coarse: [],
        });
        return id;
      };
      setBox(ROOT, 0, 0, 256, 256, [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: { kind: "solid", color: [0.16, 0.28, 0.52, 1] },
        },
      ]);
      setBox(ROOT, 128, 0, 128, 256, [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: { kind: "solid", color: [0.76, 0.42, 0.22, 1] },
        },
      ]);
      const card = setBox(
        ROOT,
        16,
        16,
        224,
        224,
        [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
        { id: 500, flags: 0, radii: [radius, radius, radius, radius] },
      );
      const modes = [
        BLEND.luminosity,
        BLEND["color-dodge"],
        BLEND.difference,
        BLEND.overlay,
      ] as const;
      for (let i = 0; i < 18; i++) {
        const x = (i % 3) * 76 - 10;
        const y = Math.floor(i / 3) * 38 - 10;
        setBox(card, x, y, 88, 46, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: {
              kind: "solid",
              color: [0.25 + (i % 5) * 0.15, 0.85 - (i % 4) * 0.18, 0.35 + (i % 3) * 0.22, 0.7],
              blend: modes[i % modes.length] ?? BLEND.luminosity,
            },
          },
        ]);
      }
      setBox(card, -6, 150, 110, 80, [
        { op: "backgroundBlur", paths: [0], evenOdd: false, radius: 14 },
      ]);
      setBox(card, 120, 150, 110, 80, [
        {
          op: "glass",
          paths: [0],
          evenOdd: false,
          kind: 0,
          inradius: 20,
          angle: -45,
          intensity: 50,
          refraction: 45,
          depth: 10,
          dispersion: 16,
          frost: 4,
          splay: 0,
          boxRadii: [10, 10, 10, 10],
          boxSmoothing: [0, 0, 0, 0],
        },
      ]);
      return [...list.finish()];
    };

    /**
     * Exact curved/rotated/even-odd clip-atlas regression scene (big rounded clip A holding
     * nested rotated clip B, overlapping multi-subpath circles C, even-odd circles D with
     * blends/blurs/glass, plus 48 neighboring small rounded clips that pack and overflow slots).
     */
    const clipAtlasCurvedEdgesScene = (revision: number, sx = 0): number[] => {
      const list = new ListWriter(0xffffffff, revision);
      list.reset();
      let nextId = 1;
      let seed = 23 >>> 0;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const rr = (w: number, h: number, r: number): WireRecord["paths"] => [
        { kind: "rect", w, h, radii: [r, r, r, r], smoothing: 0 },
      ];
      const circle = (p: PathData, cx: number, cy: number, r: number): PathData => {
        const k = 0.5523 * r;
        return p
          .moveTo(cx + r, cy)
          .cubicTo(cx + r, cy + k, cx + k, cy + r, cx, cy + r)
          .cubicTo(cx - k, cy + r, cx - r, cy + k, cx - r, cy)
          .cubicTo(cx - r, cy - k, cx - k, cy - r, cx, cy - r)
          .cubicTo(cx + k, cy - r, cx + r, cy - k, cx + r, cy)
          .close();
      };
      const add = (
        parent: number,
        r: Partial<WireRecord> & {
          x?: number;
          y?: number;
          w: number;
          h: number;
          ops: WireRecord["ops"];
        },
        id?: number,
      ): number => {
        const nid = id ?? nextId++;
        if (id && id >= nextId) nextId = id + 1;
        const { x = 0, y = 0, w, h, ...rest } = r;
        list.set(nid, parent, {
          flags: 0,
          transform: [1, 0, 0, 1, x, y],
          opacity: 1,
          width: w,
          height: h,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [{ kind: "rect", w, h, radii: [0, 0, 0, 0], smoothing: 0 }],
          coarse: [],
          ...rest,
        });
        return nid;
      };
      const fill = (
        color: readonly [number, number, number, number],
        blend?: number,
      ): WireRecord["ops"][number] => ({
        op: "fill",
        path: 0,
        evenOdd: false,
        paint: blend === undefined ? { kind: "solid", color } : { kind: "solid", color, blend },
      });
      const clipOps: WireRecord["ops"] = [
        { op: "clip", path: 0, evenOdd: false },
        { op: "children" },
        { op: "unclip" },
      ];
      const bb = (radius: number): WireRecord["ops"][number] => ({
        op: "backgroundBlur",
        paths: [0],
        evenOdd: false,
        radius,
      });
      const glass = (frost: number, r: number): WireRecord["ops"][number] => ({
        op: "glass",
        paths: [0],
        evenOdd: false,
        kind: 0,
        inradius: 20,
        angle: -45,
        intensity: 50,
        refraction: 45,
        depth: 10,
        dispersion: 16,
        frost,
        splay: 0,
        boxRadii: [r, r, r, r],
        boxSmoothing: [0, 0, 0, 0],
      });
      const blends = [
        BLEND.luminosity,
        BLEND.saturation,
        BLEND.difference,
        BLEND.hue,
        BLEND.exclusion,
        BLEND.overlay,
      ] as const;

      for (let i = 0; i < 30; i++) {
        add(ROOT, {
          x: i * 40 + sx,
          y: 0,
          w: 40,
          h: 1100,
          ops: [fill([rand(), rand(), rand(), 1])],
        });
      }
      for (let i = 0; i < 14; i++) {
        add(ROOT, {
          x: sx,
          y: 15 + i * 75,
          w: 1200,
          h: 9,
          ops: [fill([rand(), rand(), rand(), 1])],
        });
      }
      const clipA = add(
        ROOT,
        { x: 40 + sx, y: 30, w: 700, h: 700, paths: rr(700, 700, 90), ops: clipOps },
        900,
      );
      add(clipA, {
        x: 20,
        y: 20,
        w: 420,
        h: 400,
        ops: [fill([0.9, 0.2, 0.3, 0.7], BLEND.luminosity)],
      });
      const rot = 0.3;
      const c = Math.cos(rot);
      const sn = Math.sin(rot);
      const clipB = add(
        clipA,
        { x: 0, y: 0, w: 640, h: 600, transform: [c, sn, -sn, c, 120, -60], ops: clipOps },
        901,
      );
      add(clipB, {
        x: 10,
        y: 10,
        w: 560,
        h: 520,
        ops: [fill([0.2, 0.7, 0.9, 0.6], BLEND.difference)],
      });
      add(clipB, { x: 200, y: 150, w: 260, h: 220, ops: [bb(14)] });
      add(clipA, {
        x: 260,
        y: 280,
        w: 420,
        h: 400,
        ops: [fill([0.3, 0.9, 0.2, 0.7], BLEND.saturation)],
      });
      const two = circle(circle(new PathData(), 160, 160, 150), 290, 230, 150);
      const clipC = add(
        clipA,
        { x: 20, y: 300, w: 450, h: 390, paths: [{ kind: "path", path: two }], ops: clipOps },
        902,
      );
      add(clipC, {
        x: 0,
        y: 0,
        w: 450,
        h: 390,
        ops: [fill([0.95, 0.8, 0.1, 0.65], BLEND.hue)],
      });
      add(clipC, {
        x: 120,
        y: 80,
        w: 220,
        h: 200,
        ops: [
          {
            op: "progressiveBlur",
            paths: [0],
            evenOdd: false,
            startRadius: 1,
            endRadius: 20,
            start: [0, 0],
            end: [1, 1],
          },
        ],
      });
      const two2 = circle(circle(new PathData(), 150, 150, 140), 260, 200, 140);
      const clipD = add(
        clipA,
        {
          x: 330,
          y: 40,
          w: 410,
          h: 350,
          paths: [{ kind: "path", path: two2 }],
          ops: [{ op: "clip", path: 0, evenOdd: true }, { op: "children" }, { op: "unclip" }],
        },
        903,
      );
      add(clipD, {
        x: 0,
        y: 0,
        w: 410,
        h: 350,
        ops: [fill([0.6, 0.3, 0.9, 0.7], BLEND.exclusion)],
      });
      add(clipD, { x: 60, y: 60, w: 280, h: 230, paths: rr(280, 230, 30), ops: [glass(5, 30)] });
      for (let k = 0; k < 48; k++) {
        const gx = 760 + sx + (k % 6) * 74;
        const gy = 30 + Math.floor(k / 6) * 66;
        const g = add(
          ROOT,
          { x: gx, y: gy, w: 70, h: 62, paths: rr(70, 62, 8 + (k % 7) * 3), ops: clipOps },
          1000 + k,
        );
        add(g, {
          x: -6,
          y: -6,
          w: 82,
          h: 74,
          ops: [fill([rand(), rand(), rand(), 0.75], blends[k % blends.length])],
        });
        if (k % 3 === 0) add(g, { x: 10, y: 8, w: 50, h: 46, ops: [bb(10)] });
      }
      return [...list.finish()];
    };

    test("clip-chain mask cache and integer AA-rect scissor fast path stay byte-identical across scopes, blurs, glass, fractional clips, tile shifts and patches", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openEngine(page, build);
      const tileShiftPx = 128;
      // Patch 1: move Card A's clip transform by +12 px.
      const transformPatch = new ListWriter(20, 21);
      transformPatch.transform(500, [1, 0, 0, 1, 392 + 12, 72]);
      // Patch 2: change Card A's corner radius from 24 to 8 while keeping shifted transform.
      const radiusPatch = new ListWriter(21, 22);
      radiusPatch.set(500, ROOT, {
        flags: 0,
        transform: [1, 0, 0, 1, 392 + 12, 72],
        opacity: 1,
        width: 136,
        height: 164,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w: 136, h: 164, radii: [8, 8, 8, 8], smoothing: 0 }],
        ops: [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
        coarse: [],
      });

      const result = await page.evaluate(
        async ({
          warmups,
          aaBase,
          aaShifted,
          cacheBase,
          cacheShifted,
          transformPatchBytes,
          radiusPatchBytes,
          cacheFreshTransform,
          cacheFreshRadius,
          tileShiftPx,
          expectedBackend,
          scopeClipIdx,
          blurClipIdx,
          readerClipIdx,
        }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const check = (out: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = out;
            out.free();
            if (!ok) throw new Error(message);
          };
          const diffStats = (a: Uint8Array, b: Uint8Array) => {
            let bytes = Math.abs(a.length - b.length);
            let maxDelta = 0;
            let firstDiff: { px: number; a: number[]; b: number[] } | null = null;
            const n = Math.min(a.length, b.length);
            for (let i = 0; i < n; i++) {
              const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
              if (d !== 0) {
                bytes++;
                if (d > maxDelta) maxDelta = d;
                if (!firstDiff) {
                  const p = Math.floor(i / 4) * 4;
                  firstDiff = {
                    px: p / 4,
                    a: [a[p] ?? 0, a[p + 1] ?? 0, a[p + 2] ?? 0, a[p + 3] ?? 0],
                    b: [b[p] ?? 0, b[p + 1] ?? 0, b[p + 2] ?? 0, b[p + 3] ?? 0],
                  };
                }
              }
            }
            return { bytes, maxDelta, firstDiff };
          };
          const open = async () => {
            let device = await glue.createGpu(null, 0);
            for (let attempt = 0; attempt < 3 && !device.ok; attempt++) {
              device.free();
              await new Promise((r) => setTimeout(r, 300));
              device = await glue.createGpu(null, 0);
            }
            if (!device.ok || device.backend !== expectedBackend)
              throw new Error(device.message || `expected ${expectedBackend}`);
            const engine = new glue.Engine(0, 0);
            if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels) {
              throw new Error("missing GPU entry points");
            }
            check(engine.attachGpu(device));
            // Warm reader and blend pipelines individually so SwiftShader WebGPU does not pile
            // several first-time shader compiles into a single 12 s readback window.
            const warmBg = new Float32Array([0.5, 0.5, 0.5, 1]);
            for (const list of warmups) {
              check(engine.apply(new Uint8Array(list)));
              check(engine.renderGpu(16, 16, 1, 0, 0, 1, warmBg, false, 0, true));
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
            }
            engine.clearTiles?.();
            return { engine, device };
          };
          const draw = async (
            engine: InstanceType<typeof glue.Engine>,
            list: number[] | null,
            fastPath: boolean,
            camX = -384,
            clearTiles = true,
          ) => {
            if (!engine.renderGpu || !engine.gpuPixels || !engine.gpuCounters)
              throw new Error("missing GPU entry points");
            engine.setGpuClipFastPath?.(fastPath);
            if (clearTiles) engine.clearTiles?.();
            if (list) check(engine.apply(new Uint8Array(list)));
            const before = engine.gpuCounters();
            const bg = new Float32Array([0.12, 0.16, 0.22, 1]);
            check(engine.renderGpu(256, 192, 1, camX, -64, 1, bg, false, 0, true));
            const pixels = await engine.gpuPixels();
            if (!(pixels instanceof Uint8Array)) throw new Error(pixels.message);
            const after = engine.gpuCounters();
            return {
              pixels: new Uint8Array(pixels),
              scopeClip: (after[scopeClipIdx] ?? 0) - (before[scopeClipIdx] ?? 0),
              blurClip: (after[blurClipIdx] ?? 0) - (before[blurClipIdx] ?? 0),
              readerClip: (after[readerClipIdx] ?? 0) - (before[readerClipIdx] ?? 0),
            };
          };

          const primary = await open();
          const secondary = await open();
          try {
            const aaOn = await draw(primary.engine, aaBase, true, -384);
            const aaOff = await draw(primary.engine, null, false, -384);
            const aaShift = await draw(primary.engine, aaShifted, true, -384 - tileShiftPx);

            const cacheOn = await draw(primary.engine, cacheBase, true, -384);
            const cacheOff = await draw(primary.engine, null, false, -384);
            // Warm revision 20, apply transform patch (21), then radius patch (22).
            await draw(primary.engine, null, true, -384);
            const patchedTransform = await draw(
              primary.engine,
              transformPatchBytes,
              true,
              -384,
              false,
            );
            const patchedRadius = await draw(primary.engine, radiusPatchBytes, true, -384, false);
            const cacheShift = await draw(primary.engine, cacheShifted, true, -384 - tileShiftPx);

            const freshTransform = await draw(secondary.engine, cacheFreshTransform, true, -384);
            const freshRadius = await draw(secondary.engine, cacheFreshRadius, true, -384);

            return {
              aa: {
                on: {
                  scopeClip: aaOn.scopeClip,
                  blurClip: aaOn.blurClip,
                  readerClip: aaOn.readerClip,
                },
                off: {
                  scopeClip: aaOff.scopeClip,
                  blurClip: aaOff.blurClip,
                  readerClip: aaOff.readerClip,
                },
                onVsOff: diffStats(aaOn.pixels, aaOff.pixels),
                tileShift: diffStats(aaOn.pixels, aaShift.pixels),
              },
              cache: {
                on: {
                  scopeClip: cacheOn.scopeClip,
                  blurClip: cacheOn.blurClip,
                  readerClip: cacheOn.readerClip,
                },
                off: {
                  scopeClip: cacheOff.scopeClip,
                  blurClip: cacheOff.blurClip,
                  readerClip: cacheOff.readerClip,
                },
                onVsOff: diffStats(cacheOn.pixels, cacheOff.pixels),
                tileShift: diffStats(cacheOn.pixels, cacheShift.pixels),
                patchedTransformVsFresh: diffStats(patchedTransform.pixels, freshTransform.pixels),
                patchedRadiusVsFresh: diffStats(patchedRadius.pixels, freshRadius.pixels),
              },
            };
          } finally {
            primary.engine.free();
            primary.device.free();
            secondary.engine.free();
            secondary.device.free();
          }
        },
        {
          warmups: clipWarmupLists(),
          aaBase: clipAaRectScissorScene(10, 0),
          aaShifted: clipAaRectScissorScene(11, tileShiftPx),
          cacheBase: clipChainCacheScene(20, 0),
          cacheShifted: clipChainCacheScene(23, tileShiftPx),
          transformPatchBytes: [...transformPatch.finish()],
          radiusPatchBytes: [...radiusPatch.finish()],
          cacheFreshTransform: clipChainCacheScene(21, 0, { clipShiftX: 12 }),
          cacheFreshRadius: clipChainCacheScene(22, 0, { clipShiftX: 12, radius: 8 }),
          tileShiftPx,
          expectedBackend: build === "webgl" ? "webgl2" : "webgpu",
          scopeClipIdx: SCOPE_CLIP_COUNTER,
          blurClipIdx: BLUR_CLIP_COUNTER,
          readerClipIdx: READER_CLIP_COUNTER,
        },
      );

      // AA-rect scissor fast path: zero clip masks rasterized, byte-identical to mask path and +128px shift.
      expect(result.aa.on).toEqual({ scopeClip: 0, blurClip: 0, readerClip: 0 });
      expect(result.aa.off.scopeClip).toBeGreaterThan(0);
      expect(result.aa.off.blurClip).toBeGreaterThan(0);
      expect(result.aa.off.readerClip).toBeGreaterThan(0);
      expect(result.aa.onVsOff.bytes, JSON.stringify(result.aa.onVsOff)).toBe(0);
      expect(result.aa.tileShift.bytes, JSON.stringify(result.aa.tileShift)).toBe(0);

      // Clip-chain cache + fractional/rotated preservation: big drop in clip renders, 0 differing bytes.
      const cacheOnTotal =
        result.cache.on.scopeClip + result.cache.on.blurClip + result.cache.on.readerClip;
      const cacheOffTotal =
        result.cache.off.scopeClip + result.cache.off.blurClip + result.cache.off.readerClip;
      expect(cacheOnTotal).toBeGreaterThan(0);
      expect(cacheOnTotal).toBeLessThan(Math.floor(cacheOffTotal / 2));
      expect(result.cache.onVsOff.bytes, JSON.stringify(result.cache.onVsOff)).toBe(0);
      expect(result.cache.tileShift.bytes, JSON.stringify(result.cache.tileShift)).toBe(0);
      expect(
        result.cache.patchedTransformVsFresh.bytes,
        JSON.stringify(result.cache.patchedTransformVsFresh),
      ).toBe(0);
      expect(
        result.cache.patchedRadiusVsFresh.bytes,
        JSON.stringify(result.cache.patchedRadiusVsFresh),
      ).toBe(0);
    });

    test("clip-chain mask cache stays exact across mid-tile PausedWalk pause/resume and mid-pause edits", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openEngine(page, build);
      const midPausePatch = new ListWriter(30, 31);
      midPausePatch.set(500, ROOT, {
        flags: 0,
        transform: [1, 0, 0, 1, 16, 16],
        opacity: 1,
        width: 224,
        height: 224,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w: 224, h: 224, radii: [6, 6, 6, 6], smoothing: 0 }],
        ops: [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
        coarse: [],
      });

      const result = await page.evaluate(
        async ({
          warmups,
          initial,
          midPausePatchBytes,
          freshEdited,
          expectedBackend,
          scopeClipIdx,
          blurClipIdx,
          readerClipIdx,
          pausesIdx,
        }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const check = (out: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = out;
            out.free();
            if (!ok) throw new Error(message);
          };
          const diffBytes = (a: Uint8Array, b: Uint8Array) => {
            let bytes = Math.abs(a.length - b.length);
            const n = Math.min(a.length, b.length);
            for (let i = 0; i < n; i++) if (a[i] !== b[i]) bytes++;
            return bytes;
          };
          const open = async () => {
            let device = await glue.createGpu(null, 0);
            for (let attempt = 0; attempt < 3 && !device.ok; attempt++) {
              device.free();
              await new Promise((r) => setTimeout(r, 300));
              device = await glue.createGpu(null, 0);
            }
            if (!device.ok || device.backend !== expectedBackend)
              throw new Error(device.message || `expected ${expectedBackend}`);
            const engine = new glue.Engine(0, 0);
            if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels) {
              throw new Error("missing GPU entry points");
            }
            check(engine.attachGpu(device));
            // Warm reader and blend pipelines individually so SwiftShader WebGPU does not pile
            // several first-time shader compiles into a single 12 s readback window.
            const warmBg = new Float32Array([0.5, 0.5, 0.5, 1]);
            for (const list of warmups) {
              check(engine.apply(new Uint8Array(list)));
              check(engine.renderGpu(16, 16, 1, 0, 0, 1, warmBg, false, 0, true));
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
            }
            engine.clearTiles?.();
            return { engine, device };
          };
          const clipTotal = (before: Uint32Array, after: Uint32Array) =>
            (after[scopeClipIdx] ?? 0) -
            (before[scopeClipIdx] ?? 0) +
            ((after[blurClipIdx] ?? 0) - (before[blurClipIdx] ?? 0)) +
            ((after[readerClipIdx] ?? 0) - (before[readerClipIdx] ?? 0));

          const primary = await open();
          const secondary = await open();
          try {
            const p = primary.engine;
            const s = secondary.engine;
            if (!p.renderGpu || !p.gpuPixels || !p.gpuCounters || !s.renderGpu || !s.gpuPixels) {
              throw new Error("missing GPU entry points");
            }
            const readPixels = async (engine: typeof p) => {
              const px = await engine.gpuPixels?.();
              if (!(px instanceof Uint8Array)) {
                throw new Error(px?.message ?? "no GPU readback");
              }
              return new Uint8Array(px);
            };
            const bg = new Float32Array([0.1, 0.14, 0.2, 1]);
            check(p.apply(new Uint8Array(initial)));

            // 1. Unbudgeted baseline: fast path ON vs OFF.
            p.setGpuClipFastPath?.(true);
            p.clearTiles?.();
            let b0 = p.gpuCounters();
            check(p.renderGpu(256, 256, 1, 0, 0, 1, bg, false, 0, true));
            const fastPixels = await readPixels(p);
            const fastClips = clipTotal(b0, p.gpuCounters());

            p.setGpuClipFastPath?.(false);
            p.clearTiles?.();
            b0 = p.gpuCounters();
            check(p.renderGpu(256, 256, 1, 0, 0, 1, bg, false, 0, true));
            const slowPixels = await readPixels(p);
            const slowClips = clipTotal(b0, p.gpuCounters());

            // 2. Tiny budget forcing PausedWalk mid-tile pauses across the shared clip chain.
            p.setGpuClipFastPath?.(true);
            p.clearTiles?.();
            b0 = p.gpuCounters();
            let slices = 0;
            let exact = false;
            while (!exact && slices < 120) {
              const out = p.renderGpu(256, 256, 1, 0, 0, 1, bg, false, 0.01, true);
              exact = out.exact;
              check(out);
              await p.gpuFinished?.();
              slices++;
            }
            const pausedPixels = await readPixels(p);
            const afterPaused = p.gpuCounters();
            const pausedClips = clipTotal(b0, afterPaused);
            const pauses = (afterPaused[pausesIdx] ?? 0) - (b0[pausesIdx] ?? 0);

            // 3. Edit clip mid-pause and verify cache invalidation matches fresh engine.
            p.clearTiles?.();
            const firstSlice = p.renderGpu(256, 256, 1, 0, 0, 1, bg, false, 0.01, true);
            const startedPaused = firstSlice.in_progress;
            check(firstSlice);
            await p.gpuFinished?.();
            check(p.apply(new Uint8Array(midPausePatchBytes)));
            check(p.renderGpu(256, 256, 1, 0, 0, 1, bg, false, 0, true));
            const editedPixels = await readPixels(p);

            s.setGpuClipFastPath?.(true);
            check(s.apply(new Uint8Array(freshEdited)));
            check(s.renderGpu(256, 256, 1, 0, 0, 1, bg, false, 0, true));
            const freshEditedPixels = await readPixels(s);

            return {
              exact,
              pauses,
              startedPaused,
              fastClips,
              slowClips,
              pausedClips,
              fastVsSlowBytes: diffBytes(fastPixels, slowPixels),
              pausedVsFastBytes: diffBytes(pausedPixels, fastPixels),
              midPauseEditVsFreshBytes: diffBytes(editedPixels, freshEditedPixels),
            };
          } finally {
            primary.engine.free();
            primary.device.free();
            secondary.engine.free();
            secondary.device.free();
          }
        },
        {
          warmups: clipWarmupLists(),
          initial: clipPausedWalkScene(30, 28),
          midPausePatchBytes: [...midPausePatch.finish()],
          freshEdited: clipPausedWalkScene(31, 6),
          expectedBackend: build === "webgl" ? "webgl2" : "webgpu",
          scopeClipIdx: SCOPE_CLIP_COUNTER,
          blurClipIdx: BLUR_CLIP_COUNTER,
          readerClipIdx: READER_CLIP_COUNTER,
          pausesIdx: PAUSES_COUNTER,
        },
      );

      expect(result.exact).toBe(true);
      expect(result.pauses).toBeGreaterThan(0);
      expect(result.fastClips).toBeLessThanOrEqual(2);
      expect(result.slowClips).toBeGreaterThanOrEqual(16);
      expect(result.pausedClips).toBeLessThanOrEqual(2);
      expect(result.fastVsSlowBytes).toBe(0);
      expect(result.pausedVsFastBytes).toBe(0);
      expect(result.midPauseEditVsFreshBytes).toBe(0);
    });

    test("clip-atlas target-space rasterization matches uncached path byte-for-byte on curved, rotated, and even-odd clips across zooms", async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await openEngine(page, build);
      const views = [
        {
          id: "whole1",
          size: [1200, 760] as [number, number],
          cam: [1, 0, 0] as [number, number, number],
          budget: 0,
          ev: false,
        },
        {
          id: "tiled1",
          size: [1200, 760] as [number, number],
          cam: [1, 0, 0] as [number, number, number],
          budget: 40,
          ev: true,
        },
        {
          id: "z0.75",
          size: [900, 600] as [number, number],
          cam: [0.75, 0, 0] as [number, number, number],
          budget: 40,
          ev: true,
        },
        {
          id: "z1.5",
          size: [900, 700] as [number, number],
          cam: [1.5, -100, -20] as [number, number, number],
          budget: 40,
          ev: true,
        },
      ];
      const result = await page.evaluate(
        async ({
          warmups,
          list,
          views,
          expectedBackend,
          scopeClipIdx,
          blurClipIdx,
          readerClipIdx,
        }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const check = (out: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = out;
            out.free();
            if (!ok) throw new Error(message);
          };
          const diffStats = (a: Uint8Array, b: Uint8Array, w: number) => {
            let bytes = Math.abs(a.length - b.length);
            let maxDelta = 0;
            let first: { x: number; y: number; a: number[]; b: number[] } | null = null;
            const n = Math.min(a.length, b.length);
            for (let i = 0; i < n; i++) {
              const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
              if (d !== 0) {
                bytes++;
                if (d > maxDelta) maxDelta = d;
                if (!first) {
                  const p = Math.floor(i / 4);
                  first = {
                    x: p % w,
                    y: Math.floor(p / w),
                    a: [a[p * 4] ?? 0, a[p * 4 + 1] ?? 0, a[p * 4 + 2] ?? 0, a[p * 4 + 3] ?? 0],
                    b: [b[p * 4] ?? 0, b[p * 4 + 1] ?? 0, b[p * 4 + 2] ?? 0, b[p * 4 + 3] ?? 0],
                  };
                }
              }
            }
            return { bytes, maxDelta, first };
          };
          let device = await glue.createGpu(null, 0);
          for (let attempt = 0; attempt < 3 && !device.ok; attempt++) {
            device.free();
            await new Promise((r) => setTimeout(r, 300));
            device = await glue.createGpu(null, 0);
          }
          if (!device.ok || device.backend !== expectedBackend)
            throw new Error(device.message || `expected ${expectedBackend}`);
          const engine = new glue.Engine(0, 0);
          try {
            if (
              !engine.attachGpu ||
              !engine.renderGpu ||
              !engine.gpuPixels ||
              !engine.gpuCounters
            ) {
              throw new Error("missing GPU entry points");
            }
            check(engine.attachGpu(device));
            const warmBg = new Float32Array([0.5, 0.5, 0.5, 1]);
            for (const wl of warmups) {
              check(engine.apply(new Uint8Array(wl)));
              check(engine.renderGpu(16, 16, 1, 0, 0, 1, warmBg, false, 0, true));
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
            }
            engine.clearTiles?.();
            check(engine.apply(new Uint8Array(list)));
            const bg = new Float32Array([0.15, 0.25, 0.35, 1]);
            const clipTotal = (before: Uint32Array, after: Uint32Array) =>
              (after[scopeClipIdx] ?? 0) -
              (before[scopeClipIdx] ?? 0) +
              ((after[blurClipIdx] ?? 0) - (before[blurClipIdx] ?? 0)) +
              ((after[readerClipIdx] ?? 0) - (before[readerClipIdx] ?? 0));
            const renderView = async (v: (typeof views)[number], fast: boolean) => {
              engine.setGpuClipFastPath?.(fast);
              engine.clearTiles?.();
              const before = engine.gpuCounters?.() ?? new Uint32Array(0);
              let exact = false;
              let attempts = 0;
              do {
                const out = engine.renderGpu?.(
                  v.size[0],
                  v.size[1],
                  v.cam[0],
                  v.cam[1],
                  v.cam[2],
                  1,
                  bg,
                  false,
                  v.budget,
                  v.ev,
                );
                if (!out) throw new Error("no renderGpu");
                exact = out.exact;
                attempts++;
                check(out);
                await engine.gpuFinished?.();
              } while (!exact && attempts < 120);
              const px = await engine.gpuPixels?.();
              if (!(px instanceof Uint8Array)) throw new Error(px?.message ?? "no readback");
              const after = engine.gpuCounters?.() ?? new Uint32Array(0);
              return { pixels: new Uint8Array(px), exact, clips: clipTotal(before, after) };
            };

            const out: Record<
              string,
              {
                exact: [boolean, boolean];
                clips: [number, number];
                diff: ReturnType<typeof diffStats>;
              }
            > = {};
            for (const v of views) {
              const on = await renderView(v, true);
              const off = await renderView(v, false);
              out[v.id] = {
                exact: [on.exact, off.exact],
                clips: [on.clips, off.clips],
                diff: diffStats(on.pixels, off.pixels, v.size[0]),
              };
            }
            return out;
          } finally {
            engine.free();
            device.free();
          }
        },
        {
          warmups: clipWarmupLists(),
          list: clipAtlasCurvedEdgesScene(40, 0),
          views,
          expectedBackend: build === "webgl" ? "webgl2" : "webgpu",
          scopeClipIdx: SCOPE_CLIP_COUNTER,
          blurClipIdx: BLUR_CLIP_COUNTER,
          readerClipIdx: READER_CLIP_COUNTER,
        },
      );

      for (const v of views) {
        const row = result[v.id];
        expect(row, `missing result for ${v.id}`).toBeDefined();
        expect(row?.exact, `${v.id} exact`).toEqual([true, true]);
        expect(row?.diff.bytes, `${v.id}: ${JSON.stringify(row?.diff)}`).toBe(0);
      }
    });
  });
}
