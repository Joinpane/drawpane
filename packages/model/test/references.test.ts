/**
 * Copy references a transaction leaves stale are fixed by the room, as a
 * transaction of its own (review 8 of #209): applying a transaction never
 * changes a reference it didn't name, so a refused one leaves the file as
 * it was (B4), and every reader of the log, older code included, applies
 * the same operations (B3).
 */
import { describe, expect, it } from "vitest";
import {
  applyTransaction,
  MemoryStore,
  type NodeRecord,
  type Op,
  ROOT_ID,
  referenceFixes,
} from "../src";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown>,
): NodeRecord => ({ id, type, parent, key, props: props as NodeRecord["props"] });

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Leaf (a text); main A holding an instance of Leaf; an instance of A, its copy materialized. */
const kit = () => [
  node("p", "page", ROOT_ID, "a0", {}),
  node("leaf", "frame", "p", "a0", { isComponent: true }),
  node("t", "text", "leaf", "a0", { characters: "Base" }),
  node("a", "frame", "p", "a1", { isComponent: true }),
  node("na", "frame", "a", "a0", { instanceOf: "leaf" }),
  node("nat", "text", "na", "a0", { mirrors: "t", characters: "Base" }),
  node("i", "frame", "p", "a2", { instanceOf: "a" }),
  node("ni", "frame", "i", "a0", { mirrors: "na", instanceOf: "leaf" }),
  node("nit", "text", "ni", "a0", { mirrors: "nat", characters: "Base" }),
];

describe("applying a transaction never fixes references by itself", () => {
  it("leaves every reference as it was when it's refused (B4)", () => {
    const store = new MemoryStore(kit());
    const before = clone([...store.nodes()]);
    expect(() =>
      applyTransaction(store, [
        // Detaching the nested copy would leave its text copying the outer main's layer...
        { op: "set", id: "ni", prop: "mirrors", value: null },
        // ...but the transaction is refused: Leaf can't hold an instance of itself.
        {
          op: "create",
          id: "bad",
          type: "frame",
          parent: "leaf",
          key: "a1",
          props: { instanceOf: "leaf" },
        },
      ]),
    ).toThrow(/contain an instance of itself/);
    expect([...store.nodes()]).toEqual(before);
  });

  it("applies a delayed rebuild as it was sent, as code from before does (B3)", () => {
    // The nested copy detached (it follows Leaf on its own), then a rebuild made before that
    // arrives, copying the outer main's layer.
    const nodes = kit()
      .filter((n) => n.id !== "nit")
      .map((n) => (n.id === "ni" ? { ...n, props: { instanceOf: "leaf" } } : n));
    const store = new MemoryStore(clone(nodes));
    const rebuild: Op[] = [
      {
        op: "create",
        id: "nit",
        type: "text",
        parent: "ni",
        key: "a0",
        props: { mirrors: "nat", characters: "Accepted" },
      },
    ];
    applyTransaction(store, rebuild);
    expect(store.get("nit")?.props.mirrors).toBe("nat");
    // What the room then commits on its own: the fix, an operation every reader applies.
    expect(referenceFixes(store, rebuild)).toEqual([
      { op: "set", id: "nit", prop: "mirrors", value: "t" },
    ]);
  });
});

describe("referenceFixes", () => {
  it("fixes a two-level rebuild parents first, each layer copying its parent's main layer", () => {
    // Deep: Leaf holds an instance of Deep; the outer copy's Leaf copy is rebuilt copying the
    // wrong main's layers two levels down.
    const nodes = [
      node("p", "page", ROOT_ID, "a0", {}),
      node("deep", "frame", "p", "a0", { isComponent: true }),
      node("dt", "text", "deep", "a0", { characters: "Deep" }),
      node("leaf", "frame", "p", "a1", { isComponent: true }),
      node("ln", "frame", "leaf", "a0", { instanceOf: "deep" }),
      node("lnt", "text", "ln", "a0", { mirrors: "dt", characters: "Deep" }),
      node("a", "frame", "p", "a2", { isComponent: true }),
      node("na", "frame", "a", "a0", { instanceOf: "leaf" }),
      node("nan", "frame", "na", "a0", { instanceOf: "deep", mirrors: "ln" }),
      node("nant", "text", "nan", "a0", { mirrors: "lnt", characters: "Deep" }),
      // Detached from A: the nested Leaf instance follows Leaf, but its layers were made from A's.
      node("i", "frame", "p", "a3", {}),
      node("ni", "frame", "i", "a0", { instanceOf: "leaf" }),
    ];
    const store = new MemoryStore(clone(nodes));
    const rebuild: Op[] = [
      {
        op: "create",
        id: "nni",
        type: "frame",
        parent: "ni",
        key: "a0",
        props: { instanceOf: "deep", mirrors: "nan" },
      },
      {
        op: "create",
        id: "nnit",
        type: "text",
        parent: "nni",
        key: "a0",
        props: { mirrors: "nant", characters: "Deep" },
      },
    ];
    applyTransaction(store, rebuild);
    const fixes = referenceFixes(store, rebuild);
    expect(fixes).toEqual([
      { op: "set", id: "nni", prop: "mirrors", value: "ln" },
      { op: "set", id: "nnit", prop: "mirrors", value: "lnt" },
    ]);
    applyTransaction(store, fixes);
    // Fixed, there's nothing more to fix.
    expect(referenceFixes(store, rebuild)).toEqual([]);
  });

  it("finds nothing to fix where every reference copies a child of what its parent copies", () => {
    const store = new MemoryStore(kit());
    expect(
      referenceFixes(store, [{ op: "set", id: "ni", prop: "instanceOf", value: "leaf" }]),
    ).toEqual([]);
  });
});
