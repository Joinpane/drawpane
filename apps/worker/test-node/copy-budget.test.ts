/**
 * Building copies on the server never runs the heap out (decision 0029,
 * the fourth review): conversion and the check of a removed main charge
 * what they build and read to a `BuildBudget` as they go, and stop with a
 * typed error past it, whatever the file's shape. Run in Node with the V8
 * heap capped, as the memory check runs (`pnpm --filter @drawpane/worker
 * memory`; MEMORY_HEAP_MB=64 for the lower cap; COPY_BUDGET_RUNS for how
 * many generated shapes, 150 by default).
 *
 * First the shapes the review reproduced, then generated ones: deep chains
 * of mains, wide fans, instances nested many levels, large overrides,
 * mains containing their own instances, and mixes. Each must finish, or
 * stop with `InstanceTooLarge` (conversion) or a `ModelError` (the check);
 * running out of memory aborts the whole run.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import {
  applyTransaction,
  BuildBudget,
  BuildTooLarge,
  CopyView,
  copyId,
  InstanceTooLarge,
  keyBetween,
  MemoryStore,
  ModelError,
  type NodeRecord,
  type Op,
  OVERRIDE_KEY,
  type Props,
  ROOT_ID,
} from "@drawpane/model";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyConversion,
  BUILD_HELD_BYTES,
  convertStep,
  createConvertTables,
  dropConvertTables,
  LIVE_CONVERSION,
} from "../src/rooms/convert";
import { MainRemoval } from "../src/rooms/main-removal";
import { insertNodes } from "../src/rooms/node-tables";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { sqlDouble } from "./doubles";

const MB = 1024 * 1024;
const HEAP_MB = Number(process.env.MEMORY_HEAP_MB ?? 128);
const RUNS = Number(process.env.COPY_BUDGET_RUNS ?? 150);

let peakHeap = 0;
let calls = 0;
const probe = () => {
  if (++calls % 8 !== 0) return;
  const heap = getHeapStatistics().used_heap_size;
  if (heap > peakHeap) peakHeap = heap;
};
const gc = () => (globalThis as { gc?: () => void }).gc?.();

const dir = join(tmpdir(), `drawpane-copy-budget-${process.pid}`);
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const REPORT = process.env.MEMORY_REPORT ?? join(tmpdir(), "drawpane-memory-report.md");

const KEYS: string[] = [];
for (let i = 0, k: string | null = null; i < 700; i++) {
  k = keyBetween(k, null);
  KEYS.push(k);
}
const key = (i: number) => KEYS[i % KEYS.length] as string;

let rooms = 0;
/** A room's SQLite with `nodes` stored as they are (shapes the model refuses now included). */
function roomWith(nodes: Iterable<NodeRecord>) {
  const room = sqlDouble(join(dir, `r${rooms++}.sqlite`), probe);
  room.sql.exec(NODE_SCHEMA);
  let batch: NodeRecord[] = [];
  for (const node of nodes) {
    batch.push(node);
    if (batch.length >= 50) {
      insertNodes(room.sql, "nodes", batch);
      batch = [];
    }
  }
  insertNodes(room.sql, "nodes", batch);
  return room;
}

type Room = ReturnType<typeof roomWith>;

/** No limit counted in SQL beforehand: the budget alone bounds what's held. */
const NO_PRECOUNT = {
  maxInstanceLayers: Number.POSITIVE_INFINITY,
  maxInstanceBuilt: Number.POSITIVE_INFINITY,
  maxInstanceBytes: Number.POSITIVE_INFINITY,
} as const;

