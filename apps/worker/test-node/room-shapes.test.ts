/**
 * The room's compact-copies paths (decision 0029) on the shapes that grow
 * without end, with the V8 heap capped as a Durable Object's is (the memory
 * check: `pnpm --filter @drawpane/worker memory`, MEMORY_HEAP_MB=64 for the
 * lower cap). Out of memory, a Durable Object aborts and no handler runs, so
 * every path must hold what it needs whatever the file's shape:
 *
 * - very wide: 700,000 instances of one main (marking them for converting
 *   again, forgetting them when they're gone, checking a main's removal,
 *   gathering them when the main is made one again, counting what they
 *   present, sending the file to a tab from before compact copies);
 * - very deep: layers 3,000 levels down, and mains nested 300 deep;
 * - very large rows: a main of 400 texts of 200,000 CJK characters (600 KB
 *   each, stored) with an instance of it.
 *
 * The sixth review's three aborts are here: marking the wide fan dirty, the
 * removal check's discovery of it, and the old-client snapshot of the large
 * rows. Each aborted at 128 MB before its fix.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import {
  BuildTooLarge,
  copyId,
  ModelError,
  type NodeRecord,
  type Op,
  ROOT_ID,
} from "@drawpane/model";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyConversion,
  clearStrayCandidates,
  createConvertTables,
  LIVE_CONVERSION,
  markDirty,
  noteStrayCandidates,
  presentedCount,
  readyToApply,
  strayCandidate,
} from "../src/rooms/convert";
import { MainRemoval } from "../src/rooms/main-removal";
import { insertNodes, TableReader } from "../src/rooms/node-tables";
import { PresentedReader, reloadPlaceholder, sendPresented } from "../src/rooms/presented";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { sqlDouble } from "./doubles";

const MB = 1024 * 1024;
const HEAP_MB = Number(process.env.MEMORY_HEAP_MB ?? 128);
const WIDE = 700_000;

let peakHeap = 0;
let calls = 0;
const probe = () => {
  if (++calls % 4 !== 0) return;
  const heap = getHeapStatistics().used_heap_size;
  if (heap > peakHeap) peakHeap = heap;
};
const gc = () => (globalThis as { gc?: () => void }).gc?.();

const dir = join(tmpdir(), `drawpane-room-shapes-${process.pid}`);
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let rooms = 0;
function room(nodes: readonly NodeRecord[]) {
  const r = sqlDouble(join(dir, `r${rooms++}.sqlite`), probe);
  r.sql.exec(NODE_SCHEMA);
  insertNodes(r.sql, "nodes", nodes);
  return r;
}

function measured<T>(fn: () => T): { result: T; peak: number } {
  gc();
  peakHeap = getHeapStatistics().used_heap_size;
  const result = fn();
  probe();
  return { result, peak: peakHeap };
}

const report = (what: string, peak: number) => {
  console.log(`${what}: peak heap ${(peak / MB).toFixed(1)} MB (cap ${HEAP_MB} MB)`);
  expect(peak).toBeLessThan(HEAP_MB * MB);
};

const page = (id: string, key = "a0"): NodeRecord => ({
  id,
  type: "page",
  parent: ROOT_ID,
  key,
  props: {},
});
const frame = (id: string, parent: string, key: string, props: NodeRecord["props"]) =>
  ({ id, type: "frame", parent, key, props }) as NodeRecord;

/** A page `P` with a main `M` (empty, or holding `R`) and `WIDE` instances of it, `I1`..., made in SQL. */
function wide(withLayer = false) {
  const r = room([page("P"), frame("M", "P", "a0", { isComponent: true, name: "Card" })]);
  if (withLayer)
    insertNodes(r.sql, "nodes", [
      { id: "R", type: "rect", parent: "M", key: "a0", props: { width: 10 } },
    ]);
  r.transact(() =>
    r.sql.exec(
      `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ${WIDE})
       INSERT INTO nodes SELECT 'I' || x, 'P', 'a1', 'frame', '{"instanceOf":"M"}' FROM n`,
    ),
  );
  return r;
}

