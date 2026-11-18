/**
 * Component property values under collaboration, as a property (decision
 * 0035): three clients make random edits (values, resets, variant switches,
 * swaps by an instance swap property, a nested instance's values, layers
 * added to the mains, undo), sending and receiving in random order, their
 * sockets dropping and coming back, through real sync engines and a room
 * stand-in (property-rooms.ts). However it goes, once everything is
 * delivered every client and the room hold the same file, and every layer a
 * property drives shows the instance's value: the record's, or its main
 * layer's when the record keeps none.
 *
 * Compact copies show it as they're read. Materialized copies are written
 * by whoever syncs them, from what they see: a layer synced without a value
 * a teammate set at the same time shows its main layer's until that
 * instance syncs again, so in that form the check runs after one more edit
 * of the instance's properties (any client's).
 */
import { Editor, instanceProperties } from "@drawpane/editor";
import { type CopiesFormat, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Client,
  expectAgreement,
  expectConverged,
  FORMS,
  measurer,
  node,
  Room,
} from "./property-rooms";

/**
 * A Button set (variants A and B) with a text, a boolean and an icon swap
 * property, each variant holding a nested Leaf (a text property of its own,
 * exposed); and an instance of A, its copy made by the editor.
 */
function kit(): NodeRecord[] {
  const mains: NodeRecord[] = [
    node("p", "page", ROOT_ID, "a0", {}),
    node("leaf", "frame", "p", "a0", {
      isComponent: true,
      name: "Leaf",
      width: 60,
      height: 20,
      componentProps: [{ id: "leafLabel", name: "Leaf label", type: "text", default: "Leaf" }],
    }),
    node("lt", "text", "leaf", "a0", {
      name: "Text",
      characters: "Leaf",
      propRefs: { characters: "leafLabel" },
    }),
    node("iconA", "frame", "p", "a1", { isComponent: true, name: "Arrow", width: 10, height: 10 }),
    node("iconAr", "rect", "iconA", "a0", { name: "Shape", width: 10, height: 10 }),
    node("iconB", "frame", "p", "a2", { isComponent: true, name: "Check", width: 10, height: 10 }),
    node("iconBr", "ellipse", "iconB", "a0", { name: "Shape", width: 10, height: 10 }),
    node("set", "frame", "p", "a3", {
      isComponentSet: true,
      name: "Button",
      componentProps: [
        { id: "label", name: "Label", type: "text", default: "Button" },
        { id: "show", name: "Show", type: "boolean", default: true },
        {
          id: "icon",
          name: "Icon",
          type: "instance",
          default: "iconA",
          preferred: ["iconA", "iconB"],
        },
      ],
    }),
  ];
  for (const [variant, key] of [
    ["A", "a0"],
    ["B", "a1"],
  ] as const) {
    const v = `v${variant}`;
    mains.push(
      node(v, "frame", "set", key, {
        isComponent: true,
        name: `State=${variant}`,
        variantProps: { State: variant },
        width: 200,
        height: 40,
      }),
      node(`${v}t`, "text", v, "a0", {
        name: variant === "A" ? "Label" : "Title",
        characters: "Button",
        propRefs: { characters: "label" },
      }),
      node(`${v}i`, "frame", v, "a1", {
        name: "Icon",
        instanceOf: "iconA",
        width: 10,
        height: 10,
        propRefs: { visible: "show", instanceOf: "icon" },
      }),
      node(`${v}n`, "frame", v, "a2", {
        name: "Nested",
        instanceOf: "leaf",
        exposeProps: true,
        width: 60,
        height: 20,
      }),
    );
  }
  // The nested instances' own copies, and the instance, as the editor makes them.
  const editor = new Editor({ clientId: "setup", measurer });
  editor.state.set({ role: "editor" });
  editor.doc.resetStored([], "materialized");
  editor.doc.reset(mains);
  editor.setPage("p");
  for (const id of ["vAi", "vAn", "vBi", "vBn"]) {
    const of = editor.doc.get(id)?.props.instanceOf as string;
    const made = editor.insertInstance(of) as string;
    const copy = editor.doc.childIds(made);
    // Its layers become the nested instance's, as copies.
    editor.commit(
      copy.map((c, i): Op => ({ op: "move", id: c, parent: id, key: `a${i}` })),
      "setup",
      { overrides: false },
    );
    editor.commit([{ op: "delete", id: made }], "setup", { overrides: false });
  }
  const instance = editor.insertInstance("vA") as string;
  editor.commit([{ op: "set", id: instance, prop: "name", value: "I" }]);
  return editor.doc
    .stored()
    .map((n) => (n.id === instance ? { ...n, id: "i" } : n))
    .map((n) => (n.parent === instance ? { ...n, parent: "i" } : n));
}

