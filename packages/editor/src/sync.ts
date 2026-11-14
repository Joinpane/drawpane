/**
 * The client half of the sync protocol.
 *
 * Local edits apply to the document at once and wait in `pending` until the
 * FileRoom acknowledges them. When someone else's transaction arrives, the
 * engine rebases: it undoes pending edits, applies the remote transaction,
 * then re-applies pending edits on top. Because the room validates with the
 * same model code against the same state, the document always equals
 * "server state + pending edits", and a local edit never flickers back.
 *
 * Unsent edits are merged and sent at most every `flushIntervalMs`, so a drag
 * at 120 Hz becomes a handful of transactions, not hundreds.
 */
import {
  type ClientMessage,
  ModelError,
  type NodeRecord,
  type Op,
  type Peer,
  PROTOCOL_VERSION,
  type Presence,
  type RestoredVersion,
  type ServerMessage,
} from "@drawpane/model";
import type { Doc } from "./doc";

interface PendingTxn {
  ops: Op[];
  /** Undoes `ops` against the state they were applied to. Null when they no longer apply locally. */
  inverse: Op[] | null;
  /** Assigned when sent. */
  seq: number | null;
}

export type ConnectionStatus = "connecting" | "syncing" | "live" | "offline";

export interface SyncEvents {
  status(status: ConnectionStatus): void;
  peers(peers: ReadonlyMap<string, Peer>): void;
  /** A transaction of ours was refused; the document already shows the room's state again. */
  rejected(code: string, message: string): void;
  /** The document could not follow the room; it is reloading a fresh snapshot. */
  desync(reason: string): void;
  role(role: "owner" | "editor" | "viewer"): void;
  /** Someone restored the whole file to a saved version; the document already shows it. */
  restored(by: { readonly userId: string; readonly name: string }, version: RestoredVersion): void;
  /** The room's revision or the count of our edits it hasn't confirmed changed ("Saved · revision N"). */
  progress(revn: number | null, pending: number): void;
}

export interface SyncOptions {
  readonly clientId: string;
  readonly flushIntervalMs?: number;
  readonly presenceIntervalMs?: number;
  /** Injected for tests. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
}

type Send = (message: ClientMessage) => void;

export class SyncEngine {
  readonly #doc: Doc;
  readonly #clientId: string;
  readonly #flushIntervalMs: number;
  readonly #presenceIntervalMs: number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #listeners: Partial<{ [K in keyof SyncEvents]: Set<SyncEvents[K]> }> = {};

  #send: Send | null = null;
  #status: ConnectionStatus = "connecting";
  #revn: number | null = null;
  #seq = 0;
  #pending: PendingTxn[] = [];
  #flushScheduled = false;
  #lastFlush = 0;
  #snapshot: NodeRecord[] | null = null;
  /** Remote transactions that arrive while a snapshot is still loading. */
  #buffered: Array<{ revn: number; ops: readonly Op[] }> = [];
  #sessionId: string | null = null;
  #role: "owner" | "editor" | "viewer" = "viewer";
  readonly #peers = new Map<string, Peer>();
  #presence: Presence | null = null;
  #presenceScheduled = false;
  #lastPresence = 0;

  constructor(doc: Doc, options: SyncOptions) {
    this.#doc = doc;
    this.#clientId = options.clientId;
    this.#flushIntervalMs = options.flushIntervalMs ?? 50;
    this.#presenceIntervalMs = options.presenceIntervalMs ?? 50;
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  get status(): ConnectionStatus {
    return this.#status;
  }
  get revn(): number | null {
    return this.#revn;
  }
  get sessionId(): string | null {
    return this.#sessionId;
  }
  get role(): "owner" | "editor" | "viewer" {
    return this.#role;
  }
  get peers(): ReadonlyMap<string, Peer> {
    return this.#peers;
  }
  /** Edits not yet acknowledged by the room. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  on<K extends keyof SyncEvents>(event: K, listener: SyncEvents[K]): () => void {
    let set = this.#listeners[event] as Set<SyncEvents[K]> | undefined;
    if (!set) {
      set = new Set();
      (this.#listeners as Record<string, Set<unknown>>)[event] = set;
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  #emit<K extends keyof SyncEvents>(event: K, ...args: Parameters<SyncEvents[K]>): void {
    const set = this.#listeners[event] as
      | Set<(...a: Parameters<SyncEvents[K]>) => void>
      | undefined;
    if (set) for (const listener of set) listener(...args);
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit("status", status);
  }

  // -------------------------------------------------------------------------
  // Local edits

  /**
   * Applies operations locally and queues them for the room. Returns their
   * inverse for undo. Throws `ModelError` (and changes nothing) when invalid.
   */
  commit(ops: readonly Op[]): Op[] {
    if (ops.length === 0) return [];
    const inverse = this.#doc.apply(ops);
    const last = this.#pending.at(-1);
    if (last && last.seq === null && last.inverse) {
      // Merge into the unsent transaction: undo order is newest first.
      last.ops = compactOps([...last.ops, ...ops]);
      last.inverse = [...inverse, ...last.inverse];
    } else {
      this.#pending.push({ ops: [...ops], inverse, seq: null });
    }
    this.#scheduleFlush();
    this.#progress();
    return inverse;
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled || !this.#send || this.#status !== "live") return;
    this.#flushScheduled = true;
    const wait = Math.max(0, this.#lastFlush + this.#flushIntervalMs - Date.now());
    this.#setTimer(() => {
      this.#flushScheduled = false;
      this.flush();
    }, wait);
  }

