/**
 * The engine's Worker build in workerd, beside what the agent runner holds (decision 0040, "Tested
 * as the whole agent runner"; decision 0033's caps): the headless editor (document, scene, layout,
 * the display-list builder), HarfBuzz with a font loaded (the runner's own measurer, its module
 * capped at 32 MiB) and the engine (capped at 25 MiB). A scene is built here, laid out and shaped,
 * turned into a display list and exported as a PNG band by band, streamed into the response.
 *
 * GET /export?width=&height=&cards=&seed= answers the PNG, with the run's numbers in the
 * `x-engine-report` header; /noop loads everything and answers; /health answers "ok". Local only
 * (`wrangler dev`, scripts/workerd.mjs), never deployed.
 */
import { DisplayListBuilder, Doc, Scene } from "@drawpane/editor";
import { type EngineModule, ErrorCode, loadEngineSync, RenderEngine } from "@drawpane/engine";
import * as glue from "@drawpane/engine/worker-glue";
import {
  type HarfBuzzWasmOptions,
  harfBuzzWasmOptions,
} from "../../apps/agent-runner/src/harfbuzz-draw";
import { harfBuzzMeasurerWith } from "../../apps/agent-runner/src/harfbuzz-measurer";
import interFile from "../../apps/web/e2e/fixtures/Inter-Variable.ttf";
import { scene } from "./scene";
import engineWasm from "./wasm/engine.wasm";
import hbWasm from "./wasm/harfbuzz.wasm";
import drawWasm from "./wasm/harfbuzz-draw.wasm";

type HarfBuzz = typeof import("harfbuzzjs");
let hbMemory: WebAssembly.Memory | null = null;
let harfBuzz: Promise<HarfBuzz> | null = null;
function loadHarfBuzz(): Promise<HarfBuzz> {
  harfBuzz ??= (() => {
    (globalThis as { __drawpaneHarfBuzz?: HarfBuzzWasmOptions }).__drawpaneHarfBuzz =
      harfBuzzWasmOptions(hbWasm, drawWasm, (memory) => {
        hbMemory = memory;
      });
    return import("harfbuzzjs");
  })();
  return harfBuzz;
}

const inter = interFile.slice(0);
const measurer = harfBuzzMeasurerWith(async () => inter, loadHarfBuzz);
let module: EngineModule | null = null;

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handle(request);
    } catch (error) {
      return Response.json(
        { error: String(error), stack: (error as Error)?.stack ?? null, code: -1 },
        { status: 500 },
      );
    }
  },
};

async function handle(request: Request): Promise<Response> {
  {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    module ??= loadEngineSync(glue, engineWasm, "worker");
    await measurer.load([
      { family: "Inter", weight: 400, italic: false },
      { family: "Inter", weight: 600, italic: false },
    ]);
    if (url.pathname === "/memory")
      return Response.json({
        engineMemory: module.memoryBytes(),
        harfBuzzMemory: hbMemory?.buffer.byteLength ?? null,
      });
    if (url.pathname === "/noop")
      return Response.json({
        engineMemory: module.memoryBytes(),
        harfBuzzMemory: hbMemory?.buffer.byteLength ?? null,
      });
    if (url.pathname !== "/export") return new Response("not found", { status: 404 });
    const width = Number(url.searchParams.get("width") ?? 1024);
    const height = Number(url.searchParams.get("height") ?? 1024);
    const cards = Number(url.searchParams.get("cards") ?? 100);
    const seed = Number(url.searchParams.get("seed") ?? 0);
    const doc = new Doc();
    doc.apply(scene(cards, seed));
    const builder = new DisplayListBuilder(new Scene(doc), measurer);
    const list = builder.build("P");
    // A fresh engine per render, as decision 0033 gives every render a fresh instance's worth of
    // state (one module instance per isolate: its memory is the cap, reused).
    // The Worker build's budgets (WORKER_LIMITS) apply: the shipped module's memory is capped at
    // 25 MiB, and an export is admitted against it before it starts.
    const engine = new RenderEngine(module, { glyphMaskBytes: 4 << 20 });
    const applied = engine.apply(list);
    if (!applied.ok) {
      engine.dispose();
      return Response.json(
        { error: applied.message, code: applied.code },
        { status: applied.code === ErrorCode.Limit ? 413 : 500 },
      );
    }
    // The scene fills the frame: cards at the scale that makes the grid as wide as the output.
    const cols = Math.ceil(Math.sqrt(cards));
    const zoom = width / (cols * 260);
    // The engine goes however the stream ends: read to the end, failed or cancelled.
    const stream = engine.renderPngStream(
      width,
      height,
      { zoom, x: 0, y: 0, dpr: 1 },
      [1, 1, 1, 1],
      undefined,
      () => engine.dispose(),
    );
    const report = {
      width,
      height,
      cards,
      records: builder.stats.records,
      listBytes: list.length,
      glyphs: engine.glyphs,
      unsupported: builder.unsupported.size,
    };
    if (!stream.ok) {
      engine.dispose();
      return Response.json(
        { ...report, error: stream.message, code: stream.code },
        { status: 400 },
      );
    }
    // Streamed: each band is drawn and compressed as the response is read. The engine's and
    // HarfBuzz's memory are reported at the end, in a trailer request (`/memory`).
    return new Response(stream.value, {
      headers: { "content-type": "image/png", "x-engine-report": JSON.stringify(report) },
    });
  }
}
