/**
 * The spike's Worker (decision 0040, "The CPU backend for Workers"): the engine's CPU build,
 * beside HarfBuzz as the agent runner holds it, both with their memory capped. POST a display
 * list to /render: it answers what the render took in memory, and with ?pixels=1 the pixels
 * after a JSON header (4-byte length, JSON, then straight RGBA). Timing is measured by the
 * caller: a Worker's clock stands still while it computes.
 */
import interFile from "../../../apps/web/e2e/fixtures/Inter-Variable.ttf";
import { initSync, memoryBytes, renderCpu } from "../dist/cpu/engine.js";
import engineWasm from "../wasm/engine.wasm";
import hbWasm from "../wasm/harfbuzz.wasm";

interface EmscriptenOptions {
  instantiateWasm(
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ): Record<string, never>;
}

let hbMemory: WebAssembly.Memory | null = null;
let harfBuzzReady: Promise<number> | null = null;

/** HarfBuzz instantiated, Inter loaded and a line shaped: what text measuring holds. */
function loadHarfBuzz(): Promise<number> {
  harfBuzzReady ??= (async () => {
    (globalThis as { __drawpaneHarfBuzz?: EmscriptenOptions }).__drawpaneHarfBuzz = {
      instantiateWasm(imports, done) {
        void WebAssembly.instantiate(hbWasm, imports).then((instance) => {
          hbMemory = instance.exports.memory as WebAssembly.Memory;
          done(instance, hbWasm);
        });
        return {};
      },
    };
    const hb = await import("harfbuzzjs");
    const blob = new hb.Blob(interFile);
    const face = new hb.Face(blob, 0);
    const font = new hb.Font(face);
    const buffer = new hb.Buffer();
    buffer.addText("Turtle and rabbit: the slider's ends, shaped once.");
    buffer.guessSegmentProperties();
    hb.shape(font, buffer);
    return buffer.getGlyphInfos().length;
  })();
  return harfBuzzReady;
}

let engineReady = false;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const glyphs = await loadHarfBuzz();
    if (!engineReady) {
      initSync({ module: engineWasm });
      engineReady = true;
    }
    if (url.pathname === "/noop") return Response.json({ glyphs });
    if (url.pathname !== "/render" || request.method !== "POST")
      return new Response("not found", { status: 404 });
    const list = new Uint8Array(await request.arrayBuffer());
    let frame: ReturnType<typeof renderCpu>;
    try {
      frame = renderCpu(list);
    } catch (error) {
      return Response.json({ error: String(error), engineMemory: memoryBytes() }, { status: 500 });
    }
    const header = {
      width: frame.width,
      height: frame.height,
      ops: frame.ops,
      flushes: frame.flushes,
      apart: frame.apart,
      glass: frame.glass,
      glyphs,
      engineMemory: memoryBytes(),
      harfBuzzMemory: hbMemory?.buffer.byteLength ?? null,
    };
    if (url.searchParams.get("pixels") !== "1") {
      frame.free();
      return Response.json(header);
    }
    const json = new TextEncoder().encode(JSON.stringify(header));
    const rgba = frame.rgba();
    frame.free();
    const body = new Uint8Array(4 + json.length + rgba.length);
    new DataView(body.buffer).setUint32(0, json.length, true);
    body.set(json, 4);
    body.set(rgba, 4 + json.length);
    return new Response(body);
  },
};
