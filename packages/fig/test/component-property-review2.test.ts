/**
 * The second review of component properties (#187), as tests. Each case
 * failed on #187's head (8b84912) and passes with decision 0035's values
 * written one property at a time (a keyed `set`), a teammate's edit
 * reconciled with the values it couldn't see, nested instances' values
 * carried across an outer switch, and the review's other fixes. The cases
 * the review ran as controls (they passed there) stay here too, so they
 * keep passing.
 *
 * Collaboration goes through a room stand-in (`Room`): each client's
 * edits are sent as stored, ordered by the room and replayed by the
 * others' sync engines, as `FileRoom` and `SyncEngine` do. Every case
 * runs with copies stored both ways.
 */
import { readFileSync } from "node:fs";
import { Doc, Editor, instanceProperties, pinInstances } from "@drawpane/editor";
import { convertFile, type Figma } from "@drawpane/figma";
import {
  applyTransaction,
  branchChanges,
  type ClientMessage,
  type CopiesFormat,
  compactByInstance,
  getProp,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_PROPERTY_VALUES_CHARS,
  MemoryStore,
  ModelError,
  mergeOps,
  type NodeRecord,
  type Op,
  PROPS,
  ROOT_ID,
  type ServerMessage,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { effectiveValues, propertyFollowOps } from "../../editor/src/property-values";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown>,
): NodeRecord => ({ id, type, parent, key, props: props as NodeRecord["props"] });

const FORMS: readonly CopiesFormat[] = ["materialized", "compact"];
const measurer = { width: (_font: unknown, text: string) => text.length * 7 };

/** A set with a text property (Label) and a boolean (Show), and an instance that set both. */
function simple(): NodeRecord[] {
  return [
    node("p", "page", ROOT_ID, "a0", {}),
    node("set", "frame", "p", "a0", {
      isComponentSet: true,
      componentProps: [
        { id: "label", name: "Label", type: "text" },
        { id: "show", name: "Show", type: "boolean" },
      ],
    }),
    node("a", "frame", "set", "a0", {
      isComponent: true,
      variantProps: { State: "A" },
      width: 100,
      height: 30,
    }),
    node("ta", "text", "a", "a0", {
      name: "Text",
      characters: "Base",
      propRefs: { characters: "label" },
    }),
    node("va", "rect", "a", "a1", {
      name: "Icon",
      width: 10,
      height: 10,
      propRefs: { visible: "show" },
    }),
    node("b", "frame", "set", "a1", {
      isComponent: true,
      variantProps: { State: "B" },
      width: 100,
      height: 30,
    }),
    node("tb", "text", "b", "a0", {
      name: "Text",
      characters: "Base",
      propRefs: { characters: "label" },
    }),
    node("vb", "rect", "b", "a1", {
      name: "Icon",
      width: 10,
      height: 10,
      propRefs: { visible: "show" },
    }),
    node("i", "frame", "p", "a1", {
      instanceOf: "a",
      width: 100,
      height: 30,
      propValues: { label: "Before", show: true },
    }),
    node("it", "text", "i", "a0", {
      mirrors: "ta",
      name: "Text",
      characters: "Before",
      propRefs: { characters: "label" },
      overrides: ["characters"],
    }),
    node("iv", "rect", "i", "a1", {
      mirrors: "va",
      name: "Icon",
      width: 10,
      height: 10,
      propRefs: { visible: "show" },
      overrides: ["visible"],
    }),
  ];
}

/** `simple`'s instance from before records: its values only on its layers. */
const legacy = (): NodeRecord[] =>
  simple().map((n) => {
    if (n.id !== "i") return n;
    const { propValues: _, ...props } = n.props;
    return { ...n, props };
  });

/** Variants A and B, each with a nested instance of Leaf (a text property) named Nested. */
function nested(): NodeRecord[] {
  return [
    node("p", "page", ROOT_ID, "a0", {}),
    node("leaf", "frame", "p", "a0", {
      isComponent: true,
      width: 100,
      height: 30,
      componentProps: [{ id: "label", name: "Label", type: "text" }],
    }),
    node("t", "text", "leaf", "a0", {
      name: "Text",
      characters: "Base",
      propRefs: { characters: "label" },
    }),
    node("set", "frame", "p", "a1", { isComponentSet: true }),
    node("a", "frame", "set", "a0", {
      isComponent: true,
      variantProps: { State: "A" },
      width: 100,
      height: 30,
    }),
    node("na", "frame", "a", "a0", {
      name: "Nested",
      instanceOf: "leaf",
      exposeProps: true,
      width: 100,
      height: 30,
    }),
    node("nat", "text", "na", "a0", {
      name: "Text",
      mirrors: "t",
      characters: "Base",
      propRefs: { characters: "label" },
    }),
    node("b", "frame", "set", "a1", {
      isComponent: true,
      variantProps: { State: "B" },
      width: 100,
      height: 30,
    }),
    node("nb", "frame", "b", "a0", {
      name: "Nested",
      instanceOf: "leaf",
      exposeProps: true,
      width: 100,
      height: 30,
    }),
    node("nbt", "text", "nb", "a0", {
      name: "Text",
      mirrors: "t",
      characters: "Base",
      propRefs: { characters: "label" },
    }),
    node("i", "frame", "p", "a2", { instanceOf: "a", width: 100, height: 30 }),
    node("ni", "frame", "i", "a0", {
      mirrors: "na",
      name: "Nested",
      instanceOf: "leaf",
      exposeProps: true,
      width: 100,
      height: 30,
    }),
    node("nit", "text", "ni", "a0", {
      mirrors: "nat",
      name: "Text",
      characters: "Base",
      propRefs: { characters: "label" },
    }),
  ];
}

