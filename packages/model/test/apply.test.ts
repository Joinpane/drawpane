import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyOp,
  applyTransaction,
  keyBetween,
  MemoryStore,
  ModelError,
  type NodeRecord,
  type Op,
  ROOT_ID,
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

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).code).toBe(code);
    return;
  }
  throw new Error(`expected ModelError ${code}`);
}

describe("applyOp", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
    applyTransaction(store, [page("p1"), frame("f1", "p1"), rect("r1", "f1")]);
  });

  it("creates nodes in sibling order", () => {
    applyOp(store, rect("r0", "f1", keyBetween(null, "a0")));
    applyOp(store, rect("r2", "f1", "a1"));
    expect(store.childIds("f1")).toEqual(["r0", "r1", "r2"]);
  });

  it("breaks key ties by id", () => {
    applyOp(store, rect("rb", "p1", "a5"));
    applyOp(store, rect("ra", "p1", "a5"));
    expect(store.childIds("p1")).toEqual(["f1", "ra", "rb"]);
  });

  it("rejects unknown and misplaced properties and bad values", () => {
    expectCode(
      () => applyOp(store, { op: "set", id: "r1", prop: "nope" as never, value: 1 }),
      "invalid_prop",
    );
    expectCode(
      () => applyOp(store, { op: "set", id: "r1", prop: "gap", value: 1 }),
      "invalid_prop",
    );
    expectCode(
      () => applyOp(store, { op: "set", id: "r1", prop: "width", value: -1 }),
      "invalid_value",
    );
    expectCode(
      () =>
        applyOp(store, {
          op: "set",
          id: "r1",
          prop: "fills",
          value: [{ type: "solid", color: "red" }],
        }),
      "invalid_value",
    );
    expectCode(
      () => applyOp(store, { op: "set", id: "r1", prop: "x", value: Number.NaN }),
      "invalid_value",
    );
  });

  it("resets a property to its default with null", () => {
    applyOp(store, { op: "set", id: "r1", prop: "opacity", value: 0.5 });
    expect(store.get("r1")?.props.opacity).toBe(0.5);
    const inverse = applyOp(store, { op: "set", id: "r1", prop: "opacity", value: null });
    expect(store.get("r1")?.props).not.toHaveProperty("opacity");
    expect(inverse).toEqual([{ op: "set", id: "r1", prop: "opacity", value: 0.5 }]);
  });

  it("enforces nesting rules", () => {
    expectCode(() => applyOp(store, rect("r9", "r1")), "invalid_parent");
    expectCode(() => applyOp(store, rect("r9", ROOT_ID)), "invalid_parent");
    expectCode(
      () => applyOp(store, page("p9", "a1") && ({ ...page("p9"), parent: "f1" } as Op)),
      "invalid_parent",
    );
    expectCode(() => applyOp(store, rect("r9", "missing")), "not_found");
  });

  it("rejects duplicate ids, bad ids and bad keys", () => {
    expectCode(() => applyOp(store, rect("r1", "f1", "a2")), "already_exists");
    expectCode(() => applyOp(store, rect("root", "f1", "a2")), "invalid_id");
    expectCode(() => applyOp(store, rect("r5", "f1", "a00")), "invalid_key");
  });

  it("refuses to move a node inside itself", () => {
    applyOp(store, frame("f2", "f1", "a1"));
    expectCode(() => applyOp(store, { op: "move", id: "f1", parent: "f2", key: "a0" }), "cycle");
    expectCode(() => applyOp(store, { op: "move", id: "f1", parent: "f1", key: "a0" }), "cycle");
  });

  it("deletes whole subtrees and restores them with the inverse", () => {
    applyOp(store, frame("f2", "f1", "a1"));
    applyOp(store, rect("r2", "f2"));
    const before = snapshot(store);
    const inverse = applyOp(store, { op: "delete", id: "f1" });
    expect(store.has("r2")).toBe(false);
    expect(store.childIds("p1")).toEqual([]);
    applyTransaction(store, inverse);
    expect(snapshot(store)).toEqual(before);
    expect(store.childIds("f1")).toEqual(["r1", "f2"]);
  });

  it("keeps at least one page", () => {
    expectCode(() => applyOp(store, { op: "delete", id: "p1" }), "last_page");
    applyOp(store, page("p2", "a1"));
    applyOp(store, { op: "delete", id: "p1" });
    expect(store.pageIds()).toEqual(["p2"]);
  });
});

