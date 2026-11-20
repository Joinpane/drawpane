import { ErrorCode } from "@drawpane/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fallbackToReason,
  formatRendererReason,
  rendererChipLabel,
  sameRendererStatus,
} from "./renderer-status";
import {
  engineSearch,
  PRESENT_STORAGE_KEY,
  presentation,
  RENDERER_STORAGE_KEY,
  rememberRendererSwitches,
  rendererChoice,
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
    expect(engineSearch({ renderer: "canvas" })).toEqual({ renderer: "canvas" });
    expect(engineSearch({ renderer: "bogus", present: "bogus" })).toEqual({});
  });

  it("remembers ?renderer=engine in sessionStorage across navigations without the query param", () => {
    expect(rendererChoice("")).toBe("canvas");

    // Set on the dashboard or initial URL.
    rememberRendererSwitches("?renderer=engine");
    expect(sessionStorage.getItem(RENDERER_STORAGE_KEY)).toBe("engine");

    // Opening a file drops the query string: sessionStorage still keeps it.
    expect(rendererChoice("")).toBe("engine");

    // Compatibility level persists too.
    rememberRendererSwitches("?renderer=engine-compat");
    expect(rendererChoice("")).toBe("engine-compat");
  });

  it("turns the engine back off with ?renderer=canvas", () => {
    rememberRendererSwitches("?renderer=engine");
    expect(rendererChoice("")).toBe("engine");

    rememberRendererSwitches("?renderer=canvas");
    expect(rendererChoice("")).toBe("canvas");
    expect(sessionStorage.getItem(RENDERER_STORAGE_KEY)).toBeNull();
  });

  it("lets ?renderer=canvas override localStorage for the rest of the session", () => {
    localStorage.setItem(RENDERER_STORAGE_KEY, "engine");
    expect(rendererChoice("")).toBe("engine");

    expect(rendererChoice("?renderer=canvas")).toBe("canvas");
    expect(sessionStorage.getItem(RENDERER_STORAGE_KEY)).toBe("canvas");
    // Still off after navigating to a URL without the query string.
    expect(rendererChoice("")).toBe("canvas");

    // Re-enabling via URL turns it back on.
    expect(rendererChoice("?renderer=engine")).toBe("engine");
    expect(rendererChoice("")).toBe("engine");
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
});

describe("renderer-status formatting", () => {
  it("formats active engine and fallback chip labels and reasons", () => {
    const engine = {
      switchOn: true as const,
      choice: "engine" as const,
      active: "engine" as const,
      backend: "WebGPU",
      adapter: "Apple M3",
      compatibility: false,
      software: false,
    };
    expect(rendererChipLabel(engine)).toBe("Engine · WebGPU");
    expect(formatRendererReason(engine)).toBe("Drawing with WebGPU (Apple M3)");

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
