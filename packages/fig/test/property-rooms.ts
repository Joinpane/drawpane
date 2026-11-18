/**
 * What the component property tests share (decision 0035): small files with
 * properties, a room stand-in that orders real sync engines' transactions
 * as `FileRoom` does, and the checks that every client and the room agree.
 *
 * The room applies each transaction to its own store as stored, all or
 * nothing, acknowledges or rejects it, and broadcasts it to the others,
 * which replay it through their `SyncEngine` (rebasing what they haven't
 * sent). Delivery is explicit, so a test (or a generated schedule) decides
 * what each client has seen when it edits.
 *
 * A client may be a tab from before component property records (protocol
 * 2): the room sends it nothing it can't read and takes its edits as they
 * mean, with the model's own translation (`fromProtocol2`), as `FileRoom`
 * does. Its editor is today's, fed only what such a tab is: it sees no
 * references, records or definitions, so it edits the layers a property
 * drives as plain layers, as the old code did.
 */
import { Doc, Editor, instanceProperties, instanceValues } from "@drawpane/editor";
import {
  applyTransaction,
  type ClientMessage,
  type CopiesFormat,
  CopyView,
  compactByInstance,
  copyDriven,
  forProtocol2Nodes,
  forProtocol2Ops,
  fromProtocol2,
  getProp,
  MemoryStore,
  ModelError,
  type NodeRecord,
  type Op,
  ROOT_ID,
  type ServerMessage,
} from "@drawpane/model";
import { expect } from "vitest";

export const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown>,
): NodeRecord => ({ id, type, parent, key, props: props as NodeRecord["props"] });

export const FORMS: readonly CopiesFormat[] = ["materialized", "compact"];
export const measurer = { width: (_font: unknown, text: string) => text.length * 7 };

/** A set with a text property (Label) and a boolean (Show), and an instance that set both. */
export function simple(): NodeRecord[] {
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
    }),
    node("iv", "rect", "i", "a1", {
      mirrors: "va",
      name: "Icon",
      width: 10,
      height: 10,
      propRefs: { visible: "show" },
    }),
  ];
}

/**
 * `simple`'s instance from before records: its values only on its layers,
 * marked as overrides, as imports and phase 1 wrote them.
 */
export const legacy = (): NodeRecord[] =>
  simple().map((n) => {
    if (n.id === "i") {
      const { propValues: _, ...props } = n.props;
      return { ...n, props };
    }
    if (n.id === "it") return { ...n, props: { ...n.props, overrides: ["characters"] } };
    if (n.id === "iv") return { ...n, props: { ...n.props, overrides: ["visible"] } };
    return n;
  });

