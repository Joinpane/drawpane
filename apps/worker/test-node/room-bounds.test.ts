/**
 * What the room reads for ordinary actions on a legal large file, with the
 * V8 heap capped as a Durable Object's is (the memory check: `pnpm --filter
 * @drawpane/worker memory`, MEMORY_HEAP_MB=64 for the lower cap). Out of
 * memory a Durable Object aborts and no handler runs, so each is bounded by
 * bytes, not only by a count:
 *
 * - a selection of 400 texts of 200,000 CJK characters moved (600 KB each
 *   stored, 240 MB in all, under the import's 640 MB): the store's read
 *   cache kept every row a chunk read until it applied;
 * - publishing 40,000 components with 2,000-character descriptions: every
 *   main's row was read before the 2,000-asset limit was counted;
 * - restoring a version of the texts, and merging a branch that changed
 *   them: a page of 1,000 rows was read with no bound on its characters,
 *   each row with the file's and the version's (or base's) values.
 *
 * - an agent's undo after someone typed in such a text: each keystroke logs
 *   the whole text, and every log row since the call was read at once.
 *
 * The first three aborted at 128 MB before their fix (the seventh review of
 * #163), the rest too (found by the audit after it). Agent
 * tools on the same texts are in `agent-bounds.test.ts` (it loads the
 * editor, which raises the heap every test there starts from).
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import {
  applyTransaction,
  libraryAssets,
  libraryAssetsWithin,
  MAX_LIBRARY_ASSETS,
  ModelError,
  type NodeRecord,
  nodeReader,
  type Op,
  ROOT_ID,
} from "@drawpane/model";
import { afterAll, describe, expect, it } from "vitest";
import { firstOverlap } from "../src/rooms/call-ledger";
import {
  createNodeTable,
  dropTable,
  fillDepths,
  insertNodes,
  sumPast,
  TableReader,
} from "../src/rooms/node-tables";
import { OpChunks } from "../src/rooms/op-chunks";
import { PresentedReader } from "../src/rooms/presented";
import { restoreFromTable } from "../src/rooms/restore";
import { NODE_SCHEMA, SqlNodeStore } from "../src/rooms/sql-store";
import { applyThreeWay, planThreeWay } from "../src/rooms/three-way";
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

const dir = join(tmpdir(), `drawpane-room-bounds-${process.pid}`);
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

const page = (id = "P"): NodeRecord => ({
  id,
  type: "page",
  parent: ROOT_ID,
  key: "a0",
  props: {},
});

/** The JSON of a text of 200,000 CJK characters: 600,017 bytes of UTF-8. */
const LARGE_TEXT = JSON.stringify({ characters: "界".repeat(200_000) });

