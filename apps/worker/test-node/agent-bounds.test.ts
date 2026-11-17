/**
 * Agent tools on files of large values, with the V8 heap capped as a
 * Durable Object's is (the memory check: `pnpm --filter @drawpane/worker
 * memory`, MEMORY_HEAP_MB=64 for the lower cap). The headless editor holds
 * the whole file, so what it keeps is metered as it's built and as it
 * follows changes (`rooms/agent-admission.ts`); the SQL pre-check refuses
 * early what the meter surely would.
 *
 * Each review of #173 that aborted a room is here: 251 ASCII texts, nested
 * fills and deep copies admitted by the estimate and aborting as the editor
 * was built; a warm editor whose copies grew past it; 32 large images
 * drawn for a 4 KB file; a million pages listed whole. This file loads the
 * editor, so every test starts from about 32 MB of heap, not 17.
 *
 * At the 64 MB cap the engine's limit is set at 12 MB: what's tested is
 * that the editor stops at its limit, whatever the limit (48 MB is set for
 * a 128 MB room).
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import {
  createHeadlessRenderer,
  HEADLESS_IMAGE_BYTES,
  imageCost,
  ToolFailure,
} from "@drawpane/editor";
import { applyTransaction, checkNode, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import { afterAll, describe, expect, it } from "vitest";
import { STANDIN } from "../src/agent/measurer";
import { answerDocument, SqlFileDoc } from "../src/mcp/document";
import { AGENT_MAX_HELD, AgentTooLarge, agentPrecheck } from "../src/rooms/agent-admission";
import { AgentEngine } from "../src/rooms/agent-engine";
import { presentedCount } from "../src/rooms/convert";
import { insertNodes, TableReader } from "../src/rooms/node-tables";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { sqlDouble } from "./doubles";

const MB = 1024 * 1024;
const HEAP_MB = Number(process.env.MEMORY_HEAP_MB ?? 128);
/** What the engine may hold here: as a room's, or under a fifth of the lower cap. */
const LIMIT = HEAP_MB < 128 ? 12 * MB : AGENT_MAX_HELD;

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
type Room = ReturnType<typeof room>;

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

/** `count` rows of `type` with `props` (JSON) on page `P`, `N0`... */
function rows(count: number, type: string, props: string): Room {
  const r = room([page()]);
  r.transact(() => {
    for (let i = 0; i < count; i++)
      r.sql.exec(
        "INSERT INTO nodes (id, parent, key, type, props) VALUES (?, 'P', 'a0', ?, ?)",
        `N${i}`,
        type,
        props,
      );
  });
  return r;
}

const texts = (count: number, char: string, length = 200_000) =>
  rows(count, "text", JSON.stringify({ characters: char.repeat(length) }));

/** Samples the heap as each node is read, so a build's peak is seen. */
function* sampled(nodes: Iterable<NodeRecord>): Generator<NodeRecord> {
  let n = 0;
  for (const node of nodes) {
    if (++n % 64 === 0) sample();
    yield node;
  }
  sample();
}

/** The headless editor built as the room builds it (`FileRoom.#warmEditor`). */
function build(engine: AgentEngine, r: Room, copies: "materialized" | "compact", revn = 1) {
  const store = new SqlNodeStore(r.sql);
  return engine.editorAt(revn, store.count(), () => sampled(store.records()), copies);
}

/** Main `M` (`children` rectangles) with `instances` instances on page `P`. */
function copiesOf(children: number, instances: number): NodeRecord[] {
  const nodes: NodeRecord[] = [
    page(),
    { id: "M", parent: "P", key: "a0", type: "frame", props: { isComponent: true } },
  ];
  for (let i = 0; i < children; i++)
    nodes.push({ id: `C${i}`, parent: "M", key: "a0", type: "rect", props: {} });
  for (let i = 0; i < instances; i++)
    nodes.push({ id: `I${i}`, parent: "P", key: "a1", type: "frame", props: { instanceOf: "M" } });
  return nodes;
}

/**
 * An agent's read as the room runs it: pre-checked (`#tooLargeForAgents`),
 * then the headless editor built from pages, metered (`#warmEditor`), and
 * the tool run. A refusal comes back as its message, and what refused it.
 */