/** Variants A and B, each with a nested instance of Leaf (a text property) named Nested. */
export function nested(): NodeRecord[] {
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

/** `nested`, Leaf with a boolean (Show) driving an icon too. */
export function nestedWithShow(): NodeRecord[] {
  const nodes = nested().map((n) =>
    n.id === "leaf"
      ? {
          ...n,
          props: {
            ...n.props,
            componentProps: [
              { id: "label", name: "Label", type: "text" },
              { id: "show", name: "Show", type: "boolean" },
            ],
          } as NodeRecord["props"],
        }
      : n,
  );
  nodes.push(
    node("v", "rect", "leaf", "a1", { width: 10, height: 10, propRefs: { visible: "show" } }),
    node("nav", "rect", "na", "a1", {
      mirrors: "v",
      width: 10,
      height: 10,
      propRefs: { visible: "show" },
    }),
    node("nbv", "rect", "nb", "a1", {
      mirrors: "v",
      width: 10,
      height: 10,
      propRefs: { visible: "show" },
    }),
    node("niv", "rect", "ni", "a1", {
      mirrors: "nav",
      width: 10,
      height: 10,
      propRefs: { visible: "show" },
    }),
  );
  return nodes;
}

// ---------------------------------------------------------------------------
// A room and its clients

/** A FileRoom stand-in: it orders transactions, acknowledges them, and passes them on when asked. */
export class Room {
  readonly store: MemoryStore;
  revn = 1;
  readonly clients: Client[] = [];
  /** Old ids to the stored form's (compact copies rename copy layers). */
  readonly ids: ReadonlyMap<string, string>;
  readonly lastSeq = new Map<string, number>();
  /** Every transaction the room refused, with what it said. */
  readonly rejected: Array<{ client: string; code: string; message: string }> = [];

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

  join(name: string, protocol: 2 | 3 = 3): Client {
    const client = new Client(this, name, protocol);
    this.clients.push(client);
    this.connect(client);
    return client;
  }

  /** (Re)connects a client: its hello, the room's welcome and snapshot, delivered. */
  connect(client: Client): void {
    client.online = true;
    client.editor.sync.connected((message) => {
      if (client.online) this.handle(client, message);
    });
    client.deliver();
  }

  /** Drops a client's socket: what it sends is lost, what it's sent too, until it connects again. */
  disconnect(client: Client): void {
    client.online = false;
    client.inbox.length = 0;
    client.editor.sync.disconnected();
  }

  handle(from: Client, message: ClientMessage): void {
    if (message.t === "hello") {
      from.inbox.push(
        {
          t: "welcome",
          sessionId: from.name,
          revn: this.revn,
          role: from.role,
          peers: [],
          mode: "snapshot",
          lastSeq: this.lastSeq.get(from.name) ?? 0,
          copies: this.copies,
        },
        { t: "snapshot", nodes: from.read(structuredClone([...this.store.nodes()])), done: false },
        { t: "snapshot", nodes: [], done: true },
      );
      return;
    }
    if (message.t !== "txn") return;
    // Resent after a reconnect, already applied: acknowledged again, not applied twice.
    if ((this.lastSeq.get(from.name) ?? 0) >= message.seq) {
      from.inbox.push({ t: "ack", seq: message.seq, revn: this.revn });
      return;
    }
    // A tab from before records: its edits as they mean (`FileRoom` does the same).
    const ops =
      from.protocol === 2 ? this.fromProtocol2(message.ops as Op[]) : (message.ops as Op[]);
    try {
      applyTransaction(this.store, ops);
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      this.rejected.push({ client: from.name, code: error.code, message: error.message });
      // What the room has of the nodes the transaction named, as `FileRoom` sends it.
      const fix: Record<string, NodeRecord | null> = {};
      for (const op of message.ops as Op[]) {
        if (fix[op.id] === undefined) fix[op.id] = structuredClone(this.store.get(op.id) ?? null);
        if ((op.op === "create" || op.op === "move") && op.parent !== ROOT_ID)
          fix[op.parent] ??= structuredClone(this.store.get(op.parent) ?? null);
      }
      if (from.protocol === 2)
        for (const [id, n] of Object.entries(fix)) if (n) fix[id] = from.read([n])[0] as NodeRecord;
      from.inbox.push({
        t: "reject",
        seq: message.seq,
        code: error.code,
        message: error.message,
        fix,
      });
      return;
    }
    this.revn++;
    this.lastSeq.set(from.name, message.seq);
    from.inbox.push({ t: "ack", seq: message.seq, revn: this.revn });
    this.broadcast(ops, from);
  }

  /** A protocol 2 tab's operations as they apply now, read before any applies. */
  fromProtocol2(ops: readonly Op[]): Op[] {
    const view = new CopyView(this.store);
    return fromProtocol2(
      {
        get: (id) => this.store.get(id),
        driven: (id, root) => copyDriven(view, root, id),
      },
      this.copies,
      ops,
    );
  }

  /** A transaction the room makes itself (a branch merge), passed to every client. */
  commit(ops: readonly Op[]): void {
    applyTransaction(this.store, [...ops]);
    this.revn++;
    this.broadcast(ops, null);
  }

  broadcast(ops: readonly Op[], from: Client | null): void {
    for (const other of this.clients)
      if (other !== from && other.online)
        other.inbox.push({
          t: "txn",
          revn: this.revn,
          ops: structuredClone(other.protocol === 2 ? forProtocol2Ops(ops) : [...ops]),
          author: { userId: "u", sessionId: from?.name ?? "room" },
        });
  }

  /** Connects everyone, sends what every client has and delivers everything, until nothing moves. */
  settle(): void {
    for (const client of this.clients) if (!client.online) this.connect(client);
    for (let round = 0; round < 50; round++) {
      for (const client of this.clients) client.editor.sync.flush();
      if (this.clients.every((c) => c.inbox.length === 0)) return;
      for (const client of this.clients) client.deliver();
    }
    throw new Error("the room didn't settle");
  }
}

export class Client {
  readonly editor: Editor;
  readonly inbox: ServerMessage[] = [];
  online = false;
  role: "owner" | "editor" | "viewer" = "editor";

  constructor(
    readonly room: Room,
    readonly name: string,
    /** 2: a tab from before component property records (see the top). */
    readonly protocol: 2 | 3 = 3,
  ) {
    this.editor = new Editor({ clientId: name, measurer });
  }

  /** Nodes as this client is sent them. */
  read(nodes: NodeRecord[]): NodeRecord[] {
    return this.protocol === 2 ? forProtocol2Nodes(nodes) : nodes;
  }

  deliver(): void {
    while (this.inbox.length > 0) this.editor.sync.receive(this.inbox.shift() as ServerMessage);
    if (!this.editor.state.get().pageId) this.editor.setPage("p");
  }

  /** Delivers only the next message waiting, if any. */
  deliverOne(): void {
    const message = this.inbox.shift();
    if (message) this.editor.sync.receive(message);
    if (!this.editor.state.get().pageId) this.editor.setPage("p");
  }

  row(instance: string, property: string) {
    return instanceProperties(this.editor.doc, instance)?.rows.find((r) => r.id === property);
  }

  /** The values an instance keeps (its own, from the record they're in). */
  record(instance: string) {
    return instanceValues(this.editor.doc, instance);
  }

  field(id: string, field: "characters" | "visible") {
    return getProp(this.editor.doc.get(id)?.props ?? {}, field);
  }
}

const byId = (a: NodeRecord, b: NodeRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Every client holds exactly what the room stores (nothing pending anywhere).
 * A protocol 2 tab only has nothing pending: it may show a property's old
 * value until it reloads.
 */
export function expectConverged(room: Room): void {
  const stored = [...room.store.nodes()].sort(byId);
  for (const client of room.clients) {
    if (client.protocol === 2) {
      expect(client.editor.sync.pendingCount).toBe(0);
      continue;
    }
    expect(client.editor.sync.pendingCount).toBe(0);
    expect(client.editor.doc.stored().sort(byId)).toEqual(stored);
  }
}

/**
 * Every layer a property drives in `instance` (and in its nested
 * instances, `nestedToo`) shows the instance's value: the record's, or its
 * main layer's when the record keeps none. In `doc`.
 */
export function expectShowsRecord(doc: Doc, instance: string): void {
  const props = instanceProperties(doc, instance);
  const walk = (p: NonNullable<typeof props>) => {
    const values = instanceValues(doc, p.instanceId);
    for (const row of p.rows) {
      if (row.type !== "text" && row.type !== "boolean" && row.type !== "instance") continue;
      const field =
        row.type === "text" ? "characters" : row.type === "boolean" ? "visible" : "instanceOf";
      const recorded = values[row.id];
      for (const target of row.targets) {
        const shown = getProp(doc.get(target)?.props ?? {}, field);
        if (recorded !== undefined)
          expect(shown).toEqual(typeof recorded === "object" ? recorded.instance : recorded);
        else {
          // Its main layer's.
          const source = getProp(doc.get(target)?.props ?? {}, "mirrors");
          expect(shown).toEqual(getProp(doc.get(source as string)?.props ?? {}, field));
        }
      }
    }
    for (const n of p.nested) walk(n);
  };
  if (props) walk(props);
}

/**
 * The room and every client agree, and every client shows each property's
 * value on every layer it drives, as does the room's stored file opened.
 */
export function expectAgreement(room: Room, instance: string): void {
  expectConverged(room);
  for (const client of room.clients)
    if (client.protocol !== 2) expectShowsRecord(client.editor.doc, instance);
  const opened = new Doc({ compactCopies: room.copies === "compact" });
  opened.resetStored(structuredClone([...room.store.nodes()]), room.copies);
  expectShowsRecord(opened, instance);
}

/** A standalone editor on `nodes`, its stored operations kept. */
export function open(form: CopiesFormat, nodes: readonly NodeRecord[]) {
  const editor = new Editor({ clientId: "review", measurer });
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
