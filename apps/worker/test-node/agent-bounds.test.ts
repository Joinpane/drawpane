/**
 * Agent tools on a file of large values, with the V8 heap capped as a
 * Durable Object's is (the memory check: `pnpm --filter @drawpane/worker
 * memory`, MEMORY_HEAP_MB=64 for the lower cap). The headless editor holds
 * the whole file, so a file is admitted by what that would hold, measured
 * in SQL before a row is read (`rooms/agent-admission.ts`).
 *
 * The seventh review of #163 found 401 layers (400 texts of 200,000 CJK
 * characters, 240 MB) admitted by the 50,000-layer limit; an ordinary
 * get_jsx then read every row and aborted at 128 MB. This file loads the
 * editor, so every test here starts from about 32 MB of heap, not 17.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import { afterAll, describe, expect, it } from "vitest";
import { STANDIN } from "../src/agent/measurer";
import { AGENT_LAYER_BYTES, AGENT_MAX_HELD, agentAdmission } from "../src/rooms/agent-admission";
import { AgentEngine } from "../src/rooms/agent-engine";
import { insertNodes } from "../src/rooms/node-tables";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { sqlDouble } from "./doubles";

const MB = 1024 * 1024;
const HEAP_MB = Number(process.env.MEMORY_HEAP_MB ?? 128);

let peakHeap = 0;
let calls = 0;
/** Samples the heap now. */
const sample = () => {
  const heap = getHeapStatistics().used_heap_size;
  if (heap > peakHeap) peakHeap = heap;
};
/** Samples it on every fourth statement. */
const probe = () => {
  if (++calls % 4 === 0) sample();
};
const gc = () => (globalThis as { gc?: () => void }).gc?.();

const dir = join(tmpdir(), `drawpane-agent-bounds-${process.pid}`);
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let rooms = 0;
function room(nodes: readonly NodeRecord[]) {
  const r = sqlDouble(join(dir, `r${rooms++}.sqlite`), probe);
  r.sql.exec(NODE_SCHEMA);
  insertNodes(r.sql, "nodes", nodes);
  return r;
}

async function measured<T>(fn: () => T | Promise<T>): Promise<{ result: T; peak: number }> {
  gc();
  peakHeap = getHeapStatistics().used_heap_size;
  const result = await fn();
  sample();
  return { result, peak: peakHeap };
}

const report = (what: string, peak: number) => {
  console.log(`${what}: peak heap ${(peak / MB).toFixed(1)} MB (cap ${HEAP_MB} MB)`);
  expect(peak).toBeLessThan(HEAP_MB * MB);
};

const page = (): NodeRecord => ({ id: "P", type: "page", parent: ROOT_ID, key: "a0", props: {} });

/** The JSON of a text of 200,000 CJK characters: 600,017 bytes of UTF-8. */
const LARGE_TEXT = JSON.stringify({ characters: "界".repeat(200_000) });
const LARGE_TEXT_BYTES = 600_017;

/** `count` texts of 200,000 CJK characters on page `P`, `T0`... */
function largeTexts(count: number) {
  const r = room([page()]);
  r.transact(() => {
    for (let i = 0; i < count; i++)
      r.sql.exec(
        "INSERT INTO nodes (id, parent, key, type, props) VALUES (?, 'P', 'a0', 'text', ?)",
        `T${i}`,
        LARGE_TEXT,
      );
  });
  return r;
}

/** The room's own reading of the file for the headless editor (`FileRoom.#readAll`). */
function readAll(store: SqlNodeStore): NodeRecord[] {
  const nodes: NodeRecord[] = [];
  for (const rows of store.pages(2_000)) nodes.push(...rows);
  sample();
  return nodes;
}

/**
 * An agent's read as the room runs it: admitted (`#tooLargeForAgents`),
 * then the headless editor built (`#warmEditor`) and the tool run.
 */
async function agentRead(sql: SqlStorage, id: string, depth?: number) {
  const admission = agentAdmission(sql, "materialized", () => 0);
  if (!admission.ok) return { refused: admission.message };
  const store = new SqlNodeStore(sql);
  const engine = new AgentEngine(STANDIN);
  const editor = engine.editorAt(
    1,
    store.count(),
    () => readAll(store),
    "materialized",
    admission.held,
  );
  sample();
  const run = await engine.run(editor, "get_jsx", depth === undefined ? { id } : { id, depth });
  sample();
  engine.drop();
  return { jsx: (run.result.data as { jsx: string }).jsx.length };
}

describe(`agent tools on 400 texts of 200,000 CJK characters (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  it("refuses them in SQL, before reading a row", async () => {
    // 401 layers passed the 50,000-layer limit, then every row was read to build the editor.
    const r = largeTexts(400);
    const { result, peak } = await measured(() => agentRead(r.sql, "T0"));
    report("an agent's get_jsx on 240 MB of text", peak);
    expect(result).toEqual({
      refused: expect.stringMatching(
        /^This file is too large for agent tools \(editing it would take over \d+ MB of memory, and they work on files of up to 48 MB; long texts take the most\)\. The read tools/,
      ),
    });
    for (const copies of ["materialized", "compact"] as const)
      expect(agentAdmission(r.sql, copies, () => 401).ok).toBe(false);
    r.close();
  });
});

describe(`the largest file of long texts agent tools take (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  // At the 64 MB cap a file at the budget doesn't fit at all: the budget is for a 128 MB room.
  it.skipIf(HEAP_MB < 128)("admits it, builds the headless editor and reads it whole", async () => {
    const count = Math.floor(
      (AGENT_MAX_HELD - 2 * AGENT_LAYER_BYTES - 2) / (LARGE_TEXT_BYTES + AGENT_LAYER_BYTES),
    );
    const r = largeTexts(count);
    // In a frame, so get_jsx reads them all (a page isn't a layer).
    r.sql.exec("INSERT INTO nodes VALUES ('F', 'P', 'a1', 'frame', '{}')");
    r.sql.exec("UPDATE nodes SET parent = 'F' WHERE type = 'text'");
    const { result, peak } = await measured(() => agentRead(r.sql, "F", 1));
    report(`the headless editor on ${count} texts of 600 KB, read whole with get_jsx`, peak);
    expect(result).toEqual({ jsx: expect.any(Number) });
    expect((result as { jsx: number }).jsx).toBeGreaterThan(count * 200_000);
    // One more text is past it.
    r.sql.exec(
      "INSERT INTO nodes (id, parent, key, type, props) SELECT 'T-extra', 'F', 'a1', 'text', props FROM nodes WHERE id = 'T0'",
    );
    expect(agentAdmission(r.sql, "materialized", () => 0).ok).toBe(false);
    r.close();
  });
});

describe("the headless editor following edits", () => {
  it("lets go of itself once what it follows takes it past the budget", () => {
    const r = room([page()]);
    const store = new SqlNodeStore(r.sql);
    const engine = new AgentEngine(STANDIN);
    // Each text adds about 0.4 MB (200,000 characters, two bytes each).
    const start = AGENT_MAX_HELD - MB / 2;
    engine.editorAt(1, store.count(), () => readAll(store), "materialized", start);
    expect(engine.heldAt(1)).toBe(start);
    const text = (id: string): Op => ({
      op: "create",
      id,
      parent: "P",
      key: "a0",
      type: "text",
      props: { characters: "界".repeat(200_000) },
    });
    engine.follow([text("A")], 2);
    expect(engine.heldAt(2)).toBeGreaterThan(start + 400_000);
    engine.follow([text("B")], 3);
    expect(engine.heldAt(3)).toBeNull();
    expect(engine.warm).toBe(false);
    r.close();
  });
});
