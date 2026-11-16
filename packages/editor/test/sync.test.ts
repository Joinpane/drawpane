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

/** A client further behind than this loads the file again (the room's MAX_CATCHUP_BYTES). */
const MAX_BEHIND = 3;
/** Files of more nodes than this are downloaded by clients that can (INLINE_SNAPSHOT_NODES). */
const INLINE_NODES = 3;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A FileRoom stand-in with the same ordering, dedupe, catch-up and download rules. */
class FakeRoom {
  readonly store = new MemoryStore();
  revn = 0;
  readonly log: Array<{ revn: number; ops: Op[] }> = [];
  readonly lastSeq = new Map<string, { seq: number; revn: number }>();
  readonly sockets = new Set<FakeSocket>();
  /** The next accepted transaction is too large to broadcast: others are told to load the file. */
  bigNext = false;
  /** Saved versions (R2 snapshots), by revision. */
  readonly saved = new Map<number, NodeRecord[]>();
  latestSaved: number | null = null;

  save(): void {
    this.saved.set(this.revn, clone([...this.store.nodes()]));
    this.latestSaved = this.revn;
  }

  /** What `GET /api/files/:id/document` answers for a ticket. */
  download(ticket: string): { revn: number; nodes: NodeRecord[] } {
    const saved = /^saved:(\d+)$/.exec(ticket);
    if (saved) {
      const revn = Number(saved[1]);
      return { revn, nodes: clone(this.saved.get(revn) as NodeRecord[]) };
    }
    return { revn: this.revn, nodes: clone([...this.store.nodes()]) };
  }

  constructor(seed: Op[]) {
    applyTransaction(this.store, seed);
    this.revn = 1;
    this.log.push({ revn: 1, ops: seed });
  }

