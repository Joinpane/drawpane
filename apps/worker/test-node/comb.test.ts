/**
 * A deep file with wide levels (decision 0026), in the memory check: a
 * component whose first child keeps going down, 126 levels, with 999 text
 * siblings of 1,200 characters at every level, 126,002 layers in all. A
 * depth-first walk suspends one page of children per level on its way
 * down; if a suspended page kept its rows, the walk would hold nearly the
 * whole file (a second review measured 362 MB hashing it). Hashing the
 * component and an MCP search over every layer each run with the heap
 * capped (128 MB, or MEMORY_HEAP_MB), and report their peaks.
 *
 *   pnpm --filter @drawpane/worker memory
 *   MEMORY_HEAP_MB=64 pnpm --filter @drawpane/worker memory
 *
 * The report is printed and written to COMB_REPORT (a file in the temp
 * folder unless set).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { assetHash, libraryAssets, type NodeRecord, nodeReader, ROOT_ID } from "@drawpane/model";
import { afterAll, describe, expect, it } from "vitest";
import { findNodes, SqlFileDoc } from "../src/mcp/document";
import { insertNodes, TableReader } from "../src/rooms/node-tables";
import { NODE_SCHEMA } from "../src/rooms/sql-store";
import { sqlDouble } from "./doubles";

const LEVELS = 126;
const WIDTH = 1000;
const TEXT = 1200;
const MB = 1024 * 1024;

let peak = 0;
let calls = 0;
const probe = () => {
  if (++calls % 8 === 0) peak = Math.max(peak, getHeapStatistics().used_heap_size);
};
const gc = () => (globalThis as { gc?: () => void }).gc?.();

const dir = join(tmpdir(), `drawpane-comb-${process.pid}`);
mkdirSync(dir, { recursive: true });
const room = sqlDouble(join(dir, "comb.sqlite"), probe);
room.sql.exec(NODE_SCHEMA);

/** Level `level`'s children: the group the walk goes down into first, then text siblings. */
function level(level: number): NodeRecord[] {
  const parent = level === 0 ? "M1" : `G${level - 1}`;
  return Array.from({ length: WIDTH }, (_, i) =>
    i === 0 && level < LEVELS - 1
      ? { id: `G${level}`, type: "group", parent, key: "a0", props: {} }
      : {
          id: `T${level}_${i}`,
          type: "text",
          parent,
          key: "a1",
          props: { characters: "x".repeat(TEXT) },
        },
  );
}

insertNodes(room.sql, "nodes", [
  { id: "P1", parent: ROOT_ID, type: "page", key: "a0", props: {} },
  { id: "M1", parent: "P1", type: "frame", key: "a0", props: { isComponent: true, name: "Comb" } },
]);
for (let l = 0; l < LEVELS; l++) room.transact(() => insertNodes(room.sql, "nodes", level(l)));
const TOTAL = 2 + LEVELS * WIDTH;

const report: string[] = [];
const REPORT = process.env.COMB_REPORT ?? join(tmpdir(), "drawpane-comb-report.md");
afterAll(() => {
  const text = [
    `A comb of ${TOTAL.toLocaleString("en")} layers, 128 levels deep (Node ${process.version}, V8 heap capped at ${process.env.MEMORY_HEAP_MB ?? 128} MB):`,
    "",
    ...report,
  ].join("\n");
  console.log(text);
  writeFileSync(REPORT, `${text}\n`);
  room.close();
  rmSync(dir, { recursive: true, force: true });
});

async function measured<T>(path: string, run: () => T): Promise<T> {
  gc();
  gc();
  const before = getHeapStatistics().used_heap_size;
  peak = before;
  const started = performance.now();
  const result = run();
  peak = Math.max(peak, getHeapStatistics().used_heap_size);
  report.push(
    `- ${path}: ${((performance.now() - started) / 1000).toFixed(1)} s, peak heap ${(peak / MB).toFixed(0)} MB (${(before / MB).toFixed(0)} MB before)`,
  );
  return result;
}

describe("a deep file with wide levels", { timeout: 3_600_000 }, () => {
  it("hashes a component holding all of it", async () => {
    const hash = await measured("Hash the component", () =>
      assetHash(new TableReader(room.sql, "nodes"), "M1"),
    );
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    const assets = await measured("Library manifest", () =>
      libraryAssets(new TableReader(room.sql, "nodes")),
    );
    expect(assets).toEqual([{ id: "M1", name: "Comb", description: "", set: false, hash }]);
  });

  it("searches every layer for MCP", async () => {
    const found = await measured("MCP find_nodes (every layer)", () =>
      findNodes(new SqlFileDoc(new TableReader(room.sql, "nodes")), "not-found", undefined, 10),
    );
    expect(found).toMatchObject({ total: 0 });
  });

  it("searches a chain of nodes with large properties, holding one at a time", async () => {
    // A third review's shape: 126 frames, each inside the last, each with 12,000 variant
    // properties of 64 characters (about 1 MB a frame). A walk that kept every frame on its
    // way down would hold all of them.
    const chain = sqlDouble(join(dir, "chain.sqlite"), probe);
    chain.sql.exec(NODE_SCHEMA);
    insertNodes(chain.sql, "nodes", [
      { id: "P1", parent: ROOT_ID, type: "page", key: "a0", props: {} },
    ]);
    const value = "v".repeat(64);
    for (let i = 0; i < 126; i++) {
      const variantProps: Record<string, string> = {};
      for (let k = 0; k < 12_000; k++) variantProps[`p${k}`] = value;
      chain.transact(() =>
        insertNodes(chain.sql, "nodes", [
          {
            id: `F${i}`,
            type: "frame",
            parent: i === 0 ? "P1" : `F${i - 1}`,
            key: "a0",
            props: { variantProps },
          },
        ]),
      );
    }
    const found = await measured("MCP find_nodes (a chain of 1 MB frames)", () =>
      findNodes(new SqlFileDoc(new TableReader(chain.sql, "nodes")), "not-found", undefined, 10),
    );
    expect(found).toMatchObject({ total: 0 });
    chain.close();
  });

  it("hashes it as the in-memory reader does, on a smaller comb", () => {
    // The same shape, 20 levels of 50: small enough to read whole.
    const small = sqlDouble(join(dir, "small.sqlite"), () => {});
    small.sql.exec(NODE_SCHEMA);
    const nodes: NodeRecord[] = [
      { id: "P1", parent: ROOT_ID, type: "page", key: "a0", props: {} },
      { id: "M1", parent: "P1", type: "frame", key: "a0", props: { isComponent: true } },
    ];
    for (let l = 0; l < 20; l++)
      for (let i = 0; i < 50; i++)
        nodes.push(
          i === 0 && l < 19
            ? {
                id: `G${l}`,
                type: "group",
                parent: l === 0 ? "M1" : `G${l - 1}`,
                key: "a0",
                props: {},
              }
            : {
                id: `T${l}_${i}`,
                type: "text",
                parent: l === 0 ? "M1" : `G${l - 1}`,
                key: "a1",
                props: { characters: `${l} ${i}` },
              },
        );
    insertNodes(small.sql, "nodes", nodes);
    // A cache of 30 rows, so most visits read their row again.
    const reader = new TableReader(small.sql, "nodes", 30);
    expect(assetHash(reader, "M1")).toBe(assetHash(nodeReader(nodes), "M1"));
    small.close();
  });
});
