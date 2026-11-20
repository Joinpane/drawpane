import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { memoryLimits } from "../../raster/src/wasm-limits";
import {
  type EngineBuild,
  type EngineModule,
  ErrorCode,
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
});

describe.skipIf(!built())(
  "Operations the engine refuses, from the wire (re-check of PR 216)",
  () => {
    it("refuses a page holding a diamond gradient before any PNG byte, even outside the crop", async () => {
      const w = new ListWriter(0xffffffff, 1);
      w.reset();
      const record = (x: number, paint: WirePaintForTest) => ({
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
        ops: [{ op: "fill" as const, path: 0, evenOdd: false, paint }],
        coarse: [],
      });
      w.set(1, ROOT, record(0, { kind: "solid", color: [1, 0, 0, 1] }));
      w.set(
        2,
        ROOT,
        record(5000, {
          kind: "diamond",
          matrix: [16, 0, 0, 16, 0, 0],
          stops: [
            { position: 0, color: [1, 0, 0, 1] },
            { position: 1, color: [0, 0, 1, 1] },
          ],
        }),
      );
      const engine = new RenderEngine(await loadNodeEngine());
      try {
        expect(engine.apply(w.finish()).ok).toBe(true);
        expect(
          engine.renderPngStream(32, 32, { zoom: 1, x: 0, y: 0, dpr: 1 }, [0, 0, 0, 0]),
        ).toMatchObject({ ok: false, code: ErrorCode.Unsupported });
        expect(engine.unsupported()).toMatchObject({ ok: true, value: [[2, 1 << 12]] });
      } finally {
        engine.dispose();
      }
    });
  },
);

type WirePaintForTest = Parameters<ListWriter["set"]>[2]["ops"][number] extends infer O
  ? O extends { paint: infer P }
    ? P
    : never
  : never;

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
});