/** The nested Leaf instance in `i`, as `client` presents it. */
const nestedOf = (client: Client) =>
  instanceProperties(client.editor.doc, "i")?.nested[0]?.instanceId;

type Action = readonly [client: number, kind: number, arg: number];

/** Does one action; what each kind is is listed here. */
function act(room: Room, [who, kind, arg]: Action, count: { next: number }): void {
  const client = room.clients[who] as Client;
  const editor = client.editor;
  const text = `${client.name}${count.next++}`;
  switch (kind) {
    case 0:
      editor.setInstanceProperty("i", "label", text);
      return;
    case 1:
      editor.setInstanceProperty("i", "show", arg % 2 === 0);
      return;
    case 2:
      editor.setInstanceProperty("i", "icon", arg % 2 === 0 ? "iconA" : "iconB");
      return;
    case 3:
      editor.resetInstanceProperty("i", ["label", "show", "icon"][arg % 3] as string);
      return;
    case 4:
      editor.setInstanceVariant("i", "State", arg % 2 === 0 ? "A" : "B");
      return;
    case 5: {
      const nested = nestedOf(client);
      if (!nested) return;
      if (arg % 3 === 0) editor.resetInstanceProperty(nested, "leafLabel");
      else editor.setInstanceProperty(nested, "leafLabel", text);
      return;
    }
    case 6: {
      // A layer the main gains, driven by Show or Label.
      const variant = arg % 2 === 0 ? "vA" : "vB";
      const id = `added${count.next++}`;
      editor.commit([
        {
          op: "create",
          id,
          type: arg % 4 < 2 ? "rect" : "text",
          parent: variant,
          key: `b${count.next}`,
          props:
            arg % 4 < 2
              ? { width: 10, height: 10, propRefs: { visible: "show" } }
              : { characters: "Button", propRefs: { characters: "label" } },
        },
      ]);
      return;
    }
    case 7:
      editor.undo();
      return;
    case 8:
      editor.sync.flush();
      return;
    case 9:
      client.deliverOne();
      return;
    case 10:
      client.deliver();
      return;
    case 11:
      if (client.online) room.disconnect(client);
      else room.connect(client);
      return;
  }
}

const KINDS = 12;

function run(form: CopiesFormat, actions: readonly Action[]): Room {
  const room = new Room(kit(), form);
  for (const name of ["a", "b", "c"]) room.join(name);
  const count = { next: 0 };
  for (const action of actions) act(room, action, count);
  room.settle();
  return room;
}

describe("component property values converge", () => {
  it("the kit is what the test means: values on every kind of property", () => {
    const room = new Room(kit(), "compact");
    const client = room.join("a");
    const props = instanceProperties(client.editor.doc, "i");
    expect(props?.rows.map((r) => r.id)).toEqual(["State", "label", "show", "icon"]);
    expect(props?.nested[0]?.rows.map((r) => r.id)).toEqual(["leafLabel"]);
  });

  for (const form of FORMS)
    it(`three clients, random edits, resets, switches, swaps, undo and reconnects (${form})`, () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(
              fc.integer({ min: 0, max: 2 }),
              fc.integer({ min: 0, max: KINDS - 1 }),
              fc.integer({ min: 0, max: 11 }),
            ),
            { minLength: 5, maxLength: 45 },
          ),
          (actions) => {
            const room = run(form, actions);
            expectConverged(room);
            if (form === "materialized") {
              (room.clients[0] as Client).editor.setInstanceProperty("i", "label", "Settled");
              room.settle();
            }
            expectAgreement(room, "i");
          },
        ),
        {
          seed: Number(process.env.FUZZ_SEED ?? 350035),
          numRuns: Number(process.env.PROPERTY_RUNS ?? 120),
        },
      );
    }, 600_000);
});
