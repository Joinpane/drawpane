/**
 * The built modules in Node: their glue has every member `glue.d.ts` declares, errors come back
 * typed, the Worker's CPU build and the browser build's CPU path draw the same bits, large
 * frames render in bounded bands, and the streaming PNG decodes to the same picture.
 */
import { inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { score } from "../src/compare";
import {
  ANY_REVISION,
  type EngineModule,
  ErrorCode,
  FLAG,
  ListWriter,
  MAX_SIDE,
  MINOR,
  PathData,
  RenderEngine,
  ROOT,
  type WireRecord,
} from "../src/index";
import { built, loadNodeEngine } from "../src/node";

const id: readonly [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

function rec(partial: Partial<WireRecord>): WireRecord {
  return {
    flags: 0,
    opacity: 1,
    transform: id,
    width: 100,
    height: 80,
    coarseBelow: 0,
    reach: 0,
    unsupported: 0,
    paths: [],
    ops: [],
    coarse: [],
    ...partial,
  };
}

/** A small scene: gradients, a rounded box with a dashed outside stroke, an ellipse, glyphs, a clip. */
function scene(revision = 1): Uint8Array {
  const w = new ListWriter(0xffffffff, revision);
  w.reset();
  w.glyph(
    1,
    new PathData()
      .moveTo(0, 0)
      .lineTo(500, 0)
      .lineTo(500, 700)
      .lineTo(0, 700)
      .close()
      .moveTo(100, 100)
      .lineTo(100, 600)
      .lineTo(400, 600)
      .lineTo(400, 100)
      .close(),
  );
  w.set(
    1,
    ROOT,
    rec({
      paths: [
        { kind: "rect", w: 300, h: 200, radii: [24, 0, 12, 40], smoothing: 0 },
        { kind: "outside", of: 0 },
      ],
      ops: [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: {
            kind: "linear",
            matrix: [300, 0, 0, 200, 0, 0],
            stops: [
              { position: 0, color: [1, 0.5, 0, 1] },
              { position: 1, color: [0, 0.3, 1, 0.6] },
            ],
          },
        },
        { op: "clip", path: 0, evenOdd: false },
        { op: "children" },
        { op: "unclip" },
        { op: "clip", path: 1, evenOdd: true },
        {
          op: "stroke",
          path: 0,
          style: { width: 8, join: 1, cap: 0, miter: 10, dashes: [10, 5], dashOffset: 2 },
          paint: { kind: "solid", color: [0, 0, 0, 1] },
        },
        { op: "unclip" },
      ],
      transform: [1, 0, 0, 1, 20, 30],
      width: 300,
      height: 200,
    }),
  );
  w.set(
    2,
    1,
    rec({
      opacity: 0.6,
      flags: 2,
      paths: [{ kind: "ellipse", w: 120, h: 90 }],
      ops: [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: {
            kind: "radial",
            matrix: [60, 0, 0, 45, 60, 45],
            stops: [
              { position: 0, color: [1, 1, 1, 1] },
              { position: 1, color: [0.2, 0, 0.4, 1] },
            ],
          },
        },
        {
          op: "stroke",
          path: 0,
          style: { width: 3, join: 0, cap: 0, miter: 10, dashes: [], dashOffset: 0 },
          paint: {
            kind: "angular",
            matrix: [60, 0, 0, 45, 60, 45],
            stops: [
              { position: 0, color: [1, 0, 0, 1] },
              { position: 1, color: [0, 0, 1, 1] },
            ],
          },
        },
      ],
      transform: [0.94, 0.34, -0.34, 0.94, 200, -20],
    }),
  );
  w.set(
    3,
    1,
    rec({
      paths: [
        {
          kind: "glyphs",
          scale: 0.016,
          glyphs: [1, 10, 150, 1, 20.3, 150, 1, 31.6, 150, 1, 43, 150],
        },
      ],
      ops: [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: { kind: "solid", color: [0.1, 0.1, 0.1, 1] },
        },
      ],
    }),
  );
  return w.finish();
}

const cam = { zoom: 1.5, x: 4, y: 6, dpr: 1 };
const BG: [number, number, number, number] = [1, 1, 1, 1];