/** Converts the room's file as a room does, in steps; how it ended. */
function convertAll(
  room: Room,
  precount = true,
  heldBytes = BUILD_HELD_BYTES,
): { outcome: "converted" | "stopped"; why?: string; stored?: string } {
  createConvertTables(room.sql, LIVE_CONVERSION);
  try {
    for (let i = 0; i < 20_000; i++) {
      const step = convertStep(
        room,
        "nodes",
        LIVE_CONVERSION,
        undefined,
        precount ? { heldBytes } : { ...NO_PRECOUNT, heldBytes },
      );
      if (!step.done) continue;
      room.transact(() => applyConversion(room.sql, "nodes", LIVE_CONVERSION));
      // What it stores, hashed: a conversion stopped part way and resumed stores the same.
      const hash = createHash("sha256");
      for (const row of room.sql.exec<Record<string, string>>(
        "SELECT id, parent, key, type, props FROM nodes ORDER BY id",
      ))
        hash.update(`${row.id}\t${row.parent}\t${row.key}\t${row.type}\t${row.props}\n`);
      return { outcome: "converted", stored: hash.digest("hex") };
    }
  } catch (error) {
    // The typed stop: the file stays materialized and working.
    if (error instanceof InstanceTooLarge) {
      dropConvertTables(room.sql, LIVE_CONVERSION);
      return { outcome: "stopped", why: error.message };
    }
    throw error;
  }
  throw new Error("the conversion never finished");
}

class Rollback extends Error {}

/**
 * Deletes `mainId` as the room commits an edit to a file stored compact:
 * looks first, applies, checks, inside one storage transaction (rolled
 * back after, whatever happened). How it ended, and what the check held.
 */
function removeMain(
  room: Room,
  mainId: string,
  precount = true,
): { outcome: "taken" | "refused"; message?: string; held: number } {
  const store = new SqlNodeStore(room.sql);
  const ops: Op[] = [{ op: "delete", id: mainId }];
  let removal: MainRemoval | null = null;
  try {
    room.transact(() => {
      removal = new MainRemoval(room.sql, store, { precount });
      removal.lookFirst([], new Set([mainId]), ops);
      removal.note(ops);
      applyTransaction(store, ops, { rollback: false, inverse: false, cycles: false });
      store.clearCache();
      removal.check();
      throw new Rollback();
    });
  } catch (error) {
    const held = (removal as MainRemoval | null)?.peakHeld ?? 0;
    if (error instanceof Rollback) return { outcome: "taken", held };
    if (error instanceof ModelError) return { outcome: "refused", message: error.message, held };
    throw error;
  } finally {
    store.clearCache();
  }
  throw new Error("unreachable");
}

const page = (id = "Pg"): NodeRecord => ({
  id,
  type: "page",
  parent: ROOT_ID,
  key: key(0),
  props: {},
});
const frame = (id: string, parent: string, k: number, props: Props = {}): NodeRecord => ({
  id,
  type: "frame",
  parent,
  key: key(k),
  props,
});

function report(line: string): void {
  console.log(line);
  appendFileSync(REPORT, `${line}\n`);
}

