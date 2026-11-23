/**
 * Blend members drawn as blend layers in the GPU's scene (decision 0040, "Blend layers") against
 * the same members drawn as offscreen scopes composited with the engine's blend kernel, and
 * against the CPU (which always takes the kernel). Every blend mode, over partly transparent
 * backdrops: a record with a blend of its own, a blended fill, a member under a rounded clip at a
 * fractional place, a member holding a blended fill (the outer one offscreen, the inner one in
 * its scope's scene), members after the scene flushed (a layer blur before them), whose
 * backdrop is the target drawn into the scene as an image, and members between a glass and a
 * later reader, drawn into both planes, each over its own backdrop. Both GPU builds, through the
 * browser glue alone (SwiftShader here).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CPU_GPU_TOLERANCE, outsideTolerance, score } from "@drawpane/engine/compare";
import { FLAG, ListWriter, ROOT, type WireOp, type WireRecord } from "@drawpane/engine/wire";
import { expect, test } from "@playwright/test";

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
const origin = `http://localhost:${process.env.ENGINE_BLEND_ORIGIN_PORT ?? "8894"}`;

const MODES = 17;
/** Modes drawn per engine: blend layers and glass in one tile are slow on SwiftShader. */
const BATCH = 1;
const CELL = 48;
const ROWS = 6;
const WIDTH = BATCH * CELL;
const HEIGHT = ROWS * CELL;

type Rgba = [number, number, number, number];

function rect(w: number, h: number, r = 0): WireRecord["paths"][number] {
  return { kind: "rect", w, h, radii: [r, r, r, r], smoothing: 0 };
}

function fill(color: Rgba, blend = 0): WireOp {
  return { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color, blend } };
}

function record(
  at: [number, number],
  size: [number, number],
  ops: WireOp[],
  extra: Partial<WireRecord> = {},
): WireRecord {
  return {
    flags: 0,
    transform: [1, 0, 0, 1, at[0], at[1]],
    opacity: 1,
    width: size[0],
    height: size[1],
    coarseBelow: 0,
    reach: 0,
    unsupported: 0,
    paths: [rect(size[0], size[1], 6)],
    ops,
    coarse: [],
    ...extra,
  };
}

/**
 * Modes `first..first + BATCH` in columns; rows: own blend, blended fill, clipped, nested, after
 * a flush, between readers.
 */
function scene(first: number): number[] {
  const list = new ListWriter(0xffffffff, 1);
  list.reset();
  let id = 1;
  const add = (parent: number, r: WireRecord) => {
    const at = id++;
    list.set(at, parent, r);
    return at;
  };
  const backdrop = (x: number, y: number) => {
    add(ROOT, record([x + 2, y + 4], [30, 26], [fill([0.9, 0.3, 0.1, 0.65])]));
    add(ROOT, record([x + 14, y + 14], [30, 30], [fill([0.1, 0.4, 0.95, 0.5])]));
  };
  // A layer blur ahead of the last row: its scope flushes the scene before that row's members.
  add(
    ROOT,
    record([4, 4 * CELL + 2], [8, 8], [fill([0.2, 0.8, 0.3, 0.9])], {
      flags: FLAG.post,
      postEffects: [{ kind: "layerBlur", radius: 2 }],
      reach: 8,
    }),
  );
  const last = Math.min(first + BATCH, MODES + 1);
  const color = (m: number): Rgba => [
    ((m * 37) % 100) / 100,
    ((m * 61) % 100) / 100,
    ((m * 13) % 100) / 100,
    0.8,
  ];
  for (let m = first; m < last; m++) {
    const x = (m - first) * CELL;
    const source = color(m);
    // 0: a record with a blend of its own, faded.
    backdrop(x, 0);
    add(
      ROOT,
      record([x + 8.25, 9.5], [30, 28], [fill(source)], {
        flags: FLAG.blend | FLAG.isolate,
        blend: m,
        opacity: 0.7,
      }),
    );
    // 1: a blended fill.
    backdrop(x, CELL);
    add(ROOT, record([x + 8.5, CELL + 8.75], [30, 28], [fill(source, m)]));
    // 2: under a rounded clip at a fractional place, partly outside it.
    backdrop(x, 2 * CELL);
    const frame = add(
      ROOT,
      record(
        [x + 6.5, 2 * CELL + 6.25],
        [26, 30],
        [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
      ),
    );
    list.set(
      id++,
      frame,
      record([10, -4], [24, 30], [fill(source)], { flags: FLAG.blend, blend: m }),
    );
    // 3: a member holding a blended fill.
    backdrop(x, 3 * CELL);
    const outer = add(
      ROOT,
      record([x + 6, 3 * CELL + 6], [34, 34], [{ op: "children" }], {
        flags: FLAG.blend | FLAG.group,
        blend: m,
      }),
    );
    list.set(id++, outer, record([2, 2], [26, 26], [fill(source, (m % MODES) + 1)]));
    // 4: after the flush.
    backdrop(x, 4 * CELL);
    add(
      ROOT,
      record([x + 8, 4 * CELL + 9], [30, 28], [fill(source)], { flags: FLAG.blend, blend: m }),
    );
  }
  // 5: between a glass and a later reader: written to both planes, each over its own backdrop.
  const y = 5 * CELL;
  add(
    ROOT,
    record(
      [2, y + 2],
      [20, 20],
      [
        {
          op: "glass",
          paths: [0],
          evenOdd: false,
          kind: 0,
          inradius: 10,
          angle: -45,
          intensity: 80,
          refraction: 75,
          depth: 20,
          dispersion: 50,
          frost: 4,
          splay: 0,
          boxRadii: [6, 6, 6, 6],
          boxSmoothing: [0, 0, 0, 0],
        },
      ],
    ),
  );
  for (let m = first; m < last; m++) {
    const x = (m - first) * CELL;
    backdrop(x, y);
    add(
      ROOT,
      record([x + 8.5, y + 9], [30, 28], [fill(color(m))], { flags: FLAG.blend, blend: m }),
    );
  }
  add(
    ROOT,
    record(
      [WIDTH - 22, y + 24],
      [18, 18],
      [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius: 6 }],
    ),
  );
  return [...list.finish()];
}

