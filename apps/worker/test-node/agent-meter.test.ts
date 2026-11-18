/**
 * The headless editor's meter (rooms/agent-admission.ts) against what the
 * editor holds, measured: for each shape, the heap the built editor keeps
 * (after collection) is at most what its meter counts. The meter is what
 * bounds the editor, so if it counted less than a shape holds, a file of
 * that shape could pass the limit unseen.
 *
 * Shapes: those the estimate before it missed (#173's review: long ASCII
 * text, nested fills, deep compact copies) and the ordinary ones (short
 * texts, rectangles, CJK and emoji, shallow copies). Run in the memory
 * check (`pnpm --filter @drawpane/worker memory`); sizes are about 20 MB,
 * halved at the 64 MB cap.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { type NodeRecord, ROOT_ID } from "@drawpane/model";
import { afterAll, describe, expect, it } from "vitest";
import { STANDIN } from "../src/agent/measurer";
import { AgentEngine } from "../src/rooms/agent-engine";
import { insertNodes } from "../src/rooms/node-tables";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { sqlDouble } from "./doubles";

const MB = 1024 * 1024;
/** Shapes are halved under the lower heap cap. */
const SCALE = Number(process.env.MEMORY_HEAP_MB ?? 128) < 128 ? 0.5 : 1;
const n = (count: number) => Math.round(count * SCALE);
/**
 * What a heap measurement varies by between runs of the same build (code
 * and feedback V8 makes as it runs, a collection's leftovers): up to about
 * 260 KB here, whatever the shape's size.
 */
const NOISE = 512 * 1024;
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const used = () => {
  gc();
  gc();
  return getHeapStatistics().used_heap_size;
};

const dir = join(tmpdir(), `drawpane-agent-meter-${process.pid}`);
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let rooms = 0;

const page = (): NodeRecord => ({ id: "P", type: "page", parent: ROOT_ID, key: "a0", props: {} });

/** A room holding the page and `rows` rows of (id, parent, type, props JSON). */
function room(rows: Iterable<[string, string, string, string]>, nodes: NodeRecord[] = []) {
  const r = sqlDouble(join(dir, `r${rooms++}.sqlite`), () => {});
  r.sql.exec(NODE_SCHEMA);
  insertNodes(r.sql, "nodes", [page(), ...nodes]);
  r.transact(() => {
    for (const [id, parent, type, props] of rows)
      r.sql.exec("INSERT INTO nodes VALUES (?, ?, 'a0', ?, ?)", id, parent, type, props);
  });
  return r;
}

function* repeat(count: number, type: string, props: unknown) {
  const json = JSON.stringify(props);
  for (let i = 0; i < count; i++)
    yield [`N${i}`, "P", type, json] as [string, string, string, string];
}

const gradient = {
  type: "linear",
  from: { x: 0, y: 0 },
  to: { x: 1, y: 1 },
  stops: Array.from({ length: 32 }, () => ({ position: 0, color: "#000000" })),
};

/** Copies of a main `depth` frames deep, `instances` times. */
function deepCopies(depth: number, instances: number): NodeRecord[] {
  const nodes: NodeRecord[] = [
    { id: "M", parent: "P", key: "a0", type: "frame", props: { isComponent: true } },
  ];
  for (let i = 0; i < depth; i++)
    nodes.push({
      id: `F${i}`,
      parent: i === 0 ? "M" : `F${i - 1}`,
      key: "a0",
      type: "frame",
      props: {},
    });
  for (let i = 0; i < instances; i++)
    nodes.push({ id: `I${i}`, parent: "P", key: "a1", type: "frame", props: { instanceOf: "M" } });
  return nodes;
}

/** A main of `children` rectangles, `instances` times. */
function wideCopies(children: number, instances: number): NodeRecord[] {
  const nodes: NodeRecord[] = [
    { id: "M", parent: "P", key: "a0", type: "frame", props: { isComponent: true } },
  ];
  for (let i = 0; i < children; i++)
    nodes.push({
      id: `C${i}`,
      parent: "M",
      key: "a0",
      type: "rect",
      props: { width: 10, height: 10 },
    });
  for (let i = 0; i < instances; i++)
    nodes.push({ id: `I${i}`, parent: "P", key: "a1", type: "frame", props: { instanceOf: "M" } });
  return nodes;
}

/**
 * Layers as a design kit has them (a 50,000-layer slice of an imported UI
 * kit measured 16 MB of JSON, 35.7 MB held, 41.9 MB metered): frames with
 * auto layout, vector paths with their path data, styled texts, in about
 * the kit's mix (55%, 36%, 9%).
 */