describe(`building copies within a budget (heap capped at ${HEAP_MB} MB)`, {
  timeout: 3_600_000,
}, () => {
  it("refuses removing the outer main of a chain of 400, rather than run out (the review's shape)", () => {
    // M0 holds a rectangle; each Mj holds an instance of Mj-1; Inst is an instance of M400.
    // It presents 401 layers, but building it builds every nested instance on the way.
    const nodes: NodeRecord[] = [page(), frame("M0", "Pg", 0, { isComponent: true })];
    nodes.push({ id: "R", type: "rect", parent: "M0", key: key(0), props: {} });
    for (let j = 1; j <= 400; j++) {
      nodes.push(frame(`M${j}`, "Pg", j, { isComponent: true }));
      nodes.push(frame(`I${j}`, `M${j}`, 0, { instanceOf: `M${j - 1}` }));
    }
    nodes.push(frame("Inst", "Pg", 401, { instanceOf: "M400" }));
    const room = roomWith(nodes);
    gc();
    peakHeap = 0;
    const result = removeMain(room, "M400");
    expect(result.outcome).toBe("refused");
    expect(result.message).toMatch(/too large to check/);
    // The SQL count says 401 layers: it's the budget that stops it, with or without that count.
    expect(removeMain(room, "M400", false).message).toMatch(/too large to check/);
    report(
      `- chain of 400 mains, removing the outer one: refused, too large to check; check held ${(result.held / MB).toFixed(1)} MB (budgeted), peak heap ${(peakHeap / MB).toFixed(0)} MB`,
    );
    // Converted (stored materialized, the instance storing nothing): it stops or detaches, typed.
    for (const precount of [true, false]) {
      const converted = convertAll(roomWith(nodes), precount);
      expect(["converted", "stopped"]).toContain(converted.outcome);
    }
    room.close();
  });

  it("converts a main holding fourteen instances of itself, detaching them (the review's shape)", () => {
    const nodes: NodeRecord[] = [page(), frame("M0", "Pg", 0, { isComponent: true })];
    for (let j = 0; j < 14; j++) nodes.push(frame(`I0x${j}`, "M0", j, { instanceOf: "M0" }));
    nodes.push(frame("Inst", "Pg", 1, { instanceOf: "M0" }));
    gc();
    peakHeap = 0;
    expect(convertAll(roomWith(nodes), false).outcome).toBe("converted");
    const room = roomWith(nodes);
    expect(convertAll(room).outcome).toBe("converted");
    const detached = room.sql
      .exec<{ root: string; why: string }>(
        `SELECT root, why FROM ${LIVE_CONVERSION.done} WHERE status = 'detached'`,
      )
      .toArray();
    expect(detached.length).toBeGreaterThanOrEqual(14);
    report(
      `- a main holding 14 instances of itself: converted, ${detached.length} instances detached; peak heap ${(peakHeap / MB).toFixed(0)} MB`,
    );
    room.close();
  });

  it("checks removing a main of 100 texts whose 40 instances each override about 5 MB (the review's shape)", () => {
    function* nodes(): Generator<NodeRecord> {
      yield page();
      yield frame("Main", "Pg", 0, { isComponent: true });
      for (let t = 0; t < 100; t++)
        yield {
          id: `Text${t}`,
          type: "text",
          parent: "Main",
          key: key(t),
          props: { characters: "source" },
        };
      for (let i = 0; i < 40; i++) {
        const id = `Inst${i}`;
        yield frame(id, "Pg", i + 1, { instanceOf: "Main" });
        for (let t = 0; t < 100; t++)
          yield {
            id: copyId(id, [`Text${t}`]),
            type: "override",
            parent: id,
            key: OVERRIDE_KEY,
            props: {
              path: [`Text${t}`],
              characters: `${i}:${t}:${"x".repeat(50_000)}`,
              overrides: ["characters"],
            } as Props,
          };
      }
    }
    const room = roomWith(nodes());
    gc();
    const baseline = getHeapStatistics().used_heap_size;
    peakHeap = 0;
    // Looked at before the delete applies: each instance read, built and let go of in turn.
    const store = new SqlNodeStore(room.sql);
    const removal = new MainRemoval(room.sql, store);
    removal.lookFirst(["Main"]);
    expect(removal.peakHeld).toBeLessThanOrEqual(BUILD_HELD_BYTES);
    // And the whole removal: the instances would lose their texts, so it's refused.
    const result = removeMain(room, "Main");
    expect(result.outcome).toBe("refused");
    expect(result.message).toMatch(/would change how/);
    report(
      `- removing a main of 100 texts with 40 instances overriding about 5 MB each: refused (the look changes); check held ${(removal.peakHeld / MB).toFixed(1)} MB (budgeted), peak heap ${(peakHeap / MB).toFixed(0)} MB (${(baseline / MB).toFixed(0)} MB before)`,
    );
    room.close();
  });

  /** Removes a main from the shape stored compact, then converts it stored materialized; what happened. */
  function runShape(
    shape: Shape,
    precount: boolean,
  ): { removal: string; held: number; conversion: string } {
    const log = (line: string) => {
      if (process.env.COPY_BUDGET_LOG) appendFileSync(process.env.COPY_BUDGET_LOG, `${line}\n`);
    };
    log(`${JSON.stringify(shape)} precount=${precount}`);
    const compact = roomWith(compactNodes(shape));
    let removed: ReturnType<typeof removeMain>;
    try {
      removed = removeMain(compact, `M${shape.remove % shape.mains}`, precount);
    } finally {
      compact.close();
    }
    log(`  removal ${removed.outcome}, peak heap ${(peakHeap / MB).toFixed(0)} MB`);
    const materialized = roomWith(materializedNodes(shape));
    let converted: ReturnType<typeof convertAll>;
    try {
      // With the budget alone, a small one: steps stop part way, let go and try again afresh.
      converted = convertAll(materialized, precount, precount ? BUILD_HELD_BYTES : 2 * MB);
    } finally {
      materialized.close();
    }
    log(`  conversion ${converted.outcome}, peak heap ${(peakHeap / MB).toFixed(0)} MB`);
    const removal =
      removed.outcome === "taken"
        ? "taken"
        : /too large|too many/.test(removed.message ?? "")
          ? "refused, too large to check"
          : "refused, the look changes";
    const conversion =
      converted.outcome === "converted"
        ? "converted"
        : /MB a conversion holds/.test(converted.why ?? "")
          ? "stopped by the budget"
          : "stopped by a SQL count";
    return { removal, held: removed.held, conversion, stored: converted.stored };
  }

  // One generated shape again, as the log (COPY_BUDGET_LOG) wrote it: COPY_BUDGET_SHAPE='{…}'.
  it.runIf(process.env.COPY_BUDGET_SHAPE)("runs the shape given", () => {
    const shape = JSON.parse(process.env.COPY_BUDGET_SHAPE as string) as Shape;
    for (const precount of [false, true]) {
      gc();
      peakHeap = 0;
      console.log(
        JSON.stringify(runShape(shape, precount)),
        `peak heap ${(peakHeap / MB).toFixed(0)} MB`,
      );
    }
  });

  it(`always finishes or stops typed, over ${RUNS} generated shapes`, () => {
    let worst = 0;
    let worstHeld = 0;
    const outcomes = new Map<string, number>();
    const count = (what: string) => outcomes.set(what, (outcomes.get(what) ?? 0) + 1);
    fc.assert(
      fc.property(shapeArb, (shape) => {
        // With the budget alone (nothing counted in SQL first), then as rooms run.
        const stored: Array<string | undefined> = [];
        for (const precount of [false, true]) {
          gc();
          peakHeap = 0;
          const result = runShape(shape, precount);
          const how = precount ? "" : " (budget alone; 2 MB converting)";
          count(`removal ${result.removal}${how}`);
          count(`conversion ${result.conversion}${how}`);
          expect(result.held).toBeLessThanOrEqual(BUILD_HELD_BYTES);
          worstHeld = Math.max(worstHeld, result.held);
          worst = Math.max(worst, peakHeap);
          stored.push(result.stored);
        }
        // Both converted: the same file, however often the small budget stopped its steps.
        if (stored[0] !== undefined && stored[1] !== undefined) {
          expect(stored[0]).toBe(stored[1]);
          count("stored the same both ways");
        }
      }),
      { numRuns: RUNS, seed: Number(process.env.COPY_BUDGET_SEED ?? 20261116) },
    );
    report(
      `- ${RUNS} generated shapes (chains, fans, nesting, overrides, loops, mixes), each with the budget alone and as rooms run: every one finished or stopped typed (${[
        ...outcomes,
      ]
        .sort()
        .map(([k, n]) => `${k}: ${n}`)
        .join(
          ", ",
        )}); removal checks held at most ${(worstHeld / MB).toFixed(1)} MB (budgeted); peak heap ${(worst / MB).toFixed(0)} MB`,
    );
  });
});

