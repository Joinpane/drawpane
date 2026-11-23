/**
 * Divisor-aware high-zoom backdrop blur fidelity probes (decision 0040):
 *
 * Proves the <= 4/255 max and <= 2/255 p99 fidelity gate against a full-resolution reference on
 * both WebGPU (`browser`) and WebGL2 (`webgl`) across:
 * 1. Direct GPU-vs-GPU full-resolution reference at divisor d=64 (progressive blur across the
 *    entire sharp->native->mid->far transition band, plain and isolated opacity=0.75, plus
 *    uniform background blur) on the overlapping stripes + vertical bars + colored blocks scene.
 * 2. True extreme zoom at 25,600% (d=128 and d=256 naturally with no driver layer) across the
 *    sharp->native->mid band, the mid->far cut-over band (3*d), deep far band, and uniform blurs
 *    against an exact 2D erf stop-ladder full-resolution reference (cross-checked <= 2/255
 *    against direct full-resolution GPU on the same engine).
 * 3. Area-correct prefilter on thin stripes and glyph-scale bars under wide blur (eliminating
 *    Porter-Duff AA conflation tone washout).
 * 4. Review follow-ups: Noise post-effect scope stays in device-resolution reader-halo mode,
 *    native-fitting LayerBlur scope stays at device resolution and matches full-resolution
 *    reference, and fractional clip edges (EdgeMode::Clamp and EdgeMode::Border) eliminate
 *    outside-paint leakage and half-texel border shifts.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FLAG, GLASS_KIND, ListWriter, MASK, ROOT, type WireRecord } from "@drawpane/engine/wire";
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
const origin = `http://localhost:${process.env.ENGINE_ZOOM_BLUR_ORIGIN_PORT ?? "18593"}`;

type DisjointRect = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: [number, number, number];
};

type DiffStats = {
  max: number;
  p99: number;
  mean: number;
  over4: number;
  pixels: number;
};

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

/**
 * Helper to build the exact reviewer probe-pb.ts overlapping backdrop (dark horizontal stripes,
 * thin blue vertical bars, 40 red/green blocks) plus a progressive or uniform blur.
 */
function buildProbePbScene(opts: {
  radius: number;
  startRadius?: number;
  uniform?: boolean;
  isolated?: boolean;
  k: number;
  driverRadius?: number;
  driverAt?: [number, number];
  blurBox?: [number, number, number, number];
}): number[] {
  const list = new ListWriter(0xffffffff, 1);
  list.reset();
  let nextId = 1;
  const addRect = (
    parent: number,
    x: number,
    y: number,
    w: number,
    h: number,
    ops: WireRecord["ops"],
    flags = 0,
    opacity = 1,
  ) => {
    const id = nextId++;
    list.set(id, parent, {
      flags,
      transform: [1, 0, 0, 1, x, y],
      opacity,
      width: w,
      height: h,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w, h, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops,
      coarse: [],
    });
    return id;
  };
  const solid = (color: readonly [number, number, number, number]): WireRecord["ops"] => [
    { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } },
  ];

  // Page white fill so isolated opacity groups blend against deterministic white.
  addRect(ROOT, -400, -400, 1200, 1200, solid([1, 1, 1, 1]));

  const parent = opts.isolated
    ? addRect(ROOT, -120, -120, 340, 340, [{ op: "children" }], FLAG.isolate, 0.75)
    : ROOT;
  const off = opts.isolated ? 120 : 0;

  const k = opts.k;
  for (let i = 0; i < Math.ceil(300 / k); i++) {
    const y = -100 + i * k;
    addRect(parent, -100 + off, y + off, 300, 0.5 * k, solid([16 / 255, 16 / 255, 16 / 255, 1]));
  }
  for (let i = 0; i < Math.ceil(120 / k); i++) {
    const x = -100 + i * 2.5 * k;
    addRect(parent, x + off, -100 + off, 0.3 * k, 300, solid([16 / 255, 64 / 255, 208 / 255, 1]));
  }
  const m = Math.min(k, 3);
  for (let i = 0; i < 40; i++) {
    const x = ((i % 8) * 12 + 2) * m;
    const y = (Math.floor(i / 8) * 9 + 4) * m;
    addRect(
      parent,
      x + off,
      y + off,
      (3 + (i % 3)) * m,
      (2 + (i % 4)) * m,
      solid(i % 2 ? [208 / 255, 25 / 255, 18 / 255, 1] : [24 / 255, 160 / 255, 64 / 255, 1]),
    );
  }

  const [bx, by, bw, bh] = opts.blurBox ?? [0, 0, 100, 100];
  addRect(
    parent,
    bx + off,
    by + off,
    bw,
    bh,
    opts.uniform
      ? [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius: opts.radius }]
      : [
          {
            op: "progressiveBlur",
            paths: [0],
            evenOdd: false,
            startRadius: opts.startRadius ?? 0,
            endRadius: opts.radius,
            start: [0, 0],
            end: [0, 1],
          },
        ],
  );

  // Optional tiny non-overlapping driver blur at the corner of the viewport to push far_divisor
  // naturally to d >= 64 while leaving the measured blur untouched.
  if (opts.driverRadius && opts.driverAt) {
    addRect(ROOT, opts.driverAt[0], opts.driverAt[1], 0.2, 0.2, [
      { op: "backgroundBlur", paths: [0], evenOdd: false, radius: opts.driverRadius },
    ]);
  }
  return [...list.finish()];
}

/**
 * Builds a disjoint-rectangle scene (stripes + vertical bars + colored blocks) in page units
 * along with the exact same rectangles for the analytic 2D erf full-resolution oracle.
 */
function buildDisjointExtremeZoomScene(opts: {
  zoom: number;
  dpr: number;
  radius: number;
  uniform?: boolean;
  isolated?: boolean;
  /** Stripe period in device pixels at (zoom * dpr). */
  stripePeriodPx: number;
  /** Feature span in device pixels centered around the view window. */
  centerPage: [number, number];
  /** Blur rect in page units [x, y, w, h]. */
  blurRect: [number, number, number, number];
  /** Optional thin-stripe fill ratio (default 0.5). */
  duty?: number;
}): { bytes: number[]; rects: DisjointRect[]; bg: [number, number, number] } {
  const s = opts.zoom * opts.dpr;
  const period = opts.stripePeriodPx / s;
  const duty = opts.duty ?? 0.5;
  const [cx, cy] = opts.centerPage;
  const [bx, by, bw, bh] = opts.blurRect;

  // Cover plenty of support around the view (>= 4 * sigma_max or >= 40000 px).
  const halfSpan = Math.max(4 * 0.45 * opts.radius + 4, 8000 / s);
  const xMin = cx - halfSpan;
  const xMax = cx + halfSpan;
  const yMin = cy - halfSpan;
  const yMax = cy + halfSpan;

  // Carve a clean disjoint central block band around (cx, cy) so stripes and colored blocks
  // never overlap (making the 2D erf integral exact with zero overlap ambiguity).
  const bandHalf = (opts.stripePeriodPx * 3) / s;
  const blockX0 = cx - bandHalf;
  const blockX1 = cx + bandHalf;
  const blockY0 = cy - bandHalf;
  const blockY1 = cy + bandHalf;

  const rects: DisjointRect[] = [];
  // Limit stripe count to keep display list compact while covering full support.
  const maxStripes = 120;
  const yStart = Math.max(yMin, cy - (maxStripes / 2) * period);
  const yEnd = Math.min(yMax, cy + (maxStripes / 2) * period);
  const dark: [number, number, number] = [16, 16, 16];
  const blue: [number, number, number] = [16, 64, 208];
  const red: [number, number, number] = [208, 25, 18];
  const green: [number, number, number] = [24, 160, 64];

  for (let i = 0; ; i++) {
    const y0 = yStart + i * period;
    if (y0 >= yEnd) break;
    const y1 = y0 + period * duty;
    if (y1 <= blockY0 || y0 >= blockY1) {
      rects.push({ x0: xMin, y0, x1: xMax, y1, color: dark });
    } else {
      rects.push({ x0: xMin, y0, x1: blockX0, y1, color: dark });
      rects.push({ x0: blockX1, y0, x1: xMax, y1, color: dark });
    }
  }
  // Disjoint colored blocks and vertical bars inside the central block band.
  const cellW = (blockX1 - blockX0) / 6;
  const cellH = (blockY1 - blockY0) / 6;
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      if ((row + col) % 2 === 1) continue;
      const rx0 = blockX0 + col * cellW + cellW * 0.1;
      const ry0 = blockY0 + row * cellH + cellH * 0.1;
      const rx1 = rx0 + cellW * 0.7;
      const ry1 = ry0 + cellH * 0.65;
      const color = (row + col) % 4 === 0 ? red : col % 3 === 0 ? blue : green;
      rects.push({ x0: rx0, y0: ry0, x1: rx1, y1: ry1, color });
    }
  }

  const list = new ListWriter(0xffffffff, 1);
  list.reset();
  let nextId = 1;
  const addRect = (
    parent: number,
    x: number,
    y: number,
    w: number,
    h: number,
    ops: WireRecord["ops"],
    flags = 0,
    opacity = 1,
  ) => {
    const id = nextId++;
    list.set(id, parent, {
      flags,
      transform: [1, 0, 0, 1, x, y],
      opacity,
      width: w,
      height: h,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w, h, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops,
      coarse: [],
    });
    return id;
  };
  const solid = (c: [number, number, number]): WireRecord["ops"] => [
    {
      op: "fill",
      path: 0,
      evenOdd: false,
      paint: { kind: "solid", color: [c[0] / 255, c[1] / 255, c[2] / 255, 1] },
    },
  ];

  // Solid white backdrop covering full reach.
  addRect(ROOT, xMin - 10, yMin - 10, xMax - xMin + 20, yMax - yMin + 20, solid([255, 255, 255]));
  const parent = opts.isolated
    ? addRect(ROOT, xMin, yMin, xMax - xMin, yMax - yMin, [{ op: "children" }], FLAG.isolate, 0.75)
    : ROOT;
  const ox = opts.isolated ? -xMin : 0;
  const oy = opts.isolated ? -yMin : 0;
  if (opts.isolated) {
    addRect(parent, 0, 0, xMax - xMin, yMax - yMin, solid([255, 255, 255]));
  }
  for (const r of rects) {
    addRect(parent, r.x0 + ox, r.y0 + oy, r.x1 - r.x0, r.y1 - r.y0, solid(r.color));
  }
  addRect(
    parent,
    bx + ox,
    by + oy,
    bw,
    bh,
    opts.uniform
      ? [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius: opts.radius }]
      : [
          {
            op: "progressiveBlur",
            paths: [0],
            evenOdd: false,
            startRadius: 0,
            endRadius: opts.radius,
            start: [0, 0],
            end: [0, 1],
          },
        ],
  );
  return { bytes: [...list.finish()], rects, bg: [255, 255, 255] };
}

/** Exact stop ladder matching `packages/engine/rust/src/progressive_blur.rs::choose_stops`. */
function chooseStops(minS: number, maxS: number): number[] {
  const lo = Math.max(0, minS);
  const hi = Math.max(lo, maxS);
  if (hi - lo < 1e-4) return [lo];
  const SHIFT = 0.75;
  const u0 = Math.log(lo + SHIFT);
  const u1 = Math.log(hi + SHIFT);
  const intervals = Math.min(11, Math.max(1, Math.ceil((u1 - u0) / 0.15)));
  const stops: number[] = [];
  for (let i = 0; i <= intervals; i++) {
    if (i === 0) stops.push(lo);
    else if (i === intervals) stops.push(hi);
    else {
      const f = i / intervals;
      const u = u0 + (u1 - u0) * f;
      stops.push(Math.min(hi, Math.max(lo, Math.exp(u) - SHIFT)));
    }
  }
  return stops;
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-a * a));
}

function evalDisjointBlurAt(
  rects: readonly DisjointRect[],
  bg: readonly [number, number, number],
  px: number,
  py: number,
  sigmaPage: number,
): [number, number, number] {
  let r = bg[0];
  let g = bg[1];
  let b = bg[2];
  if (sigmaPage < 1e-5) {
    for (const rc of rects) {
      if (px >= rc.x0 && px < rc.x1 && py >= rc.y0 && py < rc.y1) {
        return [rc.color[0], rc.color[1], rc.color[2]];
      }
    }
    return [r, g, b];
  }
  const inv = 1 / (sigmaPage * Math.SQRT2);
  const reach = 4.5 * sigmaPage;
  for (const rc of rects) {
    if (rc.x1 < px - reach || rc.x0 > px + reach || rc.y1 < py - reach || rc.y0 > py + reach) {
      continue;
    }
    const wx = 0.5 * (erf((rc.x1 - px) * inv) - erf((rc.x0 - px) * inv));
    if (wx <= 1e-7) continue;
    const wy = 0.5 * (erf((rc.y1 - py) * inv) - erf((rc.y0 - py) * inv));
    const w = wx * wy;
    if (w > 1e-7) {
      r += (rc.color[0] - bg[0]) * w;
      g += (rc.color[1] - bg[1]) * w;
      b += (rc.color[2] - bg[2]) * w;
    }
  }
  return [r, g, b];
}

function diffRegions(
  actual: Uint8Array | number[],
  expected: Uint8Array | number[],
  w: number,
  h: number,
  crop?: [number, number, number, number],
): DiffStats {
  const [x0, y0, x1, y1] = crop ?? [0, 0, w, h];
  const diffs: number[] = [];
  let max = 0;
  let sum = 0;
  let over4 = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const d = Math.max(
        Math.abs((actual[i] ?? 0) - (expected[i] ?? 0)),
        Math.abs((actual[i + 1] ?? 0) - (expected[i + 1] ?? 0)),
        Math.abs((actual[i + 2] ?? 0) - (expected[i + 2] ?? 0)),
      );
      diffs.push(d);
      if (d > max) max = d;
      sum += d;
      if (d > 4) over4++;
    }
  }
  diffs.sort((a, b) => a - b);
  const p99 = diffs[Math.floor((diffs.length - 1) * 0.99)] ?? 0;
  return {
    max,
    p99,
    mean: diffs.length ? sum / diffs.length : 0,
    over4,
    pixels: diffs.length,
  };
}