function* kitLike(count: number): Generator<[string, string, string, string]> {
  const frame = (i: number) => ({
    name: `Frame ${i}`,
    x: i % 977,
    y: (i * 7) % 613,
    width: 240.5,
    height: 40,
    fills: [{ type: "solid", color: "#ffffff" }],
    clipContent: true,
    layoutMode: "row",
    paddingTop: 8,
    paddingRight: 12,
    paddingBottom: 8,
    paddingLeft: 12,
    gap: 8,
    justifyContent: "center",
    alignItems: "center",
    sizingH: "hug",
  });
  const path = (i: number) => ({
    name: "Vector",
    x: 0.995,
    y: 2.005,
    width: 10.003,
    height: 19.998,
    constraintH: "scale",
    constraintV: "scale",
    strokes: [{ type: "solid", color: "#171717" }],
    strokeWeight: 1.25,
    strokeAlign: "center",
    strokeJoin: "round",
    strokeCap: "round",
    pathData: Array.from(
      { length: 9 },
      (_, k) => `C${(i % 7) + k}.93 6.615 0.857 5.958 0.869 5.274`,
    ).join(" "),
  });
  const text = (i: number) => ({
    name: `Label ${i}`,
    x: 16,
    y: 16,
    width: 120,
    height: 20,
    characters: `Label number ${i} of the kit`,
    fontFamily: "Inter",
    fontWeight: 500,
    fontStyle: "normal",
    fontSize: 14,
    letterSpacing: { unit: "px", value: 0 },
    lineHeight: { unit: "px", value: 20 },
    fontFeatures: { liga: true, calt: true },
    textAlign: "left",
    textAutoResize: "width-and-height",
    fills: [{ type: "solid", color: "#0a0a0a" }],
  });
  for (let i = 0; i < count; i++) {
    const kind = i % 100 < 55 ? "frame" : i % 100 < 91 ? "path" : "text";
    const props = kind === "frame" ? frame(i) : kind === "path" ? path(i) : text(i);
    yield [`f${100_000 + i}-${i * 37}`, "P", kind, JSON.stringify(props)];
  }
}

/**
 * Layers bound to variables and linked to styles (decision 0034), as an
 * imported kit's are: what the token view indexes and caches resolved.
 */
function tokenNodes(): NodeRecord[] {
  return [
    {
      id: "TC",
      type: "collection",
      parent: ROOT_ID,
      key: "a1",
      props: {
        modes: [
          { id: "light", name: "Light" },
          { id: "dark", name: "Dark" },
        ],
      },
    },
    {
      id: "TV",
      type: "variable",
      parent: "TC",
      key: "a0",
      props: { variableType: "color", values: { light: "#ffffff", dark: "#0a0a0a" } },
    },
    {
      id: "TA",
      type: "variable",
      parent: "TC",
      key: "a1",
      props: { variableType: "color", values: { light: { alias: "TV", opacity: 0.5 } } },
    },
    {
      id: "TN",
      type: "variable",
      parent: "TC",
      key: "a2",
      props: { variableType: "number", values: { light: 8, dark: 12 } },
    },
    {
      id: "TS",
      type: "effectStyle",
      parent: ROOT_ID,
      key: "a2",
      props: {
        effects: [
          {
            type: "drop-shadow",
            x: 0,
            y: 1,
            blur: 2,
            spread: 0,
            color: "#00000040",
            bind: { y: "TN", blur: "TN", color: "TA" },
          },
        ],
      },
    },
  ];
}

/** A kit's bound frame: fill, stroke and shadow through variables and a style, padding and radius bound. */
const boundFrame = (i: number) => ({
  name: `Bound ${i}`,
  width: 240,
  height: 40,
  layoutMode: "row",
  fills: [{ type: "solid", color: "#ffffff", bind: { color: "TV" } }],
  strokes: [{ type: "solid", color: "#e5e5e5", bind: { color: "TA" } }],
  effects: [{ type: "drop-shadow", x: 0, y: 1, blur: 2, spread: 0, color: "#00000040" }],
  effectStyle: "TS",
  bindings: {
    paddingTop: "TN",
    paddingRight: "TN",
    paddingBottom: "TN",
    paddingLeft: "TN",
    gap: "TN",
    cornerRadius: "TN",
  },
});

