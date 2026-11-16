/**
 * A main that contains an instance of itself (decision 0029): the model
 * refuses making one on every path, and a file that holds one from before
 * is presented without looping, and within a build budget.
 */
import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyTransaction,
  BuildBudget,
  BuildTooLarge,
  CopyView,
  copyId,
  MemoryStore,
  ModelError,
  type NodeRecord,
  type Op,
  OVERRIDE_KEY,
  type Props,
} from "../src/index";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: Props = {},
  key = "a0",
) => ({ id, type, parent, key, props }) as NodeRecord;

/** Two mains on a page: A (with a rectangle) and B (with an instance of A). */
function file(): MemoryStore {
  return new MemoryStore([
    node("Pg", "page", "root"),
    node("A", "frame", "Pg", { isComponent: true }, "a0"),
    node("R", "rect", "A"),
    node("B", "frame", "Pg", { isComponent: true }, "a1"),
    node("IA", "frame", "B", { instanceOf: "A" }),
    node("Box", "frame", "Pg", {}, "a2"),
    node("IB", "frame", "Box", { instanceOf: "B" }),
  ]);
}

function refuses(store: MemoryStore, ops: Op[]): void {
  const before = JSON.stringify([...store.nodes()]);
  let error: unknown;
  try {
    applyTransaction(store, ops);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ModelError);
  expect((error as ModelError).code).toBe("cycle");
  // Nothing changed.
  expect(JSON.stringify([...store.nodes()])).toBe(before);
}

describe("an instance inside its own main", () => {
  it("is refused when created in the main itself", () => {
    refuses(file(), [
      { op: "create", id: "X", type: "frame", parent: "A", key: "a5", props: { instanceOf: "A" } },
    ]);
  });

  it("is refused when created in a main the instance's main contains", () => {
    // B contains an instance of A; an instance of B inside A would contain itself.
    refuses(file(), [
      { op: "create", id: "X", type: "frame", parent: "A", key: "a5", props: { instanceOf: "B" } },
    ]);
    // Deeper: inside a frame inside A.
    const store = file();
    applyTransaction(store, [
      { op: "create", id: "F", type: "frame", parent: "A", key: "a5", props: {} },
    ]);
    refuses(store, [
      { op: "create", id: "X", type: "frame", parent: "F", key: "a0", props: { instanceOf: "B" } },
    ]);
  });

  it("is refused when an instance is relinked to make one", () => {
    const store = file();
    applyTransaction(store, [
      { op: "create", id: "X", type: "frame", parent: "A", key: "a5", props: {} },
    ]);
    refuses(store, [{ op: "set", id: "X", prop: "instanceOf", value: "B" }]);
    // Relinking B's instance of A to B: B in B.
    refuses(file(), [{ op: "set", id: "IA", prop: "instanceOf", value: "B" }]);
  });

  it("is refused when moved into a main it's built from", () => {
    refuses(file(), [{ op: "move", id: "IB", parent: "A", key: "a5" }]);
    // A frame holding the instance, moved: what's inside counts.
    refuses(file(), [{ op: "move", id: "Box", parent: "A", key: "a5" }]);
  });

  it("is refused when a frame becomes a main that its own layers are built from", () => {
    // Making Box (which holds an instance of B) a main is fine.
    applyTransaction(file(), [{ op: "set", id: "Box", prop: "isComponent", value: true }]);
    // C holds an instance of D while D isn't a main yet, and D holds one of C: making D a main
    // closes the loop.
    const loop = new MemoryStore([
      node("Pg", "page", "root"),
      node("C", "frame", "Pg", { isComponent: true }, "a0"),
      node("ID", "frame", "C", { instanceOf: "D" }),
      node("D", "frame", "Pg", {}, "a1"),
      node("IC", "frame", "D", { instanceOf: "C" }),
    ]);
    refuses(loop, [{ op: "set", id: "D", prop: "isComponent", value: true }]);
  });

  it("is refused when a main is made an instance of what contains it", () => {
    // A main that's an instance of B is made of B's layers, which hold an instance of A.
    refuses(file(), [{ op: "set", id: "A", prop: "instanceOf", value: "B" }]);
  });

  it("is refused when an override record swaps a copy to the main it's in", () => {
    // Compact copies: M's instance of N has a copy of NF; a record swapping that copy to M.
    const store = new MemoryStore([
      node("Pg", "page", "root"),
      node("N", "frame", "Pg", { isComponent: true }, "a0"),
      node("NF", "frame", "N"),
      node("M", "frame", "Pg", { isComponent: true }, "a1"),
      node("IN", "frame", "M", { instanceOf: "N" }),
    ]);
    const id = copyId("IN", ["NF"]);
    refuses(store, [
      {
        op: "create",
        id,
        type: "override",
        parent: "IN",
        key: OVERRIDE_KEY,
        props: { path: ["NF"], instanceOf: "M" } as Props,
      },
    ]);
  });

  it("still takes what makes no loop, and applyOp refuses alike", () => {
    const store = file();
    // An instance of A inside B (B already holds one), and of B on a page.
    applyTransaction(store, [
      { op: "create", id: "X", type: "frame", parent: "B", key: "a5", props: { instanceOf: "A" } },
      { op: "create", id: "Y", type: "frame", parent: "Pg", key: "a9", props: { instanceOf: "B" } },
      { op: "move", id: "IB", parent: "Pg", key: "a8" },
    ]);
    expect(() =>
      applyOp(store, {
        op: "create",
        id: "Z",
        type: "frame",
        parent: "A",
        key: "a7",
        props: { instanceOf: "A" },
      }),
    ).toThrow(ModelError);
    expect(store.get("Z")).toBeUndefined();
  });

  it("puts back a loop the file held when a failed transaction rolls back", () => {
    // A file from before the check: A holds an instance of itself. Deleting it, then failing, puts it back.
    const store = file();
    store.insert(node("Self", "frame", "A", { instanceOf: "A" }, "a9"));
    expect(() =>
      applyTransaction(store, [
        { op: "delete", id: "Self" },
        { op: "delete", id: "NoSuchNode" },
      ]),
    ).toThrow(ModelError);
    expect(store.get("Self")?.props.instanceOf).toBe("A");
  });

  it("isn't checked for held operations unless asked (the room asks)", () => {
    const store = file();
    const create: Op = {
      op: "create",
      id: "X",
      type: "frame",
      parent: "A",
      key: "a5",
      props: { instanceOf: "A" },
    };
    applyTransaction(store, [create], { held: true });
    expect(store.get("X")).toBeDefined();
    const room = file();
    expect(() => applyTransaction(room, [create], { held: true, cycles: true })).toThrow(
      ModelError,
    );
  });
});

