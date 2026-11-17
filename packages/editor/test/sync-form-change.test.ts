/**
 * Pending edits across a change of the file's form (decision 0029): ids
 * they hold that name copy layers are found in the new form, as the
 * converter renames them, or the edit is dropped with the engine's notice.
 * Never sent with an id the file doesn't have. The seventh review found a
 * custom reading order saved with the copies' old ids, which the room
 * accepted and which fell back to layout order.
 */
import {
  applyTransaction,
  type ClientMessage,
  compactByInstance,
  copyId,
  DEFAULT_TRANSITION,
  MemoryStore,
  type NodeRecord,
  type Op,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { SyncEngine } from "../src/sync";

/** A main with two texts, an instance of it whose copies are C and D, and a screen to link from. */
const original: NodeRecord[] = [
  { id: "P", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  { id: "M", type: "frame", parent: "P", key: "a0", props: { isComponent: true } },
  { id: "R", type: "text", parent: "M", key: "a0", props: { characters: "First", y: 0 } },
  { id: "S", type: "text", parent: "M", key: "a1", props: { characters: "Second", y: 20 } },
  { id: "I", type: "frame", parent: "P", key: "a1", props: { instanceOf: "M" } },
  {
    id: "C",
    type: "text",
    parent: "I",
    key: "a0",
    props: { characters: "First", y: 0, mirrors: "R" },
  },
  {
    id: "D",
    type: "text",
    parent: "I",
    key: "a1",
    props: { characters: "Second", y: 20, mirrors: "S" },
  },
  { id: "F", type: "frame", parent: "P", key: "a2", props: {} },
];
const converted = compactByInstance(original);
const C2 = copyId("I", ["R"]);
const D2 = copyId("I", ["S"]);

type Form = "materialized" | "compact";

/** A client loaded in `from`, offline while it makes `edit`, then welcomed back in `to`. */
function across(
  from: { form: Form; nodes: readonly NodeRecord[] },
  to: { form: Form; nodes: readonly NodeRecord[] },
  edit: Op[],
) {
  const doc = new Doc({ compactCopies: from.form === "compact" });
  const engine = new SyncEngine(doc, { clientId: "client", setTimer: () => 0 });
  const sent: ClientMessage[] = [];
  const notices: string[] = [];
  engine.on("rejected", (_code, message) => notices.push(message));
  const welcome = (revn: number, copies: Form) =>
    engine.receive({
      t: "welcome",
      revn,
      copies,
      mode: "snapshot",
      sessionId: "s",
      role: "editor",
      peers: [],
      lastSeq: 0,
    });
  engine.connected((m) => sent.push(m));
  welcome(1, from.form);
  engine.receive({ t: "snapshot", nodes: [...from.nodes], done: true });
  engine.disconnected();
  engine.commit(edit);
  engine.connected((m) => sent.push(m));
  welcome(2, to.form);
  engine.receive({ t: "snapshot", nodes: [...to.nodes], done: true });
  engine.flush();
  const txns = sent.filter((m): m is Extract<ClientMessage, { t: "txn" }> => m.t === "txn");
  return { doc, txns, notices };
}

/** The value a set of `prop` was sent with. */
function sentValue(txns: ReturnType<typeof across>["txns"], prop: string): unknown {
  const ops = txns.flatMap((t) => t.ops);
  const op = ops.find((o) => o.op === "set" && o.prop === prop) as
    | Extract<Op, { op: "set" }>
    | undefined;
  return op?.value;
}

describe("pending edits across a change of the file's form", () => {
  it("keeps a reading order of copies, by their derived ids, when the room converted the file", () => {
    expect(converted.detached.size).toBe(0);
    const { doc, txns, notices } = across(
      { form: "materialized", nodes: original },
      { form: "compact", nodes: converted.nodes },
      [{ op: "set", id: "I", prop: "readingOrder", value: ["D", "C"] }],
    );
    expect(sentValue(txns, "readingOrder")).toEqual([D2, C2]);
    expect(doc.get("I")?.props.readingOrder).toEqual([D2, C2]);
    expect(notices).toEqual([]);
    // As the room applies it, to the file as it stores it: the copies it names are there.
    const room = new MemoryStore(converted.nodes);
    applyTransaction(room, txns.flatMap((t) => t.ops) as Op[]);
    expect(room.get("I")?.props.readingOrder).toEqual([D2, C2]);
  });

  it("keeps a prototype link to a copy, by its derived id", () => {
    const reactions = [
      {
        id: "tapToD000000000a",
        trigger: { type: "tap" },
        action: { type: "navigate", to: "D" },
        transition: DEFAULT_TRANSITION,
      },
    ];
    const { txns } = across(
      { form: "materialized", nodes: original },
      { form: "compact", nodes: converted.nodes },
      [{ op: "set", id: "F", prop: "reactions", value: reactions }],
    );
    const value = sentValue(txns, "reactions") as Array<{ action: { to: string } }>;
    expect(value[0]?.action.to).toBe(D2);
  });

  it("keeps a reading order of copies, by their old ids, when a rollback put the file back", () => {
    const { txns, notices } = across(
      { form: "compact", nodes: converted.nodes },
      { form: "materialized", nodes: original },
      [{ op: "set", id: "I", prop: "readingOrder", value: [D2, C2] }],
    );
    expect(sentValue(txns, "readingOrder")).toEqual(["D", "C"]);
    expect(notices).toEqual([]);
  });

  it("keeps a held id of a layer that isn't a copy as it is", () => {
    const { txns } = across(
      { form: "materialized", nodes: original },
      { form: "compact", nodes: converted.nodes },
      [{ op: "set", id: "F", prop: "readingOrder", value: ["I", "M"] }],
    );
    expect(sentValue(txns, "readingOrder")).toEqual(["I", "M"]);
  });

  it("drops an edit naming a copy the new form doesn't have, with the notice, and sends nothing", () => {
    // Meanwhile someone deleted the main's second text: its copy D is gone with it.
    const without = compactByInstance(original.filter((n) => n.id !== "S" && n.id !== "D"));
    const { doc, txns, notices } = across(
      { form: "materialized", nodes: original },
      { form: "compact", nodes: without.nodes },
      [{ op: "set", id: "I", prop: "readingOrder", value: ["D", "C"] }],
    );
    expect(txns).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/couldn't be kept/);
    expect(doc.get("I")?.props.readingOrder).toBeUndefined();
  });

  it("keeps an instance's copies by their ids when the room detached it", () => {
    // A detached instance keeps its layers and their ids, unlinked from its main.
    const detached = original.map((n) => {
      if (n.id === "I") return { ...n, props: {} };
      if (n.id === "C" || n.id === "D") {
        const { mirrors: _, ...props } = n.props;
        return { ...n, props };
      }
      return n;
    });
    const { txns } = across(
      { form: "materialized", nodes: original },
      { form: "compact", nodes: compactByInstance(detached).nodes },
      [{ op: "set", id: "I", prop: "readingOrder", value: ["D", "C"] }],
    );
    expect(sentValue(txns, "readingOrder")).toEqual(["D", "C"]);
  });
});
