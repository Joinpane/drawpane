/**
 * Converting a 500,000-layer file stored materialized to compact copies
 * (decision 0029, phase 4b), as a room does: in steps of about two seconds,
 * an instance at a time, then applied in one storage transaction. Run in
 * Node against node:sqlite with the V8 heap capped, as memory.test.ts runs
 * the other server paths (`pnpm --filter @drawpane/worker memory`;
 * MEMORY_HEAP_MB=64 for the lower cap, MEMORY_NODES for another size).
 *
 * The file is kit-shaped and materialized as rooms stored files before
 * 4b: 160 icons of three paths; 40 buttons, each a background, a label and
 * an icon instance (its paths copied in); and pages of screens made of
 * button instances, every copy layer stored and `mirrors`-linked, a tenth
 * with their label overridden and a fifteenth with their background's.
 */
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { keyBetween, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyConversion,
  convertStep,
  createConvertTables,
  LIVE_CONVERSION,
  MAX_INSTANCE_LAYERS,
} from "../src/rooms/convert";
import { countRows, insertNodes } from "../src/rooms/node-tables";
import { NODE_SCHEMA } from "../src/rooms/sql-store";
import { sqlDouble } from "./doubles";

const NODES = Number(process.env.MEMORY_NODES ?? 500_000);
const ICONS = 160;
const BUTTONS = 40;
/** A button instance: its root and six copy layers. */
const PER_INSTANCE = 7;
const PER_SCREEN = 20;
const PAGES = 10;
const INSTANCES = Math.round(NODES / PER_INSTANCE);
const SCREENS = Math.ceil(INSTANCES / PER_SCREEN);
const MB = 1024 * 1024;

const KEYS: string[] = [];
for (
  let i = 0, key: string | null = null;
  i < Math.max(ICONS, BUTTONS, SCREENS, PER_SCREEN) + 4;
  i++
) {
  key = keyBetween(key, null);
  KEYS.push(key);
}
const key = (i: number) => KEYS[i] as string;

/** Path data of about 200 characters, the same for a given seed. */
function pathData(seed: number): string {
  let s = "M0 0";
  let a = seed * 2654435761;
  while (s.length < 200) {
    a = (a * 1103515245 + 12345) >>> 0;
    s += ` L${a % 1000} ${(a >>> 10) % 1000}`;
  }
  return s;
}

const iconPath = (k: number, m: number) => ({
  name: `Path ${m}`,
  x: 2,
  y: 2,
  width: 20,
  height: 20,
  pathData: pathData(k * 3 + m),
});
const bg = (j: number) => ({
  name: "Background",
  width: 120,
  height: 40,
  fills: [{ type: "solid", color: `#${(j * 4099).toString(16).padStart(6, "0").slice(0, 6)}` }],
});
const label = (j: number) => ({ name: "Label", characters: `Button ${j}`, fontSize: 14 });
const iconOf = (j: number) => (j * 7) % ICONS;
const nested = (j: number) => ({
  name: `Icon ${iconOf(j)}`,
  instanceOf: `I${iconOf(j)}`,
  width: 24,
  height: 24,
});
const button = (j: number) => ({
  name: `Button ${j}`,
  width: 120,
  height: 40,
  layoutMode: "row",
  gap: 8,
});