// ---------------------------------------------------------------------------
// A room and its clients

/** A FileRoom stand-in: it orders transactions, acknowledges them, and passes them on when asked. */
class Room {
  readonly store: MemoryStore;
  revn = 1;
  readonly clients: Client[] = [];
  /** Old ids to the stored form's (compact copies rename copy layers). */
  readonly ids: ReadonlyMap<string, string>;
  readonly lastSeq = new Map<string, number>();

  /** A room holding `nodes` as stored already, in `copies` form. */
  static stored(nodes: readonly NodeRecord[], copies: CopiesFormat): Room {
    return new Room(nodes, copies, true);
  }

  constructor(
    nodes: readonly NodeRecord[],
    readonly copies: CopiesFormat,
    stored = false,
  ) {
    if (copies === "compact" && !stored) {
      const converted = compactByInstance(structuredClone(nodes));
      this.store = new MemoryStore(converted.nodes);
      this.ids = converted.ids;
    } else {
      this.store = new MemoryStore(structuredClone(nodes));
      this.ids = new Map();
    }
  }

  id(old: string): string {
    return this.ids.get(old) ?? old;
  }

  join(name: string): Client {
    const client = new Client(this, name);
    this.clients.push(client);
    client.editor.sync.connected((message) => this.handle(client, message));
    client.deliver();
    return client;
  }

  handle(from: Client, message: ClientMessage): void {
    if (message.t === "hello") {
      from.inbox.push(
        {
          t: "welcome",
          sessionId: from.name,
          revn: this.revn,
          role: "editor",
          peers: [],
          mode: "snapshot",
          lastSeq: this.lastSeq.get(from.name) ?? 0,
          copies: this.copies,
        },
        { t: "snapshot", nodes: structuredClone([...this.store.nodes()]), done: false },
        { t: "snapshot", nodes: [], done: true },
      );
      return;
    }
    if (message.t !== "txn") return;
    try {
      applyTransaction(this.store, message.ops as Op[]);
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      from.inbox.push({
        t: "reject",
        seq: message.seq,
        code: error.code,
        message: error.message,
        fix: {},
      });
      return;
    }
    this.revn++;
    this.lastSeq.set(from.name, message.seq);
    from.inbox.push({ t: "ack", seq: message.seq, revn: this.revn });
    this.broadcast(message.ops as Op[], from);
  }

  /** A transaction the room makes itself (a branch merge), passed to every client. */
  commit(ops: readonly Op[]): void {
    applyTransaction(this.store, [...ops]);
    this.revn++;
    this.broadcast(ops, null);
  }

  broadcast(ops: readonly Op[], from: Client | null): void {
    for (const other of this.clients)
      if (other !== from)
        other.inbox.push({
          t: "txn",
          revn: this.revn,
          ops: structuredClone([...ops]),
          author: { userId: "u", sessionId: from?.name ?? "room" },
        });
  }

  /** Sends what every client has and delivers everything, until nothing moves. */
  settle(): void {
    for (let round = 0; round < 20; round++) {
      for (const client of this.clients) client.editor.sync.flush();
      if (this.clients.every((c) => c.inbox.length === 0)) return;
      for (const client of this.clients) client.deliver();
    }
    throw new Error("the room didn't settle");
  }
}

class Client {
  readonly editor: Editor;
  readonly inbox: ServerMessage[] = [];

  constructor(
    readonly room: Room,
    readonly name: string,
  ) {
    this.editor = new Editor({ clientId: name, measurer });
  }

  deliver(): void {
    while (this.inbox.length > 0) this.editor.sync.receive(this.inbox.shift() as ServerMessage);
    if (!this.editor.state.get().pageId) this.editor.setPage("p");
  }

  row(instance: string, property: string) {
    return instanceProperties(this.editor.doc, instance)?.rows.find((r) => r.id === property);
  }

  record(instance: string) {
    return getProp(this.editor.doc.get(instance)?.props ?? {}, "propValues");
  }

  field(id: string, field: "characters" | "visible") {
    return getProp(this.editor.doc.get(id)?.props ?? {}, field);
  }
}