  /** Sends every unsent transaction now. */
  flush(): void {
    if (!this.#send || this.#status !== "live") return;
    this.#lastFlush = Date.now();
    for (const txn of this.#pending) {
      if (txn.seq !== null) continue;
      txn.seq = ++this.#seq;
      this.#send({ t: "txn", seq: txn.seq, ops: txn.ops });
    }
  }

  setPresence(presence: Presence): void {
    this.#presence = presence;
    if (this.#presenceScheduled || !this.#send || this.#status !== "live") return;
    this.#presenceScheduled = true;
    const wait = Math.max(0, this.#lastPresence + this.#presenceIntervalMs - Date.now());
    this.#setTimer(() => {
      this.#presenceScheduled = false;
      if (this.#send && this.#presence && this.#status === "live") {
        this.#lastPresence = Date.now();
        this.#send({ t: "presence", presence: this.#presence });
      }
    }, wait);
  }

  // -------------------------------------------------------------------------
  // Connection

  /** Call when a socket opens. */
  connected(send: Send): void {
    this.#send = send;
    this.#setStatus("syncing");
    send({ t: "hello", protocol: PROTOCOL_VERSION, clientId: this.#clientId, revn: this.#revn });
  }

  /** Call when the socket closes. Pending edits are kept and resent on reconnect. */
  disconnected(): void {
    this.#send = null;
    this.#snapshot = null;
    this.#buffered = [];
    this.#peers.clear();
    this.#emit("peers", this.#peers);
    this.#setStatus("offline");
  }

  receive(message: ServerMessage): void {
    this.#handle(message);
    this.#progress();
  }

  /** Tells listeners when the revision or the unconfirmed count moved. */
  #reported: { revn: number | null; pending: number } = { revn: null, pending: 0 };
  #progress(): void {
    const revn = this.#revn;
    const pending = this.pendingCount;
    if (revn === this.#reported.revn && pending === this.#reported.pending) return;
    this.#reported = { revn, pending };
    this.#emit("progress", revn, pending);
  }

  #handle(message: ServerMessage): void {
    switch (message.t) {
      case "welcome":
        this.#welcome(message);
        return;
      case "snapshot":
        this.#snapshotChunk(message.nodes, message.done);
        return;
      case "txn":
        this.#remote(message.revn, message.ops);
        return;
      case "ack":
        this.#ack(message.seq, message.revn);
        return;
      case "reject":
        this.#reject(message.seq, message.code, message.message);
        return;
      case "peer":
        this.#peers.set(message.peer.sessionId, message.peer);
        this.#emit("peers", this.#peers);
        return;
      case "peer-left":
        this.#peers.delete(message.sessionId);
        this.#emit("peers", this.#peers);
        return;
      case "presence": {
        const peer = this.#peers.get(message.sessionId);
        if (peer) {
          this.#peers.set(message.sessionId, { ...peer, presence: message.presence });
          this.#emit("peers", this.#peers);
        }
        return;
      }
      case "resync":
        this.#resync(null);
        return;
      case "restored":
        this.#emit("restored", message.by, message.version);
        return;
      case "pong":
        return;
      case "error":
        console.warn(`room error: ${message.code}: ${message.message}`);
        return;
    }
  }

  #welcome(message: Extract<ServerMessage, { t: "welcome" }>): void {
    this.#sessionId = message.sessionId;
    this.#role = message.role;
    this.#emit("role", message.role);
    this.#peers.clear();
    for (const peer of message.peers) this.#peers.set(peer.sessionId, peer);
    this.#emit("peers", this.#peers);

    // Anything the room already applied comes back through catch-up or the
    // snapshot, so drop it from pending. Everything else is resent.
    this.#doc.batch(() => {
      this.#undoPending();
      this.#pending = this.#pending.filter((t) => t.seq === null || t.seq > message.lastSeq);
      for (const txn of this.#pending) txn.seq = null;
      this.#seq = Math.max(this.#seq, message.lastSeq);
      if (message.mode === "catchup") {
        this.#redoPending();
      }
    });

    if (message.mode === "snapshot") {
      this.#snapshot = [];
      this.#revn = message.revn;
    } else {
      this.#goLive();
    }
  }