describe("what a transaction leaves (the fifth review)", () => {
  /** A holds IB (an instance of B); B is empty. */
  const current = () =>
    new MemoryStore([
      node("Pg", "page", "root"),
      node("A", "frame", "Pg", { isComponent: true }, "a0"),
      node("IB", "frame", "A", { instanceOf: "B" }),
      node("B", "frame", "Pg", { isComponent: true }, "a1"),
    ]);
  const createIA: Op = {
    op: "create",
    id: "IA",
    type: "frame",
    parent: "B",
    key: "a0",
    props: { instanceOf: "A" },
  };

  it("takes a restore that passes through a loop on the way to a file without one", () => {
    // The version has B holding IA and no IB: a restore creates IA, then deletes IB.
    const store = current();
    applyTransaction(store, [createIA, { op: "delete", id: "IB" }], { held: true, cycles: true });
    expect(store.get("IA")?.parent).toBe("B");
    expect(store.get("IB")).toBeUndefined();
    // Checked by the caller, the same way.
    const room = current();
    const candidates: Array<[string, boolean]> = [];
    applyTransaction(room, [createIA, { op: "delete", id: "IB" }], {
      held: true,
      cycles: { add: (id, deep) => candidates.push([id, deep]) },
    });
    expect(candidates).toEqual([["IA", false]]);
  });

  it("refuses one that ends in a loop, naming the operation, and changes nothing", () => {
    const store = current();
    const before = JSON.stringify([...store.nodes()]);
    let error: unknown;
    try {
      applyTransaction(store, [{ op: "set", id: "Pg", prop: "name", value: "Renamed" }, createIA]);
    } catch (caught) {
      error = caught;
    }
    expect((error as ModelError).code).toBe("cycle");
    expect((error as ModelError).opIndex).toBe(1);
    expect(JSON.stringify([...store.nodes()])).toBe(before);
  });
});

/** A main holding `n` instances of itself, and an instance of it on the page (written as files from before held it). */
function selfHolding(n: number): MemoryStore {
  const nodes = [node("Pg", "page", "root"), node("M", "frame", "Pg", { isComponent: true })];
  for (let i = 0; i < n; i++)
    nodes.push(node(`S${i}`, "frame", "M", { instanceOf: "M" }, `a${String.fromCharCode(48 + i)}`));
  nodes.push(node("Inst", "frame", "Pg", { instanceOf: "M" }, "a1"));
  return new MemoryStore(nodes);
}