describe("applyTransaction", () => {
  it("is all-or-nothing", () => {
    const store = new MemoryStore();
    applyTransaction(store, [page("p1"), rect("r1", "p1")]);
    const before = snapshot(store);
    try {
      applyTransaction(store, [
        { op: "set", id: "r1", prop: "x", value: 50 },
        rect("r2", "p1", "a1"),
        { op: "delete", id: "r1" },
        { op: "set", id: "r1", prop: "x", value: 1 },
      ]);
      throw new Error("should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).opIndex).toBe(3);
    }
    expect(snapshot(store)).toEqual(before);
  });

  it("can roll back a transaction that created the only page", () => {
    const store = new MemoryStore();
    expect(() => applyTransaction(store, [page("p1"), rect("r1", "nope")])).toThrow(ModelError);
    expect(store.size).toBe(0);
  });
});

/** Random valid-or-invalid operations over a small id space, to stress apply and undo. */
const ids = ["p1", "p2", "a", "b", "c", "d", "e"];
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    op: fc.constant("create" as const),
    id: fc.constantFrom(...ids),
    type: fc.constantFrom("frame" as const, "group" as const, "rect" as const, "page" as const),
    parent: fc.constantFrom(ROOT_ID, ...ids),
    key: fc.constantFrom("a0", "a1", "a2", "Zz"),
    props: fc.constant({}),
  }),
  fc.record({ op: fc.constant("delete" as const), id: fc.constantFrom(...ids) }),
  fc.record({
    op: fc.constant("set" as const),
    id: fc.constantFrom(...ids),
    prop: fc.constantFrom("x" as const, "name" as const, "opacity" as const),
    value: fc.oneof(fc.constant(null), fc.double({ min: 0, max: 1, noNaN: true }), fc.string()),
  }),
  fc.record({
    op: fc.constant("move" as const),
    id: fc.constantFrom(...ids),
    parent: fc.constantFrom(ROOT_ID, ...ids),
    key: fc.constantFrom("a0", "a1", "a3"),
  }),
);

describe("properties", () => {
  it("undo restores the exact previous state, and failures change nothing", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(opArb, { minLength: 1, maxLength: 6 }), { maxLength: 30 }),
        (txns) => {
          const store = new MemoryStore();
          applyTransaction(store, [page("p1")]);
          for (const ops of txns) {
            const before = snapshot(store);
            let inverse: Op[];
            try {
              inverse = applyTransaction(store, ops);
            } catch (error) {
              expect(error).toBeInstanceOf(ModelError);
              expect(snapshot(store)).toEqual(before);
              continue;
            }
            const after = snapshot(store);
            applyTransaction(store, inverse);
            expect(snapshot(store)).toEqual(before);
            // Redo by replaying the original ops.
            applyTransaction(store, ops);
            expect(snapshot(store)).toEqual(after);
            // Invariants: every node's parent exists and the tree has no cycles.
            for (const node of store.nodes()) {
              expect(node.parent === ROOT_ID || store.has(node.parent)).toBe(true);
              const seen = new Set<string>();
              for (let at = node.id; at !== ROOT_ID; at = store.get(at)?.parent ?? ROOT_ID) {
                expect(seen.has(at)).toBe(false);
                seen.add(at);
              }
            }
            expect(store.pageIds().length).toBeGreaterThanOrEqual(1);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
