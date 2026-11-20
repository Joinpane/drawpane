/**
 * The built modules in Node: their glue has every member `glue.d.ts` declares, errors come back
 * typed, the Worker's CPU build and the browser build's CPU path draw the same bits, large
 * frames render in bounded bands, and the streaming PNG decodes to the same picture.
 */
import { inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { score } from "../src/compare";
import {
  type EngineModule,
  ErrorCode,
  ListWriter,
  MAX_SIDE,
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
      ])
        expect(typeof proto[name], name).toBe("function");
      expect(Array.from(m.glue.listVersion())).toEqual([1, 2]);
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
      for (const name of ["attachGpu", "renderGpu", "gpuCheck", "gpuPixels", "gpuFinished"])
        expect(typeof proto[name], name).toBe("function");
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
});
