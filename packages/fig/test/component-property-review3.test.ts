/**
 * The third review of component properties (#187 at 459c172), as tests.
 * Each reproduction failed there: the record and the values on driven
 * layers were two stores a client-side step tried to keep in step. Since
 * the record is the only place a value is (decision 0035, item 3), driven
 * layers show it as they're read (compact copies) or as sync writes it from
 * the main and the record (materialized copies), and nothing repairs
 * anything, so the "repair" schedules here are ordinary concurrent edits.
 *
 * Through a room stand-in ordering three real sync engines' transactions
 * (property-rooms.ts), in both copy forms unless a case says otherwise.
 */
import { instanceValues, nestedTree } from "@drawpane/editor";
import {
  applyTransaction,
  branchChanges,
  ClientMessage,
  type CopiesFormat,
  getProp,
  MemoryStore,
  mergeOps,
  type Op,
  PROTOCOL_VERSION,
  ROOT_ID,
} from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { runTool } from "../../editor/src/agent/tools";
import { drivenLayers } from "../../editor/src/property-values";
import {
  expectAgreement,
  expectConverged,
  expectShowsRecord,
  FORMS,
  nested,
  nestedWithShow,
  node,
  open,
  Room,
  simple,
} from "./property-rooms";

const secondIcon: Op = {
  op: "create",
  id: "secondIcon",
  type: "rect",
  parent: "a",
  key: "a2",
  props: { width: 10, height: 10, propRefs: { visible: "show" } },
};

/** The values every client shows on the Show property's layers. */
const shown = (room: Room) =>
  room.clients.map((c) => (c.row("i", "show")?.targets ?? []).map((t) => c.field(t, "visible")));

// ---------------------------------------------------------------------------
// P1 #1: older clients are gated

describe("review 3, P1 #1: the protocol says keyed sets", () => {
  it("is version 3, and a version 2 hello still reads, so the room can tell such a tab apart", () => {
    expect(PROTOCOL_VERSION).toBe(3);
    const hello = { t: "hello", clientId: "old", revn: null, copies: ["materialized"] };
    expect(ClientMessage.safeParse({ ...hello, protocol: 2 }).success).toBe(true);
    expect(ClientMessage.safeParse({ ...hello, protocol: 3 }).success).toBe(true);
  });

  it("a client says version 3 in its hello", () => {
    const room = new Room(simple(), "compact");
    const sent: ClientMessage[] = [];
    const client = room.join("a");
    client.editor.sync.disconnected();
    client.editor.sync.connected((message) => sent.push(message));
    expect(sent[0]).toMatchObject({ t: "hello", protocol: 3 });
  });
});

// ---------------------------------------------------------------------------
// P1 #2: what were "repairs" are edits now; schedules that left a record and its layers apart

