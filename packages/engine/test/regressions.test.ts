import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { memoryLimits } from "../../raster/src/wasm-limits";
import { ErrorCode, ListWriter, RenderEngine, ROOT } from "../src/index";
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
