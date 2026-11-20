import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { memoryLimits } from "../../raster/src/wasm-limits";
import {
  type EngineBuild,
  type EngineModule,
  ErrorCode,
  FLAG,
  ListWriter,
  loadEngineSync,
  RenderEngine,
  ROOT,
} from "../src/index";
import { built, loadNodeEngine, wasmPath } from "../src/node";

describe.skipIf(!built())("The Worker artifact and exports (review of PR 216)", () => {
  it("ships the 25 MiB linear memory maximum in the public Worker artifact", () => {
    expect(memoryLimits(readFileSync(wasmPath("worker")))?.max).toBe((25 << 20) / 65536);
  });

  it("refuses an unsupported operation even when it is outside the PNG's crop", async () => {
    const w = new ListWriter(0xffffffff, 1);
    w.reset();
    w.set(1, ROOT, {
      flags: 0,
      opacity: 1,
      transform: [1, 0, 0, 1, 1000, 1000],
      width: 10,
      height: 10,
      coarseBelow: 0,
      reach: 0,
      unsupported: 1,
      paths: [],
      ops: [],
      coarse: [],
    });
    const engine = new RenderEngine(await loadNodeEngine());
    try {
      expect(engine.apply(w.finish()).ok).toBe(true);
      expect(
        engine.renderPng(32, 32, { zoom: 1, x: 0, y: 0, dpr: 1 }, [0, 0, 0, 0], () => {}),
      ).toMatchObject({ ok: false, code: ErrorCode.Unsupported });
    } finally {
      engine.dispose();
    }
  });
});

describe.skipIf(!built())("Export revision consistency (review of PR 216)", () => {
  it("keeps a streaming PNG on one revision if a patch arrives between bands", async () => {
    const module = await loadNodeEngine();
    const expected = new RenderEngine(module);
    const tested = new RenderEngine(module);
    const camera = { zoom: 1, x: 0, y: 0, dpr: 1 };
    const clear = [0, 0, 0, 0] as const;
    const initial = new ListWriter(0xffffffff, 1);
    initial.reset();
    const record = {
      flags: 0,
      opacity: 1,
      transform: [1, 0, 0, 1, 0, 0] as const,
      width: 32,
      height: 64,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect" as const, w: 32, h: 64, radii: [0, 0, 0, 0] as const, smoothing: 0 }],
      coarse: [],
    };
    const filled = (color: readonly [number, number, number, number]) => ({
      ...record,
      ops: [
        { op: "fill" as const, path: 0, evenOdd: false, paint: { kind: "solid" as const, color } },
      ],
    });
    initial.set(1, ROOT, filled([1, 0, 0, 1]));
    const patch = new ListWriter(1, 2);
    patch.set(1, ROOT, filled([0, 0, 1, 1]));
    try {
      expect(expected.apply(initial.finish()).ok).toBe(true);
      expect(tested.apply(initial.finish()).ok).toBe(true);
      const expectedChunks: Uint8Array[] = [];
      expect(expected.renderPng(32, 64, camera, clear, (c) => expectedChunks.push(c), 4).ok).toBe(
        true,
      );
      const started = tested.renderPngStream(32, 64, camera, clear, 4);
      if (!started.ok) throw new Error(started.message);
      const reader = started.value.getReader();
      const first = await reader.read();
      if (first.done) throw new Error("PNG fixture ended before the patch");
      const applied = tested.apply(patch.finish());
      if (!applied.ok) expect(applied.code).toBe(ErrorCode.State);
      const actual = [first.value];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        actual.push(next.value);
      }
      const png = Buffer.concat(actual);
      const idat: Buffer[] = [];
      for (let i = 8; i < png.length; ) {
        const length = png.readUInt32BE(i);
        if (png.toString("ascii", i + 4, i + 8) === "IDAT")
          idat.push(png.subarray(i + 8, i + 8 + length));
        i += 12 + length;
      }
      const scanlines = inflateSync(Buffer.concat(idat));
      const firstPixel = (row: number) => {
        const at = row * (32 * 4 + 1) + 1;
        return [...scanlines.subarray(at, at + 4)];
      };
      expect(firstPixel(0)).toEqual([255, 0, 0, 255]);
      expect(firstPixel(63)).toEqual([255, 0, 0, 255]);
      expect(png.equals(Buffer.concat(expectedChunks))).toBe(true);
    } finally {
      tested.dispose();
      expected.dispose();
    }
  });
});

