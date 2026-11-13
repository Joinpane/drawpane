import {
  applyTransaction,
  type ClientMessage,
  keyBetween,
  MemoryStore,
  ModelError,
  type NodeRecord,
  type Op,
  ROOT_ID,
  type ServerMessage,
} from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { compactOps, SyncEngine } from "../src/sync";

/** A FileRoom stand-in with the same ordering, dedupe and catch-up rules. */
class FakeRoom {
  readonly store = new MemoryStore();
  revn = 0;
  readonly log: Array<{ revn: number; ops: Op[] }> = [];
  readonly lastSeq = new Map<string, { seq: number; revn: number }>();
  readonly sockets = new Set<FakeSocket>();

  constructor(seed: Op[]) {
    applyTransaction(this.store, seed);
    this.revn = 1;
    this.log.push({ revn: 1, ops: seed });
  }

  handle(socket: FakeSocket, message: ClientMessage): void {
    if (message.t === "hello") {
      socket.clientId = message.clientId;
      const catchup = message.revn !== null && message.revn <= this.revn;
      socket.deliver({
        t: "welcome",
        sessionId: socket.clientId,
        revn: this.revn,
        role: "editor",
        peers: [],
        mode: catchup ? "catchup" : "snapshot",
        lastSeq: this.lastSeq.get(message.clientId)?.seq ?? 0,
      });
      if (catchup) {
        for (const entry of this.log) {
          if (entry.revn > (message.revn ?? 0)) {
            socket.deliver({
              t: "txn",
              revn: entry.revn,
              ops: entry.ops,
              author: { userId: "u", sessionId: "s" },
            });
          }
        }
      } else {
        socket.deliver({ t: "snapshot", nodes: [...this.store.nodes()], done: false });
        socket.deliver({ t: "snapshot", nodes: [], done: true });
      }
      return;
    }
    if (message.t !== "txn" || !socket.clientId) return;
    const known = this.lastSeq.get(socket.clientId);
    if (known && message.seq <= known.seq) {
      socket.deliver({ t: "ack", seq: message.seq, revn: known.revn });
      return;
    }
    try {
      applyTransaction(this.store, message.ops as Op[]);
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      socket.deliver({
        t: "reject",
        seq: message.seq,
        code: error.code,
        message: error.message,
        fix: {},
      });
      return;
    }
    this.revn++;
    this.log.push({ revn: this.revn, ops: message.ops as Op[] });
    this.lastSeq.set(socket.clientId, { seq: message.seq, revn: this.revn });
    socket.deliver({ t: "ack", seq: message.seq, revn: this.revn });
    for (const other of this.sockets) {
      if (other !== socket && other.clientId) {
        other.deliver({
          t: "txn",
          revn: this.revn,
          ops: message.ops as Op[],
          author: { userId: "u", sessionId: "s" },
        });
      }
    }
  }
}

/** One connection with independent queues in each direction, delivered on demand. */
class FakeSocket {
  clientId: string | null = null;
  readonly up: ClientMessage[] = [];
  readonly down: ServerMessage[] = [];
  open = true;
  constructor(readonly room: FakeRoom) {
    room.sockets.add(this);
  }
  deliver(message: ServerMessage): void {
    if (this.open) this.down.push(message);
  }
  close(): void {
    this.open = false;
    this.room.sockets.delete(this);
  }
}

class Client {
  readonly doc = new Doc();
  readonly engine: SyncEngine;
  socket: FakeSocket | null = null;
  constructor(
    readonly room: FakeRoom,
    readonly id: string,
  ) {
    // Timers never fire on their own: the test flushes explicitly.
    this.engine = new SyncEngine(this.doc, { clientId: id, setTimer: () => 0 });
  }
  connect(): void {
    const socket = new FakeSocket(this.room);
    this.socket = socket;
    this.engine.connected((m) => {
      if (socket.open) socket.up.push(JSON.parse(JSON.stringify(m)) as ClientMessage);
    });
  }
  disconnect(): void {
    this.socket?.close();
    this.socket = null;
    this.engine.disconnected();
  }
  /** Delivers one queued message in each direction; returns whether anything moved. */
  pump(direction: "up" | "down"): boolean {
    const socket = this.socket;
    if (!socket) return false;
    if (direction === "up") {
      const message = socket.up.shift();
      if (!message) return false;
      this.room.handle(socket, message);
    } else {
      const message = socket.down.shift();
      if (!message) return false;
      this.engine.receive(JSON.parse(JSON.stringify(message)) as ServerMessage);
    }
    return true;
  }
}

