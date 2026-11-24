import type * as Glue from "./preview-glue";

const MAX_BYTES = 32 << 20;
const HIGH_WATER_BYTES = 16 << 20;
const RESERVE_BYTES = 2 << 20;
const DEFAULT_QUALITY = 80;

/**
 * A bounded server-side preview generator backed by WebAssembly with a 32 MiB linear-memory cap.
 * Reuses one instantiated module across requests, discards it after high-water bursts (> 16 MiB)
 * so idle memory stays small, and discards it cleanly if a trap occurs.
 */
export function imagePreviewer(glue: typeof Glue, wasm: WebAssembly.Module) {
  let instance: typeof Glue | undefined;
  const dispose = () => {
    const current = instance;
    instance = undefined;
    current?.__drawpaneQuiesce();
  };
  return {
    memoryBytes: () => instance?.memoryBytes() ?? 0,
    dispose,
    generate(
      file: { readonly width: number; readonly height: number; readonly bytes: Uint8Array },
      maxSide: number,
      options?: { readonly quality?: number; readonly budget?: number },
    ): Uint8Array | null {
      const budget = Math.min(MAX_BYTES, options?.budget ?? MAX_BYTES);
      if (file.bytes.length + RESERVE_BYTES > budget) return null;
      const quality = options?.quality ?? DEFAULT_QUALITY;
      try {
        if (!instance) {
          const next = glue.__drawpaneCreateGlue();
          next.initSync({ module: wasm });
          instance = next;
        }
        const out =
          instance.makePreview(file.width, file.height, maxSide, quality, file.bytes, budget) ??
          null;
        if (instance.memoryBytes() > HIGH_WATER_BYTES) dispose();
        return out;
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError) dispose();
        return null;
      }
    },
  };
}
