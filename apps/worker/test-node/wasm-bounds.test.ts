/**
 * WebAssembly bounds (decision 0033, item 4.2), on #173's second review's
 * cases. resvg and HarfBuzz grow their own linear memory, which no meter in
 * JavaScript sees and which never shrinks, so each runs with a `maximum`
 * written into its module (`@drawpane/raster/wasm-limits`). Past it, a call
 * must fail cleanly, as the tool's failure, and the next call must work and
 * give the right answer:
 *
 * - resvg draws each picture in an instance of its own, since a trap leaves
 *   an instance unusable and what it held unfreed;
 * - harfbuzzjs (patched) throws when `malloc` answers 0, instead of copying
 *   a font file to address 0, after which text already loaded measured 0
 *   wide with no error.
 *
 * Run with the memory check (`pnpm --filter @drawpane/worker memory`).
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHeadlessRenderer,
  type FaceFileLoader,
  PICTURE_OUT_OF_MEMORY,
  ToolFailure,
} from "@drawpane/editor";
import { checkNode, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { nodeRasteriser } from "@drawpane/raster/node";
import {
  HARFBUZZ_MAX_BYTES,
  memoryLimits,
  RESVG_MAX_BYTES,
  withMemoryMaximum,
} from "@drawpane/raster/wasm-limits";
import { afterAll, describe, expect, it } from "vitest";
import { harfBuzzMeasurerWith } from "../src/agent/harfbuzz-measurer";
import { STANDIN } from "../src/agent/measurer";
import { AgentEngine, TEXT_OUT_OF_MEMORY } from "../src/rooms/agent-engine";
import { insertNodes } from "../src/rooms/node-tables";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { sqlDouble } from "./doubles";

const require = createRequire(import.meta.url);
const dir = join(tmpdir(), `drawpane-wasm-bounds-${process.pid}`);
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const INTER = readFileSync(new URL("../../web/e2e/fixtures/Inter-Variable.ttf", import.meta.url));

/** A room's rows: page P, and `nodes`. */
function room(name: string, nodes: NodeRecord[]) {
  const r = sqlDouble(join(dir, `${name}.sqlite`), () => {});
  r.sql.exec(NODE_SCHEMA);
  insertNodes(r.sql, "nodes", [
    { id: "P", parent: ROOT_ID, key: "a0", type: "page", props: {} } as NodeRecord,
    ...nodes.map(checkNode),
  ]);
  return r;
}

/** The headless editor over a room's rows, as the room builds it. */
function editorOf(engine: AgentEngine, r: ReturnType<typeof room>) {
  const store = new SqlNodeStore(r.sql);
  return engine.editorAt(1, store.count(), () => store.records(), "materialized");
}

