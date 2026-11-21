/**
 * Unit regression tests for `EngineView` (review of PR #233):
 *
 * - One device loss with a delayed read-back failure must trigger only one recovery attempt
 *   (per-device generation cancels stale read-back error callbacks and releases the read-back slot).
 * - Concurrent `EngineView.create` calls targeting the same canvas slot (or cancelled via
 *   `AbortSignal`) must never detach the live canvas.
 * - CPU viewport pixel bounding keeps visible + backing surfaces within `MAX_CPU_PIXELS`.
 * - CPU tile deduplication never restarts an unchanged exact job and marks `needsSettle: false`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  gpuLost: false,
  readbackError: true,
  attachCalls: 0,
  attachFixture: null as null | ((surface: unknown, attempt: number) => Promise<unknown>),
  rendererFixture: "" as string,
  vendorFixture: "" as string,
  rendererExposed: true,
  workerMessages: [] as Array<{ type: string; [k: string]: unknown }>,
  lastWorker: null as FakeWorker | null,
  builderPendingVisible: 0,
  builderPendingOffscreen: 0,
  builderSupported: true,
  builderRev: 1,
  imageDemands: [] as Array<{
    ref: string;
    visible: boolean;
    span: { width: number; height: number };
  }>,
  cameraX: 0,
  paintedX: -1,
  uploadedWidths: [] as number[],
  gpuFinishedFixture: null as null | (() => Promise<{ ok: boolean }>),
}));

class FakeWorker extends EventTarget {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor() {
    super();
    state.lastWorker = this;
  }
  postMessage(message: { type: string; [k: string]: unknown }) {
    state.workerMessages.push(message);
    if (message.type === "init") {
      queueMicrotask(() => {
        if (!this.terminated) {
          this.dispatchEvent(new MessageEvent("message", { data: { type: "ready" } }));
        }
      });
    }
  }
  emit(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  terminate() {
    this.terminated = true;
  }
}

vi.mock("@drawpane/editor", () => ({
  DisplayListBuilder: class {
    pageId: string | null = null;
    supported = true;
    unsupported = new Map<string, number>();
    pending = 0;
    pendingVisible = 0;
    waiting = 0;
    revision = 1;
    stats = { fresh: true, records: 1 };
    opening = false;
    setEditorState() {}
    setView() {}
    openSlice(id: string) {
      return this.build(id);
    }
    build(id: string) {
      this.pageId = id;
      this.supported = state.builderSupported;
      this.pendingVisible = state.builderPendingVisible;
      this.pending = state.builderPendingVisible + state.builderPendingOffscreen;
      state.builderRev = 1;
      const bytes = new Uint8Array(16);
      new DataView(bytes.buffer).setUint32(12, state.builderRev, true);
      return bytes;
    }
    update(textMs?: number) {
      if (textMs !== undefined && this.pending > 0) {
        if (this.pendingVisible > 0) {
          this.pendingVisible = 0;
          this.pending = state.builderPendingOffscreen;
        } else {
          this.pending = 0;
        }
        state.builderRev++;
        this.stats = { fresh: false, records: 1 };
        const bytes = new Uint8Array(16);
        new DataView(bytes.buffer).setUint32(12, state.builderRev, true);
        return bytes;
      }
      return null;
    }
    acknowledge() {}
    imageReady() {}
    imageDemands() {
      return state.imageDemands;
    }
    imagesInUse() {
      return new Set(state.imageDemands.map(({ ref }) => ref));
    }
  },
}));

vi.mock("@drawpane/engine", () => ({
  ErrorCode: {
    Malformed: 1,
    Version: 2,
    Revision: 3,
    Limit: 4,
    Unsupported: 5,
    Unknown: 6,
    Gpu: 7,
    DeviceLost: 8,
    NoAdapter: 9,
    Image: 10,
    State: 11,
    Timeout: 12,
  },
  loadBrowserEngine: async () => ({}),
  loadWebglEngine: async () => ({}),
  unsupportedNames: () => [],
  RenderEngine: class {
    failure = null;
    gpu: {
      adapter: string;
      backend: "webgpu" | "webgl2";
      details: string;
      fallback: boolean;
    } | null = null;
    revision = 1;
    enableViewImages() {}
    viewImageLimits() {
      return { ok: true, value: { side: 4096, bytes: 128 << 20 } };
    }
    apply() {
      return { ok: true, value: { changes: new Float64Array(), full: true } };
    }
    async attachGpu(surface?: unknown) {
      state.attachCalls++;
      if (state.attachFixture) return state.attachFixture(surface, state.attachCalls);
      state.gpuLost = false;
      this.gpu = { adapter: "NVIDIA T4", backend: "webgpu", details: "{}", fallback: false };
      return { ok: true, value: this.gpu };
    }
    detachGpu() {
      this.gpu = null;
    }
    putGpuImageLevel(_handle: number, bitmap: ImageBitmap) {
      state.uploadedWidths.push(bitmap.width);
      return { ok: true };
    }
    dropImageLevel() {}
    renderGpu(_width: number, _height: number, camera: { x: number }) {
      state.cameraX = camera.x;
      return {
        ok: true,
        value: {
          records: 1,
          culled: 0,
          glyphsMasked: 0,
          glyphsOutlined: 0,
          maskHits: 0,
          maskMisses: 0,
          maskBytes: 0,
          coarse: 0,
          specks: 0,
          standin: false,
          exact: true,
          presented: true,
          plan: "tiles",
          tiles: { drawn: 1, pending: 0, queued: 0, held: 1, evicted: 0, dragged: 0 },
          ms: { encode: 0, render: 0, submit: 0, total: 0 },
        },
      };
    }
    renderGpuAhead() {
      return {
        ok: true,
        value: {
          drawn: 0,
          pending: 0,
          queued: 0,
          held: 0,
          evicted: 0,
          ms: 0,
          encodeMs: 0,
          renderMs: 0,
          maskMisses: 0,
          records: 0,
          glyphsMasked: 0,
          glyphsOutlined: 0,
        },
      };
    }
    async gpuFinished() {
      if (state.gpuFinishedFixture) return state.gpuFinishedFixture();
      return { ok: true };
    }
    gpuCheck() {
      return state.gpuLost ? { ok: false, code: 8, message: "device lost" } : { ok: true };
    }
    async gpuPixels() {
      if (state.readbackError) {
        return { ok: false, code: 8, message: "old device read-back failed" };
      }
      const value = new Uint8Array(65 * 17 * 4);
      if (state.imageDemands.length > 0) value[state.cameraX * 4] = 255;
      return { ok: true, value };
    }
    dispose() {}
  },
}));

import {
  boundCpuViewport,
  EngineView,
  MAX_CPU_PIXELS,
  probeWebgl2Support,
  resetSessionBackendsForTest,
} from "./engine-view";

class FakeCanvas {
  tagName = "CANVAS";
  isConnected: boolean;
  parentElement: FakeSlot | null = null;
  className = "";
  dataset: Record<string, string> = {};
  style: { cssText: string; visibility?: string; width?: string; height?: string } = {
    cssText: "",
  };
  width = 1;
  height = 1;
  context: string | null = null;
  constructor(isConnected = false) {
    this.isConnected = isConnected;
  }
  getContext(kind: string) {
    if (this.context && this.context !== kind) return null;
    if (kind === "webgl2" && state.rendererFixture) {
      this.context = "webgl2";
      return {
        RENDERER: 1,
        VENDOR: 2,
        getParameter: (key: number) =>
          key === 1
            ? state.rendererFixture
            : state.vendorFixture || (state.rendererExposed ? "Apple Inc." : "WebKit"),
        getExtension: (name: string) =>
          state.rendererExposed && name === "WEBGL_debug_renderer_info"
            ? { UNMASKED_RENDERER_WEBGL: 1, UNMASKED_VENDOR_WEBGL: 2 }
            : null,
      };
    }
    if (kind === "2d") {
      this.context = "2d";
      return {
        setTransform() {},
        clearRect() {},
        fillRect() {},
        drawImage() {},
        putImageData(image: ImageData) {
          if (state.imageDemands.length > 0) state.paintedX = image.data.indexOf(255) / 4;
        },
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4),
        }),
      };
    }
    return null;
  }
  replaceWith(next: FakeCanvas) {
    next.isConnected = this.isConnected;
    this.isConnected = false;
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
      this.parentElement = null;
    }
    this.isConnected = false;
  }
}

class FakeSlot {
  tagName = "DIV";
  isConnected = true;
  children: FakeCanvas[] = [];
  style: { cssText: string; visibility?: string; width?: string; height?: string } = {
    cssText: "",
    visibility: "hidden",
    width: "800px",
    height: "600px",
  };
  replaceChildren(...nodes: FakeCanvas[]) {
    for (const prev of this.children) {
      prev.parentElement = null;
      prev.isConnected = false;
    }
    this.children = [...nodes];
    for (const next of this.children) {
      next.parentElement = this;
      next.isConnected = this.isConnected;
    }
  }
}

describe("EngineView lifecycle and CPU job regressions (PR #233)", () => {
  const origDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const origWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const origNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const origLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const origSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const origWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");

  let healthTick: (() => void) | null = null;
  let recoveries: unknown[] = [];
  let fallbacks: unknown[] = [];

  beforeEach(() => {
    resetSessionBackendsForTest();
    state.gpuLost = false;
    state.readbackError = true;
    state.attachCalls = 0;
    state.attachFixture = null;
    state.rendererFixture = "";
    state.vendorFixture = "";
    state.rendererExposed = true;
    state.workerMessages = [];
    state.lastWorker = null;
    state.imageDemands = [];
    state.cameraX = 0;
    state.paintedX = -1;
    state.uploadedWidths = [];
    healthTick = null;
    recoveries = [];
    fallbacks = [];

    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: () => new FakeCanvas(false),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://drawpane.test/?present=readback" },
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: (e: CustomEvent) => {
          if (e.type === "drawpane:renderer-recovered") recoveries.push(e.detail);
          if (e.type === "drawpane:renderer-fallback") fallbacks.push(e.detail);
        },
        setInterval: (cb: () => void) => {
          healthTick = cb;
          return 1;
        },
        clearInterval: () => {},
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      },
    });
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: FakeWorker,
    });
  });

  afterEach(() => {
    const restore = (name: string, desc: PropertyDescriptor | undefined) => {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete (globalThis as Record<string, unknown>)[name];
    };
    restore("document", origDocument);
    restore("window", origWindow);
    restore("navigator", origNavigator);
    restore("localStorage", origLocalStorage);
    restore("sessionStorage", origSessionStorage);
    restore("Worker", origWorker);
    vi.unstubAllGlobals();
  });

  it("moves presented content pixels with the camera while a sharper image decodes", async () => {
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: async () => ({ info: { description: "NVIDIA T4" } }) },
    });
    vi.stubGlobal(
      "ImageData",
      class {
        constructor(readonly data: Uint8ClampedArray) {}
      },
    );
    const fine = Promise.withResolvers<void>();
    const started = vi.fn();
    vi.stubGlobal("createImageBitmap", async (_blob: Blob, o: ImageBitmapOptions) => {
      if ((o.resizeWidth ?? 0) >= 896) {
        started();
        await fine.promise;
      }
      return { width: o.resizeWidth, height: o.resizeHeight, close() {} };
    });
    state.readbackError = false;
    state.imageDemands = [{ ref: "photo", visible: true, span: { width: 100, height: 100 } }];
    const view = await EngineView.create(
      new FakeCanvas(true) as unknown as HTMLCanvasElement,
      { scene: {}, doc: { version: 1 } } as never,
      {} as never,
      {
        subscribe: () => () => {},
        encodedVersion: () => 0,
        encoded: async () => ({ blob: new Blob(), size: { width: 1792, height: 2400 } }),
      } as never,
      "engine",
    );
    expect(view).not.toBeNull();
    const draw = (zoom: number, x: number) =>
      view?.draw("page-1", { zoom, x, y: 0 }, 65, 17, 1, "#ffffff", {
        hidden: new Set(),
        whole: null,
      });
    try {
      await vi.waitFor(() => expect(draw(1, 0)?.exact).toBe(true));
      await vi.waitFor(() => expect(state.paintedX).toBe(0));
      expect(draw(5.1, 8)).toMatchObject({ drawn: true, exact: false });
      await vi.waitFor(() => expect(started).toHaveBeenCalled());
      expect(state.uploadedWidths).not.toContain(896);
      await vi.waitFor(() => expect(state.paintedX).toBe(8));
      expect(view?.backend).toBe("webgpu");
      expect(fallbacks).toEqual([]);
      fine.resolve();
      await vi.waitFor(() => expect(draw(5.1, 8)?.exact).toBe(true));
    } finally {
      fine.resolve();
      view?.dispose();
    }
  });

  it("consumes only one recovery attempt when a delayed read-back failure races with health recovery", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter: async () => ({ info: { description: "NVIDIA T4" } }) } },
    });
    const editor = { scene: {}, doc: { version: 1 } } as never;
    const images = { subscribe: () => () => {}, natural: () => null, get: () => null } as never;
    const view = await EngineView.create(
      new FakeCanvas(true) as unknown as HTMLCanvasElement,
      editor,
      {} as never,
      images,
      "engine",
    );
    expect(view).not.toBeNull();
    expect(view?.backend).toBe("webgpu");

    // Start a draw whose read-back fails and schedules the 300 ms delayed error check.
    view?.draw("page", { zoom: 1, x: 0, y: 0 }, 65, 17, 1, "#abcdef", {
      hidden: new Set(),
      whole: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    // Health tick detects device loss and recovers on the same RenderEngine.
    state.gpuLost = true;
    healthTick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(recoveries).toHaveLength(1);

    // Waiting past the 300 ms delayed callback from the old device must NOT trigger attempt 2.
    await new Promise((r) => setTimeout(r, 380));
    expect(recoveries).toHaveLength(1);
    view?.dispose();
  });

  it("prevents an abandoned concurrent EngineView.create from detaching the live canvas", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    const editor = { scene: {}, doc: { version: 1 } } as never;
    const images = { subscribe: () => () => {}, natural: () => null, get: () => null } as never;
    const initial = new FakeCanvas(true) as unknown as HTMLCanvasElement;
    const abandoned = EngineView.create(initial, editor, {} as never, images, "engine");
    const live = EngineView.create(initial, editor, {} as never, images, "engine");
    const [abandonedView, liveView] = await Promise.all([abandoned, live]);

    expect(abandonedView).toBeNull();
    expect(liveView).not.toBeNull();
    expect(liveView?.canvas.isConnected).toBe(true);
    liveView?.dispose();
  });

  it("aborts in-flight EngineView.create via AbortSignal without replacing the canvas", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    const editor = { scene: {}, doc: { version: 1 } } as never;
    const images = { subscribe: () => () => {}, natural: () => null, get: () => null } as never;
    const initial = new FakeCanvas(true);
    const ac = new AbortController();
    const pending = EngineView.create(
      initial as unknown as HTMLCanvasElement,
      editor,
      {} as never,
      images,
      "engine-cpu",
      ac.signal,
    );
    ac.abort();
    expect(await pending).toBeNull();
    expect(initial.isConnected).toBe(true);
  });

  it("deduplicates unchanged CPU worker exact jobs and bounds oversized CPU viewports", async () => {
    expect(boundCpuViewport(1600, 960, 2)).toEqual({ width: 1600, height: 960, dpr: 2 });
    const capped = boundCpuViewport(8192, 8192, 2);
    expect(capped.width * capped.height).toBeLessThanOrEqual(MAX_CPU_PIXELS);
    expect(capped.dpr).toBeCloseTo(1, 3);

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    const editor = { scene: {}, doc: { version: 1 } } as never;
    const images = { subscribe: () => () => {}, natural: () => null, get: () => null } as never;
    const view = await EngineView.create(
      new FakeCanvas(true) as unknown as HTMLCanvasElement,
      editor,
      {} as never,
      images,
      "engine-cpu",
    );
    expect(view?.backend).toBe("cpu-worker");
    const first = view?.draw(
      "page",
      { zoom: 1, x: 0, y: 0 },
      800,
      600,
      1,
      "#ffffff",
      { hidden: new Set(), whole: null },
      true,
    );
    expect(first).toMatchObject({ drawn: true, settled: true });
    // Calling draw again with the same inputs while the exact job is in flight must NOT cancel/restart it.
    const second = view?.draw(
      "page",
      { zoom: 1, x: 0, y: 0 },
      800,
      600,
      1,
      "#ffffff",
      { hidden: new Set(), whole: null },
      true,
    );
    expect(second).toMatchObject({ drawn: true, settled: true });
    const renders = state.workerMessages.filter((m) => m.type === "render");
    expect(renders).toHaveLength(1);
    expect(renders[0]?.revision).toBe(1);

    // Sending a rejected apply-result invalidates the in-flight job so stale tiles are dropped
    // and acknowledged cleanly without being presented.
    let presented = 0;
    if (view) view.onPresented = () => presented++;
    state.lastWorker?.emit({ type: "apply-result", ok: false, revision: 0, code: 3 });
    state.lastWorker?.emit({
      type: "tile",
      jobId: renders[0]?.jobId,
      revision: 1,
      x: 0,
      y: 0,
      width: 64,
      height: 64,
      pixels: new ArrayBuffer(64 * 64 * 4),
    });
    expect(presented).toBe(0);
    expect(state.workerMessages.some((m) => m.type === "tile-ack")).toBe(true);
    view?.dispose();
  });

  it("probes on detached canvases so a failed or superseded WebGPU attach never locks the slot", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter: async () => ({ info: { description: "NVIDIA T4" } }) } },
    });
    window.location.href = "https://drawpane.test/";
    let resolvePending!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolvePending = r;
    });
    let resolveClaimed!: () => void;
    const claimed = new Promise<void>((r) => {
      resolveClaimed = r;
    });
    const initial = new FakeCanvas(true);
    let probedSurface: FakeCanvas | null = null;
    state.attachFixture = async (surface) => {
      probedSurface = surface as FakeCanvas;
      // Simulate real WebGPU locking the canvas passed to attachGpu before failing.
      probedSurface.context = "webgpu";
      resolveClaimed();
      return pending;
    };
    const editor = { scene: {}, doc: { version: 1 } } as never;
    const images = { subscribe: () => () => {}, natural: () => null, get: () => null } as never;
    const canvas = initial as unknown as HTMLCanvasElement;
    const abandoned = EngineView.create(canvas, editor, {} as never, images, "engine");
    await claimed;
    // The React slot canvas must remain untouched while the probe runs on its own detached canvas.
    expect(probedSurface).not.toBe(initial);
    expect(initial.context).toBeNull();
    expect(initial.isConnected).toBe(true);

    // Supersede the in-flight WebGPU probe with a CPU create: CPU must succeed and take the slot.
    const winning = await EngineView.create(canvas, editor, {} as never, images, "engine-cpu");
    resolvePending({ ok: false, code: 9, message: "fixture attach failed" });
    expect(await abandoned).toBeNull();
    expect(winning).not.toBeNull();
    expect(winning?.backend).toBe("cpu-worker");
    expect(winning?.canvas.isConnected).toBe(true);
    expect(fallbacks).toEqual([]);
    winning?.dispose();
  });

  it("falls back from a failed WebGPU attach after context lock to CPU instead of terminal Canvas", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter: async () => ({ info: { description: "NVIDIA T4" } }) } },
    });
    window.location.href = "https://drawpane.test/";
    const initial = new FakeCanvas(true);
    state.attachFixture = async (surface) => {
      (surface as FakeCanvas).context = "webgpu";
      return { ok: false, code: 9, message: "fixture device request rejected" };
    };
    const editor = { scene: {}, doc: { version: 1 } } as never;
    const images = { subscribe: () => () => {}, natural: () => null, get: () => null } as never;
    const view = await EngineView.create(
      initial as unknown as HTMLCanvasElement,
      editor,
      {} as never,
      images,
      "engine",
    );
    expect(view).not.toBeNull();
    expect(view?.backend).toBe("cpu-worker");
    expect(view?.canvas.isConnected).toBe(true);
    expect(fallbacks).toMatchObject([{ from: "webgpu", to: "cpu-worker" }]);
    view?.dispose();
  });

  it("classifies Apple GPU and extension-hidden WebKit WebGL honestly as unknown while refusing generic labels", () => {
    state.rendererFixture = "Apple GPU";
    state.rendererExposed = true;
    expect(probeWebgl2Support()).toMatchObject({ ok: true, adapterClass: "unknown" });

    state.rendererFixture = "WebKit WebGL";
    state.rendererExposed = false;
    expect(probeWebgl2Support()).toMatchObject({ ok: true, adapterClass: "unknown" });

    state.rendererFixture = "WebGL 2.0";
    state.vendorFixture = "Mozilla";
    state.rendererExposed = false;
    expect(probeWebgl2Support()).toMatchObject({ ok: false, adapterClass: "unidentified" });

    state.rendererFixture = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))";
    state.vendorFixture = "Google Inc.";
    state.rendererExposed = true;
    expect(probeWebgl2Support()).toMatchObject({ ok: false, adapterClass: "software" });
  });

  it("does not spend device-loss recovery attempts on healthy GPU readback timeouts and retries startup timeout once", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter: async () => ({ info: { description: "NVIDIA T4" } }) } },
    });
    // 1st startup attach times out (ErrorCode.Timeout = 12); retry succeeds without blacklisting WebGPU.
    state.attachFixture = async (_surface, attempt) => {
      if (attempt === 1)
        return { ok: false, code: 12, message: "GPU wait timed out after 6000 ms" };
      state.gpuLost = false;
      return {
        ok: true,
        value: { adapter: "NVIDIA T4", backend: "webgpu", details: "{}", fallback: false },
      };
    };
    const editor = { scene: {}, doc: { version: 1 } } as never;
    const images = { subscribe: () => () => {}, natural: () => null, get: () => null } as never;
    const view = await EngineView.create(
      new FakeCanvas(true) as unknown as HTMLCanvasElement,
      editor,
      {} as never,
      images,
      "engine",
    );
    expect(view?.backend).toBe("webgpu");
    expect(state.attachCalls).toBe(2);
    expect(fallbacks).toEqual([]);

    // Runtime readback Timeout (12) on a healthy context must NOT spend device-loss recovery budget.
    const engine = view?.engine as unknown as {
      gpuPixels: () => Promise<unknown>;
      gpuCheck: () => { ok: boolean };
    };
    let readCount = 0;
    engine.gpuPixels = async () => {
      readCount++;
      return { ok: false, code: 12, message: "GPU wait timed out after 12000 ms" };
    };
    expect(engine.gpuCheck()).toEqual({ ok: true });
    let retried = 0;
    if (view) view.onChange = () => retried++;
    view?.draw("page", { zoom: 1, x: 0, y: 0 }, 65, 17, 1, "#abcdef", {
      hidden: new Set(),
      whole: null,
    });
    await new Promise((ready) => setTimeout(ready, 360));
    expect(readCount).toBe(1);
    expect(recoveries).toEqual([]);
    expect(fallbacks).toEqual([]);
    expect(retried).toBeGreaterThanOrEqual(1);
    view?.dispose();
  });

  it("ignores obsolete CPU job errors and keeps a limited view on the Worker", async () => {
    const editor = { scene: {}, doc: { version: 1 } } as never;
    const images = { subscribe: () => () => {}, natural: () => null, get: () => null } as never;
    const view = await EngineView.create(
      new FakeCanvas(true) as unknown as HTMLCanvasElement,
      editor,
      {} as never,
      images,
      "engine-cpu",
    );
    const frame = (x: number) =>
      view?.draw("page", { zoom: 1, x, y: 0 }, 512, 512, 1, "#ffffff", {
        hidden: new Set(),
        whole: null,
      });
    frame(0);
    frame(32);
    const jobs = state.workerMessages.filter((m) => m.type === "render");
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.jobId).not.toBe(jobs[1]?.jobId);

    // Obsolete job error must be ignored completely.
    state.lastWorker?.emit({
      type: "error",
      jobId: jobs[0]?.jobId,
      revision: 1,
      code: 4,
      message: "obsolete job limit",
    });
    expect(state.lastWorker?.terminated).toBe(false);
    expect(fallbacks).toEqual([]);

    // A failed reduced render leaves the Worker active and exposes the reason on the chip.
    state.lastWorker?.emit({
      type: "error",
      jobId: jobs[1]?.jobId,
      revision: 1,
      code: 4,
      message: "active view limit",
    });
    expect(state.lastWorker?.terminated).toBe(false);
    expect(fallbacks).toEqual([]);
    expect(view?.limitReason).toBe("active view limit");
    expect(view?.software).toBe(false);
    expect(frame(32)).toMatchObject({ drawn: true, exact: false, settled: true });
    expect(view?.limitReason).toBe("active view limit");
    // Moving to a different camera view resumes CPU rendering cleanly and clears the limit reason.
    expect(frame(64)).toMatchObject({ drawn: true });
    expect(view?.limitReason).toBeNull();
    view?.dispose();
  });

  it("mounts, swaps, and removes active engine canvases inside a durable container slot", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter: async () => ({ info: { description: "NVIDIA T4" } }) } },
    });
    const editor = { scene: {}, doc: { version: 1 } } as never;
    const images = { subscribe: () => () => {}, natural: () => null, get: () => null } as never;
    const slot = new FakeSlot();
    const view = await EngineView.create(
      slot as unknown as HTMLElement,
      editor,
      {} as never,
      images,
      "engine",
    );
    expect(view).not.toBeNull();
    expect(slot.children).toHaveLength(1);
    const firstCanvas = slot.children[0];
    expect(firstCanvas).toBe(view?.canvas);
    expect(firstCanvas?.dataset.canvasRole).toBe("engine");

    // Device-loss recovery replaces the child inside the durable slot without detaching the slot.
    state.gpuLost = true;
    healthTick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(slot.isConnected).toBe(true);
    expect(slot.children).toHaveLength(1);
    expect(slot.children[0]).not.toBe(firstCanvas);
    expect(slot.children[0]).toBe(view?.canvas);

    // Disposing removes the active engine canvas cleanly so same-route switching leaves no orphan.
    view?.dispose();
    expect(slot.children).toHaveLength(0);
    expect(slot.isConnected).toBe(true);
  });

  it("shapes deferred visible text via ahead() in CPU worker mode without interrupting in-flight exact jobs for offscreen text", async () => {
    state.builderPendingVisible = 2;
    state.builderPendingOffscreen = 3;
    try {
      const editor = { scene: {}, doc: { version: 1 } } as never;
      const images = { subscribe: () => () => {}, natural: () => null, get: () => null } as never;
      const view = await EngineView.create(
        new FakeCanvas(true) as unknown as HTMLCanvasElement,
        editor,
        {} as never,
        images,
        "engine-cpu",
      );
      let changeCount = 0;
      if (view) view.onChange = () => changeCount++;

      // First draw with visible provisional text sends a moving render and requests ahead() work.
      const first = view?.draw("page", { zoom: 1, x: 0, y: 0 }, 512, 512, 1, "#ffffff", {
        hidden: new Set(),
        whole: null,
      });
      expect(first).toMatchObject({ drawn: true, exact: false, ahead: true, settled: false });
      expect(state.workerMessages.filter((m) => m.type === "apply")).toHaveLength(1);
      expect(state.workerMessages.filter((m) => m.type === "render").at(-1)).toMatchObject({
        moving: true,
      });

      // ahead() shapes visible text first and sends an apply patch to the CPU worker.
      const visibleAhead = view?.ahead("page", "#ffffff", 4);
      expect(visibleAhead).toMatchObject({ progressed: true, textVisible: 0, text: 3 });
      expect(state.workerMessages.filter((m) => m.type === "apply")).toHaveLength(2);

      // Next draw posts an exact render job; offscreen text must NOT cancel it mid-flight.
      const exactDraw = view?.draw("page", { zoom: 1, x: 0, y: 0 }, 512, 512, 1, "#ffffff", {
        hidden: new Set(),
        whole: null,
      });
      expect(exactDraw).toMatchObject({ drawn: true, exact: false, ahead: false, settled: true });
      const exactJob = state.workerMessages.filter((m) => m.type === "render").at(-1);
      expect(exactJob).toMatchObject({ moving: false, revision: 2 });
      expect(view?.ahead("page", "#ffffff", 4)).toMatchObject({ progressed: false, text: 3 });
      expect(state.workerMessages.filter((m) => m.type === "apply")).toHaveLength(2);

      // Once the exact job completes, onChange wakes the idle loop and ahead() shapes offscreen text.
      state.lastWorker?.emit({
        type: "done",
        jobId: exactJob?.jobId,
        revision: 2,
        width: 512,
        height: 512,
        camera: { zoom: 1, x: 0, y: 0, dpr: 1 },
        exact: true,
        plan: "tiles",
        tiles: { drawn: 4, pending: 0, queued: 0, held: 4, evicted: 0, dragged: 0 },
        ms: 5,
        records: 1,
        culled: 0,
        glyphsMasked: 0,
        glyphsOutlined: 0,
      });
      expect(changeCount).toBe(1);
      const offscreenAhead = view?.ahead("page", "#ffffff", 4);
      expect(offscreenAhead).toMatchObject({ progressed: true, text: 0, textVisible: 0 });
      expect(state.workerMessages.filter((m) => m.type === "apply")).toHaveLength(3);
      view?.dispose();
    } finally {
      state.builderPendingVisible = 0;
      state.builderPendingOffscreen = 0;
    }
  });

  it("ignores late direct-GPU completion callbacks after Canvas takes over on an unsupported page", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter: async () => ({ info: { description: "NVIDIA T4" } }) } },
    });
    (globalThis.window as unknown as { location: { href: string } }).location.href =
      "https://drawpane.test/?present=webgpu";
    const holds: Array<() => void> = [];
    let holdActive = true;
    state.gpuFinishedFixture = async () => {
      if (holdActive) {
        await new Promise<void>((resolve) => holds.push(resolve));
      }
      return { ok: true };
    };
    const origRaf = globalThis.requestAnimationFrame;
    const rafQueue: Array<() => void> = [];
    (
      globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }
    ).requestAnimationFrame = (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    try {
      const editor = { scene: {}, doc: { version: 1 } } as never;
      const images = { subscribe: () => () => {}, natural: () => null, get: () => null } as never;
      const view = await EngineView.create(
        new FakeCanvas(true) as unknown as HTMLCanvasElement,
        editor,
        {} as never,
        images,
        "engine",
      );
      expect(view).not.toBeNull();
      const presentedFrames: number[] = [];
      if (view) view.onGpuPresented = (n) => presentedFrames.push(n);

      // Submit a direct-GPU frame on page-1 while gpuFinished() is held.
      const first = view?.draw("page-1", { zoom: 1, x: 0, y: 0 }, 400, 300, 1, "#ffffff", {
        hidden: new Set(),
        whole: null,
      });
      expect(first?.drawn).toBe(true);
      expect(holds).toHaveLength(1);
      expect(presentedFrames).toEqual([]);

      // Switch to an unsupported page-2 so Canvas covers the engine (superseding page-1's epoch).
      state.builderSupported = false;
      const fallback = view?.draw("page-2", { zoom: 1, x: 0, y: 0 }, 400, 300, 1, "#ffffff", {
        hidden: new Set(),
        whole: null,
      });
      expect(fallback?.drawn).toBe(false);

      // Release page-1's late gpuFinished() callback and flush animation frames: MUST NOT count.
      holdActive = false;
      for (const release of holds.splice(0)) release();
      await new Promise((r) => setTimeout(r, 0));
      for (const cb of rafQueue.splice(0)) cb();
      expect(presentedFrames).toEqual([]);

      // Returning to a supported page resumes direct-GPU confirmation cleanly.
      state.builderSupported = true;
      const resumed = view?.draw("page-1", { zoom: 1, x: 0, y: 0 }, 400, 300, 1, "#ffffff", {
        hidden: new Set(),
        whole: null,
      });
      expect(resumed?.drawn).toBe(true);
      await new Promise((r) => setTimeout(r, 0));
      for (const cb of rafQueue.splice(0)) cb();
      expect(presentedFrames).toEqual([2]);
      view?.dispose();
    } finally {
      state.builderSupported = true;
      state.gpuFinishedFixture = null;
      (globalThis as unknown as { requestAnimationFrame: typeof origRaf }).requestAnimationFrame =
        origRaf;
    }
  });
});
