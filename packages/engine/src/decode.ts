import type * as Glue from "./decoder-glue";

const MAX_BYTES = 16 << 20;
const RESERVE_BYTES = 2 << 20;

/** One bounded decoder per host. The renderer charges its retained Wasm pages. */
export function imageDecoder(glue: typeof Glue, wasm: WebAssembly.Module) {
  let instance: typeof Glue | undefined;
  return {
    memoryBytes: () => instance?.memoryBytes() ?? 0,
    decode(
      file: { width: number; height: number; bytes: Uint8Array },
      target: { width: number; height: number },
      room: number,
    ): Uint8Array | "too-large" | null {
      const budget = Math.min(MAX_BYTES, room);
      if (file.bytes.length + target.width * target.height * 4 + RESERVE_BYTES > budget)
        return "too-large";
      try {
        if (!instance) {
          const next = glue.__drawpaneCreateGlue();
          next.initSync({ module: wasm });
          instance = next;
        }
        return (
          instance.decodeImage(
            file.width,
            file.height,
            target.width,
            target.height,
            file.bytes,
            budget,
          ) ?? "too-large"
        );
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError) {
          instance?.__drawpaneQuiesce();
          instance = undefined;
        }
        return null;
      }
    },
  };
}
