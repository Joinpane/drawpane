/**
 * FileRoom: one Durable Object per design file.
 *
 * It is the single authority on edit order. Each accepted transaction gets the
 * next revision number, is written to SQLite with the node rows it touches in
 * one storage transaction, is acknowledged to its sender and is broadcast to
 * every other socket. Sockets use the hibernation API, so an idle room costs
 * nothing.
 */

import { DurableObject } from "cloudflare:workers";
import {
  applyTransaction,
  branchChanges,
  ClientMessage,
  type CommentEvent,
  changeKey,
  keyBetween,
  LATENCY_BUCKETS_MS,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_OPS_PER_TRANSACTION,
  MemoryStore,
  ModelError,
  mergeOps,
  type NodeRecord,
  newId,
  nodeReader,
  type Op,
  type Peer,
  type Presence,
  type Resolution,
  type RestoredVersion,
  ROOT_ID,
  restoreOps,
  type ServerMessage,
  SNAPSHOT_CHUNK_SIZE,
  summarizeEdits,
  type VersionReason,
} from "@drawpane/model";
import { FILE_ACCESS, FILE_ROLE } from "../api/access";
import type { Env, Role } from "../env";
import { verifyPayload } from "../lib/crypto";
import { AUTOSAVE_RETENTION_MS, readSnapshot, snapshotKey, writeSnapshot } from "./snapshots";
import { NODE_SCHEMA, SqlNodeStore } from "./sql-store";

/** How long a confirmed membership is trusted before an edit checks it again. */
const ACCESS_RECHECK_MS = 60_000;

/** What the Worker vouches for when it hands a socket to the room. */
export interface RoomClaim {
  readonly uid: string;
  readonly name: string;
  readonly fid: string;
  readonly role: Role;
  readonly kind: "person" | "agent";
  /** Someone playing a shared prototype: they see the document, never who's in it. */
  readonly guest?: boolean;
  readonly exp: number;
}

export const CLAIM_HEADER = "x-drawpane-claim";

/** The author guests see on every change: nobody in particular. */
const ANONYMOUS = { userId: "", sessionId: "" } as const;

/** Per-socket state that survives hibernation. */
interface Attachment {
  readonly sessionId: string;
  readonly userId: string;
  readonly name: string;
  readonly role: Role;
  readonly kind: "person" | "agent";
  readonly color: number;
  /** A shared-prototype guest (see RoomClaim). Missing on sockets from before guests existed. */
  readonly guest?: boolean;
  clientId: string | null;
  /** When their team membership was last confirmed in D1 (see #checkAccess). */
  checkedAt?: number;
}

