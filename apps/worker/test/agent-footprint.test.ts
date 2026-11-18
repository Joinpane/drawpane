/**
 * What an agent run depended on (`agent-footprint.ts`, decision 0033): the
 * ids its commit is checked against, and the cap past which any change
 * since its base revision makes it run again.
 */
import type { NodeRecord, Op } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { readSet } from "../src/agent/runner";
import { AGENT_READ_CAP } from "../src/agent/runner-api";
import { type Footprint, footprint, overlaps } from "../src/rooms/agent-footprint";

const rec = (id: string, parent: string, props: Record<string, unknown> = {}): NodeRecord => ({
  id,
  parent,
  key: "a0",
  type: id.startsWith("t") ? "text" : "frame",
  props,
});

/** page > row (auto layout) > [a, b]; page > free > c. */
function store() {
  const nodes = [
    rec("page", "root"),
    rec("row", "page", { layoutMode: "row" }),
    rec("a", "row"),
    rec("b", "row"),
    rec("free", "page"),
    rec("c", "free"),
  ];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    get: (id: string) => byId.get(id),
    childIds: (parent: string) => nodes.filter((n) => n.parent === parent).map((n) => n.id),
  };
}

const none = { ids: [], lists: [], instances: [] };
const set = (id: string): Op => ({ op: "set", id, prop: "name", value: "x" });

describe("an agent run's footprint", () => {
  it("adds the ancestors of what it changed, and the children of auto layout ones", () => {
    const f = footprint(store(), [set("a")], none) as Footprint;
    expect([...f.writes]).toEqual(["a"]);
    expect([...f.reads].sort()).toEqual(["a", "b", "page", "row"]);
    expect([...f.lists]).toEqual(["row"]);
  });

  it("adds the old and new parents of a move, with theirs", () => {
    const f = footprint(store(), [{ op: "move", id: "c", parent: "row", key: "b0" }], none);
    expect([...(f as Footprint).reads]).toEqual(expect.arrayContaining(["free", "row", "page"]));
  });

  it("walks up through layers the run made to the stored parent", () => {
    const ops: Op[] = [
      { op: "create", id: "n1", type: "frame", parent: "free", key: "a1", props: {} },
      { op: "create", id: "n2", type: "rect", parent: "n1", key: "a0", props: {} },
    ];
    const f = footprint(store(), ops, none) as Footprint;
    expect([...f.reads].sort()).toEqual(["free", "page"]);
  });

  it("lists what it deletes", () => {
    expect(footprint(store(), [{ op: "delete", id: "free" }], none)?.deletes).toEqual(["free"]);
  });

  it("is the whole file when the runner read everything, or past the cap", () => {
    expect(footprint(store(), [set("a")], null)).toBeNull();
    const many = Array.from({ length: AGENT_READ_CAP + 1 }, (_, i) => `r${i}`);
    expect(footprint(store(), [set("a")], { ...none, ids: many })).toBeNull();
    // What the room adds counts toward it too.
    const almost = Array.from({ length: AGENT_READ_CAP - 1 }, (_, i) => `r${i}`);
    expect(footprint(store(), [set("a")], { ...none, ids: almost })).toBeNull();
  });

  it("overlaps a change to what it read or changed, a layer put in a list it read, a new instance", () => {
    const f = footprint(store(), [set("c")], {
      ids: ["x"],
      lists: ["l"],
      instances: ["main"],
    }) as Footprint;
    expect(overlaps(set("x"), f)).toBe(true);
    expect(overlaps(set("free"), f)).toBe(true);
    expect(
      overlaps({ op: "create", id: "y", type: "rect", parent: "l", key: "a", props: {} }, f),
    ).toBe(true);
    expect(
      overlaps({ op: "create", id: "y", type: "rect", parent: "c", key: "a", props: {} }, f),
    ).toBe(true);
    expect(
      overlaps(
        {
          op: "create",
          id: "i",
          type: "frame",
          parent: "page",
          key: "a",
          props: { instanceOf: "main" },
        },
        f,
      ),
    ).toBe(true);
    // A page in the reads overlaps a change to the page, not a layer made on it.
    expect(
      overlaps({ op: "create", id: "y", type: "rect", parent: "page", key: "a", props: {} }, f),
    ).toBe(false);
    expect(overlaps(set("b"), f)).toBe(false);
  });
});

describe("a run's read set", () => {
  it("leaves out the layers it made", () => {
    const reads = {
      ids: new Set(["a", "n1"]),
      lists: new Set(["n1"]),
      instances: new Set<string>(),
      all: false,
    };
    const ops: Op[] = [
      { op: "create", id: "n1", type: "frame", parent: "a", key: "a0", props: {} },
    ];
    expect(readSet(reads, ops)).toEqual({ ids: ["a"], lists: [], instances: [] });
  });

  it("is null when it read everything or more than the cap", () => {
    const empty = {
      ids: new Set<string>(),
      lists: new Set<string>(),
      instances: new Set<string>(),
    };
    expect(readSet({ ...empty, all: true }, [])).toBeNull();
    const ids = new Set(Array.from({ length: AGENT_READ_CAP + 1 }, (_, i) => `r${i}`));
    expect(readSet({ ...empty, ids, all: false }, [])).toBeNull();
  });
});
