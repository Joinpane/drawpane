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
  /** How often the edit latency histogram goes to the room (for the health page). */
  readonly statsIntervalMs?: number;
  /** Injected for tests. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
}

type Send = (message: ClientMessage) => void;

/**
 * Downloads the file with a welcome's ticket (mode `download`): its nodes,
 * and the revision they are at (the snapshot's header). `signal` aborts when
 * the download is no longer wanted (a disconnect, another welcome), so it
 * stops rather than reading the rest of a large file for nothing.
 */
export type Download = (
  ticket: string,
  signal: AbortSignal,
) => Promise<{ readonly revn: number; readonly nodes: readonly NodeRecord[] }>;

/** The longest wait before asking for the file again after a download failed. */
const MAX_DOWNLOAD_RETRY_MS = 30_000;

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
  /**
   * The revision the snapshot coming in is at. It becomes `#revn` only once
   * the snapshot is in: a connection lost partway leaves the document as it
   * was, at the revision it was at.
   */
  #snapshotRevn: number | null = null;
  /** How this connection downloads a file too large for the socket; null when it can't. */
  #download: Download | null = null;
  /** Downloads that failed in a row, for the wait before the next. */
  #downloadFailures = 0;
  /**
   * Counts welcomes, disconnects and resyncs: a download finishing after
   * one of them belongs to a connection or a welcome that's gone.
   */
  #generation = 0;
  /** Aborts the download under way, if any. */
  #downloading: AbortController | null = null;
  /**
   * A hello is out and its welcome hasn't come. Another isn't sent meanwhile:
   * two welcomes would each reset what's unconfirmed, the second from before
   * edits sent after the first, which would then go again as new ones.
   */
  #awaitingWelcome = false;
  /**
   * This client fell out of step while a hello was out: the welcome coming
   * may be a catch-up from the revision it no longer trusts, so it asks again
   * for the whole file.
   */
  #wantsFile = false;
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
    return compactOps(unsent.flatMap((t) => t.ops));
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

  /**
   * Call when a socket opens. With `download`, a large file is downloaded
   * (welcome mode `download`) instead of sent through the socket.
   */
  connected(send: Send, options: { readonly download?: Download } = {}): void {
    this.#send = send;
    this.#download = options.download ?? null;
    this.#setStatus("syncing");
    this.#hello(this.#revn);
  }

  #hello(revn: number | null): void {
    if (!this.#send) return;
    this.#awaitingWelcome = true;
    this.#send({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      clientId: this.#clientId,
      revn,
      ...(this.#download ? { download: true as const } : {}),
    });
  }

  /** Call when the socket closes. Pending edits are kept and resent on reconnect. */
  disconnected(): void {
    this.#nextGeneration();
    this.#send = null;
    this.#awaitingWelcome = false;
    this.#wantsFile = false;
    this.#download = null;
    this.#snapshot = null;
    this.#snapshotRevn = null;
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
    this.#nextGeneration();
    this.#awaitingWelcome = false;
    const stale = this.#wantsFile && message.mode === "catchup";
    this.#wantsFile = false;
    // Whatever came before this welcome comes again after it (in the log it replays, or in the
    // file it sends), so what an earlier one buffered is let go.
    this.#buffered = [];
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
      if (message.mode === "catchup" && !stale) {
        this.#redoPending();
      }
    });

    if (stale) {
      // Transactions buffer until the file asked for comes.
      this.#snapshot = [];
      this.#snapshotRevn = null;
      this.#hello(null);
    } else if (message.mode === "snapshot") {
      this.#snapshot = [];
      this.#snapshotRevn = message.revn;
    } else if (message.mode === "download") {
      // Transactions buffer meanwhile, as for a snapshot.
      this.#snapshot = [];
      this.#snapshotRevn = null;
      this.#startDownload(message.ticket ?? "");
    } else {
      this.#goLive();
    }
  }

  #snapshotChunk(nodes: readonly NodeRecord[], done: boolean): void {
    if (!this.#snapshot || this.#snapshotRevn === null) return;
    for (const node of nodes) this.#snapshot.push(node);
    if (done) this.#loaded(this.#snapshot, this.#snapshotRevn);
  }

  /** What was under way for the last welcome, connection or resync no longer is: a download stops. */
  #nextGeneration(): void {
    this.#generation++;
    this.#downloading?.abort();
    this.#downloading = null;
  }

  #startDownload(ticket: string): void {
    const generation = this.#generation;
    const download = this.#download;
    const failed = (error: unknown) => {
      if (generation !== this.#generation) return;
      const wait = Math.min(MAX_DOWNLOAD_RETRY_MS, 1000 * 2 ** this.#downloadFailures++);
      console.warn(`couldn't download the file, asking again in ${wait} ms`, error);
      this.#setTimer(() => {
        if (generation === this.#generation && this.#send) this.#hello(this.#revn);
      }, wait);
    };
    if (!download) {
      failed(new Error("the room sent a download this connection can't make"));
      return;
    }
    const controller = new AbortController();
    this.#downloading = controller;
    download(ticket, controller.signal).then((file) => {
      if (this.#downloading === controller) this.#downloading = null;
      if (generation !== this.#generation || !this.#snapshot) return;
      try {
        this.#loaded(file.nodes, file.revn);
        this.#downloadFailures = 0;
      } catch (error) {
        // A file that won't load is asked for again in a while, as a failed download is.
        this.#snapshot = [];
        this.#snapshotRevn = null;
        failed(error);
      }
    }, failed);
  }

  /**
   * The room's state is in: `nodes` at `revn`. Pending edits go on top, then
   * the transactions that came meanwhile, those after `revn`.
   */
  #loaded(nodes: readonly NodeRecord[], revn: number): void {
    this.#snapshot = null;
    this.#snapshotRevn = null;
    const buffered = this.#buffered;
    this.#buffered = [];
    // What came meanwhile must carry on from the snapshot without a gap.
    const after = buffered.filter((txn) => txn.revn > revn);
    if (after.some((txn, i) => txn.revn !== revn + 1 + i)) {
      this.#resync(`the file at revision ${revn} and the changes after it don't meet`);
      return;
    }
    this.#doc.batch(() => {
      this.#doc.reset(nodes);
      this.#redoPending();
    });
    this.#revn = revn;
    for (const txn of after) this.#remote(txn.revn, txn.ops);
    this.#goLive();
    // A download finishes outside `receive`, which reports progress otherwise.
    this.#progress();
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
        // The room accepted it: applied as it is, however deep (decision 0026).
        this.#doc.apply(ops, { held: true });
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
    // Only a document that's in follows the room's revision: while the file is loading again (a
    // resync asked for it, or a snapshot or download is on its way) the edit comes back in it,
    // and taking its revision would say this client is caught up to a file it doesn't have.
    if (this.#revn !== null && !this.#snapshot) this.#revn = Math.max(this.#revn, revn);
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
      if (txn.inverse) this.#doc.apply(txn.inverse, { held: true });
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
    this.#nextGeneration();
    this.#revn = null;
    // Loading again from now: what arrives buffers, and nothing here moves the revision, until
    // the file is in (a change applied to the document as it was would take its revision).
    this.#snapshot = [];
    this.#snapshotRevn = null;
    this.#buffered = [];
    if (this.#send) {
      this.#setStatus("syncing");
      // A welcome on its way answers this too when the room asked (whatever made it ask came
      // before it); when this client fell out of step, that welcome may be a catch-up, so it
      // asks for the file then.
      if (!this.#awaitingWelcome) this.#hello(null);
      else if (reason !== null) this.#wantsFile = true;
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