const LOG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS log (
    revn INTEGER PRIMARY KEY,
    client_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ops TEXT NOT NULL,
    at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL,
    last_revn INTEGER NOT NULL,
    at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
  -- Usage not yet reported to D1 (see #flushUsage): counted here so it
  -- survives the room going to sleep, and moved out by the alarm.
  CREATE TABLE IF NOT EXISTS usage (
    day TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (day, metric)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS usage_editors (
    day TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (day, user_id)
  ) STRICT, WITHOUT ROWID;
`;

/** Today in UTC, the key usage is counted under. */
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Transactions kept for reconnect catch-up. Older history lives in R2 snapshots. */
const LOG_RETENTION = 10_000;
const ALARM_DELAY_MS = 30_000;
/** While someone keeps editing, a version is saved at least this often. */
const SNAPSHOT_INTERVAL_MS = 60 * 60_000;
/** A version is saved once editing pauses for this long. */
const IDLE_SNAPSHOT_MS = 10 * 60_000;
/** Expired autosaves are swept at most this often. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
/** A reconnecting client that missed more than this (in JSON bytes) loads a snapshot instead. */
const MAX_CATCHUP_BYTES = 1 << 20;
/** A change bigger than this is not broadcast; clients are told to load the file again. */
const MAX_BROADCAST_BYTES = 1 << 20;

/** Who a change is logged as. */
interface Author {
  readonly clientId: string;
  readonly seq: number;
  readonly userId: string;
  readonly sessionId: string;
}

/** What `saveVersion` and `restoreVersion` are told about the person asking. */
export interface Requester {
  readonly userId: string;
  readonly name: string;
}

export interface SavedVersion {
  readonly id: string;
  readonly revn: number;
}

export type RestoreResult =
  | ({ readonly ok: true } & RestoredChange)
  /** The version's snapshot isn't in R2 (deleted by hand, or a failed write). */
  | { readonly ok: false; readonly reason: "missing" };

export interface RestoredChange {
  /** The revision the restore created, or the current one when nothing changed. */
  readonly revn: number;
  /** The version saved just before restoring, to undo it with. */
  readonly restorePoint: string;
  /** Operations the restore applied; 0 when the file already matched. */
  readonly changed: number;
  /** Values the current schema refused and the restore left out. */
  readonly dropped: number;
}

export class FileRoom extends DurableObject<Env> {
  readonly #sql: SqlStorage;
  readonly #store: SqlNodeStore;
  /** Live presence by session. Not persisted: after hibernation, peers resend on their next move. */
  readonly #presence = new Map<string, Presence>();
  #revn = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#store = new SqlNodeStore(this.#sql);
    ctx.blockConcurrencyWhile(async () => {
      this.#sql.exec(NODE_SCHEMA + LOG_SCHEMA);
      this.#revn = Number(this.#meta("revn") ?? 0);
      const hasPage = this.#store
        .childIds(ROOT_ID)
        .some((id) => this.#store.get(id)?.type === "page");
      if (!hasPage) this.#seed();
    });
  }

  // -------------------------------------------------------------------------
  // Entry points

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a websocket", { status: 426 });
    }
    const token = request.headers.get(CLAIM_HEADER);
    const claim = token ? await verifyPayload<RoomClaim>(this.env.SESSION_SECRET, token) : null;
    if (!claim || claim.exp < Date.now()) return new Response("Forbidden", { status: 403 });
    if (this.#meta("file_id") === null) this.#setMeta("file_id", claim.fid);
    else if (this.#meta("file_id") !== claim.fid) return new Response("Forbidden", { status: 403 });

    const { 0: client, 1: server } = new WebSocketPair();
    const attachment: Attachment = {
      sessionId: newId(),
      userId: claim.uid,
      name: claim.name,
      role: claim.role,
      kind: claim.kind,
      color: claim.guest ? 0 : this.#nextColor(),
      ...(claim.guest ? { guest: true } : {}),
      clientId: null,
    };
    // So an access change can find this room (see accessChanged). Written before the socket is
    // accepted: a change made after this point always reaches it.
    if (!claim.guest) {
      try {
        await this.#recordConnection(claim.fid, claim.uid);
      } catch (error) {
        console.error("couldn't record a connection", error);
        return new Response("Try again", { status: 503 });
      }
    }
    this.ctx.acceptWebSocket(server, [claim.uid]);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const size = typeof raw === "string" ? raw.length : raw.byteLength;
    if (size > MAX_CLIENT_MESSAGE_BYTES) {
      this.#send(ws, {
        t: "error",
        code: "too_large",
        message: "That change is too large to send at once.",
      });
      return;
    }
    let message: ClientMessage;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      message = ClientMessage.parse(JSON.parse(text));
    } catch {
      this.#send(ws, {
        t: "error",
        code: "bad_message",
        message: "The room couldn't read that message.",
      });
      return;
    }
    const me = ws.deserializeAttachment() as Attachment;
    switch (message.t) {
      case "hello":
        return this.#checkedHello(ws, me, message.clientId, message.revn);
      case "txn": {
        // Edits from someone whose access hasn't been confirmed lately wait for a check first.
        const current = await this.#checkAccess(ws, me);
        if (!current) return;
        return this.#transaction(ws, current, message.seq, message.ops as Op[]);
      }
      case "presence":
        // Guests are invisible: they have no cursor or selection to show.
        if (me.guest) return;
        this.#presence.set(me.sessionId, message.presence);
        this.#broadcast({ t: "presence", sessionId: me.sessionId, presence: message.presence }, ws);
        return;
      case "ping":
        this.#send(ws, { t: "pong" });
        return;
      case "stats":
        // How long this room took to confirm someone's edits, for the health page.
        if (me.guest) return;
        this.#countLatency(message.latency);
        void this.#scheduleAlarm();
        return;
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.#left(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.#left(ws);
  }

  override async alarm(): Promise<void> {
    const fileId = this.#meta("file_id");
    if (fileId) await this.#flushUsage(fileId);
    if (fileId && this.#meta("touched") === "1") {
      const editedAt = Number(this.#meta("touched_at")) || Date.now();
      await this.env.DB.prepare("UPDATE files SET updated_at = ? WHERE id = ?")
        .bind(editedAt, fileId)
        .run();
      this.#setMeta("touched", "0");
    }
    const due = this.#autosaveDue();
    if (fileId && due !== null && due <= Date.now()) {
      await this.#saveVersion(fileId, { reason: "auto" });
    }
    if (fileId) await this.#sweepVersions(fileId);
    this.#sql.exec("DELETE FROM log WHERE revn <= ?", this.#revn - LOG_RETENTION);
    // Keep going while there are edits no version holds yet.
    const next = this.#autosaveDue();
    if (next !== null) {
      await this.ctx.storage.setAlarm(Math.max(next, Date.now() + ALARM_DELAY_MS));
    }
  }

  /**
   * When the next autosave is due: an hour into a run of edits, or once
   * editing has paused for a while, whichever comes first. Null when every
   * edit is already in a version.
   */
  #autosaveDue(): number | null {
    const saved = Number(this.#meta("snapshot_revn") ?? 0);
    if (this.#revn <= saved) return null;
    const run = this.#sql
      .exec<{ first: number | null; last: number | null }>(
        "SELECT MIN(at) AS first, MAX(at) AS last FROM log WHERE revn > ? AND client_id != 'system'",
        saved,
      )
      .one();
    if (run.first === null || run.last === null) return Date.now();
    return Math.min(run.first + SNAPSHOT_INTERVAL_MS, run.last + IDLE_SNAPSHOT_MS);
  }

  /** Deletes everything this room stores. Called when a file is deleted for good. */
  async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      // Nothing left to tidy when it finishes closing: the storage is about to go.
      ws.serializeAttachment(null);
      ws.close(4404, "File deleted");
    }
    const fileId = this.#meta("file_id");
    if (fileId) {
      const listed = await this.env.FILES.list({ prefix: `files/${fileId}/` });
      if (listed.objects.length > 0) await this.env.FILES.delete(listed.objects.map((o) => o.key));
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Relays a comment change to everyone in the file. Comments live in D1; the
   * Worker calls this after each successful write. Returns how many sockets
   * it reached.
   */
  async broadcastComments(event: CommentEvent): Promise<number> {
    return this.#broadcast({ t: "comments", event });
  }

  /**
   * Someone's role on the file's team changed, or they were removed (`null`):
   * their open sockets here get the new role at once (a viewer's next edit
   * is refused), or are closed with 4401. Returns how many sockets it reached.
   */
  async accessChanged(
    userId: string,
    role: Role | null,
    by: { readonly id: string; readonly name: string },
  ): Promise<number> {
    let reached = 0;
    for (const ws of this.ctx.getWebSockets(userId)) {
      const me = ws.deserializeAttachment() as Attachment | null;
      if (!me || me.guest || me.userId !== userId) continue;
      reached++;
      if (role === null) {
        // The reason tells the client whether they left or were removed.
        this.#close(ws, 4401, by.id === userId ? "Left the team" : "Access removed");
        continue;
      }
      if (me.role === role) continue;
      ws.serializeAttachment({ ...me, role });
      this.#send(ws, { t: "role", role, previous: me.role, by });
    }
    const fileId = this.#meta("file_id");
    if (fileId && (reached === 0 || role === null))
      void this.#forgetConnection(fileId, userId, Date.now()).catch((error: unknown) =>
        console.warn("couldn't forget a connection", error),
      );
    return reached;
  }

  /**
   * This file is a branch, just merged into its main file (decision 0012):
   * everyone here becomes a viewer at once and hears why. The Worker reads
   * merged branches as read-only from then on, so reconnecting changes nothing.
   */
  async merged(by: { readonly id: string; readonly name: string }): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const me = ws.deserializeAttachment() as Attachment | null;
      if (!me) continue;
      ws.serializeAttachment({ ...me, role: "viewer" });
      this.#send(ws, { t: "merged", by });
    }
  }

  /** Disconnects everyone playing a shared prototype (the link was turned off). Returns how many. */
  async closeGuests(): Promise<number> {
    let closed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const me = ws.deserializeAttachment() as Attachment | null;
      if (!me?.guest) continue;
      try {
        ws.close(4403, "Link turned off");
        closed++;
      } catch {
        // Already closing.
      }
    }
    return closed;
  }

  /**
   * Saves the current state as a named version, or names the version that
   * already holds it. Returns that version.
   */
  async saveVersion(
    by: Requester,
    name: string,
    description: string | null,
  ): Promise<SavedVersion> {
    const fileId = this.#requireFileId();
    return this.#saveVersion(fileId, { reason: "named", by: by.userId, name, description });
  }

  /**
   * Restores the whole file to a saved version. The current state is saved
   * first, so the restore can be undone by restoring that. The restore is one
   * ordinary transaction: everyone sees it, it is logged, and pending edits
   * from other people rebase on top of it.
   */
  async restoreVersion(
    by: Requester,
    version: RestoredVersion & { readonly revn: number },
    /** The restorer's own socket, which shows its own confirmation instead of the "restored" notice. */
    sessionId: string | null,
  ): Promise<RestoreResult> {
    const fileId = this.#requireFileId();
    const nodes = await readSnapshot(this.env.FILES, snapshotKey(fileId, version.revn));
    if (!nodes) return { ok: false, reason: "missing" };
    const restorePoint = await this.#saveVersion(fileId, {
      reason: "restore",
      by: by.userId,
      restoredId: version.id,
    });
    // From here to the commit nothing awaits, so the diff and the store agree.
    const now: NodeRecord[] = [];
    for (const page of this.#store.pages(SNAPSHOT_CHUNK_SIZE)) now.push(...page);
    const plan = restoreOps(new MemoryStore(now), nodes);
    if (plan.ops.length === 0) {
      return {
        ok: true,
        revn: this.#revn,
        restorePoint: restorePoint.id,
        changed: 0,
        dropped: plan.dropped,
      };
    }
    const author = { clientId: "restore", seq: 0, userId: by.userId, sessionId: "restore" };
    const revn = this.#commit(plan.ops, author);
    const except = this.#attachments().find(({ me }) => me.sessionId === sessionId)?.ws;
    this.#broadcastChange(revn, plan.ops, author);
    this.#broadcast(
      { t: "restored", by, version: { id: version.id, name: version.name, at: version.at } },
      except,
    );
    void this.#scheduleAlarm();
    return {
      ok: true,
      revn,
      restorePoint: restorePoint.id,
      changed: plan.ops.length,
      dropped: plan.dropped,
    };
  }

  /**
   * Fills a new file with imported content (a converted .penpot, say). Only
   * a file nobody has touched: its starting page, still empty, which the
   * import replaces (removed once the imported pages are in). The nodes are checked as a whole first, so a bad one
   * leaves the file as it was; they're then committed in chunks that keep
   * each log row well under SQLite's row limit, parents before children.
   */
  async importNodes(by: Requester, nodes: readonly NodeRecord[]): Promise<ImportResult> {
    const roots = this.#store.childIds(ROOT_ID);
    const seed = roots.length === 1 ? this.#store.get(roots[0] as string) : undefined;
    if (seed?.type !== "page" || this.#store.childIds(seed.id).length > 0)
      return { ok: false, reason: "not-empty" };
    if (!nodes.some((n) => n.parent === ROOT_ID && n.type === "page"))
      return { ok: false, reason: "invalid", message: "There's nothing to import." };
    // The starting page goes last: a file always has a page, even between chunks.
    const ops: Op[] = [...creationOrder(nodes), { op: "delete", id: seed.id }];
    try {
      // A dry run on a copy: everything valid, or nothing written.
      applyTransaction(new MemoryStore([seed]), ops, { rollback: false });
    } catch (error) {
      if (error instanceof ModelError)
        return { ok: false, reason: "invalid", message: error.message };
      throw error;
    }
    const author = { clientId: "import", seq: 0, userId: by.userId, sessionId: "import" };
    let revn = this.#revn;
    for (const chunk of chunked(ops, IMPORT_CHUNK_CHARS)) {
      revn = this.#commit(chunk, author);
      this.#broadcastChange(revn, chunk, author);
    }
    void this.#scheduleAlarm();
    return { ok: true, revn, nodes: nodes.length };
  }

  /**
   * Merges a branch into this file, its main file (decision 0012). The
   * changes are worked out here, against the file as it is at this moment, so
   * nothing main did since the reviewer looked is overwritten unseen: a
   * conflict without a decision stops the merge. The file is saved as a named
   * version first, which undoes the merge from History; then the chosen
   * changes are one ordinary transaction that everyone here sees arrive.
   */
  async mergeBranch(
    by: Requester,
    fileId: string,
    branch: { readonly id: string; readonly name: string },
    snapshots: { readonly base: readonly NodeRecord[]; readonly branch: readonly NodeRecord[] },
    choices: {
      /** Each conflict's side, by change key (see changeKey). */
      readonly resolutions: Readonly<Record<string, Resolution>>;
      /** Changes left out, by change key. */
      readonly skip: readonly string[];
    },
  ): Promise<MergeResult> {
    this.#adopt(fileId);
    const read = () => {
      const nodes: NodeRecord[] = [];
      for (const page of this.#store.pages(SNAPSHOT_CHUNK_SIZE)) nodes.push(...page);
      return nodes;
    };
    const resolutions = new Map(Object.entries(choices.resolutions));
    const skip = new Set(choices.skip);
    const plan = (nodes: readonly NodeRecord[]) => {
      const main = nodeReader(nodes);
      const changes = branchChanges(
        nodeReader(snapshots.base),
        nodeReader(snapshots.branch),
        main,
      ).filter((c) => !skip.has(changeKey(c)));
      const undecided = changes.filter((c) => c.conflict && !resolutions.has(changeKey(c)));
      return { main, changes, undecided };
    };

    // Checked before the restore point is saved, and again after (that awaits).
    const first = plan(read());
    if (first.undecided.length > 0)
      return { ok: false, reason: "undecided", undecided: first.undecided.length };
    const restorePoint = await this.#saveVersion(fileId, {
      reason: "named",
      by: by.userId,
      name: `Before merging “${branch.name}”`,
      description: null,
      keepName: true,
    });

    // From here to the commit nothing awaits, so the plan and the store agree.
    const nodes = read();
    const { main, changes, undecided } = plan(nodes);
    if (undecided.length > 0)
      return { ok: false, reason: "undecided", undecided: undecided.length };
    const ops = mergeOps(main, nodeReader(snapshots.branch), changes, resolutions);
    if (ops.length === 0)
      return { ok: true, revn: this.#revn, restorePoint: restorePoint.id, changes: 0 };
    try {
      // A dry run on a copy: the whole merge applies, or none of it.
      applyTransaction(new MemoryStore(nodes), ops, { rollback: false });
    } catch (error) {
      if (error instanceof ModelError)
        return { ok: false, reason: "invalid", message: error.message };
      throw error;
    }
    const author = { clientId: "merge", seq: 0, userId: by.userId, sessionId: "merge" };
    const revn = this.#commit(ops, author);
    this.#broadcastChange(revn, ops, author);
    this.#broadcast({
      t: "merged-in",
      by: { id: by.userId, name: by.name },
      branch,
      changes: changes.length,
    });
    void this.#scheduleAlarm();
    return { ok: true, revn, restorePoint: restorePoint.id, changes: changes.length };
  }

  /** Every node in the file, for copying it into another (a duplicate, a file from a template). */
  async allNodes(): Promise<NodeRecord[]> {
    const out: NodeRecord[] = [];
    for (const page of this.#store.pages(SNAPSHOT_CHUNK_SIZE)) out.push(...page);
    return out;
  }

  /**
   * Every node with the revision they're at, read without awaiting so the two
   * agree: what a branch is made from, and its base (decision 0012).
   */
  async snapshot(): Promise<{ revn: number; nodes: NodeRecord[] }> {
    const nodes: NodeRecord[] = [];
    for (const page of this.#store.pages(SNAPSHOT_CHUNK_SIZE)) nodes.push(...page);
    return { revn: this.#revn, nodes };
  }

  /** Current revision and node count, for tests and the health page. */
  async stats(): Promise<{ revn: number; nodes: number; sockets: number }> {
    return {
      revn: this.#revn,
      nodes: this.#store.count(),
      sockets: this.ctx.getWebSockets().length,
    };
  }

  // -------------------------------------------------------------------------
  // Protocol

  /**
   * Hello, after checking the person is still on the file's team, as they
   * were when the Worker let them in: a removal that raced their joining
   * closes the socket here, and a role changed meanwhile is the one used.
   * The client id is only set after, so nothing is accepted before.
   */
  async #checkedHello(
    ws: WebSocket,
    me: Attachment,
    clientId: string,
    revn: number | null,
  ): Promise<void> {
    const current = await this.#checkAccess(ws, me, true);
    if (current) this.#hello(ws, current, clientId, revn);
  }

  /**
   * Confirms the person is still on the file's team (at hello, and before an
   * edit once a minute has passed): access changes are pushed to open rooms,
   * and this bounds what happens if one is ever missed. Returns their
   * attachment, with the role as it is now, or null after closing the socket.
   */
  async #checkAccess(ws: WebSocket, me: Attachment, now = false): Promise<Attachment | null> {
    if (me.guest) return me;
    if (!now && Date.now() - (me.checkedAt ?? 0) < ACCESS_RECHECK_MS) return me;
    const role = await this.#currentRole(me.userId);
    if (role === null) {
      this.#close(ws, 4401, "Access removed");
      return null;
    }
    // Re-read: a hello or role change may have updated it while D1 answered.
    const latest = (ws.deserializeAttachment() as Attachment | null) ?? me;
    const next: Attachment = {
      ...latest,
      ...(role !== undefined ? { role, checkedAt: Date.now() } : {}),
    };
    ws.serializeAttachment(next);
    return next;
  }

  /** Their role on the file's team now; null when they're not on it, undefined when D1 can't say. */
  async #currentRole(userId: string): Promise<Role | null | undefined> {
    const fileId = this.#meta("file_id");
    if (!fileId) return undefined;
    try {
      const row = await this.env.DB.prepare(
        `SELECT ${FILE_ROLE} AS role FROM ${FILE_ACCESS} WHERE f.id = ?`,
      )
        .bind(userId, fileId)
        .first<{ role: Role }>();
      return row?.role ?? null;
    } catch (error) {
      // The Worker checked moments ago; a D1 hiccup shouldn't lock everyone out.
      console.error("couldn't check access", error);
      return undefined;
    }
  }

  #close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  #hello(ws: WebSocket, me: Attachment, clientId: string, revn: number | null): void {
    me.clientId = clientId;
    ws.serializeAttachment(me);
    const lastSeq =
      this.#sql
        .exec<{ last_seq: number }>("SELECT last_seq FROM clients WHERE client_id = ?", clientId)
        .toArray()[0]?.last_seq ?? 0;
    const oldest = this.#sql
      .exec<{ revn: number | null }>("SELECT MIN(revn) AS revn FROM log")
      .one().revn;
    const canCatchUp =
      revn !== null &&
      revn <= this.#revn &&
      (revn === this.#revn ||
        (oldest !== null &&
          oldest <= revn + 1 &&
          this.#sql
            .exec<{ bytes: number }>(
              "SELECT COALESCE(SUM(LENGTH(ops)), 0) AS bytes FROM log WHERE revn > ?",
              revn,
            )
            .one().bytes <= MAX_CATCHUP_BYTES));

    const peers = me.guest ? [] : this.#peers().filter((p) => p.sessionId !== me.sessionId);
    this.#send(ws, {
      t: "welcome",
      sessionId: me.sessionId,
      revn: this.#revn,
      role: me.role,
      peers,
      mode: canCatchUp ? "catchup" : "snapshot",
      lastSeq,
    });
    if (canCatchUp) {
      const rows = this.#sql
        .exec<{ revn: number; ops: string; user_id: string; session_id: string }>(
          "SELECT revn, ops, user_id, session_id FROM log WHERE revn > ? ORDER BY revn",
          revn,
        )
        .toArray();
      for (const row of rows) {
        this.#send(ws, {
          t: "txn",
          revn: row.revn,
          ops: JSON.parse(row.ops) as Op[],
          author: me.guest ? ANONYMOUS : { userId: row.user_id, sessionId: row.session_id },
        });
      }
    } else {
      for (const nodes of this.#store.pages(SNAPSHOT_CHUNK_SIZE)) {
        this.#send(ws, { t: "snapshot", nodes, done: false });
      }
      this.#send(ws, { t: "snapshot", nodes: [], done: true });
    }
    if (!me.guest) this.#broadcast({ t: "peer", peer: this.#peer(me) }, ws);
  }

  #transaction(ws: WebSocket, me: Attachment, seq: number, ops: Op[]): void {
    if (!me.clientId) {
      this.#send(ws, {
        t: "error",
        code: "no_hello",
        message: "Say hello before sending changes.",
      });
      return;
    }
    if (me.role === "viewer") {
      this.#reject(ws, seq, ops, "forbidden", "You can view this file but not edit it.");
      return;
    }
    const clientId = me.clientId;
    const known = this.#sql
      .exec<{ last_seq: number; last_revn: number }>(
        "SELECT last_seq, last_revn FROM clients WHERE client_id = ?",
        clientId,
      )
      .toArray()[0];
    if (known && seq <= known.last_seq) {
      // A resend after reconnect that the room already applied.
      this.#send(ws, { t: "ack", seq, revn: known.last_revn });
      return;
    }

    const author = { clientId, seq, userId: me.userId, sessionId: me.sessionId };
    let revn: number;
    try {
      revn = this.#commit(ops, author);
    } catch (error) {
      if (error instanceof ModelError) {
        this.#reject(ws, seq, ops, error.code, error.message);
        return;
      }
      console.error("transaction failed", error);
      this.#reject(ws, seq, ops, "internal", "The room couldn't save that change. Try again.");
      return;
    }
    this.#send(ws, { t: "ack", seq, revn });
    this.#broadcastChange(revn, ops, author, ws);
    void this.#scheduleAlarm();
  }

  /**
   * Applies and logs one transaction in a single storage transaction and
   * returns its revision. Throws (changing nothing) when it doesn't apply.
   */
  #commit(ops: readonly Op[], author: Author): number {
    try {
      const revn = this.ctx.storage.transactionSync(() => {
        applyTransaction(this.#store, ops, { rollback: false });
        const next = this.#revn + 1;
        const now = Date.now();
        this.#sql.exec(
          "INSERT INTO log (revn, client_id, seq, user_id, session_id, ops, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          next,
          author.clientId,
          author.seq,
          author.userId,
          author.sessionId,
          JSON.stringify(ops),
          now,
        );
        if (author.seq > 0) {
          this.#sql.exec(
            `INSERT INTO clients (client_id, last_seq, last_revn, at) VALUES (?, ?, ?, ?)
             ON CONFLICT (client_id) DO UPDATE SET last_seq = excluded.last_seq, last_revn = excluded.last_revn, at = excluded.at`,
            author.clientId,
            author.seq,
            next,
            now,
          );
        }
        if (author.userId !== "system") this.#count(now, author.userId);
        this.#setMeta("revn", String(next));
        this.#setMeta("touched", "1");
        // When the file was last edited (not when the alarm gets round to saying so).
        this.#setMeta("touched_at", String(now));
        return next;
      });
      this.#revn = revn;
      return revn;
    } finally {
      this.#store.clearCache();
    }
  }

  /** Sends a committed change to everyone but `except`, or asks them to reload when it's huge. */
  #broadcastChange(revn: number, ops: readonly Op[], author: Author, except?: WebSocket): void {
    const message: ServerMessage = {
      t: "txn",
      revn,
      ops,
      author: { userId: author.userId, sessionId: author.sessionId },
    };
    if (JSON.stringify(ops).length > MAX_BROADCAST_BYTES) this.#broadcast({ t: "resync" }, except);
    else this.#broadcast(message, except);
  }

  #reject(ws: WebSocket, seq: number, ops: readonly Op[], code: string, message: string): void {
    const fix: Record<string, NodeRecord | null> = {};
    for (const op of ops) {
      if (fix[op.id] === undefined) fix[op.id] = this.#store.get(op.id) ?? null;
      if (
        (op.op === "create" || op.op === "move") &&
        fix[op.parent] === undefined &&
        op.parent !== ROOT_ID
      ) {
        fix[op.parent] = this.#store.get(op.parent) ?? null;
      }
    }
    this.#store.clearCache();
    this.#send(ws, { t: "reject", seq, code, message, fix });
  }

  // -------------------------------------------------------------------------
  // Helpers

  #seed(): void {
    this.#commit(
      [
        {
          op: "create",
          id: newId(),
          type: "page",
          parent: ROOT_ID,
          key: keyBetween(null, null),
          props: { name: "Page 1" },
        },
      ],
      { clientId: "system", seq: 0, userId: "system", sessionId: "system" },
    );
  }

  /** Counts one edit by `userId` for the health page (inside the edit's own storage transaction). */
  #count(now: number, userId: string): void {
    const day = today(now);
    this.#sql.exec(
      "INSERT INTO usage (day, metric, value) VALUES (?, 'edits', 1) ON CONFLICT (day, metric) DO UPDATE SET value = value + 1",
      day,
    );
    this.#sql.exec("INSERT OR IGNORE INTO usage_editors (day, user_id) VALUES (?, ?)", day, userId);
  }

  /** Adds a client's latency histogram (counts per LATENCY_BUCKETS_MS bucket) to today's usage. */
  #countLatency(counts: readonly number[]): void {
    const day = today();
    this.ctx.storage.transactionSync(() => {
      counts.forEach((n, i) => {
        if (n <= 0) return;
        const ceiling = LATENCY_BUCKETS_MS[i];
        this.#sql.exec(
          "INSERT INTO usage (day, metric, value) VALUES (?, ?, ?) ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value",
          day,
          `latency_le_${ceiling ?? "inf"}`,
          n,
        );
      });
    });
  }

  /**
   * Moves the counted usage to D1 in one batch, with the room's storage size:
   * at most once per alarm, so measuring costs next to nothing. If D1 fails,
   * the counts go back to wait for the next alarm.
   */
  async #flushUsage(fileId: string): Promise<void> {
    const { usage, editors } = this.ctx.storage.transactionSync(() => {
      const usage = this.#sql
        .exec<{ day: string; metric: string; value: number }>(
          "SELECT day, metric, value FROM usage",
        )
        .toArray();
      const editors = this.#sql
        .exec<{ day: string; user_id: string }>("SELECT day, user_id FROM usage_editors")
        .toArray();
      this.#sql.exec("DELETE FROM usage");
      this.#sql.exec("DELETE FROM usage_editors");
      return { usage, editors };
    });
    const db = this.env.DB;
    try {
      await db.batch([
        ...usage.map((u) =>
          db
            .prepare(
              "INSERT INTO usage_daily (day, metric, value) VALUES (?, ?, ?) ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value",
            )
            .bind(u.day, u.metric, u.value),
        ),
        ...editors.map((e) =>
          db
            .prepare("INSERT OR IGNORE INTO editors_daily (day, user_id) VALUES (?, ?)")
            .bind(e.day, e.user_id),
        ),
        db
          .prepare(
            "INSERT INTO room_storage (file_id, bytes, updated_at) VALUES (?, ?, ?) ON CONFLICT (file_id) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at",
          )
          .bind(fileId, this.ctx.storage.sql.databaseSize, Date.now()),
      ]);
    } catch (error) {
      console.error("usage flush failed", error);
      this.ctx.storage.transactionSync(() => {
        for (const u of usage)
          this.#sql.exec(
            "INSERT INTO usage (day, metric, value) VALUES (?, ?, ?) ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value",
            u.day,
            u.metric,
            u.value,
          );
        for (const e of editors)
          this.#sql.exec(
            "INSERT OR IGNORE INTO usage_editors (day, user_id) VALUES (?, ?)",
            e.day,
            e.user_id,
          );
      });
    }
  }

  /** Brings the alarm forward to soon (it keeps the file's "edited" time fresh), never later. */
  async #scheduleAlarm(): Promise<void> {
    const soon = Date.now() + ALARM_DELAY_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > soon) await this.ctx.storage.setAlarm(soon);
  }

  /**
   * Saves the current state as a version: a gzip snapshot in R2 and a row in
   * D1 with who edited since the last version and what they changed. When a
   * version already holds this revision, it is reused (and named, if a name
   * is given).
   */
  async #saveVersion(
    fileId: string,
    options: {
      readonly reason: VersionReason;
      readonly by?: string;
      readonly name?: string;
      readonly description?: string | null;
      readonly restoredId?: string;
      /** Name a version that's already there only if it has no name yet. */
      readonly keepName?: boolean;
    },
  ): Promise<SavedVersion> {
    // Read everything first, without awaiting, so the snapshot is one consistent revision.
    const revn = this.#revn;
    const previous = Number(this.#meta("snapshot_revn") ?? 0);
    const existing = await this.env.DB.prepare(
      "SELECT id FROM versions WHERE file_id = ? AND revn = ?",
    )
      .bind(fileId, revn)
      .first<{ id: string }>();
    if (existing) {
      if (options.name !== undefined) {
        await this.env.DB.prepare(
          options.keepName
            ? "UPDATE versions SET name = ?, description = ?, created_by = COALESCE(created_by, ?) WHERE id = ? AND name IS NULL"
            : "UPDATE versions SET name = ?, description = ?, created_by = COALESCE(created_by, ?) WHERE id = ?",
        )
          .bind(options.name, options.description ?? null, options.by ?? null, existing.id)
          .run();
      }
      return { id: existing.id, revn };
    }

    if (revn !== this.#revn) return this.#saveVersion(fileId, options);
    const nodes: NodeRecord[] = [];
    for (const page of this.#store.pages(SNAPSHOT_CHUNK_SIZE)) nodes.push(...page);
    const rows = this.#sql
      .exec<{ ops: string; user_id: string; at: number }>(
        "SELECT ops, user_id, at FROM log WHERE revn > ? AND revn <= ? AND client_id != 'system' ORDER BY revn",
        previous,
        revn,
      )
      .toArray();
    const summary = summarizeEdits(rows.map((row) => JSON.parse(row.ops) as Op[]));
    const authors = [...new Set(rows.map((row) => row.user_id))].filter(
      (id) => !id.startsWith("guest:"),
    );
    const now = Date.now();
    const size = await writeSnapshot(this.env.FILES, fileId, revn, now, nodes);
    const id = newId();
    await this.env.DB.prepare(
      `INSERT INTO versions (id, file_id, revn, reason, name, description, restored_id, created_by, created_at, authors, summary, started_at, size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (file_id, revn) DO UPDATE SET
         name = COALESCE(excluded.name, versions.name),
         description = COALESCE(excluded.description, versions.description)`,
    )
      .bind(
        id,
        fileId,
        revn,
        options.reason,
        options.name ?? null,
        options.description ?? null,
        options.restoredId ?? null,
        options.by ?? null,
        now,
        JSON.stringify(authors),
        JSON.stringify(summary),
        rows[0]?.at ?? null,
        size,
      )
      .run();
    if (revn > Number(this.#meta("snapshot_revn") ?? 0)) {
      this.#setMeta("snapshot_revn", String(revn));
      this.#setMeta("snapshot_at", String(now));
    }
    // Another save of the same revision may have won the race; return the row that exists.
    const saved = await this.env.DB.prepare(
      "SELECT id FROM versions WHERE file_id = ? AND revn = ?",
    )
      .bind(fileId, revn)
      .first<{ id: string }>();
    return { id: saved?.id ?? id, revn };
  }

  /**
   * Once a day: deletes unnamed versions past retention, and gives snapshots
   * saved before versions existed a row, so they show in history.
   */
  async #sweepVersions(fileId: string): Promise<void> {
    const last = Number(this.#meta("swept_at") ?? 0);
    if (Date.now() - last < SWEEP_INTERVAL_MS) return;
    this.#setMeta("swept_at", String(Date.now()));

    if (this.#meta("versions_indexed") !== "1") {
      const listed = await this.env.FILES.list({ prefix: `files/${fileId}/snapshots/` });
      for (const object of listed.objects) {
        const revn = Number(object.key.match(/(\d+)\.json\.gz$/)?.[1]);
        if (!Number.isSafeInteger(revn)) continue;
        await this.env.DB.prepare(
          `INSERT INTO versions (id, file_id, revn, reason, created_at, size)
           VALUES (?, ?, ?, 'auto', ?, ?) ON CONFLICT (file_id, revn) DO NOTHING`,
        )
          .bind(newId(), fileId, revn, object.uploaded.getTime(), object.size)
          .run();
      }
      this.#setMeta("versions_indexed", "1");
    }

    const cutoff = Date.now() - AUTOSAVE_RETENTION_MS;
    const { results } = await this.env.DB.prepare(
      // A version a library publish points at stays, even un-named: files copy from it (decision 0010).
      `SELECT id, revn FROM versions WHERE file_id = ? AND name IS NULL AND created_at < ?
         AND id NOT IN (SELECT version_id FROM library_publishes WHERE file_id = ?)`,
    )
      .bind(fileId, cutoff, fileId)
      .all<{ id: string; revn: number }>();
    if (results.length === 0) return;
    // Keep the newest snapshot even when it's old: it is where an idle file's history starts.
    const newest = await this.env.DB.prepare(
      "SELECT MAX(revn) AS revn FROM versions WHERE file_id = ?",
    )
      .bind(fileId)
      .first<{ revn: number }>();
    const expired = results.filter((v) => v.revn !== newest?.revn);
    if (expired.length === 0) return;
    await this.env.FILES.delete(expired.map((v) => snapshotKey(fileId, v.revn)));
    await this.env.DB.batch(
      expired.map((v) => this.env.DB.prepare("DELETE FROM versions WHERE id = ?").bind(v.id)),
    );
  }

  /** Records which file this room is, for a call that names it before anyone has opened it. */
  #adopt(fileId: string): void {
    const known = this.#meta("file_id");
    if (known === null) this.#setMeta("file_id", fileId);
    else if (known !== fileId) throw new ModelError("not_found", "This room holds another file.");
  }

  #requireFileId(): string {
    const fileId = this.#meta("file_id");
    if (!fileId) throw new ModelError("not_found", "This file has never been opened.");
    return fileId;
  }

  #meta(k: string): string | null {
    return (
      this.#sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null
    );
  }

  #setMeta(k: string, v: string): void {
    this.#sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
      k,
      v,
    );
  }

  #attachments(): Array<{ ws: WebSocket; me: Attachment }> {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, me: ws.deserializeAttachment() as Attachment }));
  }

  #nextColor(): number {
    const used = new Set(this.#attachments().map(({ me }) => me.color));
    for (let color = 1; color <= 8; color++) if (!used.has(color)) return color;
    return (this.#attachments().length % 8) + 1;
  }

  #peer(me: Attachment): Peer {
    return {
      sessionId: me.sessionId,
      userId: me.userId,
      name: me.name,
      color: me.color,
      kind: me.kind,
      presence: this.#presence.get(me.sessionId) ?? null,
    };
  }

  #peers(): Peer[] {
    return this.#attachments()
      .filter(({ me }) => me.clientId !== null && !me.guest)
      .map(({ me }) => this.#peer(me));
  }

  #left(ws: WebSocket): void {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (!me || me.guest) return;
    this.#presence.delete(me.sessionId);
    this.#broadcast({ t: "peer-left", sessionId: me.sessionId }, ws);
    // Their last socket here: the room no longer needs to hear about their access.
    const stillHere = this.ctx
      .getWebSockets(me.userId)
      .some((other) => other !== ws && other.readyState === WebSocket.OPEN);
    const fileId = this.#meta("file_id");
    if (!stillHere && fileId)
      void this.#forgetConnection(fileId, me.userId, Date.now()).catch((error: unknown) =>
        console.warn("couldn't forget a connection", error),
      );
  }

  async #recordConnection(fileId: string, userId: string): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO room_connections (file_id, user_id, connected_at) VALUES (?, ?, ?)
         ON CONFLICT (file_id, user_id) DO UPDATE SET connected_at = excluded.connected_at`,
    )
      .bind(fileId, userId, Date.now())
      .run();
  }

  /**
   * Forgets a connection made before `before`: a socket that opened since
   * (a reload, a second tab) wrote a later time, and keeps its row however
   * the two writes land.
   */
  async #forgetConnection(fileId: string, userId: string, before: number): Promise<void> {
    await this.env.DB.prepare(
      "DELETE FROM room_connections WHERE file_id = ? AND user_id = ? AND connected_at <= ?",
    )
      .bind(fileId, userId, before)
      .run();
  }

  #send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The socket closed; webSocketClose will clean up.
    }
  }

  #broadcast(message: ServerMessage, except?: WebSocket): number {
    const data = JSON.stringify(message);
    // Guests get document changes only, without who made them.
    const guestData =
      message.t === "txn"
        ? JSON.stringify({ ...message, author: ANONYMOUS })
        : message.t === "resync"
          ? data
          : null;
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const me = ws.deserializeAttachment() as Attachment | null;
      if (!me?.clientId) continue;
      if (me.guest && guestData === null) continue;
      try {
        ws.send(me.guest ? (guestData as string) : data);
        sent++;
      } catch {
        // Ignore sockets that are closing.
      }
    }
    return sent;
  }
}

