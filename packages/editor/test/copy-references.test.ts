/**
 * Copy references hold (materialized copies): a layer in a copy copies a
 * child of what its parent copies. A rebuild made before a teammate's
 * detach, delivered after it (or the other way round), and an undone detach,
 * used to leave layers copying a main their instance no longer follows, and
 * converting to compact copies then unlinked the nested instance ("no copy
 * of ... under ..."), its component link lost. Found in the reviews of #187
 * (review 5 finding 7, review 6 findings 3 and 4, review 7 B3), all on main.
 *
 * The room fixes them as a change of its own (`referenceFixes`), logged and
 * sent to every client, the author included; clients never fix references
 * themselves (review 8 of #209). So a tab on older code (the editor as it was
 * at af07ef0, `main-era/`), a client catching up from the log and one loading
 * a snapshot all hold what the room holds. Through real sync engines and a
 * room stand-in that orders, logs and fixes as `FileRoom` does.
 */
import {
  applyTransaction,
  type ClientMessage,
  compactByInstance,
  MemoryStore,
  ModelError,
  type NodeRecord,
  type Op,
  ROOT_ID,
  referenceFixes,
  type ServerMessage,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src";
import { Editor as MainEraEditor } from "./main-era/editor-af07ef0.mjs";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown>,
): NodeRecord => ({ id, type, parent, key, props: props as NodeRecord["props"] });
const measurer = { width: (_f: unknown, t: string) => t.length * 7 };
const byId = (a: NodeRecord, b: NodeRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sorted = (nodes: Iterable<NodeRecord>) => [...nodes].sort(byId);

/** The room's own changes, as `FileRoom` sends them. */
const SYSTEM = { userId: "system", sessionId: "system" };

/**
 * A FileRoom stand-in (materialized copies): it applies each transaction
 * whole or refuses it, logs it, acknowledges it and sends it on; then, as
 * `FileRoom.#fixReferences` does, it commits the copy references the
 * transaction left stale as its own change, sent to everyone.
 */
class Room {
  store: MemoryStore;
  revn = 1;
  readonly log: Array<{ revn: number; ops: Op[] }> = [];
  clients: Client[] = [];
  lastSeq = new Map<string, number>();
  readonly rejected: string[] = [];
  constructor(nodes: NodeRecord[]) {
    this.store = new MemoryStore(structuredClone(nodes));
  }
  /** A client on today's editor, or on the editor as it was at af07ef0 (`mainEra`). */
  join(name: string, mainEra = false) {
    const c = new Client(name, mainEra);
    this.clients.push(c);
    c.editor.sync.connected((m) => this.handle(c, m));
    c.deliver();
    return c;
  }
  handle(from: Client, message: ClientMessage) {
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
          copies: "materialized",
        },
        { t: "snapshot", nodes: structuredClone([...this.store.nodes()]), done: true },
      );
      return;
    }
    if (message.t !== "txn") return;
    if ((this.lastSeq.get(from.name) ?? 0) >= message.seq) {
      from.inbox.push({ t: "ack", seq: message.seq, revn: this.revn });
      return;
    }
    const ops = message.ops as Op[];
    try {
      applyTransaction(this.store, ops);
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      this.rejected.push(`${from.name}: ${error.message}`);
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
    this.log.push({ revn: this.revn, ops: structuredClone(ops) });
    this.lastSeq.set(from.name, message.seq);
    from.inbox.push({ t: "ack", seq: message.seq, revn: this.revn });
    for (const other of this.clients)
      if (other !== from)
        other.inbox.push({
          t: "txn",
          revn: this.revn,
          ops: structuredClone(ops),
          author: { userId: "u", sessionId: from.name },
        });
    const fixes = referenceFixes(this.store, ops);
    if (fixes.length === 0) return;
    applyTransaction(this.store, fixes);
    this.revn++;
    this.log.push({ revn: this.revn, ops: structuredClone(fixes) });
    for (const client of this.clients)
      client.inbox.push({ t: "txn", revn: this.revn, ops: structuredClone(fixes), author: SYSTEM });
  }
  /**
   * Sends and delivers everything until nothing moves; then every client holds
   * exactly what the room stores, with nothing pending.
   */
  settle() {
    for (let round = 0; round < 50; round++) {
      for (const c of this.clients) c.editor.sync.flush();
      if (this.clients.every((c) => c.inbox.length === 0)) {
        for (const c of this.clients) {
          expect(c.editor.sync.pendingCount, c.name).toBe(0);
          expect(sorted(c.editor.doc.stored()), c.name).toEqual(sorted(this.store.nodes()));
        }
        return;
      }
      for (const c of this.clients) c.deliver();
    }
    throw new Error("didn't settle");
  }
}
class Client {
  editor: Editor;
  inbox: ServerMessage[] = [];
  constructor(
    readonly name: string,
    mainEra = false,
  ) {
    this.editor = mainEra
      ? (new MainEraEditor({ clientId: name, measurer }) as unknown as Editor)
      : new Editor({ clientId: name, measurer });
  }
  deliver() {
    while (this.inbox.length > 0) this.editor.sync.receive(this.inbox.shift() as ServerMessage);
    if (!this.editor.state.get().pageId) this.editor.setPage("p");
  }
}