/** Every client shows each property's recorded value on every layer it drives. */
function expectAgreement(room: Room, instance: string): void {
  const first = room.clients[0] as Client;
  for (const client of room.clients) {
    expect(client.record(instance)).toEqual(first.record(instance));
    for (const row of instanceProperties(client.editor.doc, instance)?.rows ?? []) {
      if (row.type !== "text" && row.type !== "boolean") continue;
      const field = row.type === "text" ? "characters" : "visible";
      for (const target of row.targets) expect(client.field(target, field)).toBe(row.value);
    }
  }
  // And the room stores what they show.
  const stored = new Doc({ compactCopies: room.copies === "compact" });
  stored.resetStored(structuredClone([...room.store.nodes()]), room.copies);
  expect(getProp(stored.get(instance)?.props ?? {}, "propValues")).toEqual(first.record(instance));
  for (const row of instanceProperties(stored, instance)?.rows ?? []) {
    if (row.type !== "text" && row.type !== "boolean") continue;
    const field = row.type === "text" ? "characters" : "visible";
    for (const target of row.targets)
      expect(getProp(stored.get(target)?.props ?? {}, field)).toBe(row.value);
  }
}

/** A standalone editor on `nodes`, its stored operations kept. */
function open(form: CopiesFormat, nodes: readonly NodeRecord[]) {
  const editor = new Editor({ clientId: "review2", measurer });
  editor.state.set({ role: "editor" });
  editor.doc.resetStored([], form);
  editor.doc.reset(structuredClone(nodes));
  editor.setPage("p");
  const sent: Op[][] = [];
  const commit = editor.sync.commit.bind(editor.sync);
  editor.sync.commit = (ops: readonly Op[]) => {
    const inverse = commit(ops);
    if (ops.length > 0) sent.push([...editor.doc.lastStoredOps]);
    return inverse;
  };
  const row = (instance: string, property: string) =>
    instanceProperties(editor.doc, instance)?.rows.find((r) => r.id === property);
  return { editor, sent, id: (id: string) => editor.doc.resetIds.get(id) ?? id, row };
}

// ---------------------------------------------------------------------------
// Finding 1 (P1): one atomic record lost independent edits

for (const form of FORMS)
  describe(`values are written one property at a time (${form})`, () => {
    it("concurrent edits of different properties both stay, and the canvas shows the record", () => {
      const room = new Room(simple(), form);
      const a = room.join("a");
      const b = room.join("b");
      a.editor.setInstanceProperty("i", "label", "Alice");
      b.editor.setInstanceProperty("i", "show", false);
      room.settle();
      for (const client of [a, b]) {
        expect(client.row("i", "label")?.value).toBe("Alice");
        expect(client.row("i", "show")?.value).toBe(false);
      }
      expectAgreement(room, "i");
      // Showing it again doesn't bring back the label from before.
      a.editor.setInstanceProperty("i", "show", true);
      room.settle();
      expect(b.row("i", "label")?.value).toBe("Alice");
      expectAgreement(room, "i");
    });

    it("a panel edit and typing in another property's layer at once both stay", () => {
      const room = new Room(simple(), form);
      const a = room.join("a");
      const b = room.join("b");
      a.editor.setInstanceProperty("i", "show", false);
      b.editor.setProp([room.id("it")], "characters", "Bob");
      // The typing reaches the room first.
      b.editor.sync.flush();
      room.settle();
      for (const client of [a, b]) {
        expect(client.row("i", "label")?.value).toBe("Bob");
        expect(client.row("i", "show")?.value).toBe(false);
      }
      expectAgreement(room, "i");
    });

    it("concurrent edits of the same property: the later one wins everywhere", () => {
      const room = new Room(simple(), form);
      const a = room.join("a");
      const b = room.join("b");
      a.editor.setInstanceProperty("i", "label", "Alice");
      b.editor.setInstanceProperty("i", "label", "Bob");
      a.editor.sync.flush();
      b.editor.sync.flush();
      room.settle();
      for (const client of [a, b]) expect(client.row("i", "label")?.value).toBe("Bob");
      expectAgreement(room, "i");
    });

    it("undo after a teammate's edit of another property keeps theirs", () => {
      const room = new Room(simple(), form);
      const local = room.join("local");
      const peer = room.join("peer");
      local.editor.setInstanceProperty("i", "label", "Local");
      room.settle();
      peer.editor.setInstanceProperty("i", "show", false);
      room.settle();
      expect(local.row("i", "show")?.value).toBe(false);
      local.editor.undo();
      room.settle();
      for (const client of [local, peer]) {
        expect(client.row("i", "label")?.value).toBe("Before");
        expect(client.row("i", "show")?.value).toBe(false);
      }
      expectAgreement(room, "i");
      // A later edit doesn't bring the old Show back either.
      local.editor.setInstanceProperty("i", "label", "Again");
      room.settle();
      expect(peer.row("i", "show")?.value).toBe(false);
      expectAgreement(room, "i");
    });

    it("a layer added to the main meanwhile takes the value set at the same time", () => {
      const room = new Room(simple(), form);
      const a = room.join("a");
      const b = room.join("b");
      a.editor.setInstanceProperty("i", "show", false);
      b.editor.commit([
        {
          op: "create",
          id: "secondIcon",
          type: "rect",
          parent: "a",
          key: "a2",
          props: { name: "New target", width: 10, height: 10, propRefs: { visible: "show" } },
        },
      ]);
      // B wrote no value: it didn't know of A's.
      expect(
        b.editor.sync.pendingCount > 0 &&
          !b.editor.doc.lastStoredOps.some((o) => o.op === "set" && o.prop === "propValues"),
      ).toBe(true);
      a.editor.sync.flush();
      room.settle();
      for (const client of [a, b]) {
        const targets = client.row("i", "show")?.targets ?? [];
        expect(targets.length).toBe(2);
        expect(targets.map((t) => client.field(t, "visible"))).toEqual([false, false]);
      }
      expectAgreement(room, "i");
    });

    it("the same, with the new layer reaching the room first", () => {
      const room = new Room(simple(), form);
      const a = room.join("a");
      const b = room.join("b");
      a.editor.setInstanceProperty("i", "show", false);
      b.editor.commit([
        {
          op: "create",
          id: "secondIcon",
          type: "rect",
          parent: "a",
          key: "a2",
          props: { name: "New target", width: 10, height: 10, propRefs: { visible: "show" } },
        },
      ]);
      b.editor.sync.flush();
      room.settle();
      for (const client of [a, b])
        expect(
          (client.row("i", "show")?.targets ?? []).map((t) => client.field(t, "visible")),
        ).toEqual([false, false]);
      expectAgreement(room, "i");
    });

    it("an edit sent before a reconnect and replayed after keeps the other property", () => {
      const room = new Room(simple(), form);
      const a = room.join("a");
      const b = room.join("b");
      a.editor.setInstanceProperty("i", "label", "Offline");
      a.editor.sync.disconnected();
      b.editor.setInstanceProperty("i", "show", false);
      room.settle();
      a.editor.sync.connected((message) => room.handle(a, message));
      room.settle();
      for (const client of [a, b]) {
        expect(client.row("i", "label")?.value).toBe("Offline");
        expect(client.row("i", "show")?.value).toBe(false);
      }
      expectAgreement(room, "i");
    });
  });

