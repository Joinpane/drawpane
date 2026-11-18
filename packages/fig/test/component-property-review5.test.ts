/**
 * The fifth review of component properties (#187 at b9fd88e), as tests.
 *
 * A tab from before component property records (protocol 2) is no longer an
 * editor: welcomed as a viewer, it can't make an edit, and of what it held
 * unsent, a transaction is applied only when every operation in it is safe
 * (`protocol2Refusal`): none touches an instance, a layer inside one, a
 * main, a component set, an override record or a property's fields, and no
 * create puts back a node the file had. Anything else is refused whole,
 * with a message the tab shows, saying to make it again after reloading.
 * The operations here are those the review's run of the actual protocol 2
 * editor sent (`room-reproductions.log`).
 *
 * Through a room stand-in (property-rooms.ts), which applies the same rule
 * as `FileRoom`.
 */
import { Doc, instanceValues } from "@drawpane/editor";
import { compactByInstance, type NodeRecord, type Op, type ServerMessage } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { buttonKit, Client, FORMS, node, Room, simple } from "./property-rooms";

/** A protocol 2 tab's socket on `room`: its welcome, then each transaction it sends, as the room answers it. */
function oldTab(room: Room) {
  const tab = new Client(room, "old", 2);
  room.handle(tab, { t: "hello", protocol: 2, clientId: "old", revn: null, copies: [room.copies] });
  const welcome = tab.inbox.find((m) => m.t === "welcome") as Extract<
    ServerMessage,
    { t: "welcome" }
  >;
  tab.inbox.length = 0;
  let seq = 0;
  const send = (ops: Op[]) => {
    room.handle(tab, { t: "txn", seq: ++seq, ops });
    const answer = tab.inbox.shift() as ServerMessage;
    tab.inbox.length = 0;
    return answer;
  };
  return { welcome, send };
}