for (const form of FORMS)
  describe(`review 3, P1 #2: values and teammates' layers (${form})`, () => {
    it("a newer edit wins over an older one held in flight", () => {
      const room = new Room(simple(), form);
      const [a, b, c] = [room.join("a"), room.join("b"), room.join("c")];
      a.editor.setInstanceProperty("i", "show", false);
      a.editor.sync.flush();
      b.editor.commit([secondIcon]);
      b.editor.sync.flush();
      a.deliver();
      c.deliver();
      b.deliver();
      // A's socket is slower than C's: anything A sends now arrives after C's edit.
      const held: ClientMessage[] = [];
      const handle = room.handle.bind(room);
      room.handle = (from, message) => {
        if (from === a && message.t === "txn") held.push(structuredClone(message));
        else handle(from, message);
      };
      a.editor.sync.flush();
      // Nothing to repair: A has nothing to send.
      expect(held).toEqual([]);
      c.editor.setInstanceProperty("i", "show", true);
      c.editor.sync.flush();
      a.deliver();
      for (const message of held) handle(a, message);
      room.handle = handle;
      room.settle();
      expect(shown(room)).toEqual([
        [true, true],
        [true, true],
        [true, true],
      ]);
      expectAgreement(room, "i");
    });

    it("the same, the older client sending after the newer edit reached the room", () => {
      const room = new Room(simple(), form);
      const [a, b, c] = [room.join("a"), room.join("b"), room.join("c")];
      a.editor.setInstanceProperty("i", "show", false);
      a.editor.sync.flush();
      b.editor.commit([secondIcon]);
      b.editor.sync.flush();
      a.deliver();
      c.deliver();
      b.deliver();
      c.editor.setInstanceProperty("i", "show", true);
      c.editor.sync.flush();
      a.editor.sync.flush();
      room.settle();
      expectAgreement(room, "i");
    });

    it("a value a branch merge set, and an editor that went away before sending", () => {
      const room = new Room(simple(), form);
      const [a, b, c] = [room.join("a"), room.join("b"), room.join("c")];
      // A merge takes show=false for the record; no layer is written with it.
      room.commit([{ op: "set", id: "i", prop: "propValues", key: "show", value: false }]);
      for (const client of [a, b, c]) client.deliver();
      if (form === "compact")
        // Compact copies show it as they're read.
        expect(shown(room)).toEqual([[false], [false], [false]]);
      room.disconnect(a);
      room.clients.splice(room.clients.indexOf(a), 1);
      c.editor.setInstanceProperty("i", "show", true);
      room.settle();
      expect(shown(room)).toEqual([[true], [true]]);
      expectAgreement(room, "i");
    });

    it("a reset wins over a value set with a layer the resetter couldn't see", () => {
      const room = new Room(simple(), form);
      const [a, b, c] = [room.join("a"), room.join("b"), room.join("c")];
      a.editor.setInstanceProperty("i", "show", false);
      a.editor.sync.flush();
      b.editor.commit([secondIcon]);
      b.editor.sync.flush();
      for (const client of [a, b, c]) client.deliver();
      const held: ClientMessage[] = [];
      const handle = room.handle.bind(room);
      room.handle = (from, message) => {
        if (from === a && message.t === "txn") held.push(structuredClone(message));
        else handle(from, message);
      };
      a.editor.sync.flush();
      c.editor.resetInstanceProperty("i", "show");
      c.editor.sync.flush();
      a.deliver();
      for (const message of held) handle(a, message);
      room.handle = handle;
      room.settle();
      expect(instanceValues(a.editor.doc, "i").show).toBeUndefined();
      expect(shown(room)).toEqual([
        [true, true],
        [true, true],
        [true, true],
      ]);
      expectAgreement(room, "i");
    });

    it("a reset resets a layer another client added at the same time", () => {
      const room = new Room(simple(), form);
      const [a, b] = [room.join("a"), room.join("b"), room.join("c")];
      a.editor.setInstanceProperty("i", "show", false);
      a.editor.commit([secondIcon]);
      b.editor.resetInstanceProperty("i", "show");
      a.editor.sync.flush();
      b.editor.sync.flush();
      room.settle();
      expect(instanceValues(a.editor.doc, "i").show).toBeUndefined();
      if (form === "materialized") {
        // A wrote its new layer's copy with its own value, which B's reset couldn't see: it shows
        // that until the instance syncs again. The record keeps no value everywhere meanwhile.
        expectConverged(room);
        a.editor.setInstanceProperty("i", "label", "Later");
        room.settle();
      }
      expect(shown(room)).toEqual([
        [true, true],
        [true, true],
        [true, true],
      ]);
      expectAgreement(room, "i");
    });

    it("three editors and a viewer: nobody writes for anyone else, the viewer least", () => {
      const room = new Room(simple(), form);
      const [a, b] = [room.join("a"), room.join("b"), room.join("c")];
      const viewer = room.join("v");
      viewer.editor.sync.receive({
        t: "role",
        role: "viewer",
        previous: "editor",
        by: { id: "u", name: "Owner" },
      });
      a.editor.setInstanceProperty("i", "show", false);
      a.editor.sync.flush();
      b.editor.commit([secondIcon]);
      b.editor.sync.flush();
      for (const client of room.clients) client.deliver();
      // Applying a teammate's edit queues nothing anywhere.
      for (const client of room.clients) expect(client.editor.sync.pendingCount).toBe(0);
      room.settle();
      // Two edits, two revisions.
      expect(room.revn).toBe(3);
      if (form === "compact") expectAgreement(room, "i");
      else expectConverged(room);
    });

    it("a file opened by a viewer alone shows its values as stored", () => {
      const initial = simple().map((n) =>
        n.id === "i"
          ? { ...n, props: { ...n.props, propValues: { label: "Before", show: false } } }
          : n,
      );
      // Compact: the record as stored, its layer presented from it. Materialized: the record as
      // stored, the layer as written before (by hand, for the test).
      const room = form === "compact" ? new Room(simple(), form) : Room.stored(initial, form);
      if (form === "compact")
        applyTransaction(room.store, [
          { op: "set", id: "i", prop: "propValues", key: "show", value: false },
        ]);
      const viewer = room.join("viewer");
      viewer.editor.sync.receive({
        t: "role",
        role: "viewer",
        previous: "editor",
        by: { id: "u", name: "Owner" },
      });
      expect(viewer.editor.sync.pendingCount).toBe(0);
      expect(viewer.row("i", "show")?.value).toBe(false);
      // Compact copies read the record. A materialized file is what its last sync wrote: this one
      // was written without it (by hand, for the test), and nothing writes it on opening.
      expect(viewer.field(room.id("iv"), "visible")).toBe(form !== "compact");
      const editing = room.join("editor");
      room.settle();
      expect(editing.editor.sync.pendingCount).toBe(0);
    });
  });