for (const form of FORMS)
  describe(`branches merge each value on its own (${form})`, () => {
    /** Main sets Label, the branch Show, from the same base. */
    function diverged() {
      const base = open(form, simple());
      const branch = open(form, simple());
      const main = open(form, simple());
      main.editor.setInstanceProperty("i", "label", "Main");
      branch.editor.setInstanceProperty("i", "show", false);
      const changes = branchChanges(
        base.editor.doc.storedReader(),
        branch.editor.doc.storedReader(),
        main.editor.doc.storedReader(),
      );
      return { branch, main, changes };
    }

    it("different properties changed on each side don't conflict, and both come in", () => {
      const { branch, main, changes } = diverged();
      const values = changes.filter((c) => c.kind === "changed" && c.field === "propValues");
      expect(values.map((c) => (c.kind === "changed" ? [c.key, c.conflict] : null))).toEqual([
        ["show", false],
      ]);
      main.editor.doc.applyStored(
        mergeOps(main.editor.doc.storedReader(), branch.editor.doc.storedReader(), changes),
      );
      expect(main.row("i", "label")?.value).toBe("Main");
      expect(main.row("i", "show")?.value).toBe(false);
      for (const id of ["label", "show"] as const) {
        const row = main.row("i", id);
        const field = id === "label" ? "characters" : "visible";
        for (const target of row?.targets ?? [])
          expect(getProp(main.editor.doc.get(target)?.props ?? {}, field)).toBe(row?.value);
      }
    });

    it("taking the branch's side of the whole record's old key changes nothing else", () => {
      const { branch, main, changes } = diverged();
      // The review's resolution, by the key the record had as one value: nothing conflicts now.
      const ops = mergeOps(
        main.editor.doc.storedReader(),
        branch.editor.doc.storedReader(),
        changes,
        new Map([["i:propValues", "branch"]]),
      );
      main.editor.doc.applyStored(ops);
      const label = main.row("i", "label");
      expect(label?.value).toBe("Main");
      for (const target of label?.targets ?? [])
        expect(getProp(main.editor.doc.get(target)?.props ?? {}, "characters")).toBe("Main");
    });

    it("one property changed on both sides, resolved differently for record and layer, ends as the record", () => {
      const base = open(form, simple());
      const branch = open(form, simple());
      const main = open(form, simple());
      main.editor.setInstanceProperty("i", "label", "Main");
      branch.editor.setInstanceProperty("i", "label", "Branch");
      const changes = branchChanges(
        base.editor.doc.storedReader(),
        branch.editor.doc.storedReader(),
        main.editor.doc.storedReader(),
      );
      const record = changes.find((c) => c.kind === "changed" && c.field === "propValues");
      expect(record?.kind === "changed" && record.key === "label" && record.conflict).toBe(true);
      // The record takes the branch's value; any layer conflict is left on main's side.
      const ops = mergeOps(
        main.editor.doc.storedReader(),
        branch.editor.doc.storedReader(),
        changes,
        new Map([["i:propValues:label", "branch"]]),
      );
      // The room holds main as stored; the merge is its own transaction, which its clients get.
      const room = Room.stored(main.editor.doc.stored(), form);
      const client = room.join("on-main");
      room.commit(ops);
      room.settle();
      const label = client.row("i", "label");
      expect(label?.value).toBe("Branch");
      for (const target of label?.targets ?? [])
        expect(client.field(target, "characters")).toBe("Branch");
    });
  });