function presented(view: CopyView, id: string): number {
  let n = 0;
  const stack = [...view.childIds(id)];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    n++;
    stack.push(...view.childIds(at));
  }
  return n;
}

describe("presenting a file that holds a main containing its own instance", () => {
  it("builds its instances without layers, however many it holds", () => {
    for (const n of [1, 10, 14, 40]) {
      const view = new CopyView(selfHolding(n));
      // The instance shows nothing (its main contains itself); the main shows its instances, empty.
      expect(presented(view, "Inst")).toBe(0);
      expect(presented(view, "M")).toBe(n);
      expect(view.cyclic("M")).toBe(true);
    }
  });

  it("finds loops through other mains, and through a record's swap", () => {
    const store = new MemoryStore([
      node("Pg", "page", "root"),
      node("P", "frame", "Pg", { isComponent: true }, "a0"),
      node("IQ", "frame", "P", { instanceOf: "Q" }),
      node("Q", "frame", "Pg", { isComponent: true }, "a1"),
      node("IP", "frame", "Q", { instanceOf: "P" }),
      node("U", "frame", "Pg", { isComponent: true }, "a2"),
      node("IP2", "frame", "U", { instanceOf: "P" }),
      node("Inst", "frame", "Pg", { instanceOf: "U" }, "a3"),
    ]);
    const view = new CopyView(store);
    expect(view.cyclic("P")).toBe(true);
    expect(view.cyclic("Q")).toBe(true);
    // U holds an instance of P but isn't in the loop: its instance shows that copy, empty.
    expect(view.cyclic("U")).toBe(false);
    expect(presented(view, "Inst")).toBe(1);
  });

  it("works it out again when the loop is taken apart", () => {
    const store = selfHolding(3);
    const view = new CopyView(store);
    expect(presented(view, "Inst")).toBe(0);
    for (const id of ["S0", "S1", "S2"]) store.remove(id);
    store.insert(node("Rect", "rect", "M"));
    view.forget(["M"], ["M"]);
    expect(view.cyclic("M")).toBe(false);
    expect(presented(view, "Inst")).toBe(1);
  });
});

describe("a build budget", () => {
  /** Mains M0 … Mn, each Mj holding an instance of Mj-1, and an instance of Mn on the page. */
  function chain(depth: number): MemoryStore {
    const nodes = [node("Pg", "page", "root"), node("M0", "frame", "Pg", { isComponent: true })];
    nodes.push(node("R", "rect", "M0"));
    for (let j = 1; j <= depth; j++) {
      nodes.push(node(`M${j}`, "frame", "Pg", { isComponent: true }, "a0"));
      nodes.push(node(`I${j}`, "frame", `M${j}`, { instanceOf: `M${j - 1}` }));
    }
    nodes.push(node("Inst", "frame", "Pg", { instanceOf: `M${depth}` }, "a1"));
    return new MemoryStore(nodes);
  }

  it("counts the copies of nested mains it builds on the way, and their paths", () => {
    // Inst presents 401 layers, but building it builds every nested instance in turn: about
    // 80,000 slots and ten million path entries. A budget of 16 MB stops it, typed.
    const budget = new BuildBudget({ bytes: 16 * 1024 * 1024 });
    const view = new CopyView(chain(400), { lazy: true, budget });
    expect(() => presented(view, "Inst")).toThrow(BuildTooLarge);
    // Everything it built is let go of, and given back.
    expect(view.held).toBe(0);
    expect(budget.held).toBe(0);
    expect(view.slotCount).toBe(0);
  });

  it("is charged as it builds and given back as it lets go", () => {
    const budget = new BuildBudget({ bytes: 64 * 1024 * 1024 });
    const view = new CopyView(chain(20), { lazy: true, budget });
    expect(presented(view, "Inst")).toBe(21);
    expect(budget.held).toBeGreaterThan(0);
    expect(budget.held).toBe(view.held);
    view.release("Inst");
    expect(budget.held).toBeLessThan(budget.peak);
    view.clear();
    expect(budget.held).toBe(0);
  });

  it("bounds the layers built in all", () => {
    const budget = new BuildBudget({ bytes: Number.POSITIVE_INFINITY, layers: 100 });
    const view = new CopyView(chain(20), { lazy: true, budget });
    expect(() => presented(view, "Inst")).toThrow(BuildTooLarge);
  });
});