// ---------------------------------------------------------------------------
// Generated shapes

interface Shape {
  readonly kind: "chain" | "fan" | "nest" | "overrides" | "loop" | "mix";
  /** How many mains, M0 … Mn-1. */
  readonly mains: number;
  /** Own layers of each main (rectangles and texts). */
  readonly layers: number;
  /** Instances each main holds, of mains before it (and, in a loop, of itself or after). */
  readonly fan: number;
  /** Characters of each main's texts. */
  readonly text: number;
  /** Instances on the page. */
  readonly placed: number;
  /** Records each placed instance keeps, and the characters each overrides. */
  readonly records: number;
  readonly overrideText: number;
  /** Which main the removal check deletes. */
  readonly remove: number;
  readonly seed: number;
}

const shapeArb: fc.Arbitrary<Shape> = fc
  .record({
    kind: fc.constantFrom("chain", "fan", "nest", "overrides", "loop", "mix"),
    seed: fc.integer({ min: 1, max: 2 ** 30 }),
    remove: fc.nat(1000),
    a: fc.nat(1000),
    b: fc.nat(1000),
    c: fc.nat(1000),
    d: fc.nat(1000),
  })
  .map(({ kind, seed, remove, a, b, c, d }): Shape => {
    const pick = (n: number, lo: number, hi: number) => lo + (n % (hi - lo + 1));
    switch (kind) {
      case "chain":
        return {
          kind,
          seed,
          remove,
          mains: pick(a, 50, 600),
          layers: pick(b, 0, 3),
          fan: 1,
          text: pick(c, 0, 200),
          placed: pick(d, 1, 5),
          records: 0,
          overrideText: 0,
        };
      case "fan":
        return {
          kind,
          seed,
          remove,
          mains: pick(a, 2, 9),
          layers: pick(b, 0, 10),
          fan: pick(c, 2, 14),
          text: pick(d, 0, 2_000),
          placed: pick(a + d, 1, 20),
          records: pick(b, 0, 3),
          overrideText: 1_000,
        };
      case "nest":
        return {
          kind,
          seed,
          remove,
          mains: pick(a, 10, 60),
          layers: pick(b, 1, 12),
          fan: pick(c, 1, 3),
          text: pick(d, 0, 5_000),
          placed: pick(a + c, 1, 30),
          records: pick(b, 0, 5),
          overrideText: pick(d, 0, 20_000),
        };
      case "overrides":
        return {
          kind,
          seed,
          remove,
          mains: pick(a, 1, 4),
          layers: pick(b, 20, 120),
          fan: pick(c, 0, 2),
          text: pick(d, 0, 100),
          placed: pick(a + b, 5, 45),
          records: pick(c + d, 10, 120),
          overrideText: pick(d, 5_000, 120_000),
        };
      case "loop":
        return {
          kind,
          seed,
          remove,
          mains: pick(a, 1, 8),
          layers: pick(b, 0, 6),
          fan: pick(c, 1, 16),
          text: pick(d, 0, 500),
          placed: pick(a + b, 1, 10),
          records: 0,
          overrideText: 0,
        };
      default:
        return {
          kind,
          seed,
          remove,
          mains: pick(a, 3, 80),
          layers: pick(b, 0, 40),
          fan: pick(c, 0, 8),
          text: pick(d, 0, 30_000),
          placed: pick(a + c, 1, 40),
          records: pick(b + d, 0, 40),
          overrideText: pick(c + d, 0, 60_000),
        };
    }
  });