// ---------------------------------------------------------------------------
// P1 #3: a nested instance's first values had nowhere to go but a new record

for (const form of FORMS)
  it(`review 3, P1 #3: concurrent first values of a nested instance both stay (${form})`, () => {
    const room = new Room(nestedWithShow(), form);
    const [a, b] = [room.join("a"), room.join("b")];
    const ni = room.id("ni");
    a.editor.setInstanceProperty(ni, "label", "Alice");
    b.editor.setInstanceProperty(ni, "show", false);
    a.editor.sync.flush();
    b.editor.sync.flush();
    room.settle();
    expect(room.rejected).toEqual([]);
    for (const client of [a, b])
      expect(instanceValues(client.editor.doc, ni)).toEqual({ label: "Alice", show: false });
    // In the outer instance's record, which existed already: no record made for the nested one.
    expect(getProp(room.store.get("i")?.props ?? {}, "propValues")).toEqual({
      "na/label": "Alice",
      "na/show": false,
    });
    expectAgreement(room, "i");
  });

it("review 3, P1 #3: a branch merge combines first nested values per key", () => {
  const base = open("compact", nestedWithShow());
  const main = open("compact", nestedWithShow());
  const branch = open("compact", nestedWithShow());
  main.editor.setInstanceProperty(main.id("ni"), "label", "Main");
  branch.editor.setInstanceProperty(branch.id("ni"), "show", false);
  const changes = branchChanges(
    base.editor.doc.storedReader(),
    branch.editor.doc.storedReader(),
    main.editor.doc.storedReader(),
  );
  const ops = mergeOps(main.editor.doc.storedReader(), branch.editor.doc.storedReader(), changes);
  expect(() => main.editor.doc.applyStored(ops)).not.toThrow();
  expect(instanceValues(main.editor.doc, main.id("ni"))).toEqual({ label: "Main", show: false });
});

// ---------------------------------------------------------------------------
// P2 #4: an unchanged sibling must keep its own match

for (const form of FORMS)
  it(`review 3, P2 #4: an unchanged nested sibling keeps its exact match (${form})`, () => {
    const initial = nested().map((n) =>
      n.id === "na" || n.id === "nb" || n.id === "ni"
        ? { ...n, props: { ...n.props, name: "First" } }
        : n,
    );
    initial.push(
      node("na2", "frame", "a", "a1", {
        name: "Second",
        instanceOf: "leaf",
        exposeProps: true,
        width: 100,
        height: 30,
      }),
      node("na2t", "text", "na2", "a0", {
        mirrors: "t",
        characters: "Base",
        name: "Text",
        propRefs: { characters: "label" },
      }),
      node("nb2", "frame", "b", "a1", {
        name: "Renamed",
        instanceOf: "leaf",
        exposeProps: true,
        width: 100,
        height: 30,
      }),
      node("nb2t", "text", "nb2", "a0", {
        mirrors: "t",
        characters: "Base",
        name: "Text",
        propRefs: { characters: "label" },
      }),
      node("ni2", "frame", "i", "a1", {
        name: "Second",
        instanceOf: "leaf",
        mirrors: "na2",
        exposeProps: true,
        width: 100,
        height: 30,
      }),
      node("ni2t", "text", "ni2", "a0", {
        mirrors: "na2t",
        characters: "Base",
        name: "Text",
        propRefs: { characters: "label" },
      }),
    );
    const { editor, id } = open(form, initial);
    editor.setInstanceProperty(id("ni2"), "label", "Second custom");
    editor.setInstanceVariant("i", "State", "B");
    const kids = nestedTree(editor.doc, "i");
    const state = Object.fromEntries(
      kids.map((n) => [
        getProp(editor.doc.get(n.id)?.props ?? {}, "name"),
        instanceValues(editor.doc, n.id),
      ]),
    );
    expect(state).toEqual({ First: {}, Renamed: { label: "Second custom" } });
    expectShowsRecord(editor.doc, "i");
  });

