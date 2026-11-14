import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyTransaction,
  changeKinds,
  MemoryStore,
  ModelError,
  type NodeRecord,
  type Op,
  ROOT_ID,
  restoreOps,
  sameValue,
  summarizeEdits,
} from "../src/index";

function page(id: string, key = "a0"): Op {
  return { op: "create", id, type: "page", parent: ROOT_ID, key, props: { name: id } };
}
function rect(id: string, parent: string, key = "a0", props = {}): Op {
  return {
    op: "create",
    id,
    type: "rect",
    parent,
    key,
    props: { x: 0, y: 0, width: 10, height: 10, ...props },
  };
}
function frame(id: string, parent: string, key = "a0"): Op {
  return { op: "create", id, type: "frame", parent, key, props: { width: 100, height: 100 } };
}

function snapshot(store: MemoryStore): NodeRecord[] {
  return [...store.nodes()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

function storeWith(...ops: Op[]): MemoryStore {
  const store = new MemoryStore();
  applyTransaction(store, ops);
  return store;
}

/** Applies what `restoreOps` plans, as one transaction, the way the room does. */
function restore(store: MemoryStore, version: NodeRecord[], roots?: string[]) {
  const plan = restoreOps(store, version, roots ? { roots, fallbackParent: "p1" } : {});
  if (plan.ops.length > 0) applyTransaction(store, plan.ops);
  return plan;
}

describe("restoring layers", () => {
  it("only reports the layers it brought back: one whose page is gone, with nowhere else, isn't", () => {
    const store = storeWith(page("p1"));
    applyTransaction(store, [
      { op: "create", id: "c", type: "group", parent: "p1", key: "a0", props: { name: "n" } },
    ]);
    const version = snapshot(store);
    applyTransaction(store, [
      { op: "create", id: "p2", type: "page", parent: ROOT_ID, key: "a1", props: {} },
      { op: "delete", id: "p1" },
    ]);
    const plan = restoreOps(store, version, { roots: ["c"], fallbackParent: "p1" });
    expect(plan.restored).toEqual([]);
    expect(plan.ops).toEqual([]);
    // With somewhere to go, it comes back there.
    expect(restoreOps(store, version, { roots: ["c"], fallbackParent: "p2" }).restored).toEqual([
      "c",
    ]);
  });
});

describe("summarizeEdits", () => {
  it("counts each kind of change once per edit", () => {
    expect(
      [
        ...changeKinds([
          { op: "set", id: "a", prop: "fills", value: [] },
          { op: "set", id: "b", prop: "strokes", value: [] },
          { op: "set", id: "a", prop: "characters", value: "Hi" },
        ]),
      ].sort(),
    ).toEqual(["style", "text"]);
    const summary = summarizeEdits([
      [rect("r1", "p1")],
      [{ op: "set", id: "r1", prop: "x", value: 4 }],
      [
        { op: "set", id: "r1", prop: "x", value: 8 },
        { op: "set", id: "r1", prop: "fills", value: [] },
      ],
      [{ op: "delete", id: "r1" }],
      [{ op: "create", id: "v", type: "variable", parent: "c", key: "a0", props: {} }],
    ]);
    expect(summary).toEqual({
      edits: 5,
      kinds: { added: 1, geometry: 2, style: 1, removed: 1, tokens: 1 },
    });
  });
});

describe("sameValue", () => {
  it("compares JSON values by structure, ignoring key order", () => {
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue({ a: undefined }, {})).toBe(false);
    expect(sameValue(null, {})).toBe(false);
    expect(sameValue([], {})).toBe(false);
  });
});

describe("restoreOps: the whole file", () => {
  it("brings back deleted layers, undoes moves and edits, and removes new layers", () => {
    const store = storeWith(
      page("p1"),
      frame("f1", "p1"),
      rect("r1", "f1", "a0", { name: "Card" }),
      rect("r2", "p1", "a1"),
    );
    const version = snapshot(store);

    applyTransaction(store, [
      { op: "delete", id: "f1" },
      { op: "set", id: "r2", prop: "x", value: 40 },
      { op: "set", id: "r2", prop: "name", value: "Renamed" },
      frame("f2", "p1", "a2"),
      { op: "move", id: "r2", parent: "f2", key: "a0" },
      page("p2", "a1"),
    ]);
    const plan = restore(store, version);

    expect(snapshot(store)).toEqual(version);
    expect(plan.dropped).toBe(0);
    // Already restored: nothing more to do.
    expect(restoreOps(store, version).ops).toEqual([]);
  });

  it("swaps a parent and child back without passing through a cycle", () => {
    const store = storeWith(page("p1"), frame("a", "p1"), frame("b", "a"));
    const version = snapshot(store);
    applyTransaction(store, [
      { op: "move", id: "b", parent: "p1", key: "a1" },
      { op: "move", id: "a", parent: "b", key: "a0" },
    ]);
    restore(store, version);
    expect(snapshot(store)).toEqual(version);
  });

  it("keeps the file's pages valid when every page is new", () => {
    const store = storeWith(page("p1"), rect("r1", "p1"));
    const version = snapshot(store);
    applyTransaction(store, [page("p2", "a1"), { op: "delete", id: "p1" }]);
    restore(store, version);
    expect(snapshot(store)).toEqual(version);
  });

  it("leaves out values today's schema refuses", () => {
    const store = storeWith(page("p1"), rect("r1", "p1"));
    const version = snapshot(store).map((node) =>
      node.id === "r1"
        ? { ...node, props: { ...node.props, opacity: 7, retired: true, fills: null } }
        : node,
    ) as NodeRecord[];
    applyTransaction(store, [{ op: "set", id: "r1", prop: "x", value: 5 }]);
    const plan = restore(store, version);
    expect(plan.dropped).toBe(2);
    expect(store.get("r1")?.props).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });
});

describe("restoreOps: some layers", () => {
  it("restores a layer's contents and place, leaving everything else as it is now", () => {
    const store = storeWith(
      page("p1"),
      frame("card", "p1"),
      rect("title", "card", "a0", { name: "Title" }),
      rect("other", "p1", "a1"),
    );
    const version = snapshot(store);
    applyTransaction(store, [
      { op: "set", id: "title", prop: "name", value: "Heading" },
      rect("badge", "card", "a1"),
      { op: "set", id: "other", prop: "x", value: 99 },
      { op: "move", id: "card", parent: "p1", key: "a5" },
    ]);
    const plan = restore(store, version, ["card"]);

    expect(plan.restored).toEqual(["card"]);
    expect(store.get("title")?.props.name).toBe("Title");
    expect(store.get("badge")).toBeUndefined();
    expect(store.get("card")?.key).toBe("a0");
    // Outside the restored layer, today's edits stay.
    expect(store.get("other")?.props.x).toBe(99);
  });

  it("brings back a deleted layer under its old parent", () => {
    const store = storeWith(page("p1"), frame("card", "p1"), rect("title", "card"));
    const version = snapshot(store);
    applyTransaction(store, [{ op: "delete", id: "card" }, rect("new", "p1", "a3")]);
    restore(store, version, ["card"]);
    expect(store.get("card")?.parent).toBe("p1");
    expect(store.get("title")?.parent).toBe("card");
    expect(store.get("new")).toBeDefined();
  });

  it("keeps a layer where it is when its old parent is gone, or uses the fallback page", () => {
    const store = storeWith(
      page("p1"),
      page("p2", "a1"),
      frame("box", "p2"),
      rect("r1", "box"),
      rect("r2", "box", "a1"),
    );
    const version = snapshot(store);
    applyTransaction(store, [
      { op: "move", id: "r1", parent: "p1", key: "a0" },
      { op: "set", id: "r1", prop: "x", value: 3 },
      { op: "delete", id: "p2" },
    ]);
    restore(store, version, ["r1", "r2"]);
    expect(store.get("r1")).toMatchObject({ parent: "p1", props: { x: 0 } });
    expect(store.get("r2")?.parent).toBe("p1");
  });

  it("ignores pages, unknown ids and layers nested in other restored layers", () => {
    const store = storeWith(page("p1"), frame("card", "p1"), rect("title", "card"));
    const version = snapshot(store);
    applyTransaction(store, [{ op: "set", id: "title", prop: "x", value: 3 }]);
    const plan = restoreOps(store, version, { roots: ["p1", "nope", "card", "title"] });
    expect(plan.restored).toEqual(["card"]);
    expect(plan.ops).toEqual([{ op: "set", id: "title", prop: "x", value: 0 }]);
  });
});

/**
 * Random edits over a small id space; invalid ones are skipped. An id always
 * has the same type, as real ids do (they are random and never reused).
 */
const TYPE_OF = {
  p1: "page",
  p2: "page",
  a: "frame",
  b: "frame",
  c: "group",
  d: "group",
  e: "rect",
  f: "rect",
} as const;
const ids = Object.keys(TYPE_OF) as (keyof typeof TYPE_OF)[];
const editArb: fc.Arbitrary<Op> = fc.oneof(
  fc
    .record({
      id: fc.constantFrom(...ids),
      parent: fc.constantFrom(ROOT_ID, ...ids),
      key: fc.constantFrom("a0", "a1", "a2", "Zz"),
      props: fc.oneof(fc.constant({}), fc.constant({ name: "n", opacity: 0.5 })),
    })
    .map(
      ({ id, parent, key, props }): Op => ({
        op: "create",
        id,
        type: TYPE_OF[id],
        parent,
        key,
        props: TYPE_OF[id] === "page" ? {} : props,
      }),
    ),
  fc.record({ op: fc.constant("delete" as const), id: fc.constantFrom(...ids) }),
  fc.record({
    op: fc.constant("set" as const),
    id: fc.constantFrom(...ids),
    prop: fc.constantFrom("x" as const, "name" as const, "opacity" as const, "visible" as const),
    value: fc.oneof(
      fc.constant(null),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.string({ maxLength: 4 }),
      fc.boolean(),
    ),
  }),
  fc.record({
    op: fc.constant("move" as const),
    id: fc.constantFrom(...ids),
    parent: fc.constantFrom(ROOT_ID, ...ids),
    key: fc.constantFrom("a0", "a1", "a3"),
  }),
);

function play(store: MemoryStore, ops: readonly Op[]): void {
  for (const op of ops) {
    try {
      applyOp(store, op);
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
    }
  }
}

function subtree(nodes: readonly NodeRecord[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const n of nodes) if (n.parent === out[i]) out.push(n.id);
  }
  return out.sort();
}

