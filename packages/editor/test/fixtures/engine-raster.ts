import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ErrorCode, RenderEngine } from "@drawpane/engine";
import { imageDecoder } from "@drawpane/engine/decode";
import { loadNodeEngine } from "@drawpane/engine/node";
import {
  createHeadlessRenderer,
  type HeadlessEngineDeps,
  HeadlessRenderError,
} from "../../src/headless-render";
import type { TextMeasurer } from "../../src/text";

const require = createRequire(import.meta.url);

export async function nodeImageDecoder() {
  const glue = await import("@drawpane/engine/decoder-glue");
  const bytes = readFileSync(require.resolve("@drawpane/engine/decoder.wasm"));
  return imageDecoder(glue, new WebAssembly.Module(bytes));
}

/** The capped Worker renderer with Node hosts for fonts and image bytes. */
export function headlessEngine(
  measurer: TextMeasurer,
  options: Partial<Omit<HeadlessEngineDeps, "measurer">> = {},
) {
  let decoder: ReturnType<typeof nodeImageDecoder> | undefined;
  let decodedMemory = 0;
  return createHeadlessRenderer({
    measurer,
    images: async () => null,
    decodeMemoryBytes: () => decodedMemory,
    async decodeImage(file, target, room) {
      decoder ??= nodeImageDecoder();
      const codec = await decoder;
      const result = codec.decode(file, target, room);
      decodedMemory = codec.memoryBytes();
      return result;
    },
    async acquireEngine() {
      const module = await loadNodeEngine("worker", { fresh: true });
      const engine = new RenderEngine(module, { glyphOutlineBytes: 8 << 20 });
      if (engine.dead)
        throw new HeadlessRenderError({
          ok: false,
          code: ErrorCode.Trap,
          message: "Could not start the render engine.",
        });
      return { engine, release: () => module.glue.__drawpaneQuiesce() };
    },
    ...options,
  });
}