/** `count` texts of 200,000 CJK characters on page `P`, `T0`... */
function largeTexts(count: number): Room {
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

const moved = (r: Room) =>
  r.sql
    .exec<{ n: number }>("SELECT COUNT(*) AS n FROM nodes WHERE json_extract(props, '$.x') = 1")
    .one().n;

describe(`400 texts of 200,000 CJK characters (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  const r = largeTexts(400);
  afterAll(() => r.close());
  const move: Op[] = Array.from({ length: 400 }, (_, i) => ({
    op: "set",
    id: `T${i}`,
    prop: "x",
    value: 1,
  }));

  it("moves all of them in one transaction, holding a few rows at a time", async () => {
    // A drag of the selection: about 18 KB of setters, applied as FileRoom.#applyLogged does.
    const store = new SqlNodeStore(r.sql);
    const { peak } = await measured(() =>
      r.transact(() =>
        applyTransaction(store, move, { rollback: false, inverse: false, cycles: false }),
      ),
    );
    store.clearCache();
    report("moving 400 texts of 600 KB", peak);
    expect(moved(r)).toBe(400);
    r.sql.exec("UPDATE nodes SET props = json_remove(props, '$.x')");
  });

  it("keeps the inverse of the move, not the rows, for an agent's undo", async () => {
    const store = new SqlNodeStore(r.sql);
    const { result, peak } = await measured(() =>
      r.transact(() => applyTransaction(store, move, { rollback: true, inverse: true })),
    );
    store.clearCache();
    report("moving 400 texts of 600 KB, with the inverse", peak);
    expect(result).toHaveLength(400);
    expect(result[0]).toMatchObject({ op: "set", id: "T399", prop: "x" });
    expect(moved(r)).toBe(400);
    r.sql.exec("UPDATE nodes SET props = json_remove(props, '$.x')");
  });

  /** A copy of the file in `table`, its levels numbered, every text's characters changed. */
  const changedCopy = (table: string) => {
    createNodeTable(r.sql, table);
    r.sql.exec(
      `INSERT INTO ${table} (id, parent, key, type, props)
         SELECT id, parent, key, type, replace(props, '界', '国') FROM nodes`,
    );
    fillDepths(r.sql, table);
  };
  /** Commits chunks of operations as the room does, a chunk at a time. */
  const committer = () => {
    const store = new SqlNodeStore(r.sql);
    let ops = 0;
    const commit = (chunk: Op[]) => {
      applyTransaction(store, chunk, {
        rollback: false,
        inverse: false,
        held: true,
        cycles: false,
      });
      store.clearCache();
      ops += chunk.length;
    };
    return { commit, ops: () => ops };
  };
  const changed = () =>
    r.sql
      .exec<{ n: number }>(
        'SELECT COUNT(*) AS n FROM nodes WHERE props LIKE \'{"characters":"国%\'',
      )
      .one().n;

  it("restores a version that changed every text, a few rows a page", async () => {
    changedCopy("tmp_version");
    const { commit, ops } = committer();
    const { peak } = await measured(() =>
      r.transact(() => {
        const out = new OpChunks(commit);
        restoreFromTable(r.sql, "tmp_version", out);
        out.flush();
      }),
    );
    report("restoring a version of 400 texts of 600 KB", peak);
    expect(ops()).toBe(400);
    expect(changed()).toBe(400);
    dropTable(r.sql, "tmp_version");
    r.sql.exec("UPDATE nodes SET props = replace(props, '国', '界')");
  });

  it("merges a branch that changed every text, a few rows a page", async () => {
    createNodeTable(r.sql, "tmp_base");
    r.sql.exec("INSERT INTO tmp_base (id, parent, key, type, props) SELECT * FROM nodes");
    fillDepths(r.sql, "tmp_base");
    changedCopy("tmp_other");
    const tables = { base: "tmp_base", other: "tmp_other", removals: "tmp_removals" };
    const choices = { resolutions: new Map(), skip: new Set<string>() };
    const { commit, ops } = committer();
    const { result, peak } = await measured(() => {
      const plan = planThreeWay(r.sql, tables, choices);
      r.transact(() => {
        const out = new OpChunks(commit);
        applyThreeWay(r.sql, tables, choices, out);
        out.flush();
      });
      return plan;
    });
    report("merging a branch of 400 texts of 600 KB", peak);
    expect(result).toEqual({ changes: 400, conflicts: 0, undecided: 0 });
    expect(ops()).toBe(400);
    expect(changed()).toBe(400);
    for (const t of Object.values(tables)) dropTable(r.sql, t);
    r.sql.exec("UPDATE nodes SET props = replace(props, '国', '界')");
  });

  it("takes the whole move back when its last operation fails", async () => {
    // The rows set first have long left the cache: rolling back reads them again.
    const store = new SqlNodeStore(r.sql);
    const failing: Op[] = [...move, { op: "set", id: "missing", prop: "x", value: 1 }];
    const { result, peak } = await measured(() => {
      try {
        r.transact(() => applyTransaction(store, failing, { rollback: true, inverse: false }));
      } catch (error) {
        if (error instanceof ModelError) return error.code;
        throw error;
      }
      return "taken";
    });
    store.clearCache();
    report("a failed move of 400 texts of 600 KB", peak);
    expect(result).not.toBe("taken");
    expect(moved(r)).toBe(0);
  });
});

/** 40,000 mains with a 2,000-character CJK description each (6 KB stored), in `sets` sets or none. */
function components(sets: number): Room {
  const r = room([page()]);
  const main = JSON.stringify({
    isComponent: true,
    name: "Button",
    componentDescription: "界".repeat(2_000),
  });
  r.transact(() => {
    for (let s = 0; s < sets; s++)
      r.sql.exec(
        "INSERT INTO nodes (id, parent, key, type, props) VALUES (?, 'P', ?, 'frame', ?)",
        `S${s}`,
        `a${s}`,
        JSON.stringify({ isComponentSet: true, name: `Set ${s}` }),
      );
    for (let i = 0; i < 40_000; i++)
      r.sql.exec(
        "INSERT INTO nodes (id, parent, key, type, props) VALUES (?, ?, 'a0', 'frame', ?)",
        `M${i}`,
        sets > 0 ? `S${i % sets}` : "P",
        main,
      );
  });
  return r;
}

const presentedOf = (r: Room) =>
  new PresentedReader(new TableReader(r.sql, "nodes"), r.sql, "nodes");

describe(`publishing 40,000 components with 2,000-character descriptions (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  it("refuses them as too many, counting before reading a row", async () => {
    const r = components(0);
    const { result, peak } = await measured(() =>
      libraryAssetsWithin(presentedOf(r), MAX_LIBRARY_ASSETS),
    );
    report("publishing 40,000 components of 6 KB", peak);
    expect(result).toBeNull();
    r.close();
  });

  it("offers them as 20 sets of variants, reading their rows a few at a time", async () => {
    // Under the limit, but every variant's row was read (and parsed) to list them. Hashing reads
    // all 240 MB through the reader's cache, so the heap fills with garbage until it's collected:
    // at the 64 MB cap the sample passes the cap by what new space holds (decision 0026), so
    // what's checked there is that it finishes and what it still holds once collected.
    const r = components(20);
    gc();
    const before = getHeapStatistics().used_heap_size;
    const reader = presentedOf(r);
    const { result, peak } = await measured(() => libraryAssetsWithin(reader, MAX_LIBRARY_ASSETS));
    gc();
    const held = getHeapStatistics().used_heap_size - before;
    console.log(
      `publishing 20 sets of 2,000 variants of 6 KB: peak heap ${(peak / MB).toFixed(1)} MB, ${(held / MB).toFixed(1)} MB held after (cap ${HEAP_MB} MB)`,
    );
    if (HEAP_MB >= 128) expect(peak).toBeLessThan(HEAP_MB * MB);
    // The reader's cache: at most 8 MB of rows as V8 holds them, and the 20 assets.
    expect(held).toBeLessThan(16 * MB);
    void reader;
    const inKeyOrder = Array.from({ length: 20 }, (_, s) => s).sort((a, b) =>
      `a${a}` < `a${b}` ? -1 : 1,
    );
    expect(result?.map((a) => [a.id, a.set])).toEqual(inKeyOrder.map((s) => [`S${s}`, true]));
    r.close();
  });
});

describe(`an agent's undo after 300 keystrokes in a text of 200,000 characters (heap capped at ${HEAP_MB} MB)`, {
  timeout: 1_800_000,
}, () => {
  it("looks through the log a few rows at a time", async () => {
    const r = room([]);
    r.sql.exec(`CREATE TABLE log (
      revn INTEGER PRIMARY KEY, client_id TEXT NOT NULL, seq INTEGER NOT NULL,
      user_id TEXT NOT NULL, session_id TEXT NOT NULL, ops TEXT NOT NULL, at INTEGER NOT NULL
    ) STRICT`);
    r.transact(() => {
      for (let revn = 1; revn <= 300; revn++)
        r.sql.exec(
          "INSERT INTO log VALUES (?, 'c', ?, 'ana', '', ?, 0)",
          revn,
          revn,
          JSON.stringify([{ op: "set", id: "T", prop: "characters", value: "界".repeat(200_000) }]),
        );
      r.sql.exec(
        "INSERT INTO log VALUES (301, 'c', 301, 'bo', '', ?, 0)",
        JSON.stringify([{ op: "set", id: "A", prop: "x", value: 1 }]),
      );
    });
    // The agent's call changed `A`; Ana's typing didn't touch it, Bo's last edit did.
    const { result, peak } = await measured(() => firstOverlap(r.sql, 0, "agent", new Set(["A"])));
    report("an agent's undo looking through 180 MB of log", peak);
    expect(result).toEqual({ userId: "bo", ids: ["A"] });
    expect(firstOverlap(r.sql, 0, "agent", new Set(["T"]))).toEqual({ userId: "ana", ids: ["T"] });
    expect(firstOverlap(r.sql, 301, "agent", new Set(["A"]))).toBeNull();
    r.close();
  });
});

describe("what a library offers, counted in SQL", () => {
  it("finds those on a page in file order past the limit, as the in-memory reader does", () => {
    // Four mains on the page, two variants in a set, and five mains whose parent isn't there:
    // eleven counted in SQL, so a limit of four or five pages through them, counting those on
    // a page only.
    const nodes: NodeRecord[] = [
      page(),
      { id: "S", type: "frame", parent: "P", key: "a2", props: { isComponentSet: true } },
      { id: "V1", type: "frame", parent: "S", key: "a1", props: { isComponent: true } },
      { id: "V0", type: "frame", parent: "S", key: "a0", props: { isComponent: true } },
      ...["a4", "a1", "a3", "a0"].map(
        (key, i): NodeRecord => ({
          id: `M${i}`,
          type: "frame",
          parent: "P",
          key,
          props: { isComponent: true, name: `M${i}` },
        }),
      ),
      ...Array.from(
        { length: 5 },
        (_, i): NodeRecord => ({
          id: `O${i}`,
          type: "frame",
          parent: "gone",
          key: "a0",
          props: { isComponent: true },
        }),
      ),
    ];
    const r = room(nodes);
    const reader = new TableReader(r.sql, "nodes");
    const inMemory = libraryAssets(nodeReader(nodes));
    expect(inMemory.map((a) => a.id)).toEqual(["M3", "M1", "S", "M2", "M0"]);
    expect(libraryAssets(reader)).toEqual(inMemory);
    expect(libraryAssetsWithin(reader, 5)).toEqual(inMemory);
    expect(libraryAssetsWithin(reader, 4)).toBeNull();
    expect(reader.componentAssets(4)).toHaveLength(5);
    r.close();
  });
});

describe("sums read in pages", () => {
  it("is the exact sum up to the limit, and stops reading past it", () => {
    const r = room([]);
    insertNodes(
      r.sql,
      "nodes",
      Array.from({ length: 9_000 }, (_, i) => ({
        id: `n${String(i).padStart(5, "0")}`,
        type: "rect" as const,
        parent: "P",
        key: "a0",
        props: { name: "x".repeat(i % 97) },
      })),
    );
    const total = r.sql.exec<{ n: number }>("SELECT SUM(LENGTH(props)) AS n FROM nodes").one().n;
    for (const limit of [total, total + 1, total * 2])
      expect(sumPast(r.sql, "nodes", "LENGTH(props)", limit)).toBe(total);
    expect(sumPast(r.sql, "nodes", "LENGTH(props)", total - 1)).toBe(total);
    // A limit the first page of rows passes is answered from that page.
    let pages = 0;
    const counting = {
      exec: (query: string, ...bindings: unknown[]) => {
        pages++;
        return (r.sql.exec as (q: string, ...b: unknown[]) => unknown)(query, ...bindings);
      },
    } as unknown as SqlStorage;
    expect(sumPast(counting, "nodes", "LENGTH(props)", 1_000)).toBeGreaterThan(1_000);
    expect(pages).toBe(1);
    r.close();
  });
});
