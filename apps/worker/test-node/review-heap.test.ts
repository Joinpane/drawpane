/**
 * What the fifth review of compact copies found would run a room out of
 * memory (decision 0029), each reproduced with the V8 heap capped, as the
 * memory check runs (`pnpm --filter @drawpane/worker memory`;
 * MEMORY_HEAP_MB=64 for the lower cap). Before their fixes, each of these
 * aborted Node at 128 MB, which no handler survives, as a Durable Object
 * past its 128 MB doesn't.
 *
 * - Checking a commit for a main containing its own instance read every
 *   layer of the mains it followed, values parsed and cached: a main of
 *   20,000 texts of 8 KB each was 160 MB. It's asked in SQL now, reading
 *   which main each node names and nothing else.
 * - Applying a conversion renamed the ids layers hold reading 500 whole rows
 *   at a time: 500 texts of 200,000 CJK characters (600 KB each, stored)
 *   were 200 MB. Only the rows holding ids are read now, a row at a time,
 *   and only the values holding them.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import {
  applyTransaction,
  copyId,
  type ModelError,
  type NodeRecord,
  ROOT_ID,
} from "@drawpane/model";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyConversion,
  convertStep,
  createConvertTables,
  LIVE_CONVERSION,
} from "../src/rooms/convert";
import { insertNodes } from "../src/rooms/node-tables";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { sqlDouble } from "./doubles";

const MB = 1024 * 1024;
const HEAP_MB = Number(process.env.MEMORY_HEAP_MB ?? 128);

let peakHeap = 0;
let calls = 0;
const probe = () => {
  if (++calls % 4 !== 0) return;
  const heap = getHeapStatistics().used_heap_size;
  if (heap > peakHeap) peakHeap = heap;
};
const gc = () => (globalThis as { gc?: () => void }).gc?.();

const dir = join(tmpdir(), `drawpane-review-heap-${process.pid}`);
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let rooms = 0;
function room(nodes: readonly NodeRecord[]) {
  const r = sqlDouble(join(dir, `r${rooms++}.sqlite`), probe);
  r.sql.exec(NODE_SCHEMA);
  insertNodes(r.sql, "nodes", nodes);
  return r;
}

/** `count` texts under `parent`, ids `prefix`0, 1..., each `props` (its JSON written once, in JS). */
function addTexts(
  sql: SqlStorage,
  parent: string,
  count: number,
  props: Record<string, unknown>,
  prefix = `T${parent}`,
): void {
  const json = JSON.stringify(props);
  for (let i = 0; i < count; i++)
    sql.exec(
      "INSERT INTO nodes (id, parent, key, type, props) VALUES (?, ?, 'a0', 'text', ?)",
      `${prefix}${i}`,
      parent,
      json,
    );
}

const frame = (id: string, parent: string, key: string, props: NodeRecord["props"]) =>
  ({ id, type: "frame", parent, key, props }) as NodeRecord;

function measured<T>(fn: () => T): { result: T; peak: number } {
  gc();
  peakHeap = getHeapStatistics().used_heap_size;
  const result = fn();
  probe();
  return { result, peak: peakHeap };
}

describe(`what the fifth review found (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  it("checks an instance of a main of 20,000 large texts for a loop without reading them", () => {
    const r = room([
      { id: "Pg", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      frame("A", "Pg", "a0", { isComponent: true }),
      frame("B", "Pg", "a1", { isComponent: true }),
    ]);
    addTexts(r.sql, "A", 20_000, { characters: "x".repeat(8192) });
    // And one that loops: C holds an instance of A, which an instance of C in A would close.
    insertNodes(r.sql, "nodes", [
      frame("C", "Pg", "a2", { isComponent: true }),
      frame("CA", "C", "a0", { instanceOf: "A" }),
    ]);
    const store = new SqlNodeStore(r.sql);
    const options = { cycles: true, inverse: false, rollback: false } as const;
    const { peak } = measured(() =>
      r.transact(() => {
        applyTransaction(
          store,
          [
            {
              op: "create",
              id: "I",
              type: "frame",
              parent: "B",
              key: "a0",
              props: { instanceOf: "A" },
            },
          ],
          options,
        );
        store.clearCache();
        let error: unknown;
        try {
          applyTransaction(
            store,
            [
              {
                op: "create",
                id: "L",
                type: "frame",
                parent: "A",
                key: "a5",
                props: { instanceOf: "C" },
              },
            ],
            options,
          );
        } catch (caught) {
          error = caught;
        }
        expect((error as ModelError).code).toBe("cycle");
        store.clearCache();
      }),
    );
    console.log(`loop check over a 160 MB main: peak heap ${(peak / MB).toFixed(1)} MB`);
    expect(r.sql.exec("SELECT parent FROM nodes WHERE id = 'I'").toArray()).toEqual([
      { parent: "B" },
    ]);
    expect(peak).toBeLessThan(HEAP_MB * MB);
    r.close();
  });

  it("applies a conversion beside 500 texts of 200,000 characters, renaming the ids they hold", () => {
    const r = room([
      { id: "Pg", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      frame("M", "Pg", "a0", { isComponent: true }),
      { id: "R", type: "rect", parent: "M", key: "a0", props: { name: "R" } },
      frame("I", "Pg", "a1", { instanceOf: "M" }),
      { id: "C", type: "rect", parent: "I", key: "a0", props: { name: "R", mirrors: "R" } },
    ]);
    const big = "界".repeat(200_000);
    addTexts(r.sql, "Pg", 500, { characters: big, reactions: [] });
    // One that links to the copy: its link follows the copy's new id.
    const link = [{ id: "r1", trigger: { type: "click" }, action: { type: "navigate", to: "C" } }];
    addTexts(r.sql, "Pg", 1, { characters: big, reactions: link }, "Link");
    const { peak } = measured(() => {
      createConvertTables(r.sql, LIVE_CONVERSION);
      for (let i = 0; i < 100; i++) {
        if (!convertStep(r, "nodes", LIVE_CONVERSION).done) continue;
        return r.transact(() => applyConversion(r.sql, "nodes", LIVE_CONVERSION));
      }
      throw new Error("the conversion didn't finish");
    });
    console.log(`applying beside 300 MB of text: peak heap ${(peak / MB).toFixed(1)} MB`);
    expect(peak).toBeLessThan(HEAP_MB * MB);
    const held = r.sql
      .exec<{ to: string; n: number }>(
        `SELECT json_extract(props, '$.reactions[0].action.to') AS "to",
                length(json_extract(props, '$.characters')) AS n
           FROM nodes WHERE id = 'Link0'`,
      )
      .one();
    expect(held).toEqual({ to: copyId("I", ["R"]), n: 200_000 });
    expect(r.sql.exec("SELECT 1 FROM nodes WHERE id = 'C'").toArray()).toHaveLength(0);
    r.close();
  });
});