for (const build of ["browser", "webgl"] as const) {
  test.describe(`High-zoom backdrop blur fidelity (${build})`, () => {
    test("direct GPU-vs-GPU full-res reference at d=64 across stripes, bars, blocks, and isolated scope", async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await openEngine(page, build);
      const expectedBackend = build === "webgl" ? "webgl2" : "webgpu";

      // Scene: zoom=5, dpr=2 (s=10). Blur box matches the 192x160 viewport with radius 0->48
      // (sigma_max=216 px). A tiny corner driver blur (radius=680 on software limit=512, or
      // radius=1050 on hardware limit=1024) pushes d_far=64 naturally so stops span
      // native (<32), mid ([32,192)), and far (>=192). Full-res reference omits the driver blur.
      const tw = 192;
      const th = 160;
      const zoom = 5;
      const dpr = 2;
      const s = zoom * dpr;
      const blurBox: [number, number, number, number] = [20, 0, tw / s, th / s];
      const testOrigin: [number, number] = [20, 0];
      const driverAt: [number, number] = [
        testOrigin[0] + (tw - 2) / s,
        testOrigin[1] + (th - 2) / s,
      ];

      const cases = [
        {
          name: "progressive-d64-plain",
          refBytes: buildProbePbScene({ radius: 48, k: 4, blurBox }),
          testBytesSoft: buildProbePbScene({
            radius: 48,
            k: 4,
            blurBox,
            driverRadius: 680,
            driverAt,
          }),
          testBytesHw: buildProbePbScene({
            radius: 48,
            k: 4,
            blurBox,
            driverRadius: 1050,
            driverAt,
          }),
        },
        {
          name: "progressive-d64-isolated",
          refBytes: buildProbePbScene({ radius: 48, k: 4, blurBox, isolated: true }),
          testBytesSoft: buildProbePbScene({
            radius: 48,
            k: 4,
            blurBox,
            isolated: true,
            driverRadius: 680,
            driverAt,
          }),
          testBytesHw: buildProbePbScene({
            radius: 48,
            k: 4,
            blurBox,
            isolated: true,
            driverRadius: 1050,
            driverAt,
          }),
        },
        {
          name: "uniform-d64-at-3d",
          refBytes: buildProbePbScene({ radius: 48, uniform: true, k: 4, blurBox }),
          testBytesSoft: buildProbePbScene({
            radius: 48,
            uniform: true,
            k: 4,
            blurBox,
            driverRadius: 680,
            driverAt,
          }),
          testBytesHw: buildProbePbScene({
            radius: 48,
            uniform: true,
            k: 4,
            blurBox,
            driverRadius: 1050,
            driverAt,
          }),
        },
      ];

      const margin = Math.ceil(3.6 * 0.45 * 48) + 4; // 82 page units = 820 device px (> 3.5*sigma)
      const refOrigin: [number, number] = [testOrigin[0] - margin, testOrigin[1] - margin];
      const refW = tw + 2 * margin * s;
      const refH = th + 2 * margin * s;
      const ox = Math.round((testOrigin[0] - refOrigin[0]) * s);
      const oy = Math.round((testOrigin[1] - refOrigin[1]) * s);

      const results = await page.evaluate(
        async ({
          cases,
          expectedBackend,
          tw,
          th,
          refW,
          refH,
          zoom,
          dpr,
          testOrigin,
          refOrigin,
          ox,
          oy,
        }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const bg = new Float32Array([1, 1, 1, 1]);
          const requireOk = (o: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = o;
            o.free();
            if (!ok) throw new Error(message);
          };
          const renderOnce = async (
            bytesSoft: number[],
            bytesHw: number[],
            w: number,
            h: number,
            originPage: [number, number],
            editorViewport: boolean,
          ) => {
            const dev = await glue.createGpu(null, 0);
            if (!dev.ok) throw new Error(dev.message);
            if (dev.backend !== expectedBackend) throw new Error(`wrong backend ${dev.backend}`);
            const bytes = dev.fallback ? bytesSoft : bytesHw;
            const engine = new glue.Engine(0, 0);
            try {
              if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels) {
                throw new Error("missing GPU entry points");
              }
              requireOk(engine.attachGpu(dev));
              dev.free();
              requireOk(engine.apply(new Uint8Array(bytes)));
              const out = engine.renderGpu(
                w,
                h,
                zoom,
                -originPage[0] * zoom,
                -originPage[1] * zoom,
                dpr,
                bg,
                false,
                0,
                editorViewport,
              );
              const plan = out.plan;
              const exact = out.exact;
              requireOk(out);
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
              return { plan, exact, px };
            } finally {
              engine.free();
            }
          };

          const renderCpuRef = (
            bytes: number[],
            w: number,
            h: number,
            originPage: [number, number],
          ) => {
            const engine = new glue.Engine(0, 0);
            try {
              requireOk(engine.apply(new Uint8Array(bytes)));
              requireOk(
                engine.renderCpu(
                  w,
                  h,
                  zoom,
                  -originPage[0] * zoom,
                  -originPage[1] * zoom,
                  dpr,
                  bg,
                  true,
                ),
              );
              const px = engine.pixels();
              return { plan: 0, exact: true, px: new Uint8Array(px) };
            } finally {
              engine.free();
            }
          };

          const out = [];
          for (const c of cases) {
            const ref = renderCpuRef(c.refBytes, refW, refH, refOrigin);
            const testRun = await renderOnce(
              c.testBytesSoft,
              c.testBytesHw,
              tw,
              th,
              testOrigin,
              true,
            );
            // Crop ref to tw x th, excluding 4px corner where driver blur sits.
            const diffs: number[] = [];
            let max = 0;
            let sum = 0;
            for (let y = 0; y < th - 4; y++) {
              for (let x = 0; x < tw - 4; x++) {
                const ti = (y * tw + x) * 4;
                const ri = ((oy + y) * refW + (ox + x)) * 4;
                const d = Math.max(
                  Math.abs((testRun.px[ti] ?? 0) - (ref.px[ri] ?? 0)),
                  Math.abs((testRun.px[ti + 1] ?? 0) - (ref.px[ri + 1] ?? 0)),
                  Math.abs((testRun.px[ti + 2] ?? 0) - (ref.px[ri + 2] ?? 0)),
                );
                diffs.push(d);
                if (d > max) max = d;
                sum += d;
              }
            }
            diffs.sort((a, b) => a - b);
            const p99 = diffs[Math.floor((diffs.length - 1) * 0.99)] ?? 0;
            out.push({
              name: c.name,
              refPlan: ref.plan,
              testPlan: testRun.plan,
              max,
              p99,
              mean: Math.round((sum / diffs.length) * 100) / 100,
            });
          }
          return out;
        },
        { cases, expectedBackend, tw, th, refW, refH, zoom, dpr, testOrigin, refOrigin, ox, oy },
      );

      for (const r of results) {
        console.log(
          `[zoom-blur ${build}] ${r.name}: plan=${r.testPlan} max=${r.max} p99=${r.p99} mean=${r.mean}`,
        );
        expect(r.testPlan, `${r.name} must run reader-halo (plan 4)`).toBe(4);
        expect(r.max, `${r.name} max=${r.max} p99=${r.p99} mean=${r.mean}`).toBeLessThanOrEqual(4);
        expect(r.p99, `${r.name} max=${r.max} p99=${r.p99} mean=${r.mean}`).toBeLessThanOrEqual(2);
      }
    });

    test("extreme zoom 25,600% (d=128 and d=256 naturally) matches exact full-res stop-ladder oracle", async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await openEngine(page, build);
      const expectedBackend = build === "webgl" ? "webgl2" : "webgpu";

      // 1. Control check: verify our 2D erf stop-ladder oracle matches direct full-res GPU
      //    (editorViewport=false) within <= 2/255 at zoom=5, radius=32 (sigma_max=144).
      // 2. Real 25,600% zoom (zoom=256, dpr=2 -> s=512):
      //    - radius 0->40 (sigma_max=9216, d_far=128 on SwiftShader / 64 on hardware)
      //      sampled across Band A (native->mid transition, sigma 0..90),
      //      Band B (mid->far transition crossing 3*d_far=384, sigma 280..520),
      //      and Band C (deep far band, sigma 900..1500), plus isolated opacity=0.75.
      //    - radius 0->80 (sigma_max=18432, d_far=256 on SwiftShader / 128 on hardware)
      //      sampled across the mid->far transition crossing 3*256=768 px!
      //    - uniform backgroundBlur at 25,600% (radius=40, sigma=9216, d_far=128).
      const w = 192;
      const h = 192;
      const scenarios = [
        {
          name: "control-fullres-oracle",
          zoom: 5,
          dpr: 2,
          radius: 18,
          uniform: false,
          isolated: false,
          stripePeriodPx: 36,
          blurRect: [0, 0, 80, 24] as [number, number, number, number],
          viewOrigin: [20, 2] as [number, number],
          editorViewport: false,
          expectPlan: 2,
        },
        {
          name: "25600pct-d128-native-to-mid",
          zoom: 256,
          dpr: 2,
          radius: 40,
          uniform: false,
          isolated: false,
          stripePeriodPx: 96,
          blurRect: [0, 0, 100, 100] as [number, number, number, number],
          // At sigma_max=9216 over 51200 px, slope = 0.18 sigma/px.
          // y_dev in [100, 292] -> sigma in [18, 52.6] crossing native->mid cut-over (32 px).
          viewOrigin: [50, 100 / 512] as [number, number],
          editorViewport: true,
          expectPlan: 4,
        },
        {
          name: "25600pct-d128-mid-to-far",
          zoom: 256,
          dpr: 2,
          radius: 40,
          uniform: false,
          isolated: false,
          // Resonant stripe period ~1.06 * d_far = 136 px!
          stripePeriodPx: 136,
          // With bh=16 units (8192 px), slope = 9216/8192 = 1.125 sigma/px.
          // y_dev in [240, 432] -> sigma in [270, 486], crossing 3*128=384 right in the middle!
          blurRect: [0, 0, 100, 16] as [number, number, number, number],
          viewOrigin: [50, 240 / 512] as [number, number],
          editorViewport: true,
          expectPlan: 4,
        },
        {
          name: "25600pct-d128-isolated-mid-to-far",
          zoom: 256,
          dpr: 2,
          radius: 40,
          uniform: false,
          isolated: true,
          stripePeriodPx: 136,
          blurRect: [0, 0, 100, 16] as [number, number, number, number],
          viewOrigin: [50, 240 / 512] as [number, number],
          editorViewport: true,
          expectPlan: 4,
        },
        {
          name: "25600pct-d256-mid-to-far",
          zoom: 256,
          dpr: 2,
          radius: 80,
          uniform: false,
          isolated: false,
          // Resonant stripe period ~1.06 * 256 = 272 px!
          stripePeriodPx: 272,
          // sigma_max=18432 over bh=16 units (8192 px) -> slope = 2.25 sigma/px.
          // y_dev in [256, 448] -> sigma in [576, 1008], crossing 3*256=768 right in the middle!
          blurRect: [0, 0, 100, 16] as [number, number, number, number],
          viewOrigin: [50, 256 / 512] as [number, number],
          editorViewport: true,
          expectPlan: 4,
        },
        {
          name: "25600pct-d128-uniform",
          zoom: 256,
          dpr: 2,
          radius: 40,
          uniform: true,
          isolated: false,
          stripePeriodPx: 512,
          blurRect: [0, 0, 100, 100] as [number, number, number, number],
          viewOrigin: [50, 50] as [number, number],
          editorViewport: true,
          expectPlan: 4,
        },
      ];
      const built = scenarios.map((sc) => {
        const s = sc.zoom * sc.dpr;
        const centerPage: [number, number] = [
          sc.viewOrigin[0] + w / (2 * s),
          sc.viewOrigin[1] + h / (2 * s),
        ];
        const scene = buildDisjointExtremeZoomScene({
          zoom: sc.zoom,
          dpr: sc.dpr,
          radius: sc.radius,
          uniform: sc.uniform,
          isolated: sc.isolated,
          stripePeriodPx: sc.stripePeriodPx,
          centerPage,
          blurRect: sc.blurRect,
        });
        return { ...sc, bytes: scene.bytes, rects: scene.rects, bg: scene.bg };
      });

      const gpuFrames = await page.evaluate(
        async ({ items, expectedBackend, w, h }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const bg = new Float32Array([1, 1, 1, 1]);
          const requireOk = (o: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = o;
            o.free();
            if (!ok) throw new Error(message);
          };
          const out = [];
          for (const item of items) {
            const dev = await glue.createGpu(null, 0);
            if (!dev.ok) throw new Error(dev.message);
            if (dev.backend !== expectedBackend) throw new Error(`wrong backend ${dev.backend}`);
            const engine = new glue.Engine(0, 0);
            try {
              if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels) {
                throw new Error("missing GPU entry points");
              }
              requireOk(engine.attachGpu(dev));
              dev.free();
              requireOk(engine.apply(new Uint8Array(item.bytes)));
              const pad = item.editorViewport
                ? 0
                : Math.ceil(3.6 * 0.45 * item.radius * item.zoom * item.dpr) + 8;
              const rw = w + 2 * pad;
              const rh = h + 2 * pad;
              const ox = item.viewOrigin[0] - pad / (item.zoom * item.dpr);
              const oy = item.viewOrigin[1] - pad / (item.zoom * item.dpr);
              const res = engine.renderGpu(
                rw,
                rh,
                item.zoom,
                -ox * item.zoom,
                -oy * item.zoom,
                item.dpr,
                bg,
                false,
                0,
                item.editorViewport,
              );
              const plan = res.plan;
              requireOk(res);
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
              const crop = new Uint8Array(w * h * 4);
              for (let y = 0; y < h; y++) {
                const srcOff = ((pad + y) * rw + pad) * 4;
                crop.set(px.subarray(srcOff, srcOff + w * 4), y * w * 4);
              }
              out.push({ name: item.name, plan, pixels: Array.from(crop) });
            } finally {
              engine.free();
            }
          }
          return out;
        },
        {
          items: built.map((b) => ({
            name: b.name,
            bytes: b.bytes,
            zoom: b.zoom,
            dpr: b.dpr,
            radius: b.radius,
            viewOrigin: b.viewOrigin,
            editorViewport: b.editorViewport,
          })),
          expectedBackend,
          w,
          h,
        },
      );

      for (let i = 0; i < built.length; i++) {
        const sc = built[i];
        const frame = gpuFrames[i];
        if (!sc || !frame) throw new Error(`missing scenario ${i}`);
        expect(frame.plan, `${sc.name} plan`).toBe(sc.expectPlan);
        const s = sc.zoom * sc.dpr;
        const sigmaMax = 0.45 * sc.radius * s;
        const stops = sc.uniform ? [sigmaMax] : chooseStops(0, sigmaMax);
        const expected = new Uint8Array(w * h * 4);
        const [, by, , bh] = sc.blurRect;
        for (let y = 0; y < h; y++) {
          const py = sc.viewOrigin[1] + (y + 0.5) / s;
          const t = Math.min(1, Math.max(0, (py - by) / bh));
          const sigmaDev = sc.uniform ? sigmaMax : sigmaMax * t;
          let lo = 0;
          let hi = 0;
          let frac = 0;
          if (!sc.uniform && stops.length > 1) {
            lo = stops.length - 2;
            hi = stops.length - 1;
            for (let k = 0; k < stops.length - 1; k++) {
              if (sigmaDev <= (stops[k + 1] ?? sigmaMax)) {
                lo = k;
                hi = k + 1;
                break;
              }
            }
            const sLo = stops[lo] ?? 0;
            const sHi = stops[hi] ?? sigmaMax;
            frac = Math.min(
              1,
              Math.max(
                0,
                (sigmaDev * sigmaDev - sLo * sLo) / Math.max(sHi * sHi - sLo * sLo, 1e-6),
              ),
            );
          }
          const stopLo = stops[lo] ?? 0;
          const stopHi = stops[hi] ?? sigmaMax;
          for (let x = 0; x < w; x++) {
            const px = sc.viewOrigin[0] + (x + 0.5) / s;
            let rgb: [number, number, number];
            if (sc.uniform || lo === hi) {
              rgb = evalDisjointBlurAt(sc.rects, sc.bg, px, py, stopLo / s);
            } else {
              const c0 = evalDisjointBlurAt(sc.rects, sc.bg, px, py, stopLo / s);
              const c1 = evalDisjointBlurAt(sc.rects, sc.bg, px, py, stopHi / s);
              rgb = [
                c0[0] + (c1[0] - c0[0]) * frac,
                c0[1] + (c1[1] - c0[1]) * frac,
                c0[2] + (c1[2] - c0[2]) * frac,
              ];
            }
            if (sc.isolated) {
              // Isolated opacity=0.75 over white page: 0.75 * rgb + 0.25 * 255
              rgb = [
                rgb[0] * 0.75 + 255 * 0.25,
                rgb[1] * 0.75 + 255 * 0.25,
                rgb[2] * 0.75 + 255 * 0.25,
              ];
            }
            const off = (y * w + x) * 4;
            expected[off] = Math.round(rgb[0]);
            expected[off + 1] = Math.round(rgb[1]);
            expected[off + 2] = Math.round(rgb[2]);
            expected[off + 3] = 255;
          }
        }
        const stats = diffRegions(frame.pixels, expected, w, h);
        console.log(
          `[zoom-blur ${build}] ${sc.name}: plan=${frame.plan} max=${stats.max} p99=${stats.p99} mean=${stats.mean.toFixed(2)}`,
        );
        const maxGate = sc.name === "control-fullres-oracle" ? 2 : 4;
        expect(
          stats.max,
          `${sc.name}: max=${stats.max} p99=${stats.p99} mean=${stats.mean.toFixed(2)}`,
        ).toBeLessThanOrEqual(maxGate);
        expect(
          stats.p99,
          `${sc.name}: max=${stats.max} p99=${stats.p99} mean=${stats.mean.toFixed(2)}`,
        ).toBeLessThanOrEqual(2);
      }
    });

    test("area-correct prefilter preserves tone of thin stripes under wide blur (no AA conflation)", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openEngine(page, build);
      const expectedBackend = build === "webgl" ? "webgl2" : "webgpu";

      // Fine stripes: height 0.5 unit (5 px dark #101010, 5 px white #ffffff -> true mean 135.5)
      // at zoom=5, dpr=2 (s=10) under wide blur radius=220 (sigma=990 px, reach=3465 px ->
      // span ~7200 px -> d_far=16 on SwiftShader, S=4 -> d_render=4 <= 5px gap -> zero conflation!).
      // Without supersampling (d_render=16), Vello AA conflation washed this ~15-25/255 lighter.
      const w = 192;
      const h = 192;
      const zoom = 5;
      const dpr = 2;
      const s = zoom * dpr;
      const list = new ListWriter(0xffffffff, 1);
      list.reset();
      let id = 1;
      const rect = (x: number, y: number, rw: number, rh: number, ops: WireRecord["ops"]) => {
        list.set(id++, ROOT, {
          flags: 0,
          transform: [1, 0, 0, 1, x, y],
          opacity: 1,
          width: rw,
          height: rh,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [{ kind: "rect", w: rw, h: rh, radii: [0, 0, 0, 0], smoothing: 0 }],
          ops,
          coarse: [],
        });
      };
      // White base across full reach [-450, 450]
      rect(-450, -450, 900, 900, [
        { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 1, 1, 1] } },
      ]);
      // 900 thin horizontal stripes: height 0.5 units every 1.0 unit (5 px stripe, 5 px gap).
      for (let y = -450; y < 450; y += 1) {
        rect(-450, y, 900, 0.5, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [16 / 255, 16 / 255, 16 / 255, 1] },
          },
        ]);
      }
      // Wide uniform background blur covering view.
      rect(-40, -40, 80, 80, [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius: 220 }]);
      const bytes = [...list.finish()];

      const res = await page.evaluate(
        async ({ bytes, expectedBackend, w, h, zoom, dpr }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const dev = await glue.createGpu(null, 0);
          if (!dev.ok) throw new Error(dev.message);
          if (dev.backend !== expectedBackend) throw new Error(`wrong backend ${dev.backend}`);
          const engine = new glue.Engine(0, 0);
          const bg = new Float32Array([1, 1, 1, 1]);
          try {
            const check = (o: { ok: boolean; message: string; free(): void }) => {
              const { ok, message } = o;
              o.free();
              if (!ok) throw new Error(message);
            };
            if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels) {
              throw new Error("missing GPU entry points");
            }
            check(engine.attachGpu(dev));
            dev.free();
            check(engine.apply(new Uint8Array(bytes)));
            const out = engine.renderGpu(
              w,
              h,
              zoom,
              w / (2 * dpr),
              h / (2 * dpr),
              dpr,
              bg,
              false,
              0,
              true,
            );
            const plan = out.plan;
            check(out);
            const px = await engine.gpuPixels();
            if (!(px instanceof Uint8Array)) throw new Error(px.message);
            const diffs: number[] = [];
            let max = 0;
            let sumVal = 0;
            const target = 135.5; // exact 50/50 mix of 16 and 255
            for (let i = 0; i < w * h; i++) {
              const v = px[i * 4] ?? 0;
              sumVal += v;
              const d = Math.abs(v - Math.round(target));
              diffs.push(d);
              if (d > max) max = d;
            }
            diffs.sort((a, b) => a - b);
            return {
              plan,
              max,
              p99: diffs[Math.floor((diffs.length - 1) * 0.99)] ?? 0,
              meanVal: sumVal / (w * h),
            };
          } finally {
            engine.free();
          }
        },
        { bytes, expectedBackend, w, h, zoom, dpr },
      );
      console.log(
        `[zoom-blur ${build}] thin-stripes: plan=${res.plan} max=${res.max} p99=${res.p99} meanVal=${res.meanVal.toFixed(2)} (target 135.5)`,
      );
      expect(res.plan).toBe(4);
      expect(
        res.max,
        `thin stripes meanVal=${res.meanVal.toFixed(2)} (expected 135.5)`,
      ).toBeLessThanOrEqual(4);
      expect(res.p99, `thin stripes meanVal=${res.meanVal.toFixed(2)}`).toBeLessThanOrEqual(2);
      void s;
    });

    test("Noise and native-fitting LayerBlur scopes keep device resolution in reader-halo mode", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openEngine(page, build);
      const expectedBackend = build === "webgl" ? "webgl2" : "webgpu";

      const makeScoped = (postEffects: WireRecord["postEffects"]) => {
        const list = new ListWriter(0xffffffff, 1);
        list.reset();
        const rect = (
          id: number,
          parent: number,
          x: number,
          y: number,
          w: number,
          h: number,
          ops: WireRecord["ops"],
          flags = 0,
          post?: WireRecord["postEffects"],
        ) => {
          list.set(id, parent, {
            flags,
            transform: [1, 0, 0, 1, x, y],
            opacity: 1,
            width: w,
            height: h,
            coarseBelow: 0,
            reach: 0,
            unsupported: 0,
            paths: [{ kind: "rect", w, h, radii: [0, 0, 0, 0], smoothing: 0 }],
            ops,
            coarse: [],
            ...(post ? { postEffects: post } : {}),
          });
        };
        const solid = (c: readonly [number, number, number, number]): WireRecord["ops"] => [
          { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: c } },
        ];
        // Sharp 1-device-px edge on the left (outside the post scope) to prove device resolution.
        rect(1, ROOT, -100, -100, 100, 200, solid([0, 0, 0, 1]));
        rect(2, ROOT, 0, -100, 100, 200, solid([1, 1, 1, 1]));
        // Post-effect scope starting at x=0.5 (device x=192, 128 px past the sharp edge at x=64,
        // well outside the LayerBlur's ~42 px reach) holding a clipped wide backdrop blur (radius 40).
        // Clipping clamps the blur to the striped interior (exact mean 135.5) with no transparent edge.
        rect(
          3,
          ROOT,
          0.5,
          -100,
          200,
          200,
          [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
          FLAG.post,
          postEffects,
        );
        // Striped 50/50 backdrop inside the scope (mean 135.5) under wide blur (sigma 4608 px).
        rect(4, 3, 0, 0, 200, 200, solid([1, 1, 1, 1]));
        for (let i = 0; i < 40; i++) {
          rect(5 + i, 3, 0, i * 5, 200, 2.5, solid([16 / 255, 16 / 255, 16 / 255, 1]));
        }
        rect(50, 3, 0, 0, 200, 200, [
          { op: "backgroundBlur", paths: [0], evenOdd: false, radius: 40 },
        ]);
        return [...list.finish()];
      };

      const noiseBytes = makeScoped([
        {
          kind: "noise",
          noiseType: 0,
          size: 4,
          density: 50,
          color: [0.5, 0.5, 0.5, 0],
          secondaryColor: [0, 0, 0, 0],
          opacity: 1,
        },
      ]);
      // LayerBlur radius 0.1 at s=256 -> sigma_lb = 11.52 <= MAX_BLUR_SIGMA (fits natively; reach ~41 px).
      const layerBlurBytes = makeScoped([{ kind: "layerBlur", radius: 0.1 }]);

      const out = await page.evaluate(
        async ({ noiseBytes, layerBlurBytes, expectedBackend }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const bg = new Float32Array([1, 1, 1, 1]);
          const run = async (bytes: number[]) => {
            const dev = await glue.createGpu(null, 0);
            if (!dev.ok) throw new Error(dev.message);
            if (dev.backend !== expectedBackend) throw new Error(`wrong backend ${dev.backend}`);
            const engine = new glue.Engine(0, 0);
            try {
              const check = (o: { ok: boolean; message: string; free(): void }) => {
                const { ok, message } = o;
                o.free();
                if (!ok) throw new Error(message);
              };
              if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels) {
                throw new Error("missing GPU entry points");
              }
              check(engine.attachGpu(dev));
              dev.free();
              check(engine.apply(new Uint8Array(bytes)));
              // zoom=128, dpr=2 (s=256), 320x192 view: x=0 maps to device x=64,
              // post scope starts at page x=0.5 -> device x=192.
              const r = engine.renderGpu(320, 192, 128, 32, 48, 2, bg, false, 0, true);
              const plan = r.plan;
              const ok = r.ok;
              const msg = r.message;
              r.free();
              if (!ok) throw new Error(`renderGpu failed: ${msg}`);
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
              const at = (x: number, y: number) =>
                Array.from(px.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4));
              return {
                plan,
                leftSharp: at(63, 96),
                rightSharp: at(64, 96),
                nearScopeEdge: at(188, 96),
                insideScope: at(280, 96),
              };
            } finally {
              engine.free();
            }
          };
          return { noise: await run(noiseBytes), layerBlur: await run(layerBlurBytes) };
        },
        { noiseBytes, layerBlurBytes, expectedBackend },
      );

      for (const [label, r] of [
        ["noise", out.noise],
        ["layerBlur", out.layerBlur],
      ] as const) {
        console.log(
          `[zoom-blur ${build}] scope-${label}: plan=${r.plan} sharp=[${r.leftSharp[0]},${r.rightSharp[0]}] nearEdge=${r.nearScopeEdge[0]} inside=${r.insideScope[0]} (target 136)`,
        );
        expect(r.plan, `${label} must stay in device-resolution reader-halo`).toBe(4);
        expect(r.leftSharp, `${label} sharp black edge`).toEqual([0, 0, 0, 255]);
        expect(r.rightSharp, `${label} sharp white edge`).toEqual([255, 255, 255, 255]);
        // Deep inside the clipped scope (88 px past the scope edge, well past LayerBlur's 41 px
        // reach), the wide-blurred 50/50 striped backdrop must settle to ~135.5 within 4/255.
        expect(
          Math.abs((r.insideScope[0] ?? 0) - 136),
          `${label} inside=${r.insideScope}`,
        ).toBeLessThanOrEqual(4);
        expect(r.insideScope[3]).toBe(255);
      }
      // Verify LayerBlur actually blurred across x_dev=192 onto x_dev=188 while Noise did not.
      expect(out.noise.nearScopeEdge[0], "noise stays sharp outside scope").toBe(255);
      expect(out.layerBlur.nearScopeEdge[0], "layerBlur spreads outside scope").toBeLessThan(245);
    });

    test("fractional clip edges in reduced halo pass eliminate clamp leakage and border shift", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openEngine(page, build);
      const expectedBackend = build === "webgl" ? "webgl2" : "webgpu";

      // At zoom=128, dpr=2 (s=256), driverRadius=25 -> sigma=2880, replay_reach=11232, span~22.7k ->
      // d_far=64 on SwiftShader (512 cap), S=2 -> d_render=32 px (and on hardware d_far=32, d_render=8).
      // Place clip edge at odd x_dev=89 so it is fractional at EVERY power-of-two d_render >= 2!
      const w = 256;
      const h = 128;
      const zoom = 128;
      const dpr = 2;
      const s = zoom * dpr;
      const clipXDev = 89;
      const clipXPage = clipXDev / s;

      const makeClipScene = (solidFill: boolean, radius: number) => {
        const list = new ListWriter(0xffffffff, 1);
        list.reset();
        const rect = (
          id: number,
          parent: number,
          x: number,
          y: number,
          rw: number,
          rh: number,
          ops: WireRecord["ops"],
        ) => {
          list.set(id, parent, {
            flags: 0,
            transform: [1, 0, 0, 1, x, y],
            opacity: 1,
            width: rw,
            height: rh,
            coarseBelow: 0,
            reach: 0,
            unsupported: 0,
            paths: [{ kind: "rect", w: rw, h: rh, radii: [0, 0, 0, 0], smoothing: 0 }],
            ops,
            coarse: [],
          });
        };
        // Bright contrasting red paint outside the clip frame.
        rect(1, ROOT, -200, -200, 400, 400, [
          { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 0, 0, 1] } },
        ]);
        const clipOps: WireRecord["ops"] = solidFill
          ? [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: [1, 1, 1, 1] },
              },
              { op: "clip", path: 0, evenOdd: false },
              { op: "children" },
              { op: "unclip" },
            ]
          : [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }];
        rect(2, ROOT, clipXPage, -100, 200, 200, clipOps);
        // Dark interior paint covering the whole clip frame.
        rect(3, 2, 0, 0, 200, 200, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [16 / 255, 16 / 255, 16 / 255, 1] },
          },
        ]);
        rect(4, 2, 0, 0, 200, 200, [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius }]);
        return [...list.finish()];
      };

      // Use radius=2.0 (sigma=230.4 >= 3*64=192) with a driver blur pushing d_far=64 so the border
      // transition slope (1 / (sigma * sqrt(2*pi))) is steep enough to expose a half-texel shift.
      const makeClipWithDriver = (solidFill: boolean, radius: number, driverRadius: number) => {
        const list = new ListWriter(0xffffffff, 1);
        list.reset();
        const rect = (
          id: number,
          parent: number,
          x: number,
          y: number,
          rw: number,
          rh: number,
          ops: WireRecord["ops"],
        ) => {
          list.set(id, parent, {
            flags: 0,
            transform: [1, 0, 0, 1, x, y],
            opacity: 1,
            width: rw,
            height: rh,
            coarseBelow: 0,
            reach: 0,
            unsupported: 0,
            paths: [{ kind: "rect", w: rw, h: rh, radii: [0, 0, 0, 0], smoothing: 0 }],
            ops,
            coarse: [],
          });
        };
        rect(1, ROOT, -200, -200, 400, 400, [
          { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 0, 0, 1] } },
        ]);
        // Tiny corner driver blur at (0, 0) BEFORE the clipped frame pushes d_far=64 without
        // forcing the clipped frame onto the downstream-composite replay path.
        rect(2, ROOT, 0, 0, 1 / s, 1 / s, [
          { op: "backgroundBlur", paths: [0], evenOdd: false, radius: driverRadius },
        ]);
        const clipOps: WireRecord["ops"] = solidFill
          ? [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: [1, 1, 1, 1] },
              },
              { op: "clip", path: 0, evenOdd: false },
              { op: "children" },
              { op: "unclip" },
            ]
          : [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }];
        rect(3, ROOT, clipXPage, -100, 200, 200, clipOps);
        rect(4, 3, 0, 0, 200, 200, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [16 / 255, 16 / 255, 16 / 255, 1] },
          },
        ]);
        rect(5, 3, 0, 0, 200, 200, [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius }]);
        return [...list.finish()];
      };

      const clampBytes = makeClipScene(false, 25);
      // radius=2.0 -> sigma=230.4 (>= 3*64=192 -> far tier at d_far=64 on both software and hardware).
      const borderRadius = 2.0;
      const borderSigma = 0.45 * borderRadius * s;
      const borderBytesSoft = makeClipWithDriver(true, borderRadius, 25);
      const borderBytesHw = makeClipWithDriver(true, borderRadius, 42);
      // Unfilled EdgeMode::Clamp with a 1 px bright blue bar sitting right on the fractional
      // left clip edge [89, 90) and dark (16,16,16) for x >= 90, plus bright red outside x < 89.
      // At every render divisor >= 2, [89, 90) sits inside the straddling texel [88, 90), so
      // clamping to the clean interior [90, ...) drops the blue bar (~96/255 error), while exact
      // edge-strip prefiltering repeats blue outward and rejects red.
      const makeClampEdgeBar = (driverRadius: number) => {
        const list = new ListWriter(0xffffffff, 1);
        list.reset();
        const rect = (
          id: number,
          parent: number,
          x: number,
          y: number,
          rw: number,
          rh: number,
          ops: WireRecord["ops"],
        ) => {
          list.set(id, parent, {
            flags: 0,
            transform: [1, 0, 0, 1, x, y],
            opacity: 1,
            width: rw,
            height: rh,
            coarseBelow: 0,
            reach: 0,
            unsupported: 0,
            paths: [{ kind: "rect", w: rw, h: rh, radii: [0, 0, 0, 0], smoothing: 0 }],
            ops,
            coarse: [],
          });
        };
        rect(1, ROOT, -200, -200, 400, 400, [
          { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 0, 0, 1] } },
        ]);
        rect(2, ROOT, 0, 0, 1 / s, 1 / s, [
          { op: "backgroundBlur", paths: [0], evenOdd: false, radius: driverRadius },
        ]);
        rect(3, ROOT, clipXPage, -100, 200, 200, [
          { op: "clip", path: 0, evenOdd: false },
          { op: "children" },
          { op: "unclip" },
        ]);
        rect(4, 3, 0, 0, 200, 200, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [16 / 255, 16 / 255, 16 / 255, 1] },
          },
        ]);
        rect(5, 3, 0, 0, 1 / s, 200, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [16 / 255, 64 / 255, 208 / 255, 1] },
          },
        ]);
        rect(6, 3, 0, 0, 200, 200, [
          { op: "backgroundBlur", paths: [0], evenOdd: false, radius: borderRadius },
        ]);
        return [...list.finish()];
      };
      const clampEdgeBarSoft = makeClampEdgeBar(25);
      const clampEdgeBarHw = makeClampEdgeBar(42);

      const res = await page.evaluate(
        async ({
          clampBytes,
          clampEdgeBarSoft,
          clampEdgeBarHw,
          borderBytesSoft,
          borderBytesHw,
          expectedBackend,
          w,
          h,
          zoom,
          dpr,
        }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const bg = new Float32Array([1, 1, 1, 1]);
          const run = async (bytesSoft: number[], bytesHw: number[]) => {
            const dev = await glue.createGpu(null, 0);
            if (!dev.ok) throw new Error(dev.message);
            if (dev.backend !== expectedBackend) throw new Error(`wrong backend ${dev.backend}`);
            const bytes = dev.fallback ? bytesSoft : bytesHw;
            const engine = new glue.Engine(0, 0);
            try {
              const check = (o: { ok: boolean; message: string; free(): void }) => {
                const { ok, message } = o;
                o.free();
                if (!ok) throw new Error(message);
              };
              if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels) {
                throw new Error("missing GPU entry points");
              }
              check(engine.attachGpu(dev));
              dev.free();
              check(engine.apply(new Uint8Array(bytes)));
              const r = engine.renderGpu(w, h, zoom, 0, 0, dpr, bg, false, 0, true);
              const plan = r.plan;
              check(r);
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
              return { plan, px: Array.from(px) };
            } finally {
              engine.free();
            }
          };
          return {
            clamp: await run(clampBytes, clampBytes),
            clampEdgeBar: await run(clampEdgeBarSoft, clampEdgeBarHw),
            border: await run(borderBytesSoft, borderBytesHw),
          };
        },
        {
          clampBytes,
          clampEdgeBarSoft,
          clampEdgeBarHw,
          borderBytesSoft,
          borderBytesHw,
          expectedBackend,
          w,
          h,
          zoom,
          dpr,
        },
      );

      // Verify EdgeMode::Clamp inside clip frame [clipXDev, w): must be uniform (16, 16, 16), zero red leak.
      expect(res.clamp.plan).toBe(4);
      const clampExpected = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = clipXDev; x < w; x++) {
          const i = (y * w + x) * 4;
          clampExpected[i] = 16;
          clampExpected[i + 1] = 16;
          clampExpected[i + 2] = 16;
          clampExpected[i + 3] = 255;
        }
      }
      const clampStats = diffRegions(res.clamp.px, clampExpected, w, h, [clipXDev, 16, w, h - 16]);
      console.log(
        `[zoom-blur ${build}] clip-clamp: plan=${res.clamp.plan} max=${clampStats.max} p99=${clampStats.p99} mean=${clampStats.mean.toFixed(2)}`,
      );
      expect(clampStats.max, `EdgeMode::Clamp leak max=${clampStats.max}`).toBeLessThanOrEqual(4);
      expect(clampStats.p99, `EdgeMode::Clamp leak p99=${clampStats.p99}`).toBeLessThanOrEqual(2);

      // Verify EdgeMode::Clamp preserves the 1 px blue bar on [clipXDev, clipXDev+1) while
      // rejecting bright red outside the clip: exact 1D erf transition from blue to dark at x=90.
      expect(res.clampEdgeBar.plan).toBe(4);
      const edgeBarExpected = new Uint8Array(w * h * 4);
      const inv = 1 / (borderSigma * Math.SQRT2);
      for (let y = 0; y < h; y++) {
        for (let x = clipXDev; x < w; x++) {
          const wDark = 0.5 * (1 + erf((x + 0.5 - (clipXDev + 1)) * inv));
          const i = (y * w + x) * 4;
          edgeBarExpected[i] = Math.round(16 * (1 - wDark) + 16 * wDark);
          edgeBarExpected[i + 1] = Math.round(64 * (1 - wDark) + 16 * wDark);
          edgeBarExpected[i + 2] = Math.round(208 * (1 - wDark) + 16 * wDark);
          edgeBarExpected[i + 3] = 255;
        }
      }
      const edgeBarStats = diffRegions(res.clampEdgeBar.px, edgeBarExpected, w, h, [
        clipXDev,
        16,
        w,
        h - 16,
      ]);
      console.log(
        `[zoom-blur ${build}] clip-clamp-edge-bar: plan=${res.clampEdgeBar.plan} max=${edgeBarStats.max} p99=${edgeBarStats.p99} mean=${edgeBarStats.mean.toFixed(2)}`,
      );
      expect(
        edgeBarStats.max,
        `EdgeMode::Clamp edge bar max=${edgeBarStats.max}`,
      ).toBeLessThanOrEqual(4);
      expect(
        edgeBarStats.p99,
        `EdgeMode::Clamp edge bar p99=${edgeBarStats.p99}`,
      ).toBeLessThanOrEqual(2);

      // Verify EdgeMode::Border inside clip frame [clipXDev, w): exact 1D erf transition from 255 to 16 at clipXDev.
      expect(res.border.plan).toBe(4);
      const borderExpected = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = clipXDev; x < w; x++) {
          const wInside = 0.5 * (1 + erf((x + 0.5 - clipXDev) * inv));
          const v = Math.round(255 * (1 - wInside) + 16 * wInside);
          const i = (y * w + x) * 4;
          borderExpected[i] = v;
          borderExpected[i + 1] = v;
          borderExpected[i + 2] = v;
          borderExpected[i + 3] = 255;
        }
      }
      const borderStats = diffRegions(res.border.px, borderExpected, w, h, [
        clipXDev,
        16,
        w,
        h - 16,
      ]);
      console.log(
        `[zoom-blur ${build}] clip-border: plan=${res.border.plan} max=${borderStats.max} p99=${borderStats.p99} mean=${borderStats.mean.toFixed(2)}`,
      );
      expect(borderStats.max, `EdgeMode::Border shift max=${borderStats.max}`).toBeLessThanOrEqual(
        4,
      );
      expect(borderStats.p99, `EdgeMode::Border shift p99=${borderStats.p99}`).toBeLessThanOrEqual(
        2,
      );
    });

    test("isolated scope glass overlays interior paint onto reader prefix snapshot", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openEngine(page, build);
      const expectedBackend = build === "webgl" ? "webgl2" : "webgpu";

      const makeScopedGlassScene = (opts: { includeWideBlur: boolean }) => {
        const list = new ListWriter(0xffffffff, 1);
        list.reset();
        const addRect = (
          id: number,
          parent: number,
          x: number,
          y: number,
          rw: number,
          rh: number,
          ops: WireRecord["ops"],
          extra?: Partial<WireRecord>,
        ) => {
          list.set(id, parent, {
            flags: extra?.flags ?? 0,
            transform: [1, 0, 0, 1, x, y],
            opacity: extra?.opacity ?? 1,
            width: rw,
            height: rh,
            coarseBelow: 0,
            reach: 0,
            unsupported: 0,
            paths: [
              {
                kind: "rect",
                w: rw,
                h: rh,
                radii: [0, 0, 0, 0],
                smoothing: 0,
              },
            ],
            ops,
            coarse: [],
            ...extra,
          });
        };
        // Striped page backdrop behind the isolated scope.
        for (let i = 0; i < 8; i++) {
          addRect(10 + i, ROOT, -200, i * 16 - 40, 600, 8, [
            {
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: { kind: "solid", color: [0.15, 0.25, 0.4, 1] },
            },
          ]);
        }
        if (opts.includeWideBlur) {
          // Wide backdrop blur forces reader-halo mode (plan = 4) at high zoom.
          addRect(20, ROOT, -40, -40, 200, 200, [
            { op: "backgroundBlur", paths: [0], evenOdd: false, radius: 25 },
          ]);
        }
        // Faded isolated frame so glass inside it must overlay interior paint onto
        // readers.blur_source ("reader prefix snapshot") via the "scope composite" pass.
        addRect(30, ROOT, 0, 0, 128, 96, [{ op: "children" }], {
          flags: FLAG.isolate,
          opacity: 0.75,
        });
        // Interior paint inside the isolated scope before the glass lens.
        addRect(31, 30, 8, 12, 112, 24, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.85, 0.25, 0.2, 1] },
          },
        ]);
        // Rounded-rect glass lens inside the isolated scope (frost=0 enables native_sampling
        // even in reader-halo mode so overlay_glass_interiors runs on readers.blur_source).
        const lensW = 64;
        const lensH = 48;
        const radii: [number, number, number, number] = [8, 8, 8, 8];
        list.set(32, 30, {
          flags: 0,
          transform: [1, 0, 0, 1, 24, 20],
          opacity: 1,
          width: lensW,
          height: lensH,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [{ kind: "rect", w: lensW, h: lensH, radii, smoothing: 0 }],
          ops: [
            {
              op: "glass",
              paths: [0],
              evenOdd: false,
              kind: GLASS_KIND.box,
              inradius: 24,
              angle: 0,
              intensity: 0,
              refraction: 0.8,
              depth: 8,
              dispersion: 0,
              frost: opts.includeWideBlur ? 0 : 4,
              splay: 0,
              boxRadii: radii,
              boxSmoothing: [0, 0, 0, 0],
            },
          ],
          coarse: [],
        });
        return [...list.finish()];
      };

      const nativeBytes = makeScopedGlassScene({ includeWideBlur: false });
      const haloBytes = makeScopedGlassScene({ includeWideBlur: true });

      const out = await page.evaluate(
        async ({ nativeBytes, haloBytes, expectedBackend }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const bg = new Float32Array([0.85, 0.85, 0.85, 1]);
          const requireOk = (o: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = o;
            o.free();
            if (!ok) throw new Error(message);
          };
          const renderGpu = async (
            bytes: number[],
            w: number,
            h: number,
            zoom: number,
            dpr: number,
          ) => {
            const dev = await glue.createGpu(null, 0);
            if (!dev.ok) throw new Error(dev.message);
            if (dev.backend !== expectedBackend) throw new Error(`wrong backend ${dev.backend}`);
            const engine = new glue.Engine(0, 0);
            try {
              if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels) {
                throw new Error("missing GPU entry points");
              }
              requireOk(engine.attachGpu(dev));
              dev.free();
              requireOk(engine.apply(new Uint8Array(bytes)));
              const r = engine.renderGpu(w, h, zoom, 0, 0, dpr, bg, false, 0, true);
              const plan = r.plan;
              requireOk(r);
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
              return { plan, px: Array.from(px) };
            } finally {
              engine.free();
            }
          };
          const renderCpu = (bytes: number[], w: number, h: number, zoom: number, dpr: number) => {
            const engine = new glue.Engine(0, 0);
            try {
              requireOk(engine.apply(new Uint8Array(bytes)));
              requireOk(engine.renderCpu(w, h, zoom, 0, 0, dpr, bg, false));
              return Array.from(engine.pixels());
            } finally {
              engine.free();
            }
          };
          const nativeGpu = await renderGpu(nativeBytes, 128, 96, 1, 1);
          const nativeCpu = renderCpu(nativeBytes, 128, 96, 1, 1);
          const haloGpu = await renderGpu(haloBytes, 128, 96, 128, 2);
          return { nativeGpu, nativeCpu, haloGpu };
        },
        { nativeBytes, haloBytes, expectedBackend },
      );

      const nativeStats = diffRegions(out.nativeGpu.px, out.nativeCpu, 128, 96);
      console.log(
        `[zoom-blur ${build}] scoped-glass-prefix: native max=${nativeStats.max} p99=${nativeStats.p99} mean=${nativeStats.mean.toFixed(2)} haloPlan=${out.haloGpu.plan}`,
      );
      expect(nativeStats.max).toBeLessThanOrEqual(4);
      expect(nativeStats.p99).toBeLessThanOrEqual(2);
      expect(out.haloGpu.plan).toBe(4);
    });

    test("real 2880x1800 viewport preserves fine detail under wide blur (100% r=250 and 1000%)", async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await openEngine(page, build);
      const expectedBackend = build === "webgl" ? "webgl2" : "webgpu";

      // Real 1440x900 @ DPR 2 (2880x1800 device px):
      // 1) 100% zoom (s=2), radius=250 uniform blur (sigma=225 px, reach~960 px -> padded view
      //    4800x3720 = 17.8M px > 16M px -> naturally enters reader-halo) over 0.5-unit (1 px)
      //    stripes (exact mean 135.5).
      // 2) 1000% zoom (s=20), radius=56 uniform blur (sigma=504 px, reach~2150 px -> coarse
      //    frame ~768x640, realistic real-viewport coarse size) over 0.2-unit (4 px) fine stripes
      //    (exact mean 135.5). Content-aware supersampling picks S >= 4 so fine detail does not
      //    wash out on real viewports.
      const buildStripeBlur = (opts: {
        span: number;
        period: number;
        blurBox: [number, number, number, number];
        radius: number;
      }) => {
        const list = new ListWriter(0xffffffff, 1);
        list.reset();
        let id = 1;
        const rect = (x: number, y: number, rw: number, rh: number, ops: WireRecord["ops"]) => {
          list.set(id++, ROOT, {
            flags: 0,
            transform: [1, 0, 0, 1, x, y],
            opacity: 1,
            width: rw,
            height: rh,
            coarseBelow: 0,
            reach: 0,
            unsupported: 0,
            paths: [{ kind: "rect", w: rw, h: rh, radii: [0, 0, 0, 0], smoothing: 0 }],
            ops,
            coarse: [],
          });
        };
        const sp = opts.span;
        rect(-sp, -sp, 2 * sp, 2 * sp, [
          { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 1, 1, 1] } },
        ]);
        const count = Math.ceil((2 * sp) / opts.period);
        for (let i = 0; i < count; i++) {
          const y = -sp + i * opts.period;
          rect(-sp, y, 2 * sp, 0.5 * opts.period, [
            {
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: { kind: "solid", color: [16 / 255, 16 / 255, 16 / 255, 1] },
            },
          ]);
        }
        const [bx, by, bw, bh] = opts.blurBox;
        rect(bx, by, bw, bh, [
          { op: "backgroundBlur", paths: [0], evenOdd: false, radius: opts.radius },
        ]);
        return [...list.finish()];
      };

      const w = 2880;
      const h = 1800;
      const cases = [
        {
          name: "real2880-100pct-r250",
          zoom: 1,
          dpr: 2,
          // View covers [-720..720, -450..450] page units; blur covers whole view; stripes span
          // [-1300..1300] (well past 960 px / 2 = 480 unit reach on all sides).
          // On hardware (4096/12M cap, d_render=2) test 1 px stripes (period 1.0); on SwiftShader
          // (2048/4.2M cap, d_render=4) test 2 px stripes (period 2.0).
          bytesHw: buildStripeBlur({
            span: 1300,
            period: 1.0,
            blurBox: [-720, -450, 1440, 900],
            radius: 250,
          }),
          bytesSoft: buildStripeBlur({
            span: 1300,
            period: 2.0,
            blurBox: [-720, -450, 1440, 900],
            radius: 250,
          }),
          // Measure central 600x400 px crop well inside the striped support.
          crop: [1140, 700, 1740, 1100] as [number, number, number, number],
        },
        {
          name: "real2880-1000pct-fine4px",
          zoom: 10,
          dpr: 2,
          // View covers [-72..72, -45..45] page units; blur reach ~110 units -> span 200 units.
          // period 0.4 units = 8 px (4 px dark stripe, 4 px white gap -> mean 135.5).
          bytesHw: buildStripeBlur({
            span: 200,
            period: 0.4,
            blurBox: [-72, -45, 144, 90],
            radius: 56,
          }),
          bytesSoft: buildStripeBlur({
            span: 200,
            period: 0.4,
            blurBox: [-72, -45, 144, 90],
            radius: 56,
          }),
          crop: [1140, 700, 1740, 1100] as [number, number, number, number],
        },
      ];

      const results = await page.evaluate(
        async ({ cases, expectedBackend, w, h }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const bg = new Float32Array([1, 1, 1, 1]);
          const requireOk = (o: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = o;
            o.free();
            if (!ok) throw new Error(message);
          };
          const out = [];
          for (const c of cases) {
            const dev = await glue.createGpu(null, 0);
            if (!dev.ok) throw new Error(dev.message);
            if (dev.backend !== expectedBackend) throw new Error(`wrong backend ${dev.backend}`);
            const bytes = dev.fallback ? c.bytesSoft : c.bytesHw;
            const engine = new glue.Engine(0, 0);
            try {
              if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels) {
                throw new Error("missing GPU entry points");
              }
              requireOk(engine.attachGpu(dev));
              dev.free();
              requireOk(engine.apply(new Uint8Array(bytes)));
              const r = engine.renderGpu(
                w,
                h,
                c.zoom,
                w / (2 * c.dpr),
                h / (2 * c.dpr),
                c.dpr,
                bg,
                false,
                0,
                true,
              );
              const plan = r.plan;
              requireOk(r);
              const px = await engine.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
              const [cx0, cy0, cx1, cy1] = c.crop;
              const diffs: number[] = [];
              let max = 0;
              let sumVal = 0;
              for (let y = cy0; y < cy1; y++) {
                for (let x = cx0; x < cx1; x++) {
                  const v = px[(y * w + x) * 4] ?? 0;
                  sumVal += v;
                  const d = Math.abs(v - 136);
                  diffs.push(d);
                  if (d > max) max = d;
                }
              }
              diffs.sort((a, b) => a - b);
              out.push({
                name: c.name,
                plan,
                max,
                p99: diffs[Math.floor((diffs.length - 1) * 0.99)] ?? 0,
                meanVal: sumVal / diffs.length,
              });
            } finally {
              engine.free();
            }
          }
          return out;
        },
        { cases, expectedBackend, w, h },
      );

      for (const r of results) {
        console.log(
          `[zoom-blur ${build}] ${r.name}: plan=${r.plan} max=${r.max} p99=${r.p99} meanVal=${r.meanVal.toFixed(2)} (target 135.5)`,
        );
        expect(r.plan, `${r.name} must run reader-halo (plan 4)`).toBe(4);
        expect(r.max, `${r.name} meanVal=${r.meanVal.toFixed(2)}`).toBeLessThanOrEqual(4);
        expect(r.p99, `${r.name} meanVal=${r.meanVal.toFixed(2)}`).toBeLessThanOrEqual(2);
      }
    });

    test("glass stacked over wide progressive blur at d>=32 matches full-res reference", async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await openEngine(page, build);
      const expectedBackend = build === "webgl" ? "webgl2" : "webgpu";

      const tw = 192;
      const th = 160;
      const zoom = 5;
      const dpr = 2;
      const s = zoom * dpr;
      const blurBox: [number, number, number, number] = [20, 0, tw / s, th / s];
      const testOrigin: [number, number] = [20, 0];
      const driverAt: [number, number] = [
        testOrigin[0] + (tw - 2) / s,
        testOrigin[1] + (th - 2) / s,
      ];

      const buildGlassOverBlur = (driverRadius?: number) => {
        const list = new ListWriter(0xffffffff, 1);
        list.reset();
        let nextId = 1;
        const addRect = (
          x: number,
          y: number,
          w: number,
          h: number,
          ops: WireRecord["ops"],
          radii: [number, number, number, number] = [0, 0, 0, 0],
        ) => {
          const id = nextId++;
          list.set(id, ROOT, {
            flags: 0,
            transform: [1, 0, 0, 1, x, y],
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
        const solid = (color: readonly [number, number, number, number]): WireRecord["ops"] => [
          { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } },
        ];
        addRect(-400, -400, 1200, 1200, solid([1, 1, 1, 1]));
        const k = 4;
        for (let i = 0; i < Math.ceil(300 / k); i++) {
          addRect(-100, -100 + i * k, 300, 0.5 * k, solid([16 / 255, 16 / 255, 16 / 255, 1]));
        }
        for (let i = 0; i < Math.ceil(120 / k); i++) {
          addRect(
            -100 + i * 2.5 * k,
            -100,
            0.3 * k,
            300,
            solid([16 / 255, 64 / 255, 208 / 255, 1]),
          );
        }
        // Glass lens BELOW the blur (rule b*: must not bleed into the blur's backdrop).
        addRect(
          22,
          2,
          8,
          6,
          [
            {
              op: "glass",
              paths: [0],
              evenOdd: false,
              kind: GLASS_KIND.box,
              inradius: 3,
              angle: -45,
              intensity: 0.8,
              refraction: 0.8,
              depth: 2,
              dispersion: 0.5,
              frost: 2,
              splay: 0,
              boxRadii: [1.5, 1.5, 1.5, 1.5],
              boxSmoothing: [0, 0, 0, 0],
            },
          ],
          [1.5, 1.5, 1.5, 1.5],
        );
        // Wide progressive blur across [0..48] (sigma 0..216 px).
        const [bx, by, bw, bh] = blurBox;
        addRect(bx, by, bw, bh, [
          {
            op: "progressiveBlur",
            paths: [0],
            evenOdd: false,
            startRadius: 0,
            endRadius: 48,
            start: [0, 0],
            end: [0, 1],
          },
        ]);
        // Glass lens ABOVE the progressive blur (mid->far sigma band) that samples the blurred
        // prefix; must obey sigma >= 3*d via mid-tier capture / mid-patched prefix.
        addRect(
          24,
          6,
          10,
          7,
          [
            {
              op: "glass",
              paths: [0],
              evenOdd: false,
              kind: GLASS_KIND.box,
              inradius: 3.5,
              angle: -45,
              intensity: 0.8,
              refraction: 0.8,
              depth: 2,
              dispersion: 0.5,
              frost: 2,
              splay: 0,
              boxRadii: [2, 2, 2, 2],
              boxSmoothing: [0, 0, 0, 0],
            },
          ],
          [2, 2, 2, 2],
        );
        if (driverRadius) {
          addRect(driverAt[0], driverAt[1], 0.2, 0.2, [
            { op: "backgroundBlur", paths: [0], evenOdd: false, radius: driverRadius },
          ]);
        }
        return [...list.finish()];
      };

      const refBytes = buildGlassOverBlur();
      const testSoft = buildGlassOverBlur(680);
      const testHw = buildGlassOverBlur(1050);
      const margin = Math.ceil(3.6 * 0.45 * 48) + 4;
      const refOrigin: [number, number] = [testOrigin[0] - margin, testOrigin[1] - margin];
      const refW = tw + 2 * margin * s;
      const refH = th + 2 * margin * s;
      const ox = Math.round((testOrigin[0] - refOrigin[0]) * s);
      const oy = Math.round((testOrigin[1] - refOrigin[1]) * s);

      const res = await page.evaluate(
        async ({
          refBytes,
          testSoft,
          testHw,
          expectedBackend,
          tw,
          th,
          refW,
          refH,
          zoom,
          dpr,
          testOrigin,
          refOrigin,
          ox,
          oy,
        }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const bg = new Float32Array([1, 1, 1, 1]);
          const requireOk = (o: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = o;
            o.free();
            if (!ok) throw new Error(message);
          };
          // CPU full-resolution reference
          const cpu = new glue.Engine(0, 0);
          let refPx: Uint8Array;
          try {
            requireOk(cpu.apply(new Uint8Array(refBytes)));
            requireOk(
              cpu.renderCpu(
                refW,
                refH,
                zoom,
                -refOrigin[0] * zoom,
                -refOrigin[1] * zoom,
                dpr,
                bg,
                true,
              ),
            );
            refPx = new Uint8Array(cpu.pixels());
          } finally {
            cpu.free();
          }
          // GPU reader-halo render
          const dev = await glue.createGpu(null, 0);
          if (!dev.ok) throw new Error(dev.message);
          if (dev.backend !== expectedBackend) throw new Error(`wrong backend ${dev.backend}`);
          const bytes = dev.fallback ? testSoft : testHw;
          const gpu = new glue.Engine(0, 0);
          try {
            if (!gpu.attachGpu || !gpu.renderGpu || !gpu.gpuPixels) {
              throw new Error("missing GPU entry points");
            }
            requireOk(gpu.attachGpu(dev));
            dev.free();
            requireOk(gpu.apply(new Uint8Array(bytes)));
            const out = gpu.renderGpu(
              tw,
              th,
              zoom,
              -testOrigin[0] * zoom,
              -testOrigin[1] * zoom,
              dpr,
              bg,
              false,
              0,
              true,
            );
            const plan = out.plan;
            requireOk(out);
            const px = await gpu.gpuPixels();
            if (!(px instanceof Uint8Array)) throw new Error(px.message);
            const inDiffs: number[] = [];
            const outDiffs: number[] = [];
            let inMax = 0;
            let outMax = 0;
            // Upper glass lens sits at [24..34, 6..13] page units -> [40..140, 60..130] device px.
            for (let y = 0; y < th - 4; y++) {
              for (let x = 0; x < tw - 4; x++) {
                const ti = (y * tw + x) * 4;
                const ri = ((oy + y) * refW + (ox + x)) * 4;
                const d = Math.max(
                  Math.abs((px[ti] ?? 0) - (refPx[ri] ?? 0)),
                  Math.abs((px[ti + 1] ?? 0) - (refPx[ri + 1] ?? 0)),
                  Math.abs((px[ti + 2] ?? 0) - (refPx[ri + 2] ?? 0)),
                );
                if (x >= 40 && x < 140 && y >= 60 && y < 130) {
                  inDiffs.push(d);
                  if (d > inMax) inMax = d;
                } else {
                  outDiffs.push(d);
                  if (d > outMax) outMax = d;
                }
              }
            }
            inDiffs.sort((a, b) => a - b);
            outDiffs.sort((a, b) => a - b);
            return {
              plan,
              inMax,
              inP99: inDiffs[Math.floor((inDiffs.length - 1) * 0.99)] ?? 0,
              outMax,
              outP99: outDiffs[Math.floor((outDiffs.length - 1) * 0.99)] ?? 0,
            };
          } finally {
            gpu.free();
          }
        },
        {
          refBytes,
          testSoft,
          testHw,
          expectedBackend,
          tw,
          th,
          refW,
          refH,
          zoom,
          dpr,
          testOrigin,
          refOrigin,
          ox,
          oy,
        },
      );

      console.log(
        `[zoom-blur ${build}] glass-over-blur-d64: plan=${res.plan} inGlass=(max=${res.inMax},p99=${res.inP99}) outGlass=(max=${res.outMax},p99=${res.outP99})`,
      );
      expect(res.plan).toBe(4);
      expect(res.inMax).toBeLessThanOrEqual(4);
      expect(res.inP99).toBeLessThanOrEqual(2);
      expect(res.outMax).toBeLessThanOrEqual(4);
      expect(res.outP99).toBeLessThanOrEqual(2);
    });

    test("Noise, LayerBlur, and PictureMask scopes match full-res reference across the whole frame", async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await openEngine(page, build);
      const expectedBackend = build === "webgl" ? "webgl2" : "webgpu";

      const tw = 160;
      const th = 128;
      const zoom = 5;
      const dpr = 2;
      const s = zoom * dpr;
      const testOrigin: [number, number] = [0.4, 24];
      const driverAt: [number, number] = [
        testOrigin[0] + (tw - 2) / s,
        testOrigin[1] + (th - 2) / s,
      ];

      const buildScopeScene = (opts: {
        post?: WireRecord["postEffects"];
        clipped: boolean;
        pageBackdrop?: boolean;
        pictureMask?: boolean;
        withGlass?: boolean;
        endRadius: number;
        driverRadius?: number;
      }) => {
        const list = new ListWriter(0xffffffff, 1);
        list.reset();
        let nextId = 1;
        const addRect = (
          parent: number,
          x: number,
          y: number,
          w: number,
          h: number,
          ops: WireRecord["ops"],
          flags = 0,
          postEffects?: WireRecord["postEffects"],
          extra?: Partial<WireRecord>,
        ) => {
          const id = nextId++;
          list.set(id, parent, {
            flags,
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
                radii: [0, 0, 0, 0],
                smoothing: 0,
              },
            ],
            ops,
            coarse: [],
            ...(postEffects ? { postEffects } : {}),
            ...extra,
          });
          return id;
        };
        const solid = (color: readonly [number, number, number, number]): WireRecord["ops"] => [
          { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color } },
        ];
        // Contrasting red paint outside the scope to verify clipped scopes never leak outside paint.
        addRect(ROOT, -300, -300, 900, 900, solid([1, 1, 1, 1]));
        if (opts.clipped) {
          addRect(ROOT, -200, -200, 200.77, 500, solid([1, 0, 0, 1]));
        }
        const k = 4;
        if (opts.pageBackdrop) {
          for (let i = 0; i < 120; i++) {
            addRect(
              ROOT,
              -200,
              -180 + i * k,
              500,
              0.5 * k,
              solid([16 / 255, 16 / 255, 16 / 255, 1]),
            );
          }
        }
        let scopeId: number;
        let ox: number;
        let oy: number;
        if (opts.pictureMask) {
          addRect(
            ROOT,
            0,
            0,
            52,
            48,
            [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: {
                  kind: "linear",
                  matrix: [52, 0, 0, 48, 0, 0],
                  stops: [
                    { position: 0, color: [1, 1, 1, 1] },
                    { position: 1, color: [1, 1, 1, 0.25] },
                  ],
                },
              },
            ],
            FLAG.mask,
            undefined,
            { mask: MASK.alpha },
          );
          scopeId = addRect(ROOT, 0, 0, 52, 48, [{ op: "children" }], FLAG.group);
          ox = 0;
          oy = 0;
        } else {
          const scopeOps: WireRecord["ops"] = opts.clipped
            ? [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }]
            : [{ op: "children" }];
          // Clipped scope starts at fractional device x=0.37*10=3.7 px inside the view;
          // pageBackdrop scopes start tightly at (0, 0) so inner blurs rely on the inherited page
          // prefix (#274); plain unclipped scopes span the full blur reach.
          const scopeX = opts.clipped ? 0.77 : opts.pageBackdrop ? 0 : -200;
          const scopeY = opts.pageBackdrop ? 0 : -200;
          const scopeW = opts.pageBackdrop ? 52 : 600;
          const scopeH = opts.pageBackdrop ? 48 : 600;
          scopeId = addRect(
            ROOT,
            scopeX,
            scopeY,
            scopeW,
            scopeH,
            scopeOps,
            opts.post ? FLAG.post : 0,
            opts.post,
          );
          ox = -scopeX;
          oy = -scopeY;
        }
        const stripeX0 = opts.clipped || opts.pageBackdrop ? 0 : -200;
        const stripeW = opts.clipped || opts.pageBackdrop ? 52 : 500;
        if (!opts.pageBackdrop) {
          for (let i = 0; i < 120; i++) {
            addRect(
              scopeId,
              stripeX0 + ox,
              -180 + i * k + oy,
              stripeW,
              0.5 * k,
              solid([16 / 255, 16 / 255, 16 / 255, 1]),
            );
          }
        }
        const barY0 = opts.pageBackdrop ? 0 : -180;
        const barH = opts.pageBackdrop ? 48 : 480;
        const barCount = opts.pageBackdrop ? 6 : 40;
        for (let i = 0; i < barCount; i++) {
          addRect(
            scopeId,
            stripeX0 + i * 2.5 * k + ox,
            barY0 + oy,
            0.3 * k,
            barH,
            solid([16 / 255, 64 / 255, 208 / 255, 1]),
          );
        }
        addRect(scopeId, 0 + ox, 0 + oy, 52, 48, [
          {
            op: "progressiveBlur",
            paths: [0],
            evenOdd: false,
            startRadius: 0,
            endRadius: opts.endRadius,
            start: [0, 0],
            end: [0, 1],
          },
        ]);
        if (opts.withGlass) {
          addRect(
            scopeId,
            3 + ox,
            26 + oy,
            10,
            7,
            [
              {
                op: "glass",
                paths: [0],
                evenOdd: false,
                kind: GLASS_KIND.box,
                inradius: 3.5,
                angle: -45,
                intensity: 0.8,
                refraction: 0.8,
                depth: 2,
                dispersion: 0.5,
                frost: 2,
                splay: 0,
                boxRadii: [2, 2, 2, 2],
                boxSmoothing: [0, 0, 0, 0],
              },
            ],
            0,
            undefined,
            {
              paths: [{ kind: "rect", w: 10, h: 7, radii: [2, 2, 2, 2], smoothing: 0 }],
            },
          );
        }
        if (opts.driverRadius) {
          addRect(
            ROOT,
            driverAt[0],
            driverAt[1],
            0.2,
            0.2,
            [{ op: "backgroundBlur", paths: [0], evenOdd: false, radius: opts.driverRadius }],
            opts.pictureMask ? FLAG.endsMask : 0,
          );
        }
        return [...list.finish()];
      };

      const noisePost: WireRecord["postEffects"] = [
        {
          kind: "noise",
          noiseType: 0,
          size: 1,
          density: 50,
          color: [0, 0, 0, 0.25],
          secondaryColor: [1, 1, 1, 0.25],
          opacity: 0.25,
        },
      ];
      const lbPost: WireRecord["postEffects"] = [{ kind: "layerBlur", radius: 1.5 }];

      const cases = [
        {
          name: "unclipped-noise",
          expectHalo: true,
          refBytes: buildScopeScene({ post: noisePost, clipped: false, endRadius: 48 }),
          testSoft: buildScopeScene({
            post: noisePost,
            clipped: false,
            endRadius: 48,
            driverRadius: 680,
          }),
          testHw: buildScopeScene({
            post: noisePost,
            clipped: false,
            endRadius: 48,
            driverRadius: 1050,
          }),
        },
        {
          name: "unclipped-layerBlur",
          expectHalo: true,
          refBytes: buildScopeScene({ post: lbPost, clipped: false, endRadius: 48 }),
          testSoft: buildScopeScene({
            post: lbPost,
            clipped: false,
            endRadius: 48,
            driverRadius: 680,
          }),
          testHw: buildScopeScene({
            post: lbPost,
            clipped: false,
            endRadius: 48,
            driverRadius: 1050,
          }),
        },
        {
          name: "clipped-noise-halo",
          expectHalo: true,
          refBytes: buildScopeScene({ post: noisePost, clipped: true, endRadius: 48 }),
          testSoft: buildScopeScene({
            post: noisePost,
            clipped: true,
            endRadius: 48,
            driverRadius: 680,
          }),
          testHw: buildScopeScene({
            post: noisePost,
            clipped: true,
            endRadius: 48,
            driverRadius: 1050,
          }),
        },
        {
          name: "clipped-layerBlur-halo",
          expectHalo: true,
          refBytes: buildScopeScene({ post: lbPost, clipped: true, endRadius: 48 }),
          testSoft: buildScopeScene({
            post: lbPost,
            clipped: true,
            endRadius: 48,
            driverRadius: 680,
          }),
          testHw: buildScopeScene({
            post: lbPost,
            clipped: true,
            endRadius: 48,
            driverRadius: 1050,
          }),
        },
        {
          name: "unclipped-noise-page-backdrop",
          expectHalo: true,
          refBytes: buildScopeScene({
            post: noisePost,
            clipped: false,
            pageBackdrop: true,
            endRadius: 48,
          }),
          testSoft: buildScopeScene({
            post: noisePost,
            clipped: false,
            pageBackdrop: true,
            endRadius: 48,
            driverRadius: 680,
          }),
          testHw: buildScopeScene({
            post: noisePost,
            clipped: false,
            pageBackdrop: true,
            endRadius: 48,
            driverRadius: 1050,
          }),
        },
        {
          name: "pictureMask-halo",
          expectHalo: true,
          refBytes: buildScopeScene({
            clipped: false,
            pageBackdrop: true,
            pictureMask: true,
            endRadius: 48,
          }),
          testSoft: buildScopeScene({
            clipped: false,
            pageBackdrop: true,
            pictureMask: true,
            endRadius: 48,
            driverRadius: 680,
          }),
          testHw: buildScopeScene({
            clipped: false,
            pageBackdrop: true,
            pictureMask: true,
            endRadius: 48,
            driverRadius: 1050,
          }),
        },
        {
          name: "glass-in-layerBlur-halo",
          expectHalo: true,
          refBytes: buildScopeScene({
            post: lbPost,
            clipped: false,
            pageBackdrop: true,
            withGlass: true,
            endRadius: 48,
          }),
          testSoft: buildScopeScene({
            post: lbPost,
            clipped: false,
            pageBackdrop: true,
            withGlass: true,
            endRadius: 48,
            driverRadius: 680,
          }),
          testHw: buildScopeScene({
            post: lbPost,
            clipped: false,
            pageBackdrop: true,
            withGlass: true,
            endRadius: 48,
            driverRadius: 1050,
          }),
        },
      ];

      const margin = Math.ceil(3.6 * 0.45 * 48) + 8;
      const refOrigin: [number, number] = [testOrigin[0] - margin, testOrigin[1] - margin];
      const refW = tw + 2 * margin * s;
      const refH = th + 2 * margin * s;
      const ox = Math.round((testOrigin[0] - refOrigin[0]) * s);
      const oy = Math.round((testOrigin[1] - refOrigin[1]) * s);

      const results = await page.evaluate(
        async ({
          cases,
          expectedBackend,
          tw,
          th,
          refW,
          refH,
          zoom,
          dpr,
          testOrigin,
          refOrigin,
          ox,
          oy,
        }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const bg = new Float32Array([1, 1, 1, 1]);
          const requireOk = (o: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = o;
            o.free();
            if (!ok) throw new Error(message);
          };
          const out = [];
          for (const c of cases) {
            // Render full-resolution CPU reference
            const cpu = new glue.Engine(0, 0);
            let refPx: Uint8Array;
            try {
              requireOk(cpu.apply(new Uint8Array(c.refBytes)));
              requireOk(
                cpu.renderCpu(
                  refW,
                  refH,
                  zoom,
                  -refOrigin[0] * zoom,
                  -refOrigin[1] * zoom,
                  dpr,
                  bg,
                  true,
                ),
              );
              refPx = new Uint8Array(cpu.pixels());
            } finally {
              cpu.free();
            }
            // Render GPU view under reader-halo driver
            const dev = await glue.createGpu(null, 0);
            if (!dev.ok) throw new Error(dev.message);
            if (dev.backend !== expectedBackend) throw new Error(`wrong backend ${dev.backend}`);
            const bytes = dev.fallback ? c.testSoft : c.testHw;
            const gpu = new glue.Engine(0, 0);
            try {
              if (!gpu.attachGpu || !gpu.renderGpu || !gpu.gpuPixels) {
                throw new Error("missing GPU entry points");
              }
              requireOk(gpu.attachGpu(dev));
              dev.free();
              requireOk(gpu.apply(new Uint8Array(bytes)));
              const r = gpu.renderGpu(
                tw,
                th,
                zoom,
                -testOrigin[0] * zoom,
                -testOrigin[1] * zoom,
                dpr,
                bg,
                false,
                0,
                true,
              );
              const plan = r.plan;
              requireOk(r);
              const px = await gpu.gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(px.message);
              const diffs: number[] = [];
              let max = 0;
              let sum = 0;
              for (let y = 0; y < th - 4; y++) {
                for (let x = 0; x < tw - 4; x++) {
                  const ti = (y * tw + x) * 4;
                  const ri = ((oy + y) * refW + (ox + x)) * 4;
                  const d = Math.max(
                    Math.abs((px[ti] ?? 0) - (refPx[ri] ?? 0)),
                    Math.abs((px[ti + 1] ?? 0) - (refPx[ri + 1] ?? 0)),
                    Math.abs((px[ti + 2] ?? 0) - (refPx[ri + 2] ?? 0)),
                  );
                  diffs.push(d);
                  if (d > max) max = d;
                  sum += d;
                }
              }
              diffs.sort((a, b) => a - b);
              out.push({
                name: c.name,
                expectHalo: c.expectHalo,
                plan,
                max,
                p99: diffs[Math.floor((diffs.length - 1) * 0.99)] ?? 0,
                mean: Math.round((sum / diffs.length) * 100) / 100,
              });
            } finally {
              gpu.free();
            }
          }
          return out;
        },
        {
          cases,
          expectedBackend,
          tw,
          th,
          refW,
          refH,
          zoom,
          dpr,
          testOrigin,
          refOrigin,
          ox,
          oy,
        },
      );

      for (const r of results) {
        console.log(
          `[zoom-blur ${build}] ${r.name}: plan=${r.plan} max=${r.max} p99=${r.p99} mean=${r.mean}`,
        );
        expect(r.plan, `${r.name} must run reader-halo (plan 4)`).toBe(4);
        expect(r.max, `${r.name} max=${r.max} p99=${r.p99} mean=${r.mean}`).toBeLessThanOrEqual(4);
        expect(r.p99, `${r.name} max=${r.max} p99=${r.p99} mean=${r.mean}`).toBeLessThanOrEqual(2);
      }
    });

    test("budgeted moving frames that hit a limit present a warped stand-in (F4)", async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await openEngine(page, build);
      // A sparse blue square at the page origin and, 2,000 units to the right, 150 small squares
      // (about 750 path verbs) under a wide background blur. With `frame_verbs` at 400 a tile
      // there hits the verb limit.
      const list = new ListWriter(0xffffffff, 1);
      list.reset();
      let nextId = 1;
      const addRect = (x: number, y: number, w: number, h: number, ops: WireRecord["ops"]) => {
        list.set(nextId++, ROOT, {
          flags: 0,
          transform: [1, 0, 0, 1, x, y],
          opacity: 1,
          width: w,
          height: h,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [{ kind: "rect", w, h, radii: [0, 0, 0, 0], smoothing: 0 }],
          ops,
          coarse: [],
        });
      };
      const solid = (c: readonly [number, number, number, number]): WireRecord["ops"] => [
        { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: c } },
      ];
      addRect(0, 0, 400, 400, solid([0.2, 0.4, 0.8, 1]));
      for (let i = 0; i < 150; i++) {
        addRect(2000 + (i % 15) * 30, Math.floor(i / 15) * 30, 20, 20, solid([0.8, 0.2, 0.2, 1]));
      }
      addRect(2000, 0, 500, 400, [
        { op: "backgroundBlur", paths: [0], evenOdd: false, radius: 1800 },
      ]);
      const bytes = [...list.finish()];
      const res = await page.evaluate(async (bytes) => {
        const name = "/engine.js";
        const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
        await glue.default({ module_or_path: "/engine_bg.wasm" });
        const bg = new Float32Array([1, 1, 1, 1]);
        const requireOk = (o: { ok: boolean; message: string; free(): void }) => {
          const { ok, message } = o;
          o.free();
          if (!ok) throw new Error(message);
        };
        const dev = await glue.createGpu(null, 0);
        if (!dev.ok) throw new Error(dev.message);
        const gpu = new glue.Engine(0, 0);
        try {
          if (!gpu.attachGpu || !gpu.renderGpu || !gpu.gpuPixels)
            throw new Error("missing GPU entry points");
          requireOk(gpu.setLimit("frame_verbs", 400));
          requireOk(gpu.attachGpu(dev));
          dev.free();
          requireOk(gpu.apply(new Uint8Array(bytes)));
          const pixel = async (x: number, y: number) => {
            const px = await gpu.gpuPixels?.();
            if (!(px instanceof Uint8Array)) throw new Error(px?.message ?? "no pixels");
            const i = (y * 512 + x) * 4;
            return [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0];
          };
          // A settled frame over the blue square.
          requireOk(gpu.renderGpu(512, 320, 1, 0, 0, 1, bg, false, 0, true));
          const before = await pixel(100, 100);
          // Pan into the dense region while moving, on a 16.7 ms budget.
          const verb = gpu.renderGpu(512, 320, 1, -1900, 0, 1, bg, true, 16.7, true);
          const verbOut = {
            ok: verb.ok,
            plan: verb.plan,
            standin: verb.standin,
            exact: verb.exact,
          };
          verb.free();
          // What a read-back shows: the stand-in for the new camera (the square moved out of
          // view, so background), not the previous frame.
          const after = await pixel(100, 100);
          const far = gpu.renderGpu(512, 320, 1, -1e13, 0, 1, bg, true, 16.7, true);
          const farOut = { ok: far.ok, plan: far.plan, standin: far.standin, exact: far.exact };
          far.free();
          return { before, verbOut, after, farOut };
        } finally {
          gpu.free();
        }
      }, bytes);
      console.log(`[zoom-blur ${build}] f4 ${JSON.stringify(res)}`);
      expect(res.before[2]).toBeGreaterThan(150);
      expect(res.before[0]).toBeLessThan(100);
      for (const r of [res.verbOut, res.farOut]) {
        expect(r.ok).toBe(true);
        expect(r.plan).toBe(1);
        expect(r.standin).toBe(true);
        expect(r.exact).toBe(false);
      }
      expect(Math.min(...res.after), `stand-in read back: ${res.after}`).toBeGreaterThan(240);
    });

    test(`view blurs past MAX_BLUR_SIGMA (sigma 2,700) stay within <=4/255 max, <=2/255 p99 (${build})`, async ({
      page,
      browserName,
    }) => {
      test.skip(browserName !== "chromium", "Requires Chromium GPU build.");
      test.setTimeout(240_000);
      await openEngine(page, build);
      const expectedBackend = build === "browser" ? "webgpu" : "webgl2";

      // Exact 2D Gaussian integral over disjoint opaque rects composited over white (with optional
      // alpha-only mode for EdgeMode::Zero LayerBlur / DropShadow over white page).
      const evalZeroLayerOverWhite = (
        rects: readonly DisjointRect[],
        px: number,
        py: number,
        sigmaPage: number,
      ): [number, number, number] => {
        const inv = 1 / (sigmaPage * Math.SQRT2);
        let rPrem = 0;
        let gPrem = 0;
        let bPrem = 0;
        let aSum = 0;
        for (const rc of rects) {
          const wx = 0.5 * (erf((rc.x1 - px) * inv) - erf((rc.x0 - px) * inv));
          if (wx <= 0) continue;
          const wy = 0.5 * (erf((rc.y1 - py) * inv) - erf((rc.y0 - py) * inv));
          const w = wx * wy;
          if (w <= 0) continue;
          rPrem += w * rc.color[0];
          gPrem += w * rc.color[1];
          bPrem += w * rc.color[2];
          aSum += w;
        }
        const rem = Math.max(0, 1 - aSum);
        return [rPrem + rem * 255, gPrem + rem * 255, bPrem + rem * 255];
      };

      // A small view: each tile it covers repeats the sigma 2,700 work, which a software
      // adapter (CI) does slowly.
      const w = 256;
      const h = 192;
      const zoom = 100; // 10,000%
      const dpr = 2;
      const s = zoom * dpr; // 200 dev px / page unit
      const radius = 30; // sigma = 0.45 * 30 * 200 = 2,700 px (> MAX_BLUR_SIGMA = 2,560)
      const sigmaPage = 0.45 * radius; // 13.5 page units

      const makeRecord = (
        list: ListWriter,
        id: number,
        parent: number,
        x: number,
        y: number,
        rw: number,
        rh: number,
        ops: WireRecord["ops"],
        extra: Partial<WireRecord> = {},
      ) => {
        const autoFlags =
          (extra.postEffects?.length ? FLAG.post : 0) |
          (ops.some((o) => o.op === "children") ? FLAG.group : 0);
        list.set(id, parent, {
          transform: [1, 0, 0, 1, x, y],
          opacity: 1,
          width: rw,
          height: rh,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [{ kind: "rect", w: rw, h: rh, radii: [0, 0, 0, 0], smoothing: 0 }],
          ops,
          coarse: [],
          ...extra,
          flags: autoFlags | (extra.flags ?? 0),
        });
      };
      const solid = (c: [number, number, number], a = 1): WireRecord["ops"] => [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: { kind: "solid", color: [c[0] / 255, c[1] / 255, c[2] / 255, a] },
        },
      ];

      // 1. BackgroundBlur at 10,000% with sigma = 2,700 (and 5,400) over disjoint backdrop.
      const bg2700 = buildDisjointExtremeZoomScene({
        zoom,
        dpr,
        radius,
        uniform: true,
        stripePeriodPx: 320,
        centerPage: [50 + w / (2 * s), 50 + h / (2 * s)],
        blurRect: [0, 0, 100, 100],
      });

      // 2. Standalone compact LayerBlur (Case L1, native fit): 5 x 5 page rect (1,000 x 1,000 dev px)
      //    at 10,000% with sigma = 2,700 (> MAX_BLUR_SIGMA). High-contrast black/blue split ensures
      //    both unblurred and all-white outputs fail the <= 4/255 gate.
      const l1Rects: DisjointRect[] = [
        { x0: 47.5, y0: 47.5, x1: 50, y1: 52.5, color: [0, 0, 0] },
        { x0: 50, y0: 47.5, x1: 52.5, y1: 52.5, color: [24, 96, 216] },
      ];
      const l1List = new ListWriter(0xffffffff, 2);
      l1List.reset();
      makeRecord(l1List, 1, ROOT, -100, -100, 300, 300, solid([255, 255, 255]));
      makeRecord(l1List, 2, ROOT, 47.5, 47.5, 5, 5, [{ op: "children" }], {
        postEffects: [{ kind: "layerBlur", radius }],
      });
      makeRecord(l1List, 3, 2, 0, 0, 2.5, 5, solid([0, 0, 0]));
      makeRecord(l1List, 4, 2, 2.5, 0, 2.5, 5, solid([24, 96, 216]));
      const l1Bytes = [...l1List.finish()];

      // 3. Standalone large LayerBlur (case L2, one reduced-grid pass): 120 x 120 page mosaic
      //    (24,000 x 24,000 dev px) of abutting coloured tiles with sigma = 2,700.
      const l2Rects: DisjointRect[] = [];
      const l2List = new ListWriter(0xffffffff, 3);
      l2List.reset();
      makeRecord(l2List, 1, ROOT, -200, -200, 500, 500, solid([255, 255, 255]));
      makeRecord(l2List, 2, ROOT, -10, -10, 120, 120, [{ op: "children" }], {
        postEffects: [{ kind: "layerBlur", radius }],
      });
      let lid = 3;
      const palette: [number, number, number][] = [
        [220, 38, 38],
        [37, 99, 235],
        [22, 163, 74],
        [234, 179, 8],
      ];
      for (let r = 0; r < 12; r++) {
        for (let c = 0; c < 12; c++) {
          const x = c * 10;
          const y = r * 10;
          const col = palette[(r * 3 + c) % palette.length] ?? [220, 38, 38];
          makeRecord(l2List, lid++, 2, x, y, 10, 10, solid(col));
          l2Rects.push({ x0: -10 + x, y0: -10 + y, x1: x, y1: y, color: col });
        }
      }
      const l2Bytes = [...l2List.finish()];

      // 4. LayerBlur scope over 2,560 wrapping a BackgroundBlur (Case L3): page striped backdrop
      //    behind a LayerBlur(radius=30 -> sigma=2,700) frame containing a BackgroundBlur(radius=10
      //    -> sigma=900) filling the frame. For a backdrop blurred by sigma_1=900 then LayerBlurred
      //    by sigma_2=2700 inside the finite frame, compare directly against a full-resolution
      //    scale-reduced GPU render (zoom=5 -> 1/20x exact scale, sigma_1=45, sigma_2=135) where
      //    both blurs run natively below MAX_BLUR_SIGMA!
      const l3List = new ListWriter(0xffffffff, 4);
      l3List.reset();
      makeRecord(l3List, 1, ROOT, -200, -200, 500, 500, solid([255, 255, 255]));
      let l3id = 2;
      for (let i = -20; i <= 20; i++) {
        makeRecord(
          l3List,
          l3id++,
          ROOT,
          -100,
          i * 6,
          300,
          3,
          solid(i % 2 === 0 ? [20, 40, 180] : [200, 40, 30]),
        );
      }
      const scopeId = l3id++;
      makeRecord(l3List, scopeId, ROOT, 0, 0, 100, 100, [{ op: "children" }], {
        postEffects: [{ kind: "layerBlur", radius }],
      });
      makeRecord(l3List, l3id++, scopeId, 0, 0, 100, 100, [
        { op: "backgroundBlur", paths: [0], evenOdd: false, radius: 10 },
      ]);
      const l3Bytes = [...l3List.finish()];

      // 5. DropShadow at 10,000% with blur = 30 -> sigma = 2,700 (> MAX_BLUR_SIGMA).
      const shRects: DisjointRect[] = [{ x0: 45, y0: 45, x1: 55, y1: 55, color: [30, 80, 210] }];
      const shList = new ListWriter(0xffffffff, 5);
      shList.reset();
      makeRecord(shList, 1, ROOT, -100, -100, 300, 300, solid([255, 255, 255]));
      makeRecord(
        shList,
        2,
        ROOT,
        45,
        45,
        10,
        10,
        [
          {
            op: "dropShadow",
            paths: [0],
            evenOdd: false,
            dx: 0,
            dy: 0,
            blur: radius,
            color: [30 / 255, 80 / 255, 210 / 255, 1],
            blend: 0,
          },
        ],
        { reach: 45 },
      );
      const shBytes = [...shList.finish()];

      const gpuOut = await page.evaluate(
        async ({
          expectedBackend,
          w,
          h,
          zoom,
          dpr,
          bg2700,
          l1Bytes,
          l2Bytes,
          l3Bytes,
          shBytes,
        }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const bg = new Float32Array([1, 1, 1, 1]);
          const requireOk = (o: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = o;
            o.free();
            if (!ok) throw new Error(message);
          };
          const dev = await glue.createGpu(null, 0);
          if (!dev.ok) throw new Error(dev.message);
          if (dev.backend !== expectedBackend) throw new Error(`wrong backend ${dev.backend}`);
          const engine = new glue.Engine(0, 0);
          try {
            if (!engine.attachGpu || !engine.renderGpu || !engine.gpuPixels) {
              throw new Error("missing GPU entry points");
            }
            const gpuPixels = engine.gpuPixels.bind(engine);
            requireOk(engine.attachGpu(dev));
            dev.free();
            const finished = async (label: string, target = engine) => {
              const done = await target.gpuFinished?.();
              if (done && !done.ok) throw new Error(`${label}: ${done.message}`);
              done?.free();
            };
            // Settles a view the way the editor does: frames at `budget`, slices between them,
            // and (unlike the editor) a GPU wait after each call, so no single wait holds a whole
            // software-rendered frame of sigma 2,700 work. Counts the calls that said exact.
            const settle = async (
              label: string,
              rw: number,
              rh: number,
              z: number,
              ox: number,
              oy: number,
              editorViewport: boolean,
              budget: number,
              target = engine,
            ) => {
              let calls = 0;
              let exactCalls = 0;
              let last = {
                ok: false,
                plan: -1,
                exact: false,
                standin: true,
                reduced: 0,
                pending: -1,
              };
              while (calls < 400) {
                calls++;
                const r = target.renderGpu?.(
                  rw,
                  rh,
                  z,
                  -ox * z,
                  -oy * z,
                  dpr,
                  bg,
                  false,
                  budget,
                  editorViewport,
                );
                if (!r) throw new Error(`${label}: no GPU entry point`);
                last = {
                  ok: r.ok,
                  plan: r.plan,
                  exact: r.exact,
                  standin: r.standin,
                  reduced: r.reduced,
                  pending: r.pending,
                };
                const inProgress = r.in_progress;
                if (r.exact) exactCalls++;
                requireOk(r);
                await finished(label, target);
                if (budget <= 0 || (last.pending === 0 && !inProgress)) break;
                target.renderGpuAhead?.(bg, budget)?.free();
                await finished(label, target);
              }
              return { ...last, calls, exactCalls };
            };
            const renderCase = async (
              label: string,
              bytes: number[] | null,
              rw: number,
              rh: number,
              z: number,
              ox: number,
              oy: number,
              editorViewport: boolean,
            ) => {
              if (bytes) requireOk(engine.apply(new Uint8Array(bytes)));
              const meta = await settle(
                label,
                rw,
                rh,
                z,
                ox,
                oy,
                editorViewport,
                editorViewport ? 8 : 0,
              );
              const px = await gpuPixels();
              if (!(px instanceof Uint8Array)) throw new Error(`${label}: ${px.message}`);
              return { ...meta, pixels: Array.from(px) };
            };

            const bgRes = await renderCase("bg", bg2700, w, h, zoom, 50, 50, true);
            const l1Res = await renderCase("L1", l1Bytes, w, h, zoom, 50, 50, true);
            const l2Res = await renderCase("L2", l2Bytes, w, h, zoom, 50, 50, true);
            const l3Res = await renderCase("L3", l3Bytes, w, h, zoom, 50, 50, true);
            // Reference for Case L3: render a wide native view at zoom = 2 (50x smaller scale ->
            // sigma_bg = 18, sigma_lb = 54, both well inside native limits) spanning 200 x 200 page
            // units so the entire 100 x 100 scope and full BackgroundBlur reach fit without crop
            // clamping, aligned to the exact page coordinate of pixel (floor(w/2), floor(h/2)).
            const l3RefW = 800;
            const l3RefH = 800;
            const l3RefZoom = 2;
            const l3RefS = l3RefZoom * dpr;
            const cxPage = 50 + (Math.floor(w / 2) + 0.5) / (zoom * dpr);
            const cyPage = 50 + (Math.floor(h / 2) + 0.5) / (zoom * dpr);
            const l3RefOx = cxPage - (l3RefW / 2 + 0.5) / l3RefS;
            const l3RefOy = cyPage - (l3RefH / 2 + 0.5) / l3RefS;
            const l3Ref = await renderCase(
              "L3-ref",
              null,
              l3RefW,
              l3RefH,
              l3RefZoom,
              l3RefOx,
              l3RefOy,
              false,
            );
            const shRes = await renderCase("shadow", shBytes, w, h, zoom, 50, 50, true);
            // Every reduced path stays not exact on the budgeted tile path too: from a cleared
            // cache, over many small slices and over the editor's 8 ms ones. On a fresh engine,
            // since revisions only move forward: the reduced halo (1), then L2 (3), then L3 (4).
            const honesty = [];
            const devH = await glue.createGpu(null, 0);
            if (!devH.ok) throw new Error(devH.message);
            const honest = new glue.Engine(0, 0);
            try {
              if (!honest.attachGpu) throw new Error("missing GPU entry points");
              requireOk(honest.attachGpu(devH));
              devH.free();
              for (const [label, bytes] of [
                ["reader halo", bg2700],
                ["L2", l2Bytes],
                ["L3", l3Bytes],
              ] as const) {
                requireOk(honest.apply(new Uint8Array(bytes)));
                for (const budget of [1, 8]) {
                  honest.clearTiles?.();
                  const label2 = `${label} at ${budget} ms`;
                  const r = await settle(label2, w, h, zoom, 50, 50, true, budget, honest);
                  honesty.push({ label, budget, ...r });
                }
              }
            } finally {
              honest.free();
            }
            return { bgRes, l1Res, l2Res, l3Res, l3Ref, shRes, honesty };
          } finally {
            engine.free();
          }
        },
        {
          expectedBackend,
          w,
          h,
          zoom,
          dpr,
          bg2700: bg2700.bytes,
          l1Bytes,
          l2Bytes,
          l3Bytes,
          shBytes,
        },
      );

      const scoreAgainstOracle = (
        pixels: number[],
        evalAt: (px: number, py: number) => [number, number, number],
      ) => {
        const diffs: number[] = [];
        let max = 0;
        let sum = 0;
        for (let y = 0; y < h; y++) {
          const py = 50 + (y + 0.5) / s;
          for (let x = 0; x < w; x++) {
            const px = 50 + (x + 0.5) / s;
            const [er, eg, eb] = evalAt(px, py);
            const o = (y * w + x) * 4;
            const d = Math.max(
              Math.abs((pixels[o] ?? 0) - Math.round(er)),
              Math.abs((pixels[o + 1] ?? 0) - Math.round(eg)),
              Math.abs((pixels[o + 2] ?? 0) - Math.round(eb)),
            );
            diffs.push(d);
            if (d > max) max = d;
            sum += d;
          }
        }
        diffs.sort((a, b) => a - b);
        return {
          max,
          p99: diffs[Math.floor((diffs.length - 1) * 0.99)] ?? 0,
          mean: Math.round((sum / diffs.length) * 100) / 100,
        };
      };

      const bgStats = scoreAgainstOracle(gpuOut.bgRes.pixels, (px, py) =>
        evalDisjointBlurAt(bg2700.rects, bg2700.bg, px, py, sigmaPage),
      );
      const l1Stats = scoreAgainstOracle(gpuOut.l1Res.pixels, (px, py) =>
        evalZeroLayerOverWhite(l1Rects, px, py, sigmaPage),
      );
      const l2Stats = scoreAgainstOracle(gpuOut.l2Res.pixels, (px, py) =>
        evalZeroLayerOverWhite(l2Rects, px, py, sigmaPage),
      );
      const shStats = scoreAgainstOracle(gpuOut.shRes.pixels, (px, py) =>
        evalZeroLayerOverWhite(shRects, px, py, sigmaPage),
      );

      // Compare every L3 pixel with the native zoom=2 reference at the same page coordinate,
      // sampled bilinearly (the reference's 4 px per page unit resolve a field blurred by 57 of
      // its pixels exactly enough).
      const l3RefS = 2 * dpr;
      const cxPage = 50 + (Math.floor(w / 2) + 0.5) / s;
      const cyPage = 50 + (Math.floor(h / 2) + 0.5) / s;
      const l3RefOx = cxPage - (800 / 2 + 0.5) / l3RefS;
      const l3RefOy = cyPage - (800 / 2 + 0.5) / l3RefS;
      const l3Stats = scoreAgainstOracle(gpuOut.l3Res.pixels, (px, py) => {
        const fx = (px - l3RefOx) * l3RefS - 0.5;
        const fy = (py - l3RefOy) * l3RefS - 0.5;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const at = (x: number, y: number, c: number) =>
          gpuOut.l3Ref.pixels[(y * 800 + x) * 4 + c] ?? 0;
        const lerp = (c: number) =>
          (at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx) * (1 - ty) +
          (at(x0, y0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, c) * tx) * ty;
        return [lerp(0), lerp(1), lerp(2)];
      });

      console.log(
        `[zoom-blur ${build}] F6 sigma=2700: ` +
          `bg(plan=${gpuOut.bgRes.plan},exact=${gpuOut.bgRes.exact},max=${bgStats.max},p99=${bgStats.p99}) ` +
          `L1(exact=${gpuOut.l1Res.exact},max=${l1Stats.max},p99=${l1Stats.p99}) ` +
          `L2-mosaic(exact=${gpuOut.l2Res.exact},max=${l2Stats.max},p99=${l2Stats.p99}) ` +
          `L3-scope(plan=${gpuOut.l3Res.plan},exact=${gpuOut.l3Res.exact},max=${l3Stats.max},p99=${l3Stats.p99}) ` +
          `shadow(exact=${gpuOut.shRes.exact},max=${shStats.max},p99=${shStats.p99})`,
      );

      // Accuracy holds for every case. Exact means nothing in the frame was reduced: the
      // background blur and the L3 scope run in the reduced halo tiers and L2 on a reduced grid,
      // so those frames are never exact; L1 and the shadow are device-resolution and are.
      expect(gpuOut.bgRes.plan).toBe(4);
      expect(gpuOut.bgRes.exact).toBe(false);
      expect(bgStats.max).toBeLessThanOrEqual(4);
      expect(bgStats.p99).toBeLessThanOrEqual(2);

      expect(gpuOut.l1Res.exact).toBe(true);
      expect(l1Stats.max).toBeLessThanOrEqual(4);
      expect(l1Stats.p99).toBeLessThanOrEqual(2);

      expect(gpuOut.l2Res.exact).toBe(false);
      expect(l2Stats.max).toBeLessThanOrEqual(4);
      expect(l2Stats.p99).toBeLessThanOrEqual(2);

      expect(gpuOut.l3Res.plan).toBe(4);
      expect(gpuOut.l3Res.exact).toBe(false);
      expect(l3Stats.max).toBeLessThanOrEqual(4);
      expect(l3Stats.p99).toBeLessThanOrEqual(2);

      expect(gpuOut.shRes.exact).toBe(true);

      for (const r of gpuOut.honesty) {
        console.log(`[zoom-blur ${build}] F6 budgeted honesty: ${JSON.stringify(r)}`);
        const what = `${r.label} at ${r.budget} ms`;
        expect(r.exactCalls, `${what} never says exact`).toBe(0);
        expect(r.exact, `${what} settles not exact`).toBe(false);
        expect(r.pending, `${what} settles`).toBe(0);
        if (r.label === "L2") {
          expect(r.reduced, `${what} names its reduction`).toBeGreaterThan(0);
        } else {
          expect(r.plan, `${what} uses the reduced halo tiers`).toBe(4);
        }
      }
      const l2Slices = gpuOut.honesty.find((r) => r.label === "L2" && r.budget === 1)?.calls ?? 0;
      expect(l2Slices, "L2 at 1 ms settles over several slices").toBeGreaterThan(1);
      expect(shStats.max).toBeLessThanOrEqual(4);
      expect(shStats.p99).toBeLessThanOrEqual(2);
    });

    test("settled 1,000% frames turn exact through apron tiles and match a native reference", async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await openEngine(page, build);
      // An abutting mosaic (the worst case for a reduced backdrop: every seam conflates) under a
      // background blur whose reach (radius 30 at zoom 10: sigma 135 px, about 546 px of reach)
      // is past the 512 px band halo, wide enough for the reduced halo tiers. The view's padded
      // whole frame would fit one native pass, so `padded_view_pixels` is lowered to make the
      // view settle through apron tiles.
      const zoom = 10;
      const dpr = 1;
      const s = zoom * dpr;
      const [tw, th] = [512, 320];
      const view = { x: 40, y: 30 };
      const margin = 60; // page units of reference margin (600 px, past the reach)
      const list = new ListWriter(0xffffffff, 1);
      list.reset();
      let nextId = 1;
      const add = (x: number, y: number, w: number, h: number, ops: WireRecord["ops"]) =>
        list.set(nextId++, ROOT, {
          flags: 0,
          transform: [1, 0, 0, 1, x, y],
          opacity: 1,
          width: w,
          height: h,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [{ kind: "rect", w, h, radii: [0, 0, 0, 0], smoothing: 0 }],
          ops,
          coarse: [],
        });
      const fill = (c: [number, number, number]): WireRecord["ops"] => [
        { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [...c, 1] } },
      ];
      add(-200, -200, 600, 600, fill([1, 1, 1]));
      const palette: [number, number, number][] = [
        [0.86, 0.15, 0.15],
        [0.15, 0.39, 0.92],
        [0.09, 0.64, 0.29],
        [0.08, 0.08, 0.08],
      ];
      for (let r = 0; r < 26; r++) {
        for (let c = 0; c < 26; c++) {
          add(
            -90 + c * 10.3,
            -90 + r * 10.3,
            10.3,
            10.3,
            fill(palette[(r * 3 + c) % 4] ?? [0, 0, 0]),
          );
        }
      }
      // The blur covers the test view and a little more.
      add(view.x - 5, view.y - 5, tw / s + 10, th / s + 10, [
        { op: "backgroundBlur", paths: [0], evenOdd: false, radius: 30 },
      ]);
      const bytes = [...list.finish()];
      const res = await page.evaluate(
        async ({ bytes, zoom, dpr, tw, th, view, margin, s }) => {
          const name = "/engine.js";
          const glue = (await import(name)) as typeof import("@drawpane/engine/browser-glue");
          await glue.default({ module_or_path: "/engine_bg.wasm" });
          const bg = new Float32Array([1, 1, 1, 1]);
          const requireOk = (o: { ok: boolean; message: string; free(): void }) => {
            const { ok, message } = o;
            o.free();
            if (!ok) throw new Error(message);
          };
          const open = async (aprons: boolean) => {
            const dev = await glue.createGpu(null, 0);
            if (!dev.ok) throw new Error(dev.message);
            const engine = new glue.Engine(0, 0);
            if (
              !engine.attachGpu ||
              !engine.renderGpu ||
              !engine.gpuPixels ||
              !engine.renderGpuAhead
            )
              throw new Error("missing GPU entry points");
            requireOk(engine.attachGpu(dev));
            dev.free();
            if (aprons) requireOk(engine.setLimit("padded_view_pixels", 1));
            requireOk(engine.apply(new Uint8Array(bytes)));
            return engine;
          };
          // Native reference: a frame holding the whole reach (no reader halo).
          const ref = await open(false);
          let refPx: Uint8Array;
          let refInfo: { plan: number; exact: boolean };
          try {
            const rw = tw + 2 * margin * s;
            const rh = th + 2 * margin * s;
            const r = ref.renderGpu?.(
              rw,
              rh,
              zoom,
              -(view.x - margin) * zoom,
              -(view.y - margin) * zoom,
              dpr,
              bg,
              false,
              0,
              true,
            );
            if (!r) throw new Error("no frame");
            refInfo = { plan: r.plan, exact: r.exact };
            requireOk(r);
            const px = await ref.gpuPixels?.();
            if (!(px instanceof Uint8Array)) throw new Error(px?.message ?? "no pixels");
            refPx = new Uint8Array(tw * th * 4);
            for (let y = 0; y < th; y++) {
              const from = ((y + margin * s) * rw + margin * s) * 4;
              refPx.set(px.subarray(from, from + tw * 4), y * tw * 4);
            }
          } finally {
            ref.free();
          }
          // The view settles the way the editor does: frames at the rest budget, then slices
          // between frames, until a frame says exact or it settles without being exact.
          const settle = async (aprons: boolean) => {
            const engine = await open(aprons);
            try {
              const cam = [zoom, -view.x * zoom, -view.y * zoom, dpr] as const;
              const moving = engine.renderGpu?.(tw, th, ...cam, bg, true, 4, true);
              const movingExact = moving?.exact ?? true;
              moving?.free();
              const t0 = performance.now();
              let frames = 0;
              let last = { plan: -1, exact: false, standin: true, pending: -1 };
              while (frames < 400) {
                frames++;
                const r = engine.renderGpu?.(tw, th, ...cam, bg, false, 8, true);
                if (!r) throw new Error("no frame");
                last = { plan: r.plan, exact: r.exact, standin: r.standin, pending: r.pending };
                const inProgress = r.in_progress;
                requireOk(r);
                if (last.exact || (last.pending === 0 && !inProgress)) break;
                engine.renderGpuAhead?.(bg, 8)?.free();
              }
              const ms = performance.now() - t0;
              const px = await engine.gpuPixels?.();
              if (!(px instanceof Uint8Array)) throw new Error(px?.message ?? "no pixels");
              return { aprons, movingExact, last, frames, ms, test: Array.from(px) };
            } finally {
              engine.free();
            }
          };
          return {
            refInfo,
            ref: Array.from(refPx),
            runs: [await settle(true), await settle(false)],
          };
        },
        { bytes, zoom, dpr, tw, th, view, margin, s },
      );
      expect(res.refInfo.exact, "the reference is a native frame").toBe(true);
      for (const run of res.runs) {
        const stats = diffRegions(run.test, res.ref, tw, th);
        const route = run.aprons ? "forced aprons" : "default limits";
        console.log(
          `[zoom-blur ${build}] apron settle (${route}): ref=${JSON.stringify(res.refInfo)} ` +
            `moving exact=${run.movingExact} settled=${JSON.stringify(run.last)} after ${run.frames} ` +
            `frames, ${Math.round(run.ms)} ms; max=${stats.max} p99=${stats.p99} mean=${stats.mean.toFixed(3)}`,
        );
        expect(run.movingExact, `${route}: a moving frame is a stand-in`).toBe(false);
        // With default limits a software adapter refuses the padded view (about 2.3 M pixels);
        // the view must still settle exact, through aprons, not on the reduced halo.
        expect(run.last.exact, `${route}: the settled frame is exact`).toBe(true);
        expect(run.last.plan, `${route}: not the reduced halo`).not.toBe(4);
        if (run.aprons) expect(run.last.plan, "forced aprons settle on tiles").toBe(0);
        expect(stats.max, `${route}: max=${stats.max} p99=${stats.p99}`).toBeLessThanOrEqual(2);
        expect(stats.p99, `${route}: max=${stats.max} p99=${stats.p99}`).toBeLessThanOrEqual(1);
      }
    });
  });
}