/** The file, a batch of nodes at a time. */
function* file(): Generator<NodeRecord[]> {
  const lib: NodeRecord[] = [
    { id: "Lib", type: "page", parent: ROOT_ID, key: key(0), props: { name: "Library" } },
  ];
  for (let k = 0; k < ICONS; k++) {
    lib.push({
      id: `I${k}`,
      type: "frame",
      parent: "Lib",
      key: key(k),
      props: { name: `Icon ${k}`, isComponent: true, x: k * 30, width: 24, height: 24 },
    });
    for (let m = 0; m < 3; m++)
      lib.push({
        id: `I${k}p${m}`,
        type: "path",
        parent: `I${k}`,
        key: key(m),
        props: iconPath(k, m),
      });
  }
  for (let j = 0; j < BUTTONS; j++) {
    const k = iconOf(j);
    lib.push(
      {
        id: `B${j}`,
        type: "frame",
        parent: "Lib",
        key: key(ICONS + j),
        props: { ...button(j), isComponent: true, y: 100 + j * 50 } as NodeRecord["props"],
      },
      {
        id: `B${j}r`,
        type: "rect",
        parent: `B${j}`,
        key: key(0),
        props: bg(j) as NodeRecord["props"],
      },
      { id: `B${j}t`, type: "text", parent: `B${j}`, key: key(1), props: label(j) },
      { id: `B${j}n`, type: "frame", parent: `B${j}`, key: key(2), props: nested(j) },
    );
    for (let m = 0; m < 3; m++)
      lib.push({
        id: `B${j}n${m}`,
        type: "path",
        parent: `B${j}n`,
        key: key(m),
        props: { ...iconPath(k, m), mirrors: `I${k}p${m}` },
      });
  }
  yield lib;
  for (let p = 0; p < PAGES; p++)
    yield [
      {
        id: `S${p}`,
        type: "page",
        parent: ROOT_ID,
        key: key(p + 1),
        props: { name: `Screens ${p}` },
      },
    ];
  for (let s = 0; s < SCREENS; s++) {
    const screen = `F${s}`;
    const batch: NodeRecord[] = [
      {
        id: screen,
        type: "frame",
        parent: `S${s % PAGES}`,
        key: key(Math.floor(s / PAGES)),
        props: { name: `Screen ${s}`, x: s * 400, width: 375, height: 812 },
      },
    ];
    for (let i = 0; i < PER_SCREEN; i++) {
      const n = s * PER_SCREEN + i;
      if (n >= INSTANCES) break;
      const j = n % BUTTONS;
      const k = iconOf(j);
      const root = `R${n}`;
      const text =
        n % 10 === 0 ? { ...label(j), characters: `Go ${n}`, overrides: ["characters"] } : label(j);
      const fill =
        n % 15 === 0
          ? { ...bg(j), fills: [{ type: "solid", color: "#ff0000" }], overrides: ["fills"] }
          : bg(j);
      batch.push(
        {
          id: root,
          type: "frame",
          parent: screen,
          key: key(i),
          props: { ...button(j), instanceOf: `B${j}`, x: 10, y: i * 44 } as NodeRecord["props"],
        },
        {
          id: `${root}r`,
          type: "rect",
          parent: root,
          key: key(0),
          props: { ...fill, mirrors: `B${j}r` } as NodeRecord["props"],
        },
        {
          id: `${root}t`,
          type: "text",
          parent: root,
          key: key(1),
          props: { ...text, mirrors: `B${j}t` },
        },
        {
          id: `${root}n`,
          type: "frame",
          parent: root,
          key: key(2),
          props: { ...nested(j), mirrors: `B${j}n` },
        },
      );
      for (let m = 0; m < 3; m++)
        batch.push({
          id: `${root}n${m}`,
          type: "path",
          parent: `${root}n`,
          key: key(m),
          props: { ...iconPath(k, m), mirrors: `B${j}n${m}` },
        });
    }
    yield batch;
  }
}

let peakHeap = 0;
let calls = 0;
const sample = () => {
  const heap = getHeapStatistics().used_heap_size;
  if (heap > peakHeap) peakHeap = heap;
};
const probe = () => {
  if (++calls % 16 === 0) sample();
};
const gc = () => (globalThis as { gc?: () => void }).gc?.();

const dir = join(tmpdir(), `drawpane-convert-memory-${process.pid}`);
mkdirSync(dir, { recursive: true });
const room = sqlDouble(join(dir, "room.sqlite"), probe);
const REPORT = process.env.MEMORY_REPORT ?? join(tmpdir(), "drawpane-memory-report.md");

afterAll(() => {
  room.close();
  rmSync(dir, { recursive: true, force: true });
});

describe(`converting a file of about ${NODES.toLocaleString("en")} layers`, {
  timeout: 3_600_000,
}, () => {
  it("converts in steps, then applies it, within the capped heap", () => {
    room.sql.exec(NODE_SCHEMA);
    let total = 0;
    for (const batch of file()) {
      room.transact(() => insertNodes(room.sql, "nodes", batch));
      total += batch.length;
    }
    expect(countRows(room.sql, "nodes")).toBe(total);
    createConvertTables(room.sql, LIVE_CONVERSION);

    gc();
    gc();
    const baseline = getHeapStatistics().used_heap_size;
    peakHeap = baseline;
    const started = performance.now();
    let steps = 0;
    let longest = 0;
    let detached = 0;
    for (;;) {
      const at = performance.now();
      // Bounded by the work it does (rows read and written), as in the room.
      const step = convertStep(room, "nodes", LIVE_CONVERSION);
      longest = Math.max(longest, performance.now() - at);
      steps++;
      detached += step.detached;
      sample();
      if (step.done) break;
    }
    const converting = (performance.now() - started) / 1000;
    const applyAt = performance.now();
    const applied = room.transact(() => applyConversion(room.sql, "nodes", LIVE_CONVERSION));
    const applying = (performance.now() - applyAt) / 1000;
    sample();

    const stored = countRows(room.sql, "nodes");
    const records = room.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM nodes WHERE type = 'override'")
      .one().n;
    // Every overridden label and background is a record; nothing else differs.
    const expectedRecords = Math.ceil(INSTANCES / 10) + Math.ceil(INSTANCES / 15);
    expect(detached).toBe(0);
    expect(applied.detached).toEqual([]);
    expect(records).toBe(expectedRecords);
    expect(stored).toBe(total - INSTANCES * 6 - BUTTONS * 3 + records);
    const line =
      `Convert ${total.toLocaleString("en")} layers (${INSTANCES.toLocaleString("en")} instances) to compact copies ` +
      `(heap capped at ${process.env.MEMORY_HEAP_MB ?? 128} MB): ${steps} steps in ${converting.toFixed(1)} s ` +
      `(longest ${(longest / 1000).toFixed(1)} s), applied in ${applying.toFixed(1)} s; ` +
      `${stored.toLocaleString("en")} nodes stored after (${records.toLocaleString("en")} records); ` +
      `peak heap ${(peakHeap / MB).toFixed(0)} MB (${(baseline / MB).toFixed(0)} MB before).`;
    console.log(line);
    appendFileSync(REPORT, `${line}\n`);
  });
});

