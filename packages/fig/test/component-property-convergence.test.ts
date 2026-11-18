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
 *
 * The third client may be a tab from before component property records
 * (protocol 2, review 4 of #187): it edits the layers a property drives as
 * plain layers, queues edits while offline, and is never refused or told to
 * reload with any unsent; once everything is in, it reloads (as its update
 * banner does) and everyone agrees. A client may also detach the instance.
 * In materialized form, the room's automatic conversion to compact copies
 * then keeps every instance (none detached) and shows what the record says,
 * when no main changed in structure meanwhile.
 */
import { Doc, instanceProperties } from "@drawpane/editor";
import { type CopiesFormat, compactByInstance, keyBetween, type NodeRecord } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buttonKit,
  type Client,
  expectAgreement,
  expectConverged,
  expectShowsRecord,
  FORMS,
  Room,
} from "./property-rooms";

/** The nested Leaf instance in `i`, as `client` presents it. */
const nestedOf = (client: Client) =>
  instanceProperties(client.editor.doc, "i")?.nested[0]?.instanceId;

type Action = readonly [client: number, kind: number, arg: number];

/**
 * What a tab from before records does (protocol 2): it doesn't see properties,
 * so it edits the layers in the instance by hand (the text, the icon's
 * visibility), a main's, or a page's (safe: a layer added). It loaded the file
 * before this change and edits offline until it connects; then it's a viewer,
 * and only its safe edits apply (`protocol2Refusal`). True when it did.
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
  if (client.protocol === 2 && actAsOldTab(client, kind, arg, text)) return;
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
    case 12:
      // Now and then the instance is detached; otherwise a value is set.
      if (arg >= 10) {
        editor.select(["i"]);
        editor.detachInstances();
      } else editor.setInstanceProperty("i", "label", text);
      return;
  }
}

const KINDS = 13;

function run(form: CopiesFormat, actions: readonly Action[], oldTab: boolean): Room {
  const room = new Room(buttonKit(), form);
  room.join("a");
  room.join("b");
  if (oldTab) room.joinOffline("c");
  else room.join("c");
  const count = { next: 0 };
  for (const action of actions) act(room, action, count);
  room.settle();
  return room;
}

/**
 * The tab from before records reloads (nothing pending: each of its edits
 * applied or was refused, and its banner waited), as today's. It's never
 * refused anything safe.
 */
function reloadOldTabs(room: Room): void {
  for (const client of [...room.clients])
    if (client.protocol === 2) {
      expect(client.editor.sync.pendingCount).toBe(0);
      expect(room.rejected.filter((r) => r.client === client.name)).toEqual([]);
      room.clients.splice(room.clients.indexOf(client), 1);
      room.join(`${client.name}-reloaded`);
    }
  room.settle();
}

/** The room's file, converted to compact copies as its room does: every instance kept, as it shows. */
function expectConverts(room: Room): void {
  const converted = compactByInstance(structuredClone([...room.store.nodes()]));
  expect([...converted.detached.entries()]).toEqual([]);
  const doc = new Doc({ compactCopies: true });
  doc.resetStored(converted.nodes, "compact");
  expectShowsRecord(doc, "i");
}

/** One schedule, and everything the property says of it once it's all delivered. */
function check(form: CopiesFormat, actions: readonly Action[], oldTab: boolean): void {
  const room = run(form, actions, oldTab);
  expectConverged(room);
  reloadOldTabs(room);
  if (form === "materialized") {
    // Converted as the room does, stale values or not. (A layer added to a main as its instance
    // switches variant leaves the instance's layers stale in structure until it syncs again,
    // which conversion keeps as it draws: not a value.)
    if (!actions.some(([, kind]) => kind === 6)) expectConverts(room);
    (room.clients[0] as Client).editor.setInstanceProperty("i", "label", "Settled");
    room.settle();
  }
  expectAgreement(room, "i");
}

describe("component property values converge", () => {
  // Review 5 of #187, P2 #7, found at seed 1875001: C swaps the icon, A detaches the instance
  // before hearing of it, C undoes its swap, then A edits. C's delayed swap and undo rebuild the
  // icon's layers copying the old main's copy layers, which the detach had pointed through to
  // the icon's own; conversion then unlinked the nested icon.
  it("the seed 1875001 schedule, after the fix: a detach that saw the swap, then its undo (materialized)", () => {
    // The same seed's next schedule once the first was fixed: B hears C's swap, then detaches;
    // C undoes its swap after.
    check(
      "materialized",
      [
        [2, 2, 3],
        [2, 8, 0],
        [1, 9, 0],
        [1, 12, 10],
        [2, 7, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      false,
    );
  });

  it("the seed 1875001 schedule, its third: the swap's undo in before the detach (materialized)", () => {
    // C sends its undo before B, who detached having seen the swap, sends the detach: the rect
    // C's undo made copies the old main's copy layer, valid then, and B's detach never saw it.
    check(
      "materialized",
      [
        [2, 2, 3],
        [2, 8, 0],
        [1, 9, 0],
        [1, 12, 10],
        [2, 7, 0],
        [0, 0, 0],
        [0, 0, 0],
        [2, 8, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      false,
    );
  });

  it("the seed 1875001 schedule: a delayed swap and undo after a detach (materialized)", () => {
    check(
      "materialized",
      [
        [2, 2, 3],
        [0, 12, 10],
        [2, 7, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      false,
    );
  });

  it("the kit is what the test means: values on every kind of property", () => {
    const room = new Room(buttonKit(), "compact");
    const client = room.join("a");
    const props = instanceProperties(client.editor.doc, "i");
    expect(props?.rows.map((r) => r.id)).toEqual(["State", "label", "show", "icon"]);
    expect(props?.nested[0]?.rows.map((r) => r.id)).toEqual(["leafLabel"]);
  });

  for (const form of FORMS)
    for (const oldTab of [false, true])
      it(`three clients, random edits, resets, switches, swaps, detach, undo and reconnects${oldTab ? ", one a tab from before records" : ""} (${form})`, () => {
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
            (actions) => check(form, actions, oldTab),
          ),
          {
            seed: Number(process.env.FUZZ_SEED ?? 350035),
            numRuns: Number(process.env.PROPERTY_RUNS ?? 120),
          },
        );
      }, 600_000);
});