/** As a conversion would have left the wide file: every instance settled, built from `M`. */
function settled(r: ReturnType<typeof room>) {
  createConvertTables(r.sql, LIVE_CONVERSION);
  r.transact(() => {
    r.sql.exec(
      `INSERT INTO conv_done SELECT id, 'converted', NULL, 0 FROM nodes WHERE parent = 'P' AND id != 'M'`,
    );
    r.sql.exec("INSERT INTO conv_deps SELECT 'M', root FROM conv_done");
    r.sql.exec(
      "INSERT INTO conv_roots SELECT root, ROW_NUMBER() OVER (ORDER BY root) FROM conv_done",
    );
  });
}

/** The main `M` of 400 texts of 200,000 CJK characters, and an instance `I` of it. */
function largeRows() {
  const r = room([
    page("P"),
    frame("M", "P", "a0", { isComponent: true }),
    frame("I", "P", "a1", { instanceOf: "M" }),
  ]);
  const text = JSON.stringify({ characters: "界".repeat(200_000) });
  r.transact(() => {
    for (let i = 0; i < 400; i++)
      r.sql.exec(
        "INSERT INTO nodes (id, parent, key, type, props) VALUES (?, 'M', 'a0', 'text', ?)",
        `T${i}`,
        text,
      );
  });
  return r;
}

/**
 * A chain of `depth` frames on a page, a main at the bottom holding a text,
 * and an instance of it at the bottom of another chain as deep.
 */
function deep(depth: number) {
  const nodes: NodeRecord[] = [page("P")];
  for (const side of ["A", "B"])
    for (let i = 0; i < depth; i++)
      nodes.push(
        frame(`${side}${i}`, i === 0 ? "P" : `${side}${i - 1}`, side === "A" ? "a0" : "a1", {}),
      );
  nodes.push(frame("M", `A${depth - 1}`, "a0", { isComponent: true, name: "Deep" }));
  nodes.push({ id: "T", type: "text", parent: "M", key: "a0", props: { characters: "deep" } });
  nodes.push(frame("I", `B${depth - 1}`, "a0", { instanceOf: "M" }));
  return room(nodes);
}

const refusal = (fn: () => void): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ModelError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return "taken";
};