describe.skipIf(!built("worker") && !process.env.CI)("the engine's modules", () => {
  let worker: EngineModule;
  let browser: EngineModule;
  let webgl: EngineModule;
  beforeAll(async () => {
    worker = await loadNodeEngine("worker");
    browser = await loadNodeEngine("browser");
    webgl = await loadNodeEngine("webgl");
  });

  it("have the glue glue.d.ts declares", () => {
    for (const m of [worker, browser, webgl]) {
      const proto = m.glue.Engine.prototype as unknown as Record<string, unknown>;
      for (const name of [
        "apply",
        "dirtyFor",
        "unsupported",
        "putImage",
        "dropImage",
        "renderCpu",
        "pixels",
        "renderBand",
        "pngBegin",
        "pngBand",
        "pngTake",
        "pngEnd",
        "pngAbort",
        "setLimit",
        "bandRows",
        "blurCpu",
      ])
        expect(typeof proto[name], name).toBe("function");
      expect(Array.from(m.glue.listVersion())).toEqual([1, 4]);
      expect(typeof m.glue.__drawpaneRenew).toBe("function");
    }
    expect(browser.glue.hasGpu()).toBe(true);
    expect(browser.glue.gpuBackend()).toBe("webgpu");
    expect(webgl.glue.hasGpu()).toBe(true);
    expect(webgl.glue.gpuBackend()).toBe("webgl2");
    expect(worker.glue.hasGpu()).toBe(false);
    expect(worker.glue.gpuBackend()).toBe("");
    for (const m of [browser, webgl]) {
      const proto = m.glue.Engine.prototype as unknown as Record<string, unknown>;
      for (const name of [
        "attachGpu",
        "renderGpu",
        "gpuCheck",
        "gpuPixels",
        "gpuFinished",
        "blurGpu",
        "blurGpuStats",
      ])
        expect(typeof proto[name], name).toBe("function");
    }
  });

  it("run the reference Gaussian blur bit-identically in worker, WebGPU and WebGL2 CPU builds", () => {
    const a = new RenderEngine(worker);
    const b = new RenderEngine(browser);
    const c = new RenderEngine(webgl);
    const w = 97;
    const h = 73;
    const src = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (x === 0 || y === 0 || (x >= 20 && x < 70 && y >= 15 && y < 55)) {
          src[i] = 220;
          src[i + 1] = 130;
          src[i + 2] = 60;
          src[i + 3] = 255;
        }
      }
    }
    for (const sigma of [0, 3.5, 14, 28]) {
      for (const edge of [
        { kind: "zero" as const },
        { kind: "clamp" as const },
        { kind: "border" as const, color: [0.2, 0.4, 0.6, 0.9] as const },
      ]) {
        const ra = a.blurCpu({ src, srcWidth: w, srcHeight: h, sigma, edge });
        const rb = b.blurCpu({ src, srcWidth: w, srcHeight: h, sigma, edge });
        const rc = c.blurCpu({ src, srcWidth: w, srcHeight: h, sigma, edge });
        if (!ra.ok || !rb.ok || !rc.ok) throw new Error("blurCpu failed");
        expect(Buffer.from(ra.value).equals(Buffer.from(rb.value))).toBe(true);
        expect(Buffer.from(ra.value).equals(Buffer.from(rc.value))).toBe(true);
      }
    }
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it("handles extreme Gaussian blur sigmas cleanly without trapping Wasm", () => {
    for (const mod of [worker, browser, webgl]) {
      const e = new RenderEngine(mod);
      // 1x1 Clamp is an exact constant plane at any finite sigma, including 1e9.
      const one = new Uint8Array([255, 255, 255, 255]);
      for (const sigma of [1, 1e9]) {
        const r = e.blurCpu({
          src: one,
          srcWidth: 1,
          srcHeight: 1,
          sigma,
          edge: { kind: "clamp" },
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(Array.from(r.value)).toEqual([255, 255, 255, 255]);
      }
      // 2x2 Clamp at sigma = 256 stays within bounded taps and succeeds.
      const two = new Uint8Array([
        255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
      ]);
      const ok256 = e.blurCpu({
        src: two,
        srcWidth: 2,
        srcHeight: 2,
        sigma: 256,
        edge: { kind: "clamp" },
      });
      expect(ok256.ok).toBe(true);
      // Non-constant source past MAX_BLUR_SIGMA refuses with ErrorCode.Limit without trapping.
      const refused = e.blurCpu({
        src: two,
        srcWidth: 2,
        srcHeight: 2,
        sigma: 1e9,
        edge: { kind: "clamp" },
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe(ErrorCode.Limit);
      // Shared Wasm instance stays healthy after the refusal.
      const after = e.blurCpu({
        src: one,
        srcWidth: 1,
        srcHeight: 1,
        sigma: 2,
        edge: { kind: "clamp" },
      });
      expect(after.ok).toBe(true);
      if (after.ok) expect(Array.from(after.value)).toEqual([255, 255, 255, 255]);
      e.dispose();
    }
  });

  it("draw the same bits in the Worker, WebGPU and WebGL2 builds' CPU paths", () => {
    const a = new RenderEngine(worker);
    const b = new RenderEngine(browser);
    const c = new RenderEngine(webgl);
    for (const e of [a, b, c]) expect(e.apply(scene()).ok).toBe(true);
    const ra = a.renderCpu(480, 360, cam, BG);
    const rb = b.renderCpu(480, 360, cam, BG);
    const rc = c.renderCpu(480, 360, cam, BG);
    if (!ra.ok || !rb.ok || !rc.ok) throw new Error("render failed");
    expect(Buffer.from(ra.value.pixels).equals(Buffer.from(rb.value.pixels))).toBe(true);
    expect(Buffer.from(ra.value.pixels).equals(Buffer.from(rc.value.pixels))).toBe(true);
    // And it drew something: the gradient box and the glyphs.
    const s = score(ra.value.pixels, new Uint8Array(480 * 360 * 4).fill(255), 480, 360);
    expect(s.mean).toBeGreaterThan(10);
    expect(ra.value.stats.glyphsMasked).toBe(4);
  });

  it("answer errors with codes, and never take a bad list", () => {
    const e = new RenderEngine(worker);
    const bad = scene();
    bad[4] = 9; // major version
    const r = e.apply(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrorCode.Version);
    expect(e.records).toBe(0);
    const big = e.renderCpu(MAX_SIDE + 1, 10, cam, BG);
    expect(!big.ok && big.code).toBe(ErrorCode.Limit);
    expect(e.dead).toBe(false);
  });

  it("render large frames in bands, the same as whole", () => {
    const e = new RenderEngine(worker);
    expect(e.apply(scene()).ok).toBe(true);
    const whole = e.renderCpu(480, 360, cam, BG, false);
    if (!whole.ok) throw new Error(whole.message);
    const banded = new Uint8Array(480 * 360 * 4);
    const r = e.renderBands(480, 360, cam, BG, (y0, _rows, px) => banded.set(px, y0 * 480 * 4), 64);
    expect(r.ok).toBe(true);
    expect(Buffer.from(banded).equals(Buffer.from(whole.value.pixels))).toBe(true);
  });

  it("stream a PNG band by band that decodes to the frame", () => {
    const e = new RenderEngine(worker);
    expect(e.apply(scene()).ok).toBe(true);
    const chunks: Uint8Array[] = [];
    expect(e.renderPng(480, 360, cam, BG, (c) => chunks.push(c), 64).ok).toBe(true);
    const png = Buffer.concat(chunks);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    // Decode: IDAT chunks inflated, Sub filters undone.
    const idat: Buffer[] = [];
    for (let at = 8; at < png.length; ) {
      const len = png.readUInt32BE(at);
      const type = png.subarray(at + 4, at + 8).toString();
      if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
      at += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = 480 * 4;
    const out = new Uint8Array(480 * 360 * 4);
    for (let y = 0; y < 360; y++) {
      expect(raw[y * (stride + 1)]).toBe(1);
      for (let i = 0; i < stride; i++) {
        const left = i >= 4 ? (out[y * stride + i - 4] as number) : 0;
        out[y * stride + i] = ((raw[y * (stride + 1) + 1 + i] as number) + left) & 255;
      }
    }
    const whole = e.renderCpu(480, 360, cam, BG, false);
    if (!whole.ok) throw new Error(whole.message);
    expect(Buffer.from(out).equals(Buffer.from(whole.value.pixels))).toBe(true);
  });

  it("refuses a Worker PNG export whose nested isolation and glass exceed memory_bytes without trapping", async () => {
    const cap = 25 << 20;
    const e = new RenderEngine(worker, { memoryBytes: cap });
    const width = 2048;
    const height = 1024;
    const w = new ListWriter(ANY_REVISION, 1);
    w.reset();
    for (let id = 1; id <= 24; id++) {
      w.set(
        id,
        id - 1,
        rec({
          flags: FLAG.group | FLAG.isolate,
          opacity: 0.5,
          width: 0,
          height: 0,
          ops: [{ op: "children" }],
        }),
      );
    }
    w.set(
      25,
      24,
      rec({
        width,
        height,
        paths: [{ kind: "rect", w: width, h: height, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops: [
          {
            op: "glass",
            paths: [0],
            evenOdd: false,
            kind: 0,
            inradius: 512,
            angle: -45,
            intensity: 60,
            refraction: 80,
            depth: 8,
            dispersion: 50,
            frost: 10,
            splay: 0,
            boxRadii: [0, 0, 0, 0],
            boxSmoothing: [0, 0, 0, 0],
          },
        ],
      }),
    );
    expect(e.apply(w.finish()).ok).toBe(true);
    const res = e.renderPngStream(width, height, { zoom: 1, x: 0, y: 0, dpr: 1 }, BG);
    expect(res).toMatchObject({ ok: false, code: ErrorCode.Limit });
    expect(e.dead).toBe(false);
    const small = e.renderPngStream(16, 16, { zoom: 1, x: 0, y: 0, dpr: 1 }, BG);
    if (!small.ok) throw new Error(small.message);
    const bytes = new Uint8Array(await new Response(small.value).arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(worker.memoryBytes()).toBeLessThanOrEqual(cap);
    e.dispose();
  });

  function blurExportScene(
    width: number,
    height: number,
    depth: number,
    readers: readonly ("backgroundBlur" | "progressiveBlur")[],
    radius: number,
  ): Uint8Array {
    const w = new ListWriter(ANY_REVISION, 1);
    w.reset();
    const box = (x: number, width: number, height: number): Partial<WireRecord> => ({
      transform: [1, 0, 0, 1, x, 0],
      width,
      height,
      paths: [{ kind: "rect", w: width, h: height, radii: [0, 0, 0, 0], smoothing: 0 }],
    });
    for (let i = 0; i <= 20; i++) {
      w.set(
        i + 1,
        ROOT,
        rec({
          ...box((i * 37) % width, i === 0 ? width : 9, height),
          ops: [
            {
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: {
                kind: "solid",
                color: i === 0 ? [0.9, 0.4, 0.1, 1] : [0.1, 0.1, 0.8, 0.8],
              },
            },
          ],
        }),
      );
    }
    let parent = ROOT;
    let next = 100;
    for (let i = 0; i < depth; i++) {
      w.set(
        next,
        parent,
        rec({ flags: FLAG.group | FLAG.isolate, opacity: 0.8, ops: [{ op: "children" }] }),
      );
      parent = next++;
      w.set(
        next++,
        parent,
        rec({
          ...box(0, 40, 40),
          ops: [
            {
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: { kind: "solid", color: [0, 1, 0, 0.5] },
            },
          ],
        }),
      );
    }
    for (const kind of readers) {
      w.set(
        next++,
        parent,
        rec({
          ...box(0, width, height),
          ops: [
            kind === "backgroundBlur"
              ? { op: kind, paths: [0], evenOdd: false, radius }
              : {
                  op: kind,
                  paths: [0],
                  evenOdd: false,
                  startRadius: 0,
                  endRadius: radius,
                  start: [0, 0],
                  end: [1, 1],
                },
          ],
        }),
      );
    }
    return w.finish();
  }

  async function streamBlurExport(
    mod: EngineModule,
    width: number,
    height: number,
    list: Uint8Array,
  ): Promise<boolean> {
    const e = new RenderEngine(mod);
    try {
      expect(e.apply(list).ok).toBe(true);
      const camera = { zoom: 1, x: 0, y: 0, dpr: 1 };
      const stream = e.renderPngStream(width, height, camera, BG);
      if (stream.ok) {
        const bytes = new Uint8Array(await new Response(stream.value).arrayBuffer());
        expect([...bytes.subarray(-8, -4)]).toEqual([73, 69, 78, 68]); // IEND
      } else {
        expect(stream.code, stream.message).toBe(ErrorCode.Limit);
      }
      expect(e.dead).toBe(false);
      const retry = e.renderPng(16, 16, camera, BG, () => {});
      expect(retry.ok).toBe(true);
      return stream.ok;
    } finally {
      e.dispose();
    }
  }

  it.each([
    [
      "three progressive and uniform readers",
      0,
      13,
      ["progressiveBlur", "backgroundBlur", "progressiveBlur"],
    ],
    ["three uniform readers", 0, 40, ["backgroundBlur", "backgroundBlur", "backgroundBlur"]],
    ["one reader inside seven fades", 7, 13, ["backgroundBlur"]],
  ] as const)(
    "safely admits or refuses a full-width Worker blur export with %s",
    async (_description, depth, radius, readers) => {
      const mod = await loadNodeEngine("worker", { fresh: true });
      await streamBlurExport(mod, 1988, 605, blurExportScene(1988, 605, depth, readers, radius));
    },
  );

  it("streams every admitted Worker blur export across seeded sizes, counts and group depths", async () => {
    const mod = await loadNodeEngine("worker", { fresh: true });
    let seed = 232240;
    const next = (bound: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 12) % bound;
    };
    const cases = 20;
    let admitted = 0;
    for (let i = 0; i < cases; i++) {
      const width = 128 + next(1900);
      const height = 128 + next(1000);
      const depth = next(9);
      const readers = Array.from({ length: 1 + next(4) }, () =>
        next(2) === 0 ? ("backgroundBlur" as const) : ("progressiveBlur" as const),
      );
      admitted += Number(
        await streamBlurExport(
          mod,
          width,
          height,
          blurExportScene(width, height, depth, readers, 2 + next(52)),
        ),
      );
    }
    expect(admitted).toBeGreaterThan(3);
    expect(admitted).toBeLessThan(cases);
  }, 180_000);

  it("refuses a deeply isolated whole render whose working set exceeds the Wasm address space", async () => {
    const mod = await loadNodeEngine("worker", { fresh: true });
    const e = new RenderEngine(mod);
    try {
      const list = blurExportScene(8, 8, 60, ["backgroundBlur"], 2);
      expect(e.apply(list).ok).toBe(true);
      const camera = { zoom: 1, x: 0, y: 0, dpr: 1 };
      expect(e.renderCpu(4096, 4096, camera, BG, false)).toMatchObject({
        ok: false,
        code: ErrorCode.Limit,
      });
      expect(e.dead).toBe(false);
    } finally {
      e.dispose();
    }
  });

  it("refuses an oversized whole-frame glass render before the Worker can trap", async () => {
    const mod = await loadNodeEngine("worker", { fresh: true });
    const e = new RenderEngine(mod);
    try {
      const width = 2048;
      const height = 1536;
      const w = new ListWriter(ANY_REVISION, 1);
      w.reset();
      w.set(
        1,
        ROOT,
        rec({
          width,
          height,
          paths: [{ kind: "rect", w: width, h: height, radii: [0, 0, 0, 0], smoothing: 0 }],
          ops: [
            {
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: { kind: "solid", color: [0.9, 0.4, 0.1, 1] },
            },
            {
              op: "glass",
              paths: [0],
              evenOdd: false,
              kind: 0,
              inradius: 700,
              angle: -45,
              intensity: 65,
              refraction: 50,
              depth: 30,
              dispersion: 50,
              frost: 60,
              splay: 0,
              boxRadii: [0, 0, 0, 0],
              boxSmoothing: [0, 0, 0, 0],
            },
          ],
        }),
      );
      expect(e.apply(w.finish()).ok).toBe(true);
      const camera = { zoom: 1, x: 0, y: 0, dpr: 1 };
      expect(e.renderCpu(width, height, camera, BG, false)).toMatchObject({
        ok: false,
        code: ErrorCode.Limit,
      });
      expect(e.dead).toBe(false);
      expect(e.apply(scene(2)).ok).toBe(true);
      expect(e.renderCpu(16, 16, camera, BG, false).ok).toBe(true);
    } finally {
      e.dispose();
    }
  });

  it("checks wire version compatibility on RenderEngine construction and rejects incompatible wire versions", () => {
    const stale: EngineModule = {
      ...worker,
      glue: {
        ...worker.glue,
        listVersion: () => new Uint32Array([1, 2]),
      },
    };
    const staleEngine = new RenderEngine(stale);
    expect(staleEngine.dead).toBe(true);
    const staleApply = staleEngine.apply(scene());
    expect(staleApply.ok).toBe(false);
    if (!staleApply.ok) expect(staleApply.code).toBe(ErrorCode.Version);
    staleEngine.dispose();

    const e = new RenderEngine(worker);
    // Export context is valid from 1.3 onwards. A 1.2 header must fail with Version.
    const w = new ListWriter(ANY_REVISION, 1);
    w.reset();
    w.set(
      1,
      ROOT,
      rec({
        flags: FLAG.context,
        width: 64,
        height: 64,
        paths: [{ kind: "rect", w: 64, h: 64, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops: [
          { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 0, 0, 1] } },
        ],
      }),
    );
    const bytes = w.finish();
    const asV12 = bytes.slice();
    asV12[6] = 2; // minor = 2
    const r12 = e.apply(asV12);
    expect(r12.ok).toBe(false);
    if (!r12.ok) expect(r12.code).toBe(ErrorCode.Version);

    const future = bytes.slice();
    future[6] = MINOR + 1;
    const newer = e.apply(future);
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.code).toBe(ErrorCode.Version);

    const asV13 = bytes.slice();
    asV13[6] = 3;
    expect(e.apply(asV13).ok).toBe(true);
    e.dispose();
  });
});
