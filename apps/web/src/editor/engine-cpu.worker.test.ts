/**
 * Unit regression tests for `engine-cpu.worker.ts` (PR #233 + Phase 2 tiled CPU path):
 * - Transfer backlog is bounded by both count (`MAX_INFLIGHT_TRANSFERS = 2`) and bytes
 *   (`MAX_INFLIGHT_BYTES = 16 MiB`) worker-wide across superseded jobs and rejected `apply`
 *   messages, so a 4096x4096 frame queues at most 1 transfer (64 MiB, never 256 MiB) until ACKed.
 * - Renders through Phase 2's `renderCpuTiled`, stepping progressively while pending tiles
 *   remain and forwarding `exact`, `plan`, and `tiles` metadata in `done`.
 * - Obsolete `createImageBitmap` rejections are discarded silently without poisoning CPU mode;
 *   active render/bitmap errors carry both `jobId` and `revision`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const workerState = vi.hoisted(() => ({
  failRenderCode: null as number | null,
  remainingTiles: 0,
  lastTiledOptions: null as Record<string, unknown> | null,
}));

vi.mock("@drawpane/engine", () => ({
  ErrorCode: {
    Revision: 3,
    Limit: 4,
    Unsupported: 5,
    Gpu: 7,
  },
  loadBrowserEngine: async () => ({}),
  RenderEngine: class {
    revision = 1;
    apply(bytes: Uint8Array) {
      if (bytes[0] === 255) return { ok: false, message: "injected wrong base", code: 3 };
      this.revision = bytes[0] ?? 1;
      workerState.remainingTiles = 24;
      return { ok: true };
    }
    renderCpuTiled(
      w: number,
      h: number,
      _camera: unknown,
      _bg: unknown,
      options: { moving?: boolean; maxJobs?: number; tile?: number; slots?: number } = {},
    ) {
      workerState.lastTiledOptions = options;
      if (workerState.failRenderCode !== null) {
        return { ok: false, code: workerState.failRenderCode, message: "injected limit" };
      }
      const step = Math.min(options.maxJobs ?? 4, workerState.remainingTiles);
      workerState.remainingTiles = Math.max(0, workerState.remainingTiles - step);
      const exact = !options.moving && workerState.remainingTiles === 0;
      return {
        ok: true,
        value: {
          pixels: new Uint8Array(w * h * 4),
          stats: {
            exact,
            standin: !exact,
            plan: exact ? "tiles" : "standin",
            tiles: {
              drawn: step,
              pending: workerState.remainingTiles,
              queued: 0,
              held: 24 - workerState.remainingTiles,
              evicted: 0,
              dragged: 0,
            },
            records: 1,
            culled: 0,
            glyphsMasked: 0,
            glyphsOutlined: 0,
          },
        },
      };
    }
    dispose() {}
  },
}));

describe("engine-cpu.worker tiled rendering, transfer credit, and error tagging", () => {
  const origSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  const origCreateBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const origImageData = Object.getOwnPropertyDescriptor(globalThis, "ImageData");

  afterEach(() => {
    workerState.failRenderCode = null;
    workerState.remainingTiles = 0;
    workerState.lastTiledOptions = null;
    if (origSelf) Object.defineProperty(globalThis, "self", origSelf);
    else delete (globalThis as Record<string, unknown>).self;
    if (origCreateBitmap) Object.defineProperty(globalThis, "createImageBitmap", origCreateBitmap);
    else delete (globalThis as Record<string, unknown>).createImageBitmap;
    if (origImageData) Object.defineProperty(globalThis, "ImageData", origImageData);
    else delete (globalThis as Record<string, unknown>).ImageData;
    vi.resetModules();
  });

  it("keeps unacknowledged transfers bounded by count and bytes worker-wide across job changes and failed applies", async () => {
    const replies: Array<{
      type: string;
      jobId?: number;
      revision?: number;
      code?: number;
      exact?: boolean;
      plan?: string;
      pixels?: ArrayBuffer;
      tiles?: { drawn: number; pending: number; held: number };
    }> = [];
    const scope: {
      onmessage: ((e: { data: unknown }) => Promise<void> | void) | null;
      postMessage: (m: (typeof replies)[number]) => void;
    } = {
      onmessage: null,
      postMessage: (m) => replies.push(m),
    };
    Object.defineProperty(globalThis, "self", { configurable: true, value: scope });
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: undefined,
    });

    await import("./engine-cpu.worker");
    const send = (data: unknown) => scope.onmessage?.({ data });
    const waitTick = () => new Promise((r) => setTimeout(r, 30));
    const render = (jobId: number, revision: number, side = 512, moving = false) =>
      send({
        type: "render",
        jobId,
        revision,
        width: side,
        height: side,
        tileSize: 64,
        camera: { zoom: 1, x: 0, y: 0, dpr: 1 },
        background: [1, 1, 1, 1],
        moving,
      });
    const tiles = (jobId: number) => replies.filter((r) => r.type === "tile" && r.jobId === jobId);

    await send({ type: "init" });
    workerState.remainingTiles = 24;
    await render(1, 1, 512);
    await waitTick();
    // 512x512 = 1 MiB per frame: transfer count cap pauses at 2 unacked slices.
    expect(tiles(1)).toHaveLength(2);
    expect(workerState.lastTiledOptions).toMatchObject({ moving: false, maxJobs: 4, tile: 64 });

    // Failed apply + rejected render + recovered apply + new render with zero ACKs sent:
    // the worker must hold at 2 unacked frames total and post 0 frames for job 3 until ACKs arrive.
    await send({ type: "apply", bytes: Uint8Array.of(255).buffer });
    await render(2, 2, 512);
    await waitTick();
    expect(tiles(2)).toHaveLength(0);

    await send({ type: "apply", bytes: Uint8Array.of(3).buffer });
    await render(3, 3, 512);
    await waitTick();
    expect(tiles(3)).toHaveLength(0);

    // ACKing the 2 stale frames from job 1 releases worker-wide credit so job 3 proceeds.
    for (let i = 0; i < 2; i++) {
      await send({ type: "tile-ack", jobId: 1 });
    }
    await waitTick();
    expect(tiles(3)).toHaveLength(2);
    expect(tiles(3).every((t) => t.revision === 3)).toBe(true);

    // ACKing remaining slices lets job 3 complete exact with Phase 2 tile stats (6 slices total).
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 2; i++) {
        await send({ type: "tile-ack", jobId: 3 });
      }
      await waitTick();
    }
    expect(replies).toContainEqual(
      expect.objectContaining({
        type: "done",
        jobId: 3,
        revision: 3,
        exact: true,
        plan: "tiles",
        tiles: expect.objectContaining({ drawn: 24, pending: 0, held: 24 }),
      }),
    );

    // Large 4096x4096 frame (64 MiB): byte budget allows at most 1 frame in flight (64 MiB, never 256 MiB).
    await send({ type: "apply", bytes: Uint8Array.of(4).buffer });
    await render(4, 4, 4096);
    await waitTick();
    expect(tiles(4)).toHaveLength(1);
    const heldBytes = tiles(4).reduce((sum, t) => sum + (t.pixels?.byteLength ?? 0), 0);
    expect(heldBytes).toBe(64 * 1024 * 1024);

    // Even a tiny 32x32 frame must wait while the 64 MiB frame is unacknowledged.
    await send({ type: "apply", bytes: Uint8Array.of(5).buffer });
    await render(5, 5, 32);
    await waitTick();
    expect(tiles(5)).toHaveLength(0);

    // One stale ACK frees the 64 MiB budget so job 5 immediately renders.
    await send({ type: "tile-ack", jobId: 4 });
    await waitTick();
    expect(tiles(5).length).toBeGreaterThanOrEqual(1);

    // Render errors must include both jobId and revision.
    for (let i = 0; i < tiles(5).length; i++) {
      await send({ type: "tile-ack", jobId: 5 });
    }
    workerState.failRenderCode = 4;
    await render(6, 5, 64);
    await waitTick();
    expect(replies).toContainEqual(
      expect.objectContaining({ type: "error", jobId: 6, revision: 5, code: 4 }),
    );

    await send({ type: "dispose" });
  });

  it("discards createImageBitmap rejections from superseded jobs and tags active bitmap errors", async () => {
    const replies: Array<{
      type: string;
      jobId?: number;
      revision?: number;
      code?: number;
      message?: string;
    }> = [];
    const scope: {
      onmessage: ((e: { data: unknown }) => Promise<void> | void) | null;
      postMessage: (m: (typeof replies)[number]) => void;
    } = {
      onmessage: null,
      postMessage: (m) => replies.push(m),
    };
    Object.defineProperty(globalThis, "self", { configurable: true, value: scope });
    Object.defineProperty(globalThis, "ImageData", {
      configurable: true,
      value: class {
        constructor(
          public data: Uint8ClampedArray,
          public width: number,
          public height: number,
        ) {}
      },
    });

    let rejectStale!: (reason?: unknown) => void;
    const stalePromise = new Promise<ImageBitmap>((_resolve, reject) => {
      rejectStale = reject;
    });
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: () => stalePromise,
    });

    await import("./engine-cpu.worker");
    const send = (data: unknown) => scope.onmessage?.({ data });
    const waitTick = () => new Promise((r) => setTimeout(r, 30));

    await send({ type: "init" });
    workerState.remainingTiles = 4;
    await send({
      type: "render",
      jobId: 1,
      revision: 1,
      width: 32,
      height: 32,
      tileSize: 64,
      camera: { zoom: 1, x: 0, y: 0, dpr: 1 },
      background: [1, 1, 1, 1],
      moving: false,
    });
    await waitTick();

    // Supersede job 1 with revision 3 before job 1's createImageBitmap rejects.
    await send({ type: "apply", bytes: Uint8Array.of(3).buffer });
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: undefined,
    });
    await send({
      type: "render",
      jobId: 3,
      revision: 3,
      width: 32,
      height: 32,
      tileSize: 64,
      camera: { zoom: 1, x: 0, y: 0, dpr: 1 },
      background: [1, 1, 1, 1],
      moving: false,
    });
    rejectStale(new Error("old camera bitmap allocation rejected"));
    await waitTick();

    // Zero error messages from the superseded job, and job 3 rendered pixels cleanly.
    expect(replies.filter((r) => r.type === "error")).toEqual([]);
    expect(replies.some((r) => r.type === "tile" && r.jobId === 3 && r.revision === 3)).toBe(true);

    // An active job's createImageBitmap rejection must be tagged with its jobId and revision.
    for (const t of replies.filter((r) => r.type === "tile" && r.jobId === 3)) {
      await send({ type: "tile-ack", jobId: t.jobId });
    }
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: () => Promise.reject(new Error("active bitmap failure")),
    });
    await send({
      type: "render",
      jobId: 4,
      revision: 3,
      width: 32,
      height: 32,
      tileSize: 64,
      camera: { zoom: 1, x: 0, y: 0, dpr: 1 },
      background: [1, 1, 1, 1],
      moving: false,
    });
    await waitTick();
    expect(replies).toContainEqual(
      expect.objectContaining({
        type: "error",
        jobId: 4,
        revision: 3,
        code: 7,
        message: expect.stringContaining("active bitmap failure"),
      }),
    );

    await send({ type: "dispose" });
  });
});
