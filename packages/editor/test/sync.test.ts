import {
  applyTransaction,
  type ClientMessage,
  type CopiesFormat,
  copyId,
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
import { compactCopiesDefault, Doc } from "../src/doc";
import { compactOps, SyncEngine } from "../src/sync";

/** A client further behind than this loads the file again (the room's MAX_CATCHUP_BYTES). */
const MAX_BEHIND = 3;
/** Files of more nodes than this are downloaded by clients that can (INLINE_SNAPSHOT_NODES). */
const INLINE_NODES = 3;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** How a room stores copies in this run (the tests' second run turns compact copies on). */
const roomForm = (): CopiesFormat => (compactCopiesDefault() ? "compact" : "materialized");
/** What a client says it reads in its hello (protocol 3). */
const HELLO = { t: "hello", protocol: 4, copies: ["materialized", "compact"] } as const;

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

  /** How the room stores copies (decision 0029), which its snapshots' headers say. */
  readonly copies: CopiesFormat = roomForm();

  /** What `GET /api/files/:id/document` answers for a ticket. */
  download(ticket: string): { revn: number; nodes: NodeRecord[]; copies: CopiesFormat } {
    const saved = /^saved:(\d+)$/.exec(ticket);
    if (saved) {
      const revn = Number(saved[1]);
      return { revn, nodes: clone(this.saved.get(revn) as NodeRecord[]), copies: this.copies };
    }
    return { revn: this.revn, nodes: clone([...this.store.nodes()]), copies: this.copies };
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
        copies: this.copies,
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
    resolve: (file: { revn: number; nodes: NodeRecord[]; copies: CopiesFormat }) => void;
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

/**
 * The seed with a component: a main holding a layer, and two instances of
 * it. Stored as the room stores it in this run: compact (instance roots
 * only, copies presented from the main) or materialized (each copy a
 * stored layer that mirrors the main's).
 */
function componentSeed(): Op[] {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  const layer = { x: 0, y: 0, width: 100, height: 10 };
  const ops: Op[] = [
    ...seed,
    {
      op: "create",
      id: "M",
      type: "frame",
      parent: PAGE,
      key: "a1",
      props: { ...box, isComponent: true },
    },
    { op: "create", id: "R", type: "rect", parent: "M", key: "a0", props: layer },
  ];
  for (const [i, key] of [
    ["1", "a2"],
    ["2", "a3"],
  ] as const) {
    ops.push({
      op: "create",
      id: `I${i}`,
      type: "frame",
      parent: PAGE,
      key,
      props: { ...box, instanceOf: "M" },
    });
    if (roomForm() === "materialized")
      ops.push({
        op: "create",
        id: `C${i}`,
        type: "rect",
        parent: `I${i}`,
        key: "a0",
        props: { ...layer, mirrors: "R" },
      });
  }
  return ops;
}

/** Nodes as sorted strings, their values in key order (an edit may store a value again, last). */
function snapshot(nodes: Iterable<NodeRecord>) {
  return [...nodes]
    .map((n) => {
      const props = Object.fromEntries(
        Object.entries(n.props).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
      return JSON.stringify({ ...n, props });
    })
    .sort();
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
  switch (choice % 7) {
    case 5:
    case 6: {
      // A width on the main's layer or one of its copies (an override record when compact),
      // from few values, so a copy's override often comes to equal its main's.
      const targets = layers.filter((n) => n.id === "R" || n.props.mirrors !== undefined);
      const node = pick(targets);
      return node
        ? [{ op: "set", id: node.id, prop: "width", value: 100 * (1 + (choice % 3)) }]
        : null;
    }
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
          const room = new FakeRoom(componentSeed());
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
          // What the room stores, and that presented as a client loading it would.
          const expected = snapshot(room.store.nodes());
          const presented = new Doc();
          presented.resetStored(clone([...room.store.nodes()]), room.copies);
          const shown = snapshot(presented.nodes());
          for (const client of clients)
            expect({
              client: client.id,
              status: client.engine.status,
              revn: client.engine.revn,
              pending: client.engine.pendingCount,
              stored: snapshot(client.doc.stored()),
              nodes: snapshot(client.doc.nodes()),
            }).toEqual({
              client: client.id,
              status: "live",
              revn: room.revn,
              pending: 0,
              stored: expected,
              nodes: shown,
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

  it("keeps a set that what's made or moved under the node needs", () => {
    // An instance detached, the detach undone (its override record comes back, which needs
    // the instance) and redone, all unsent: the middle `instanceOf` has to stay.
    const ops: Op[] = [
      { op: "set", id: "i", prop: "instanceOf", value: "main" },
      { op: "create", id: "r", type: "override", parent: "i", key: "a0", props: { path: ["d"] } },
      { op: "delete", id: "r" },
      { op: "set", id: "i", prop: "instanceOf", value: null },
      { op: "set", id: "f", prop: "x", value: 1 },
      { op: "move", id: "g", parent: "f", key: "a0" },
      { op: "set", id: "f", prop: "x", value: 2 },
    ];
    expect(compactOps(ops)).toEqual(ops);
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
      copies: compactCopiesDefault() ? "compact" : "materialized",
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
    expect(sent).toEqual([{ ...HELLO, clientId: "c1", revn: null, download: true }]);
    const welcome = (mode: "snapshot" | "download") =>
      engine.receive({
        t: "welcome",
        sessionId: "s1",
        revn: 9,
        role: "editor",
        peers: [],
        mode,
        lastSeq: 0,
        copies: roomForm(),
        ...(mode === "download" ? { ticket: "t" } : {}),
      });
    for (const mode of ["snapshot", "download"] as const) {
      welcome(mode);
      if (mode === "snapshot")
        engine.receive({ t: "snapshot", nodes: [doc.get(ROOT_ID) as NodeRecord], done: false });
      engine.disconnected();
      sent.length = 0;
      engine.connected((m) => sent.push(m), { download });
      expect(sent).toEqual([{ ...HELLO, clientId: "c1", revn: null, download: true }]);
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
    expect(sent).toEqual([{ ...HELLO, clientId: "c1", revn: null }]);
  });

  it("sends one hello at a time, however often the room asks to reload before answering", () => {
    const { engine, sent } = live();
    sent.length = 0;
    engine.receive({ t: "resync" });
    engine.receive({ t: "resync" });
    expect(sent.filter((m) => m.t === "hello")).toHaveLength(1);
  });

  it("stops a download no longer wanted: on a disconnect, and on another welcome", () => {
    const engine = new SyncEngine(new Doc(), { clientId: "c1", setTimer: () => 0 });
    const signals: AbortSignal[] = [];
    const download = (_ticket: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<never>(() => {});
    };
    const welcome = () =>
      engine.receive({
        t: "welcome",
        sessionId: "s1",
        revn: 1,
        role: "editor",
        peers: [],
        mode: "download",
        lastSeq: 0,
        copies: roomForm(),
        ticket: "t",
      });
    engine.connected(() => {}, { download });
    welcome();
    expect(signals.map((s) => s.aborted)).toEqual([false]);
    welcome();
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    engine.disconnected();
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
  });

  it("asks again after a failed download without counting what came the first time twice", async () => {
    const doc = new Doc();
    const timers: Array<() => void> = [];
    const engine = new SyncEngine(doc, { clientId: "c1", setTimer: (fn) => timers.push(fn) });
    const sent: ClientMessage[] = [];
    const answers: Array<{
      resolve: (file: { revn: number; nodes: NodeRecord[]; copies: CopiesFormat }) => void;
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
        copies: roomForm(),
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
    answers.shift()?.resolve({ revn: 1, nodes: [page], copies: roomForm() });
    await settle();
    expect(engine.status).toBe("live");
    expect(engine.revn).toBe(2);
    expect(doc.get(PAGE)?.props.name).toBe("Renamed");
    expect(sent.filter((m) => m.t === "hello")).toHaveLength(2);
  });

  it("doesn't load a download in another form than the welcome said, and asks again later", async () => {
    // The file changed form between the welcome and the download (decision 0029): the room only
    // takes changes in the form it welcomed this client in.
    const doc = new Doc();
    const timers: Array<() => void> = [];
    const engine = new SyncEngine(doc, { clientId: "c1", setTimer: (fn) => timers.push(fn) });
    const sent: ClientMessage[] = [];
    const other: CopiesFormat = roomForm() === "compact" ? "materialized" : "compact";
    engine.connected((m) => sent.push(m), {
      download: async () => ({ revn: 1, nodes: [doc.get(ROOT_ID) as NodeRecord], copies: other }),
    });
    engine.receive({
      t: "welcome",
      sessionId: "s1",
      revn: 1,
      role: "editor",
      peers: [],
      mode: "download",
      lastSeq: 0,
      copies: roomForm(),
      ticket: "t",
    });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(engine.status).toBe("syncing");
    expect(engine.revn).toBeNull();
    // Asked for again after a wait, not at once (no loop with a room that keeps doing it).
    expect(sent.filter((m) => m.t === "hello")).toHaveLength(1);
    expect(timers).toHaveLength(1);
    timers.shift()?.();
    expect(sent.at(-1)).toMatchObject({ t: "hello", revn: null, download: true });
  });

  it("asks for the file when a catch-up comes in another form than the document's", () => {
    const { doc, engine, sent } = live();
    const other: CopiesFormat = doc.copies === "compact" ? "materialized" : "compact";
    engine.disconnected();
    sent.length = 0;
    engine.connected((m) => sent.push(m));
    expect(sent).toEqual([{ ...HELLO, clientId: "c1", revn: 1 }]);
    engine.receive({
      t: "welcome",
      sessionId: "s1",
      revn: 2,
      role: "editor",
      peers: [],
      mode: "catchup",
      lastSeq: 0,
      copies: other,
    });
    expect(sent.at(-1)).toEqual({ ...HELLO, clientId: "c1", revn: null });
    expect(engine.status).toBe("syncing");
    expect(engine.copies).toBe(other);
  });

  it("reloads quietly when the room asks, keeping pending edits", () => {
    const { engine, sent } = live();
    const desyncs: string[] = [];
    engine.on("desync", (reason) => desyncs.push(reason));
    engine.commit(seed);
    sent.length = 0;
    engine.receive({ t: "resync" });
    expect(engine.status).toBe("syncing");
    expect(sent).toEqual([
      {
        t: "hello",
        protocol: 4,
        clientId: "c1",
        revn: null,
        copies: ["materialized", "compact"],
      },
    ]);
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
      copies: compactCopiesDefault() ? "compact" : "materialized",
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
      copies: compactCopiesDefault() ? "compact" : "materialized",
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

describe("SyncEngine with compact copies", () => {
  it("rebases an edit already sent as the room will apply it, not stored again", () => {
    // A copy's width is 100. This client sets it to 200; before the room confirms that, another
    // client's change to the main's width (to 200 too) arrives. Stored again on top of it, the
    // edit would store nothing (the copy equals its main), but the room applies what was sent:
    // a record of 200. So a later change of the main to 300 shows 200 in the room.
    const nodes: NodeRecord[] = [
      { id: "P", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      { id: "M", type: "frame", parent: "P", key: "a0", props: { isComponent: true } },
      { id: "R", type: "rect", parent: "M", key: "a0", props: { width: 100 } },
      { id: "I", type: "frame", parent: "P", key: "a1", props: { instanceOf: "M" } },
    ];
    const room = new Doc();
    room.resetStored(clone(nodes), "compact");
    const doc = new Doc();
    const sent: ClientMessage[] = [];
    const engine = new SyncEngine(doc, { clientId: "A", setTimer: () => 0 });
    engine.connected((m) => sent.push(clone(m)));
    engine.receive({
      t: "welcome",
      sessionId: "A",
      revn: 1,
      role: "editor",
      peers: [],
      mode: "snapshot",
      lastSeq: 0,
      copies: "compact",
    });
    engine.receive({ t: "snapshot", nodes: clone(nodes), done: true });
    const copy = copyId("I", ["R"]);
    engine.commit([{ op: "set", id: copy, prop: "width", value: 200 }]);
    engine.flush();
    const txn = sent.find((m) => m.t === "txn");
    if (txn?.t !== "txn") throw new Error("nothing was sent");
    const author = { userId: "B", sessionId: "B" };
    const remote: Op[] = [{ op: "set", id: "R", prop: "width", value: 200 }];
    room.applyStored(remote);
    engine.receive({ t: "txn", revn: 2, ops: remote, author });
    room.applyStored(txn.ops as Op[]);
    engine.receive({ t: "ack", seq: txn.seq, revn: 3 });
    expect(snapshot(doc.stored())).toEqual(snapshot(room.stored()));
    const later: Op[] = [{ op: "set", id: "R", prop: "width", value: 300 }];
    room.applyStored(later);
    engine.receive({ t: "txn", revn: 4, ops: later, author });
    expect(room.get(copy)?.props.width).toBe(200);
    expect(doc.get(copy)?.props.width).toBe(200);
  });
});