// ---------------------------------------------------------------------------
// P2 #5: a peer's compact unlink

it("review 3, P2 #5: a teammate's unlink in compact copies reaches the driven-layer cache", () => {
  const room = new Room(simple(), "compact");
  const [a, b] = [room.join("a"), room.join("b")];
  const target = room.id("it");
  drivenLayers(a.editor.doc, "i");
  const structure = a.editor.doc.structure;
  b.editor.setProp([target], "propRefs", null);
  b.editor.sync.flush();
  a.deliver();
  b.deliver();
  expect(a.editor.doc.structure).not.toBe(structure);
  expect([...drivenLayers(a.editor.doc, "i").values()].flat()).not.toContain(target);
  a.editor.setInstanceProperty("i", "label", "Updated");
  room.settle();
  // Unlinked, it kept what it showed, as its own.
  expect(a.field(target, "characters")).toBe("Before");
  expect(b.field(target, "characters")).toBe("Before");
  expectAgreement(room, "i");
});

for (const form of FORMS)
  it(`review 3, P2 #5: unlinking a driven layer keeps what it shows (${form})`, () => {
    const { editor, id } = open(form, simple());
    editor.setProp([id("it")], "propRefs", null);
    expect(getProp(editor.doc.get(id("it"))?.props ?? {}, "characters")).toBe("Before");
    editor.setInstanceProperty("i", "label", "Later");
    expect(getProp(editor.doc.get(id("it"))?.props ?? {}, "characters")).toBe("Before");
  });

// ---------------------------------------------------------------------------
// P2 #6: compaction and the record's bound

for (const form of FORMS)
  it(`review 3, P2 #6: merging unsent edits never makes them a transaction the room refuses (${form})`, () => {
    const initial = [
      node("p", "page", ROOT_ID, "a0", {}),
      node("main", "frame", "p", "a0", {
        isComponent: true,
        componentProps: [
          { id: "a", name: "A", type: "text" },
          { id: "b", name: "B", type: "text" },
        ],
      }),
      node("i", "frame", "p", "a1", {
        instanceOf: "main",
        propValues: { a: "a".repeat(200_000), b: "b".repeat(199_998) },
      }),
      node("ta", "text", "main", "a0", { characters: "BaseA", propRefs: { characters: "a" } }),
      node("tb", "text", "main", "a1", { characters: "BaseB", propRefs: { characters: "b" } }),
      node("ia", "text", "i", "a0", {
        characters: "a".repeat(200_000),
        mirrors: "ta",
        propRefs: { characters: "a" },
      }),
      node("ib", "text", "i", "a1", {
        characters: "b".repeat(199_998),
        mirrors: "tb",
        propRefs: { characters: "b" },
      }),
    ];
    const { editor } = open(form, initial);
    const room = new MemoryStore(editor.doc.stored());
    editor.setInstanceProperty("i", "a", "x");
    editor.setInstanceProperty("i", "b", "b".repeat(200_000));
    editor.setInstanceProperty("i", "a", "xx");
    const unsent = editor.sync.takeUnsent();
    const record = getProp(editor.doc.get("i")?.props ?? {}, "propValues");
    expect(record.a).toBe("xx");
    expect(record.b).toHaveLength(200_000);
    expect(() => applyTransaction(room, unsent)).not.toThrow();
    expect(room.get("i")?.props).toEqual(editor.doc.storedReader().get("i")?.props);
  });