const refused = (answer: ServerMessage) => {
  expect(answer.t).toBe("reject");
  const message = (answer as Extract<ServerMessage, { t: "reject" }>).message;
  // What the tab shows: its change wasn't saved, and to make it again after reloading.
  expect(message).toMatch(/wasn't saved/);
  expect(message).toMatch(/[Rr]eload/);
};

describe("review 5, the new rule: a protocol 2 tab is read-only, its safe queued edits apply", () => {
  for (const form of FORMS) {
    it(`welcomes it as a viewer, whatever its role (${form})`, () => {
      const room = new Room(simple(), form);
      expect(oldTab(room).welcome.role).toBe("viewer");
    });

    it(`applies a queued transaction whose every operation is safe (${form})`, () => {
      const room = new Room(simple(), form);
      const { send } = oldTab(room);
      expect(send([{ op: "set", id: "p", prop: "name", value: "Renamed offline" }]).t).toBe("ack");
      const rect: Op = {
        op: "create",
        id: "plainRect000001",
        type: "rect",
        parent: "p",
        key: "a5",
        props: { width: 10, height: 10 },
      };
      expect(
        send([rect, { op: "set", id: "plainRect000001", prop: "opacity", value: 0.5 }]).t,
      ).toBe("ack");
      expect(send([{ op: "move", id: "plainRect000001", parent: "p", key: "a6" }]).t).toBe("ack");
      expect(room.store.get("p")?.props.name).toBe("Renamed offline");
      expect(room.store.get("plainRect000001")?.props.opacity).toBe(0.5);
      expect(room.rejected).toEqual([]);
    });

    it(`refuses the review's delete of an instance, and its undo, whole (${form})`, () => {
      const room = new Room(simple(), form);
      const { send } = oldTab(room);
      refused(send([{ op: "delete", id: "i" }]));
      expect(instanceValues(open(room), "i")).toEqual({ label: "Before", show: true });
    });

    it(`refuses a detach (${form})`, () => {
      const room = new Room(simple(), form);
      const { send } = oldTab(room);
      refused(send([{ op: "set", id: "i", prop: "instanceOf", value: null }]));
      expect(room.store.get("i")?.props.instanceOf).toBe("a");
    });

    it(`refuses an edit inside an instance: a driven text, an ordinary override (${form})`, () => {
      const room = new Room(simple(), form);
      const { send } = oldTab(room);
      const text = room.id("it");
      if (form === "compact")
        refused(
          send([
            {
              op: "create",
              id: text,
              type: "override",
              parent: "i",
              key: "a0",
              props: { path: ["ta"], characters: "Typed" } as never,
            },
          ]),
        );
      else
        refused(
          send([
            { op: "set", id: text, prop: "characters", value: "Typed" },
            { op: "set", id: text, prop: "overrides", value: ["characters"] },
          ]),
        );
      refused(
        send([{ op: "set", id: form === "compact" ? "i" : text, prop: "opacity", value: 0.5 }]),
      );
      expect(instanceValues(open(room), "i").label).toBe("Before");
    });

    it(`refuses a main's edit, a component set's, and making an instance (${form})`, () => {
      const room = new Room(simple(), form);
      const { send } = oldTab(room);
      refused(send([{ op: "set", id: "ta", prop: "characters", value: "Main" }]));
      refused(send([{ op: "set", id: "set", prop: "name", value: "Set" }]));
      refused(
        send([
          {
            op: "create",
            id: "newInstance0001",
            type: "frame",
            parent: "p",
            key: "a5",
            props: { instanceOf: "a" },
          },
        ]),
      );
    });

    it(`never applies part of a transaction (${form})`, () => {
      const room = new Room(simple(), form);
      const { send } = oldTab(room);
      refused(
        send([
          { op: "set", id: "p", prop: "name", value: "Renamed" },
          { op: "delete", id: "i" },
        ]),
      );
      expect(room.store.get("p")?.props.name).toBeUndefined();
      expect(room.store.get("i")).toBeDefined();
    });

    it(`refuses a create that puts back a node the file had (${form})`, () => {
      const nodes = [
        ...simple(),
        node("plainRect000002", "rect", "p", "a5", { width: 10, height: 10 }),
      ];
      const room = new Room(nodes, form);
      const current = room.join("current");
      current.editor.commit([{ op: "delete", id: "plainRect000002" }]);
      room.settle();
      const { send } = oldTab(room);
      refused(
        send([
          {
            op: "create",
            id: "plainRect000002",
            type: "rect",
            parent: "p",
            key: "a5",
            props: { width: 10, height: 10 },
          },
        ]),
      );
      expect(room.store.get("plainRect000002")).toBeUndefined();
    });

    it(`refuses deleting or moving what holds an instance (${form})`, () => {
      const nodes = [...simple(), node("holder000000001", "frame", "p", "a5", {})];
      const room = new Room(nodes, form);
      const { send } = oldTab(room);
      expect(send([{ op: "move", id: "i", parent: "holder000000001", key: "a0" }]).t).toBe(
        "reject",
      );
      refused(send([{ op: "delete", id: "set" }]));
    });
  }
});

/** The room's file opened as a client does. */
function open(room: Room): Doc {
  const doc = new Doc({ compactCopies: room.copies === "compact" });
  doc.resetStored(structuredClone([...room.store.nodes()]), room.copies);
  return doc;
}

// ---------------------------------------------------------------------------
// P1 #1: a record that exists decides every key; one it doesn't keep is the main's

/** Materialized, settled: Label reset (the record keeps Show), the text synced before it. */
function staleReset() {
  const room = new Room(simple(), "materialized");
  const a = room.join("a");
  const b = room.join("b");
  a.editor.resetInstanceProperty("i", "label");
  b.editor.setInstanceVariant("i", "State", "B");
  a.editor.sync.flush();
  b.editor.sync.flush();
  room.settle();
  const text = a.row("i", "label")?.targets[0] as string;
  expect(room.store.get("i")?.props.propValues).toEqual({ show: true });
  expect(a.field(text, "characters")).toBe("Before");
  return { room, a, text };
}

describe("review 5, P1 #1: a reset isn't brought back at a boundary", () => {
  it("conversion keeps the reset, the layer showing its main's", () => {
    const { room, text } = staleReset();
    const converted = compactByInstance([...room.store.nodes()]);
    expect([...converted.detached.keys()]).toEqual([]);
    const doc = new Doc();
    doc.resetStored(converted.nodes, "compact");
    expect(doc.get("i")?.props.propValues).toEqual({ show: true });
    expect(doc.get(converted.ids.get(text) as string)?.props.characters).toBe("Base");
  });

  for (const boundary of ["detach", "unlink"] as const)
    it(`${boundary} keeps the main's value`, () => {
      const { room, a, text } = staleReset();
      if (boundary === "detach") {
        a.editor.select(["i"]);
        a.editor.detachInstances();
      } else a.editor.commit([{ op: "set", id: text, prop: "propRefs", value: null }]);
      room.settle();
      expect(a.field(text, "characters")).toBe("Base");
    });

  for (const form of FORMS)
    it(`resetting the last value keeps an empty record, the marker that it decides (${form})`, () => {
      const room = new Room(simple(), form);
      const a = room.join("a");
      a.editor.resetInstanceProperty("i", "label");
      a.editor.resetInstanceProperty("i", "show");
      room.settle();
      expect(room.store.get("i")?.props.propValues).toEqual({});
      expectNoPending(room);
    });

  it("an instance's first record takes every value its layers held from before records, once", () => {
    // A materialized file from before records: the instance's values only on its layers.
    const legacy = simple().map((n) => {
      if (n.id === "i") {
        const { propValues: _, ...props } = n.props;
        return { ...n, props };
      }
      if (n.id === "iv") return { ...n, props: { ...n.props, visible: false } };
      return n;
    });
    const room = new Room(legacy, "materialized");
    const a = room.join("a");
    a.editor.setInstanceProperty("i", "show", true);
    room.settle();
    // Show is the edit; Label, which its layer held, is folded in with it.
    expect(room.store.get("i")?.props.propValues).toEqual({ label: "Before", show: true });
    a.editor.undo();
    room.settle();
    // The fold isn't undone with the edit: the values the layers held stay, Show back to theirs.
    expect(room.store.get("i")?.props.propValues).toEqual({ label: "Before", show: false });
    expect(a.field("it", "characters")).toBe("Before");
  });
});

const expectNoPending = (room: Room) => {
  for (const c of room.clients) expect(c.editor.sync.pendingCount).toBe(0);
};

// ---------------------------------------------------------------------------
// P1 #2: detach and unlink keep a swap the record chose

/** Materialized, settled: the record swaps the icon to iconB, the nested icon synced before it. */
function staleSwap() {
  const room = new Room(buttonKit(), "materialized");
  const a = room.join("a");
  const b = room.join("b");
  a.editor.setInstanceProperty("i", "icon", "iconB");
  b.editor.setInstanceVariant("i", "State", "B");
  a.editor.sync.flush();
  b.editor.sync.flush();
  room.settle();
  const icon = a.editor.doc
    .childIds("i")
    .map((id) => a.editor.doc.get(id) as NodeRecord)
    .find((n) => n.props.name === "Icon") as NodeRecord;
  expect(room.store.get("i")?.props.propValues?.icon).toEqual({ instance: "iconB" });
  expect(icon.props.instanceOf).toBe("iconA");
  return { room, a, icon };
}

describe("review 5, P1 #2: a swap the record chose survives detach and unlink", () => {
  it("detach makes the nested icon an instance of the component the record chose", () => {
    const { room, a, icon } = staleSwap();
    a.editor.select(["i"]);
    a.editor.detachInstances();
    room.settle();
    expect(a.editor.doc.get(icon.id)?.props.instanceOf).toBe("iconB");
    expect(a.editor.doc.childIds(icon.id).map((id) => a.editor.doc.get(id)?.type)).toEqual([
      "ellipse",
    ]);
    expect(compactByInstance([...room.store.nodes()]).detached.size).toBe(0);
  });

  it("unlink keeps the component the record chose", () => {
    const { room, a, icon } = staleSwap();
    a.editor.commit([{ op: "set", id: icon.id, prop: "propRefs", value: null }]);
    room.settle();
    expect(a.editor.doc.get(icon.id)?.props.instanceOf).toBe("iconB");
  });

  it("conversion builds it from the component the record chose (the control)", () => {
    const { room, icon } = staleSwap();
    const converted = compactByInstance([...room.store.nodes()]);
    expect([...converted.detached]).toEqual([]);
    const doc = new Doc({ compactCopies: true });
    doc.resetStored(converted.nodes, "compact");
    expect(doc.get(converted.ids.get(icon.id) as string)?.props.instanceOf).toBe("iconB");
  });
});

// ---------------------------------------------------------------------------
// P2 #7: a delayed structure never stores a copy reference into a main its layer left

describe("review 5, P2 #7: a delayed swap undo after a detach", () => {
  it("keeps the nested icon's layers copying its own component, so conversion keeps it linked", () => {
    const room = new Room(buttonKit(), "materialized");
    const a = room.join("a");
    room.join("b");
    const c = room.join("c");
    c.editor.setInstanceProperty("i", "icon", "iconB");
    a.editor.select(["i"]);
    a.editor.detachInstances();
    c.editor.undo();
    for (let i = 0; i < 5; i++) a.editor.setInstanceProperty("i", "label", `noop${i}`);
    room.settle();
    // Every copy layer copies a layer of the main its instance follows.
    const store = room.store;
    for (const layer of store.nodes()) {
      const mirrors = layer.props.mirrors;
      if (typeof mirrors !== "string") continue;
      let owner = store.get(layer.parent);
      while (owner && !(owner.type === "frame" && owner.props.instanceOf))
        owner = store.get(owner.parent);
      const container = (owner?.props.mirrors ?? owner?.props.instanceOf) as string | undefined;
      let at = store.get(mirrors);
      while (at && at.id !== container) at = store.get(at.parent);
      expect(at?.id, `${layer.id} copies ${mirrors}`).toBe(container);
    }
    expect([...compactByInstance([...store.nodes()]).detached]).toEqual([]);
  });
});
