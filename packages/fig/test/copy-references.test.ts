/**
 * Copy references hold (materialized copies): a layer in a copy copies a
 * child of what its parent copies. A rebuild made before a teammate's
 * detach, delivered after it (or the other way round), and an undone detach,
 * used to leave layers copying a main their instance no longer follows, and
 * converting to compact copies then unlinked the nested instance ("no copy
 * of ... under ..."), its component link lost. Found in the reviews of #187
 * (review 5 finding 7, review 6 findings 3 and 4, review 7 B3), all on main.
 * Through real sync engines and a room stand-in ordering their transactions.
 */
import { Editor } from "@drawpane/editor";
import {
  applyTransaction,
  type ClientMessage,
  compactByInstance,
  MemoryStore,
  ModelError,
  type NodeRecord,
  type Op,
  ROOT_ID,
  type ServerMessage,
} from "@drawpane/model";
import { expect, it } from "vitest";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown>,
): NodeRecord => ({ id, type, parent, key, props: props as NodeRecord["props"] });
const measurer = { width: (_f: unknown, t: string) => t.length * 7 };

class Room {
  store: MemoryStore;
  revn = 1;
  clients: Client[] = [];
  lastSeq = new Map<string, number>();
  readonly rejected: string[] = [];
  constructor(nodes: NodeRecord[]) {
    this.store = new MemoryStore(structuredClone(nodes));
  }
  join(name: string) {
    const c = new Client(name);
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
    try {
      applyTransaction(this.store, message.ops as Op[]);
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
    this.lastSeq.set(from.name, message.seq);
    from.inbox.push({ t: "ack", seq: message.seq, revn: this.revn });
    for (const other of this.clients)
      if (other !== from)
        other.inbox.push({
          t: "txn",
          revn: this.revn,
          ops: structuredClone(message.ops as Op[]),
          author: { userId: "u", sessionId: from.name },
        });
  }
  settle() {
    for (let round = 0; round < 50; round++) {
      for (const c of this.clients) c.editor.sync.flush();
      if (this.clients.every((c) => c.inbox.length === 0)) return;
      for (const c of this.clients) c.deliver();
    }
    throw new Error("didn't settle");
  }
}
class Client {
  editor: Editor;
  inbox: ServerMessage[] = [];
  constructor(readonly name: string) {
    this.editor = new Editor({ clientId: name, measurer });
  }
  deliver() {
    while (this.inbox.length > 0) this.editor.sync.receive(this.inbox.shift() as ServerMessage);
    if (!this.editor.state.get().pageId) this.editor.setPage("p");
  }
}

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
  expect([...compactByInstance([...room.store.nodes()]).detached]).toEqual([]);
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
  expect([...compactByInstance([...room.store.nodes()]).detached]).toEqual([]);
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
  expect([...compactByInstance([...room.store.nodes()]).detached]).toEqual([]);
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
  expect([...compactByInstance([...room.store.nodes()]).detached]).toEqual([]);
});

it("repairs a two-level rebuild parents first, each layer copying its parent's main layer", () => {
  const store = new MemoryStore([
    ...deepKit().filter((n) => !["i", "ni", "nni", "nnit"].includes(n.id)),
    // Detached already: ni follows Leaf itself.
    node("i", "frame", "p", "a4", {}),
    node("ni", "frame", "i", "a0", { instanceOf: "leaf" }),
  ]);
  applyTransaction(store, [
    {
      op: "create",
      id: "nni",
      type: "frame",
      parent: "ni",
      key: "a0",
      props: { instanceOf: "deep", mirrors: "nan" },
    },
    {
      op: "create",
      id: "nnit",
      type: "text",
      parent: "nni",
      key: "a0",
      props: { mirrors: "nant", characters: "Deep" },
    },
  ]);
  expect(store.get("nni")?.props.mirrors).toBe("ln");
  expect(store.get("nnit")?.props.mirrors).toBe("lnt");
  expect(compactByInstance([...store.nodes()]).detached.size).toBe(0);
});

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