// ---------------------------------------------------------------------------
// Finding 2 (P1): an outer switch dropped nested instances' values

for (const form of FORMS)
  describe(`nested values across an outer switch (${form})`, () => {
    it("a nested instance keeps its value when the outer instance switches variant", () => {
      const { editor, row } = open(form, nested());
      const ni = instanceProperties(editor.doc, "i")?.nested[0]?.instanceId as string;
      editor.setInstanceProperty(ni, "label", "Nested custom");
      expect(row(ni, "label")?.value).toBe("Nested custom");
      editor.setInstanceVariant("i", "State", "B");
      const next = instanceProperties(editor.doc, "i")?.nested[0]?.instanceId as string;
      const label = row(next, "label");
      expect(label?.value).toBe("Nested custom");
      expect(label?.changed).toBe(true);
      expect(getProp(editor.doc.get(next)?.props ?? {}, "propValues")).toEqual({
        label: "Nested custom",
      });
      for (const target of label?.targets ?? [])
        expect(getProp(editor.doc.get(target)?.props ?? {}, "characters")).toBe("Nested custom");
      // One undo puts it all back; redo switches again with the value.
      editor.undo();
      const back = instanceProperties(editor.doc, "i")?.nested[0]?.instanceId as string;
      expect(getProp(editor.doc.get("i")?.props ?? {}, "instanceOf")).toBe("a");
      expect(row(back, "label")?.value).toBe("Nested custom");
      editor.redo();
      const again = instanceProperties(editor.doc, "i")?.nested[0]?.instanceId as string;
      expect(row(again, "label")?.value).toBe("Nested custom");
    });

    it("a nested instance named differently is matched by its component", () => {
      const nodes = nested().map((n) =>
        n.id === "nb" ? { ...n, props: { ...n.props, name: "Renamed" } } : n,
      );
      const { editor, row } = open(form, nodes);
      const ni = instanceProperties(editor.doc, "i")?.nested[0]?.instanceId as string;
      editor.setInstanceProperty(ni, "label", "By component");
      editor.setInstanceVariant("i", "State", "B");
      const next = instanceProperties(editor.doc, "i")?.nested[0]?.instanceId as string;
      expect(row(next, "label")?.value).toBe("By component");
    });

    it("a nested value from before records goes across too", () => {
      const nodes = nested().map((n) =>
        n.id === "nit"
          ? { ...n, props: { ...n.props, characters: "Legacy nested", overrides: ["characters"] } }
          : n,
      );
      const { editor, row } = open(form, nodes);
      editor.setInstanceVariant("i", "State", "B");
      const next = instanceProperties(editor.doc, "i")?.nested[0]?.instanceId as string;
      expect(row(next, "label")?.value).toBe("Legacy nested");
    });
  });

// ---------------------------------------------------------------------------
// The review's controls (they passed on #187's head), kept

