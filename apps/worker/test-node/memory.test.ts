/**
 * How much memory each server path takes on a file of 500,000 layers
 * (decision 0026), measured in Node: local workerd doesn't hold a Durable
 * Object to its 128 MB, so the room's code runs here against node:sqlite
 * and a file-backed R2 (doubles.ts). The process's V8 heap is capped at
 * 128 MB (`--max-old-space-size`, vitest.memory.config.ts), so a path that
 * held the file would fail outright; each also reports its peak.
 *
 *   pnpm --filter @drawpane/worker memory               # 500,000 layers
 *   MEMORY_NODES=120000 pnpm --filter @drawpane/worker memory
 *
 * The table is printed and written to MEMORY_REPORT (a file in the temp
 * folder unless set).
 *
 * The file: pages of frames of paths whose data is random digits, about
 * 450 bytes of JSON a layer (the shadcn/ui Pro kit measures 410 to 510).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import {
  applyTransaction,
  keyBetween,
  libraryAssets,
  type NodeRecord,
  NodeRecordSchema,
  type Op,
  ROOT_ID,
} from "@drawpane/model";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { answerDocument, SqlFileDoc } from "../src/mcp/document";
import {
  beginStaging,
  checkStaged,
  fillFromStaged,
  IMPORT_TABLE,
  stageNodes,
} from "../src/rooms/import-stage";
import {
  copyNodes,
  countRows,
  createNodeTable,
  dropTable,
  insertNodes,
  type RoomSql,
  TableReader,
  tablePages,
} from "../src/rooms/node-tables";
import { OpChunks } from "../src/rooms/op-chunks";
import { loadSnapshot, restoreFromTable } from "../src/rooms/restore";
import {
  openSnapshot,
  openSnapshotStream,
  putStream,
  reviewStream,
  snapshotStream,
  writeSnapshot,
} from "../src/rooms/snapshots";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { applyThreeWay, planThreeWay } from "../src/rooms/three-way";
import { r2Double, sqlDouble } from "./doubles";

const NODES = Number(process.env.MEMORY_NODES ?? 500_000);
const PAGES = 10;
const FRAMES = 500;
const LEAVES = Math.max(1, Math.round(NODES / (PAGES * FRAMES)));
const TOTAL = PAGES + PAGES * FRAMES + PAGES * FRAMES * LEAVES;
const PART_BYTES = 4 * 1024 * 1024;
/** The layer a version 1 snapshot changes. */
const MARK = `N5x5x${Math.min(5, LEAVES - 1)}`;
const MB = 1024 * 1024;

const KEYS: string[] = [];
for (let i = 0, key: string | null = null; i < Math.max(FRAMES, LEAVES); i++) {
  key = keyBetween(key, null);
  KEYS.push(key);
}

function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The file, a frame (and its paths) at a time. Every 25th frame is a component. */
function* file(): Generator<NodeRecord[]> {
  const next = random(7);
  const path = () => {
    let s = "M0 0";
    while (s.length < 300) s += ` L${Math.floor(next() * 1e6)} ${Math.floor(next() * 1e6)}`;
    return s;
  };
  for (let p = 0; p < PAGES; p++) {
    yield [
      {
        id: `P${p}`,
        type: "page",
        parent: ROOT_ID,
        key: KEYS[p] as string,
        props: { name: `Page ${p}` },
      },
    ];
    for (let f = 0; f < FRAMES; f++) {
      const frame = `F${p}x${f}`;
      const batch: NodeRecord[] = [
        {
          id: frame,
          type: "frame",
          parent: `P${p}`,
          key: KEYS[f] as string,
          props: {
            name: `Frame ${f}`,
            x: f * 10,
            width: 400,
            height: 300,
            ...(f % 25 === 0 ? { isComponent: true } : {}),
          },
        },
      ];
      for (let l = 0; l < LEAVES; l++)
        batch.push({
          id: `N${p}x${f}x${l}`,
          type: "path",
          parent: frame,
          key: KEYS[l] as string,
          props: { name: `Path ${l}`, x: l, y: l, width: 10, height: 10, pathData: path() },
        });
      yield batch;
    }
  }
}

// ---------------------------------------------------------------------------
// Measuring

let peakHeap = 0;
let peakExternal = 0;
let peakRss = 0;
let calls = 0;
const sample = () => {
  const heap = getHeapStatistics().used_heap_size;
  if (heap > peakHeap) peakHeap = heap;
  const usage = process.memoryUsage();
  if (usage.arrayBuffers > peakExternal) peakExternal = usage.arrayBuffers;
  if (usage.rss > peakRss) peakRss = usage.rss;
};
const probe = () => {
  if (++calls % 16 === 0) sample();
};