it("review 3, P2 #6: what a transaction leaves is what's checked against the bound", () => {
  const store = new MemoryStore([
    node("p", "page", ROOT_ID, "a0", {}),
    node("i", "frame", "p", "a0", { propValues: { a: "a".repeat(200_000) } }),
  ]);
  const grow: Op = { op: "set", id: "i", prop: "propValues", key: "b", value: "b".repeat(199_999) };
  const shrink: Op = { op: "set", id: "i", prop: "propValues", key: "a", value: "x" };
  // Growing first passes through a record past the bound, and ends inside it.
  expect(() => applyTransaction(store, [grow, shrink])).not.toThrow();
  // Ending past it is refused, and changes nothing.
  const before = structuredClone(store.get("i"));
  expect(() =>
    applyTransaction(store, [
      { op: "set", id: "i", prop: "propValues", key: "a", value: "a".repeat(200_000) },
    ]),
  ).toThrow(/too many characters/);
  expect(store.get("i")).toEqual(before);
});

// ---------------------------------------------------------------------------
// P2 #7: the agent tools read and write through the record

for (const form of FORMS)
  it(`review 3, P2 #7: MCP set_props writes the record, which the layers show (${form})`, async () => {
    const { editor, id } = open(form, simple());
    const result = await runTool(editor, "set_props", {
      changes: [{ id: "i", props: { propValues: { label: "Agent", show: false } } }],
    });
    expect(result.data).toEqual({ changed: ["i"] });
    const ops = editor.sync.takeUnsent();
    // A value at a time.
    for (const op of ops)
      if (op.op === "set" && op.prop === "propValues") expect(op.key).toBeTruthy();
    expect(getProp(editor.doc.get(id("it"))?.props ?? {}, "characters")).toBe("Agent");
    expect(getProp(editor.doc.get(id("iv"))?.props ?? {}, "visible")).toBe(false);
    // Typing in the label through the agent is the property's edit too.
    await runTool(editor, "set_props", {
      changes: [{ id: id("it"), props: { characters: "Typed" } }],
    });
    expect(instanceValues(editor.doc, "i").label).toBe("Typed");
    expect(getProp(editor.doc.get(id("it"))?.props ?? {}, "overrides")).not.toContain("characters");
  });

// ---------------------------------------------------------------------------
// The review's generated schedules, kept: three clients, values, layers added, resets

/** Runs a schedule of [client, action] pairs on `simple` through the room, then settles. */
function runSchedule(form: CopiesFormat, actions: ReadonlyArray<readonly [number, number]>) {
  const room = new Room(simple(), form);
  for (const name of ["a", "b", "c"]) room.join(name);
  let next = 0;
  for (const [actor, action] of actions) {
    const client = room.clients[actor] as (typeof room.clients)[number];
    if (action === 0) client.editor.setInstanceProperty("i", "show", false);
    if (action === 1) client.editor.setInstanceProperty("i", "show", true);
    if (action === 2) client.editor.setInstanceProperty("i", "label", `${actor}-${next++}`);
    if (action === 3)
      client.editor.commit([
        {
          op: "create",
          id: `icon${next++}`,
          type: "rect",
          parent: "a",
          key: "a2",
          props: { width: 10, height: 10, propRefs: { visible: "show" } },
        },
      ]);
    if (action === 4) client.editor.sync.flush();
    if (action === 5) client.deliverOne();
    if (action === 6) client.deliver();
    if (action === 7) client.editor.resetInstanceProperty("i", "show");
  }
  room.settle();
  return room;
}

for (const form of FORMS)
  for (const resets of [false, true])
    it(`review 3: generated schedules converge${resets ? ", resets included" : ""} (${form})`, () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: resets ? 7 : 6 })),
            {
              minLength: 10,
              maxLength: 40,
            },
          ),
          (actions) => {
            const room = runSchedule(form, actions);
            expectConverged(room);
            // Compact copies show the record whatever happened; materialized ones once the instance
            // has synced after the last structural edit it didn't see (decision 0035).
            if (form === "materialized") {
              (room.clients[0] as (typeof room.clients)[number]).editor.setInstanceProperty(
                "i",
                "label",
                "Settled",
              );
              room.settle();
            }
            expectAgreement(room, "i");
          },
        ),
        { seed: 1870035, numRuns: 150 },
      );
    }, 120_000);