export type MergeResult =
  | {
      readonly ok: true;
      /** The revision the merge landed at (the current one when it changed nothing). */
      readonly revn: number;
      /** The version saved just before: restoring it undoes the merge. */
      readonly restorePoint: string;
      /** How many changes it took. */
      readonly changes: number;
    }
  /** Main changed since review: conflicts nobody decided. */
  | { readonly ok: false; readonly reason: "undecided"; readonly undecided: number }
  | { readonly ok: false; readonly reason: "invalid"; readonly message: string };

export type ImportResult =
  | { readonly ok: true; readonly revn: number; readonly nodes: number }
  | { readonly ok: false; readonly reason: "not-empty" }
  | { readonly ok: false; readonly reason: "invalid"; readonly message: string };

/** About 1 MB of JSON per commit: one log row each, far below SQLite's 2 MB row cap. */
const IMPORT_CHUNK_CHARS = 1_000_000;

/** Create ops for `nodes`, each parent before its children (siblings keep their order). */
function creationOrder(nodes: readonly NodeRecord[]): Op[] {
  const byParent = new Map<string, NodeRecord[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parent) ?? [];
    list.push(node);
    byParent.set(node.parent, list);
  }
  const ops: Op[] = [];
  const queue = [...(byParent.get(ROOT_ID) ?? [])];
  for (let node = queue.shift(); node; node = queue.shift()) {
    ops.push({
      op: "create",
      id: node.id,
      type: node.type,
      parent: node.parent,
      key: node.key,
      props: node.props,
    });
    queue.push(...(byParent.get(node.id) ?? []));
  }
  // Nodes whose parent isn't in the set go last, where validation rejects them by name.
  if (ops.length < nodes.length) {
    const placed = new Set(ops.map((o) => o.id));
    for (const node of nodes)
      if (!placed.has(node.id))
        ops.push({
          op: "create",
          id: node.id,
          type: node.type,
          parent: node.parent,
          key: node.key,
          props: node.props,
        });
  }
  return ops;
}

/** `ops` in runs of at most about `limit` characters of JSON (and a transaction's worth of ops). */
function chunked(ops: readonly Op[], limit: number): Op[][] {
  const out: Op[][] = [];
  let current: Op[] = [];
  let size = 0;
  for (const op of ops) {
    const length = JSON.stringify(op).length;
    if (
      current.length > 0 &&
      (size + length > limit || current.length >= MAX_OPS_PER_TRANSACTION)
    ) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(op);
    size += length;
  }
  if (current.length > 0) out.push(current);
  return out;
}
