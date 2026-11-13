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
  ClientMessage,
  type CommentEvent,
  keyBetween,
  MAX_CLIENT_MESSAGE_BYTES,
  ModelError,
  type NodeRecord,
  newId,
  type Op,
  type Peer,
  type Presence,
  ROOT_ID,
  type ServerMessage,
  SNAPSHOT_CHUNK_SIZE,
} from "@drawpane/model";
import type { Env, Role } from "../env";
import { verifyPayload } from "../lib/crypto";
import { NODE_SCHEMA, SqlNodeStore } from "./sql-store";

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
`;

/** Transactions kept for reconnect catch-up. Older history lives in R2 snapshots. */
const LOG_RETENTION = 10_000;
const ALARM_DELAY_MS = 30_000;
const SNAPSHOT_INTERVAL_MS = 60 * 60_000;

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
        return this.#hello(ws, me, message.clientId, message.revn);
      case "txn":
        return this.#transaction(ws, me, message.seq, message.ops as Op[]);
      case "presence":
        // Guests are invisible: they have no cursor or selection to show.
        if (me.guest) return;
        this.#presence.set(me.sessionId, message.presence);
        this.#broadcast({ t: "presence", sessionId: me.sessionId, presence: message.presence }, ws);
        return;
      case "ping":
        this.#send(ws, { t: "pong" });
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
    if (fileId && this.#meta("touched") === "1") {
      await this.env.DB.prepare("UPDATE files SET updated_at = ? WHERE id = ?")
        .bind(Date.now(), fileId)
        .run();
      this.#setMeta("touched", "0");
    }
    const lastSnapshotAt = Number(this.#meta("snapshot_at") ?? 0);
    const lastSnapshotRevn = Number(this.#meta("snapshot_revn") ?? 0);
    if (
      fileId &&
      this.#revn > lastSnapshotRevn &&
      Date.now() - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS
    ) {
      await this.#snapshot(fileId);
    }
    this.#sql.exec("DELETE FROM log WHERE revn <= ?", this.#revn - LOG_RETENTION);
    // Keep the snapshot cadence going while there are unsnapshotted edits.
    if (this.#revn > Number(this.#meta("snapshot_revn") ?? 0)) {
      const due = Math.max(lastSnapshotAt + SNAPSHOT_INTERVAL_MS, Date.now() + ALARM_DELAY_MS);
      await this.ctx.storage.setAlarm(due);
    }
  }

  /** Deletes everything this room stores. Called when a file is deleted for good. */
  async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(4404, "File deleted");
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
      (revn === this.#revn || (oldest !== null && oldest <= revn + 1));

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

    let revn: number;
    try {
      revn = this.ctx.storage.transactionSync(() => {
        applyTransaction(this.#store, ops, { rollback: false });
        const next = this.#revn + 1;
        const now = Date.now();
        this.#sql.exec(
          "INSERT INTO log (revn, client_id, seq, user_id, session_id, ops, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          next,
          clientId,
          seq,
          me.userId,
          me.sessionId,
          JSON.stringify(ops),
          now,
        );
        this.#sql.exec(
          `INSERT INTO clients (client_id, last_seq, last_revn, at) VALUES (?, ?, ?, ?)
           ON CONFLICT (client_id) DO UPDATE SET last_seq = excluded.last_seq, last_revn = excluded.last_revn, at = excluded.at`,
          clientId,
          seq,
          next,
          now,
        );
        this.#setMeta("revn", String(next));
        this.#setMeta("touched", "1");
        return next;
      });
    } catch (error) {
      this.#store.clearCache();
      if (error instanceof ModelError) {
        this.#reject(ws, seq, ops, error.code, error.message);
        return;
      }
      console.error("transaction failed", error);
      this.#reject(ws, seq, ops, "internal", "The room couldn't save that change. Try again.");
      return;
    }
    this.#store.clearCache();
    this.#revn = revn;
    this.#send(ws, { t: "ack", seq, revn });
    this.#broadcast(
      { t: "txn", revn, ops, author: { userId: me.userId, sessionId: me.sessionId } },
      ws,
    );
    void this.#scheduleAlarm();
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
    const ops: Op[] = [
      {
        op: "create",
        id: newId(),
        type: "page",
        parent: ROOT_ID,
        key: keyBetween(null, null),
        props: { name: "Page 1" },
      },
    ];
    this.ctx.storage.transactionSync(() => {
      applyTransaction(this.#store, ops, { rollback: false });
      this.#revn += 1;
      this.#sql.exec(
        "INSERT INTO log (revn, client_id, seq, user_id, session_id, ops, at) VALUES (?, 'system', 0, 'system', 'system', ?, ?)",
        this.#revn,
        JSON.stringify(ops),
        Date.now(),
      );
      this.#setMeta("revn", String(this.#revn));
    });
    this.#store.clearCache();
  }

  async #scheduleAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_DELAY_MS);
    }
  }

  async #snapshot(fileId: string): Promise<void> {
    const parts: string[] = [];
    for (const nodes of this.#store.pages(SNAPSHOT_CHUNK_SIZE)) {
      for (const node of nodes) parts.push(JSON.stringify(node));
    }
    const body = `{"format":"drawpane.snapshot","version":1,"fileId":${JSON.stringify(fileId)},"revn":${this.#revn},"at":${Date.now()},"nodes":[${parts.join(",")}]}`;
    const gz = new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip")));
    await this.env.FILES.put(
      `files/${fileId}/snapshots/${String(this.#revn).padStart(12, "0")}.json.gz`,
      await gz.arrayBuffer(),
      {
        httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
        customMetadata: { revn: String(this.#revn) },
      },
    );
    this.#setMeta("snapshot_revn", String(this.#revn));
    this.#setMeta("snapshot_at", String(Date.now()));
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
      message.t === "txn" ? JSON.stringify({ ...message, author: ANONYMOUS }) : null;
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
