import { type BooleanEngine, loadPathKitEngine } from "@drawpane/editor";

/**
 * Loads Skia's PathOps (PathKit, WASM) the first time a boolean runs. Both
 * the loader and the WASM are separate chunks, so opening a file never
 * downloads them. See docs/decisions/0002-vector-booleans.md.
 */
export async function loadBooleanEngine(): Promise<BooleanEngine> {
  const { default: wasmUrl } = await import("pathkit-wasm/bin/pathkit.wasm?url");
  return loadPathKitEngine({ wasmUrl });
}
