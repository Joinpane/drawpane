/**
 * Chinese, Japanese and Korean text under the WebAssembly caps (decision
 * 0033, item 4.2): text in every language must measure and render. CJK font
 * files are large (Noto Sans SC's variable file is 17.7 MB) and HarfBuzz
 * needs the whole font. The CPU renderer receives just the shaped outlines.
 *
 * The fonts are Google's own files, as the app loads them: the variable
 * file for measuring and drawing. They're too large to commit, so they're fetched once from Google's
 * font servers and kept in node_modules/.cache/drawpane-fonts.
 *
 * Run with the memory check (`pnpm --filter @drawpane/worker memory`). One
 * HarfBuzz for the file (harfbuzzjs is one instance per isolate), as in a
 * room: the cases run in order, the second drawing while it holds the first's
 * fonts.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FaceFileLoader } from "@drawpane/editor";
import { checkNode, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { HARFBUZZ_MAX_BYTES, withMemoryMaximum } from "@drawpane/raster/wasm-limits";
import { afterAll, describe, expect, it } from "vitest";
import { headlessEngine } from "../../../packages/editor/test/fixtures/engine-raster";
import { enginePngPixel } from "../../../packages/editor/test/fixtures/png";
import { AgentEngine } from "../../agent-runner/src/engine";
import { harfBuzzMeasurerWith } from "../../agent-runner/src/harfbuzz-measurer";
import { insertNodes } from "../src/rooms/node-tables";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { sqlDouble } from "./doubles";

const require = createRequire(import.meta.url);
const dir = join(tmpdir(), `drawpane-wasm-cjk-${process.pid}`);
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MiB = 1 << 20;
const GSTATIC = "https://fonts.gstatic.com/s/";
/** Google's files, from its download manifests (fonts.google.com/download/list), with their sizes. */
const FONTS = {
  scVariable: ["notosanssc/v41/k3kXo84MPvpLmixcA63oeALhKYiJ-Q7m8w.ttf", 17_711_448],
  jpVariable: ["notosansjp/v57/-F62fjtqLzI2JPCgQBnw7HFoxgIO2lZ9hg.ttf", 9_531_420],
} as const;

/** A font file, from the cache or fetched into it; one ArrayBuffer per file, as the loaders keep them. */
const files = new Map<string, Promise<ArrayBuffer>>();
function font(name: keyof typeof FONTS): Promise<ArrayBuffer> {
  let hit = files.get(name);
  if (!hit) {
    hit = (async () => {
      const [path, size] = FONTS[name];
      const cache = new URL("../node_modules/.cache/drawpane-fonts/", import.meta.url);
      const file = new URL(path.replaceAll("/", "_"), cache);
      if (!existsSync(file)) {
        const response = await fetch(`${GSTATIC}${path}`);
        if (!response.ok) throw new Error(`${path}: ${response.status}`);
        mkdirSync(cache, { recursive: true });
        writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
      }
      const bytes = readFileSync(file);
      expect(bytes.length).toBe(size);
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    })();
    files.set(name, hit);
  }
  return hit;
}

