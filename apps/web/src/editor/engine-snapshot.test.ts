import { Editor, type TextMeasurer } from "@drawpane/editor";
import { ErrorCode, MAX_SIDE } from "@drawpane/engine";
import { type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import {
  EngineSnapshotService,
  isAbortError,
  renderEngineRasterExport,
  type SnapshotJobPayload,
  type SnapshotWorkerPort,
} from "./engine-snapshot";
import type { SnapshotWorkerReply, SnapshotWorkerRequest } from "./engine-snapshot.worker";

const measurer: TextMeasurer = {
  width: (font, text) => {
    const size = Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16);
    return text.length * size * 0.5;
  },
  shapeForEngine: () => ({ shaped: { glyphs: [], width: 0, scale: 1 }, fallback: false }),
};

function makeEditor(ops: Op[] = []) {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page 1" } },
    ...ops,
  ]);
  editor.setPage("p");
  return editor;
}

class FakeWorker implements SnapshotWorkerPort {
  onmessage: ((event: MessageEvent<SnapshotWorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: SnapshotWorkerRequest[] = [];
  terminated = false;

  postMessage(message: SnapshotWorkerRequest): void {
    this.sent.push(message);
    if (message.type === "init") {
      queueMicrotask(() => this.emit({ type: "ready" }));
    }
  }

  emit(reply: SnapshotWorkerReply): void {
    this.onmessage?.({ data: reply } as MessageEvent<SnapshotWorkerReply>);
  }

  crash(message = "worker boom"): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function payload(width = 100, height = 100): SnapshotJobPayload {
  return {
    format: "png",
    quality: 0.92,
    width,
    height,
    imageBudget: 192 << 20,
    camera: { zoom: 1, x: 0, y: 0, dpr: 1 },
    background: [0, 0, 0, 0],
    list: new ArrayBuffer(16),
    images: [],
    transfer: [],
    reducedImages: 0,
    omittedImages: 0,
  };
}

function rendersOf(worker: FakeWorker) {
  return worker.sent.filter(
    (m): m is Extract<SnapshotWorkerRequest, { type: "render" }> => m.type === "render",
  );
}

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("EngineSnapshotService", () => {
  it("runs jobs sequentially in priority order (high before normal before low)", async () => {
    const worker = new FakeWorker();
    const service = new EngineSnapshotService(() => worker);

    // Job 1 starts once the worker is ready; subsequent jobs queue while it runs.
    const first = service.enqueue(payload(10, 10), "low");
    await flush();

    expect(rendersOf(worker).map((r) => r.width)).toEqual([10]);
    const low = service.enqueue(payload(20, 20), "low");
    const normal = service.enqueue(payload(30, 30), "normal");
    const high = service.enqueue(payload(40, 40), "high");

    worker.emit({
      type: "done",
      jobId: must(rendersOf(worker)[0], "render 0").jobId,
      mime: "image/png",
      bytes: new Uint8Array([1]).buffer,
      reducedImages: 0,
      omittedImages: 0,
    });
    expect((await first).size).toBe(1);

    await flush();
    expect(rendersOf(worker).map((r) => r.width)).toEqual([10, 40]);
    worker.emit({
      type: "done",
      jobId: must(rendersOf(worker)[1], "render 1").jobId,
      mime: "image/png",
      bytes: new Uint8Array([2]).buffer,
      reducedImages: 0,
      omittedImages: 0,
    });
    expect((await high).size).toBe(1);

    await flush();
    expect(rendersOf(worker).map((r) => r.width)).toEqual([10, 40, 30]);
    worker.emit({
      type: "done",
      jobId: must(rendersOf(worker)[2], "render 2").jobId,
      mime: "image/png",
      bytes: new Uint8Array([3]).buffer,
      reducedImages: 0,
      omittedImages: 0,
    });
    expect((await normal).size).toBe(1);

    await flush();
    expect(rendersOf(worker).map((r) => r.width)).toEqual([10, 40, 30, 20]);
    worker.emit({
      type: "done",
      jobId: must(rendersOf(worker)[3], "render 3").jobId,
      mime: "image/png",
      bytes: new Uint8Array([4]).buffer,
      reducedImages: 0,
      omittedImages: 0,
    });
    expect((await low).size).toBe(1);

    service.dispose();
  });

  it("cancels both queued and in-flight jobs via AbortSignal", async () => {
    const worker = new FakeWorker();
    const service = new EngineSnapshotService(() => worker);

    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();

    const active = service.enqueue(payload(10, 10), "normal", activeAbort.signal);
    const queued = service.enqueue(payload(20, 20), "normal", queuedAbort.signal);
    const survivor = service.enqueue(payload(30, 30), "normal");

    await flush();

    // Cancel the queued job before it ever reaches the worker.
    queuedAbort.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    // Cancel the running job; the worker receives a cancel message and advances once confirmed.
    activeAbort.abort();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    const cancelMsg = worker.sent.find(
      (m): m is Extract<SnapshotWorkerRequest, { type: "cancel" }> => m.type === "cancel",
    );
    expect(cancelMsg).toBeDefined();

    worker.emit({ type: "cancelled", jobId: must(cancelMsg, "cancel").jobId });
    await flush();

    const renders = rendersOf(worker);
    expect(renders.map((r) => r.width)).toEqual([10, 30]);
    worker.emit({
      type: "done",
      jobId: must(renders[1], "survivor render").jobId,
      mime: "image/png",
      bytes: new Uint8Array([9]).buffer,
      reducedImages: 0,
      omittedImages: 0,
    });
    expect((await survivor).size).toBe(1);

    service.dispose();
  });

  it("restarts the worker cleanly after a crash and runs subsequent jobs", async () => {
    const workers: FakeWorker[] = [];
    const service = new EngineSnapshotService(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });

    const first = service.enqueue(payload(10, 10), "high");
    const second = service.enqueue(payload(20, 20), "high");

    await flush();
    expect(workers).toHaveLength(1);

    const firstWorker = must(workers[0], "first worker");
    firstWorker.crash("OOM");
    await expect(first).rejects.toThrow(/OOM/);

    await flush();
    expect(workers).toHaveLength(2);
    expect(firstWorker.terminated).toBe(true);

    const secondWorker = must(workers[1], "second worker");
    const nextRender = must(rendersOf(secondWorker)[0], "second render");
    expect(nextRender.width).toBe(20);
    secondWorker.emit({
      type: "done",
      jobId: nextRender.jobId,
      mime: "image/png",
      bytes: new Uint8Array([7]).buffer,
      reducedImages: 0,
      omittedImages: 0,
    });
    expect((await second).size).toBe(1);

    service.dispose();
  });

  it("kills a hung worker on watchdog timeout and runs queued jobs on a fresh worker", async () => {
    const workers: FakeWorker[] = [];
    const service = new EngineSnapshotService(
      () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      { jobTimeoutMs: 25 },
    );

    const hung = service.enqueue(payload(10, 10), "low");
    await flush();
    const next = service.enqueue(payload(20, 20), "high");

    await expect(hung).rejects.toThrow(/timed out/);
    await flush();
    expect(workers).toHaveLength(2);
    expect(must(workers[0], "hung worker").terminated).toBe(true);

    const freshWorker = must(workers[1], "fresh worker");
    const nextRender = must(rendersOf(freshWorker)[0], "next render");
    expect(nextRender.width).toBe(20);
    freshWorker.emit({
      type: "done",
      jobId: nextRender.jobId,
      mime: "image/png",
      bytes: new Uint8Array([5]).buffer,
      reducedImages: 1,
      omittedImages: 0,
    });
    expect((await next).size).toBe(1);

    service.dispose();
  });

  it("maps engine Limit errors to ExportError with reason 'limit'", async () => {
    const worker = new FakeWorker();
    const service = new EngineSnapshotService(() => worker);

    const job = service.enqueue(payload(500, 500), "high");
    await flush();
    const render = must(rendersOf(worker)[0], "limit render");
    worker.emit({
      type: "error",
      jobId: render.jobId,
      code: ErrorCode.Limit,
      message: "glyph outlines exceed budget",
    });

    await expect(job).rejects.toMatchObject({
      name: "ExportError",
      reason: "limit",
    });
    await expect(job).rejects.toThrow(/too many different glyph outlines/);

    const workJob = service.enqueue(payload(8192, 8192), "high");
    await flush();
    const workRender = must(rendersOf(worker)[1], "work limit render");
    worker.emit({
      type: "error",
      jobId: workRender.jobId,
      code: ErrorCode.Limit,
      message: "this export needs too much rendering work at this scale",
    });
    await expect(workJob).rejects.toMatchObject({
      name: "ExportError",
      reason: "limit",
      message: "This export needs too much rendering work at this scale. Try a smaller scale.",
    });

    service.dispose();
  });

  it("preempts a running low-priority thumbnail when a high-priority export arrives and resumes it after", async () => {
    const worker = new FakeWorker();
    const service = new EngineSnapshotService(() => worker);

    const lowJob = service.enqueue(payload(100, 100), "low");
    await flush();
    const firstRender = must(rendersOf(worker)[0], "initial low render");
    expect(firstRender.width).toBe(100);

    // Enqueue a high-priority export while the thumbnail is running: cancels and preempts low.
    const highJob = service.enqueue(payload(800, 600), "high");
    const cancelMsg = worker.sent.find(
      (m): m is Extract<SnapshotWorkerRequest, { type: "cancel" }> => m.type === "cancel",
    );
    expect(cancelMsg?.jobId).toBe(firstRender.jobId);

    // Worker yields on the cancel check -> high-priority export runs immediately.
    worker.emit({ type: "cancelled", jobId: firstRender.jobId, wasmBytes: 6 << 20 });
    await flush();

    const afterPreempt = rendersOf(worker);
    expect(afterPreempt.map((r) => r.width)).toEqual([100, 800]);
    const highRender = must(afterPreempt[1], "high render");
    worker.emit({
      type: "done",
      jobId: highRender.jobId,
      mime: "image/png",
      bytes: new Uint8Array([1, 2]).buffer,
      reducedImages: 0,
      omittedImages: 0,
      wasmBytes: 12 << 20,
    });
    expect((await highJob).size).toBe(2);

    // Preempted thumbnail resumes automatically with a fresh jobId and intact payload buffer.
    await flush();
    const resumed = rendersOf(worker);
    expect(resumed.map((r) => r.width)).toEqual([100, 800, 100]);
    const resumedRender = must(resumed[2], "resumed low render");
    expect(resumedRender.jobId).toBeGreaterThan(firstRender.jobId);
    expect(resumedRender.list.byteLength).toBe(16);
    worker.emit({
      type: "done",
      jobId: resumedRender.jobId,
      mime: "image/png",
      bytes: new Uint8Array([3, 4, 5]).buffer,
      reducedImages: 0,
      omittedImages: 0,
      wasmBytes: 12 << 20,
    });
    expect((await lowJob).size).toBe(3);

    service.dispose();
  });

  it("recycles a slow low-priority worker on preemption timeout so an urgent export starts promptly", async () => {
    const workers: FakeWorker[] = [];
    const service = new EngineSnapshotService(
      () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      { preemptTimeoutMs: 20, jobTimeoutMs: 5000 },
    );

    const lowJob = service.enqueue(payload(100, 100), "low");
    await flush();
    const highJob = service.enqueue(payload(500, 500), "high");

    // Worker 0 ignores cancel; preemption timeout kills it and starts Worker 1 for high first.
    await new Promise((r) => setTimeout(r, 40));
    expect(workers).toHaveLength(2);
    expect(must(workers[0], "preempted worker").terminated).toBe(true);

    const worker1 = must(workers[1], "fresh worker");
    const highRender = must(rendersOf(worker1)[0], "high render on worker1");
    expect(highRender.width).toBe(500);
    worker1.emit({
      type: "done",
      jobId: highRender.jobId,
      mime: "image/png",
      bytes: new Uint8Array([8]).buffer,
      reducedImages: 0,
      omittedImages: 0,
      wasmBytes: 8 << 20,
    });
    expect((await highJob).size).toBe(1);

    await flush();
    const lowRender = must(rendersOf(worker1)[1], "resumed low render on worker1");
    expect(lowRender.width).toBe(100);
    worker1.emit({
      type: "done",
      jobId: lowRender.jobId,
      mime: "image/png",
      bytes: new Uint8Array([9, 9]).buffer,
      reducedImages: 0,
      omittedImages: 0,
      wasmBytes: 8 << 20,
    });
    expect((await lowJob).size).toBe(2);

    service.dispose();
  });

  it("terminates an idle worker after idleTimeoutMs and spawns a fresh worker on the next job", async () => {
    const workers: FakeWorker[] = [];
    const service = new EngineSnapshotService(
      () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      { idleTimeoutMs: 25 },
    );

    const first = service.enqueue(payload(64, 64), "low");
    await flush();
    const worker0 = must(workers[0], "worker 0");
    worker0.emit({
      type: "done",
      jobId: must(rendersOf(worker0)[0], "first render").jobId,
      mime: "image/png",
      bytes: new Uint8Array([1]).buffer,
      reducedImages: 0,
      omittedImages: 0,
      wasmBytes: 6 << 20,
    });
    expect((await first).size).toBe(1);
    expect(worker0.terminated).toBe(false);

    await new Promise((r) => setTimeout(r, 50));
    expect(worker0.terminated).toBe(true);

    const second = service.enqueue(payload(64, 64), "low");
    await flush();
    expect(workers).toHaveLength(2);
    const worker1 = must(workers[1], "worker 1");
    worker1.emit({
      type: "done",
      jobId: must(rendersOf(worker1)[0], "second render").jobId,
      mime: "image/png",
      bytes: new Uint8Array([2]).buffer,
      reducedImages: 0,
      omittedImages: 0,
      wasmBytes: 6 << 20,
    });
    expect((await second).size).toBe(1);

    service.dispose();
  });

  it("recycles the worker immediately after a large job exceeding recycleWasmBytes", async () => {
    const workers: FakeWorker[] = [];
    const service = new EngineSnapshotService(
      () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      { recycleWasmBytes: 64 << 20, idleTimeoutMs: 60_000 },
    );

    const big = service.enqueue(payload(4000, 3000), "high");
    await flush();
    const worker0 = must(workers[0], "worker 0");
    worker0.emit({
      type: "done",
      jobId: must(rendersOf(worker0)[0], "big render").jobId,
      mime: "image/png",
      bytes: new Uint8Array([1, 2, 3]).buffer,
      reducedImages: 0,
      omittedImages: 0,
      wasmBytes: 128 << 20,
    });
    expect((await big).size).toBe(3);
    expect(worker0.terminated).toBe(true);

    const small = service.enqueue(payload(100, 100), "low");
    await flush();
    expect(workers).toHaveLength(2);
    const worker1 = must(workers[1], "worker 1");
    worker1.emit({
      type: "done",
      jobId: must(rendersOf(worker1)[0], "small render").jobId,
      mime: "image/png",
      bytes: new Uint8Array([4]).buffer,
      reducedImages: 0,
      omittedImages: 0,
      wasmBytes: 6 << 20,
    });
    expect((await small).size).toBe(1);
    expect(worker1.terminated).toBe(false);

    service.dispose();
  });

  it("classifies AbortError cleanly without catching ordinary export errors", () => {
    expect(isAbortError(new DOMException("cancelled", "AbortError"))).toBe(true);
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(new Error("worker load failed"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe("renderEngineRasterExport", () => {
  it("refuses an 8,193 px frame with a clear error naming 8,192 px, and accepts 8,192 px", async () => {
    const worker = new FakeWorker();
    const service = new EngineSnapshotService(() => worker);
    const editor = makeEditor([
      {
        op: "create",
        id: "ok",
        type: "frame",
        parent: "p",
        key: "a0",
        props: {
          x: 0,
          y: 0,
          width: MAX_SIDE,
          height: 64,
          fills: [{ type: "solid", color: "#ff5a1f" }],
        },
      },
      {
        op: "create",
        id: "too-big",
        type: "frame",
        parent: "p",
        key: "a1",
        props: {
          x: 0,
          y: 100,
          width: MAX_SIDE + 1,
          height: 64,
          fills: [{ type: "solid", color: "#2b4fd6" }],
        },
      },
    ]);

    await expect(
      renderEngineRasterExport(editor, ["too-big"], { format: "png", scale: 1 }, service),
    ).rejects.toMatchObject({
      name: "ExportError",
      reason: "size",
    });
    await expect(
      renderEngineRasterExport(editor, ["too-big"], { format: "png", scale: 1 }, service),
    ).rejects.toThrow(/8193 × 64 px.*8,192 px/);

    const okPromise = renderEngineRasterExport(
      editor,
      ["ok"],
      { format: "png", scale: 1 },
      service,
    );
    await flush();
    const render = must(rendersOf(worker)[0], "png render");
    expect(render.width).toBe(MAX_SIDE);
    expect(render.height).toBe(64);
    expect(render.background).toEqual([0, 0, 0, 0]);
    worker.emit({
      type: "done",
      jobId: render.jobId,
      mime: "image/png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      reducedImages: 0,
      omittedImages: 0,
    });
    const blob = await okPromise;
    expect(blob.type).toBe("image/png");

    // JPEG defaults to opaque white background.
    const jpegPromise = renderEngineRasterExport(
      editor,
      ["ok"],
      { format: "jpeg", scale: 1 },
      service,
    );
    await flush();
    const jpegRender = must(rendersOf(worker).at(-1), "jpeg render");
    expect(jpegRender.format).toBe("jpeg");
    expect(jpegRender.background).toEqual([1, 1, 1, 1]);
    worker.emit({
      type: "done",
      jobId: jpegRender.jobId,
      mime: "image/jpeg",
      bytes: new Uint8Array([0xff, 0xd8]).buffer,
      reducedImages: 0,
      omittedImages: 0,
    });
    expect((await jpegPromise).type).toBe("image/jpeg");

    service.dispose();
  });
});