describe.skipIf(!built())("Recovery and stream lifetimes", () => {
  const camera = { zoom: 1, x: 0, y: 0, dpr: 1 };
  const clear = [0, 0, 0, 0] as const;
  const square = () => {
    const w = new ListWriter(0xffffffff, 1);
    w.reset();
    w.set(1, ROOT, {
      flags: 0,
      opacity: 1,
      transform: [1, 0, 0, 1, 0, 0],
      width: 16,
      height: 16,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w: 16, h: 16, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops: [{ op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 0, 0, 1] } }],
      coarse: [],
    });
    return w.finish();
  };

  it("renews the module after a trap, so the next engine works", async () => {
    // A fresh module of its own: the trap takes its instance down.
    const module = await loadNodeEngine("worker", { fresh: true });
    // Past its 25 MiB of linear memory, the Worker build can't take a 32 MiB message in: a trap.
    const greedy = new RenderEngine(module, { messageBytes: 64 << 20 });
    const r = greedy.apply(new Uint8Array(32 << 20));
    expect(r).toMatchObject({ ok: false, code: ErrorCode.Trap });
    expect(greedy.dead).toBe(true);
    expect(module.trapped).toBe(true);
    const next = new RenderEngine(module);
    expect(next.dead).toBe(false);
    expect(next.apply(square()).ok).toBe(true);
    const frame = next.renderCpu(16, 16, camera, clear, false);
    expect(frame.ok && frame.value.pixels[0]).toBe(255);
    next.dispose();
  });

  it("lets the engine go, and take patches again, when a stream is cancelled", async () => {
    const engine = new RenderEngine(await loadNodeEngine());
    expect(engine.apply(square()).ok).toBe(true);
    let ended = 0;
    const started = engine.renderPngStream(16, 64, camera, clear, 4, () => ended++);
    if (!started.ok) throw new Error(started.message);
    // A second export on the same engine waits its turn.
    expect(engine.renderPngStream(16, 16, camera, clear)).toMatchObject({
      ok: false,
      code: ErrorCode.State,
    });
    const reader = started.value.getReader();
    await reader.read();
    await reader.cancel();
    expect(ended).toBe(1);
    const patch = new ListWriter(1, 2);
    patch.remove(1);
    expect(engine.apply(patch.finish()).ok).toBe(true);
    engine.dispose();
  });

  it("refuses an export too large for the Worker's memory before any byte", async () => {
    const engine = new RenderEngine(await loadNodeEngine(), { memoryBytes: 4 << 20 });
    expect(engine.apply(square()).ok).toBe(true);
    expect(engine.renderPngStream(8192, 8192, camera, clear)).toMatchObject({
      ok: false,
      code: ErrorCode.Limit,
    });
    // Nothing is left pinned: patches go through.
    const patch = new ListWriter(1, 2);
    patch.remove(1);
    expect(engine.apply(patch.finish()).ok).toBe(true);
    engine.dispose();
  });

  it("handles large-radius drop shadows in the 25 MiB Worker without trapping Wasm", async () => {
    const module = await loadNodeEngine("worker", { fresh: true });
    const w = 4096;
    const h = 1800;
    for (const radius of [128, 256, 384, 700]) {
      const e = new RenderEngine(module);
      const list = new ListWriter(0xffffffff, 1);
      list.reset();
      list.set(1, ROOT, {
        flags: 0,
        opacity: 1,
        transform: [1, 0, 0, 1, 0, 0],
        width: w,
        height: h,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w, h, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops: [
          {
            op: "dropShadow",
            paths: [0],
            evenOdd: false,
            dx: 4,
            dy: 4,
            blur: radius,
            color: [0, 0, 0, 0.8],
            blend: 0,
          },
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [1, 0.3, 0.2, 1] },
          },
        ],
        coarse: [],
      });
      expect(e.apply(list.finish()).ok).toBe(true);
      const started = e.renderPngStream(w, h, camera, clear);
      if (started.ok) {
        const reader = started.value.getReader();
        let chunks = 0;
        try {
          for (let i = 0; i < 8; i++) {
            const r = await reader.read();
            if (r.done) break;
            chunks++;
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        expect(chunks).toBeGreaterThan(0);
      } else {
        expect(started.code).toBe(ErrorCode.Limit);
      }
      expect(e.dead).toBe(false);
      expect(module.trapped).not.toBe(true);
      e.dispose();
    }
    // Extreme sigma past MAX_BLUR_SIGMA refuses cleanly at admission without trapping Wasm.
    const extreme = new RenderEngine(module);
    const list = new ListWriter(0xffffffff, 1);
    list.reset();
    list.set(1, ROOT, {
      flags: 0,
      opacity: 1,
      transform: [1, 0, 0, 1, 0, 0],
      width: 64,
      height: 64,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w: 64, h: 64, radii: [0, 0, 0, 0], smoothing: 0 }],
      ops: [
        {
          op: "dropShadow",
          paths: [0],
          evenOdd: false,
          dx: 0,
          dy: 0,
          blur: 10000,
          color: [0, 0, 0, 0.5],
          blend: 0,
        },
        { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: [1, 0, 0, 1] } },
      ],
      coarse: [],
    });
    expect(extreme.apply(list.finish()).ok).toBe(true);
    expect(extreme.renderPngStream(64, 64, camera, clear)).toMatchObject({
      ok: false,
      code: ErrorCode.Limit,
    });
    expect(extreme.dead).toBe(false);
    expect(module.trapped).not.toBe(true);
    extreme.dispose();
  });

  it("handles large-radius layer blurs in the 25 MiB Worker without trapping Wasm", async () => {
    const module = await loadNodeEngine("worker", { fresh: true });
    const w = 4096;
    const h = 1800;
    const cam = { zoom: 1, x: 0, y: 0, dpr: 1 };
    for (const radius of [128, 256, 384, 700, 10000]) {
      const e = new RenderEngine(module);
      const list = new ListWriter(0xffffffff, 1);
      list.reset();
      list.set(1, ROOT, {
        flags: FLAG.post,
        opacity: 1,
        transform: [1, 0, 0, 1, 0, 0],
        width: w,
        height: h,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w, h, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops: [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [1, 0.3, 0.2, 1] },
          },
        ],
        coarse: [],
        postEffects: [{ kind: "layerBlur", radius }],
      });
      expect(e.apply(list.finish()).ok).toBe(true);
      const started = e.renderPngStream(w, h, cam, clear);
      if (radius >= 700) {
        expect(started).toMatchObject({ ok: false, code: ErrorCode.Limit });
      } else if (started.ok) {
        const reader = started.value.getReader();
        let chunks = 0;
        try {
          for (let i = 0; i < 6; i++) {
            const r = await reader.read();
            if (r.done) break;
            chunks++;
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        expect(chunks).toBeGreaterThan(0);
      } else {
        expect(started.code).toBe(ErrorCode.Limit);
      }
      expect(e.dead).toBe(false);
      expect(module.trapped).not.toBe(true);
      e.dispose();
    }
  });

  it("handles large-radius textures in the 25 MiB Worker without trapping Wasm", async () => {
    const module = await loadNodeEngine("worker", { fresh: true });
    const w = 4096;
    const h = 1800;
    for (const [radius, zoom] of [
      [12, 1],
      [100, 1],
      [100, 20],
    ] as const) {
      const cam = { zoom, x: 0, y: 0, dpr: 1 };
      const e = new RenderEngine(module);
      const list = new ListWriter(0xffffffff, 1);
      list.reset();
      list.set(1, ROOT, {
        flags: FLAG.post,
        opacity: 1,
        transform: [1, 0, 0, 1, 0, 0],
        width: w,
        height: h,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w, h, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops: [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.3, 0.6, 0.9, 1] },
          },
        ],
        coarse: [],
        postEffects: [{ kind: "texture", size: 4, radius, clipToShape: false }],
      });
      expect(e.apply(list.finish()).ok).toBe(true);
      const started = e.renderPngStream(w, h, cam, clear);
      if (started.ok) {
        const reader = started.value.getReader();
        let chunks = 0;
        try {
          for (let i = 0; i < 4; i++) {
            const r = await reader.read();
            if (r.done) break;
            chunks++;
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        expect(chunks).toBeGreaterThan(0);
      } else {
        expect(started.code).toBe(ErrorCode.Limit);
      }
      expect(e.dead).toBe(false);
      expect(module.trapped).not.toBe(true);
      e.dispose();
    }
  });

  it("refuses or streams noise, texture, and multi-step post chains under tight Worker memory without trapping", async () => {
    const module = await loadNodeEngine("worker", { fresh: true });
    const cam = { zoom: 1, x: 0, y: 0, dpr: 1 };
    const cases: Array<{
      name: string;
      w: number;
      h: number;
      memoryBytes?: number;
      mustRefuse?: boolean;
      rejectWire?: boolean;
      postEffects: NonNullable<Parameters<ListWriter["set"]>[2]["postEffects"]>;
    }> = [
      {
        name: "noise under tight 4 MiB Worker budget",
        w: 512,
        h: 512,
        memoryBytes: 4 << 20,
        mustRefuse: true,
        postEffects: [
          {
            kind: "noise",
            noiseType: 0,
            size: 1.5,
            density: 65,
            color: [0, 0, 0, 0.7],
            secondaryColor: [1, 1, 1, 1],
            opacity: 1,
          },
        ],
      },
      {
        name: "texture under tight 2 MiB Worker budget",
        w: 512,
        h: 512,
        memoryBytes: 2 << 20,
        mustRefuse: true,
        postEffects: [{ kind: "texture", size: 4, radius: 18, clipToShape: false }],
      },
      {
        name: "multi-step blur + texture + noise chain at 4096x1800 in 25 MiB Worker",
        w: 4096,
        h: 1800,
        postEffects: [
          { kind: "layerBlur", radius: 220 },
          { kind: "texture", size: 4, radius: 100, clipToShape: false },
          {
            kind: "noise",
            noiseType: 2,
            size: 1.4,
            density: 70,
            color: [0, 0, 0, 1],
            secondaryColor: [1, 1, 1, 1],
            opacity: 0.7,
          },
        ],
      },
      {
        name: "extreme texture lattice scale",
        w: 256,
        h: 256,
        rejectWire: true,
        postEffects: [{ kind: "texture", size: 1e-8, radius: 8, clipToShape: false }],
      },
      {
        name: "texture radius outside the editor range",
        w: 256,
        h: 256,
        rejectWire: true,
        postEffects: [{ kind: "texture", size: 3, radius: 101, clipToShape: false }],
      },
    ];
    for (const c of cases) {
      const e = new RenderEngine(
        module,
        c.memoryBytes !== undefined ? { memoryBytes: c.memoryBytes } : undefined,
      );
      const list = new ListWriter(0xffffffff, 1);
      list.reset();
      list.set(1, ROOT, {
        flags: FLAG.post,
        opacity: 1,
        transform: [1, 0, 0, 1, 0, 0],
        width: c.w,
        height: c.h,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w: c.w, h: c.h, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops: [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.3, 0.5, 0.8, 1] },
          },
        ],
        coarse: [],
        postEffects: c.postEffects,
      });
      const applied = e.apply(list.finish());
      if (c.rejectWire) {
        expect(applied, c.name).toMatchObject({ ok: false, code: ErrorCode.Limit });
        expect(e.dead, c.name).toBe(false);
        e.dispose();
        continue;
      }
      expect(applied.ok, c.name).toBe(true);
      const started = e.renderPngStream(c.w, c.h, cam, clear);
      if (c.mustRefuse) {
        expect(started, c.name).toMatchObject({ ok: false, code: ErrorCode.Limit });
      } else if (started.ok) {
        const reader = started.value.getReader();
        let chunks = 0;
        try {
          for (let i = 0; i < 4; i++) {
            const r = await reader.read();
            if (r.done) break;
            chunks++;
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        expect(chunks, c.name).toBeGreaterThan(0);
      } else {
        expect(started.code, c.name).toBe(ErrorCode.Limit);
      }
      expect(e.dead, c.name).toBe(false);
      expect(module.trapped, c.name).not.toBe(true);
      e.dispose();
    }
  });

  it("matches whole-frame and 73-row banded CPU renders bit-for-bit across shadow and layer-blur seams", async () => {
    const module = await loadNodeEngine("worker");
    const w = 1157;
    const h = 305;
    const cam = { zoom: 1, x: 13.42, y: -7.57, dpr: 1.35 };
    const cases: Array<{
      name: string;
      shadow?: number;
      blurs?: number[];
      postEffects?: Parameters<ListWriter["set"]>[2]["postEffects"];
      blend?: number;
      mask?: { kind: number; blur?: number };
    }> = [
      { name: "shadow only", shadow: 35 },
      { name: "blur only odd", blurs: [24] },
      { name: "blur plus shadow", blurs: [32], shadow: 68 },
      { name: "two successive blurs", blurs: [17, 43] },
      { name: "large blur plus shadow", blurs: [280], shadow: 89 },
      { name: "blended multiply plus shadow", shadow: 35, blend: 1 },
      { name: "blended linear-dodge plus blur", blurs: [24], blend: 16 },
      { name: "alpha picture mask", mask: { kind: 4 } },
      { name: "luminance picture mask", mask: { kind: 5 } },
      { name: "blurred alpha picture mask", mask: { kind: 4, blur: 18 } },
      {
        name: "mono noise",
        postEffects: [
          {
            kind: "noise",
            noiseType: 0,
            size: 1.8,
            density: 65,
            color: [0.05, 0.05, 0.05, 0.7],
            secondaryColor: [1, 1, 1, 1],
            opacity: 1,
          },
        ],
      },
      {
        name: "duo and multi noise",
        postEffects: [
          {
            kind: "noise",
            noiseType: 1,
            size: 2.2,
            density: 55,
            color: [0.1, 0.1, 0.1, 0.65],
            secondaryColor: [1, 1, 1, 0.7],
            opacity: 1,
          },
          {
            kind: "noise",
            noiseType: 2,
            size: 1.2,
            density: 70,
            color: [0, 0, 0, 1],
            secondaryColor: [1, 1, 1, 1],
            opacity: 0.6,
          },
        ],
      },
      {
        name: "unclipped texture",
        postEffects: [{ kind: "texture", size: 4.5, radius: 14, clipToShape: false }],
      },
      {
        name: "clipped texture plus blur plus noise",
        postEffects: [
          { kind: "layerBlur", radius: 14 },
          {
            kind: "noise",
            noiseType: 0,
            size: 1.5,
            density: 60,
            color: [0, 0, 0, 0.5],
            secondaryColor: [1, 1, 1, 1],
            opacity: 1,
          },
          { kind: "texture", size: 3.5, radius: 9, clipToShape: true },
        ],
      },
    ];
    for (const c of cases) {
      const e = new RenderEngine(module);
      const list = new ListWriter(0xffffffff, 1);
      list.reset();
      list.set(10, ROOT, {
        flags: 0,
        opacity: 1,
        transform: [1, 0, 0, 1, 0, 0],
        width: w,
        height: h,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w, h, radii: [0, 0, 0, 0], smoothing: 0 }],
        ops: [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.35, 0.55, 0.75, 1] },
          },
        ],
        coarse: [],
      });
      if (c.mask) {
        list.set(20, ROOT, {
          flags: FLAG.mask | (c.mask.blur ? FLAG.post : 0),
          opacity: 1,
          transform: [1.15, 0.14, -0.18, 0.94, 620.25, 45.75],
          width: 340,
          height: 150,
          coarseBelow: 0,
          reach: 0,
          unsupported: 0,
          paths: [{ kind: "rect", w: 340, h: 150, radii: [20, 20, 20, 20], smoothing: 0 }],
          ops: [
            {
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: {
                kind: "linear",
                matrix: [340, 0, 0, 150, 0, 0],
                stops: [
                  { position: 0, color: [1, 1, 1, 1] },
                  { position: 1, color: [0, 0, 0, 0.1] },
                ],
              },
            },
          ],
          coarse: [],
          ...(c.mask.blur ? { postEffects: [{ kind: "layerBlur", radius: c.mask.blur }] } : {}),
          mask: c.mask.kind,
        });
      }
      const posts =
        c.postEffects ?? c.blurs?.map((radius) => ({ kind: "layerBlur" as const, radius }));
      list.set(1, ROOT, {
        flags: (posts ? FLAG.post : 0) | (c.blend ? FLAG.blend : 0),
        opacity: 1,
        transform: [1.19, 0.22, -0.26, 0.91, 650.37, 79.53],
        width: 312,
        height: 108,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w: 312, h: 108, radii: [9, 9, 9, 9], smoothing: 0 }],
        ops: [
          ...(c.shadow
            ? [
                {
                  op: "dropShadow" as const,
                  paths: [0],
                  evenOdd: false,
                  dx: 19,
                  dy: -11,
                  blur: c.shadow,
                  color: [0, 0, 0, 0.78] as const,
                  blend: 0,
                },
              ]
            : []),
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [1, 0.3, 0.2, 1] },
          },
        ],
        coarse: [],
        ...(posts ? { postEffects: posts } : {}),
        ...(c.blend ? { blend: c.blend } : {}),
      });
      list.order(ROOT, c.mask ? [10, 20, 1] : [10, 1]);
      expect(e.apply(list.finish()).ok, c.name).toBe(true);
      const full = e.renderCpu(w, h, cam, clear, false);
      if (!full.ok) throw new Error(`${c.name}: ${full.message}`);
      let diffs = 0;
      const banded = e.renderBands(
        w,
        h,
        cam,
        clear,
        (y0, _rows, part) => {
          for (let i = 0; i < part.length; i++) {
            if (part[i] !== full.value.pixels[y0 * w * 4 + i]) diffs++;
          }
        },
        73,
      );
      expect(banded.ok, c.name).toBe(true);
      expect(diffs, c.name).toBe(0);
      e.dispose();
    }
  });
});

