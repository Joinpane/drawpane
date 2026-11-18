/**
 * The sixth review of component properties (#187 at 3b7fcee), as tests.
 *
 * A: no instance without a record reaches a client: the room migrates a
 * file from before records once, and every path content comes in by folds
 * it; a merge compares a record's presence as part of it.
 *
 * B: copy references are derived top-down by origin (`resolveMirrors`): each
 * layer under an instance copies a child of what its parent copies, the one
 * whose copy chain ends at the same main layer as its own reference, parents
 * before children, on what a transaction leaves. One level deeper than
 * review 5's schedule, and the undo of a detach after a delayed swap undo,
 * which needs the outer link back.
 */
import { Doc, instanceValues } from "@drawpane/editor";
import {
  applyTransaction,
  branchChanges,
  compactByInstance,
  MemoryStore,
  mergeOps,
  migrateRecords,
  type NodeRecord,
  needsRecord,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import {
  deepKit,
  expectAgreement,
  FORMS,
  legacy,
  nested,
  node,
  open,
  Room,
  simple,
} from "./property-rooms";

describe("review 6, B: copy references by origin, parents first", () => {
  it("a transaction recreating two levels of delayed copies repairs parents before children", () => {
    const nodes = [
      { id: "p", type: "page", parent: "root", key: "a0", props: {} },
      { id: "deep", type: "frame", parent: "p", key: "a0", props: { isComponent: true } },
      { id: "dt", type: "text", parent: "deep", key: "a0", props: { characters: "Deep" } },
      { id: "leaf", type: "frame", parent: "p", key: "a1", props: { isComponent: true } },
      { id: "ln", type: "frame", parent: "leaf", key: "a0", props: { instanceOf: "deep" } },
      {
        id: "lnt",
        type: "text",
        parent: "ln",
        key: "a0",
        props: { mirrors: "dt", characters: "Deep" },
      },
      { id: "a", type: "frame", parent: "p", key: "a2", props: { isComponent: true } },
      { id: "na", type: "frame", parent: "a", key: "a0", props: { instanceOf: "leaf" } },
      {
        id: "nan",
        type: "frame",
        parent: "na",
        key: "a0",
        props: { instanceOf: "deep", mirrors: "ln" },
      },
      {
        id: "nant",
        type: "text",
        parent: "nan",
        key: "a0",
        props: { mirrors: "lnt", characters: "Deep" },
      },
      // Outer already detached: ni follows Leaf directly, its old copy links absent.
      { id: "i", type: "frame", parent: "p", key: "a3", props: {} },
      { id: "ni", type: "frame", parent: "i", key: "a0", props: { instanceOf: "leaf" } },
    ] as NodeRecord[];
    const store = new MemoryStore(nodes);
    applyTransaction(store, [
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
    ]);
    expect(store.get("nni")?.props.mirrors).toBe("ln");
    expect(store.get("nnit")?.props.mirrors).toBe("lnt");
    expect(compactByInstance([...store.nodes()]).detached.size).toBe(0);
  });

  it("deep nested swap undo after another client's detach preserves every nested component link", () => {
    const initial = deepKit();
    expect([...compactByInstance(initial).detached]).toEqual([]);
    const room = new Room(initial, "materialized");
    const a = room.join("a");
    room.join("b");
    const c = room.join("c");
    c.editor.swapInstance("ni", "other");
    a.editor.select(["i"]);
    a.editor.detachInstances();
    c.editor.undo();
    room.settle();
    const converted = compactByInstance([...room.store.nodes()]);
    expectAgreement(room, "i");
    expect([...converted.detached]).toEqual([]);
  });

  it("undoing detach after a delayed swap undo restores references changed implicitly", () => {
    const room = new Room(
      [
        ...nested(),
        node("other", "frame", "p", "a4", { isComponent: true, width: 10, height: 10 }),
        node("ot", "ellipse", "other", "a0", { width: 10, height: 10 }),
      ],
      "materialized",
    );
    const a = room.join("a");
    const c = room.join("c");
    c.editor.swapInstance("ni", "other");
    room.settle();
    a.editor.select(["i"]);
    a.editor.detachInstances();
    room.settle();
    c.editor.undo();
    room.settle();
    expect([...compactByInstance([...room.store.nodes()]).detached]).toEqual([]);
    a.editor.undo();
    room.settle();
    const converted = compactByInstance([...room.store.nodes()]);
    expectAgreement(room, "i");
    expect([...converted.detached]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Merges: a record's presence is part of the field

describe("review 6, the merge planner: a record that exists differs from none", () => {
  /** Three stores of `simple`, the instance's record as each side has it (undefined: none). */
  const sides = (
    base: Record<string, unknown> | undefined,
    main: Record<string, unknown> | undefined,
    branch: Record<string, unknown> | undefined,
  ) => {
    const at = (record: Record<string, unknown> | undefined) =>
      new MemoryStore(
        simple().map((n) => {
          if (n.id !== "i") return n;
          const { propValues: _, ...props } = n.props;
          return { ...n, props: (record ? { ...props, propValues: record } : props) as never };
        }),
      );
    return { base: at(base), main: at(main), branch: at(branch) };
  };

  it("a branch making an empty record is a change main takes", () => {
    const { base, main, branch } = sides(undefined, undefined, {});
    const changes = branchChanges(base, branch, main);
    expect(changes).toEqual([
      expect.objectContaining({ id: "i", field: "propValues", conflict: false }),
    ]);
    applyTransaction(main, mergeOps(main, branch, changes));
    expect(main.get("i")?.props.propValues).toEqual({});
  });

  it("both sides making a record differently conflicts, main's kept until resolved", () => {
    // Review 6, finding 2's shape: main folded Label and set Show; the branch's reset left {}.
    const { base, main, branch } = sides(undefined, { label: "Before", show: false }, {});
    const changes = branchChanges(base, branch, main);
    expect(changes).toEqual([
      expect.objectContaining({ id: "i", field: "propValues", conflict: true }),
    ]);
    applyTransaction(main, mergeOps(main, branch, changes));
    expect(main.get("i")?.props.propValues).toEqual({ label: "Before", show: false });
    applyTransaction(main, mergeOps(main, branch, changes, new Map([["i:propValues", "branch"]])));
    expect(main.get("i")?.props.propValues).toEqual({});
  });

  it("both sides making the same record is a change that doesn't conflict, and changes nothing", () => {
    const { base, main, branch } = sides(undefined, {}, {});
    const changes = branchChanges(base, branch, main);
    expect(changes).toEqual([
      expect.objectContaining({ id: "i", field: "propValues", conflict: false }),
    ]);
    applyTransaction(main, mergeOps(main, branch, changes));
    expect(main.get("i")?.props.propValues).toEqual({});
  });

  it("entries of records on both sides still merge one at a time", () => {
    const { base, main, branch } = sides({ label: "B" }, { label: "B", show: false }, {});
    const changes = branchChanges(base, branch, main);
    expect(changes).toEqual([
      expect.objectContaining({ id: "i", field: "propValues", key: "label", conflict: false }),
    ]);
    applyTransaction(main, mergeOps(main, branch, changes));
    expect(main.get("i")?.props.propValues).toEqual({ show: false });
  });

  it("a branch's entry change where main took the record away conflicts", () => {
    const { base, main, branch } = sides({ label: "B" }, undefined, { label: "C" });
    expect(branchChanges(base, branch, main)).toEqual([
      expect.objectContaining({ id: "i", field: "propValues", key: "label", conflict: true }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// A: no instance without a record reaches a client

describe("review 6, A: instances from before records are migrated once, before anyone reads them", () => {
  it("two clients' first edits of an instance from before records both stay (finding 1)", () => {
    // The room migrated the file as it loaded: neither client folds, so neither overwrites.
    const room = new Room(legacy(), "materialized");
    const a = room.join("a");
    const b = room.join("b");
    expect(room.store.get("i")?.props.propValues).toEqual({ label: "Before", show: true });
    a.editor.setInstanceProperty("i", "label", "A accepted");
    b.editor.setInstanceProperty("i", "show", false);
    a.editor.sync.flush();
    b.editor.sync.flush();
    room.settle();
    expect(room.rejected).toEqual([]);
    expectAgreement(room, "i");
    expect(room.store.get("i")?.props.propValues).toEqual({ label: "A accepted", show: false });
  });

  it("keeps every value past the record's bounds, unlinking its layer (finding 6)", () => {
    const large = ["1".repeat(150_000), "2".repeat(150_000), "3".repeat(150_000)];
    const nodes: NodeRecord[] = [
      node("p", "page", ROOT_ID, "a0", {}),
      node("m", "frame", "p", "a0", {
        isComponent: true,
        width: 100,
        height: 30,
        componentProps: ["one", "two", "three"].map((id) => ({ id, name: id, type: "text" })),
      }),
      ...["one", "two", "three"].map((id, i) =>
        node(`t${i}`, "text", "m", `a${i}`, { characters: "Base", propRefs: { characters: id } }),
      ),
      node("i", "frame", "p", "a1", { instanceOf: "m", width: 100, height: 30 }),
      ...["one", "two", "three"].map((id, i) =>
        node(`it${i}`, "text", "i", `a${i}`, {
          mirrors: `t${i}`,
          characters: large[i],
          propRefs: { characters: id },
          overrides: ["characters"],
        }),
      ),
    ];
    const room = new Room(nodes, "materialized");
    const a = room.join("a");
    // The third didn't fit with the first two: its layer is unlinked, keeping its text.
    expect(Object.keys(room.store.get("i")?.props.propValues ?? {})).toEqual(["one", "two"]);
    expect(room.store.get("it2")?.props.propRefs).toEqual({});
    a.editor.setInstanceProperty("i", "one", "Changed");
    room.settle();
    expect(room.rejected).toEqual([]);
    expect(a.editor.doc.get("it2")?.props.characters === large[2]).toBe(true);
    expect(a.editor.doc.get("it1")?.props.characters === large[1]).toBe(true);
    expect(a.editor.doc.get("it0")?.props.characters).toBe("Changed");
  });

  it("keeps a second layer that disagrees on the same property, unlinking it (finding 6)", () => {
    const nodes: NodeRecord[] = [
      node("p", "page", ROOT_ID, "a0", {}),
      node("m", "frame", "p", "a0", {
        isComponent: true,
        width: 100,
        height: 30,
        componentProps: [
          { id: "label", name: "Label", type: "text" },
          { id: "show", name: "Show", type: "boolean" },
        ],
      }),
      node("t1", "text", "m", "a0", { characters: "Base", propRefs: { characters: "label" } }),
      node("t2", "text", "m", "a1", { characters: "Base", propRefs: { characters: "label" } }),
      node("v", "rect", "m", "a2", { width: 10, height: 10, propRefs: { visible: "show" } }),
      node("i", "frame", "p", "a1", { instanceOf: "m", width: 100, height: 30 }),
      node("it1", "text", "i", "a0", {
        mirrors: "t1",
        characters: "First accepted",
        propRefs: { characters: "label" },
        overrides: ["characters"],
      }),
      node("it2", "text", "i", "a1", {
        mirrors: "t2",
        characters: "Second accepted",
        propRefs: { characters: "label" },
        overrides: ["characters"],
      }),
      node("iv", "rect", "i", "a2", {
        mirrors: "v",
        width: 10,
        height: 10,
        propRefs: { visible: "show" },
      }),
    ];
    const room = new Room(nodes, "materialized");
    const a = room.join("a");
    a.editor.setInstanceProperty("i", "show", false);
    room.settle();
    expect(room.rejected).toEqual([]);
    expect(room.store.get("i")?.props.propValues).toEqual({ label: "First accepted", show: false });
    expect(a.editor.doc.get("it2")?.props.characters).toBe("Second accepted");
    expect(a.editor.doc.get("it1")?.props.characters).toBe("First accepted");
  });

  it("migrates once: every instance gets a record, and a second run changes nothing", () => {
    const once = migrateRecords(legacy());
    expect(once.migrated).toBe(1);
    expect(once.nodes.find((n) => n.id === "i")?.props.propValues).toEqual({
      label: "Before",
      show: true,
    });
    // Nested instances in mains keep records of their own, empty when they set nothing.
    const nestedOnce = migrateRecords(nested());
    expect(nestedOnce.nodes.filter(needsRecord)).toEqual([]);
    expect(nestedOnce.nodes.find((n) => n.id === "na")?.props.propValues).toEqual({});
    const twice = migrateRecords(once.nodes);
    expect(twice.migrated).toBe(0);
    expect(twice.nodes).toBe(once.nodes);
  });

  for (const form of FORMS)
    it(`a paste from a file before records comes in keeping a record (${form})`, () => {
      const { editor } = open(form, simple());
      const clipboard = JSON.stringify({
        format: "drawpane/nodes",
        nodes: legacy()
          .filter((n) => n.id === "i" || n.parent === "i")
          .map((n) => (n.id === "i" ? { ...n, parent: "" } : n)),
      });
      expect(editor.paste(clipboard)).toBe(true);
      const pasted = editor.s.selection[0] as string;
      // Its layers' values, folded against its main in this file.
      expect(instanceValues(editor.doc, pasted)).toEqual({ label: "Before", show: true });
      expect(editor.doc.stored().filter(needsRecord)).toEqual([]);
    });

  it("a branch reset merges against main's first record, both sides and the base migrated (finding 2)", () => {
    const original = legacy();
    // As the room merges: each side, and the base, with every instance keeping a record.
    const main = new Room(original, "materialized");
    const branch = new Room(original, "materialized");
    const m = main.join("main");
    const b = branch.join("branch");
    m.editor.setInstanceProperty("i", "show", false);
    b.editor.setInstanceProperty("i", "label", "Temporary");
    b.editor.resetInstanceProperty("i", "label");
    main.settle();
    branch.settle();
    const base = new MemoryStore(migrateRecords(original).nodes);
    const changes = branchChanges(base, branch.store, main.store);
    expect(changes.filter((c) => c.conflict)).toEqual([]);
    applyTransaction(main.store, mergeOps(main.store, branch.store, changes));
    expect(main.store.get("i")?.props.propValues).toEqual({ show: false });
    const result = compactByInstance([...main.store.nodes()]);
    const doc = new Doc({ compactCopies: true });
    doc.resetStored(result.nodes, "compact");
    expect(doc.get(result.ids.get("it") as string)?.props.characters).toBe("Base");
  });
});
