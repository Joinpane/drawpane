import { ErrorCode } from "@drawpane/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  engineBackendLabel,
  fallbackToReason,
  formatRendererReason,
  rendererChipLabel,
  sameRendererStatus,
} from "./renderer-status";
import {
  DEFAULT_RENDERER_POLICY,
  engineSearch,
  MOTION_POLICY_STORAGE_KEY,
  motionPolicy,
  PRESENT_STORAGE_KEY,
  presentation,
  RENDERER_STORAGE_KEY,
  type RendererChoice,
  type RendererPolicy,
  type RendererSource,
  rememberRendererSwitches,
  rendererChoice,
  selectRenderer,
} from "./renderer-switch";

class MemoryStorage implements Storage {
  readonly #map = new Map<string, string>();
  get length(): number {
    return this.#map.size;
  }
  clear(): void {
    this.#map.clear();
  }
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
}

describe("renderer-switch", () => {
  const originalLocal = globalThis.localStorage;
  const originalSession = globalThis.sessionStorage;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: new MemoryStorage(),
      configurable: true,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      value: new MemoryStorage(),
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: { location: { href: "http://localhost/f/file-1" } },
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocal,
      configurable: true,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      value: originalSession,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
    });
  });

  it("validates engine search parameters and ignores unknown values", () => {
    expect(engineSearch({ renderer: "engine", present: "readback", other: "x" })).toEqual({
      renderer: "engine",
      present: "readback",
    });
    expect(engineSearch({ renderer: "engine-compat", present: "webgpu" })).toEqual({
      renderer: "engine-compat",
      present: "webgpu",
    });
    expect(engineSearch({ renderer: "engine-webgl" })).toEqual({ renderer: "engine-webgl" });
    expect(engineSearch({ renderer: "engine-cpu" })).toEqual({ renderer: "engine-cpu" });
    expect(engineSearch({ renderer: "canvas" })).toEqual({ renderer: "canvas" });
    expect(engineSearch({ renderer: "bogus", present: "bogus" })).toEqual({});
  });

  const engineDefault: RendererPolicy = { defaultRenderer: "engine", forceCanvas: false };

  it.each<{
    source: RendererSource;
    choice: RendererChoice;
    url?: string;
    session?: string;
    local?: string;
    policy?: RendererPolicy | null;
  }>([
    {
      source: "server",
      choice: "canvas",
      url: "engine-webgl",
      session: "engine-cpu",
      local: "engine",
      policy: { ...engineDefault, forceCanvas: true },
    },
    {
      source: "url",
      choice: "canvas",
      url: "canvas",
      session: "engine-cpu",
      local: "engine",
      policy: engineDefault,
    },
    {
      source: "url",
      choice: "engine-webgl",
      url: "engine-webgl",
      session: "canvas",
      policy: engineDefault,
    },
    {
      source: "session",
      choice: "engine-cpu",
      url: "bogus",
      session: "engine-cpu",
      local: "canvas",
      policy: engineDefault,
    },
    { source: "local", choice: "canvas", session: "bogus", local: "canvas", policy: engineDefault },
    { source: "instance-default", choice: "engine", local: "bogus", policy: engineDefault },
    {
      source: "instance-default",
      choice: "canvas",
      policy: { defaultRenderer: "canvas", forceCanvas: false },
    },
    { source: "built-in", choice: "canvas", policy: DEFAULT_RENDERER_POLICY },
    { source: "settings-unavailable", choice: "canvas", url: "engine", policy: null },
  ])("chooses $choice from $source", ({ source, choice, url, session, local, policy }) => {
    if (session) sessionStorage.setItem(RENDERER_STORAGE_KEY, session);
    if (local) localStorage.setItem(RENDERER_STORAGE_KEY, local);
    expect(selectRenderer(url ? `?renderer=${url}` : "", policy)).toEqual({ choice, source });
  });

  it("remembers a Canvas URL escape on an engine-default instance", () => {
    expect(selectRenderer("?renderer=canvas", engineDefault)).toEqual({
      choice: "canvas",
      source: "url",
    });
    expect(selectRenderer("", engineDefault)).toEqual({ choice: "canvas", source: "session" });
  });

  it("uses the next source when storage throws and keeps URL overrides through app navigation", () => {
    const blocked = () => {
      throw new Error("Storage is blocked");
    };
    const availableSession = sessionStorage;
    Object.defineProperty(globalThis, "sessionStorage", { get: blocked, configurable: true });
    localStorage.setItem(RENDERER_STORAGE_KEY, "canvas");
    expect(selectRenderer("", engineDefault)).toEqual({ choice: "canvas", source: "local" });
    Object.defineProperty(globalThis, "localStorage", { get: blocked, configurable: true });
    expect(selectRenderer("", engineDefault)).toEqual({
      choice: "engine",
      source: "instance-default",
    });
    expect(selectRenderer("?renderer=canvas", engineDefault)).toEqual({
      choice: "canvas",
      source: "url",
    });
    expect(selectRenderer("", engineDefault)).toEqual({ choice: "canvas", source: "session" });
    Object.defineProperty(globalThis, "sessionStorage", {
      value: availableSession,
      configurable: true,
    });
    rememberRendererSwitches("?renderer=canvas");
  });

  it("remembers ?renderer=engine, engine-compat, engine-webgl, and engine-cpu in sessionStorage", () => {
    expect(rendererChoice("")).toBe("canvas");

    // Set on the dashboard or initial URL.
    rememberRendererSwitches("?renderer=engine");
    expect(sessionStorage.getItem(RENDERER_STORAGE_KEY)).toBe("engine");

    // Opening a file drops the query string: sessionStorage still keeps it.
    expect(rendererChoice("")).toBe("engine");

    // Compatibility, WebGL2, and CPU view switches persist too.
    rememberRendererSwitches("?renderer=engine-compat");
    expect(rendererChoice("")).toBe("engine-compat");
    rememberRendererSwitches("?renderer=engine-webgl");
    expect(rendererChoice("")).toBe("engine-webgl");
    rememberRendererSwitches("?renderer=engine-cpu");
    expect(rendererChoice("")).toBe("engine-cpu");
  });

  it("turns the engine back off with ?renderer=canvas", () => {
    rememberRendererSwitches("?renderer=engine");
    expect(rendererChoice("")).toBe("engine");

    rememberRendererSwitches("?renderer=canvas");
    expect(rendererChoice("")).toBe("canvas");
    expect(sessionStorage.getItem(RENDERER_STORAGE_KEY)).toBeNull();
  });

  it("lets ?renderer=canvas override localStorage for engine, engine-webgl, and engine-cpu", () => {
    for (const storedMode of ["engine", "engine-webgl", "engine-cpu"] as const) {
      sessionStorage.clear();
      localStorage.setItem(RENDERER_STORAGE_KEY, storedMode);
      expect(rendererChoice("")).toBe(storedMode);

      expect(rendererChoice("?renderer=canvas")).toBe("canvas");
      expect(sessionStorage.getItem(RENDERER_STORAGE_KEY)).toBe("canvas");
      // Still off after navigating to a URL without the query string.
      expect(rendererChoice("")).toBe("canvas");

      // Re-enabling via URL turns it back on.
      expect(rendererChoice(`?renderer=${storedMode}`)).toBe(storedMode);
      expect(rendererChoice("")).toBe(storedMode);
    }
  });

  it("remembers ?present=readback in sessionStorage and turns it off with ?present=webgpu", () => {
    expect(presentation("")).toBe("webgpu");

    rememberRendererSwitches("?present=readback");
    expect(sessionStorage.getItem(PRESENT_STORAGE_KEY)).toBe("readback");
    expect(presentation("")).toBe("readback");

    rememberRendererSwitches("?present=webgpu");
    expect(presentation("")).toBe("webgpu");
    expect(sessionStorage.getItem(PRESENT_STORAGE_KEY)).toBeNull();
  });

  it("switches motion policy between standin (default) and exact via URL or storage", () => {
    expect(motionPolicy("")).toBe("standin");
    expect(engineSearch({ motion: "exact" })).toEqual({ motion: "exact" });
    expect(engineSearch({ motion: "standin" })).toEqual({ motion: "standin" });
    expect(engineSearch({ motion: "bogus" })).toEqual({});

    rememberRendererSwitches("?motion=exact");
    expect(sessionStorage.getItem(MOTION_POLICY_STORAGE_KEY)).toBe("exact");
    expect(motionPolicy("")).toBe("exact");

    rememberRendererSwitches("?motion=standin");
    expect(motionPolicy("")).toBe("standin");
    expect(sessionStorage.getItem(MOTION_POLICY_STORAGE_KEY)).toBeNull();

    localStorage.setItem(MOTION_POLICY_STORAGE_KEY, "exact");
    expect(motionPolicy("")).toBe("exact");
    expect(motionPolicy("?motion=standin")).toBe("standin");
    expect(sessionStorage.getItem(MOTION_POLICY_STORAGE_KEY)).toBe("standin");
    expect(motionPolicy("")).toBe("standin");
  });
});