async function agentRead(
  r: Room,
  tool: string,
  input: unknown,
  copies: "materialized" | "compact" = "materialized",
  { precheck = true } = {},
) {
  if (precheck) {
    const pre = agentPrecheck(r.sql, copies, () => presentedCount(r.sql), LIMIT);
    if (!pre.ok) return { refused: pre.message, by: "precheck" };
  }
  const engine = new AgentEngine(STANDIN, { limit: LIMIT });
  try {
    const editor = build(engine, r, copies);
    sample();
    const run = await engine.run(editor, tool, input);
    sample();
    return { result: run.result.data };
  } catch (error) {
    if (error instanceof ToolFailure)
      return { refused: error.message, by: error instanceof AgentTooLarge ? "meter" : "tool" };
    throw error;
  } finally {
    engine.drop();
  }
}

const TOO_LARGE = expect.stringMatching(
  /^This file is too large for agent tools \(editing it would take more than the \d+ MB of memory they work in; long texts take the most\)\. The read tools/,
);

describe(`agent tools on files the estimate admitted (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  it("refuses 400 texts of 200,000 CJK characters in SQL, before reading a row", async () => {
    // #163's seventh review: 401 layers passed the 50,000-layer limit, then every row was read.
    const r = texts(400, "界");
    const { result, peak } = await measured(() => agentRead(r, "get_jsx", { id: "N0" }));
    report("an agent's get_jsx on 240 MB of CJK text", peak);
    expect(result).toEqual({ refused: TOO_LARGE, by: "precheck" });
    r.close();
  });

  it("builds 251 texts of 200,000 ASCII characters a page at a time, and refuses more", async () => {
    // #173's review: admitted (50.3 MB estimated), and building the editor aborted, as the
    // whole file was read (2,000 rows a page) and parsed while every row's JSON was held.
    // Read a page of 4 million characters at a time, it fits: the meter counts 47.9 MB.
    const count = Math.floor((LIMIT - 64 * 1024) / 200_300);
    const r = texts(count, "x");
    const built = await measured(() => agentRead(r, "get_jsx", { id: "N0" }));
    report(`building the editor of ${count} ASCII texts and reading one`, built.peak);
    expect(built.result).toEqual({ result: { jsx: expect.any(String) } });
    // Ten more are past the limit: refused in SQL, before a row is read.
    r.transact(() => {
      for (let i = 0; i < 10; i++)
        r.sql.exec(
          "INSERT INTO nodes (id, parent, key, type, props) SELECT ?, 'P', 'a0', 'text', props FROM nodes WHERE id = 'N0'",
          `X${i}`,
        );
    });
    const pre = await measured(() => agentRead(r, "get_jsx", { id: "N0" }));
    report(`the pre-check on ${count + 10} ASCII texts`, pre.peak);
    expect(pre.result).toEqual({ refused: TOO_LARGE, by: "precheck" });
    // Without the pre-check, the meter stops the build at its limit.
    const meter = await measured(() =>
      agentRead(r, "get_jsx", { id: "N0" }, "materialized", { precheck: false }),
    );
    report(`building the editor of ${count + 10} ASCII texts, unchecked`, meter.peak);
    expect(meter.result).toEqual({ refused: TOO_LARGE, by: "meter" });
    r.close();
  });

  it("refuses 1,386 rectangles of 32 gradients of 32 stops as it builds them", async () => {
    // #173's review: 50.3 MB estimated; the parsed objects held far more, and it aborted.
    const fill = {
      type: "linear",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
      stops: Array.from({ length: 32 }, () => ({ position: 0, color: "#000000" })),
    };
    const node = checkNode({
      id: "R",
      parent: "P",
      key: "a0",
      type: "rect",
      props: { fills: Array.from({ length: 32 }, () => fill) },
    } as NodeRecord);
    // 1,386 against 48 MB; as many against the limit here.
    const r = rows(
      Math.round((1_386 * LIMIT) / AGENT_MAX_HELD),
      "rect",
      JSON.stringify(node.props),
    );
    // The SQL pre-check can't tell how many objects there are: it passes, and the meter decides.
    expect(agentPrecheck(r.sql, "materialized", () => 0, LIMIT).ok).toBe(true);
    const { result, peak } = await measured(() => agentRead(r, "get_jsx", { id: "N0" }));
    report("building the editor of 1,386 gradient-filled rectangles", peak);
    expect(result).toEqual({ refused: TOO_LARGE, by: "meter" });
    r.close();
  });

  it("refuses a main 600 frames deep with 80 instances as it builds their copies", async () => {
    // #173's review: 48,682 layers as presented, under the layer limit; the copies' paths
    // (600 deep) held far more than the estimate's 760 bytes a copy, and it aborted.
    const nodes: NodeRecord[] = [
      page(),
      { id: "M", parent: "P", key: "a0", type: "frame", props: { isComponent: true } },
    ];
    for (let i = 0; i < 600; i++)
      nodes.push({
        id: `F${i}`,
        parent: i === 0 ? "M" : `F${i - 1}`,
        key: "a0",
        type: "frame",
        props: {},
      });
    for (let i = 0; i < 80; i++)
      nodes.push({
        id: `I${i}`,
        parent: "P",
        key: "a1",
        type: "frame",
        props: { instanceOf: "M" },
      });
    const r = room(nodes);
    expect(presentedCount(r.sql)).toBeLessThan(50_000);
    expect(agentPrecheck(r.sql, "compact", () => presentedCount(r.sql), LIMIT).ok).toBe(true);
    const { result, peak } = await measured(() =>
      agentRead(r, "get_jsx", { id: "I0", depth: 1 }, "compact"),
    );
    report("building the editor of 80 copies of a main 600 deep", peak);
    expect(result).toEqual({ refused: TOO_LARGE, by: "meter" });
    r.close();
  });
});

describe(`the largest file of long texts agent tools take (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  it("builds the editor at its limit, reads a text whole, and refuses JSX past a read", async () => {
    // As many 200,000-character ASCII texts as the meter takes, in a frame.
    const count = Math.floor((LIMIT - 64 * 1024) / 200_300);
    const r = texts(count, "x");
    r.sql.exec("INSERT INTO nodes VALUES ('F', 'P', 'a1', 'frame', '{}')");
    r.sql.exec("UPDATE nodes SET parent = 'F' WHERE type = 'text'");
    expect(agentPrecheck(r.sql, "materialized", () => 0, LIMIT).ok).toBe(true);
    const engine = new AgentEngine(STANDIN, { limit: LIMIT });
    const { result, peak } = await measured(async () => {
      const editor = build(engine, r, "materialized");
      sample();
      const one = await engine.run(editor, "get_jsx", { id: "N0" });
      sample();
      const all = await engine.run(editor, "get_jsx", { id: "F" }).catch((e: unknown) => e);
      sample();
      return { one: (one.result.data as { jsx: string }).jsx.length, all };
    });
    report(`the headless editor on ${count} texts of 200,000 characters, read with get_jsx`, peak);
    console.log(`  meter: ${((engine.heldAt(1) ?? 0) / MB).toFixed(1)} MB of ${LIMIT / MB} MB`);
    expect(engine.heldAt(1)).toBeGreaterThan(LIMIT * 0.95);
    expect(result.one).toBeGreaterThan(200_000);
    expect(result.all).toBeInstanceOf(ToolFailure);
    expect((result.all as Error).message).toMatch(/more JSX than one read returns/);
    engine.drop();
    // Two more texts are past it: refused as it's built.
    for (const id of ["N-extra", "N-extra2"])
      r.sql.exec(
        "INSERT INTO nodes (id, parent, key, type, props) SELECT ?, 'F', 'a1', 'text', props FROM nodes WHERE id = 'N0'",
        id,
      );
    expect(() => build(engine, r, "materialized")).toThrow(AgentTooLarge);
    r.close();
  });
});