  handle(socket: FakeSocket, message: ClientMessage): void {
    if (message.t === "hello") {
      socket.clientId = message.clientId;
      const catchup =
        message.revn !== null &&
        message.revn <= this.revn &&
        this.revn - message.revn <= MAX_BEHIND;
      const download =
        !catchup && message.download === true && [...this.store.nodes()].length > INLINE_NODES;
      const from = this.latestSaved;
      socket.deliver({
        t: "welcome",
        sessionId: socket.clientId,
        revn: this.revn,
        role: "editor",
        peers: [],
        mode: catchup ? "catchup" : download ? "download" : "snapshot",
        lastSeq: this.lastSeq.get(message.clientId)?.seq ?? 0,
        ...(download ? { ticket: from === null ? "live" : `saved:${from}` } : {}),
      });
      const after = catchup ? (message.revn ?? 0) : download && from !== null ? from : null;
      if (after !== null) {
        for (const entry of this.log) {
          if (entry.revn > after) {
            socket.deliver({
              t: "txn",
              revn: entry.revn,
              ops: entry.ops,
              author: { userId: "u", sessionId: "s" },
            });
          }
        }
      } else if (!download) {
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
    const big = this.bigNext;
    this.bigNext = false;
    for (const other of this.sockets) {
      if (other !== socket && other.clientId) {
        other.deliver(
          big
            ? { t: "resync" }
            : {
                t: "txn",
                revn: this.revn,
                ops: message.ops as Op[],
                author: { userId: "u", sessionId: "s" },
              },
        );
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
  /** Downloads asked for and not yet answered, oldest first, from this and earlier connections. */
  readonly downloads: Array<{
    ticket: string;
    resolve: (file: { revn: number; nodes: NodeRecord[] }) => void;
    reject: (error: Error) => void;
  }> = [];
  /** Timers the engine set; they fire only when the test runs them. */
  timers: Array<() => void> = [];
  constructor(
    readonly room: FakeRoom,
    readonly id: string,
    readonly canDownload = false,
  ) {
    this.engine = new SyncEngine(this.doc, {
      clientId: id,
      setTimer: (fn) => this.timers.push(fn),
    });
  }
  connect(): void {
    const socket = new FakeSocket(this.room);
    this.socket = socket;
    this.engine.connected(
      (m) => {
        if (socket.open) socket.up.push(JSON.parse(JSON.stringify(m)) as ClientMessage);
      },
      this.canDownload
        ? {
            download: (ticket) =>
              new Promise((resolve, reject) => this.downloads.push({ ticket, resolve, reject })),
          }
        : {},
    );
  }
  /** Answers the oldest download (the file as the room has it now, or a saved version), or fails it. */
  async answerDownload(fail: boolean): Promise<boolean> {
    const next = this.downloads.shift();
    if (!next) return false;
    if (fail) next.reject(new Error("network"));
    else next.resolve(this.room.download(next.ticket));
    // The engine hears of it a microtask or two later.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    return true;
  }
  runTimers(): boolean {
    const timers = this.timers;
    this.timers = [];
    for (const fn of timers) fn();
    return timers.length > 0;
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
  | { kind: "reconnect"; client: number }
  | { kind: "save" }
  | { kind: "big" }
  | { kind: "download"; client: number; fail: boolean }
  | { kind: "timers"; client: number };

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
  it("every client ends equal to the room, whatever the interleaving", async () => {
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
      { weight: 1, arbitrary: fc.record({ kind: fc.constant("save" as const) }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant("big" as const) }) },
      {
        weight: 2,
        arbitrary: fc.record({
          kind: fc.constant("download" as const),
          client: fc.nat(2),
          fail: fc.boolean(),
        }),
      },
      {
        weight: 1,
        arbitrary: fc.record({ kind: fc.constant("timers" as const), client: fc.nat(2) }),
      },
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(action, { minLength: 60, maxLength: 240, size: "max" }),
        async (actions) => {
          const room = new FakeRoom(seed);
          // Two clients download a large file, one is sent it through the socket.
          const clients = [0, 1, 2].map((i) => new Client(room, `client${i}`, i > 0));
          for (const client of clients) {
            client.connect();
            while (client.pump("up") || client.pump("down")) {}
          }
          const counter = { n: 0 };
          for (const a of actions) {
            const client = clients["client" in a ? a.client : 0] as Client;
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
              case "save":
                room.save();
                break;
              case "big":
                room.bigNext = true;
                break;
              case "download":
                await client.answerDownload(a.fail);
                break;
              case "timers":
                client.runTimers();
                break;
            }
          }
          // Quiesce: flush, deliver, answer downloads and run timers until nothing moves.
          for (let round = 0; round < 50; round++) {
            let moved = false;
            for (const client of clients) {
              client.engine.flush();
              while (client.pump("up")) moved = true;
            }
            for (const client of clients) while (client.pump("down")) moved = true;
            for (const client of clients) {
              while (await client.answerDownload(false)) moved = true;
              if (client.runTimers()) moved = true;
            }
            if (!moved) break;
          }
          const expected = snapshot(room.store.nodes());
          for (const client of clients)
            expect({
              client: client.id,
              status: client.engine.status,
              revn: client.engine.revn,
              pending: client.engine.pendingCount,
              nodes: snapshot(client.doc.nodes()),
            }).toEqual({
              client: client.id,
              status: "live",
              revn: room.revn,
              pending: 0,
              nodes: expected,
            });
        },
      ),
      { numRuns: 400 },
    );
  }, 30_000); // 400 random interleavings: CPU-heavy, and slower when the whole repo tests at once.

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

describe("SyncEngine.takeUnsent", () => {
  it("hands over every unsent edit as one transaction that applies to the starting state", () => {
    const start: NodeRecord[] = [
      { id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    ] as NodeRecord[];
    const doc = new Doc();
    doc.reset(start);
    // Never connected: like the Worker's headless editor, edits only queue.
    const engine = new SyncEngine(doc, { clientId: "headless", setTimer: () => 0 });
    engine.commit([
      { op: "create", id: "r", type: "rect", parent: "p", key: "a0", props: { width: 10 } },
    ]);
    engine.commit([{ op: "set", id: "r", prop: "width", value: 20 }]);
    engine.commit([{ op: "set", id: "r", prop: "width", value: 30 }]);
    const ops = engine.takeUnsent();
    expect(engine.pendingCount).toBe(0);
    expect(engine.takeUnsent()).toEqual([]);
    // The overridden width is compacted away; the rest replays to the same document.
    expect(ops.filter((o) => o.op === "set")).toHaveLength(1);
    const room = new MemoryStore(start);
    applyTransaction(room, ops);
    expect(room.get("r")?.props.width).toBe(30);
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

  it("after losing the connection while a file loads, says the revision it had, not the one it was loading", () => {
    // What happened to a 500,000-layer file: the room was reset partway through sending it.
    const doc = new Doc();
    const engine = new SyncEngine(doc, { clientId: "c1", setTimer: () => 0 });
    const sent: ClientMessage[] = [];
    const download = () => new Promise<never>(() => {});
    engine.connected((m) => sent.push(m), { download });
    expect(sent).toEqual([{ t: "hello", protocol: 1, clientId: "c1", revn: null, download: true }]);
    const welcome = (mode: "snapshot" | "download") =>
      engine.receive({
        t: "welcome",
        sessionId: "s1",
        revn: 9,
        role: "editor",
        peers: [],
        mode,
        lastSeq: 0,
        ...(mode === "download" ? { ticket: "t" } : {}),
      });
    for (const mode of ["snapshot", "download"] as const) {
      welcome(mode);
      if (mode === "snapshot")
        engine.receive({ t: "snapshot", nodes: [doc.get(ROOT_ID) as NodeRecord], done: false });
      engine.disconnected();
      sent.length = 0;
      engine.connected((m) => sent.push(m), { download });
      expect(sent).toEqual([
        { t: "hello", protocol: 1, clientId: "c1", revn: null, download: true },
      ]);
      expect(engine.revn).toBeNull();
    }
  });

  it("takes no revision while the file loads again, from an ack or a change, so a reconnect loads it afresh", () => {
    const { engine, sent } = live();
    engine.commit(seed);
    engine.flush();
    // Someone's change too large to broadcast, then the room confirms ours, then another change.
    engine.receive({ t: "resync" });
    engine.receive({ t: "ack", seq: 1, revn: 3 });
    engine.receive({
      t: "txn",
      revn: 4,
      ops: [{ op: "set", id: PAGE, prop: "name", value: "Renamed" }],
      author: { userId: "u", sessionId: "s" },
    });
    expect(engine.revn).toBeNull();
    engine.disconnected();
    sent.length = 0;
    engine.connected((m) => sent.push(m));
    expect(sent).toEqual([{ t: "hello", protocol: 1, clientId: "c1", revn: null }]);
  });

  it("sends one hello at a time, however often the room asks to reload before answering", () => {
    const { engine, sent } = live();
    sent.length = 0;
    engine.receive({ t: "resync" });
    engine.receive({ t: "resync" });
    expect(sent.filter((m) => m.t === "hello")).toHaveLength(1);
  });

  it("asks again after a failed download without counting what came the first time twice", async () => {
    const doc = new Doc();
    const timers: Array<() => void> = [];
    const engine = new SyncEngine(doc, { clientId: "c1", setTimer: (fn) => timers.push(fn) });
    const sent: ClientMessage[] = [];
    const answers: Array<{
      resolve: (file: { revn: number; nodes: NodeRecord[] }) => void;
      reject: (error: Error) => void;
    }> = [];
    engine.connected((m) => sent.push(m), {
      download: () => new Promise((resolve, reject) => answers.push({ resolve, reject })),
    });
    const page: NodeRecord = {
      id: PAGE,
      type: "page",
      parent: ROOT_ID,
      key: "a0",
      props: { name: "Page 1" },
    };
    // The room offers a saved version at revision 1, and sends revision 2 after it.
    const welcomeAndReplay = () => {
      engine.receive({
        t: "welcome",
        sessionId: "s1",
        revn: 2,
        role: "editor",
        peers: [],
        mode: "download",
        lastSeq: 0,
        ticket: "saved-1",
      });
      engine.receive({
        t: "txn",
        revn: 2,
        ops: [{ op: "set", id: PAGE, prop: "name", value: "Renamed" }],
        author: { userId: "u", sessionId: "s" },
      });
    };
    const settle = async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };
    welcomeAndReplay();
    answers.shift()?.reject(new Error("network"));
    await settle();
    expect(timers).toHaveLength(1);
    timers.shift()?.();
    expect(sent.at(-1)).toMatchObject({ t: "hello", revn: null, download: true });
    welcomeAndReplay();
    answers.shift()?.resolve({ revn: 1, nodes: [page] });
    await settle();
    expect(engine.status).toBe("live");
    expect(engine.revn).toBe(2);
    expect(doc.get(PAGE)?.props.name).toBe("Renamed");
    expect(sent.filter((m) => m.t === "hello")).toHaveLength(2);
  });

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

  it("reports progress as edits wait and the room confirms them", () => {
    const { engine, sent } = live();
    const heard: [number | null, number][] = [];
    engine.on("progress", (revn, pending) => heard.push([revn, pending]));
    engine.commit(seed);
    expect(heard).toEqual([[1, 1]]);
    engine.flush();
    const txn = sent.find((m) => m.t === "txn") as { seq: number } | undefined;
    engine.receive({ t: "ack", seq: txn?.seq ?? 1, revn: 2 });
    expect(heard).toEqual([
      [1, 1],
      [2, 0],
    ]);
    // Nothing moved: nothing said.
    engine.receive({ t: "ack", seq: txn?.seq ?? 1, revn: 2 });
    expect(heard).toHaveLength(2);
  });

  it("times how long the room takes to confirm edits, and reports it now and then", () => {
    const doc = new Doc();
    const timers: (() => void)[] = [];
    const engine = new SyncEngine(doc, {
      clientId: "c1",
      setTimer: (fn) => timers.push(fn),
    });
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
    engine.commit(seed);
    engine.flush();
    const txn = sent.find((m) => m.t === "txn") as { seq: number };
    engine.receive({ t: "ack", seq: txn.seq, revn: 2 });
    // The report goes out on a timer, with the one confirmation counted (fast: the first bucket).
    for (const fire of timers.splice(0)) fire();
    const stats = sent.find((m) => m.t === "stats") as { latency: number[] } | undefined;
    expect(stats?.latency.reduce((a, b) => a + b, 0)).toBe(1);
    expect(stats?.latency[0]).toBe(1);
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

describe("SyncEngine in a file deeper than 128 levels", () => {
  it("rebases over a change the room accepted, putting back layers as deep as they were", () => {
    // A chain of groups from level 2 (D0) to level 133 (D131), as a file could hold.
    const nodes: NodeRecord[] = [{ id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} }];
    for (let i = 0; i < 132; i++)
      nodes.push({
        id: `D${i}`,
        type: "group",
        parent: i === 0 ? "p" : `D${i - 1}`,
        key: "a0",
        props: {},
      });
    const doc = new Doc();
    const engine = new SyncEngine(doc, { clientId: "c1", setTimer: () => 0 });
    engine.connected(() => {});
    engine.receive({
      t: "welcome",
      sessionId: "s1",
      revn: 1,
      role: "editor",
      peers: [],
      mode: "snapshot",
      lastSeq: 0,
    });
    engine.receive({ t: "snapshot", nodes, done: true });
    const desyncs: string[] = [];
    engine.on("desync", (reason) => desyncs.push(reason));
    // Deleting the deepest layer waits for the room: undoing it to rebase puts it back.
    engine.commit([{ op: "delete", id: "D131" }]);
    // Meanwhile the room accepted a restore that brought back a layer there.
    engine.receive({
      t: "txn",
      revn: 2,
      ops: [{ op: "create", id: "back", type: "group", parent: "D131", key: "a1", props: {} }],
      author: { userId: "u", sessionId: "restore" },
    });
    expect(desyncs).toEqual([]);
    // The pending delete is redone on top, taking the restored layer with it, as the room will.
    expect(doc.get("D131")).toBeUndefined();
    expect(engine.pendingCount).toBe(1);
    // The room confirms the delete.
    engine.receive({ t: "ack", seq: 1, revn: 3 });
    expect(desyncs).toEqual([]);
  });
});