interface Row {
  path: string;
  seconds: number;
  heap: number;
  buffers: number;
  rss: number;
  baseline: number;
}
const rows: Row[] = [];
/** Facts noted along the way (bytes sent, snapshot size), for the report. */
const notes: string[] = [];
/** Where the report goes, besides the console. */
const REPORT = process.env.MEMORY_REPORT ?? join(tmpdir(), "drawpane-memory-report.md");

const gc = () => (globalThis as { gc?: () => void }).gc?.();

async function measure(path: string, run: () => Promise<void> | void): Promise<void> {
  gc();
  gc();
  const baseline = getHeapStatistics().used_heap_size;
  peakHeap = baseline;
  peakExternal = process.memoryUsage().arrayBuffers;
  peakRss = process.memoryUsage().rss;
  const started = performance.now();
  await run();
  sample();
  rows.push({
    path,
    seconds: (performance.now() - started) / 1000,
    heap: peakHeap,
    buffers: peakExternal,
    rss: peakRss,
    baseline,
  });
}

// ---------------------------------------------------------------------------

const dir = join(tmpdir(), `drawpane-memory-${process.pid}`);
mkdirSync(dir, { recursive: true });
const room: RoomSql & { close(): void } = sqlDouble(join(dir, "room.sqlite"), probe);
const bucket = r2Double(join(dir, "r2"), probe);
const { sql } = room;
const store = new SqlNodeStore(sql);
sql.exec(NODE_SCHEMA);
sql.exec(`CREATE TABLE log (revn INTEGER PRIMARY KEY, ops TEXT NOT NULL) STRICT`);
let revn = 0;

/** Commits a chunk as the room does (#applyLogged): applied to the store and logged. */
const commit = (ops: Op[]) => {
  applyTransaction(store, ops, { rollback: false, inverse: false });
  sql.exec("INSERT INTO log (revn, ops) VALUES (?, ?)", ++revn, JSON.stringify(ops));
  store.clearCache();
};

/** What the Worker does with a part's body: parse it and check its shape. */
const Part = z.object({ nodes: z.array(NodeRecordSchema) });

const nodeCount = () => countRows(sql, "nodes");
const getNode = (id: string) => {
  const node = store.get(id);
  store.clearCache();
  return node;
};

afterAll(() => {
  const mb = (n: number) => (n / MB).toFixed(0);
  const lines = [
    `Memory on a file of ${TOTAL.toLocaleString("en")} layers (Node ${process.version}, V8 heap capped at ${process.env.MEMORY_HEAP_MB ?? 128} MB):`,
    "",
    "| Path | Time | Peak heap | Heap before | Peak buffers | Peak RSS |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.path} | ${r.seconds.toFixed(1)} s | ${mb(r.heap)} MB | ${mb(r.baseline)} MB | ${mb(r.buffers)} MB | ${mb(r.rss)} MB |`,
    ),
  ];
  lines.push("", ...notes);
  console.log(lines.join("\n"));
  writeFileSync(REPORT, `${lines.join("\n")}\n`);
  room.close();
  rmSync(dir, { recursive: true, force: true });
});

