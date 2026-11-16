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
 *
 * The room says how the file stores copies (decision 0029) at welcome, and
 * the document takes that form when the snapshot loads. With compact
 * copies, an edit is made on the layers as presented, and what's sent and
 * kept to rebase with is what it stored (`Doc.lastStoredOps`), so the room
 * and other clients get override records, never copy layers.
 */
import {
  type ClientMessage,
  type CopiesFormat,
  LATENCY_BUCKETS_MS,
  latencyBucket,
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
  /** The edit as made, on layers as presented: what's applied again after a rebase. */
  ops: Op[];
  /** The edit as stored, as the room takes it (the same as `ops` unless copies are compact). */
  stored: Op[];
  /** Undoes `stored` exactly, as stored operations. Null when the edit no longer applies locally. */
  inverse: Op[] | null;
  /** Assigned when sent. */
  seq: number | null;
}

/** How this client can read a file's copies: both ways. */
const READS: CopiesFormat[] = ["materialized", "compact"];

export type ConnectionStatus = "connecting" | "syncing" | "live" | "offline";

export interface SyncEvents {
  status(status: ConnectionStatus): void;
  peers(peers: ReadonlyMap<string, Peer>): void;
  /** A transaction of ours was refused; the document already shows the room's state again. */
  rejected(code: string, message: string): void;
  /** The file's copies are stored this way (decision 0029), as the room said at welcome. */
  copies(copies: CopiesFormat): void;
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
  /** How often the edit latency histogram goes to the room (for the health page). */
  readonly statsIntervalMs?: number;
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
  readonly #statsIntervalMs: number;
  /** When each sent transaction left, by seq, to time the room's confirmation. */
  readonly #sentAt = new Map<number, number>();
  /** Confirmation times since the last report, counted into LATENCY_BUCKETS_MS. */
  #latency: number[] | null = null;
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
  /** How the room said the file stores copies, at the latest welcome. */
  #copies: CopiesFormat | null = null;
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
    this.#statsIntervalMs = options.statsIntervalMs ?? 30_000;
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
  /** How the file stores copies, as the room said; null before the first welcome. */
  get copies(): CopiesFormat | null {
    return this.#copies;
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
    const stored = [...this.#doc.lastStoredOps];
    const storedInverse = [...this.#doc.lastStoredInverse];
    const last = this.#pending.at(-1);
    if (last && last.seq === null && last.inverse) {
      // Merge into the unsent transaction: undo order is newest first.
      last.ops = compactOps([...last.ops, ...ops]);
      last.stored = compactOps([...last.stored, ...stored]);
      last.inverse = [...storedInverse, ...last.inverse];
    } else {
      this.#pending.push({ ops: [...ops], stored, inverse: storedInverse, seq: null });
    }
    this.#scheduleFlush();
    this.#progress();
    return inverse;
  }

  /**
   * Takes every edit not yet sent, as one transaction, and forgets it: for an
   * engine that commits edits itself instead of sending them (the Worker's
   * headless editor, decision 0021). Fix-ups are included, as they were
   * committed. Empty when there's nothing unsent.
   */
  takeUnsent(): Op[] {
    const unsent = this.#pending.filter((t) => t.seq === null);
    if (unsent.length === 0) return [];
    this.#pending = this.#pending.filter((t) => t.seq !== null);
    this.#progress();
    return compactOps(unsent.flatMap((t) => t.stored));
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
      this.#sentAt.set(txn.seq, Date.now());
      this.#send({ t: "txn", seq: txn.seq, ops: txn.stored });
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
    send({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      clientId: this.#clientId,
      revn: this.#revn,
      copies: READS,
    });
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
      case "role":
        this.#role = message.role;
        this.#emit("role", message.role);
        return;
      case "merged":
        // A merged branch is read-only for everyone.
        this.#role = "viewer";
        this.#emit("role", "viewer");
        return;
      case "merged-in":
      case "updated-from-main":
      case "pong":
        return;
      case "error":
        console.warn(`room error: ${message.code}: ${message.message}`);
        return;
    }
  }

  #welcome(message: Extract<ServerMessage, { t: "welcome" }>): void {
    // A room from before compact copies doesn't say: it stores them materialized.
    const copies = message.copies ?? "materialized";
    if (message.mode === "catchup" && copies !== this.#doc.copies) {
      // Changes in another form than the document's can't be caught up on: load it whole.
      this.#copies = copies;
      this.#resync(null);
      return;
    }
    const changed = this.#copies !== copies;
    this.#copies = copies;
    if (changed) this.#emit("copies", copies);
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
      // Resent under new numbers: their old send times no longer apply.
      this.#sentAt.clear();
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
    let dropped = 0;
    this.#doc.batch(() => {
      const before = this.#doc.copies;
      // As the room stores it: the document takes the file's form.
      this.#doc.resetStored(snapshot, this.#copies ?? "materialized");
      // Edits made before the file changed form that don't apply now (a copy layer's old
      // id) are dropped: the room couldn't take them in the old form.
      dropped = this.#redoPending(before !== this.#doc.copies);
    });
    if (dropped > 0)
      this.#emit(
        "rejected",
        "format",
        dropped === 1
          ? "This file was updated while you edited, and your last change couldn't be kept."
          : "This file was updated while you edited, and your last changes couldn't be kept.",
      );
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
        // The room accepted it: applied as it is (as stored), however deep (decision 0026).
        this.#doc.applyStored(ops, { held: true });
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
    this.#timeAck(seq);
  }

  /** Counts how long the room took to confirm everything up to `seq`, and reports it in a while. */
  #timeAck(seq: number): void {
    const now = Date.now();
    for (const [sent, at] of this.#sentAt) {
      if (sent > seq) continue;
      this.#sentAt.delete(sent);
      if (!this.#latency) {
        this.#latency = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
        this.#setTimer(() => this.#report(), this.#statsIntervalMs);
      }
      const bucket = latencyBucket(now - at);
      this.#latency[bucket] = (this.#latency[bucket] ?? 0) + 1;
    }
  }

  #report(): void {
    const latency = this.#latency;
    this.#latency = null;
    if (latency && this.#send && this.#status === "live") this.#send({ t: "stats", latency });
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
      if (txn.inverse) this.#doc.applyStored(txn.inverse, { held: true });
      txn.inverse = null;
    }
  }

  /**
   * Re-apply pending edits oldest first, each stored again against the
   * document as it is now. Edits that no longer apply stay queued; the room
   * will reject them too. When the file has changed form (`reformed`), they
   * can't be sent as they were: those are dropped instead. Returns how many.
   */
  #redoPending(reformed = false): number {
    let dropped = 0;
    const kept: PendingTxn[] = [];
    for (const txn of this.#pending) {
      try {
        this.#doc.apply(txn.ops);
        txn.stored = [...this.#doc.lastStoredOps];
        txn.inverse = [...this.#doc.lastStoredInverse];
      } catch (error) {
        if (!(error instanceof ModelError)) throw error;
        txn.inverse = null;
        if (reformed) {
          dropped++;
          continue;
        }
      }
      kept.push(txn);
    }
    this.#pending = kept;
    return dropped;
  }

  /** Loads the room's state afresh. `reason` is set when we fell out of step (not when the room asked). */
  #resync(reason: string | null): void {
    if (reason !== null) this.#emit("desync", reason);
    this.#revn = null;
    if (this.#send) {
      this.#setStatus("syncing");
      this.#send({
        t: "hello",
        protocol: PROTOCOL_VERSION,
        clientId: this.#clientId,
        revn: null,
        copies: READS,
      });
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