const PAGE = "page1";
const seed: Op[] = [
  { op: "create", id: PAGE, type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page 1" } },
];

function snapshot(nodes: Iterable<NodeRecord>) {
  return [...nodes].map((n) => JSON.stringify(n)).sort();
}

type Action =
  | { kind: "edit"; client: number; choice: number; value: number }
  | { kind: "flush"; client: number }
  | { kind: "pump"; client: number; direction: "up" | "down" }
  | { kind: "reconnect"; client: number };

/** Builds a plausible edit from the client's current view of the document. */
function makeEdit(doc: Doc, choice: number, value: number, counter: { n: number }): Op[] | null {
  const layers = [...doc.nodes()].filter((n) => n.type !== "page");
  const containers = [...doc.nodes()].filter((n) => n.type === "page" || n.type === "frame");
  const pick = <T>(list: T[]): T | undefined => list[value % Math.max(1, list.length)];
  switch (choice % 5) {
    case 0:
    case 1: {
      const parent = pick(containers);
      if (!parent) return null;
      const siblings = doc.childIds(parent.id);
      const last = siblings.at(-1);
      const key = keyBetween(last ? (doc.get(last)?.key ?? null) : null, null);
      const id = `n${counter.n++}${value}`;
      return [
        {
          op: "create",
          id,
          type: choice % 2 ? "frame" : "rect",
          parent: parent.id,
          key,
          props: { x: value, y: 0, width: 10, height: 10 },
        },
      ];
    }
    case 2: {
      const node = pick(layers);
      return node ? [{ op: "set", id: node.id, prop: "x", value }] : null;
    }
    case 3: {
      const node = pick(layers);
      const parent = pick(containers.slice().reverse());
      return node && parent
        ? [{ op: "move", id: node.id, parent: parent.id, key: keyBetween(null, null) }]
        : null;
    }
    default: {
      const node = pick(layers);
      return node ? [{ op: "delete", id: node.id }] : null;
    }
  }
}

describe("SyncEngine convergence", () => {
  it("every client ends equal to the room, whatever the interleaving", () => {
    const action: fc.Arbitrary<Action> = fc.oneof(
      {
        weight: 4,
        arbitrary: fc.record({
          kind: fc.constant("edit" as const),
          client: fc.nat(2),
          choice: fc.nat(),
          value: fc.nat(1000),
        }),
      },
      {
        weight: 2,
        arbitrary: fc.record({ kind: fc.constant("flush" as const), client: fc.nat(2) }),
      },
      {
        weight: 6,
        arbitrary: fc.record({
          kind: fc.constant("pump" as const),
          client: fc.nat(2),
          direction: fc.constantFrom("up" as const, "down" as const),
        }),
      },
      {
        weight: 1,
        arbitrary: fc.record({ kind: fc.constant("reconnect" as const), client: fc.nat(2) }),
      },
    );

    fc.assert(
      fc.property(fc.array(action, { minLength: 60, maxLength: 240, size: "max" }), (actions) => {
        const room = new FakeRoom(seed);
        const clients = [0, 1, 2].map((i) => new Client(room, `client${i}`));
        for (const client of clients) {
          client.connect();
          while (client.pump("up") || client.pump("down")) {}
        }
        const counter = { n: 0 };
        for (const a of actions) {
          const client = clients[a.client] as Client;
          switch (a.kind) {
            case "edit": {
              const ops = makeEdit(client.doc, a.choice, a.value, counter);
              if (ops) {
                try {
                  client.engine.commit(ops);
                } catch (error) {
                  if (!(error instanceof ModelError)) throw error;
                }
              }
              break;
            }
            case "flush":
              client.engine.flush();
              break;
            case "pump":
              client.pump(a.direction);
              break;
            case "reconnect":
              client.disconnect();
              client.connect();
              break;
          }
        }
        // Quiesce: flush and deliver until nothing moves.
        for (let round = 0; round < 50; round++) {
          let moved = false;
          for (const client of clients) {
            client.engine.flush();
            while (client.pump("up")) moved = true;
          }
          for (const client of clients) while (client.pump("down")) moved = true;
          if (!moved) break;
        }
        const expected = snapshot(room.store.nodes());
        for (const client of clients) {
          expect(client.engine.pendingCount).toBe(0);
          expect(snapshot(client.doc.nodes())).toEqual(expected);
          expect(client.engine.revn).toBe(room.revn);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("keeps a local edit visible while a conflicting remote edit arrives", () => {
    const room = new FakeRoom(seed);
    const a = new Client(room, "a");
    const b = new Client(room, "b");
    for (const c of [a, b]) {
      c.connect();
      while (c.pump("up") || c.pump("down")) {}
    }
    a.engine.commit([{ op: "create", id: "r", type: "rect", parent: PAGE, key: "a1", props: {} }]);
    a.engine.flush();
    a.pump("up");
    a.pump("down");
    b.pump("down");

    b.engine.commit([{ op: "set", id: "r", prop: "x", value: 5 }]);
    b.engine.flush();
    a.engine.commit([{ op: "set", id: "r", prop: "x", value: 9 }]);
    b.pump("up"); // Room applies b's x=5 first.
    a.pump("down"); // a receives x=5 while its own x=9 is pending...
    expect(a.doc.get("r")?.props.x).toBe(9); // ...and still shows 9.
    a.engine.flush();
    a.pump("up");
    b.pump("down");
    b.pump("down");
    expect(b.doc.get("r")?.props.x).toBe(9);
  });
});

describe("compactOps", () => {
  it("keeps only the last set of a property, but never across a structural op", () => {
    const ops: Op[] = [
      { op: "set", id: "a", prop: "x", value: 1 },
      { op: "set", id: "b", prop: "x", value: 1 },
      { op: "set", id: "a", prop: "x", value: 2 },
      { op: "move", id: "b", parent: "p", key: "a0" },
      { op: "set", id: "b", prop: "x", value: 3 },
    ];
    expect(compactOps(ops)).toEqual([ops[1], ops[2], ops[3], ops[4]]);
  });
});

describe("SyncEngine room requests", () => {
  function live() {
    const doc = new Doc();
    const engine = new SyncEngine(doc, { clientId: "c1", setTimer: () => 0 });
    const sent: ClientMessage[] = [];
    engine.connected((m) => sent.push(m));
    engine.receive({
      t: "welcome",
      sessionId: "s1",
      revn: 1,
      role: "editor",
      peers: [],
      mode: "snapshot",
      lastSeq: 0,
    });
    engine.receive({ t: "snapshot", nodes: [], done: true });
    return { doc, engine, sent };
  }

  it("reloads quietly when the room asks, keeping pending edits", () => {
    const { engine, sent } = live();
    const desyncs: string[] = [];
    engine.on("desync", (reason) => desyncs.push(reason));
    engine.commit(seed);
    sent.length = 0;
    engine.receive({ t: "resync" });
    expect(engine.status).toBe("syncing");
    expect(sent).toEqual([{ t: "hello", protocol: 1, clientId: "c1", revn: null }]);
    expect(engine.pendingCount).toBe(1);
    expect(desyncs).toEqual([]);
  });

  it("tells listeners who restored which version", () => {
    const { engine } = live();
    const heard: unknown[] = [];
    engine.on("restored", (by, version) => heard.push({ by, version }));
    const message: ServerMessage = {
      t: "restored",
      by: { userId: "u1", name: "Ana" },
      version: { id: "v1", name: "Kickoff", at: 5 },
    };
    engine.receive(message);
    expect(heard).toEqual([
      { by: { userId: "u1", name: "Ana" }, version: { id: "v1", name: "Kickoff", at: 5 } },
    ]);
  });
});