for (const form of FORMS)
  describe(`controls (${form})`, () => {
    it("undo restores value and canvas across variant switches", () => {
      const { editor, row } = open(form, simple());
      editor.setInstanceProperty("i", "label", "Before switch");
      editor.setInstanceVariant("i", "State", "B");
      editor.undo();
      expect(getProp(editor.doc.get("i")?.props ?? {}, "instanceOf")).toBe("a");
      expect(row("i", "label")?.value).toBe("Before switch");
      for (const target of row("i", "label")?.targets ?? [])
        expect(getProp(editor.doc.get(target)?.props ?? {}, "characters")).toBe("Before switch");
      editor.redo();
      expect(getProp(editor.doc.get("i")?.props ?? {}, "instanceOf")).toBe("b");
      expect(row("i", "label")?.value).toBe("Before switch");
    });

    it("keeps a nested record effective when the outer main edits its nested instance", () => {
      const { editor, row } = open(form, nested());
      const ni = instanceProperties(editor.doc, "i")?.nested[0]?.instanceId as string;
      editor.setInstanceProperty(ni, "label", "Local");
      editor.setInstanceProperty("na", "label", "Outer");
      expect(row(ni, "label")?.value).toBe("Local");
      for (const target of row(ni, "label")?.targets ?? [])
        expect(getProp(editor.doc.get(target)?.props ?? {}, "characters")).toBe("Local");
    });

    it("nested values apply to newly linked layers several levels deep", () => {
      const nodes = nested();
      nodes.push(
        node("shell", "frame", "p", "a3", {
          isComponent: true,
          name: "Shell",
          width: 100,
          height: 30,
        }),
      );
      const { editor, row } = open(form, nodes);
      const inner = editor.insertInstance("a") as string;
      editor.commit([{ op: "move", id: inner, parent: "shell", key: "a0" }]);
      const shell = editor.insertInstance("shell") as string;
      const stack = [...editor.doc.childIds(shell)];
      let deep: string | undefined;
      while (stack.length > 0) {
        const id = stack.pop() as string;
        if (getProp(editor.doc.get(id)?.props ?? {}, "instanceOf") === "leaf") deep = id;
        stack.push(...editor.doc.childIds(id));
      }
      expect(deep).toBeTruthy();
      editor.setInstanceProperty(deep as string, "label", "Deep");
      editor.commit([
        {
          op: "create",
          id: "t2",
          type: "text",
          parent: "leaf",
          key: "a1",
          props: { name: "Second", characters: "Base", propRefs: { characters: "label" } },
        },
      ]);
      const targets = row(deep as string, "label")?.targets ?? [];
      expect(targets.map((t) => getProp(editor.doc.get(t)?.props ?? {}, "characters"))).toEqual([
        "Deep",
        "Deep",
      ]);
      if (form === "compact") {
        const stored = editor.doc.storedReader().get(deep as string) as NodeRecord;
        expect(stored.type).toBe("override");
        expect(stored.props.propValues).toEqual({ label: "Deep" });
        expect((stored.props.path ?? []).length).toBeGreaterThanOrEqual(2);
      }
      const reopened = new Doc({ compactCopies: form === "compact" });
      reopened.resetStored(structuredClone(editor.doc.stored()), form);
      const restored = instanceProperties(reopened, deep as string)?.rows.find(
        (r) => r.id === "label",
      );
      expect(restored?.value).toBe("Deep");
      expect(
        (restored?.targets ?? []).map((t) => getProp(reopened.get(t)?.props ?? {}, "characters")),
      ).toEqual(["Deep", "Deep"]);
    });

    it("a legacy disagreement is adopted in layer order", () => {
      const nodes = legacy();
      nodes.push(
        node("ta2", "text", "a", "a2", {
          name: "Second",
          characters: "Base",
          propRefs: { characters: "label" },
        }),
        node("it2", "text", "i", "a2", {
          mirrors: "ta2",
          name: "Second",
          characters: "Second override",
          propRefs: { characters: "label" },
          overrides: ["characters"],
        }),
      );
      const { editor, row } = open(form, nodes);
      expect(effectiveValues(editor.doc, "i").label).toBe("Before");
      editor.setInstanceProperty("i", "show", false);
      expect(
        (row("i", "label")?.targets ?? []).map((t) =>
          getProp(editor.doc.get(t)?.props ?? {}, "characters"),
        ),
      ).toEqual(["Before", "Before"]);
    });
  });

// ---------------------------------------------------------------------------
// Findings 3 to 5 (P2)