describe(`the headless editor following edits (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  it("counts what it follows as applied, and lets go of itself past its limit", () => {
    const fill = Math.floor((LIMIT - MB) / 400_300);
    const r = texts(fill, "界");
    const engine = new AgentEngine(STANDIN, { limit: LIMIT });
    build(engine, r, "materialized");
    const start = engine.heldAt(1) as number;
    expect(start).toBeGreaterThan(LIMIT - 2 * MB);
    const text = (id: string): Op => ({
      op: "create",
      id,
      parent: "P",
      key: "a0",
      type: "text",
      props: { characters: "界".repeat(200_000) },
    });
    // Each adds 400 KB (200,000 characters, two bytes each), counted as it's applied.
    engine.follow([text("A")], 2);
    expect(engine.heldAt(2)).toBeGreaterThan(start + 400_000);
    // And what's deleted is given back.
    engine.follow([{ op: "delete", id: "A" }], 3);
    expect(engine.heldAt(3)).toBeLessThan(start + 64 * 1024);
    for (let i = 4; engine.warm && i < 20; i++) engine.follow([text(`B${i}`)], i);
    expect(engine.warm).toBe(false);
    r.close();
  });

  it("lets go of a warm editor whose copies a change multiplies past its limit", async () => {
    // #173's review: a main of one child with 1,000 instances, then 80 children added to the
    // main. The editor presented 82,083 layers and stayed warm at its admitted 1.1 MB.
    const r = room(copiesOf(1, 1_000));
    const engine = new AgentEngine(STANDIN, { limit: LIMIT });
    expect(build(engine, r, "compact").doc.size).toBe(1 + 2 + 2 * 1_000);
    const ops: Op[] = Array.from({ length: 80 }, (_, i) => ({
      op: "create",
      id: `N${i}`,
      parent: "M",
      key: "a1",
      type: "rect",
      props: {},
    }));
    insertNodes(
      r.sql,
      "nodes",
      ops.map((op) => {
        const { op: _, ...node } = op as Extract<Op, { op: "create" }>;
        return node as NodeRecord;
      }),
    );
    // Their copies add 80,000 layers: at least 49.3 MB as the meter counts them, just under
    // what the pre-check before applying refuses here, so they're built, and the meter stops
    // the build at its limit. The sample includes what that build let go of (young garbage,
    // collected before V8 would abort); what's held after is what matters.
    gc();
    const before = getHeapStatistics().used_heap_size;
    const { peak } = await measured(() => engine.follow(ops, 2));
    gc();
    const after = getHeapStatistics().used_heap_size;
    console.log(
      `following 80 children added to a main of 1,000 instances: sampled ${(peak / MB).toFixed(1)} MB, held after ${(after / MB).toFixed(1)} MB (cap ${HEAP_MB} MB)`,
    );
    expect(after).toBeLessThan(before + 4 * MB);
    expect(engine.heldAt(2)).toBeNull();
    expect(engine.warm).toBe(false);
    // Asked again, the room refuses it in SQL: 82,083 layers as presented.
    expect(presentedCount(r.sql)).toBe(82_083);
    const pre = agentPrecheck(r.sql, "compact", () => presentedCount(r.sql), LIMIT);
    expect(pre).toEqual({ ok: false, message: expect.stringMatching(/82,083 layers/) });
    // And building it regardless stops at the limit, or at the layer limit.
    expect(() => build(engine, r, "compact", 2)).toThrow(AgentTooLarge);
    r.close();
  });

  it("refuses a tool whose edit multiplies copies past the limit, and lets the editor go", async () => {
    const r = room(copiesOf(1, 1_000));
    const engine = new AgentEngine(STANDIN, { limit: LIMIT });
    const jsx = Array.from({ length: 80 }, () => "<Rect w={4} h={4} />").join("");
    // Its copies are built to the limit and let go of: the sample includes them (young garbage).
    gc();
    const before = getHeapStatistics().used_heap_size;
    const { result, peak } = await measured(() =>
      engine
        .run(build(engine, r, "compact"), "render", { jsx: `<Frame>${jsx}</Frame>`, parentId: "M" })
        .catch((e: unknown) => e),
    );
    gc();
    const after = getHeapStatistics().used_heap_size;
    console.log(
      `a render of 80 layers into a main of 1,000 instances: sampled ${(peak / MB).toFixed(1)} MB, held after ${(after / MB).toFixed(1)} MB (cap ${HEAP_MB} MB)`,
    );
    expect(after).toBeLessThan(before + 4 * MB);
    expect(result).toBeInstanceOf(AgentTooLarge);
    expect(engine.warm).toBe(false);
    r.close();
  });
});

describe(`export_image on a small file of large images (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  it("draws the images past what a render may hold as placeholders, one file at a time", async () => {
    // #173's review: a 100 × 100 rectangle with 32 image fills of 4 MiB files. Every file was
    // read at once and kept as a data: URL, and the room aborted before rasterising.
    const fills = Array.from({ length: 32 }, (_, i) => ({
      type: "image" as const,
      ref: String(i).padStart(64, "0"),
      scaleMode: "fill" as const,
    }));
    const r = room([
      page(),
      checkNode({
        id: "R",
        parent: "P",
        key: "a0",
        type: "rect",
        props: { width: 100, height: 100, fills },
      }),
    ]);
    expect(agentPrecheck(r.sql, "materialized", () => 0, LIMIT).ok).toBe(true);
    const engine = new AgentEngine(STANDIN, { limit: LIMIT });
    const editor = build(engine, r, "materialized");
    let read = 0;
    const renderer = createHeadlessRenderer({
      measurer: STANDIN,
      fonts: async () => null,
      // The review's loader: ignores what it may hold and hands every file over.
      images: async (ref) => {
        read++;
        const bytes = new Uint8Array(4 << 20);
        bytes.set(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
          ),
        );
        bytes[bytes.length - 1] = Number(ref);
        return { bytes, type: "image/png", width: 1, height: 1 };
      },
      rasteriser: { rasterise: () => ({ png: new Uint8Array(), width: 100, height: 100 }) },
    });
    const { result, peak } = await measured(() =>
      engine
        .run(
          editor,
          "export_image",
          { id: "R" },
          { renderPng: (id, options) => renderer.renderPng(editor.doc, id, options) },
        )
        .catch((e: unknown) => e),
    );
    report("export_image of 32 image fills of 4 MiB", peak);
    // Three fit in what a render may hold; the rest are let go of as they're read, and drawn as
    // placeholders the answer lists.
    const fit = Math.floor(HEADLESS_IMAGE_BYTES / imageCost(4 << 20, 1, 1));
    const notes = (result as { result: { data: { approximate: string[] } } }).result.data
      .approximate;
    expect(notes).toEqual([expect.stringContaining(`${32 - fit} image(s) are too large`)]);
    expect(read).toBe(32);
    engine.drop();
    r.close();
  });
});