describe("the WebAssembly modules", () => {
  it("are capped as the Worker bundles them, and the caps fit in a Worker with the editor", () => {
    const resvg = new Uint8Array(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
    const hb = new Uint8Array(readFileSync(require.resolve("harfbuzzjs/dist/harfbuzz.wasm")));
    // As shipped: resvg may grow to 4 GiB, HarfBuzz to 2 GiB.
    expect(memoryLimits(resvg)?.max).toBeUndefined();
    expect(memoryLimits(hb)?.max).toBe(32_768);
    expect(memoryLimits(withMemoryMaximum(resvg, RESVG_MAX_BYTES))).toEqual({
      min: memoryLimits(resvg)?.min,
      max: RESVG_MAX_BYTES / 65_536,
    });
    expect(memoryLimits(withMemoryMaximum(hb, HARFBUZZ_MAX_BYTES))?.max).toBe(
      HARFBUZZ_MAX_BYTES / 65_536,
    );
    // Decision 0033, answer 2: a 17 MB baseline, the editor's 48 MiB, and both caps, under 128 MB.
    expect(17e6 + (48 << 20) + RESVG_MAX_BYTES + HARFBUZZ_MAX_BYTES).toBeLessThan(128e6);
  });
});

describe("resvg-nested: 20 nested 2048 px frames at 90% opacity", () => {
  it("fails export_image cleanly, and draws a small layer right after", async () => {
    // Uncapped, resvg grew to 666.6 MiB at scale 1 and 375.4 MiB at the default (review 2).
    const nodes: NodeRecord[] = [
      {
        id: "F",
        parent: "P",
        key: "a0",
        type: "frame",
        props: { width: 2048, height: 2048, clipContent: true },
      },
      // Smaller, but not tiny: about 10 MiB to draw, which a reused instance no longer has.
      {
        id: "S",
        parent: "P",
        key: "a1",
        type: "frame",
        props: { x: 3000, width: 1024, height: 512, fills: [{ type: "solid", color: "#0000ff" }] },
      },
      {
        id: "S1",
        parent: "S",
        key: "a0",
        type: "rect",
        props: {
          width: 512,
          height: 512,
          opacity: 0.5,
          fills: [{ type: "solid", color: "#ff0000" }],
        },
      },
    ];
    let parent = "F";
    for (let i = 0; i < 20; i++) {
      nodes.push({
        id: `G${i}`,
        parent,
        key: "a0",
        type: "frame",
        props: {
          width: 2048,
          height: 2048,
          opacity: 0.9,
          fills: [{ type: "solid", color: "#ff0000" }],
        },
      } as NodeRecord);
      parent = `G${i}`;
    }
    const r = room("resvg-nested", nodes);
    const engine = new AgentEngine(STANDIN);
    const editor = editorOf(engine, r);
    const rasteriser = await nodeRasteriser();
    const renderer = createHeadlessRenderer({
      measurer: STANDIN,
      fonts: async () => null,
      images: async () => null,
      rasteriser,
    });
    const services = {
      renderPng: (id: string, options: object) => renderer.renderPng(editor.doc, id, options),
    };
    for (const input of [{ id: "F", scale: 1 }, { id: "F" }]) {
      const failed = engine.run(editor, "export_image", input, services);
      await expect(failed).rejects.toBeInstanceOf(ToolFailure);
      await expect(failed).rejects.toThrow(PICTURE_OUT_OF_MEMORY);
    }
    // The next picture is drawn in a fresh instance: right, and at its size.
    const small = await engine.run(
      editorOf(engine, r),
      "export_image",
      { id: "S", scale: 1 },
      services,
    );
    expect(small.result.data).toMatchObject({ width: 1024, height: 512 });
    const px = rasteriser.pixels(
      `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#00ff00"/></svg>`,
      { scale: 1, fonts: [] },
    );
    expect([...px.data.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
    r.close();
  });
});

describe("font-faces: 800 texts in Inter at weights 100 to 899", () => {
  /** HarfBuzz from its module with the cap, as the Worker instantiates it; its memory, to watch. */
  async function cappedHarfBuzz() {
    let memory: WebAssembly.Memory | null = null;
    const bytes = withMemoryMaximum(
      new Uint8Array(readFileSync(require.resolve("harfbuzzjs/dist/harfbuzz.wasm"))),
      HARFBUZZ_MAX_BYTES,
    );
    (globalThis as { __drawpaneHarfBuzz?: unknown }).__drawpaneHarfBuzz = {
      instantiateWasm(
        imports: WebAssembly.Imports,
        done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
      ) {
        void WebAssembly.instantiate(bytes, imports).then(({ instance, module }) => {
          memory = instance.exports.memory as WebAssembly.Memory;
          done(instance, module);
        });
        return {};
      },
    };
    const hb = await import("harfbuzzjs");
    return { hb, used: () => memory?.buffer.byteLength ?? 0 };
  }

  const texts = (): NodeRecord[] =>
    Array.from({ length: 800 }, (_, i) => ({
      id: `T${100 + i}`,
      parent: "P",
      key: "a0",
      type: "text",
      props: { characters: "Hello", fontFamily: "Inter", fontWeight: 100 + i },
    })) as NodeRecord[];

  // One HarfBuzz for the file (harfbuzzjs is one instance per isolate): the cases run in order.
  const harfBuzz = cappedHarfBuzz();
  const inter = INTER.buffer.slice(INTER.byteOffset, INTER.byteOffset + INTER.byteLength);

  it("shares one face for the file the loader keeps, and loads all 800 well inside the cap", async () => {
    // Uncapped and unshared, HarfBuzz grew to 172.3 MiB before a tool ran (review 2).
    const { hb, used } = await harfBuzz;
    const loader: FaceFileLoader = async (face) =>
      face.family === "Inter" ? { bytes: inter, weight: face.weight } : null;
    const measurer = harfBuzzMeasurerWith(loader, async () => hb);
    const r = room("font-faces-shared", texts());
    const engine = new AgentEngine(measurer);
    await engine.load(engine.missingFaces(editorOf(engine, r)));
    expect(used()).toBeLessThan(HARFBUZZ_MAX_BYTES / 2);
    expect(measurer.width("400 16px Inter", "Hamburgefonstiv")).toBeGreaterThan(100);
    r.close();
  });

  it("fails cleanly when the faces don't fit, and text loaded before still measures right", async () => {
    // A loader that hands out a copy per face (one without a cache) gets no sharing: each
    // weight copies the file in again, until HarfBuzz's memory is full.
    const { hb, used } = await harfBuzz;
    const loader: FaceFileLoader = async (face) =>
      face.family === "Inter" ? { bytes: inter.slice(0), weight: face.weight } : null;
    const measurer = harfBuzzMeasurerWith(loader, async () => hb);
    await measurer.load([{ family: "Inter", weight: 400, italic: false }]);
    const before = measurer.width("400 16px Inter", "Hamburgefonstiv");
    expect(before).toBeGreaterThan(100);

    const r = room("font-faces", texts());
    const engine = new AgentEngine(measurer);
    const failed = await engine.load(engine.missingFaces(editorOf(engine, r))).then(
      () => null,
      (error: unknown) => error,
    );
    expect(used()).toBeLessThanOrEqual(HARFBUZZ_MAX_BYTES);

    // Measured again in the face loaded before, at a size not measured yet (no cache): it
    // still measures as it did. Without the check on `malloc`, a font file was copied over
    // the start of memory, and this measured 0.
    expect(measurer.width("400 32px Inter", "Hamburgefonstiv")).toBeCloseTo(2 * before, 3);
    expect(measurer.width("400 16px Inter", "Hamburgefonstiv fonts")).toBeGreaterThan(before);
    // And the load failed as the tool's failure, saying why.
    expect(failed).toBeInstanceOf(ToolFailure);
    expect((failed as Error).message).toBe(TEXT_OUT_OF_MEMORY);
    r.close();
  });
});
