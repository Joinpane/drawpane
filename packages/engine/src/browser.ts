import { type EngineModule, loadEngineAsync } from "./index";

/** Loads the browser's WebGPU and CPU build. */
export async function loadBrowserEngine(): Promise<EngineModule> {
  return loadEngineAsync(await import("@drawpane/engine/browser-glue"), "browser");
}

/** Loads the separate WebGPU build used by the opt-in compute experiment. */
export async function loadComputeEngine(): Promise<EngineModule> {
  return loadEngineAsync(await import("@drawpane/engine/compute-glue"), "browser");
}

/** Loads the WebGL2 fallback and keeps its glue out of CPU-only hosts. */
export async function loadWebglEngine(): Promise<EngineModule> {
  return loadEngineAsync(await import("@drawpane/engine/webgl-glue"), "webgl");
}

/** Loads the CPU-only Worker build (25 MiB cap) for dedicated browser Workers. */
export async function loadWorkerEngine(): Promise<EngineModule> {
  return loadEngineAsync(await import("@drawpane/engine/worker-glue"), "worker");
}