describe("properties", () => {
  it("restoring any version after any edits gives back exactly that version", () => {
    fc.assert(
      fc.property(
        fc.array(editArb, { maxLength: 40 }),
        fc.array(editArb, { maxLength: 40 }),
        (before, after) => {
          const store = storeWith(page("p1"));
          play(store, before);
          const version = snapshot(store);
          play(store, after);
          restore(store, version);
          expect(snapshot(store)).toEqual(version);
          expect(restoreOps(store, version).ops).toEqual([]);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("restoring a layer makes it and everything in it match the version", () => {
    fc.assert(
      fc.property(
        fc.array(editArb, { maxLength: 40 }),
        fc.array(editArb, { maxLength: 40 }),
        fc.constantFrom("a", "b", "c"),
        (before, after, root) => {
          const store = storeWith(page("p1"));
          play(store, before);
          const version = snapshot(store);
          const was = version.find((n) => n.id === root);
          play(store, after);
          let plan: ReturnType<typeof restore>;
          try {
            plan = restore(store, version, [root]);
          } catch (error) {
            // Only a layer rewrapped inside its own old child can't go back in one step.
            expect((error as ModelError).code).toBe("cycle");
            return;
          }
          if (!was || was.type === "page" || was.parent === ROOT_ID) {
            expect(plan.restored).toEqual([]);
            return;
          }
          if (plan.restored.length === 0) return; // Nowhere left to put it.
          const now = snapshot(store);
          expect(subtree(now, root)).toEqual(subtree(version, root));
          for (const id of subtree(version, root)) {
            const v = version.find((n) => n.id === id) as NodeRecord;
            expect(store.get(id)?.props).toEqual(v.props);
            if (id !== root) expect(store.get(id)?.parent).toBe(v.parent);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