describe(`700,000 instances of one main (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  it("marks every converted instance of an edited main for converting again, in SQL", () => {
    // The sixth review's: the instances were read into memory with `.toArray()` and kept in a Set.
    const r = wide();
    settled(r);
    insertNodes(r.sql, "nodes", [frame("Last", "P", "a2", { instanceOf: "M" })]);
    const { result, peak } = measured(() =>
      r.transact(() => markDirty(r.sql, "nodes", LIVE_CONVERSION, ["M"])),
    );
    report("marking 700,000 instances dirty", peak);
    expect(result).toBe(WIDE);
    expect(r.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM conv_done").one().n).toBe(0);
    expect(r.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM conv_deps").one().n).toBe(0);
    r.close();
  });

  it("forgets what was decided for 700,000 instances deleted since, in SQL", () => {
    const r = wide();
    settled(r);
    r.transact(() => r.sql.exec("DELETE FROM nodes WHERE parent = 'P' AND id != 'M'"));
    const { result, peak } = measured(() =>
      r.transact(() => readyToApply(r.sql, "nodes", LIVE_CONVERSION)),
    );
    report("forgetting 700,000 deleted instances", peak);
    expect(result).toBe(true);
    expect(r.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM conv_done").one().n).toBe(0);
    r.close();
  });

  it("refuses removing their main as too many to check, before building any", () => {
    // The sixth review's: every instance was listed, and a map built of them, before any limit.
    const r = wide();
    const store = new SqlNodeStore(r.sql);
    const { result, peak } = measured(() =>
      refusal(() => r.transact(() => new MainRemoval(r.sql, store).lookFirst(["M"]))),
    );
    report("removing a main of 700,000 instances", peak);
    expect(result).toMatch(/^conflict: Removing the component “Card” needs Drawpane to check/);
    expect(result).toMatch(/too many to check at once/);
    r.close();
  });

  it("skips its instances when the page they're on goes with the main, in SQL", () => {
    const r = wide();
    const store = new SqlNodeStore(r.sql);
    const ops: Op[] = [{ op: "delete", id: "P" }];
    const { result, peak } = measured(() =>
      refusal(() =>
        r.transact(() => {
          const removal = new MainRemoval(r.sql, store);
          removal.lookFirst([], new Set(), ops);
          return removal;
        }),
      ),
    );
    report("looking at a main deleted with its 700,000 instances", peak);
    expect(result).toBe("taken");
    r.close();
  });

  it("gathers every instance of a main made one again, and checks them, in SQL", () => {
    const r = wide();
    const { result, peak } = measured(() =>
      r.transact(() => {
        clearStrayCandidates(r.sql);
        noteStrayCandidates(r.sql, [{ op: "set", id: "M", prop: "isComponent", value: true }]);
        const gathered = r.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM stray_check").one().n;
        return { gathered, stray: strayCandidate(r.sql) };
      }),
    );
    report("checking 700,000 instances for stored layers", peak);
    expect(result).toEqual({ gathered: WIDE, stray: false });
    r.close();
  });

  it("counts what they present, a page of mains at a time", () => {
    const r = wide(true);
    const { result, peak } = measured(() => presentedCount(r.sql));
    report("counting 700,000 instances as presented", peak);
    // Every stored node, and the rectangle each instance presents.
    expect(result).toBe(WIDE + 3 + WIDE);
    r.close();
  });

  it("applies a conversion that detached all of them, counting rather than listing", () => {
    const r = wide();
    createConvertTables(r.sql, LIVE_CONVERSION);
    r.transact(() =>
      r.sql.exec(
        `INSERT INTO conv_done SELECT id, 'detached', 'its layers aren''t its main''s', 0
           FROM nodes WHERE parent = 'P' AND id != 'M'`,
      ),
    );
    const { result, peak } = measured(() =>
      r.transact(() => applyConversion(r.sql, "nodes", LIVE_CONVERSION)),
    );
    report("applying 700,000 detached instances", peak);
    expect(result.detached).toBe(WIDE);
    r.close();
  });

  it("sends a tab from before compact copies a page saying to reload", () => {
    const r = wide(true);
    const sent: Array<{ nodes: NodeRecord[]; done: boolean }> = [];
    const { result, peak } = measured(() =>
      sendPresented(r.sql, (nodes, done) => sent.push({ nodes, done })),
    );
    report("the old-client snapshot of 700,000 instances", peak);
    expect(result).toBe("placeholder");
    expect(sent).toEqual([{ nodes: reloadPlaceholder(), done: true }]);
    r.close();
  });
});

describe(`a main of 400 texts of 200,000 characters (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  it("sends a tab from before compact copies a page saying to reload", () => {
    // The sixth review's: 2,000 presented nodes were gathered with no bound on their bytes.
    const r = largeRows();
    const sent: Array<{ nodes: NodeRecord[]; done: boolean }> = [];
    const { result, peak } = measured(() =>
      sendPresented(r.sql, (nodes, done) => sent.push({ nodes, done })),
    );
    report("the old-client snapshot of 240 MB of text", peak);
    expect(result).toBe("placeholder");
    expect(sent).toHaveLength(1);
    r.close();
  });

  it("refuses removing the main as too large to check, before reading the texts", () => {
    const r = largeRows();
    const store = new SqlNodeStore(r.sql);
    const { result, peak } = measured(() =>
      refusal(() => r.transact(() => new MainRemoval(r.sql, store).lookFirst(["M"]))),
    );
    report("removing a main of 240 MB of text", peak);
    expect(result).toMatch(/^conflict: .*too large to check/);
    r.close();
  });

  it("reads a copy of a text through the MCP reader, holding the rows a few at a time", () => {
    // Building the instance reads every text (to find its layers and whether its main contains
    // itself), through the reader's bounded cache; the copy asked for is the one node kept.
    const r = largeRows();
    const reader = new PresentedReader(new TableReader(r.sql, "nodes"), r.sql, "nodes");
    const { result, peak } = measured(() => {
      try {
        const copy = reader.get(copyId("I", ["T0"]));
        return { type: copy?.type, length: String(copy?.props.characters ?? "").length };
      } catch (error) {
        if (error instanceof BuildTooLarge) return { type: "too large", length: 0 };
        throw error;
      }
    });
    report("an MCP read of a copy of 240 MB of text", peak);
    expect(result).toEqual({ type: "text", length: 200_000 });
    r.close();
  });

  it("marks for converting again what an edit to one text changes, and counts it", () => {
    const r = largeRows();
    createConvertTables(r.sql, LIVE_CONVERSION);
    r.sql.exec("INSERT INTO conv_done VALUES ('I', 'converted', NULL, 0)");
    r.sql.exec("INSERT INTO conv_deps VALUES ('M', 'I')");
    const { result, peak } = measured(() => ({
      dirty: r.transact(() => markDirty(r.sql, "nodes", LIVE_CONVERSION, ["T7"])),
      presented: presentedCount(r.sql),
    }));
    report("marking and counting beside 240 MB of text", peak);
    expect(result).toEqual({ dirty: 1, presented: 403 + 400 });
    r.close();
  });
});