/**
 * A main as large as an instance may be to convert (just under
 * MAX_INSTANCE_LAYERS layers: groups of rectangles), and three materialized
 * instances of it: each is held whole while it converts.
 */
const GROUPS = 100;
const PER_GROUP = Math.floor((MAX_INSTANCE_LAYERS - GROUPS - 100) / GROUPS);
function* bigFile(): Generator<NodeRecord[]> {
  const rect = (g: number, r: number) => ({
    x: r * 3,
    y: g * 3,
    width: 2,
    height: 2,
    name: `Cell ${g}.${r}`,
    fills: [
      { type: "solid", color: `#${((g * 7919 + r) % 0xffffff).toString(16).padStart(6, "0")}` },
    ],
  });
  const tree = (
    rootId: string,
    parent: string,
    k: string,
    root: Record<string, unknown>,
    copy: boolean,
  ) => {
    const out: NodeRecord[] = [
      { id: rootId, type: "frame", parent, key: k, props: root as NodeRecord["props"] },
    ];
    for (let g = 0; g < GROUPS; g++) {
      out.push({
        id: `${rootId}g${g}`,
        type: "frame",
        parent: rootId,
        key: key(g),
        props: {
          name: `Row ${g}`,
          width: 600,
          height: 3,
          ...(copy ? { mirrors: `Bigg${g}` } : {}),
        },
      });
      for (let r = 0; r < PER_GROUP; r++)
        out.push({
          id: `${rootId}g${g}r${r}`,
          type: "rect",
          parent: `${rootId}g${g}`,
          key: keyBetween(null, null) + r.toString(36).padStart(3, "0"),
          props: {
            ...rect(g, r),
            ...(copy ? { mirrors: `Bigg${g}r${r}` } : {}),
          } as NodeRecord["props"],
        });
    }
    return out;
  };
  yield [{ id: "P", type: "page", parent: ROOT_ID, key: key(0), props: { name: "Page" } }];
  yield tree(
    "Big",
    "P",
    key(0),
    { name: "Big", isComponent: true, width: 600, height: 300 },
    false,
  );
  for (let i = 0; i < 3; i++)
    yield tree(
      `I${i}`,
      "P",
      key(i + 1),
      { name: "Big", width: 600, height: 300, instanceOf: "Big", y: 400 * (i + 1) },
      true,
    );
}

describe(`converting instances of ${MAX_INSTANCE_LAYERS.toLocaleString("en")} layers`, {
  timeout: 3_600_000,
}, () => {
  it("converts each in a step of its own, within the capped heap", () => {
    const big = sqlDouble(join(dir, "big.sqlite"), probe);
    try {
      big.sql.exec(NODE_SCHEMA);
      let total = 0;
      for (const batch of bigFile()) {
        for (let i = 0; i < batch.length; i += 5_000)
          big.transact(() => insertNodes(big.sql, "nodes", batch.slice(i, i + 5_000)));
        total += batch.length;
      }
      createConvertTables(big.sql, LIVE_CONVERSION);
      gc();
      gc();
      const baseline = getHeapStatistics().used_heap_size;
      peakHeap = baseline;
      let steps = 0;
      let longest = 0;
      let detached = 0;
      const started = performance.now();
      for (;;) {
        const at = performance.now();
        const step = convertStep(big, "nodes", LIVE_CONVERSION);
        longest = Math.max(longest, performance.now() - at);
        steps++;
        detached += step.detached;
        sample();
        gc();
        if (step.done) break;
      }
      const converting = (performance.now() - started) / 1000;
      big.transact(() => applyConversion(big.sql, "nodes", LIVE_CONVERSION));
      sample();
      expect(detached).toBe(0);
      expect(countRows(big.sql, "nodes")).toBe(total - 3 * (GROUPS + GROUPS * PER_GROUP));
      const line =
        `Convert 3 instances of ${(GROUPS + GROUPS * PER_GROUP + 1).toLocaleString("en")} layers (${total.toLocaleString("en")} in all) ` +
        `(heap capped at ${process.env.MEMORY_HEAP_MB ?? 128} MB): ${steps} steps in ${converting.toFixed(1)} s ` +
        `(longest ${(longest / 1000).toFixed(1)} s); peak heap ${(peakHeap / MB).toFixed(0)} MB (${(baseline / MB).toFixed(0)} MB before).`;
      console.log(line);
      appendFileSync(REPORT, `${line}\n`);
    } finally {
      big.close();
    }
  });
});
