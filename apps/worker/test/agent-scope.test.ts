/**
 * An agent run's scope and what changes touch (`agent-scope.ts`, decision
 * 0033), on a room's own SQLite: the top-level layers a run worked in,
 * closed over the mains, styles and variables used inside them, and the
 * runner's half (`agentReads`), which places what it read.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Doc } from "@drawpane/editor";
import { copyId, type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { agentReads } from "../../agent-runner/src/runner";
import { AGENT_SCOPE_CAP, AGENT_SCOPE_SCAN } from "../src/agent/runner-api";
import {
  leftBy,
  placeAll,
  runScope,
  type Scope,
  touchedBy,
  touches,
} from "../src/rooms/agent-scope";

type Row = [id: string, parent: string, type: string, props?: Record<string, unknown>];

/** Runs `body` on an empty room's SQLite, its nodes table holding `rows`. */
async function withRows<T>(rows: readonly Row[], body: (sql: SqlStorage) => T): Promise<T> {
  const room = env.FILE_ROOM.get(env.FILE_ROOM.newUniqueId());
  return runInDurableObject(room, (_room, state) => {
    const sql = state.storage.sql;
    sql.exec("DELETE FROM nodes");
    for (const [id, parent, type, props = {}] of rows)
      sql.exec(
        "INSERT INTO nodes (id, parent, key, type, props) VALUES (?, ?, 'a0', ?, ?)",
        id,
        parent,
        type,
        JSON.stringify(props),
      );
    return body(sql);
  });
}

/** A page with two top-level frames, a nested layer, a main inside a kit frame, a collection. */
const FILE: Row[] = [
  [ROOT_ID, "", "frame"],
  ["p", ROOT_ID, "page"],
  ["f", "p", "frame"],
  ["c", "f", "frame"],
  ["g", "c", "rect"],
  ["other", "p", "frame"],
  ["o1", "other", "rect"],
  ["kit", "p", "frame"],
  ["main", "kit", "frame", { isComponent: true }],
  ["mainChild", "main", "rect"],
  ["i", "f", "frame", { instanceOf: "main" }],
  ["col", ROOT_ID, "collection"],
  ["v", "col", "variable"],
  ["grp", "p", "group"],
  ["inGroup", "grp", "rect"],
];

const reads = (units: string[], lists: string[] = [], absent: string[] = []) => ({
  units,
  lists,
  absent,
});
const set = (id: string, prop = "x", value: unknown = 1): Op =>
  ({ op: "set", id, prop, value }) as Op;

describe("placing layers", () => {
  it("places each by its top-level layer, a page or root-level record by itself", async () => {
    const placed = await withRows(FILE, (sql) =>
      Object.fromEntries(placeAll(sql, ["g", "f", "v", "p", "missing", ROOT_ID])),
    );
    expect(placed).toEqual({
      g: { top: "f", parent: "c", type: "rect" },
      f: { top: "f", parent: "p", type: "frame" },
      v: { top: "col", parent: "col", type: "variable" },
      p: { top: "p", parent: ROOT_ID, type: "page" },
    });
  });
});

