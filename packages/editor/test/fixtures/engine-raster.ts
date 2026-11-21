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
  let decoder: Awaited<ReturnType<typeof nodeImageDecoder>> | undefined;
  return createHeadlessRenderer({
    measurer,
    images: async () => null,
    decodeMemoryBytes: () => decoder?.memoryBytes() ?? 0,
    async decodeImage(file, target, room) {
      decoder ??= await nodeImageDecoder();
      return decoder.decode(file, target, room);
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
      return {
        engine,
        release() {
          decoder?.dispose();
          module.glue.__drawpaneQuiesce();
        },
      };
    },
    ...options,
  });
}