for (const form of FORMS)
  describe(`resets and direct edits (${form})`, () => {
    it("resetting a field on a swapped nested root restores the chosen component's binding", () => {
      const nodes = nested();
      nodes.push(
        node("leaf2", "frame", "p", "a4", {
          name: "Other",
          isComponent: true,
          width: 100,
          height: 30,
        }),
      );
      const { editor } = open(form, nodes);
      const ni = instanceProperties(editor.doc, "i")?.nested[0]?.instanceId as string;
      const collection = editor.createCollection("Opacity") as string;
      const va = editor.createVariable(collection, "Old", "number", 0.2) as string;
      const vb = editor.createVariable(collection, "New", "number", 0.8) as string;
      editor.bindVariable(["leaf"], "opacity", va);
      editor.bindVariable(["leaf2"], "opacity", vb);
      editor.swapInstance(ni, "leaf2");
      expect(getProp(editor.doc.get(ni)?.props ?? {}, "bindings").opacity).toBe(vb);
      editor.setProp([ni], "opacity", 0.5);
      editor.resetOverride(ni, "opacity");
      expect(getProp(editor.doc.get(ni)?.props ?? {}, "bindings").opacity).toBe(vb);
      expect(getProp(editor.doc.get(ni)?.props ?? {}, "opacity")).toBe(0.8);
      expect(getProp(editor.doc.get(ni)?.props ?? {}, "overrides")).not.toContain("opacity");
    });

    it("the first direct edit records the other values the layers hold from before records", () => {
      const { editor, id, row } = open(form, legacy());
      editor.setProp([id("iv")], "visible", false);
      expect(getProp(editor.doc.get("i")?.props ?? {}, "propValues")).toEqual({
        label: "Before",
        show: false,
      });
      editor.commit([{ op: "delete", id: "ta" }]);
      editor.commit([
        {
          op: "create",
          id: "ta2",
          type: "text",
          parent: "a",
          key: "a0",
          props: { name: "Text", characters: "Base", propRefs: { characters: "label" } },
        },
      ]);
      expect(row("i", "label")?.value).toBe("Before");
      for (const target of row("i", "label")?.targets ?? [])
        expect(getProp(editor.doc.get(target)?.props ?? {}, "characters")).toBe("Before");
    });

    it("typing pins a follower that already holds the value before its main's default changes", () => {
      const nodes = legacy();
      nodes.push(
        node("ta2", "text", "a", "a2", {
          name: "Second",
          characters: "Base",
          propRefs: { characters: "label" },
        }),
        node("it2", "text", "i", "a2", {
          name: "Second",
          mirrors: "ta2",
          characters: "Base",
          propRefs: { characters: "label" },
        }),
      );
      const { editor, row } = open(form, nodes);
      const targets = row("i", "label")?.targets ?? [];
      editor.setProp([targets[0] as string], "characters", "Base");
      expect(getProp(editor.doc.get(targets[1] as string)?.props ?? {}, "overrides")).toContain(
        "characters",
      );
      editor.setProp(["ta2"], "characters", "Changed on main");
      expect(targets.map((t) => getProp(editor.doc.get(t)?.props ?? {}, "characters"))).toEqual([
        "Base",
        "Base",
      ]);
      expect(row("i", "label")?.value).toBe("Base");
    });

    it("typing detaches a variable bound to an equal follower", () => {
      const nodes = legacy();
      nodes.push(
        node("ta2", "text", "a", "a2", {
          name: "Second",
          characters: "Base",
          propRefs: { characters: "label" },
        }),
        node("it2", "text", "i", "a2", {
          name: "Second",
          mirrors: "ta2",
          characters: "Base",
          propRefs: { characters: "label" },
        }),
      );
      const { editor, row } = open(form, nodes);
      const collection = editor.createCollection("Copy") as string;
      const variable = editor.createVariable(collection, "Label", "string", "Base") as string;
      editor.bindVariable(["ta2"], "characters", variable);
      const targets = row("i", "label")?.targets ?? [];
      expect(
        getProp(editor.doc.get(targets[1] as string)?.props ?? {}, "bindings").characters,
      ).toBe(variable);
      editor.setProp([targets[0] as string], "characters", "Base");
      expect(
        getProp(editor.doc.get(targets[1] as string)?.props ?? {}, "bindings").characters,
      ).toBeUndefined();
    });
  });

// ---------------------------------------------------------------------------
// Finding 6 (P2): an import's explicit unlink

for (const form of FORMS)
  describe(`imports keep a layer unlinked from a property (${form})`, () => {
    function imported() {
      const file = JSON.parse(
        readFileSync(
          new URL("../../figma/test/fixtures/component-properties.json", import.meta.url),
          "utf8",
        ),
      ) as Figma.File;
      type Raw = { id: string; children?: Raw[] } & Record<string, unknown>;
      const find = (n: Raw, id: string): Raw | undefined =>
        n.id === id ? n : (n.children ?? []).map((c) => find(c, id)).find(Boolean);
      const root = file.document as unknown as Raw;
      const main = find(root, "1:7") as Raw;
      const copy = find(root, "I6:1;1:7") as Raw;
      (find(root, "1:5") as Raw).children?.push({
        ...structuredClone(main),
        id: "1:77",
        name: "Unlinked in copy",
        characters: "Second default",
      });
      (find(root, "6:1") as Raw).children?.push({
        ...structuredClone(copy),
        id: "I6:1;1:77",
        name: "Unlinked in copy",
        characters: "Keep detached",
        componentPropertyReferences: {},
      });
      return pinInstances(convertFile(file).nodes).nodes;
    }

    it("setting another property leaves the unlinked layer's text", () => {
      const nodes = imported();
      const editor = new Editor({ clientId: "import", measurer });
      editor.state.set({ role: "editor" });
      editor.doc.resetStored([], form);
      editor.doc.reset(structuredClone(nodes));
      editor.setPage("f0-1");
      const target = editor.doc.resetIds.get("fI6-1_1-77") ?? "fI6-1_1-77";
      expect(getProp(editor.doc.get(target)?.props ?? {}, "characters")).toBe("Keep detached");
      // It isn't one of the property's layers.
      const label = instanceProperties(editor.doc, "f6-1")?.rows.find((r) => r.type === "text");
      expect(label?.targets).not.toContain(target);
      editor.setInstanceProperty("f6-1", "10:1", false);
      expect(getProp(editor.doc.get(target)?.props ?? {}, "characters")).toBe("Keep detached");
      // Its main's text changing doesn't reach it either: the difference is its own.
      editor.setProp(["f1-77"], "characters", "Main changed");
      expect(getProp(editor.doc.get(target)?.props ?? {}, "characters")).toBe("Keep detached");
    });

    it("a copy that leaves its references out still takes its main layer's", () => {
      const nodes = imported();
      const copy = nodes.find((n) => n.id === "fI6-1_1-7");
      expect(getProp(copy?.props ?? {}, "propRefs").characters).toBeTruthy();
      const unlinked = nodes.find((n) => n.id === "fI6-1_1-77");
      expect(getProp(unlinked?.props ?? {}, "propRefs")).toEqual({});
      expect(getProp(unlinked?.props ?? {}, "overrides")).toContain("propRefs");
    });
  });