describe.skipIf(!built())(
  "Operations the engine refuses, from the wire (re-check of PR 216)",
  () => {
    it("refuses a page holding a backdrop reader before any PNG byte, even outside the crop", async () => {
      const w = new ListWriter(0xffffffff, 1);
      w.reset();
      const base = (x: number, ops: Parameters<ListWriter["set"]>[2]["ops"]) => ({
        flags: 0,
        opacity: 1,
        transform: [1, 0, 0, 1, x, 0] as const,
        width: 16,
        height: 16,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [
          { kind: "rect" as const, w: 16, h: 16, radii: [0, 0, 0, 0] as const, smoothing: 0 },
        ],
        ops,
        coarse: [],
      });
      w.set(
        1,
        ROOT,
        base(0, [
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: {
              kind: "diamond",
              matrix: [16, 0, 0, 16, 0, 0],
              stops: [
                { position: 0, color: [1, 0, 0, 1] },
                { position: 1, color: [0, 0, 1, 1] },
              ],
            },
          },
        ]),
      );
      w.set(2, ROOT, base(5000, [{ op: "read", kernel: 0, halo: 4 }]));
      const engine = new RenderEngine(await loadNodeEngine());
      try {
        expect(engine.apply(w.finish()).ok).toBe(true);
        expect(
          engine.renderPngStream(32, 32, { zoom: 1, x: 0, y: 0, dpr: 1 }, [0, 0, 0, 0]),
        ).toMatchObject({ ok: false, code: ErrorCode.Unsupported });
        expect(engine.unsupported()).toMatchObject({ ok: true, value: [[2, 1 << 13]] });
      } finally {
        engine.dispose();
      }
    });
  },
);