/** A main of `children` bound rectangles, `instances` times, some in a frame set to Dark. */
function boundCopies(children: number, instances: number): NodeRecord[] {
  const nodes: NodeRecord[] = [
    ...tokenNodes(),
    { id: "M", parent: "P", key: "a0", type: "frame", props: { isComponent: true } },
    { id: "D", parent: "P", key: "a2", type: "frame", props: { variableModes: { TC: "dark" } } },
  ];
  for (let i = 0; i < children; i++)
    nodes.push({
      id: `C${i}`,
      parent: "M",
      key: "a0",
      type: "rect",
      props: boundFrame(i) as never,
    });
  for (let i = 0; i < instances; i++)
    nodes.push({
      id: `I${i}`,
      parent: i % 2 ? "D" : "P",
      key: "a1",
      type: "frame",
      props: { instanceOf: "M" },
    });
  return nodes;
}

const SHAPES: Array<{
  name: string;
  copies: "materialized" | "compact";
  make: () => ReturnType<typeof room>;
}> = [
  {
    name: "long ASCII texts (100 of 200,000)",
    copies: "materialized",
    make: () => room(repeat(n(100), "text", { characters: "x".repeat(200_000) })),
  },
  {
    name: "long CJK texts (50 of 200,000)",
    copies: "materialized",
    make: () => room(repeat(n(50), "text", { characters: "界".repeat(200_000) })),
  },
  {
    name: "long emoji texts (50 of 100,000)",
    copies: "materialized",
    make: () => room(repeat(n(50), "text", { characters: "😀".repeat(100_000) })),
  },
  {
    name: "rectangles with 32 gradients of 32 stops (300)",
    copies: "materialized",
    make: () => room(repeat(n(300), "rect", { fills: Array.from({ length: 32 }, () => gradient) })),
  },
  {
    name: "rectangles (30,000)",
    copies: "materialized",
    make: () =>
      room(
        repeat(n(30_000), "rect", {
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          fills: [{ type: "solid", color: "#ff0000" }],
          name: "Rectangle",
        }),
      ),
  },
  {
    name: "texts of 300 characters (30,000)",
    copies: "materialized",
    make: () => room(repeat(n(30_000), "text", { characters: "x".repeat(300), name: "Text" })),
  },
  {
    name: "kit-like layers (30,000 frames, paths and texts)",
    copies: "materialized",
    make: () => room(kitLike(n(30_000))),
  },
  {
    name: "deep compact copies (a main 200 frames deep, 40 instances)",
    copies: "compact",
    make: () => room([], deepCopies(200, n(40))),
  },
  {
    name: "bound and styled layers (15,000, through variables, aliases and an effect style)",
    copies: "materialized",
    make: () =>
      room(
        (function* () {
          for (let i = 0; i < n(15_000); i++)
            yield [`B${i}`, "P", "frame", JSON.stringify(boundFrame(i))] as [
              string,
              string,
              string,
              string,
            ];
        })(),
        tokenNodes(),
      ),
  },
  {
    name: "bound compact copies (a main of 20 bound frames, 1,000 instances, half in Dark)",
    copies: "compact",
    make: () => room([], boundCopies(20, n(1_000))),
  },
  {
    name: "shallow compact copies (a main of 20 rectangles, 2,000 instances)",
    copies: "compact",
    make: () => room([], wideCopies(20, n(2_000))),
  },
];

describe("the headless editor's meter", { timeout: 600_000 }, () => {
  for (const shape of SHAPES)
    it(`counts at least what it holds: ${shape.name}`, () => {
      const r = shape.make();
      const store = new SqlNodeStore(r.sql);
      const engine = new AgentEngine(STANDIN);
      // The editor's own fixed state, held by a file of one page.
      const empty = room([]);
      const emptyStore = new SqlNodeStore(empty.sql);
      const before0 = used();
      const probe = new AgentEngine(STANDIN);
      probe.editorAt(1, emptyStore.count(), () => emptyStore.records(), shape.copies);
      const fixed = used() - before0;
      probe.drop();
      empty.close();

      const before = used();
      const editor = engine.editorAt(1, store.count(), () => store.records(), shape.copies);
      // What a tool reads (every layer, as presented) is built too.
      engine.missingFaces(editor);
      const held = used() - before;
      const counted = engine.heldAt(1) as number;
      console.log(
        `${shape.name}: holds ${(held / MB).toFixed(2)} MB, meter ${(counted / MB).toFixed(2)} MB (${(counted / held).toFixed(2)}x), fixed ${(fixed / MB).toFixed(2)} MB`,
      );
      expect(counted).toBeGreaterThanOrEqual(held - fixed - NOISE);
      expect(editor.doc.size).toBeGreaterThan(0);
      engine.drop();
      r.close();
    });
});