// ---------------------------------------------------------------------------
// Findings 7 (P2) and 8 (P3): size and cost

describe("record bounds", () => {
  /** A main with 22 text properties and a legacy instance holding 200,000 characters in each. */
  function large(): NodeRecord[] {
    const nodes = [
      node("p", "page", ROOT_ID, "a0", {}),
      node("m", "frame", "p", "a0", {
        isComponent: true,
        componentProps: Array.from({ length: 22 }, (_, i) => ({
          id: `p${i}`,
          name: `Property ${i}`,
          type: "text",
        })),
      }),
      node("i", "frame", "p", "a1", { instanceOf: "m" }),
    ];
    for (let i = 0; i < 22; i++) {
      const key = `a${i.toString().padStart(2, "0")}`;
      nodes.push(
        node(`t${i}`, "text", "m", key, {
          characters: "Default",
          propRefs: { characters: `p${i}` },
        }),
        node(`it${i}`, "text", "i", key, {
          mirrors: `t${i}`,
          characters: "x".repeat(200_000),
          propRefs: { characters: `p${i}` },
          overrides: ["characters"],
        }),
      );
    }
    return nodes;
  }

  for (const form of FORMS)
    it(`setting one value of a large legacy instance fits a room message (${form})`, () => {
      const { editor, sent, id } = open(form, large());
      editor.setInstanceProperty("i", "p0", "y");
      const values = getProp(editor.doc.get("i")?.props ?? {}, "propValues");
      expect(PROPS.propValues.schema.safeParse(values).success).toBe(true);
      expect(values.p0).toBe("y");
      // Everything the edit sends goes as one transaction (unsent commits merge).
      const bytes = Buffer.byteLength(JSON.stringify({ t: "txn", seq: 1, ops: sent.flat() }));
      expect(bytes).toBeLessThanOrEqual(MAX_CLIENT_MESSAGE_BYTES);
      // Each value the record holds was written on its own.
      for (const ops of sent)
        for (const op of ops)
          if (op.op === "set" && op.prop === "propValues") expect(op.key).toBeTruthy();
      // Values the record has no room for stay on their layers, and still show.
      const rows = instanceProperties(editor.doc, "i")?.rows ?? [];
      expect(rows.find((r) => r.id === "p21")?.value).toBe("x".repeat(200_000));
      expect(getProp(editor.doc.get(id("it21"))?.props ?? {}, "characters")).toBe(
        "x".repeat(200_000),
      );
    });

  it("a record holding more than its bound is refused", () => {
    const values = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`p${i}`, "x".repeat(MAX_PROPERTY_VALUES_CHARS / 2)]),
    );
    expect(PROPS.propValues.schema.safeParse(values).success).toBe(false);
  });
});

describe("typing cost", () => {
  it("typing in a driven text reads its property's layers, not the instance's copy", () => {
    const nodes = simple();
    for (let i = 0; i < 10_000; i++) {
      const key = `b${i.toString().padStart(5, "0")}`;
      nodes.push(
        node(`r${i}`, "rect", "a", key, {}),
        node(`ir${i}`, "rect", "i", key, { mirrors: `r${i}` }),
      );
    }
    const { editor, id } = open("materialized", nodes);
    // The first keystroke finds the property's layers; the next ones read them.
    editor.setProp([id("it")], "characters", "O");
    let gets = 0;
    const get = editor.doc.get.bind(editor.doc);
    editor.doc.get = (at: string) => {
      gets++;
      return get(at);
    };
    const ops = propertyFollowOps(editor.doc, [
      { op: "set", id: id("it"), prop: "characters", value: "On" },
    ]);
    expect(ops).toEqual([{ op: "set", id: "i", prop: "propValues", key: "label", value: "On" }]);
    expect(gets).toBeLessThan(100);
    // A structural change finds them again.
    editor.doc.get = get;
    const added = editor.commit([
      {
        op: "create",
        id: "ta3",
        type: "text",
        parent: "a",
        key: "a5",
        props: { name: "Third", characters: "Base", propRefs: { characters: "label" } },
      },
    ]);
    expect(added).toBe(true);
    const follow = propertyFollowOps(editor.doc, [
      { op: "set", id: id("it"), prop: "characters", value: "Once" },
    ]);
    // The new layer follows the typing too.
    expect(follow.filter((o) => o.op === "set" && o.prop === "characters").length).toBe(1);
    expect(
      instanceProperties(editor.doc, "i")?.rows.find((r) => r.id === "label")?.targets.length,
    ).toBe(2);
  });
});