describe("a run's scope", () => {
  it("is the top-level layers it read in and changed, and the mains used inside them", async () => {
    const scope = await withRows(FILE, (sql) => runScope(sql, [set("g")], reads(["f"])));
    expect([...(scope as Scope).units].sort()).toEqual(["f", "kit"]);
    expect([...(scope as Scope).lists]).toEqual([]);
  });

  it("holds the page's list and its top-level groups when it puts a top-level layer in", async () => {
    const made: Op = { op: "create", id: "new", type: "rect", parent: "p", key: "a9", props: {} };
    const scope = (await withRows(FILE, (sql) => runScope(sql, [made], reads([])))) as Scope;
    expect([...scope.lists]).toEqual(["p"]);
    expect([...scope.units]).toEqual(["grp"]);
  });

  it("holds a page's list when it moves a top-level layer, from where it is now", async () => {
    const move: Op = { op: "move", id: "other", parent: "f", key: "a9" };
    const scope = (await withRows(FILE, (sql) => runScope(sql, [move], reads([])))) as Scope;
    expect([...scope.units].sort()).toEqual(["f", "grp", "kit", "other"]);
    expect([...scope.lists]).toEqual(["p"]);
  });

  it("holds what it points a layer at: a variable's collection", async () => {
    const bind = set("o1", "bindings", { width: "v" });
    const scope = (await withRows(FILE, (sql) => runScope(sql, [bind], reads([])))) as Scope;
    expect([...scope.units].sort()).toEqual(["col", "other"]);
  });

  it("is the whole file when the runner couldn't place what it read", async () => {
    expect(await withRows(FILE, (sql) => runScope(sql, [set("g")], null))).toBeNull();
  });

  it("is the whole file past AGENT_SCOPE_SCAN layers looked through", async () => {
    const rows: Row[] = [
      [ROOT_ID, "", "frame"],
      ["p", ROOT_ID, "page"],
      ["big", "p", "frame"],
    ];
    const scope = await withRows(rows, (sql) => {
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n LIMIT ?)
         INSERT INTO nodes (id, parent, key, type, props) SELECT 'k' || i, 'big', 'a0', 'rect', '{}' FROM n`,
        AGENT_SCOPE_SCAN,
      );
      return runScope(sql, [set("k0")], reads([]));
    });
    expect(scope).toBeNull();
  });

  it("isn't the whole file for a small change in a frame of 5,000 auto layout children", async () => {
    const rows: Row[] = [
      [ROOT_ID, "", "frame"],
      ["p", ROOT_ID, "page"],
      ["row", "p", "frame", { layoutMode: "row" }],
      ["elsewhere", "p", "frame"],
      ["e1", "elsewhere", "rect"],
    ];
    for (let i = 0; i < 5_000; i++) rows.push([`c${i}`, "row", "rect"]);
    const { scope, touched } = await withRows(rows, (sql) => ({
      scope: runScope(sql, [set("c0", "opacity", 0.5)], reads(["row"])),
      touched: touchedBy(sql, [set("e1")]),
    }));
    expect(scope).not.toBeNull();
    expect(touches(touched as Scope, scope as Scope)).toBe(false);
  });
});

describe("what a change touches", () => {
  it("meets a run in the same top-level frame, free-positioned or not", async () => {
    const { scope, sibling, elsewhere } = await withRows(FILE, (sql) => ({
      scope: runScope(sql, [set("g", "opacity", 0.5)], reads(["f"])) as Scope,
      sibling: touchedBy(sql, [set("i", "x", 80)]) as Scope,
      elsewhere: touchedBy(sql, [set("o1", "x", 80)]) as Scope,
    }));
    expect(touches(sibling, scope)).toBe(true);
    expect(touches(elsewhere, scope)).toBe(false);
  });

  it("meets a run when a layer inside a main used in its scope changes", async () => {
    const { scope, main } = await withRows(FILE, (sql) => ({
      scope: runScope(sql, [set("i", "gap", 10)], reads(["f"])) as Scope,
      main: touchedBy(sql, [set("mainChild", "width", 80)]) as Scope,
    }));
    expect(touches(main, scope)).toBe(true);
  });

  it("meets a run that changed a main when an instance of it is made anywhere", async () => {
    const instance: Op = {
      op: "create",
      id: "late",
      type: "frame",
      parent: "other",
      key: "a9",
      props: { instanceOf: "main" },
    };
    const { scope, made } = await withRows(FILE, (sql) => ({
      scope: runScope(sql, [set("main", "width", 80)], reads(["kit"])) as Scope,
      made: touchedBy(sql, [instance]) as Scope,
    }));
    expect(touches(made, scope)).toBe(true);
  });

  it("meets a run that placed a top-level layer when a sibling top-level layer moves, or a group's layer", async () => {
    const made: Op = { op: "create", id: "new", type: "rect", parent: "p", key: "a9", props: {} };
    const { scope, sibling, inGroup, nested } = await withRows(FILE, (sql) => ({
      scope: runScope(sql, [made], reads([])) as Scope,
      sibling: touchedBy(sql, [set("other", "x", 500)]) as Scope,
      inGroup: touchedBy(sql, [set("inGroup", "x", 500)]) as Scope,
      nested: touchedBy(sql, [set("o1", "x", 500)]) as Scope,
    }));
    expect(touches(sibling, scope)).toBe(true);
    expect(touches(inGroup, scope)).toBe(true);
    // Inside a frame: the frame's bounds are its own.
    expect(touches(nested, scope)).toBe(false);
  });

  it("meets a run that looked for a layer that's made meanwhile", async () => {
    const { scope, made } = await withRows(FILE, (sql) => ({
      scope: runScope(sql, [set("g")], reads(["f"], [], ["wanted"])) as Scope,
      made: touchedBy(sql, [
        { op: "create", id: "wanted", type: "rect", parent: "other", key: "a9", props: {} },
      ]) as Scope,
    }));
    expect(touches(made, scope)).toBe(true);
  });

  it("notes where a deleted or moved layer was before it goes, and everything for a page", async () => {
    const { left, page } = await withRows(FILE, (sql) => ({
      left: leftBy(sql, [
        { op: "delete", id: "g" },
        { op: "move", id: "other", parent: "f", key: "a" },
      ]),
      page: leftBy(sql, [{ op: "delete", id: "p" }]),
    }));
    expect([...(left as Scope).units].sort()).toEqual(["f", "other"]);
    expect([...(left as Scope).lists]).toEqual(["p"]);
    expect(page).toBeNull();
  });
});

describe("where a run read, as its runner places it", () => {
  function doc(compactCopies = false) {
    const d = new Doc({ compactCopies });
    const create = (id: string, parent: string, type: string, props = {}): Op =>
      ({ op: "create", id, type, parent, key: "a0", props }) as Op;
    d.apply([
      create("p", ROOT_ID, "page"),
      create("f", "p", "frame", { isComponent: true }),
      create("a", "f", "rect"),
      create("i", "p", "frame", { instanceOf: "f", x: 300 }),
    ]);
    return d;
  }
  const tracked = (d: Doc, read: (d: Doc) => void) => {
    const reads = d.trackReads();
    read(d);
    d.untrackReads();
    return reads;
  };

  it("places each layer read by its top-level layer, a copy layer by its instance's", () => {
    const d = doc(true);
    const copy = copyId("i", ["a"]);
    const reads = tracked(d, (d) => {
      d.get("a");
      d.get(copy);
      d.childIds("p");
      d.has("missing");
    });
    expect(agentReads(d, reads, [])).toEqual({
      units: expect.arrayContaining(["f", "i", "p"]),
      lists: ["p"],
      absent: ["missing"],
    });
  });

  it("leaves out what the run made, and is null when it read everything", () => {
    const d = doc();
    const reads = tracked(d, (d) => d.get("made"));
    const made: Op = { op: "create", id: "made", type: "rect", parent: "f", key: "a1", props: {} };
    expect(agentReads(d, reads, [made])).toEqual({ units: [], lists: [], absent: [] });
    expect(agentReads(d, { ...reads, all: true }, [])).toBeNull();
  });

  it("is null past AGENT_SCOPE_CAP ids it can't place", () => {
    const d = doc();
    const reads = tracked(d, (d) => {
      for (let n = 0; n <= AGENT_SCOPE_CAP; n++) d.has(`absent-${n}`);
    });
    expect(agentReads(d, reads, [])).toBeNull();
  });
});