/** A small seeded random source (mulberry32). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The mains and what they hold: their own layers, and instances of others. */
function* mains(shape: Shape): Generator<NodeRecord> {
  const rand = random(shape.seed);
  for (let m = 0; m < shape.mains; m++) {
    const id = `M${m}`;
    yield frame(id, "Pg", m + 1, { isComponent: true, name: id });
    let k = 0;
    for (let l = 0; l < shape.layers; l++)
      yield l % 2 === 0
        ? { id: `${id}L${l}`, type: "rect", parent: id, key: key(k++), props: { width: 10 + l } }
        : {
            id: `${id}L${l}`,
            type: "text",
            parent: id,
            key: key(k++),
            props: { characters: `${id}:${l}:${"t".repeat(shape.text)}` },
          };
    for (let f = 0; f < shape.fan; f++) {
      let of: number;
      if (shape.kind === "chain") of = m - 1;
      else if (shape.kind === "loop") of = Math.floor(rand() * shape.mains);
      else if (shape.kind === "mix" && rand() < 0.05) of = Math.floor(rand() * shape.mains);
      else of = m - 1 - Math.floor(rand() * Math.min(m, 3));
      if (of < 0) continue;
      yield frame(`${id}I${f}`, id, k++, { instanceOf: `M${of}` });
    }
  }
}