const noneDetached = (room: Room) =>
  expect([...compactByInstance([...room.store.nodes()]).detached]).toEqual([]);

/** A main holding a nested icon instance; an instance of it, materialized as the editor makes it. */
function iconKit(): NodeRecord[] {
  const mains = [
    node("p", "page", ROOT_ID, "a0", {}),
    node("iconA", "frame", "p", "a0", { isComponent: true, width: 10, height: 10 }),
    node("iconAr", "rect", "iconA", "a0", { width: 10, height: 10 }),
    node("iconB", "frame", "p", "a1", { isComponent: true, width: 10, height: 10 }),
    node("iconBr", "ellipse", "iconB", "a0", { width: 10, height: 10 }),
    node("vA", "frame", "p", "a2", { isComponent: true, width: 50, height: 20 }),
    node("vAi", "frame", "vA", "a0", { name: "Icon", instanceOf: "iconA", width: 10, height: 10 }),
  ];
  const editor = new Editor({ clientId: "setup", measurer });
  editor.state.set({ role: "editor" });
  editor.doc.resetStored([], "materialized");
  editor.doc.reset(mains);
  editor.setPage("p");
  const made = editor.insertInstance("iconA") as string;
  editor.commit(
    editor.doc
      .childIds(made)
      .map((c, i): Op => ({ op: "move", id: c, parent: "vAi", key: `a${i}` })),
    "s",
    { overrides: false },
  );
  editor.commit([{ op: "delete", id: made }], "s", { overrides: false });
  const i = editor.insertInstance("vA") as string;
  return editor.doc
    .stored()
    .map((n) => (n.id === i ? { ...n, id: "i" } : n.parent === i ? { ...n, parent: "i" } : n));
}

const iconIn = (room: Room) => {
  const doc = (room.clients[0] as Client).editor.doc;
  return doc.childIds("i").find((id) => doc.get(id)?.props.name === "Icon") as string;
};

it("keeps a nested instance linked after a delayed swap and its undo cross a teammate's detach", () => {
  const room = new Room(iconKit());
  expect([...compactByInstance([...room.store.nodes()]).detached]).toEqual([]);
  const a = room.join("a");
  room.join("b");
  const c = room.join("c");
  c.editor.swapInstance(iconIn(room), "iconB");
  a.editor.select(["i"]);
  a.editor.detachInstances();
  c.editor.undo();
  room.settle();
  expect(room.rejected).toEqual([]);
  noneDetached(room);
});

/** Deep: Leaf holds an instance of Deep; main A holds an instance of Leaf; an instance of A. */
function deepKit(): NodeRecord[] {
  return [
    node("p", "page", ROOT_ID, "a0", {}),
    node("deep", "frame", "p", "a0", { isComponent: true, width: 10, height: 10 }),
    node("dt", "text", "deep", "a0", { characters: "Deep" }),
    node("leaf", "frame", "p", "a1", { isComponent: true, width: 10, height: 10 }),
    node("ln", "frame", "leaf", "a0", { instanceOf: "deep", width: 10, height: 10 }),
    node("lnt", "text", "ln", "a0", { mirrors: "dt", characters: "Deep" }),
    node("a", "frame", "p", "a2", { isComponent: true, width: 10, height: 10 }),
    node("na", "frame", "a", "a0", { instanceOf: "leaf", width: 10, height: 10 }),
    node("nan", "frame", "na", "a0", { instanceOf: "deep", mirrors: "ln", width: 10, height: 10 }),
    node("nant", "text", "nan", "a0", { mirrors: "lnt", characters: "Deep" }),
    node("other", "frame", "p", "a3", { isComponent: true, width: 10, height: 10 }),
    node("ot", "ellipse", "other", "a0", { width: 10, height: 10 }),
    node("i", "frame", "p", "a4", { instanceOf: "a", width: 10, height: 10 }),
    node("ni", "frame", "i", "a0", { instanceOf: "leaf", mirrors: "na", width: 10, height: 10 }),
    node("nni", "frame", "ni", "a0", { instanceOf: "deep", mirrors: "nan", width: 10, height: 10 }),
    node("nnit", "text", "nni", "a0", { mirrors: "nant", characters: "Deep" }),
  ];
}