describe(`very deep files (heap capped at ${HEAP_MB} MB)`, { timeout: 1_800_000 }, () => {
  it("checks a main 3,000 levels down, its instance as deep, and sends the file as presented", () => {
    const r = deep(3_000);
    const store = new SqlNodeStore(r.sql);
    const sent: NodeRecord[] = [];
    const { result, peak } = measured(() => {
      createConvertTables(r.sql, LIVE_CONVERSION);
      r.sql.exec("INSERT INTO conv_done VALUES ('I', 'converted', NULL, 0)");
      r.sql.exec("INSERT INTO conv_deps VALUES ('M', 'I')");
      const dirty = r.transact(() => markDirty(r.sql, "nodes", LIVE_CONVERSION, ["T"]));
      // Unmaking the main: its instance must keep its look, which it can't without storing it.
      const removal = refusal(() =>
        r.transact(() => {
          const check = new MainRemoval(r.sql, store);
          const ops: Op[] = [{ op: "set", id: "M", prop: "isComponent", value: false }];
          check.lookFirst([], new Set(), ops);
          check.note(ops);
          r.sql.exec("UPDATE nodes SET props = json_remove(props, '$.isComponent') WHERE id = 'M'");
          store.clearCache();
          check.check();
        }),
      );
      const how = sendPresented(r.sql, (nodes) => sent.push(...nodes));
      const reader = new PresentedReader(new TableReader(r.sql, "nodes"), r.sql, "nodes");
      let walked = 0;
      for (const _ of reader.idsUnder("P")) walked++;
      return { dirty, removal: removal.split(":")[0], how, walked };
    });
    report("a file 3,000 levels deep", peak);
    expect(result).toEqual({ dirty: 1, removal: "conflict", how: "presented", walked: 6_004 });
    expect(sent.find((n) => n.id === copyId("I", ["T"]))?.props.characters).toBe("deep");
    r.close();
  });

  it("follows mains nested 300 deep when one at the bottom is removed", () => {
    // M0 holds an instance of M1, which holds one of M2, ... M299 holds a text. Each main has an
    // instance on the page keeping an override record, so every round finds more.
    const nodes: NodeRecord[] = [page("P")];
    const depth = 300;
    for (let i = 0; i < depth; i++) {
      nodes.push(frame(`M${i}`, "P", "a0", { isComponent: true, name: `Level ${i}` }));
      if (i + 1 < depth) nodes.push(frame(`N${i}`, `M${i}`, "a0", { instanceOf: `M${i + 1}` }));
      nodes.push(frame(`J${i}`, "P", "a1", { instanceOf: `M${i}` }));
    }
    nodes.push({
      id: "T",
      type: "text",
      parent: `M${depth - 1}`,
      key: "a0",
      props: { characters: "x" },
    });
    const r = room(nodes);
    const store = new SqlNodeStore(r.sql);
    const { result, peak } = measured(() =>
      refusal(() =>
        r.transact(() => {
          const check = new MainRemoval(r.sql, store);
          check.lookFirst([`M${depth - 1}`]);
          return check;
        }),
      ),
    );
    report("looking at the instances of a main nested 300 deep", peak);
    expect(result).toBe("taken");
    r.close();
  });
});