/** The file stored compact: mains, and instances on the page keeping override records. */
function* compactNodes(shape: Shape): Generator<NodeRecord> {
  yield page();
  yield* mains(shape);
  const rand = random(shape.seed ^ 0x5bd1e995);
  for (let p = 0; p < shape.placed; p++) {
    const of = shape.mains - 1 - Math.floor(rand() * Math.min(shape.mains, 4));
    const id = `P${p}`;
    yield frame(id, "Pg", shape.mains + 1 + p, { instanceOf: `M${of}`, x: p * 10 });
    // Records on the main's own texts (its first level, paths of one element).
    for (let r = 0; r < Math.min(shape.records, shape.layers); r++) {
      const layer = `M${of}L${r}`;
      yield {
        id: copyId(id, [layer]),
        type: "override",
        parent: id,
        key: OVERRIDE_KEY,
        props: (r % 2 === 1
          ? {
              path: [layer],
              characters: `${p}:${r}:${"o".repeat(shape.overrideText)}`,
              overrides: ["characters"],
            }
          : { path: [layer], opacity: 0.5, overrides: ["opacity"] }) as Props,
      };
    }
  }
}

/**
 * The same file stored materialized, as rooms stored files before compact
 * copies: when it presents few enough layers to write out, every copy
 * layer stored. Otherwise the mains are written out (the instances inside
 * them stored as copies) when they present few enough, and the instances
 * on the page store nothing: building one is large, and conversion finds
 * it doesn't match and detaches it, or stops, typed. Failing that, nothing
 * is written out.
 */
function* materializedNodes(shape: Shape): Generator<NodeRecord> {
  const all = [...compactNodes(shape)];
  const whole = presentedAtMost(all, 5_000) ? written(all) : null;
  if (whole) {
    yield* whole.filter((n) => n.type !== "override");
    return;
  }
  const placed = (n: NodeRecord) => n.parent === "Pg" && n.type === "frame" && n.id.startsWith("P");
  const mainsOnly = all.filter((n) => n.type !== "override" && !placed(n));
  const mains = presentedAtMost(mainsOnly, 30_000) ? written(mainsOnly) : null;
  if (mains) {
    yield* mains;
    for (const node of all) if (placed(node)) yield node;
    return;
  }
  for (const node of all) if (node.type !== "override") yield node;
}

/**
 * Every copy layer of `nodes` built and written out (as `expand` does),
 * within a budget of its own; null when building them would hold more
 * (a deep chain builds its nested mains' copies over and over).
 */
function written(nodes: readonly NodeRecord[]): NodeRecord[] | null {
  const view = new CopyView(new MemoryStore(nodes), {
    budget: new BuildBudget({ bytes: 16 * MB }),
  });
  try {
    return [...view.nodes()];
  } catch (error) {
    if (error instanceof BuildTooLarge) return null;
    throw error;
  }
}

/** Whether the stored file presents at most `limit` layers (counted, not built; a loop counts as too many). */
function presentedAtMost(nodes: readonly NodeRecord[], limit: number): boolean {
  const children = new Map<string, NodeRecord[]>();
  for (const node of nodes) {
    const list = children.get(node.parent);
    if (list) list.push(node);
    else children.set(node.parent, [node]);
  }
  const memo = new Map<string, number>();
  const under = (id: string, path: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (path.has(id)) return Number.POSITIVE_INFINITY;
    path.add(id);
    let n = 0;
    for (const child of children.get(id) ?? []) {
      if (child.type === "override") continue;
      const of = child.props.instanceOf;
      n += 1 + (typeof of === "string" ? under(of, path) : under(child.id, path));
      if (n > limit) break;
    }
    path.delete(id);
    memo.set(id, n);
    return n;
  };
  return under(ROOT_ID, new Set()) <= limit;
}