it("keeps every level linked when the swapped copy is itself a nested instance's", () => {
  const room = new Room(deepKit());
  expect([...compactByInstance([...room.store.nodes()]).detached]).toEqual([]);
  const a = room.join("a");
  room.join("b");
  const c = room.join("c");
  c.editor.swapInstance("ni", "other");
  a.editor.select(["i"]);
  a.editor.detachInstances();
  c.editor.undo();
  room.settle();
  expect(room.rejected).toEqual([]);
  noneDetached(room);
});

it("keeps the links after a detach is undone, the outer copy followed again", () => {
  const room = new Room([
    node("p", "page", ROOT_ID, "a0", {}),
    node("leaf", "frame", "p", "a0", { isComponent: true, width: 100, height: 30 }),
    node("t", "text", "leaf", "a0", { characters: "Base" }),
    node("a", "frame", "p", "a1", { isComponent: true, width: 100, height: 30 }),
    node("na", "frame", "a", "a0", { instanceOf: "leaf", width: 100, height: 30 }),
    node("nat", "text", "na", "a0", { mirrors: "t", characters: "Base" }),
    node("i", "frame", "p", "a2", { instanceOf: "a", width: 100, height: 30 }),
    node("ni", "frame", "i", "a0", { mirrors: "na", instanceOf: "leaf", width: 100, height: 30 }),
    node("nit", "text", "ni", "a0", { mirrors: "nat", characters: "Base" }),
    node("other", "frame", "p", "a4", { isComponent: true, width: 10, height: 10 }),
    node("ot", "ellipse", "other", "a0", { width: 10, height: 10 }),
  ]);
  const a = room.join("a");
  const c = room.join("c");
  c.editor.swapInstance("ni", "other");
  room.settle();
  a.editor.select(["i"]);
  a.editor.detachInstances();
  room.settle();
  c.editor.undo();
  room.settle();
  const mid = [...compactByInstance([...room.store.nodes()]).detached];
  a.editor.undo();
  room.settle();
  expect(mid).toEqual([]);
  expect(room.rejected).toEqual([]);
  noneDetached(room);
});

it("keeps the nested instance linked when its old main was deleted before the stale swap's undo", () => {
  const room = new Room(deepKit());
  const a = room.join("a");
  const c = room.join("c");
  c.editor.swapInstance("ni", "other");
  a.editor.select(["i"]);
  a.editor.detachInstances();
  a.editor.commit([{ op: "delete", id: "a" }]);
  a.editor.sync.flush();
  a.deliver();
  room.settle();
  c.editor.undo();
  room.settle();
  expect(room.rejected).toEqual([]);
  noneDetached(room);
});