describe("renderer-status formatting", () => {
  it("formats active engine and fallback chip labels and reasons", () => {
    expect(engineBackendLabel("webgpu")).toBe("WebGPU");
    expect(engineBackendLabel("webgl2")).toBe("WebGL2");
    expect(engineBackendLabel("cpu-worker")).toBe("CPU view");

    const engine = {
      switchOn: true as const,
      choice: "engine" as const,
      active: "engine" as const,
      backend: engineBackendLabel("webgpu"),
      adapter: "Apple M3",
      compatibility: false,
      software: false,
    };
    expect(rendererChipLabel(engine)).toBe("Engine · WebGPU");
    expect(formatRendererReason(engine)).toBe("Drawing with WebGPU (Apple M3)");

    const webgl = {
      ...engine,
      choice: "engine-webgl" as const,
      backend: engineBackendLabel("webgl2"),
      adapter: "NVIDIA T4",
    };
    expect(rendererChipLabel(webgl)).toBe("Engine · WebGL2");
    expect(formatRendererReason(webgl)).toBe("Drawing with WebGL2 (NVIDIA T4)");

    const cpu = {
      ...engine,
      choice: "engine-cpu" as const,
      backend: engineBackendLabel("cpu-worker"),
      adapter: "vello_cpu (Web Worker)",
    };
    expect(rendererChipLabel(cpu)).toBe("Engine · CPU view");
    expect(formatRendererReason(cpu)).toBe("Drawing with CPU view (vello_cpu (Web Worker))");

    const recovering = {
      switchOn: true as const,
      choice: "engine" as const,
      active: "canvas" as const,
      reason: { kind: "recovering" as const },
    };
    expect(rendererChipLabel(recovering)).toBe("Canvas renderer");
    expect(formatRendererReason(recovering)).toBe("recovering GPU surface");

    const unsupported = {
      switchOn: true as const,
      choice: "engine" as const,
      active: "canvas" as const,
      reason: { kind: "unsupported" as const, features: ["shadow", "glass", "layerBlur"] },
    };
    expect(rendererChipLabel(unsupported)).toBe("Canvas renderer");
    expect(formatRendererReason(unsupported)).toBe("this page uses shadow, glass, layer blur");

    const noGpu = {
      switchOn: true as const,
      choice: "engine" as const,
      active: "canvas" as const,
      reason: fallbackToReason({
        from: "webgpu",
        to: "canvas",
        reason: "this browser has no WebGPU",
        code: ErrorCode.NoAdapter,
        adapter: null,
        kind: "no-webgpu",
      }),
    };
    expect(formatRendererReason(noGpu)).toBe("no WebGPU in this browser");

    const software = {
      switchOn: true as const,
      choice: "engine" as const,
      active: "canvas" as const,
      reason: fallbackToReason({
        from: "webgpu",
        to: "canvas",
        reason: "only a software WebGPU adapter is available",
        code: ErrorCode.NoAdapter,
        adapter: null,
        kind: "software-gpu",
      }),
    };
    expect(formatRendererReason(software)).toBe("only a software GPU");

    const err = {
      switchOn: true as const,
      choice: "engine" as const,
      active: "canvas" as const,
      reason: fallbackToReason({
        from: "webgpu",
        to: "canvas",
        reason: "device lost",
        code: ErrorCode.DeviceLost,
        adapter: "SwiftShader",
        kind: "error",
      }),
    };
    expect(formatRendererReason(err)).toBe("engine error: device lost");
  });

  it("compares status values so unchanged frames skip notifications", () => {
    const a = {
      switchOn: true as const,
      choice: "engine" as const,
      active: "canvas" as const,
      reason: { kind: "unsupported" as const, features: ["shadow"] },
    };
    const b = {
      switchOn: true as const,
      choice: "engine" as const,
      active: "canvas" as const,
      reason: { kind: "unsupported" as const, features: ["shadow"] },
    };
    const c = {
      switchOn: true as const,
      choice: "engine" as const,
      active: "canvas" as const,
      reason: { kind: "unsupported" as const, features: ["shadow", "glass"] },
    };
    expect(sameRendererStatus(a, b)).toBe(true);
    expect(sameRendererStatus(a, c)).toBe(false);
  });
});