type Drawn = {
  inScene: number[];
  offscreen: number[];
  cpu: number[];
  counters: { inScene: number[]; offscreen: number[] };
  exact: boolean[];
};

async function draw(
  page: import("@playwright/test").Page,
  build: GpuBuild,
  first: number,
): Promise<Drawn> {
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
  return page.evaluate(
    async ({ bytes, width, height, expected }) => {
      const name = "/engine.js";
      const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
      await glue.default({ module_or_path: "/engine_bg.wasm" });
      const check = (r: { ok: boolean; message: string; free(): void }) => {
        try {
          if (!r.ok) throw new Error(r.message);
        } finally {
          r.free();
        }
      };
      const bg = new Float32Array(4);
      const device = await glue.createGpu(null, 0);
      if (!device.ok) throw new Error(device.message);
      if (device.backend !== expected)
        throw new Error(`expected ${expected}, got ${device.backend}`);
      const e = new glue.Engine(0, 0);
      try {
        if (!e.attachGpu || !e.renderGpu || !e.gpuPixels || !e.setSceneBlends || !e.gpuCounters)
          throw new Error("no GPU entry points");
        check(e.apply(new Uint8Array(bytes)));
        check(e.attachGpu(device));
        const cpu: number[] = [];
        for (let y = 0; y < height; y += 128) {
          const rows = Math.min(128, height - y);
          check(e.renderBand(width, height, 1, 0, 0, 1, bg, y, rows));
          cpu.push(...e.pixels());
        }
        const exact: boolean[] = [];
        const pass = async (inScene: boolean) => {
          e.setSceneBlends?.(inScene);
          const before = [...(e.gpuCounters?.() ?? [])];
          const frame = e.renderGpu?.(width, height, 1, 0, 0, 1, bg, false, 0);
          if (!frame) throw new Error("no GPU frame");
          exact.push(frame.exact);
          check(frame);
          const pixels = await e.gpuPixels?.();
          if (!(pixels instanceof Uint8Array)) throw new Error(pixels?.message ?? "no read-back");
          const after = [...(e.gpuCounters?.() ?? [])];
          return { pixels: [...pixels], counters: after.map((v, i) => v - (before[i] ?? 0)) };
        };
        const a = await pass(true);
        const b = await pass(false);
        return {
          inScene: a.pixels,
          offscreen: b.pixels,
          cpu,
          counters: { inScene: a.counters, offscreen: b.counters },
          exact,
        };
      } finally {
        try {
          e.free();
        } catch {}
        device.free();
      }
    },
    {
      bytes: scene(first),
      width: WIDTH,
      height: HEIGHT,
      expected: build === "webgl" ? "webgl2" : "webgpu",
    },
  );
}

/** Counter indices (`RenderEngine.gpuCounters`): isolation scopes, blend layers, backdrops. */
const SCOPES = 11 + 16;
const SCENE_BLENDS = SCOPES + 5;
const BACKDROPS = SCOPES + 6;

for (const build of ["browser", "webgl"] as const) {
  test(`blend layers in the scene match offscreen blends and the CPU (${build})`, async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    for (let first = 1; first <= MODES; first += BATCH) {
      // A page of its own each: SwiftShader slows down as devices pile up in one.
      const page = await browser.newPage();
      const d = await draw(page, build, first).finally(() => page.close());
      const modes = `modes ${first}..${Math.min(first + BATCH - 1, MODES)}`;
      expect(d.exact, modes).toEqual([true, true]);
      // The scene drew them as blend layers (and brought a backdrop in), the other pass offscreen.
      const members = ROWS * Math.min(BATCH, MODES + 1 - first);
      expect(d.counters.inScene[SCENE_BLENDS] ?? 0, modes).toBeGreaterThanOrEqual(members);
      expect(d.counters.inScene[BACKDROPS] ?? 0, modes).toBeGreaterThan(0);
      expect(d.counters.offscreen[SCENE_BLENDS] ?? 0, modes).toBe(0);
      expect(d.counters.offscreen[SCOPES] ?? 0, modes).toBeGreaterThanOrEqual(members);
      const pairs: [string, number[], number[]][] = [
        ["in the scene vs offscreen", d.inScene, d.offscreen],
        ["in the scene vs the CPU", d.inScene, d.cpu],
        ["offscreen vs the CPU", d.offscreen, d.cpu],
      ];
      for (const [label, ours, theirs] of pairs) {
        const s = score(new Uint8Array(ours), new Uint8Array(theirs), WIDTH, HEIGHT);
        console.log(
          `${build} ${modes}, ${label}: mean ${s.mean.toFixed(3)}, p99 ${s.p99}, worst tile ${s.worstTile.toFixed(2)}, severe ${s.severeInTile}`,
        );
        expect(outsideTolerance(s, CPU_GPU_TOLERANCE), `${build} ${modes}, ${label}`).toEqual([]);
      }
    }
  });
}