describe("a tab on older code, and replay of the log (review 8 of #209, B3)", () => {
  it("leaves a tab on the editor from before holding what the room holds after the room's fix", () => {
    const room = new Room(iconKit());
    const a = room.join("a");
    const old = room.join("old", true);
    old.editor.swapInstance(iconIn(room), "iconB");
    a.editor.select(["i"]);
    a.editor.detachInstances();
    old.editor.undo();
    // Every client equals the room (checked as it settles), the old tab included.
    room.settle();
    expect(room.rejected).toEqual([]);
    noneDetached(room);
    // The fix is in the log, as the room's own change.
    expect(
      room.log.some((entry) => entry.ops.every((op) => op.op === "set" && op.prop === "mirrors")),
    ).toBe(true);
  });

  it("gives a client catching up from the log what a client loading the snapshot gets", () => {
    const room = new Room(iconKit());
    const a = room.join("a");
    const c = room.join("c");
    const start = room.revn;
    const before = structuredClone([...room.store.nodes()]);
    c.editor.swapInstance(iconIn(room), "iconB");
    a.editor.select(["i"]);
    a.editor.detachInstances();
    c.editor.undo();
    room.settle();
    const load = (name: string, nodes: NodeRecord[], revn: number) => {
      const editor = new Editor({ clientId: name, measurer });
      editor.sync.connected(() => {});
      editor.sync.receive({
        t: "welcome",
        sessionId: name,
        revn,
        role: "editor",
        peers: [],
        mode: "snapshot",
        lastSeq: 0,
        copies: "materialized",
      });
      editor.sync.receive({ t: "snapshot", nodes: structuredClone(nodes), done: true });
      return editor;
    };
    const fresh = load("fresh", [...room.store.nodes()], room.revn);
    const cached = load("cached", before, start);
    for (const entry of room.log.filter((e) => e.revn > start))
      cached.sync.receive({
        t: "txn",
        revn: entry.revn,
        ops: structuredClone(entry.ops),
        author: SYSTEM,
      });
    expect(cached.sync.pendingCount).toBe(0);
    expect(sorted(cached.doc.stored())).toEqual(sorted(fresh.doc.stored()));
  });

  it("replays a transaction logged before this change as it was, for every client alike", () => {
    // A delayed rebuild a server from before stored and logged unfixed: a client loading the
    // snapshot and one catching up from the log hold the same file (neither fixes it itself).
    const base = [
      node("p", "page", ROOT_ID, "a0", {}),
      node("leaf", "frame", "p", "a0", { isComponent: true }),
      node("t", "text", "leaf", "a0", { characters: "Base" }),
      node("a", "frame", "p", "a1", { isComponent: true }),
      node("na", "frame", "a", "a0", { instanceOf: "leaf" }),
      node("nat", "text", "na", "a0", { mirrors: "t", characters: "Base" }),
      node("i", "frame", "p", "a2", {}),
      node("other", "frame", "p", "a3", { isComponent: true }),
      node("ot", "ellipse", "other", "a0", {}),
      node("ni", "frame", "i", "a0", { instanceOf: "other" }),
      node("tmp", "ellipse", "ni", "a0", { mirrors: "ot" }),
    ];
    const accepted: Op[] = [
      { op: "set", id: "ni", prop: "instanceOf", value: "leaf" },
      { op: "delete", id: "tmp" },
      {
        op: "create",
        id: "nit",
        type: "text",
        parent: "ni",
        key: "a0",
        props: { mirrors: "nat", characters: "Accepted" },
      },
    ];
    const oldServer = new MainEraEditor({ clientId: "server", measurer }) as unknown as Editor;
    oldServer.doc.resetStored(structuredClone(base), "materialized");
    oldServer.doc.applyStored(accepted);
    const snapshot = [...oldServer.doc.stored()];
    const load = (name: string, nodes: NodeRecord[], revn: number) => {
      const editor = new Editor({ clientId: name, measurer });
      editor.sync.connected(() => {});
      editor.sync.receive({
        t: "welcome",
        sessionId: name,
        revn,
        role: "editor",
        peers: [],
        mode: "snapshot",
        lastSeq: 0,
        copies: "materialized",
      });
      editor.sync.receive({ t: "snapshot", nodes: structuredClone(nodes), done: true });
      return editor;
    };
    const fresh = load("fresh", snapshot, 2);
    const cached = load("cached", base, 1);
    cached.sync.receive({
      t: "txn",
      revn: 2,
      ops: accepted,
      author: { userId: "u", sessionId: "server" },
    });
    expect(fresh.sync.pendingCount).toBe(0);
    expect(cached.sync.pendingCount).toBe(0);
    expect(sorted(cached.doc.stored())).toEqual(sorted(fresh.doc.stored()));
  });
});

describe("conversion keeps what it can (#209)", () => {
  it("converts a layer whose reference is gone as the copy at its place, its own value kept", () => {
    const nodes = [
      node("p", "page", ROOT_ID, "a0", {}),
      node("leaf", "frame", "p", "a0", { isComponent: true, width: 10, height: 10 }),
      node("t", "text", "leaf", "a0", { characters: "Base" }),
      node("i", "frame", "p", "a1", { instanceOf: "leaf", width: 10, height: 10 }),
      // Copies a layer deleted since (a main gone with it), and was changed by hand.
      node("it", "text", "i", "a0", {
        mirrors: "gone",
        characters: "Mine",
        overrides: ["characters"],
      }),
    ];
    const converted = compactByInstance(nodes);
    expect([...converted.detached]).toEqual([]);
    const record = converted.nodes.find((n) => n.type === "override");
    expect(record?.props.characters).toBe("Mine");
  });

  it("still says why it can't convert a layer nothing in its main is at the place of", () => {
    const nodes = [
      node("p", "page", ROOT_ID, "a0", {}),
      node("leaf", "frame", "p", "a0", { isComponent: true, width: 10, height: 10 }),
      node("t", "text", "leaf", "a0", { characters: "Base" }),
      node("i", "frame", "p", "a1", { instanceOf: "leaf", width: 10, height: 10 }),
      node("it", "text", "i", "a0", { mirrors: "t", characters: "Base" }),
      node("extra", "rect", "i", "a1", { mirrors: "gone", width: 1, height: 1 }),
    ];
    expect([...compactByInstance(nodes).detached.values()]).toEqual([
      "2 layers under i, 1 in its main",
    ]);
  });
});