describe(`a file of ${TOTAL.toLocaleString("en")} layers`, { timeout: 3_600_000 }, () => {
  let jsonBytes = 0;

  it("imports in parts: each checked and kept aside, then checked whole and filled in", async () => {
    sql.exec(
      "INSERT INTO nodes (id, parent, key, type, props) VALUES ('Seed', ?, 'a0', 'page', '{}')",
      ROOT_ID,
    );
    await measure("Import, 4 MB parts, check and commit", () => {
      beginStaging(sql);
      let part: NodeRecord[] = [];
      let bytes = 0;
      const send = () => {
        const body = JSON.stringify({ nodes: part });
        jsonBytes += body.length;
        const parsed = Part.parse(JSON.parse(body)).nodes as NodeRecord[];
        stageNodes(room, parsed);
        part = [];
        bytes = 0;
      };
      for (const batch of file())
        for (const node of batch) {
          part.push(node);
          bytes += 460;
          if (bytes >= PART_BYTES) send();
        }
      if (part.length > 0) send();
      checkStaged(sql);
      room.transact(() => fillFromStaged(sql, "Seed"));
      dropTable(sql, IMPORT_TABLE);
    });
    expect(nodeCount()).toBe(TOTAL);
    notes.push(`Imported ${(jsonBytes / MB).toFixed(0)} MB of JSON.`);
  });

  it("saves a version: copied aside, gzipped as a stream, uploaded in parts", async () => {
    await measure("Save a version (multipart R2)", async () => {
      copyNodes(sql, "nodes", "tmp_frozen");
      await writeSnapshot(
        bucket,
        "v1.json.gz",
        { fileId: "F", revn: 1, at: 0 },
        tablePages(sql, "tmp_frozen"),
      );
      dropTable(sql, "tmp_frozen");
    });
    const stored = await bucket.head("v1.json.gz");
    // Past one 8 MiB part, it went up as a multipart upload.
    if (TOTAL > 100_000) expect(stored?.size).toBeGreaterThan(8 * MB);
    notes.push(`Snapshot: ${((stored?.size ?? 0) / MB).toFixed(0)} MB gzipped.`);
  });

  it("restores a version after a page is deleted and layers changed", async () => {
    room.transact(() => {
      store.removeTree("P3");
      for (let f = 0; f < 50; f++) store.setProp(`N0x${f}x0`, "name", "Changed");
    });
    store.clearCache();
    expect(nodeCount()).toBe(TOTAL - 1 - FRAMES - FRAMES * LEAVES);
    let changed = 0;
    await measure("Restore a version (read back, diffed in SQL)", async () => {
      const source = await openSnapshot(bucket, "v1.json.gz");
      if (!source) throw new Error("no snapshot");
      await loadSnapshot(sql, "tmp_version", source, room.transact);
      room.transact(() => {
        const out = new OpChunks(commit);
        restoreFromTable(sql, "tmp_version", out);
        changed = out.count;
      });
      dropTable(sql, "tmp_version");
    });
    expect(changed).toBe(1 + FRAMES + FRAMES * LEAVES + 50);
    expect(nodeCount()).toBe(TOTAL);
    expect(getNode("N0x3x0")?.props.name).toBe("Path 0");
  });

  it("restores a version 1 snapshot (one JSON object), read as a stream", async () => {
    // Written as the old format was, a stream of text through gzip, so this side holds none of it.
    const text = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(
          `{"format":"drawpane.snapshot","version":1,"fileId":"F","revn":1,"at":0,"nodes":[`,
        );
      },
      pull: (() => {
        const batches = file();
        let first = true;
        return (controller: ReadableStreamDefaultController<string>) => {
          const next = batches.next();
          if (next.done) {
            controller.enqueue("]}");
            controller.close();
            return;
          }
          const parts = next.value.map((n) =>
            JSON.stringify(n.id === MARK ? { ...n, props: { ...n.props, name: "From v1" } } : n),
          );
          controller.enqueue((first ? "" : ",") + parts.join(","));
          first = false;
        };
      })(),
    });
    await putStream(
      bucket,
      "old.json.gz",
      text.pipeThrough(new TextEncoderStream()).pipeThrough(new CompressionStream("gzip")),
      1,
    );
    let changed = 0;
    await measure("Restore a version 1 snapshot", async () => {
      const source = await openSnapshot(bucket, "old.json.gz");
      if (!source) throw new Error("no snapshot");
      expect(source.header.version).toBe(1);
      await loadSnapshot(sql, "tmp_version", source, room.transact);
      room.transact(() => {
        const out = new OpChunks(commit);
        restoreFromTable(sql, "tmp_version", out);
        changed = out.count;
      });
      dropTable(sql, "tmp_version");
    });
    expect(changed).toBe(1);
    expect(getNode(MARK)?.props.name).toBe("From v1");
  });

  it("makes a branch, and merges it: base from R2, the branch streamed in, diffed in SQL", async () => {
    // The branch: a copy with 5,000 layers renamed, a page's frame deleted, and a frame added.
    copyNodes(sql, "nodes", "branch_nodes");
    sql.exec(
      `UPDATE branch_nodes SET props = json_set(props, '$.name', 'Renamed') WHERE id LIKE 'N1x%x1' OR id LIKE 'N2x%x2'`,
    );
    sql.exec(`DELETE FROM branch_nodes WHERE id = 'F4x4' OR parent = 'F4x4'`);
    insertNodes(sql, "branch_nodes", [
      {
        id: "New",
        type: "frame",
        parent: "P0",
        key: keyBetween(KEYS.at(-1) as string, null),
        props: { name: "New" },
      },
    ] as NodeRecord[]);
    await measure("Branch: main's nodes to the base in R2", async () => {
      copyNodes(sql, "nodes", "tmp_frozen");
      await writeSnapshot(
        bucket,
        "base.json.gz",
        { fileId: "F", revn: 2, at: 0 },
        tablePages(sql, "tmp_frozen"),
      );
      dropTable(sql, "tmp_frozen");
    });
    let changes = 0;
    await measure("Merge (branch streamed room to room)", async () => {
      const stream = snapshotStream(
        { fileId: "B", revn: 9, at: 0 },
        tablePages(sql, "branch_nodes"),
      );
      const other = await openSnapshotStream(stream);
      const base = await openSnapshot(bucket, "base.json.gz");
      if (!other || !base) throw new Error("no snapshot");
      await loadSnapshot(sql, "tmp_base", base, room.transact);
      await loadSnapshot(sql, "tmp_other", other, room.transact);
      const tables = { base: "tmp_base", other: "tmp_other", removals: "tmp_removals" };
      const choices = { resolutions: new Map(), skip: new Set<string>() };
      const plan = planThreeWay(sql, tables, choices);
      expect(plan.undecided).toBe(0);
      changes = plan.changes;
      room.transact(() => applyThreeWay(sql, tables, choices, new OpChunks(commit)));
      for (const t of Object.values(tables)) dropTable(sql, t);
    });
    // Leaf 1 of every frame on page 1, and leaf 2 of every frame on page 2.
    const renamed = 2 * FRAMES;
    expect(changes).toBe(renamed + 1 + 1);
    expect(getNode("N1x7x1")?.props.name).toBe("Renamed");
    expect(getNode("F4x4")).toBeUndefined();
    expect(getNode("New")).toBeDefined();
    dropTable(sql, "branch_nodes");
  });

  it("streams review: base, branch and main, as the Worker sends them", async () => {
    let lines = 0;
    await measure("Branch review (three files streamed)", async () => {
      const sources = await Promise.all([
        openSnapshot(bucket, "base.json.gz"),
        openSnapshot(bucket, "v1.json.gz"),
        openSnapshot(bucket, "old.json.gz"),
      ]);
      const [a, b, c] = sources;
      if (!a || !b || !c) throw new Error("no snapshot");
      const reader = reviewStream(a, b, c).pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let i = value.indexOf("\n"); i >= 0; i = value.indexOf("\n", i + 1)) lines++;
        probe();
      }
    });
    expect(lines).toBe(3 * TOTAL + 3);
  });

  it("duplicates a file: streamed from one room's copy into another's import", async () => {
    await measure("Duplicate (room to room stream)", async () => {
      copyNodes(sql, "nodes", "tmp_frozen");
      const source = await openSnapshotStream(
        snapshotStream({ fileId: "F", revn: 3, at: 0 }, tablePages(sql, "tmp_frozen")),
      );
      if (!source) throw new Error("no stream");
      beginStaging(sql, "copy_import");
      for await (const lines of source.lines)
        stageNodes(
          room,
          lines.map((l) => JSON.parse(l) as NodeRecord),
          "copy_import",
        );
      dropTable(sql, "tmp_frozen");
    });
    expect(countRows(sql, "copy_import")).toBe(nodeCount());
    dropTable(sql, "copy_import");
  });

  it("publishes a library: its components found and hashed from SQLite", async () => {
    let assets = 0;
    await measure("Library manifest", () => {
      copyNodes(sql, "nodes", "tmp_frozen");
      assets = libraryAssets(new TableReader(sql, "tmp_frozen")).length;
      dropTable(sql, "tmp_frozen");
    });
    expect(assets).toBe(PAGES * (FRAMES / 25));
  });

  it("answers MCP reads, walking every page", async () => {
    let total = 0;
    await measure("MCP find_nodes (every layer)", () => {
      const found = answerDocument(new SqlFileDoc(new TableReader(sql, "nodes")), {
        kind: "find",
        query: "Path 42",
        limit: 100,
      }) as { total: number };
      total = found.total;
    });
    expect(total).toBe(LEAVES > 42 ? PAGES * FRAMES - 1 : 0);
  });

  it("keeps the room's own nodes table unchanged in shape", () => {
    createNodeTable(sql, "tmp_check");
    dropTable(sql, "tmp_check");
    expect(nodeCount()).toBeGreaterThan(0);
  });
});