  #snapshotChunk(nodes: readonly NodeRecord[], done: boolean): void {
    if (!this.#snapshot) return;
    for (const node of nodes) this.#snapshot.push(node);
    if (!done) return;
    const snapshot = this.#snapshot;
    this.#snapshot = null;
    const buffered = this.#buffered;
    this.#buffered = [];
    this.#doc.batch(() => {
      this.#doc.reset(snapshot);
      this.#redoPending();
    });
    for (const txn of buffered) this.#remote(txn.revn, txn.ops);
    this.#goLive();
  }

  #goLive(): void {
    this.#setStatus("live");
    this.flush();
    if (this.#presence) this.setPresence(this.#presence);
  }

  #remote(revn: number, ops: readonly Op[]): void {
    if (this.#snapshot) {
      this.#buffered.push({ revn, ops });
      return;
    }
    if (this.#revn !== null && revn <= this.#revn) return; // Already seen.
    this.#doc.batch(() => {
      this.#undoPending();
      try {
        this.#doc.apply(ops);
      } catch (error) {
        this.#redoPending();
        this.#resync(error instanceof Error ? error.message : String(error));
        return;
      }
      this.#revn = revn;
      this.#redoPending();
    });
  }

  #ack(seq: number, revn: number): void {
    const head = this.#pending[0];
    if (!head || head.seq === null || head.seq > seq) return; // Stale ack for something already dropped.
    if (head.inverse === null) {
      // The room accepted an edit that no longer applies here: we have diverged.
      this.#pending.shift();
      this.#resync("the room accepted an edit that could not be applied locally");
      return;
    }
    while (this.#pending[0] && (this.#pending[0].seq ?? Number.POSITIVE_INFINITY) <= seq)
      this.#pending.shift();
    this.#revn = Math.max(this.#revn ?? 0, revn);
  }

  #reject(seq: number, code: string, message: string): void {
    const index = this.#pending.findIndex((t) => t.seq === seq);
    if (index === -1) return;
    this.#doc.batch(() => {
      this.#undoPending();
      this.#pending.splice(index, 1);
      this.#redoPending();
    });
    this.#emit("rejected", code, message);
  }

  /** Undo pending edits newest first, leaving the document at the last known room state. */
  #undoPending(): void {
    for (let i = this.#pending.length - 1; i >= 0; i--) {
      const txn = this.#pending[i] as PendingTxn;
      if (txn.inverse) this.#doc.apply(txn.inverse);
      txn.inverse = null;
    }
  }

  /** Re-apply pending edits oldest first. Edits that no longer apply stay queued; the room will reject them too. */
  #redoPending(): void {
    for (const txn of this.#pending) {
      try {
        txn.inverse = this.#doc.apply(txn.ops);
      } catch (error) {
        if (!(error instanceof ModelError)) throw error;
        txn.inverse = null;
      }
    }
  }

  /** Loads the room's state afresh. `reason` is set when we fell out of step (not when the room asked). */
  #resync(reason: string | null): void {
    if (reason !== null) this.#emit("desync", reason);
    this.#revn = null;
    if (this.#send) {
      this.#setStatus("syncing");
      this.#send({ t: "hello", protocol: PROTOCOL_VERSION, clientId: this.#clientId, revn: null });
    }
  }
}

/**
 * Drops `set` operations that a later `set` of the same property overrides,
 * unless a create, delete or move of that node sits between them.
 */
export function compactOps(ops: readonly Op[]): Op[] {
  const keep = new Array<boolean>(ops.length).fill(true);
  const seen = new Set<string>();
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i] as Op;
    if (op.op === "set") {
      const key = `${op.id}\u0000${op.prop}`;
      if (seen.has(key)) keep[i] = false;
      else seen.add(key);
    } else {
      // A structural op on a node ends any run of sets that could be merged across it.
      for (const key of seen) if (key.startsWith(`${op.id}\u0000`)) seen.delete(key);
    }
  }
  return ops.filter((_, i) => keep[i]);
}