describe.skipIf(!built())("Direct Worker renderCpu memory bounds (PR #239)", () => {
  it("renders or refuses cleanly without trapping Wasm across 25 MiB, 16 MiB, tight budgets, and raw glue", async () => {
    const w = 848;
    const h = 1202;
    const cam = { zoom: 1, x: 0, y: 0, dpr: 1 };
    const bg = [0, 0, 0, 0] as const;
    const list = new ListWriter(0xffffffff, 1);
    list.reset();
    // Build a multi-shadow + multi-layer-blur frame matching the Drawer fixture's 848x1202 footprint.
    const order: number[] = [];
    list.set(1, ROOT, {
      flags: 0,
      opacity: 1,
      transform: [1, 0, 0, 1, 0, 0],
      width: w,
      height: h,
      coarseBelow: 0,
      reach: 0,
      unsupported: 0,
      paths: [{ kind: "rect", w, h, radii: [16, 16, 16, 16], smoothing: 0 }],
      ops: [
        {
          op: "fill",
          path: 0,
          evenOdd: false,
          paint: { kind: "solid", color: [0.96, 0.96, 0.97, 1] },
        },
      ],
      coarse: [],
    });
    order.push(1);
    for (let i = 0; i < 16; i++) {
      const id = 10 + i;
      const y = 32 + i * 70;
      list.set(id, ROOT, {
        flags: i % 3 === 0 ? FLAG.post : 0,
        opacity: 1,
        transform: [1, 0, 0, 1, 24, y],
        width: 800,
        height: 54,
        coarseBelow: 0,
        reach: 0,
        unsupported: 0,
        paths: [{ kind: "rect", w: 800, h: 54, radii: [10, 10, 10, 10], smoothing: 0 }],
        ops: [
          {
            op: "dropShadow",
            paths: [0],
            evenOdd: false,
            dx: 0,
            dy: 6,
            blur: 24,
            color: [0, 0, 0, 0.35],
            blend: 0,
          },
          {
            op: "fill",
            path: 0,
            evenOdd: false,
            paint: { kind: "solid", color: [0.2 + (i % 4) * 0.15, 0.45, 0.78, 1] },
          },
        ],
        coarse: [],
        ...(i % 3 === 0 ? { postEffects: [{ kind: "layerBlur", radius: 22 }] } : {}),
      });
      order.push(id);
    }
    list.order(ROOT, order);
    const wire = list.finish();

    // Browser uncapped reference pixels.
    let refPixels: Uint8Array | null = null;
    if (built("browser")) {
      const bMod = await loadNodeEngine("browser", { fresh: true });
      const bEng = new RenderEngine(bMod);
      expect(bEng.apply(wire).ok).toBe(true);
      const bRes = bEng.renderCpu(w, h, cam, bg, false);
      if (!bRes.ok) throw new Error(bRes.message);
      refPixels = bRes.value.pixels;
      bEng.dispose();
    }

    // Fresh Worker instances at 25 MiB and 16 MiB must match the reference to one color level or refuse with Limit.
    for (const budget of [25 << 20, 16 << 20] as const) {
      const wMod = await loadNodeEngine("worker", { fresh: true });
      const e = new RenderEngine(wMod, { memoryBytes: budget });
      expect(e.apply(wire).ok).toBe(true);
      const r = e.renderCpu(w, h, cam, bg, false);
      expect(e.dead, `budget=${budget}`).toBe(false);
      expect(wMod.trapped, `budget=${budget}`).not.toBe(true);
      if (r.ok) {
        expect(r.value.pixels.length).toBe(w * h * 4);
        if (refPixels) {
          let differences = 0;
          let max = 0;
          let first = -1;
          for (const [i, value] of r.value.pixels.entries()) {
            const delta = Math.abs(value - (refPixels[i] as number));
            if (delta > 0) {
              if (first < 0) first = i;
              differences++;
              max = Math.max(max, delta);
            }
          }
          expect(
            max,
            `budget=${budget}, ${differences} differences, first=(${(first >> 2) % w},${Math.floor((first >> 2) / w)})`,
          ).toBeLessThanOrEqual(1);
        }
      } else {
        expect(r.code).toBe(ErrorCode.Limit);
      }
      e.dispose();
    }

    // Tight budget smaller than the framebuffer alone refuses cleanly with Limit before allocating.
    {
      const wMod = await loadNodeEngine("worker", { fresh: true });
      const e = new RenderEngine(wMod, { memoryBytes: 4 << 20 });
      expect(e.apply(wire).ok).toBe(true);
      const r = e.renderCpu(w, h, cam, bg, false);
      expect(r).toMatchObject({ ok: false, code: ErrorCode.Limit });
      expect(e.dead).toBe(false);
      expect(wMod.trapped).not.toBe(true);
      e.dispose();
    }

    // Raw worker glue (without RenderEngine facade) also enforces the 25 MiB cap and never traps.
    {
      const wMod = await loadNodeEngine("worker", { fresh: true });
      const raw = new wMod.glue.Engine(0, 0);
      const applied = raw.apply(wire);
      expect(applied.ok, applied.message).toBe(true);
      applied.free();
      const rendered = raw.renderCpu(
        w,
        h,
        cam.zoom,
        cam.x,
        cam.y,
        cam.dpr,
        new Float32Array(bg),
        false,
      );
      if (rendered.ok) {
        const px = raw.pixels();
        expect(px.length).toBe(w * h * 4);
      } else {
        expect(rendered.code).toBe(ErrorCode.Limit);
      }
      rendered.free();
      raw.free();
    }
  });
});

