/**
 * The fourth review of component properties (#187 at 2a30738), as tests.
 * Each blocking reproduction failed there and passes here; the follow-ups
 * the review ranked non-blocking are pinned as they are (`it.fails`), each
 * named in the pull request's checklist.
 *
 * Through a room stand-in ordering real sync engines' transactions
 * (property-rooms.ts), or one editor, in both copy forms unless a case says
 * otherwise.
 */
import { Doc, instanceValues, pinInstances } from "@drawpane/editor";
import {
  applyTransaction,
  branchChanges,
  compactByInstance,
  copyId,
  getProp,
  MemoryStore,
  mergeOps,
  mergeRecordProps,
  type Op,
  OVERRIDE_KEY,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { runTool } from "../../editor/src/agent/tools";
import { expectConverged, FORMS, nested, node, open, Room, simple } from "./property-rooms";

/** The texts under `id`, in order. */
const texts = (doc: Doc, id: string): string[] => {
  const n = doc.get(id);
  return [
    ...(n?.type === "text" ? [getProp(n.props, "characters")] : []),
    ...doc.childIds(id).flatMap((c) => texts(doc, c)),
  ];
};

/** The props of `id` as `room`'s first client shows them. */
const shownBy = (room: Room, id: string) =>
  (room.clients[0]?.editor.doc.get(id)?.props ?? {}) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// P1 #1: a create over a record merges field by field

describe("review 4, P1 #1: two first changes to one copy layer both stay", () => {
  const cleared = () =>
    simple().map((n) =>
      ["ta", "it"].includes(n.id) ? { ...n, props: { ...n.props, opacity: 0.4, rotation: 20 } } : n,
    );

  it("keeps two people's explicit clears (the review's case)", () => {
    const room = new Room(cleared(), "compact");
    const a = room.join("a");
    const b = room.join("b");
    const text = room.id("it");
    a.editor.commit([{ op: "set", id: text, prop: "opacity", value: null }]);
    b.editor.commit([{ op: "set", id: text, prop: "rotation", value: null }]);
    a.editor.sync.flush();
    b.editor.sync.flush();
    room.settle();
    expectConverged(room);
    expect(getProp(shownBy(room, text), "opacity")).toBe(1);
    expect(getProp(shownBy(room, text), "rotation")).toBe(0);
    expect([...((room.store.get(text)?.props.unset as string[]) ?? [])].sort()).toEqual([
      "opacity",
      "rotation",
    ]);
  });

  it("keeps a clear and a value of two fields, whichever comes first", () => {
    for (const first of ["a", "b"] as const) {
      const room = new Room(cleared(), "compact");
      const a = room.join("a");
      const b = room.join("b");
      const text = room.id("it");
      a.editor.commit([{ op: "set", id: text, prop: "opacity", value: null }]);
      b.editor.commit([{ op: "set", id: text, prop: "rotation", value: 45 }]);
      (first === "a" ? a : b).editor.sync.flush();
      (first === "a" ? b : a).editor.sync.flush();
      room.settle();
      expectConverged(room);
      expect(getProp(shownBy(room, text), "opacity")).toBe(1);
      expect(getProp(shownBy(room, text), "rotation")).toBe(45);
    }
  });

  it("merges by the rule: unset is both lists, a set field is the later writer's, nothing unmentioned goes", () => {
    const existing = { path: ["t"], opacity: 0.4, unset: ["rotation"], overrides: ["opacity"] };
    expect(
      mergeRecordProps(existing, { path: ["t"], unset: ["fills"], overrides: ["fills"] }),
    ).toEqual({
      path: ["t"],
      opacity: 0.4,
      unset: ["rotation", "fills"],
      overrides: ["opacity", "fills"],
    });
    // A later value of a field unset before takes it out of `unset`; a later unset removes a value.
    expect(mergeRecordProps(existing, { path: ["t"], rotation: 30, unset: ["opacity"] })).toEqual({
      path: ["t"],
      rotation: 30,
      unset: ["opacity"],
      overrides: ["opacity"],
    });
    // The later writer's value of the same field.
    expect(mergeRecordProps(existing, { path: ["t"], opacity: 0.9 })).toMatchObject({
      opacity: 0.9,
      unset: ["rotation"],
    });
  });

  it("undoes a merged create back to the record it merged into", () => {
    const id = copyId("i", ["ta"]);
    const before = node(id, "override", "i", OVERRIDE_KEY, {
      path: ["ta"],
      opacity: 0.4,
      unset: ["rotation"],
    });
    const store = new MemoryStore([...simple(), before]);
    const inverse = applyTransaction(store, [
      {
        op: "create",
        id,
        type: "override",
        parent: "i",
        key: OVERRIDE_KEY,
        props: { path: ["ta"], unset: ["opacity"], overrides: ["opacity"] },
      },
    ]);
    expect(store.get(id)?.props).toEqual({
      path: ["ta"],
      unset: ["rotation", "opacity"],
      overrides: ["opacity"],
    });
    applyTransaction(store, inverse);
    expect(store.get(id)).toEqual(before);
  });

  // Follow-up 7 (non-blocking): the second create's marks are written by a whole-list `set`.
  it.fails("keeps both override marks of two first ordinary overrides", () => {
    const room = new Room(simple(), "compact");
    const a = room.join("a");
    const b = room.join("b");
    const text = room.id("it");
    a.editor.commit([{ op: "set", id: text, prop: "opacity", value: 0.5 }]);
    b.editor.commit([{ op: "set", id: text, prop: "rotation", value: 20 }]);
    a.editor.sync.flush();
    b.editor.sync.flush();
    room.settle();
    expect(getProp(shownBy(room, text) as never, "overrides")).toContain("opacity");
  });

  // Follow-up 8 (non-blocking): a bare model store keeps a refused create's earlier fields.
  it.fails("rolls a refused duplicate create back in a bare model store", () => {
    const id = copyId("i", ["ta"]);
    const store = new MemoryStore([
      ...simple(),
      node(id, "override", "i", OVERRIDE_KEY, { path: ["ta"], opacity: 0.4 }),
    ]);
    const before = structuredClone(store.get(id));
    expect(() =>
      applyTransaction(store, [
        {
          op: "create",
          id,
          type: "override",
          parent: "i",
          key: OVERRIDE_KEY,
          props: { path: ["ta"], opacity: 0.7, width: -1 },
        },
      ]),
    ).toThrow();
    expect(store.get(id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// P1 #2: a tab from before records keeps its unsent edits. The fourth round kept such a tab an
// editor, its edits translated; the fifth review showed that can't hold over what it does to an
// instance, so it views the file now and only its safe queued edits apply: see
// component-property-review5.test.ts and the worker's component-properties.test.ts.

// ---------------------------------------------------------------------------
// P1 #3: detach keeps the values a nested instance takes from its main

describe("review 4, P1 #3: detach keeps a nested instance's inherited values", () => {
  for (const form of FORMS)
    it(`keeps what the main around it set, and follows it from then on (${form})`, () => {
      const { editor } = open(form, nested());
      editor.setInstanceProperty("na", "label", "Inherited custom");
      expect(texts(editor.doc, "i")).toEqual(["Inherited custom"]);
      editor.select(["i"]);
      editor.detachInstances();
      const inner = editor.doc.childIds("i")[0] as string;
      expect(texts(editor.doc, "i")).toEqual(["Inherited custom"]);
      expect(instanceValues(editor.doc, inner)).toEqual({ label: "Inherited custom" });
      editor.commit([{ op: "set", id: "t", prop: "characters", value: "New base" }]);
      expect(texts(editor.doc, "i")).toEqual(["Inherited custom"]);
    });

  for (const form of FORMS)
    it(`the outer instance's own value still comes first (${form})`, () => {
      const { editor } = open(form, nested());
      editor.setInstanceProperty("na", "label", "Inherited");
      const inner = editor.doc.childIds("i")[0] as string;
      editor.setInstanceProperty(inner, "label", "Own");
      editor.select(["i"]);
      editor.detachInstances();
      const detached = editor.doc.childIds("i")[0] as string;
      expect(instanceValues(editor.doc, detached)).toEqual({ label: "Own" });
      expect(texts(editor.doc, "i")).toEqual(["Own"]);
    });
});

for (const form of FORMS)
  it(`review 4, P1 #3: undoing a detach gives the nested instance back as it was (${form})`, () => {
    // Found by the property test: the undo's record sync rebuilt the nested copy from its own
    // component, its layers given new ids.
    const { editor } = open(form, nested());
    editor.setInstanceProperty("na", "label", "Inherited");
    const inner = editor.doc.childIds("i")[0] as string;
    editor.setInstanceProperty(inner, "label", "Own");
    const before = structuredClone(editor.doc.stored());
    editor.select(["i"]);
    editor.detachInstances();
    editor.undo();
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
    expect(editor.doc.stored().sort(byId)).toEqual(before.sort(byId));
    expect(texts(editor.doc, "i")).toEqual(["Own"]);
  });

// ---------------------------------------------------------------------------
// P1 #4: a stale materialized layer never outlives its record

/** Materialized, settled: the record says Latest value, the layer was synced before it. */
function staleRoom() {
  const room = new Room(simple(), "materialized");
  const a = room.join("a");
  const b = room.join("b");
  a.editor.setInstanceProperty("i", "label", "Latest value");
  b.editor.setInstanceVariant("i", "State", "B");
  a.editor.sync.flush();
  b.editor.sync.flush();
  room.settle();
  expectConverged(room);
  expect(a.record("i").label).toBe("Latest value");
  const text = a.row("i", "label")?.targets[0] as string;
  return { room, a, text };
}

describe("review 4, P1 #4: the record wins over a stale materialized layer", () => {
  it("is the stale state the review found (the record and the layer differ)", () => {
    const { a, text } = staleRoom();
    expect(a.field(text, "characters")).not.toBe("Latest value");
  });

  it("detach keeps the record's value", () => {
    const { room, a, text } = staleRoom();
    a.editor.select(["i"]);
    a.editor.detachInstances();
    room.settle();
    expectConverged(room);
    expect(a.field(text, "characters")).toBe("Latest value");
    expect(getProp(a.editor.doc.get(text)?.props ?? {}, "overrides")).toEqual([]);
  });

  it("unlink keeps the record's value", () => {
    const { room, a, text } = staleRoom();
    a.editor.commit([{ op: "set", id: text, prop: "propRefs", value: null }]);
    room.settle();
    expectConverged(room);
    expect(a.field(text, "characters")).toBe("Latest value");
  });

  it("conversion to compact copies keeps the instance, showing the record's value", () => {
    const { room } = staleRoom();
    const converted = compactByInstance([...room.store.nodes()]);
    expect([...converted.detached.keys()]).toEqual([]);
    const doc = new Doc();
    doc.resetStored(converted.nodes, "compact");
    expect(getProp(doc.get("i")?.props ?? {}, "instanceOf")).toBe("b");
    expect(texts(doc, "i")).toEqual(["Latest value"]);
  });

  it("conversion still folds a file from before records, and unlinks a layer that disagrees", () => {
    // Two layers driven by Label showing two texts, no record: the first folds, the second
    // shows another value than the record now has, so its instance is left as it draws.
    const legacyTwo = simple().map((n) => {
      if (n.id === "i") {
        const { propValues: _, ...props } = n.props;
        return { ...n, props };
      }
      return n;
    });
    legacyTwo.push(
      node("ta2", "text", "a", "a2", { characters: "Base", propRefs: { characters: "label" } }),
      node("it2", "text", "i", "a2", {
        mirrors: "ta2",
        characters: "Other",
        propRefs: { characters: "label" },
      }),
    );
    const converted = compactByInstance(legacyTwo);
    const doc = new Doc();
    doc.resetStored(converted.nodes, "compact");
    expect(texts(doc, "i")).toEqual(["Before", "Other"]);
  });

  // Follow-up 9, fixed with review 5's P1 #1: an instance that keeps a record isn't folded again.
  it("the import fold keeps an existing record over a stale layer", () => {
    const { room } = staleRoom();
    const pinned = pinInstances([...room.store.nodes()]);
    expect(pinned.nodes.find((n) => n.id === "i")?.props.propValues?.label).toBe("Latest value");
  });
});

// ---------------------------------------------------------------------------
// P2 #5: unlink and edit in one change

/** `simple`, Label driving a second text too. */
function twoTargets() {
  const nodes = simple();
  nodes.push(
    node("ta2", "text", "a", "a2", { characters: "Base", propRefs: { characters: "label" } }),
    node("it2", "text", "i", "a2", {
      mirrors: "ta2",
      characters: "Before",
      propRefs: { characters: "label" },
    }),
  );
  return nodes;
}

describe("review 4, P2 #5: an unlink and an edit in one change edit that layer only", () => {
  for (const form of FORMS) {
    it(`operations in order (${form})`, () => {
      const { editor, id } = open(form, twoTargets());
      const text = id("it");
      editor.commit([
        { op: "set", id: text, prop: "propRefs", value: null },
        { op: "set", id: text, prop: "characters", value: "New independent text" },
      ]);
      expect(editor.doc.get(text)?.props.characters).toBe("New independent text");
      expect(editor.doc.get(id("it2"))?.props.characters).toBe("Before");
      expect(instanceValues(editor.doc, "i").label).toBe("Before");
    });

    for (const order of ["refs first", "text first"] as const)
      it(`set_props, ${order} (${form})`, async () => {
        const { editor, id } = open(form, twoTargets());
        const text = id("it");
        const props: Record<string, unknown> =
          order === "refs first"
            ? { propRefs: {}, characters: "New independent text" }
            : { characters: "New independent text", propRefs: {} };
        await runTool(editor, "set_props", { changes: [{ id: text, props }] });
        expect(editor.doc.get(text)?.props.characters).toBe("New independent text");
        expect(editor.doc.get(id("it2"))?.props.characters).toBe("Before");
        expect(instanceValues(editor.doc, "i").label).toBe("Before");
      });
  }

  it("an edit before the unlink is still the property's", () => {
    const { editor, id } = open("compact", twoTargets());
    const text = id("it");
    editor.commit([
      { op: "set", id: text, prop: "characters", value: "Everyone" },
      { op: "set", id: text, prop: "propRefs", value: null },
    ]);
    expect(instanceValues(editor.doc, "i").label).toBe("Everyone");
    expect(editor.doc.get(id("it2"))?.props.characters).toBe("Everyone");
    expect(editor.doc.get(text)?.props.characters).toBe("Everyone");
  });
});

// ---------------------------------------------------------------------------
// P2 #6: a record both sides made since the base

describe("review 4, P2 #6: first overrides made on main and on a branch", () => {
  const sides = (onMain: Record<string, unknown>, onBranch: Record<string, unknown>) => {
    const seed = new Room(simple(), "compact");
    const base = new MemoryStore([...seed.store.nodes()]);
    const main = new MemoryStore(structuredClone([...base.nodes()]));
    const branch = new MemoryStore(structuredClone([...base.nodes()]));
    const id = seed.id("it");
    const create = (props: Record<string, unknown>): Op => ({
      op: "create",
      id,
      type: "override",
      parent: "i",
      key: OVERRIDE_KEY,
      props: { path: ["ta"], ...props } as never,
    });
    applyTransaction(main, [create(onMain)]);
    applyTransaction(branch, [create(onBranch)]);
    return { base, main, branch, id };
  };

  it("conflicts where they set the same field differently, and leaves main's until resolved", () => {
    const { base, main, branch, id } = sides(
      { opacity: 0.4, overrides: ["opacity"] },
      { opacity: 0.7, overrides: ["opacity"] },
    );
    const changes = branchChanges(base, branch, main);
    expect(changes).toEqual([
      expect.objectContaining({ id, field: "opacity", main: 0.4, branch: 0.7, conflict: true }),
    ]);
    applyTransaction(main, mergeOps(main, branch, changes));
    expect(main.get(id)?.props.opacity).toBe(0.4);
    // Resolved the branch's way, it's the branch's.
    applyTransaction(main, mergeOps(main, branch, changes, new Map([[`${id}:opacity`, "branch"]])));
    expect(main.get(id)?.props.opacity).toBe(0.7);
  });

  it("brings independent fields without a conflict, both kept, marks and clears too", () => {
    const { base, main, branch, id } = sides(
      { opacity: 0.4, overrides: ["opacity"] },
      { rotation: 30, unset: ["fills"], overrides: ["rotation", "fills"] },
    );
    const changes = branchChanges(base, branch, main);
    expect(changes.every((c) => !c.conflict)).toBe(true);
    applyTransaction(main, mergeOps(main, branch, changes));
    expect(main.get(id)?.props).toEqual({
      path: ["ta"],
      opacity: 0.4,
      rotation: 30,
      unset: ["fills"],
      overrides: ["opacity", "rotation", "fills"],
    });
  });

  it("isn't a change where both made the same value", () => {
    const { base, main, branch } = sides({ opacity: 0.4 }, { opacity: 0.4 });
    expect(branchChanges(base, branch, main)).toEqual([]);
  });

  it("conflicts on a value one side clears and the other sets", () => {
    const { base, main, branch, id } = sides({ unset: ["opacity"] }, { opacity: 0.7 });
    expect(branchChanges(base, branch, main)).toEqual([
      expect.objectContaining({ id, field: "opacity", main: null, branch: 0.7, conflict: true }),
    ]);
  });

  it("conflicts on one record key both sides set first, differently", () => {
    const seed = new Room(simple(), "compact");
    const base = new MemoryStore(
      [...seed.store.nodes()].map((n) =>
        n.id === "i" ? { ...n, props: { ...n.props, propValues: {} } } : n,
      ),
    );
    const main = new MemoryStore(structuredClone([...base.nodes()]));
    const branch = new MemoryStore(structuredClone([...base.nodes()]));
    const key = (value: string): Op => ({
      op: "set",
      id: "i",
      prop: "propValues",
      key: "extra",
      value,
    });
    applyTransaction(main, [key("Main")]);
    applyTransaction(branch, [key("Branch")]);
    const changes = branchChanges(base, branch, main);
    expect(changes).toEqual([
      expect.objectContaining({ id: "i", field: "propValues", key: "extra", conflict: true }),
    ]);
    applyTransaction(main, mergeOps(main, branch, changes));
    expect(main.get("i")?.props.propValues).toMatchObject({ extra: "Main" });
  });
});