const fixture = (name: string) => {
  const bytes = readFileSync(new URL(`../../web/e2e/fixtures/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
const INTER = fixture("Inter-Variable.ttf");
const INSTRUMENT = fixture("InstrumentSans-Variable.ttf");

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

/** As the Worker's loader answers the measurer: each family's variable file, at the weight asked. */
const loader: FaceFileLoader = async (face) => {
  const bytes =
    face.family === "Noto Sans SC"
      ? await font("scVariable")
      : face.family === "Noto Sans JP"
        ? await font("jpVariable")
        : face.family === "Inter"
          ? INTER
          : face.family === "Instrument Sans"
            ? INSTRUMENT
            : null;
  return bytes && { bytes, weight: face.weight };
};

const CHINESE = "设计稿中的中文排版";
const JAPANESE = "日本語の組版テスト";

const text = (id: string, parent: string, key: string, y: number, props: object): NodeRecord =>
  ({
    id,
    parent,
    key,
    type: "text",
    props: { x: 40, y, fontSize: 48, ...props },
  }) as NodeRecord;

/**
 * Frame F: frame G, of text in Noto Sans SC at two weights and Inter at
 * three, and a line in Noto Sans JP below it.
 */
function room() {
  const r = sqlDouble(join(dir, "cjk.sqlite"), () => {});
  r.sql.exec(NODE_SCHEMA);
  insertNodes(r.sql, "nodes", [
    { id: "P", parent: ROOT_ID, key: "a0", type: "page", props: {} } as NodeRecord,
    ...[
      {
        id: "F",
        parent: "P",
        key: "a0",
        type: "frame",
        props: { width: 1200, height: 800, fills: [{ type: "solid", color: "#ffffff" }] },
      } as NodeRecord,
      {
        id: "G",
        parent: "F",
        key: "a0",
        type: "frame",
        props: { width: 1200, height: 600, fills: [{ type: "solid", color: "#ffffff" }] },
      } as NodeRecord,
      text("T1", "G", "a0", 40, { characters: CHINESE, fontFamily: "Noto Sans SC" }),
      text("T2", "G", "a1", 140, {
        characters: CHINESE,
        fontFamily: "Noto Sans SC",
        fontWeight: 700,
      }),
      text("T3", "F", "a1", 640, { characters: JAPANESE, fontFamily: "Noto Sans JP" }),
      ...[400, 500, 700].map((w, i) =>
        text(`L${w}`, "G", `a${2 + i}`, 240 + i * 100, {
          characters: "Hamburgefonstiv",
          fontFamily: "Inter",
          fontWeight: w,
        }),
      ),
    ].map(checkNode),
  ]);
  return r;
}

function editorOf(engine: AgentEngine, r: ReturnType<typeof room>) {
  const store = new SqlNodeStore(r.sql);
  return engine.editorAt(1, store.count(), () => store.records(), "materialized");
}

describe("CJK text under the caps", { timeout: 300_000 }, () => {
  const harfBuzz = cappedHarfBuzz();
  const measurer = harfBuzz.then(({ hb }) => harfBuzzMeasurerWith(loader, async () => hb));
  const r = room();
  afterAll(() => r.close());

  it("measures Noto Sans SC at two weights, with Noto Sans JP and Inter at three, inside HarfBuzz's cap", async () => {
    const { used } = await harfBuzz;
    const m = await measurer;
    const engine = new AgentEngine(m);
    await engine.load(engine.missingFaces(editorOf(engine, r)));
    const held = used();
    console.log(
      `HarfBuzz holds ${(held / MiB).toFixed(2)} MiB of its ${HARFBUZZ_MAX_BYTES / MiB} MiB for SC 400 and 700, JP 400, Inter 400, 500 and 700`,
    );
    expect(held).toBeLessThanOrEqual(HARFBUZZ_MAX_BYTES);
    for (const face of [
      { family: "Noto Sans SC", weight: 400 },
      { family: "Noto Sans SC", weight: 700 },
      { family: "Noto Sans JP", weight: 400 },
    ])
      expect(m.has({ ...face, italic: false })).toBe(true);
    // Every ideograph and kana in Noto Sans CJK is one em wide: measured in the face itself.
    expect(m.width('400 16px "Noto Sans SC"', CHINESE)).toBeCloseTo(16 * CHINESE.length, 3);
    expect(m.width('700 16px "Noto Sans SC"', CHINESE)).toBeCloseTo(16 * CHINESE.length, 3);
    expect(m.width('400 16px "Noto Sans JP"', JAPANESE)).toBeCloseTo(16 * JAPANESE.length, 3);
    // Noto Sans CJK's ascent is 1.16 em; the fallback's (Instrument Sans) isn't.
    expect(m.metrics('400 16px "Noto Sans SC"')?.ascent).toBeCloseTo(16 * 1.16, 2);
    expect(m.width('400 16px "Inter"', "Hamburgefonstiv")).toBeGreaterThan(100);
  });

  it("exports the SC and JP faces through the capped engine while HarfBuzz holds the fonts", async () => {
    const { used } = await harfBuzz;
    const m = await measurer;
    const engine = new AgentEngine(m);
    const editor = editorOf(engine, r);
    await engine.load(engine.missingFaces(editor));
    const renderer = headlessEngine(m, {
      prepareFonts: async (nodes) => m.prepareRenderFonts?.(nodes),
    });
    const services = {
      renderPng: (id: string, options: object) => renderer.renderPng(editor.doc, id, options),
    };
    const { result } = await engine.run(editor, "export_image", { id: "G", scale: 0.5 }, services);
    expect(result.data).toMatchObject({ width: 600, height: 300, scale: 0.5 });
    const png = Uint8Array.from(atob(result.image?.base64 ?? ""), (c) => c.charCodeAt(0));
    const edge = enginePngPixel(png, 550, 20);
    expect(edge).toEqual([255, 255, 255, 255]);
    let hasInk = false;
    for (let y = 23; y < 50 && !hasInk; y += 3) {
      for (let x = 22; x < 40 && !hasInk; x += 3) {
        hasInk = (enginePngPixel(png, x, y)[0] ?? 255) < 128;
      }
    }
    expect(hasInk).toBe(true);
    expect(used()).toBeLessThanOrEqual(HARFBUZZ_MAX_BYTES);
  });

  it("exports a text layer with 1,500 distinct ideographs inside the CPU outline budget", async () => {
    const m = await measurer;
    const engine = new AgentEngine(m);
    const editor = editorOf(engine, r);
    editor.doc.apply([
      {
        op: "create",
        ...text("dense", "P", "a1", 0, {
          characters: Array.from({ length: 1500 }, (_, i) =>
            String.fromCodePoint(0x4e00 + 3 * i),
          ).join(""),
          fontFamily: "Noto Sans SC",
          fontSize: 16,
          width: 1600,
          height: 400,
          textAutoResize: "none",
        }),
      },
    ]);
    const renderer = headlessEngine(m, {
      prepareFonts: async (nodes) => m.prepareRenderFonts?.(nodes),
    });
    const result = await renderer.renderPng(editor.doc, "dense", { scale: 0.5 });
    expect(result).toMatchObject({ width: 800, height: 200, missingFonts: [] });
    expect(result.fallbackText).toBeUndefined();
    expect(result.png.length).toBeGreaterThan(10_000);
  });
});