describe.skipIf(!built())("Engines sharing a module (re-check of PR 216)", () => {
  const fresh = (revision: number) => {
    const w = new ListWriter(0xffffffff, revision);
    w.reset();
    return w.finish();
  };

  it("refuses an image past the Worker's budget before copying it, and the other engine lives", async () => {
    const module = await loadNodeEngine("worker", { fresh: true });
    const a = new RenderEngine(module);
    const b = new RenderEngine(module);
    expect(a.apply(fresh(7)).ok).toBe(true);
    // 2,048² RGBA is 16 MiB, past the Worker's 6 MiB of images: refused, not a trap.
    const big = new Uint8Array(2048 * 2048 * 4);
    expect(b.putImage(1, 2048, 2048, big)).toMatchObject({ ok: false, code: ErrorCode.Limit });
    expect(b.dead).toBe(false);
    expect(a.dead).toBe(false);
    expect(a.revision).toBe(7);
    // Bytes that don't match the size are refused too, before any copy.
    expect(b.putImage(2, 4, 4, new Uint8Array(10))).toMatchObject({
      ok: false,
      code: ErrorCode.Image,
    });
    a.dispose();
    b.dispose();
  });

  it("kills every engine on a module that trapped, so none sees the renewed instance", async () => {
    const module = await loadNodeEngine("worker", { fresh: true });
    const a = new RenderEngine(module);
    expect(a.apply(fresh(7)).ok).toBe(true);
    const greedy = new RenderEngine(module, { messageBytes: 64 << 20 });
    expect(greedy.apply(new Uint8Array(32 << 20))).toMatchObject({
      ok: false,
      code: ErrorCode.Trap,
    });
    // The first engine's memory went with the instance: it's dead, not pointing into the next.
    expect(a.dead).toBe(true);
    const c = new RenderEngine(module);
    expect(c.apply(fresh(42)).ok).toBe(true);
    expect(c.revision).toBe(42);
    expect(a.revision).toBe(0);
    expect(a.apply(fresh(43))).toMatchObject({ ok: false, code: ErrorCode.Trap });
    expect(c.revision).toBe(42);
    // Disposing the dead engines frees nothing in the new instance.
    a.dispose();
    greedy.dispose();
    expect(c.revision).toBe(42);
    expect(c.apply(fresh(43)).ok).toBe(true);
    c.dispose();
  });

  for (const build of ["worker", "browser", "webgl"] as const satisfies readonly EngineBuild[]) {
    it(`shares WASM epoch across separate loadEngineSync wrappers on real ${build} glue`, async () => {
      if (!built(build)) return;
      const m1 = await loadNodeEngine(build, { fresh: true });
      const m2 = loadEngineSync(m1.glue, readFileSync(wasmPath(build)), build);
      expect(m1.glue).toBe(m2.glue);
      const a = new RenderEngine(m1);
      const b = new RenderEngine(m2);
      const bytes = fresh(1);
      expect(a.apply(bytes).ok).toBe(true);
      expect(b.apply(bytes).ok).toBe(true);

      const originalApply = m1.glue.Engine.prototype.apply;
      m1.glue.Engine.prototype.apply = () => {
        throw new WebAssembly.RuntimeError("injected unreachable");
      };
      try {
        expect(a.apply(bytes)).toMatchObject({ ok: false, code: ErrorCode.Trap });
      } finally {
        m1.glue.Engine.prototype.apply = originalApply;
      }

      // Sibling from second wrapper must immediately see the shared epoch bump and mark itself dead.
      expect(m1.epoch).toBe(1);
      expect(m2.epoch).toBe(1);
      expect(m2.trapped).toBe(true);
      expect(b.dead).toBe(true);

      const renewed = new RenderEngine(m1);
      expect(renewed.dead).toBe(false);
      expect(renewed.apply(fresh(2)).ok).toBe(true);
      expect(b.apply(fresh(3))).toMatchObject({ ok: false, code: ErrorCode.Trap });
      // Disposing the dead sibling must not touch the renewed instance.
      b.dispose();
      expect(renewed.revision).toBe(2);
      renewed.dispose();
    });

    it(`releases the dead Wasm heap and cached views on ${build} default glue after renewal`, async () => {
      if (!built(build)) return;
      const url = new URL(`../dist/${build}/engine.js`, import.meta.url).href;
      const freshGlue = (await import(
        /* @vite-ignore */ `${url}?quiesce-release=${build}-${Date.now()}`
      )) as typeof import("../src/glue");
      const bytes = readFileSync(wasmPath(build));
      const exports = freshGlue.initSync({ module: bytes }) as { memory: WebAssembly.Memory };
      // Grow memory past 64 MiB (Worker caps at 25 MiB, so grow 12 MiB there).
      const growPages = build === "worker" ? 192 : 1024;
      exports.memory.grow(growPages);
      const grownBytes = exports.memory.buffer.byteLength;
      expect(grownBytes).toBeGreaterThanOrEqual(growPages * 65536);
      const renewed = freshGlue.__drawpaneRenew() as typeof import("../src/glue");
      // Default glue keeps the compiled WebAssembly.Module for future renewals,
      // but releases the dead Wasm instance, exports, init promise, and memory views.
      expect(freshGlue.__drawpaneModule()).toBeInstanceOf(WebAssembly.Module);
      expect(() => freshGlue.initSync()).toThrow(/quiesced/);
      expect(() => freshGlue.initSync({ module: bytes })).toThrow(/quiesced/);
      await expect(freshGlue.default()).rejects.toThrow(/quiesced/);
      const freshExports = renewed.initSync() as { memory: WebAssembly.Memory };
      expect(freshExports.memory).not.toBe(exports.memory);
      expect(freshExports.memory.buffer.byteLength).toBeLessThan(grownBytes);
    });
  }

  it("handles traps and epoch changes across async attachGpu without touching stale GpuInit", async () => {
    let initFreed = 0;
    let initRead = 0;
    let initUnfinalized = 0;
    const gate = Promise.withResolvers<void>();
    class FakeEngine {
      __destroy_into_raw() {
        return 1;
      }
      free() {}
      apply() {
        throw new WebAssembly.RuntimeError("trap during inflight attach");
      }
      attachGpu() {
        throw new Error("attachGpu must not run after epoch change");
      }
    }
    const fakeGlue = {
      Engine: FakeEngine,
      hasGpu: () => true,
      gpuBackend: () => "webgl2",
      __drawpaneRenew() {},
      memoryBytes: () => 0,
      async createGpu() {
        await gate.promise;
        return {
          get ok() {
            initRead++;
            return true;
          },
          get code() {
            initRead++;
            return 0;
          },
          get message() {
            initRead++;
            return "";
          },
          get adapter() {
            initRead++;
            return "fake";
          },
          get backend() {
            initRead++;
            return "webgl2";
          },
          get details() {
            initRead++;
            return "{}";
          },
          get fallback() {
            initRead++;
            return false;
          },
          __destroy_into_raw() {
            initUnfinalized++;
            return 2;
          },
          free() {
            initFreed++;
          },
        };
      },
    };
    const origWebGL2 = (globalThis as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext;
    Object.defineProperty(globalThis, "WebGL2RenderingContext", {
      configurable: true,
      value: function WebGL2RenderingContext() {},
    });
    try {
      const m1 = {
        build: "webgl",
        glue: fakeGlue,
        memoryBytes: () => 0,
      } as unknown as EngineModule;
      const m2 = {
        build: "webgl",
        glue: fakeGlue,
        memoryBytes: () => 0,
      } as unknown as EngineModule;
      const pending = new RenderEngine(m1);
      const sibling = new RenderEngine(m2);
      const attachPromise = pending.attachGpu(null);
      // Sibling traps while attachGpu is awaiting createGpu.
      expect(sibling.apply(new Uint8Array())).toMatchObject({ ok: false, code: ErrorCode.Trap });
      gate.resolve();
      const res = await attachPromise;
      expect(res).toMatchObject({ ok: false, code: ErrorCode.Trap });
      expect(initRead).toBe(0);
      expect(initFreed).toBe(0);
      expect(initUnfinalized).toBe(1);

      // A RuntimeError thrown from async createGpu itself must map to Trap, not NoAdapter.
      const trapGlue = {
        ...fakeGlue,
        async createGpu() {
          throw new WebAssembly.RuntimeError("unreachable in createGpu");
        },
      };
      const trapMod = {
        build: "webgl",
        glue: trapGlue,
        memoryBytes: () => 0,
      } as unknown as EngineModule;
      const trapped = new RenderEngine(trapMod);
      expect(await trapped.attachGpu(null)).toMatchObject({ ok: false, code: ErrorCode.Trap });
      expect(trapped.dead).toBe(true);
    } finally {
      if (origWebGL2 === undefined) {
        delete (globalThis as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext;
      } else {
        Object.defineProperty(globalThis, "WebGL2RenderingContext", {
          configurable: true,
          value: origWebGL2,
        });
      }
    }
  });

  it("isolates overlapping compatibility attaches from concurrent core and later adapter requests", async () => {
    class FakeEngine {
      __destroy_into_raw() {
        return 1;
      }
      free() {}
    }
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let calls = 0;
    const optionsSeen: Array<Record<string, unknown> | undefined> = [];
    const original = async (options?: Record<string, unknown>) => {
      optionsSeen.push(options);
      return {};
    };
    const origNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter: original } },
    });
    try {
      const gpu = (
        navigator as Navigator & {
          gpu: { requestAdapter: (o?: Record<string, unknown>) => Promise<unknown> };
        }
      ).gpu;
      const fakeGlue = {
        Engine: FakeEngine,
        hasGpu: () => true,
        gpuBackend: () => "webgpu",
        async createGpu() {
          const gate = [first, second][calls++];
          await gpu.requestAdapter({});
          await gate?.promise;
          return { ok: false, code: ErrorCode.NoAdapter, message: "fixture", free() {} };
        },
      };
      const fakeModule = {
        build: "browser",
        glue: fakeGlue,
        memoryBytes: () => 0,
      } as unknown as EngineModule;
      const p = new RenderEngine(fakeModule).attachGpu(null, { compatibility: true });
      const q = new RenderEngine(fakeModule).attachGpu(null, { compatibility: true });
      let thirdOptions: Record<string, unknown> | undefined;
      const coreModule = {
        build: "browser",
        glue: {
          ...fakeGlue,
          async createGpu() {
            await gpu.requestAdapter({});
            thirdOptions = optionsSeen.at(-1);
            return { ok: false, code: ErrorCode.NoAdapter, message: "fixture", free() {} };
          },
        },
        memoryBytes: () => 0,
      } as unknown as EngineModule;
      // Core attach must complete without waiting on compatibility attaches and without receiving
      // featureLevel: "compatibility".
      await new RenderEngine(coreModule).attachGpu(null);
      first.resolve();
      await p;
      second.resolve();
      await q;
      await gpu.requestAdapter({});
      expect(thirdOptions?.featureLevel).toBeUndefined();
      expect(optionsSeen.at(-1)?.featureLevel).toBeUndefined();
      expect(gpu.requestAdapter).toBe(original);
      expect(optionsSeen.filter((o) => o?.featureLevel === "compatibility")).toHaveLength(2);
    } finally {
      if (origNavigator) {
        Object.defineProperty(globalThis, "navigator", origNavigator);
      } else {
        delete (globalThis as { navigator?: unknown }).navigator;
      }
    }
  });

  it("refuses a Wasm module whose listVersion is older than the JS wire writer", () => {
    const staleModule = {
      build: "browser",
      glue: {
        listVersion: () => new Uint32Array([1, 0]),
      },
      memoryBytes: () => 0,
    } as unknown as EngineModule;
    const engine = new RenderEngine(staleModule);
    expect(engine.failure).toMatchObject({ ok: false, code: ErrorCode.Version });
  });
});