describe(`get_outline on a million pages (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  it("lists the pages its limit allows, counting the rest in SQL", async () => {
    // #173's review: a legal import of a million pages with 64-character ids. The reader listed
    // every page id before the outline applied its limit, and aborted.
    const r = room([]);
    r.sql.exec(
      "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1000000) INSERT INTO nodes SELECT printf('%064d', n), ?, 'a0', 'page', '{}' FROM seq",
      ROOT_ID,
    );
    const reader = new TableReader(r.sql, "nodes");
    const { result, peak } = await measured(() =>
      answerDocument(new SqlFileDoc(reader), { kind: "outline", depth: 2, limit: 400 }),
    );
    report("get_outline on a million pages", peak);
    const answer = result as { pages: unknown[]; morePages: number };
    expect(answer.pages).toHaveLength(400);
    expect(answer.morePages).toBe(1_000_000 - 400);
    // Every page id, as a walk reads them: a page of ids held at a time.
    const walk = await measured(() => {
      let n = 0;
      for (const _ of reader.pageIds()) n++;
      return n;
    });
    report("walking a million page ids", walk.peak);
    expect(walk.result).toBe(1_000_000);
    // A person deleting a page: the last-page check counts pages in SQL, no further than two.
    // Found re-checking #173's audit: it read every page's id and row (as did the room's check,
    // on every load, that the file has a page).
    const store = new SqlNodeStore(r.sql);
    expect(store.pagesUpTo(1)).toBe(1);
    const deleted = await measured(() =>
      r.transact(() => applyTransaction(store, [{ op: "delete", id: `${"0".repeat(63)}1` }])),
    );
    report("deleting a page of a million", deleted.peak);
    expect(store.pagesUpTo(2_000_000)).toBe(999_999);
    r.close();
  });
});
