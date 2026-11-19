/**
 * Component property values under collaboration, as a property (decision
 * 0035): three clients make random edits (values, resets, variant switches,
 * swaps by an instance swap property, a nested instance's values, layers
 * added to the mains, detach, undo), sending and receiving in random order,
 * their sockets dropping and coming back, through real sync engines and a
 * room stand-in (property-rooms.ts). However it goes, once everything is
 * delivered every client and the room hold the same file; every property row
 * says what the layers it drives hold (their value, or "Mixed"); and an edit
 * of each property then sets every layer it drives, everywhere.
 *
 * A value is the value of the layers it drives, kept as ordinary overrides,
 * so the third client may be a tab from before properties: it edits those
 * layers by hand, offline at first, and is refused only what any client is
 * on main (an edit of a layer a teammate removed or detached meanwhile). A third
 * variant nests three levels deep (Leaf holds an instance of Deep), its
 * nested Leaf copy swapped by hand to another component and back.
 */
import { instanceProperties } from "@drawpane/editor";
import { type CopiesFormat, compactByInstance, keyBetween, type NodeRecord } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buttonKit,
  type Client,
  expectAgreement,
  expectConverged,
  FORMS,
  Room,
} from "./property-rooms";

/** The nested Leaf instance in `i`, as `client` presents it. */
const nestedOf = (client: Client) =>
  instanceProperties(client.editor.doc, "i")?.nested[0]?.instanceId;

type Action = readonly [client: number, kind: number, arg: number];

/**
 * What a tab from before properties does: it doesn't see them, so it edits the
 * layers in the instance by hand (the text, the icon's visibility), a main's,
 * or a page's. It loaded the file before and edits offline until it connects.
 * True when it did.
 */
function actAsOldTab(client: Client, kind: number, arg: number, text: string): boolean {
  const editor = client.editor;
  const kids = editor.doc.childIds("i").map((id) => editor.doc.get(id) as NodeRecord);
  const label = kids.find((n) => n.type === "text");
  const icon = kids.find((n) => n.props.name === "Icon");
  if (kind === 0 && label)
    editor.commit([{ op: "set", id: label.id, prop: "characters", value: text }]);
  else if (kind === 1 && icon)
    editor.commit([{ op: "set", id: icon.id, prop: "visible", value: arg % 2 === 0 }]);
  else if (kind === 2 || kind === 3 || kind === 5)
    editor.commit([
      {
        op: "create",
        id: `page${text}`,
        type: "rect",
        parent: "p",
        key: keyBetween(
          editor.doc.get(editor.doc.childIds("p").at(-1) as string)?.key ?? null,
          null,
        ),
        props: { width: 10, height: 10 },
      },
    ]);
  else if (kind === 6) {
    // A plain layer in a main: its tab knows no references.
    editor.commit([
      {
        op: "create",
        id: `old${text}`,
        type: "rect",
        parent: arg % 2 === 0 ? "vA" : "vB",
        key: `c${text}`,
        props: { width: 10, height: 10 },
      },
    ]);
  } else if (kind === 12) return true;
  else return false;
  return true;
}

/** Does one action; what each kind is is listed here. */
function act(room: Room, [who, kind, arg]: Action, count: { next: number }): void {
  const client = room.clients[who] as Client;
  const editor = client.editor;
  const text = `${client.name}${count.next++}`;
  if (client.name === OLD_TAB && actAsOldTab(client, kind, arg, text)) return;
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
    case 13: {
      // The nested Leaf copy swapped by hand, to Other or back (the deep kit has Other).
      const nested =
        nestedOf(client) ??
        editor.doc.childIds("i").find((id) => {
          const n = editor.doc.get(id);
          return n?.props.name === "Nested";
        });
      if (nested && editor.doc.has("other"))
        editor.swapInstance(nested, arg % 2 === 0 ? "other" : "leaf");
      return;
    }
    case 12:
      // Now and then the instance is detached; otherwise a value is set.
      if (arg >= 10) {
        editor.select(["i"]);
        editor.detachInstances();
      } else editor.setInstanceProperty("i", "label", text);
      return;
  }
}

const KINDS = 14;

/** The client that acts as a tab from before properties, when there's one. */
const OLD_TAB = "old";

function run(form: CopiesFormat, actions: readonly Action[], oldTab: boolean, deep = false): Room {
  const room = new Room(buttonKit({ deep }), form);
  room.join("a");
  room.join("b");
  if (oldTab) room.joinOffline(OLD_TAB);
  else room.join("c");
  const count = { next: 0 };
  for (const action of actions) act(room, action, count);
  room.settle();
  return room;
}

/** One schedule, and everything the property says of it once it's all delivered. */
function check(
  form: CopiesFormat,
  actions: readonly Action[],
  oldTab: boolean,
  deep = false,
): void {
  const room = run(form, actions, oldTab, deep);
  expectConverged(room);
  // A tab from before properties is refused nothing for what it is: its edits are ordinary ones.
  // What any client's edit is refused on main still is: one of a layer a teammate removed meanwhile
  // (a variant switch rebuilds the layers), and with compact copies one of a copy layer a teammate
  // detached meanwhile, its override record made where the plain layer is now, or under what's a
  // plain frame now (both reproduced on main without properties: a follow-up for compact copies).
  const onMain = new Set(["not_found", "already_exists", "invalid_parent"]);
  if (oldTab)
    expect(room.rejected.filter((r) => r.client === OLD_TAB && !onMain.has(r.code))).toEqual([]);
  expectAgreement(room, "i");
}

describe("component property values converge", () => {
  it("the deep kit is three levels deep: the instance's Leaf copy holds a copy of Deep", () => {
    const room = new Room(buttonKit({ deep: true }), "materialized");
    const doc = room.join("a").editor.doc;
    const leafCopy = doc.childIds("i").find((id) => doc.get(id)?.props.instanceOf === "leaf");
    const deepCopy = doc
      .childIds(leafCopy as string)
      .find((id) => doc.get(id)?.props.instanceOf === "deep");
    expect(deepCopy && doc.childIds(deepCopy).map((id) => doc.get(id)?.props.characters)).toEqual([
      "Deep",
    ]);
    expect([...compactByInstance([...room.store.nodes()]).detached]).toEqual([]);
  });

  it("the kit is what the test means: values on every kind of property", () => {
    const room = new Room(buttonKit(), "compact");
    const client = room.join("a");
    const props = instanceProperties(client.editor.doc, "i");
    expect(props?.rows.map((r) => r.id)).toEqual(["State", "label", "show", "icon"]);
    expect(props?.nested[0]?.rows.map((r) => r.id)).toEqual(["leafLabel"]);
  });

  for (const form of FORMS)
    for (const [oldTab, deep] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const)
      it(`three clients, random edits, resets, switches, swaps, detach, undo and reconnects${oldTab ? ", one a tab from before properties" : ""}${deep ? ", three levels deep" : ""} (${form})`, () => {
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
            (actions) => check(form, actions, oldTab, deep),
          ),
          {
            seed: Number(process.env.FUZZ_SEED ?? 350035),
            numRuns: Number(process.env.PROPERTY_RUNS ?? 120),
          },
        );
      }, 600_000);
});
