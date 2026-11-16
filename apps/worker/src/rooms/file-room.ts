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
import { findTool, type HeadlessRenderer, ToolFailure, type ToolServices } from "@drawpane/editor";
import {
  applyTransaction,
  ClientMessage,
  type CommentEvent,
  type CopiesFormat,
  heldNodeIds,
  IMPORT_TTL_MS,
  keyBetween,
  LATENCY_BUCKETS_MS,
  type LibraryAsset,
  libraryAssets,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_LIBRARY_ASSETS,
  ModelError,
  type NodeRecord,
  newId,
  type Op,
  type Peer,
  type Presence,
  type Props,
  RELOAD_CLOSE_CODE,
  type Resolution,
  type RestoredVersion,
  ROOT_ID,
  renameHeldIds,
  type ServerMessage,
  SNAPSHOT_CHUNK_SIZE,
  snapshotCopies,
  summarizeEdits,
  type VersionReason,
} from "@drawpane/model";
import { fileFontLoader } from "../agent/harfbuzz";
import { agentMeasurer } from "../agent/measurer";
import { headlessRenderer } from "../agent/render";
import { FILE_ACCESS, FILE_ROLE } from "../api/access";
import type { Env, Role } from "../env";
import { verifyPayload } from "../lib/crypto";
import { answerDocument, type DocumentRequest, SqlFileDoc } from "../mcp/document";
import { AgentEngine, type EngineRun } from "./agent-engine";
import { CALL_SCHEMA, CallLedger, changedIds, overlap, type StepCall } from "./call-ledger";
import {
  applyConversion,
  CONVERT_STEP_WORK,
  COPIES_LOG_SCHEMA,
  compactTable,
  convertStep,
  createConvertTables,
  dropConvertTables,
  hasConvertTables,
  hasInstances,
  LIVE_CONVERSION,
  markDirty,
  NotAllConverted,
  presentedCount,
  readyToApply,
  strayInstance,
} from "./convert";
import {
  beginStaging,
  checkStaged,
  dropStaging,
  fillFromStaged,
  IMPORT_LIMITS,
  IMPORT_TABLE,
  type ImportLimits,
  NO_COMPACT_COPIES,
  stageNodes,
} from "./import-stage";
import { MainRemoval, RemovalNeedsLooks } from "./main-removal";
import {
  copyNodes,
  countRows,
  dropTable,
  type RoomSql,
  TableReader,
  tablePages,
  tempTable,
  tempTableAge,
  tempTables,
} from "./node-tables";
import { OpChunks } from "./op-chunks";
import {
  dropPinMap,
  hasPinMap,
  keepPinMap,
  loadPinMap,
  PIN_MAP_KEEP_MS,
  pinMapKey,
  pinRenamedInR2,
  pinsRenamed,
  savePinMap,
} from "./pin-map";
import { PresentedReader } from "./presented";
import { loadSnapshot, restoreFromTable, SnapshotError } from "./restore";
import {
  AUTOSAVE_RETENTION_MS,
  branchBaseKey,
  nextBranchBaseKey,
  openSnapshot,
  openSnapshotStream,
  type SnapshotSource,
  snapshotKey,
  snapshotNodes,
  snapshotStream,
  writeSnapshot,
} from "./snapshots";
import { NODE_SCHEMA, SqlNodeStore } from "./sql-store";
import { applyThreeWay, planThreeWay, type ThreeWayTables } from "./three-way";

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

/**
 * Clients ping every 25 s (connection.ts); the runtime answers for the room
 * (setWebSocketAutoResponse), so a ping doesn't wake it, and notes when.
 */
const PING = JSON.stringify({ t: "ping" });
const PONG = JSON.stringify({ t: "pong" });
/**
 * A session that hasn't pinged for this long is gone (a laptop asleep, a
 * network dropped without a goodbye): without it, its selection and cursor
 * would stay on everyone's canvas. A hidden tab's timers can slow to once a
 * minute, so this leaves room for a couple of those.
 */
export const STALE_MS = 150_000;
/** How often, at most, a room looks for sessions that have gone quiet. */
const PRUNE_EVERY_MS = 15_000;

/** How long one step of converting a file to compact copies runs before the room serves others. */
/** How often, at most, a client from before compact copies is sent the file again as it changes. */
const VIEW_REFRESH_MS = 30_000;

/** What a client from before compact copies is told when it tries to edit a file stored compact. */
const RELOAD_TO_EDIT = "Drawpane was updated. Reload the page to edit this file.";

/** Props only copies, instances and mains have: an edit setting them is about copies. */
const COPY_PROPS: ReadonlySet<string> = new Set([
  "instanceOf",
  "mirrors",
  "overrides",
  "unset",
  "isComponent",
  "isComponentSet",
]);

/** Applying a conversion refused this many times in a row (something stays materialized): it stops. */
const CONVERT_REFUSALS = 5;
/** The version saved before a file's copies are converted (decision 0029): how to undo it. */
export const BEFORE_COMPACT = "Before compact copies";

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
  /** When the socket was accepted. Missing on sockets from before rooms pruned quiet ones. */
  joinedAt?: number;
  /**
   * How the file stored copies when this client loaded it (decision 0029): its
   * changes are in that form. Missing on sockets from before compact copies:
   * materialized.
   */
  copies?: CopiesFormat;
  /**
   * The forms of copies the client reads, from its hello (a protocol 1
   * client reads materialized only). Missing on sockets welcomed before it
   * was recorded: see #reads.
   */
  reads?: CopiesFormat[];
  /**
   * A client from before compact copies (protocol 1) in a file stored
   * compact: it's sent the file as presented, every copy layer built, to
   * view, and its edits are refused, telling it to reload (decision 0029).
   */
  viewing?: boolean;
  /** When a viewing client was last sent the file. */
  servedAt?: number;
  /** Whether the file changed since a viewing client was last sent it. */
  stale?: boolean;
}

/** What an edit to a file stored compact is checked for, once it has applied (see #checkCompact). */
interface CompactCheck {
  /** Mains it removes, and what their instances show before and after (main-removal.ts). */
  readonly removal: MainRemoval;
  /** Nodes that may now be an instance of a live main storing layers. */
  readonly candidates: Set<string>;
}

/** What a storage transaction that removes a main looks at first, when it's run again. */
interface LookFirst {
  readonly mains: ReadonlySet<string>;
  readonly deleted: ReadonlySet<string>;
}

/**
 * Runs `attempt` (one storage transaction) again while the main-removal
 * check asks to look at instances first (it rolled back), at most three
 * times: the second time skipping what the first deleted, the third
 * looking at everything.
 */
function withLooks<R>(first: LookFirst, attempt: (look: LookFirst) => R): R {
  let look = first;
  for (let tries = 0; ; tries++) {
    try {
      return attempt(look);
    } catch (error) {
      if (!(error instanceof RemovalNeedsLooks) || tries >= 2) {
        if (error instanceof RemovalNeedsLooks)
          throw new ModelError("conflict", "The file changed while that was saved. Try again.");
        throw error;
      }
      look = {
        mains: new Set([...look.mains, ...error.mains]),
        deleted: tries === 0 && error.deleted ? error.deleted : new Set(),
      };
    }
  }
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
  -- Objects in R2 this room no longer points at (a branch's old bases), deleted by the
  -- alarm once nothing that read the pointer before can still be reading them.
  CREATE TABLE IF NOT EXISTS stale_objects (key TEXT PRIMARY KEY, at INTEGER NOT NULL) STRICT;
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
/** A transient table older than this was let go of by whatever read it. */
const STALE_TABLE_MS = 60 * 60_000;
/** A copy of a file this server already holds is taken whatever its size. */
const UNLIMITED: ImportLimits = {
  nodes: Number.POSITIVE_INFINITY,
  bytes: Number.POSITIVE_INFINITY,
};
/**
 * The most nodes a file may have for agents to work on it: the headless
 * editor (decision 0021) holds the whole file in memory: its document alone
 * measured 34 MB at 50,000 layers (about 700 bytes each), and building it
 * reads them all at once first.
 */
export const AGENT_MAX_NODES = 50_000;

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

/** An agent session writing to this file (decision 0021), checked by the Worker. */
export interface AgentSessionRef {
  readonly id: string;
  /** "Claude, for Ana". */
  readonly name: string;
  /** This room's file: the session's target. */
  readonly fileId: string;
}

/** What an agent call answers. A failure is worded for the model and committed nothing. */
export type AgentCallResult =
  | {
      readonly ok: true;
      /** The revision it committed; null when it changed nothing. */
      readonly revn: number | null;
      readonly result: unknown;
      /** A picture the tool answered with (export_image), for the model to see. */
      readonly image?: { readonly mimeType: string; readonly base64: string };
      /** True when the call id was seen before: this is the recorded answer, and nothing ran. */
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly message: string };

/** The largest change one agent call may make, in JSON bytes (one log row, well under SQLite's cap). */
const MAX_AGENT_CHANGE_BYTES = 1 << 20;
/** How often a call runs again because the file changed under it, before giving up. */
const AGENT_ATTEMPTS = 3;
const NO_ENGINE =
  "Agents can't design on this instance yet: it has no text measurer configured. Reading still works.";

export interface SavedVersion {
  readonly id: string;
  readonly revn: number;
}

export type RestoreResult =
  | ({ readonly ok: true } & RestoredChange)
  /** The version's snapshot isn't in R2 (deleted by hand, or a failed write). */
  | { readonly ok: false; readonly reason: "missing" }
  /** Its snapshot doesn't hold together, or can't be applied: nothing changed. */
  | { readonly ok: false; readonly reason: "invalid"; readonly message: string };

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
  /** What one import may bring in all its parts (tests lower it to reach it with a few nodes). */
  importLimits: ImportLimits = IMPORT_LIMITS;
  /** Tests: turns compact copies off (true) or on (false) as `COMPACT_COPIES` would; null reads it. */
  compactCopiesOff: boolean | null = null;
  /**
   * About how much work (rows read and written) a step of converting to
   * compact copies does (tests set 0, one instance a step, to see it resume).
   */
  convertStepWork = CONVERT_STEP_WORK;
  /**
   * Tests: runs where a restore, a merge, an update, a hello or a sweep of
   * comment pins has awaited and is about to go on, to make something
   * happen in between.
   */
  pause: ((at: "restore" | "merge" | "update" | "hello" | "sweep") => Promise<void>) | null = null;
  readonly #sql: SqlStorage;
  readonly #store: SqlNodeStore;
  readonly #room: RoomSql;
  /** When this room last looked for quiet sessions (in memory: after a sleep it looks again). */
  #prunedAt = 0;
  /** Live presence by session. Not persisted: after hibernation, peers resend on their next move. */
  readonly #presence = new Map<string, Presence>();
  #revn = 0;
  readonly #ledger: CallLedger;
  /** The warm headless editor agents' calls run on (decision 0021); made on the first call. */
  #engine: AgentEngine | null = null;
  #rendering: Promise<HeadlessRenderer> | null = null;
  /** The update from main under way, which the next waits for: one at a time. */
  #updating: Promise<unknown> = Promise.resolve();
  /** How this file stores copies (decision 0029); in meta as `copies`. */
  #copies: CopiesFormat = "materialized";
  /** Whether a conversion to compact copies is under way (its tables are here, not applied). */
  #converting = false;
  /** A conversion was applied: everyone is told to load the file again, once comment pins moved. */
  #announce = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#store = new SqlNodeStore(this.#sql);
    this.#ledger = new CallLedger(this.#sql);
    this.#room = { sql: this.#sql, transact: (fn) => ctx.storage.transactionSync(fn) };
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    ctx.blockConcurrencyWhile(async () => {
      this.#sql.exec(NODE_SCHEMA + LOG_SCHEMA + CALL_SCHEMA + COPIES_LOG_SCHEMA);
      // Nothing can be reading a transient table yet: any left are from before a restart.
      for (const table of tempTables(this.#sql)) dropTable(this.#sql, table);
      this.#revn = Number(this.#meta("revn") ?? 0);
      const hasPage = this.#store
        .childIds(ROOT_ID)
        .some((id) => this.#store.get(id)?.type === "page");
      const copies = this.#meta("copies");
      if (!hasPage) {
        // A new file: stored compact, unless conversion is turned off (COMPACT_COPIES=off).
        if (copies === null)
          this.#setMeta("copies", this.#compactOn() ? "compact" : "materialized");
        this.#seed();
      } else if (copies === null) this.#setMeta("copies", "materialized");
      this.#copies = this.#meta("copies") === "compact" ? "compact" : "materialized";
      this.#converting =
        this.#copies === "materialized" && hasConvertTables(this.#sql, LIVE_CONVERSION);
      // A file from before compact copies converts when its room loads (decision 0029):
      // in steps, by the alarm, the file usable meanwhile.
      if (this.#conversionDue()) await this.#scheduleAlarm(1_000);
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
      joinedAt: Date.now(),
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
    // Someone's here and active: a good moment to let go of anyone who has gone quiet.
    const now = Date.now();
    if (now - this.#prunedAt >= PRUNE_EVERY_MS) {
      this.#prunedAt = now;
      // Not the sender, though: whatever its pings did, it's talking now.
      this.pruneQuiet(now, ws);
    }
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
    const me = ws.deserializeAttachment() as Attachment | null;
    // Let go (gone quiet, or the file deleted) while this was on its way: nothing more to do.
    if (!me) return;
    switch (message.t) {
      case "hello": {
        // How the client can read copies: one from before compact copies reads them
        // materialized. Which form the file has is decided when it's welcomed (see #hello).
        const reads: readonly CopiesFormat[] =
          message.protocol === 1 ? ["materialized"] : (message.copies ?? ["materialized"]);
        return this.#checkedHello(ws, me, message.clientId, message.revn, reads, message.protocol);
      }
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

  /**
   * Closes sockets that haven't pinged for STALE_MS, and tells everyone else
   * they've left. A socket can die without a close (a laptop shut, a network
   * gone), and the runtime may not notice for a long while: until then its
   * person's last selection and cursor stayed on everyone's canvas, looking
   * like an outline from nowhere. Returns how many it closed. Public for tests.
   */
  pruneQuiet(now = Date.now(), except?: WebSocket): number {
    let closed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const me = ws.deserializeAttachment() as Attachment | null;
      // Sockets from before this knew when they joined: left to close on their own.
      if (!me || me.joinedAt === undefined) continue;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      if (now - Math.max(me.joinedAt, pinged) <= STALE_MS) continue;
      this.#left(ws);
      // So #left doesn't run again when the close comes back.
      ws.serializeAttachment(null);
      try {
        ws.close(4001, "Gone quiet");
      } catch {
        // Already closed.
      }
      closed++;
    }
    return closed;
  }

  override async alarm(): Promise<void> {
    this.pruneQuiet();
    const converting = await this.#convertCopies();
    await this.#movePins();
    const viewers = this.#refreshViewers();
    if (this.#announce) {
      // Everyone loads the file again, in its new form (comment pins moved first, when they could).
      this.#announce = false;
      this.#broadcast({ t: "resync" });
    }
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
    this.#ledger.sweep();
    this.#sweepStaging();
    await this.#sweepStaleObjects();
    // Keep going while there are edits no version holds yet, an import waits for its commit,
    // or something left behind waits to be cleared away.
    const next = [
      converting,
      viewers,
      this.#pinsDue(),
      this.#autosaveDue(),
      this.#importExpiry(),
      this.#staleTablesDue(),
      this.#staleObjectsDue(),
    ].filter((n) => n !== null);
    if (converting !== null) {
      // A conversion under way comes back at once: the room serves others between steps.
      await this.ctx.storage.setAlarm(Date.now() + 100);
    } else if (next.length > 0) {
      await this.ctx.storage.setAlarm(Math.max(Math.min(...next), Date.now() + ALARM_DELAY_MS));
    }
  }

  // -------------------------------------------------------------------------
  // Compact copies (decision 0029, phase 4b)

  /** Whether files convert to compact copies, and new ones start so: `COMPACT_COPIES=off` stops both. */
  #compactOn(): boolean {
    if (this.compactCopiesOff !== null) return !this.compactCopiesOff;
    return (this.env.COMPACT_COPIES ?? "").toLowerCase() !== "off";
  }

  /**
   * Tests: as if this room held a file from before compact copies, stored
   * materialized (these nodes), which converts when the alarm next runs.
   */
  async storeMaterialized(nodes: readonly NodeRecord[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec("DELETE FROM nodes");
      for (const node of nodes) this.#store.insert(node);
      dropConvertTables(this.#sql, LIVE_CONVERSION);
      for (const k of ["conv_backup", "conv_failed", "conv_refused"])
        this.#sql.exec("DELETE FROM meta WHERE k = ?", k);
      const next = this.#revn + 1;
      this.#setMeta("revn", String(next));
      this.#setMeta("catchup_from", String(next));
      this.#setMeta("copies", "materialized");
      this.#revn = next;
    });
    this.#store.clearCache();
    this.#copies = "materialized";
    this.#converting = false;
    this.#engine?.drop();
    this.#broadcast({ t: "resync" });
    await this.#scheduleAlarm(1_000);
  }

  /** Whether this file is stored materialized and should convert. */
  #conversionDue(): boolean {
    return (
      this.#copies === "materialized" &&
      this.#compactOn() &&
      this.#meta("conv_failed") === null &&
      this.#meta("file_id") !== null
    );
  }

  /** How this file stores copies: for the Worker, tests and the health page. */
  async copiesFormat(): Promise<{
    copies: CopiesFormat;
    converting: boolean;
    failed: string | null;
    backup: string | null;
    detached: Array<{ root: string; why: string }>;
  }> {
    return {
      copies: this.#copies,
      converting: this.#converting,
      failed: this.#meta("conv_failed"),
      backup: this.#meta("conv_backup"),
      detached: this.#sql
        .exec<{ root: string; why: string }>("SELECT root, why FROM copies_log ORDER BY at, root")
        .toArray(),
    };
  }

  /**
   * One step of converting the file to compact copies; when it's the last,
   * the conversion is applied. Returns when to come back (now, when there's
   * more), or null. A version is saved first ("Before compact copies"),
   * which restoring undoes it from. A step that fails stops the conversion
   * for good (the file stays as it was, materialized) and says why.
   */
  async #convertCopies(): Promise<number | null> {
    if (!this.#conversionDue()) return null;
    const fileId = this.#meta("file_id") as string;
    try {
      if (!this.#converting) {
        // Nothing stored differently in a file without instances: it only changes format.
        if (!hasInstances(this.#sql)) {
          this.#finishConversion(fileId, false);
          return null;
        }
        if (this.#meta("conv_backup") === null) {
          const backup = await this.#saveVersion(fileId, {
            reason: "named",
            name: BEFORE_COMPACT,
            description:
              "Saved before this file's component copies were stored compactly. Restore it to undo that.",
            keepName: true,
          });
          // The save awaited: the file may have changed format meanwhile (a restore).
          if (!this.#conversionDue()) return null;
          this.#setMeta("conv_backup", backup.id);
        }
        createConvertTables(this.#sql, LIVE_CONVERSION);
        this.#converting = true;
      }
      // From the step to applying it nothing awaits, so no edit lands between them; applying
      // lists the file's instances once more anyway, and refuses while any is left to convert.
      const step = convertStep(this.#room, "nodes", LIVE_CONVERSION, this.convertStepWork);
      if (!step.done) return Date.now();
      return this.#finishConversion(fileId, true) ? null : Date.now();
    } catch (error) {
      console.error(
        `compact copies: converting file ${fileId} failed; it stays materialized`,
        error,
      );
      this.#setMeta("conv_failed", error instanceof Error ? error.message : String(error));
      dropConvertTables(this.#sql, LIVE_CONVERSION);
      this.#converting = false;
      return null;
    }
  }

  /**
   * Applies the conversion in one storage transaction: from here the file is
   * stored compact. Clients behind it load the file again (it's one revision,
   * not logged as operations, like an import); agent sessions' undo stops at
   * it; comment pins on copies follow their layers' new ids (`#remapComments`).
   */
  #finishConversion(fileId: string, tables: boolean): boolean {
    const now = Date.now();
    let result: { next: number; applied: ReturnType<typeof applyConversion> | null } | null;
    try {
      result = this.#applyConversion(fileId, tables, now);
    } catch (error) {
      if (!(error instanceof NotAllConverted)) throw error;
      // Rolled back: an instance would stay materialized. The next steps convert it; should it
      // keep happening, the conversion stops (the file stays materialized and working).
      const refused = Number(this.#meta("conv_refused") ?? 0) + 1;
      this.#setMeta("conv_refused", String(refused));
      console.warn(`compact copies: file ${fileId} not applied yet: ${error.message}`);
      if (refused >= CONVERT_REFUSALS) throw error;
      return false;
    }
    if (!result) return false;
    this.#revn = result.next;
    this.#copies = "compact";
    this.#viewersAfterChange();
    this.#converting = false;
    this.#store.clearCache();
    this.#engine?.drop();
    this.#announce = true;
    const applied = result.applied;
    console.log(
      `compact copies: file ${fileId} converted at revision ${result.next}` +
        (applied
          ? `: ${applied.removed} copy layers no longer stored, ${applied.records} override records, ${applied.detached.length} instances left detached`
          : " (no instances)"),
    );
    return true;
  }

  /** The storage transaction that applies a conversion; null when an instance is left to convert. */
  #applyConversion(
    fileId: string,
    tables: boolean,
    now: number,
  ): { next: number; applied: ReturnType<typeof applyConversion> | null } | null {
    return this.ctx.storage.transactionSync(() => {
      // Listed once more: an instance made since the last step converts first.
      if (tables && !readyToApply(this.#sql, "nodes", LIVE_CONVERSION)) return null;
      const applied = tables ? applyConversion(this.#sql, "nodes", LIVE_CONVERSION) : null;
      for (const { root, why } of applied?.detached ?? [])
        this.#sql.exec(
          "INSERT OR REPLACE INTO copies_log (root, why, at) VALUES (?, ?, ?)",
          root,
          why,
          now,
        );
      const next = this.#revn + 1;
      this.#setMeta("revn", String(next));
      this.#setMeta("catchup_from", String(next));
      this.#setMeta("copies", "compact");
      this.#setMeta("touched", "1");
      this.#setMeta("touched_at", String(now));
      // An agent's undo is in materialized terms: it doesn't reach back past this.
      this.#sql.exec("UPDATE agent_calls SET state = 'dropped' WHERE state IN ('done', 'undone')");
      this.#sql.exec("DELETE FROM meta WHERE k = 'conv_refused'");
      if (tables) {
        // The map stays a while, for comment pins (see pin-map.ts); the rest goes.
        keepPinMap(this.#sql, LIVE_CONVERSION.map);
        dropConvertTables(this.#sql, LIVE_CONVERSION);
        this.#setMeta("pins_key", pinMapKey(fileId, next));
        this.#setMeta("pins_saved", "0");
        this.#setMeta("pins_until", String(now + PIN_MAP_KEEP_MS));
      }
      // Any sweep under way was for the form before: it stops, and pins follow this one.
      this.#formChanged("compact", tables);
      return { next, applied };
    });
  }

  /**
   * Comment pins (D1 `comment_threads.node_id`) on copy layers follow the
   * file's change of form (pin-map.ts): the map is kept in R2, pins are
   * moved when it's applied or undone, and once more before the room lets
   * the map go. Each part retried by the alarm until it's done.
   */
  async #movePins(): Promise<void> {
    const fileId = this.#meta("file_id");
    if (!fileId) return;
    try {
      const load = this.#meta("pins_load");
      if (load !== null) {
        // A restore put the old form back, and the room no longer had the map: from R2.
        const gen = this.#pinsGen();
        await loadPinMap(this.env.FILES, load, this.#sql);
        // The form changed again while that loaded: what that change asked for stands.
        if (this.#pinsGen() !== gen) return;
        this.#sql.exec("DELETE FROM meta WHERE k = 'pins_load'");
        this.#setMeta("pins_until", String(Date.now() + PIN_MAP_KEEP_MS));
        this.#setMeta("pins_sweep", pinSweepFlag(this.#copies, gen));
      }
      if (!hasPinMap(this.#sql)) return;
      const key = this.#meta("pins_key");
      if (key !== null && this.#meta("pins_saved") === "0") {
        await savePinMap(this.env.FILES, key, this.#sql);
        this.#setMeta("pins_saved", "1");
      }
      const flag = this.#meta("pins_sweep");
      if (flag !== null) {
        const sweep = parsePinSweep(flag, this.#copies, this.#pinsGen());
        // Cleared only when it finished, and only the flag it was for: a change of form since
        // set another, which the next alarm sweeps (the latest form wins).
        if ((await this.#sweepPins(fileId, sweep)) && this.#meta("pins_sweep") === flag)
          this.#sql.exec("DELETE FROM meta WHERE k = 'pins_sweep'");
      }
      const until = Number(this.#meta("pins_until") ?? 0);
      if (
        Date.now() >= until &&
        this.#meta("pins_saved") !== "0" &&
        this.#meta("pins_sweep") === null
      ) {
        // Once more, for pins written since, then the map goes (R2 keeps it), unless the form
        // changed meanwhile: then that change's sweep comes first.
        const sweep = { to: this.#copies, gen: this.#pinsGen() };
        if ((await this.#sweepPins(fileId, sweep)) && this.#meta("pins_sweep") === null) {
          dropPinMap(this.#sql);
          this.#sql.exec("DELETE FROM meta WHERE k = 'pins_until'");
        }
      }
    } catch (error) {
      console.warn(`compact copies: comment pins of file ${fileId} not moved yet`, error);
    }
  }

  /** How many times the file changed form (conversion applied, a materialized restore). */
  #pinsGen(): number {
    return Number(this.#meta("pins_gen") ?? 0);
  }

  /**
   * The file changed how it stores copies (to `to`), in the storage
   * transaction that changed it: a sweep of comment pins under way, for the
   * form before, stops before its next write; pins are swept toward `to`
   * when `sweep` (the room has the map), else when the map is loaded.
   */
  #formChanged(to: CopiesFormat, sweep: boolean): void {
    const gen = this.#pinsGen() + 1;
    this.#setMeta("pins_gen", String(gen));
    if (sweep) this.#setMeta("pins_sweep", pinSweepFlag(to, gen));
    else this.#sql.exec("DELETE FROM meta WHERE k = 'pins_sweep'");
    // A map waiting to load was the old conversion's: one applied now brings its own.
    if (to === "compact") this.#sql.exec("DELETE FROM meta WHERE k = 'pins_load'");
  }

  /**
   * Moves every pin the map renames toward the form `sweep.to`. Before each
   * write it checks the file still stores that form, at the same change
   * (`gen`): a restore or a conversion that landed while it awaited D1
   * stops it (false), and the sweep that change asked for puts pins where
   * they belong. True when it finished. Each write moves a pin only from the
   * id it read, so a sweep that runs again changes nothing more.
   */
  async #sweepPins(fileId: string, sweep: PinSweep): Promise<boolean> {
    const current = () => this.#copies === sweep.to && this.#pinsGen() === sweep.gen;
    if (!current()) return false;
    const { results } = await this.env.DB.prepare(
      "SELECT id, node_id FROM comment_threads WHERE file_id = ? AND node_id IS NOT NULL",
    )
      .bind(fileId)
      .all<{ id: string; node_id: string }>();
    await this.pause?.("sweep");
    if (!current()) return false;
    const renamed = pinsRenamed(
      this.#sql,
      results.map((r) => r.node_id),
      sweep.to === "compact",
    );
    const updates = results
      .filter((r) => renamed.has(r.node_id))
      .map((r) =>
        this.env.DB.prepare(
          "UPDATE comment_threads SET node_id = ? WHERE id = ? AND node_id = ?",
        ).bind(renamed.get(r.node_id), r.id, r.node_id),
      );
    for (let i = 0; i < updates.length; i += 50) {
      if (!current()) return false;
      await this.env.DB.batch(updates.slice(i, i + 50));
    }
    return true;
  }

  /** When pins need the alarm next (a sweep, a save, a load, the map's end); null when they don't. */
  #pinsDue(): number | null {
    if (
      this.#meta("pins_load") !== null ||
      this.#meta("pins_sweep") !== null ||
      this.#meta("pins_saved") === "0"
    )
      return Date.now() + ALARM_DELAY_MS;
    const until = this.#meta("pins_until");
    return until === null ? null : Number(until);
  }

  /**
   * The layer a comment written now is pinned to, as the file names it now,
   * or null to pin it to its point on the page (decision 0029):
   *
   * - an id the file has (a stored layer, or a copy layer built on the
   *   comment's page) stays as it is;
   * - a copy layer's id in the form the file had before it changed (a tab
   *   that hasn't reloaded) is translated, through the map the room keeps
   *   for a week (pin-map.ts), or after that the copy of it in R2;
   * - anything else (a layer deleted since, an id the maps don't name) is
   *   null: a comment is never pinned to a layer the file doesn't have;
   * - so is an id it can't translate because reading the map failed (R2
   *   unavailable, a damaged copy), or the layer couldn't be looked for.
   */
  async pinTarget(nodeId: string, pageId: string | null = null): Promise<string | null> {
    try {
      const toCompact = this.#copies === "compact";
      if (this.#hasLayer(nodeId, pageId)) return nodeId;
      const local = pinsRenamed(this.#sql, [nodeId], toCompact).get(nodeId);
      if (local !== undefined) return this.#hasLayer(local, pageId) ? local : null;
      const key = this.#meta("pins_key");
      if (key === null || hasPinMap(this.#sql)) return null;
      const archived = await pinRenamedInR2(this.env.FILES, key, nodeId, toCompact);
      // Asked as the file is now: it may have changed while R2 answered.
      return archived !== null && this.#hasLayer(archived, pageId) ? archived : null;
    } catch (error) {
      console.error("comment pin: couldn't find or translate its layer; pinned to the page", error);
      return null;
    }
  }

  /**
   * Whether the file has the layer `id` as people see it: stored, or, in a
   * file stored compact, a copy layer (one with a record is built from its
   * instance; one without is looked for on `pageId`, an instance at a time,
   * as the MCP tools read them).
   */
  #hasLayer(id: string, pageId: string | null): boolean {
    const stored = this.#store.get(id);
    const page = pageId === null ? undefined : this.#store.get(pageId);
    this.#store.clearCache();
    if (stored && stored.type !== "override") return true;
    if (this.#copies !== "compact") return false;
    const reader = new PresentedReader(new TableReader(this.#sql, "nodes"), this.#sql, "nodes");
    if (stored) return reader.get(id) !== undefined;
    if (page?.type !== "page") return false;
    const stack = [page.id];
    for (let at = stack.pop(); at !== undefined; at = stack.pop())
      for (const child of reader.children(at)) {
        if (child === id) return true;
        stack.push(child);
      }
    return false;
  }

  /**
   * Drops transient tables a stream let go of without finishing (after an
   * hour: none is read for that long), and an import nobody committed.
   */
  #sweepStaging(now = Date.now()): void {
    for (const table of tempTables(this.#sql))
      if (tempTableAge(table, now) > STALE_TABLE_MS) dropTable(this.#sql, table);
    const expiry = this.#importExpiry();
    if (expiry !== null && expiry <= now) this.#dropImport();
  }

  /** Deletes the R2 objects this room stopped pointing at an hour or more ago (a branch's old bases). */
  async #sweepStaleObjects(now = Date.now()): Promise<void> {
    const due = this.#sql
      .exec<{ key: string }>(
        "SELECT key FROM stale_objects WHERE at <= ? ORDER BY at LIMIT 1000",
        now - STALE_TABLE_MS,
      )
      .toArray()
      .map((row) => row.key);
    if (due.length === 0) return;
    await this.env.FILES.delete(due);
    for (const key of due) this.#sql.exec("DELETE FROM stale_objects WHERE key = ?", key);
  }

  /** When the oldest object this room stopped pointing at can go; null when there's none. */
  #staleObjectsDue(): number | null {
    const at = this.#sql
      .exec<{ at: number | null }>("SELECT MIN(at) AS at FROM stale_objects")
      .one().at;
    return at === null ? null : at + STALE_TABLE_MS;
  }

  /** When the oldest transient table left behind is old enough to drop; null when there's none. */
  #staleTablesDue(now = Date.now()): number | null {
    const ages = tempTables(this.#sql).map((table) => tempTableAge(table, now));
    return ages.length === 0 ? null : now - Math.max(...ages) + STALE_TABLE_MS;
  }

  /** When the import waiting for its commit is thrown away; null when none is. */
  #importExpiry(): number | null {
    const at = this.#meta("import_at");
    return at === null ? null : Number(at) + IMPORT_TTL_MS;
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
    const source = await openSnapshot(this.env.FILES, snapshotKey(fileId, version.revn));
    if (!source) return { ok: false, reason: "missing" };
    const versionCopies = snapshotCopies(source.header);
    // The version goes into a table beside the file's, a batch at a time.
    const table = tempTable("version");
    try {
      try {
        await loadSnapshot(this.#sql, table, source, this.#room.transact);
      } catch (error) {
        if (error instanceof SnapshotError)
          return { ok: false, reason: "invalid", message: error.message };
        throw error;
      }
      // Undoing compact copies (decision 0029): with conversion turned off, a version from before
      // it puts the file back as it was stored then, materialized.
      if (this.#copies === "compact" && versionCopies === "materialized" && !this.#compactOn())
        return await this.#restoreMaterialized(by, fileId, version, table, sessionId);
      const unreadable = this.#readable(versionCopies, "This version");
      if (unreadable) return { ok: false, reason: "invalid", message: unreadable };
      // A version saved before the file converted is converted as it's read.
      const read = [{ table, copies: versionCopies }];
      const unconverted = this.#reform(read, "This version");
      if (unconverted) return { ok: false, reason: "invalid", message: unconverted };
      const restorePoint = await this.#saveVersion(fileId, {
        reason: "restore",
        by: by.userId,
        restoredId: version.id,
      });
      await this.pause?.("restore");
      // The file may have changed form while that saved (a conversion applied): the version is
      // read in the form it has now. From here to the commit nothing awaits, so the diff, the
      // form and the store agree.
      const reformed = this.#reform(read);
      if (reformed) return { ok: false, reason: "invalid", message: reformed };
      const author = { clientId: "restore", seq: 0, userId: by.userId, sessionId: "restore" };
      const except = this.#attachments().find(({ me }) => me.sessionId === sessionId)?.ws;
      let committed: { revn: number; count: number; result: number };
      try {
        committed = this.#commitChunks(
          author,
          (out) => restoreFromTable(this.#sql, table, out),
          true,
        );
      } catch (error) {
        // The whole restore applies, or none of it.
        if (error instanceof ModelError)
          return { ok: false, reason: "invalid", message: error.message };
        throw error;
      }
      const { revn, count, result: dropped } = committed;
      if (count > 0) {
        this.#broadcast(
          { t: "restored", by, version: { id: version.id, name: version.name, at: version.at } },
          except,
        );
        void this.#scheduleAlarm();
      }
      return { ok: true, revn, restorePoint: restorePoint.id, changed: count, dropped };
    } finally {
      dropTable(this.#sql, table);
    }
  }

  /**
   * Brings tables read from snapshots (a version, a branch's base and side)
   * into the form the file stores copies in now, converting those that come
   * materialized into a file stored compact. Synchronous: call it right
   * before working out what to commit from them, after the last await, as
   * the file may have converted meanwhile. Returns why they can't come in,
   * or null (and each entry says its table's form).
   */
  #reform(
    tables: Array<{ readonly table: string; copies: CopiesFormat }>,
    what = "It",
  ): string | null {
    for (const entry of tables) {
      if (entry.copies === this.#copies) continue;
      const unreadable = this.#readable(entry.copies, what);
      if (unreadable) return unreadable;
      try {
        compactTable(this.#room, entry.table);
      } catch (error) {
        if (error instanceof ModelError) return error.message;
        throw error;
      }
      entry.copies = "compact";
    }
    return null;
  }

  /**
   * Why nodes stored as `copies` can't come into this file, or null when
   * they can: a materialized file can't take compact copies (conversion is
   * off, or the file hasn't converted yet).
   */
  #readable(copies: CopiesFormat, what: string): string | null {
    if (copies === "materialized" || this.#copies === "compact") return null;
    return this.#compactOn()
      ? `${what} stores component copies compactly, and this file is still being updated to do so. Try again in a minute.`
      : `${what} stores component copies compactly, which this server has turned off (COMPACT_COPIES).`;
  }

  /**
   * Restores a version saved before the file converted to compact copies,
   * as it was stored: the file is materialized again (decision 0029, how a
   * conversion is undone with COMPACT_COPIES=off). The file is replaced
   * whole, in one storage transaction, as an import replaces it; everyone
   * loads it again. The current state is saved first, as any restore does.
   */
  async #restoreMaterialized(
    by: Requester,
    fileId: string,
    version: RestoredVersion & { readonly revn: number },
    table: string,
    sessionId: string | null,
  ): Promise<RestoreResult> {
    const restorePoint = await this.#saveVersion(fileId, {
      reason: "restore",
      by: by.userId,
      restoredId: version.id,
    });
    const now = Date.now();
    const revn = this.ctx.storage.transactionSync(() => {
      this.#sql.exec("DELETE FROM nodes");
      this.#sql.exec(
        "INSERT INTO nodes (id, parent, key, type, props) SELECT id, parent, key, type, props FROM " +
          table +
          " WHERE depth IS NOT NULL",
      );
      const next = this.#revn + 1;
      this.#setMeta("revn", String(next));
      this.#setMeta("catchup_from", String(next));
      this.#setMeta("copies", "materialized");
      this.#setMeta("touched", "1");
      this.#setMeta("touched_at", String(now));
      this.#count(now, by.userId);
      this.#sql.exec("UPDATE agent_calls SET state = 'dropped' WHERE state IN ('done', 'undone')");
      // Comment pins on copies go back to the ids the file has again (pin-map.ts): from the map
      // the room keeps, or from its copy in R2.
      const map = hasPinMap(this.#sql);
      if (map) this.#setMeta("pins_until", String(now + PIN_MAP_KEEP_MS));
      else {
        const key = this.#meta("pins_key");
        if (key !== null && this.#meta("pins_saved") === "1") this.#setMeta("pins_load", key);
      }
      // A sweep under way (toward compact) stops; pins go back once the map is here.
      this.#formChanged("materialized", map);
      return next;
    });
    this.#revn = revn;
    this.#copies = "materialized";
    this.#store.clearCache();
    this.#engine?.drop();
    const except = this.#attachments().find(({ me }) => me.sessionId === sessionId)?.ws;
    this.#broadcast(
      { t: "restored", by, version: { id: version.id, name: version.name, at: version.at } },
      except,
    );
    this.#broadcast({ t: "resync" });
    void this.#scheduleAlarm();
    console.log(`compact copies: file ${fileId} restored materialized from version ${version.id}`);
    return { ok: true, revn, restorePoint: restorePoint.id, changed: 1, dropped: 0 };
  }

  /**
   * Publishes the file as a library (decision 0010): what it offers, read
   * from its nodes copied aside at one revision, and a named version saved
   * from that same copy, so the list and the content can't disagree. Nothing
   * is saved when there's nothing to publish.
   */
  async publishLibrary(
    by: Requester,
    fileId: string,
    name: string,
    description: string | null,
  ): Promise<PublishResult> {
    this.#adopt(fileId);
    const frozen = this.#freeze();
    try {
      // With compact copies, components are hashed as they're presented (decision 0029).
      const reader = new TableReader(this.#sql, frozen.table);
      const assets = libraryAssets(
        frozen.copies === "compact" ? new PresentedReader(reader, this.#sql, frozen.table) : reader,
      );
      if (assets.length === 0) return { ok: false, reason: "empty" };
      if (assets.length > MAX_LIBRARY_ASSETS) return { ok: false, reason: "too-many" };
      const version = await this.#saveVersion(
        fileId,
        { reason: "named", by: by.userId, name, description },
        frozen,
      );
      return { ok: true, version, assets };
    } finally {
      dropTable(this.#sql, frozen.table);
    }
  }

  /**
   * Answers an MCP read (decision 0011) from the file's nodes in SQLite,
   * reading only what the answer needs (see mcp/document.ts).
   */
  async readDocument(fileId: string, request: DocumentRequest): Promise<unknown> {
    this.#adopt(fileId);
    try {
      const reader = new TableReader(this.#sql, "nodes");
      // Copies as people see them (decision 0029): built an instance at a time.
      const doc =
        this.#copies === "compact"
          ? new PresentedReader(reader, this.#sql, "nodes").asDocView()
          : new SqlFileDoc(reader);
      return answerDocument(doc, request);
    } finally {
      this.#store.clearCache();
    }
  }

  /**
   * Starts an import into a new file (decision 0026): only a file nobody
   * has touched, its starting page still empty, which the import replaces.
   * Its nodes then come in parts (`importPart`) and land at `commitImport`;
   * until then the file is as it was. A new begin replaces an import that
   * was never committed. The room learns which file it is, so the file can
   * be versioned and published before anyone opens it (a kit added and
   * published at once).
   */
  async beginImport(fileId: string): Promise<ImportBegun> {
    this.#adopt(fileId);
    if (!this.#seedPage()) return { ok: false, reason: "not-empty" };
    const importId = newId();
    beginStaging(this.#sql, IMPORT_TABLE);
    this.#setMeta("import_id", importId);
    this.#setMeta("import_at", String(Date.now()));
    // The commit replaces the file as it is now; an edit in between refuses it (see the commit).
    this.#setMeta("import_revn", String(this.#revn));
    // So an import nobody commits is thrown away.
    void this.#scheduleAlarm();
    return { ok: true, importId, copies: this.#copies };
  }

  /** Checks a part of an import's nodes and keeps them for the commit. All or none of the part. */
  async importPart(
    fileId: string,
    importId: string,
    nodes: readonly NodeRecord[],
  ): Promise<ImportPartResult> {
    this.#adopt(fileId);
    if (this.#meta("import_id") !== importId) return { ok: false, reason: "gone" };
    try {
      // Held to the import's limits in all, in the same transaction that keeps the part.
      const staged = stageNodes(this.#room, nodes, IMPORT_TABLE, this.importLimits, {
        records: this.#copies === "compact",
      });
      this.#setMeta("import_at", String(Date.now()));
      return { ok: true, staged };
    } catch (error) {
      if (error instanceof ModelError)
        return { ok: false, reason: "invalid", message: error.message };
      throw error;
    }
  }

  /**
   * Checks the import's nodes as a whole and fills the file with them in one
   * storage transaction, replacing the starting page. A file never shows
   * half an import: before this, nobody sees any of it; a check that fails
   * leaves the file as it was (the import is thrown away).
   */
  async commitImport(
    by: Requester,
    fileId: string,
    importId: string,
    /**
     * How the parts stored copies (decision 0029): `compact` when the browser
     * converted them before sending. Anything else (an older page, another
     * client) is taken as materialized and converted here.
     */
    sent: CopiesFormat = "materialized",
  ): Promise<ImportResult> {
    return this.#commitImport(by, fileId, importId, false, this.#copies, sent);
  }

  /** A copy of a file this server holds (`importSnapshot`) isn't held to an import's limits. */
  #commitImport(
    by: Requester,
    fileId: string,
    importId: string,
    copy: boolean,
    copies: CopiesFormat,
    sent: CopiesFormat,
  ): ImportResult {
    this.#adopt(fileId);
    if (this.#meta("import_id") !== importId) return { ok: false, reason: "gone" };
    try {
      return this.#fillFromStaging(by, copy, copies, sent);
    } finally {
      this.#dropImport();
    }
  }

  /** Throws away an import that was begun (the importer gave up). */
  async abortImport(fileId: string, importId: string): Promise<void> {
    this.#adopt(fileId);
    if (this.#meta("import_id") === importId) this.#dropImport();
  }

  /**
   * Fills a new file with nodes in one call: a small import (the one-request
   * endpoint), staged and committed as one sending parts would be.
   */
  async importNodes(
    by: Requester,
    nodes: readonly NodeRecord[],
    fileId: string,
    /** How the nodes store copies: said by the sender, as at a commit (see `commitImport`). */
    sent: CopiesFormat = "materialized",
  ): Promise<ImportResult> {
    const begun = await this.beginImport(fileId);
    if (!begun.ok) return begun;
    const part = await this.importPart(fileId, begun.importId, nodes);
    if (!part.ok) {
      this.#dropImport();
      return part.reason === "gone" ? { ok: false, reason: "gone" } : part;
    }
    return this.commitImport(by, fileId, begun.importId, sent);
  }

  /**
   * Fills a new file with another's nodes, read from a snapshot stream (a
   * duplicate, a branch: see `exportSnapshot`), or from a snapshot in R2.
   */
  async importSnapshot(
    by: Requester,
    fileId: string,
    from: ReadableStream<Uint8Array> | { readonly key: string },
  ): Promise<ImportResult> {
    const source =
      from instanceof ReadableStream
        ? await openSnapshotStream(from)
        : await openSnapshot(this.env.FILES, from.key);
    if (!source) return { ok: false, reason: "invalid", message: "There's nothing to copy." };
    // A copy stores copies as its source does, or compact when converting is on (decision 0029).
    const sourceCopies = snapshotCopies(source.header);
    const copies: CopiesFormat =
      sourceCopies === "compact" || this.#compactOn() ? "compact" : "materialized";
    const begun = await this.beginImport(fileId);
    if (!begun.ok) {
      await source.lines.return(undefined);
      return begun;
    }
    try {
      for await (const nodes of snapshotNodes(source)) {
        if (this.#meta("import_id") !== begun.importId) return { ok: false, reason: "gone" };
        stageNodes(this.#room, nodes, IMPORT_TABLE, UNLIMITED, {
          records: sourceCopies === "compact",
        });
      }
    } catch (error) {
      this.#dropImport();
      if (error instanceof ModelError)
        return { ok: false, reason: "invalid", message: error.message };
      throw error;
    }
    return this.#commitImport(by, fileId, begun.importId, true, copies, sourceCopies);
  }

  /** The starting page, when it's all the file has (and still empty). */
  #seedPage(): NodeRecord | null {
    const roots = this.#store.childIds(ROOT_ID);
    const seed = roots.length === 1 ? this.#store.get(roots[0] as string) : undefined;
    const empty = seed?.type === "page" && this.#store.childIds(seed.id).length === 0;
    this.#store.clearCache();
    return empty ? (seed as NodeRecord) : null;
  }

  #dropImport(): void {
    dropStaging(this.#sql, IMPORT_TABLE);
    for (const k of ["import_id", "import_at", "import_revn"])
      this.#sql.exec("DELETE FROM meta WHERE k = ?", k);
  }

  /**
   * Checks the staged import and moves it into `nodes`, replacing the
   * starting page. Refused when the file changed since the import began:
   * someone renamed the starting page, say, and the import would replace
   * that acknowledged edit unseen.
   */
  #fillFromStaging(
    by: Requester,
    copy: boolean,
    copies: CopiesFormat,
    sent: CopiesFormat,
  ): ImportResult {
    const seed = this.#seedPage();
    // Compact copies can't come into a file stored materialized: they'd show nothing.
    if (sent === "compact" && copies !== "compact")
      return { ok: false, reason: "invalid", message: NO_COMPACT_COPIES };
    if (!seed) return { ok: false, reason: "not-empty" };
    if (this.#meta("import_revn") !== String(this.#revn)) return { ok: false, reason: "changed" };
    // Records come only with nodes said to be compact: converted as materialized, every instance
    // equal to its main would lose its layers.
    if (
      sent === "materialized" &&
      this.#sql.exec(`SELECT 1 FROM ${IMPORT_TABLE} WHERE type = 'override' LIMIT 1`).toArray()
        .length > 0
    )
      return {
        ok: false,
        reason: "invalid",
        message:
          'These nodes hold override records (compact copies): send them with copies: "compact".',
      };
    // Compact, they may not store layers under an instance: those come from its main.
    if (sent === "compact" && strayInstance(this.#sql, IMPORT_TABLE) !== null)
      return {
        ok: false,
        reason: "invalid",
        message:
          "An instance stores layers of its own, which in compact copies come from its main.",
      };
    try {
      checkStaged(
        this.#sql,
        IMPORT_TABLE,
        copy
          ? { limits: UNLIMITED, maxDepth: Number.POSITIVE_INFINITY, records: copies === "compact" }
          : { limits: this.importLimits, records: copies === "compact" },
      );
    } catch (error) {
      if (error instanceof ModelError)
        return { ok: false, reason: "invalid", message: error.message };
      throw error;
    }
    // Into a file that stores compact copies, what came materialized is converted first. What
    // came compact isn't: an instance equal to its main has no layers and no records there.
    if (copies === "compact" && sent === "materialized") compactTable(this.#room, IMPORT_TABLE);
    const nodes = countRows(this.#sql, IMPORT_TABLE);
    const revn = this.ctx.storage.transactionSync(() => {
      fillFromStaged(this.#sql, seed.id, IMPORT_TABLE);
      // A new form: a sweep of comment pins under way for the old one stops.
      if (copies !== this.#copies) this.#formChanged(copies, false);
      this.#setMeta("copies", copies);
      // Not logged: one change of the whole file. Clients behind it load the file instead of
      // catching up (see #hello); the log before it stays, for who edited what.
      const next = this.#revn + 1;
      this.#setMeta("catchup_from", String(next));
      const now = Date.now();
      this.#count(now, by.userId);
      this.#setMeta("revn", String(next));
      this.#setMeta("touched", "1");
      this.#setMeta("touched_at", String(now));
      return next;
    });
    this.#store.clearCache();
    this.#revn = revn;
    this.#copies = copies;
    this.#viewersAfterChange();
    this.#engine?.drop();
    this.#broadcast({ t: "resync" });
    void this.#scheduleAlarm();
    return { ok: true, revn, nodes };
  }

  /**
   * The file's nodes as a version 2 snapshot stream (gzip), at the revision
   * it's at now (see the header), however long it takes to read: copied
   * aside first, so edits meanwhile don't show. What a branch, a duplicate
   * or a merge reads another file's nodes from, room to room.
   */
  async exportSnapshot(): Promise<ReadableStream<Uint8Array>> {
    const fileId = this.#meta("file_id") ?? "";
    const { table, revn, copies } = this.#freeze();
    // Should the reader let go without finishing, the alarm drops the copy in time.
    void this.#scheduleAlarm();
    return snapshotStream(
      { fileId, revn, at: Date.now(), copies },
      tablePages(this.#sql, table),
      () => dropTable(this.#sql, table),
    );
  }

  /**
   * A branch's nodes as `exportSnapshot` streams them, and the key of the
   * base they're a change from, read together: an update from main moves
   * both at once (see `updateFromMain`).
   */
  async exportBranch(): Promise<{ baseKey: string; nodes: ReadableStream<Uint8Array> }> {
    const baseKey = this.#baseKey(this.#requireFileId());
    return { baseKey, nodes: await this.exportSnapshot() };
  }

  /** Where this branch's current base is in R2. */
  #baseKey(fileId: string): string {
    return this.#meta("base_key") ?? branchBaseKey(fileId);
  }

  /** Writes the file as it is now to `key` in R2 (a branch's base); returns its revision. */
  async writeSnapshotTo(key: string): Promise<{ revn: number; size: number }> {
    const fileId = this.#meta("file_id") ?? "";
    const { table, revn, copies } = this.#freeze();
    try {
      const size = await writeSnapshot(
        this.env.FILES,
        key,
        { fileId, revn, at: Date.now(), copies },
        tablePages(this.#sql, table),
      );
      return { revn, size };
    } finally {
      dropTable(this.#sql, table);
    }
  }

  /** Copies the nodes aside (in SQL, without awaiting), so a slow read sees one revision. */
  #freeze(): { table: string; revn: number; copies: CopiesFormat } {
    const table = tempTable("frozen");
    copyNodes(this.#sql, "nodes", table);
    return { table, revn: this.#revn, copies: this.#copies };
  }

  /**
   * Merges a branch into this file, its main file (decision 0012). The
   * changes are worked out here, against the file as it is at this moment, so
   * nothing main did since the reviewer looked is overwritten unseen: a
   * conflict without a decision stops the merge. The file is saved as a named
   * version first, which undoes the merge from History; then the chosen
   * changes are committed together (in chunks a large merge needs, in one
   * storage transaction) that everyone here sees arrive. The branch's base
   * comes from R2 and the branch itself as a snapshot stream, each into a
   * table here (decision 0026).
   */
  async mergeBranch(
    by: Requester,
    fileId: string,
    branch: { readonly id: string; readonly name: string },
    /** The branch's nodes, and the key of its base, from `exportBranch`. */
    from: { readonly baseKey: string; readonly nodes: ReadableStream<Uint8Array> },
    choices: {
      /** Each conflict's side, by change key (see changeKey). */
      readonly resolutions: Readonly<Record<string, Resolution>>;
      /** Changes left out, by change key. */
      readonly skip: readonly string[];
    },
  ): Promise<MergeResult> {
    this.#adopt(fileId);
    const decided = {
      resolutions: new Map(Object.entries(choices.resolutions)),
      skip: new Set(choices.skip),
    };
    return this.#threeWay(from.baseKey, from.nodes, async (tables, _revn, _base, read) => {
      // Checked before the restore point is saved, and again after (that awaits).
      const first = planThreeWay(this.#sql, tables, decided);
      if (first.undecided > 0)
        return { ok: false, reason: "undecided", undecided: first.undecided };
      const restorePoint = await this.#saveVersion(fileId, {
        reason: "named",
        by: by.userId,
        name: `Before merging “${branch.name}”`,
        description: null,
        keepName: true,
      });
      await this.pause?.("merge");
      // In the form the file has now (it may have converted meanwhile). From here to the commit
      // nothing awaits, so the plan, the form and the store agree.
      const reformed = this.#reform(read);
      if (reformed) return { ok: false, reason: "invalid", message: reformed };
      const plan = planThreeWay(this.#sql, tables, decided);
      if (plan.undecided > 0) return { ok: false, reason: "undecided", undecided: plan.undecided };
      const author = { clientId: "merge", seq: 0, userId: by.userId, sessionId: "merge" };
      let committed: { revn: number; count: number };
      try {
        committed = this.#commitChunks(
          author,
          (out) => applyThreeWay(this.#sql, tables, decided, out),
          false,
        );
      } catch (error) {
        // The whole merge applies, or none of it.
        if (error instanceof ModelError)
          return { ok: false, reason: "invalid", message: error.message };
        throw error;
      }
      const { revn, count } = committed;
      if (count === 0) return { ok: true, revn, restorePoint: restorePoint.id, changes: 0 };
      this.#broadcast({
        t: "merged-in",
        by: { id: by.userId, name: by.name },
        branch,
        changes: plan.changes,
      });
      void this.#scheduleAlarm();
      return { ok: true, revn, restorePoint: restorePoint.id, changes: plan.changes };
    });
  }

  /**
   * Brings main's changes since the base into this file, a branch (decision
   * 0012). Worked out here, against the branch as it is at this moment:
   * main's changes the branch didn't also make are committed together;
   * where both changed the same thing, the branch keeps its own, which
   * review then shows as a change against main as it is now. Main as it was
   * read becomes the branch's base.
   *
   * The two move together or not at all: main as read is written to R2
   * first, under a key of its own, and the branch's changes and the pointer
   * to its new base are then committed in one storage transaction. A failed
   * write or commit leaves the branch and its base as they were, so trying
   * again works. Updates run one at a time, and one bringing main as it was
   * before the current base changes nothing. The base replaced is deleted
   * later (by the alarm), as a review or merge may still be reading it.
   */
  async updateFromMain(
    by: Requester,
    fileId: string,
    mainNodes: ReadableStream<Uint8Array>,
  ): Promise<UpdateResult> {
    const run = this.#updating.then(() => this.#updateFromMain(by, fileId, mainNodes));
    this.#updating = run.catch(() => {});
    return run;
  }

  async #updateFromMain(
    by: Requester,
    fileId: string,
    mainNodes: ReadableStream<Uint8Array>,
  ): Promise<UpdateResult> {
    this.#adopt(fileId);
    const none = { resolutions: new Map<string, Resolution>(), skip: new Set<string>() };
    const oldKey = this.#baseKey(fileId);
    const result = await this.#threeWay(
      oldKey,
      mainNodes,
      async (tables, mainRevn, baseRevn, read): Promise<UpdateResult> => {
        // Main as read is no newer than the base: there's nothing to bring in, and the base stays.
        if (mainRevn <= baseRevn)
          return { ok: true, revn: this.#revn, changes: 0, kept: 0, mainRevn: baseRevn };
        const newKey = nextBranchBaseKey(fileId, mainRevn);
        try {
          await writeSnapshot(
            this.env.FILES,
            newKey,
            { fileId, revn: mainRevn, at: Date.now(), copies: this.#copies },
            tablePages(this.#sql, tables.other),
          );
        } catch (error) {
          console.error(`couldn't store the new base of branch ${fileId}`, error);
          await this.env.FILES.delete(newKey).catch(() => {});
          return { ok: false, message: "Main as it is now couldn't be stored. Try again." };
        }
        await this.pause?.("update");
        // In the form the branch has now (it may have converted meanwhile). From here to the
        // commit nothing awaits, so the plan, the form and the store agree.
        const reformed = this.#reform(read);
        if (reformed) {
          await this.env.FILES.delete(newKey).catch(() => {});
          return { ok: false, message: reformed };
        }
        const plan = planThreeWay(this.#sql, tables, none);
        const author = { clientId: "update", seq: 0, userId: by.userId, sessionId: "update" };
        let count: number;
        try {
          ({ count } = this.#commitChunks(
            author,
            (out) => {
              applyThreeWay(this.#sql, tables, none, out);
              out.flush();
              // In the same transaction as the changes: the branch and its base move together.
              this.#setMeta("base_key", newKey);
              this.#sql.exec(
                "INSERT OR REPLACE INTO stale_objects (key, at) VALUES (?, ?)",
                oldKey,
                Date.now(),
              );
            },
            false,
          ));
        } catch (error) {
          await this.env.FILES.delete(newKey).catch(() => {});
          if (error instanceof ModelError) return { ok: false, message: error.message };
          throw error;
        }
        void this.#scheduleAlarm();
        const kept = plan.conflicts;
        const taken = plan.changes - kept;
        if (count > 0)
          this.#broadcast({
            t: "updated-from-main",
            by: { id: by.userId, name: by.name },
            changes: taken,
          });
        return { ok: true, revn: this.#revn, changes: taken, kept, mainRevn };
      },
    );
    if ("missing" in result) return { ok: false, message: result.missing };
    if ("reason" in result) return { ok: false, message: result.message };
    return result;
  }

  /**
   * Reads a branch's base (from R2) and the other side (a stream) into
   * tables here, runs `work` on them, and drops them.
   */
  async #threeWay<R>(
    baseKey: string,
    otherNodes: ReadableStream<Uint8Array>,
    work: (
      tables: ThreeWayTables,
      otherRevn: number,
      baseRevn: number,
      /** Each side's table and its form now: `#reform` them after awaiting. */
      read: Array<{ readonly table: string; copies: CopiesFormat }>,
    ) => Promise<R>,
  ): Promise<
    | R
    | { readonly ok: false; readonly reason: "missing"; readonly missing: string }
    | { readonly ok: false; readonly reason: "invalid"; readonly message: string }
  > {
    const tables: ThreeWayTables = {
      base: tempTable("base"),
      other: tempTable("other"),
      removals: tempTable("removals"),
    };
    let other: SnapshotSource | null = null;
    try {
      other = await openSnapshotStream(otherNodes);
      if (!other) throw new Error("the other file's nodes didn't come");
      const base = await openSnapshot(this.env.FILES, baseKey);
      if (!base) {
        await other.lines.return(undefined);
        return {
          ok: false,
          reason: "missing",
          missing: "This branch's starting point is missing.",
        };
      }
      try {
        await loadSnapshot(this.#sql, tables.base, base, this.#room.transact);
        await loadSnapshot(this.#sql, tables.other, other, this.#room.transact);
      } catch (error) {
        if (error instanceof SnapshotError)
          return { ok: false, reason: "invalid", message: `It can't be read. ${error.message}` };
        throw error;
      }
      // Compared in this file's form (decision 0029): a side saved before compact copies is
      // converted as it's read. Copies' ids are derived the same way on every side.
      const read = [
        { table: tables.base, copies: snapshotCopies(base.header) },
        { table: tables.other, copies: snapshotCopies(other.header) },
      ];
      const unreadable = this.#reform(read, "One side");
      if (unreadable) return { ok: false, reason: "invalid", message: unreadable };
      return await work(tables, other.header.revn ?? 0, base.header.revn ?? 0, read);
    } finally {
      for (const table of Object.values(tables)) dropTable(this.#sql, table);
    }
  }

  // -------------------------------------------------------------------------
  // Agents (decision 0021)

  /**
   * Runs an agent's write tool on the headless editor and commits what it
   * did as one transaction, attributed to the person and the session and
   * seen arriving by everyone here. The Worker has checked the session and
   * the person's access.
   *
   * Everything async comes first (the fonts the document needs); from
   * taking the editor to the commit, nothing waits on anything outside the
   * room, so the tool runs on the file as it is when it commits. A call id
   * seen before answers as recorded, without running again. A tool that
   * fails commits nothing.
   */
  async runAgentTool(
    by: Requester,
    session: AgentSessionRef,
    callId: string,
    name: string,
    input: unknown,
  ): Promise<AgentCallResult> {
    this.#adopt(session.fileId);
    const tool = findTool(name);
    if (tool?.level !== "write") return { ok: false, message: `There's no write tool ${name}.` };
    const replay = this.#replay(session.id, callId);
    if (replay) return replay;
    const tooLarge = this.#tooLargeForAgents();
    if (tooLarge) return tooLarge;
    const engine = this.#agentEngine(session.fileId);
    if (!engine) return { ok: false, message: NO_ENGINE };

    // The fonts the file is set in, loaded before anything is measured.
    const missing = engine.missingFaces(this.#warmEditor(engine));
    if (missing.length > 0) await engine.load(missing);

    for (let attempt = 0; attempt < AGENT_ATTEMPTS; attempt++) {
      // A retry of this call may have finished while the fonts loaded.
      const again = this.#replay(session.id, callId);
      if (again) return again;
      const revn = this.#revn;
      let run: EngineRun;
      try {
        run = await engine.run(this.#warmEditor(engine), name, input);
      } catch (error) {
        return failedRun(engine, name, error);
      }
      // Tools don't wait on anything, so nothing can have landed meanwhile; if it did, run again.
      if (this.#revn !== revn) {
        engine.drop();
        continue;
      }
      // Text in a font not loaded yet: load it, and run again so it's measured right.
      const fonts = engine.facesMissingFrom(this.#warmEditor(engine), run.ops);
      if (fonts.length > 0 && attempt < AGENT_ATTEMPTS - 1) {
        engine.drop();
        await engine.load(fonts);
        continue;
      }
      return this.#commitAgentCall(by, session, callId, tool.title, name, run);
    }
    return { ok: false, message: "The file kept changing while that ran. Try again." };
  }

  /**
   * Runs an agent's read tool (get_jsx, export_image) on the headless
   * editor: nothing is committed or recorded.
   */
  async readAgentTool(fileId: string, name: string, input: unknown): Promise<AgentCallResult> {
    this.#adopt(fileId);
    const tool = findTool(name);
    if (!tool || tool.level === "write")
      return { ok: false, message: `There's no read tool ${name}.` };
    const tooLarge = this.#tooLargeForAgents();
    if (tooLarge) return tooLarge;
    const engine = this.#agentEngine(fileId);
    if (!engine) return { ok: false, message: NO_ENGINE };
    if (name === "export_image") {
      // Text is laid out again to be drawn: in its own fonts, as the browser lays it out.
      const missing = engine.missingFaces(this.#warmEditor(engine));
      if (missing.length > 0) await engine.load(missing);
    }
    const editor = this.#warmEditor(engine);
    const services: ToolServices = {
      renderPng: async (id, options) =>
        (await this.#renderer(fileId, engine)).renderPng(editor.doc, id, options),
    };
    try {
      const { result } = await engine.run(editor, name, input, services);
      return {
        ok: true,
        revn: null,
        result: result.data,
        ...(result.image ? { image: result.image } : {}),
        replayed: false,
      };
    } catch (error) {
      return failedRun(engine, name, error);
    }
  }

  /** The room's renderer, made the first time something is drawn. */
  #renderer(fileId: string, engine: AgentEngine): Promise<HeadlessRenderer> {
    this.#rendering ??= headlessRenderer(
      this.env,
      fileId,
      engine.measurer,
      fileFontLoader(this.env, fileId),
    ).catch((error: unknown) => {
      this.#rendering = null;
      throw error;
    });
    return this.#rendering;
  }

  /**
   * Whether a session's call committed, and what it answered: how another
   * engine (an open editor that went away halfway) learns a call is done.
   */
  async agentCall(
    sessionId: string,
    callId: string,
  ): Promise<{ revn: number | null; result: unknown } | null> {
    const call = this.#ledger.get(sessionId, callId);
    return call ? { revn: call.revn, result: call.result } : null;
  }

  /**
   * Undoes the session's latest call, or redoes the one it undid last, as
   * one transaction. Only that session's calls, and never over a person:
   * when someone else has changed the same layers since, it refuses and
   * says who and which.
   */
  async stepAgentCall(
    by: Requester,
    session: AgentSessionRef,
    callId: string,
    direction: "undo" | "redo",
  ): Promise<AgentCallResult> {
    this.#adopt(session.fileId);
    const replay = this.#replay(session.id, callId);
    if (replay) return replay;
    const target =
      direction === "undo"
        ? this.#ledger.lastDone(session.id)
        : this.#ledger.lastUndone(session.id);
    if (!target)
      return {
        ok: false,
        message:
          direction === "undo"
            ? "Nothing to undo: this session has no changes left to take back."
            : "Nothing to redo: undo something first.",
      };
    const since = direction === "undo" ? target.revn : (target.undoneRevn ?? target.revn);
    const blocked = this.#editedSince(since, session.id, changedIds(target.ops, target.inverse));
    if (blocked)
      return { ok: false, message: await this.#blockedMessage(direction, target, blocked) };

    const ops = direction === "undo" ? target.inverse : target.ops;
    const author = { clientId: "agent", seq: 0, userId: by.userId, sessionId: session.id };
    const result = {
      [direction === "undo" ? "undone" : "redone"]: { tool: target.tool, label: target.label },
    };
    let revn: number;
    try {
      revn = this.#commit(ops, author, {
        also: (next, inverse) => {
          if (direction === "undo") this.#ledger.markUndone(target, next, inverse);
          else this.#ledger.markRedone(target, next, inverse);
          const label = direction === "undo" ? "Undo" : "Redo";
          const call = { sessionId: session.id, callId, userId: by.userId, tool: direction, label };
          this.#ledger.recordCall(call, next, result, null, null);
        },
      });
    } catch (error) {
      if (error instanceof ModelError)
        return {
          ok: false,
          message:
            error.code === "conflict"
              ? `Can't ${direction} “${target.label}”: ${error.message}`
              : `Can't ${direction} “${target.label}”: the layers it changed have changed since.`,
        };
      throw error;
    }
    this.#broadcastChange(revn, ops, author);
    void this.#scheduleAlarm();
    return { ok: true, revn, result, replayed: false };
  }

  /** A refusal when the file is more than the headless editor holds (AGENT_MAX_NODES). */
  #tooLargeForAgents(): AgentCallResult | null {
    const stored = this.#store.count();
    // With compact copies the editor holds every copy layer as built: counted as presented.
    const nodes =
      this.#copies === "compact" && stored <= AGENT_MAX_NODES ? this.#presentedLayers() : stored;
    if (nodes <= AGENT_MAX_NODES) return null;
    return {
      ok: false,
      message: `This file is too large for agent tools (${nodes.toLocaleString("en")} layers; they work on files of up to ${AGENT_MAX_NODES.toLocaleString("en")}). The read tools (get_outline, find_nodes, get_node) still work.`,
    };
  }

  /** Layers the file presents (compact copies), worked out once a revision. */
  #presented: { revn: number; count: number } | null = null;
  #presentedLayers(): number {
    if (this.#presented?.revn !== this.#revn)
      this.#presented = { revn: this.#revn, count: presentedCount(this.#sql) };
    return this.#presented.count;
  }

  #replay(sessionId: string, callId: string): AgentCallResult | null {
    const seen = this.#ledger.get(sessionId, callId);
    return seen ? { ok: true, revn: seen.revn, result: seen.result, replayed: true } : null;
  }

  /** The room's engine, made with the file's measurer; null when none is configured. */
  #agentEngine(fileId: string): AgentEngine | null {
    if (this.#engine) return this.#engine;
    const measurer = agentMeasurer(this.env, fileId);
    if (!measurer) return null;
    this.#engine = new AgentEngine(measurer);
    return this.#engine;
  }

  #warmEditor(engine: AgentEngine) {
    return engine.editorAt(this.#revn, this.#store.count(), () => this.#readAll(), this.#copies);
  }

  /** Commits an engine run as one transaction, with its ledger row in the same storage transaction. */
  #commitAgentCall(
    by: Requester,
    session: AgentSessionRef,
    callId: string,
    label: string,
    tool: string,
    run: EngineRun,
  ): AgentCallResult {
    const engine = this.#engine as AgentEngine;
    const data = run.result.data ?? null;
    const call = { sessionId: session.id, callId, userId: by.userId, tool, label };
    if (run.ops.length === 0) {
      this.ctx.storage.transactionSync(() => this.#ledger.recordCall(call, null, data, null, null));
      return { ok: true, revn: null, result: data, replayed: false };
    }
    if (JSON.stringify(run.ops).length > MAX_AGENT_CHANGE_BYTES) {
      engine.drop();
      return {
        ok: false,
        message: "That's too much to change in one call. Build it in parts: one section per call.",
      };
    }
    const author = { clientId: "agent", seq: 0, userId: by.userId, sessionId: session.id };
    let revn: number;
    try {
      revn = this.#commit(run.ops, author, {
        fromEngine: true,
        also: (next, inverse) => this.#ledger.recordCall(call, next, data, run.ops, inverse),
      });
    } catch (error) {
      engine.drop();
      if (error instanceof ModelError)
        return { ok: false, message: `That change doesn't apply: ${error.message}` };
      throw error;
    }
    this.#broadcastChange(revn, run.ops, author);
    void this.#scheduleAlarm();
    return { ok: true, revn, result: data, replayed: false };
  }

  /**
   * Whether anyone but `sessionId` changed (or put something inside) any of
   * `ids` after revision `since`: who, and which. "unknown" when the log no
   * longer reaches back that far.
   */
  #editedSince(
    since: number,
    sessionId: string,
    ids: ReadonlySet<string>,
  ): { userId: string; ids: string[] } | "unknown" | null {
    if (since >= this.#revn) return null;
    // An import since then replaced the file without logging it.
    if (since < this.#catchupFrom()) return "unknown";
    const oldest = this.#sql
      .exec<{ revn: number | null }>("SELECT MIN(revn) AS revn FROM log")
      .one().revn;
    if (oldest === null || oldest > since + 1) return "unknown";
    const rows = this.#sql
      .exec<{ user_id: string; ops: string }>(
        "SELECT user_id, ops FROM log WHERE revn > ? AND session_id != ? ORDER BY revn",
        since,
        sessionId,
      )
      .toArray();
    for (const row of rows) {
      const hit = overlap(JSON.parse(row.ops) as Op[], ids);
      if (hit.length > 0) return { userId: row.user_id, ids: hit };
    }
    return null;
  }

  async #blockedMessage(
    direction: "undo" | "redo",
    target: StepCall,
    blocked: { userId: string; ids: string[] } | "unknown",
  ): Promise<string> {
    const what = `Can't ${direction} “${target.label}”`;
    if (blocked === "unknown")
      return `${what}: it was too long ago to tell whether anyone changed its layers since.`;
    const person = await this.env.DB.prepare("SELECT name FROM users WHERE id = ?")
      .bind(blocked.userId)
      .first<{ name: string }>()
      .catch(() => null);
    const names = blocked.ids
      .slice(0, 3)
      .map((id) => {
        const node = this.#store.get(id);
        const name = node?.props.name;
        return typeof name === "string" && name ? `“${name}” (${id})` : id;
      })
      .join(", ");
    this.#store.clearCache();
    const more = blocked.ids.length > 3 ? ` and ${blocked.ids.length - 3} more` : "";
    return `${what}: ${person?.name ?? "someone"} changed ${names}${more} since, and undo never reverts a person's work. Change the layers back with the tools instead.`;
  }

  #readAll(): NodeRecord[] {
    const nodes: NodeRecord[] = [];
    for (const page of this.#store.pages(SNAPSHOT_CHUNK_SIZE)) nodes.push(...page);
    return nodes;
  }

  /**
   * Every node in the file, for tests. Nothing on the server reads a whole
   * file this way (decision 0026): it streams (`exportSnapshot`) or asks
   * the room. Refuses files over 20,000 nodes.
   */
  async allNodes(): Promise<NodeRecord[]> {
    if (this.#store.count() > 20_000) throw new Error("allNodes is for small files (tests)");
    return this.#readAll();
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
    reads: readonly CopiesFormat[],
    protocol: number,
  ): Promise<void> {
    const current = await this.#checkAccess(ws, me, true);
    await this.pause?.("hello");
    // The file's form is checked here, after the await, as it's sent (it may have converted).
    if (current) this.#hello(ws, current, clientId, revn, reads, protocol);
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

  #hello(
    ws: WebSocket,
    me: Attachment,
    clientId: string,
    revn: number | null,
    reads: readonly CopiesFormat[],
    protocol: number,
  ): void {
    if (!reads.includes(this.#copies)) {
      // A tab from before compact copies: the file to view, every copy built, as it reads it.
      if (protocol === 1 && this.#copies === "compact") {
        this.#helloToView(ws, me, clientId);
        return;
      }
      // Anything else that can't read the file's form is told to reload, for a newer client.
      this.#send(ws, {
        t: "error",
        code: "reload",
        message: "Drawpane was updated. Reload the page to keep working on this file.",
      });
      this.#close(ws, RELOAD_CLOSE_CODE, "Reload");
      return;
    }
    me.clientId = clientId;
    // Its changes are in the form the file has now; should that change, they're checked for it.
    me.copies = this.#copies;
    me.reads = [...reads];
    me.viewing = false;
    me.stale = false;
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
      revn >= this.#catchupFrom() &&
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
      copies: this.#copies,
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

  /**
   * Welcomes a client from before compact copies (protocol 1) into a file
   * stored compact, as it can be: a viewer, sent the file as presented
   * (every copy layer built from its main and its record, an instance at a
   * time, as the MCP tools read it), in the form it reads. Its edits are
   * refused, telling it to reload (see #transaction), and it's sent the file
   * again as it changes, every VIEW_REFRESH_MS at most. The pre-compact
   * client shows a viewer's file and a refusal's message as they are; a
   * close it doesn't know would have it reconnect over and over.
   */
  #helloToView(ws: WebSocket, me: Attachment, clientId: string): void {
    me.clientId = clientId;
    me.copies = "materialized";
    me.reads = ["materialized"];
    me.viewing = true;
    me.servedAt = Date.now();
    me.stale = false;
    ws.serializeAttachment(me);
    const lastSeq =
      this.#sql
        .exec<{ last_seq: number }>("SELECT last_seq FROM clients WHERE client_id = ?", clientId)
        .toArray()[0]?.last_seq ?? 0;
    const peers = me.guest ? [] : this.#peers().filter((p) => p.sessionId !== me.sessionId);
    this.#send(ws, {
      t: "welcome",
      sessionId: me.sessionId,
      revn: this.#revn,
      role: "viewer",
      peers,
      mode: "snapshot",
      lastSeq,
      copies: "materialized",
    });
    // Nothing awaits from here to the last chunk: one revision.
    const presented = new PresentedReader(new TableReader(this.#sql, "nodes"), this.#sql, "nodes");
    let chunk: NodeRecord[] = [];
    for (const node of presented.onPages()) {
      chunk.push(node);
      if (chunk.length < SNAPSHOT_CHUNK_SIZE) continue;
      this.#send(ws, { t: "snapshot", nodes: chunk, done: false });
      chunk = [];
    }
    this.#send(ws, { t: "snapshot", nodes: chunk, done: true });
    if (!me.guest) this.#broadcast({ t: "peer", peer: this.#peer(me) }, ws);
  }

  /** Sends the file again to clients viewing it from before compact copies, when it changed. */
  #refreshViewers(now = Date.now()): number | null {
    let due: number | null = null;
    for (const { ws, me } of this.#attachments()) {
      if (!me.viewing || !me.stale) continue;
      const at = (me.servedAt ?? 0) + VIEW_REFRESH_MS;
      if (at <= now) {
        ws.serializeAttachment({ ...me, stale: false, servedAt: now });
        this.#send(ws, { t: "resync" });
      } else due = due === null ? at : Math.min(due, at);
    }
    return due;
  }

  /**
   * Whether a socket's client reads copies stored as `form`: what its hello
   * said. A socket welcomed before that was recorded reads what it was
   * welcomed in, and materialized (every client does).
   */
  #reads(me: Attachment, form: CopiesFormat): boolean {
    if (me.reads) return me.reads.includes(form);
    return form === "materialized" || me.copies === form;
  }

  /**
   * Clients that can't read the file's form now (a tab from before compact
   * copies, open while the file converted) become viewers, as if they had
   * said hello now: no change in the new form is sent to them, their edits
   * are refused telling them to reload, and they're sent the file again
   * (`resync`) to view. Called right after the storage transaction that
   * changes the form, with nothing awaited in between.
   */
  #viewersAfterChange(): void {
    for (const { ws, me } of this.#attachments()) {
      if (!me.clientId || me.viewing || this.#reads(me, this.#copies)) continue;
      ws.serializeAttachment({ ...me, viewing: true, stale: true, servedAt: 0 });
    }
  }

  /**
   * Operations in the materialized form (from a client that loaded the file
   * before it converted) as they apply to the file stored compact, or why
   * they can't: they apply when they touch no copy layer, instance, main or
   * record, and make none (a page renamed, a layer on a screen moved). Ids
   * they hold in values are checked too: a layer named by its copy's old id
   * (a reading order, a prototype link, a flow's start) is renamed to its
   * derived id from the conversion's map; any other id the map knows (a
   * text style, a binding, a variable mode or alias naming an old copy id)
   * is refused, as is a held id the file doesn't have and the map can't
   * translate. The rest are refused, as their ids and meaning changed.
   */
  #fromOldForm(ops: readonly Op[]): { ops: Op[] } | { refusal: string } {
    const plain = new Map<string, boolean>();
    // Whether a stored node, and every node above it, is outside copies, instances and mains.
    const isPlain = (id: string): boolean => {
      if (id === ROOT_ID) return true;
      const known = plain.get(id);
      if (known !== undefined) return known;
      const node = this.#store.get(id);
      const props = (node?.props ?? {}) as Record<string, unknown>;
      const ok =
        !!node &&
        node.type !== "override" &&
        ![...COPY_PROPS].some((prop) => props[prop] !== undefined) &&
        isPlain(node.parent);
      plain.set(id, ok);
      return ok;
    };
    const holdsCopies = (id: string) =>
      this.#sql
        .exec(
          `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent = sub.id)
           SELECT 1 FROM nodes n JOIN sub ON sub.id = n.id
            WHERE n.type = 'override' OR json_extract(n.props, '$.instanceOf') IS NOT NULL
               OR json_extract(n.props, '$.isComponent') = 1
               OR json_extract(n.props, '$.isComponentSet') = 1
            LIMIT 1`,
          id,
        )
        .toArray().length > 0;
    const made = new Set<string>();
    for (const op of ops) if (op.op === "create") made.add(op.id);
    const exists = (id: string) => {
      if (made.has(id)) return true;
      const node = this.#store.get(id);
      return !!node && node.type !== "override";
    };
    const refusal = { refusal: "This file was updated, and that change was made before it was." };
    /** Values with the ids they hold checked, layers' old copy ids renamed; null when refused. */
    const held = (props: Readonly<Record<string, unknown>>): Record<string, unknown> | null => {
      const { layers, others } = heldNodeIds(props as Props);
      if (layers.length === 0 && others.length === 0) return props as Record<string, unknown>;
      const renamed = pinsRenamed(this.#sql, [...layers, ...others], true);
      if (others.some((id) => renamed.has(id) || !exists(id))) return null;
      if (layers.some((id) => !renamed.has(id) && !exists(id))) return null;
      if (renamed.size === 0) return props as Record<string, unknown>;
      return (renameHeldIds(props as Props, (id) => renamed.get(id)) ?? props) as Record<
        string,
        unknown
      >;
    };
    const out: Op[] = [];
    try {
      for (const op of ops) {
        if (op.op === "create") {
          const props = op.props as Record<string, unknown>;
          if ([...COPY_PROPS].some((prop) => props[prop] !== undefined)) return refusal;
          if (!made.has(op.parent) && !isPlain(op.parent)) return refusal;
          const checked = held(props);
          if (!checked) return refusal;
          out.push(checked === props ? op : { ...op, props: checked as Props });
          continue;
        }
        if (op.op === "set") {
          if (COPY_PROPS.has(op.prop)) return refusal;
          if (!made.has(op.id) && !isPlain(op.id)) return refusal;
          if (op.value === null || op.value === undefined) {
            out.push(op);
            continue;
          }
          const value = { [op.prop]: op.value };
          const checked = held(value);
          if (!checked) return refusal;
          out.push(checked === value ? op : ({ ...op, value: checked[op.prop] } as Op));
          continue;
        }
        if (!made.has(op.id)) {
          // An id it doesn't have is most likely a copy layer's old one.
          if (!isPlain(op.id)) return refusal;
          if (op.op === "delete" && holdsCopies(op.id)) return refusal;
        }
        if (op.op === "move" && !made.has(op.parent) && !isPlain(op.parent)) return refusal;
        out.push(op);
      }
      return { ops: out };
    } finally {
      this.#store.clearCache();
    }
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
    // A client from before compact copies, viewing a file stored compact: it can't edit it.
    if (me.viewing || !this.#reads(me, this.#copies)) {
      this.#reject(ws, seq, ops, "format", RELOAD_TO_EDIT);
      return;
    }
    // Changes in the form the file stored when this client loaded it, which has changed since
    // (decision 0029): those that don't touch copies apply as they are; the rest are refused,
    // and the client loads the file again (it was told to already).
    if ((me.copies ?? "materialized") !== this.#copies) {
      const fitted: { ops: Op[] } | { refusal: string } =
        this.#copies === "compact"
          ? this.#fromOldForm(ops)
          : { refusal: "This file was updated, and that change was made before it was." };
      if ("refusal" in fitted) {
        this.#reject(ws, seq, ops, "format", `${fitted.refusal} Loading it again.`);
        this.#send(ws, { t: "resync" });
        return;
      }
      ops = fitted.ops;
    }
    // Override records (decision 0029) only in a file that stores compact copies.
    if (
      this.#copies !== "compact" &&
      ops.some((op) => op.op === "create" && op.type === "override")
    ) {
      this.#reject(ws, seq, ops, "unsupported", "This file doesn't store compact copies.");
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
   * `also` writes more in the same storage transaction (an agent call's
   * ledger row), given the revision and the operations that undo it.
   * The warm agent editor follows, unless the change is its own (`fromEngine`).
   */
  #commit(
    ops: readonly Op[],
    author: Author,
    options: {
      readonly also?: (revn: number, inverse: Op[]) => void;
      readonly fromEngine?: boolean;
    } = {},
  ): number {
    try {
      // A main it removes: what its instances show is looked at first (main-removal.ts).
      const first: LookFirst =
        this.#copies === "compact"
          ? {
              mains: MainRemoval.predicted(this.#sql, this.#store, ops),
              deleted: new Set(ops.flatMap((op) => (op.op === "delete" ? [op.id] : []))),
            }
          : { mains: new Set(), deleted: new Set() };
      const revn = withLooks(first, (look) =>
        this.ctx.storage.transactionSync(() => {
          const next = this.#revn + 1;
          // An edit to a file stored compact is checked as a whole (decision 0029).
          const check = this.#compactCheck(look);
          const inverse = this.#applyLogged(ops, author, next, {
            inverse: options.also !== undefined,
            check,
          });
          // Checked before `also` writes anything: a check that asks to run it again rolls back.
          if (check) this.#checkCompact(check);
          options.also?.(next, inverse);
          return next;
        }),
      );
      this.#revn = revn;
      if (options.fromEngine) this.#engine?.committed(revn);
      else this.#engine?.follow(ops, revn);
      return revn;
    } finally {
      this.#store.clearCache();
    }
  }

  /**
   * What an edit to a file stored compact is checked for (decision 0029),
   * gathered as its operations apply (a restore's or a merge's in chunks),
   * then checked once, before its storage transaction ends; null when the
   * file stores copies materialized. Call inside the storage transaction,
   * before anything applies: what the instances of `look.mains` show is
   * read then.
   */
  #compactCheck(look: LookFirst): CompactCheck | null {
    if (this.#copies !== "compact") return null;
    const removal = new MainRemoval(this.#sql, this.#store);
    removal.lookFirst(look.mains, look.deleted);
    return { removal, candidates: new Set() };
  }

  /** Before operations apply: the mains they may remove. */
  #noteRemovedMains(ops: readonly Op[], check: CompactCheck): void {
    check.removal.note(ops);
  }

  /** After operations apply: the nodes that may now be an instance storing layers. */
  #noteCandidates(ops: readonly Op[], check: CompactCheck): void {
    for (const op of ops) {
      if (op.op === "create" || op.op === "move") check.candidates.add(op.parent);
      if (op.op === "set" && op.prop === "instanceOf") check.candidates.add(op.id);
      if (op.op === "set" && op.prop === "isComponent" && op.value)
        for (const row of this.#sql
          .exec<{ id: string }>(
            "SELECT id FROM nodes WHERE type = 'frame' AND json_extract(props, '$.instanceOf') = ?",
            op.id,
          )
          .toArray())
          check.candidates.add(row.id);
    }
  }

  /**
   * What an edit to a file stored compact must leave (decision 0029), so a
   * client's mistake or a race can't lose a copy's look: no stored layers
   * under an instance of a live main (its layers come from the main), and
   * every instance of a main the edit removed showing exactly what it
   * showed (main-removal.ts: the editor stores each instance's layers
   * before removing a main; a client behind the file stores what it saw,
   * and is refused, to make the change again).
   */
  #checkCompact({ removal, candidates }: CompactCheck): void {
    this.#store.clearCache();
    const isMain = (id: string) => {
      const main = this.#store.get(id);
      return main?.type === "frame" && !!main.props.isComponent;
    };
    const isLive = (node: NodeRecord | undefined) => {
      const of = node?.type === "frame" ? node.props.instanceOf : undefined;
      return !!of && of !== node?.id && isMain(of);
    };
    for (const id of candidates)
      if (
        isLive(this.#store.get(id)) &&
        this.#sql
          .exec("SELECT 1 FROM nodes WHERE parent = ? AND type != 'override' LIMIT 1", id)
          .toArray().length > 0
      )
        throw new ModelError(
          "invalid_parent",
          "Layers inside an instance come from its main component: detach it to change them.",
        );
    removal.check();
  }

  /**
   * Applies and logs one transaction as revision `next`, inside a storage
   * transaction the caller runs. Returns the operations that undo it when
   * asked (`inverse`); without them, a delete doesn't read what it removes.
   * `held`: it puts back what a file this server holds had (a restore, a
   * merge, an update from main), so nothing is refused for depth.
   */
  #applyLogged(
    ops: readonly Op[],
    author: Author,
    next: number,
    {
      inverse,
      held = false,
      check,
    }: { inverse: boolean; held?: boolean; check: CompactCheck | null },
  ): Op[] {
    // A conversion under way (decision 0029) converts again the instances this may change:
    // found before (what's deleted) and after (what's made) it applies.
    const touched = this.#converting ? touchedIds(ops) : null;
    if (touched) markDirty(this.#sql, "nodes", LIVE_CONVERSION, touched);
    // A file stored compact: what this removes and makes, checked when the transaction ends.
    if (check) this.#noteRemovedMains(ops, check);
    // Every commit is checked for instances inside their own main, held or not (the clients follow).
    const undo = applyTransaction(this.#store, ops, {
      rollback: false,
      inverse,
      held,
      cycles: true,
    });
    this.#store.clearCache();
    if (check) this.#noteCandidates(ops, check);
    if (touched) markDirty(this.#sql, "nodes", LIVE_CONVERSION, touched);
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
    return undo;
  }

  /**
   * Commits operations worked out a few at a time (a restore, a merge),
   * each chunk of about a megabyte its own logged revision, all in one
   * storage transaction: everything lands or, if anything throws, nothing
   * does. Then everyone here sees it arrive, chunk by chunk, or is asked to
   * load the file again when it's more than a broadcast carries.
   */
  #commitChunks<R>(
    author: Author,
    produce: (out: OpChunks) => R,
    /**
     * Whether the operations bring back what this file already held (a
     * restore), so layers come back as deep as they were. A merge or an
     * update combines two files' changes into a tree neither held, so it
     * follows the ordinary depth rule.
     */
    held: boolean,
  ): { revn: number; count: number; result: R } {
    let next = this.#revn;
    const sent: Array<{ revn: number; ops: Op[] }> = [];
    let sentChars = 0;
    let tooBig = false;
    let outcome: { result: R; count: number };
    try {
      // Which mains it removes is known once it has applied: when it removes any, it's run
      // again, looking at their instances first (main-removal.ts).
      const none: LookFirst = { mains: new Set(), deleted: new Set() };
      outcome = withLooks(none, (look) => {
        next = this.#revn;
        sent.length = 0;
        sentChars = 0;
        tooBig = false;
        this.#store.clearCache();
        return this.ctx.storage.transactionSync(() => {
          // Checked as one edit, whatever order its chunks come in (decision 0029).
          const check = this.#compactCheck(look);
          const out = new OpChunks((ops) => {
            next++;
            this.#applyLogged(ops, author, next, { inverse: false, held, check });
            this.#store.clearCache();
            if (tooBig) return;
            sentChars += JSON.stringify(ops).length;
            if (sentChars > MAX_BROADCAST_BYTES) {
              tooBig = true;
              sent.length = 0;
            } else sent.push({ revn: next, ops });
          });
          const result = produce(out);
          out.flush();
          if (check) this.#checkCompact(check);
          return { result, count: out.count };
        });
      });
    } catch (error) {
      this.#engine?.drop();
      throw error;
    } finally {
      this.#store.clearCache();
    }
    this.#revn = next;
    if (tooBig) {
      this.#engine?.drop();
      this.#broadcast({ t: "resync" });
    } else
      for (const chunk of sent) {
        this.#engine?.follow(chunk.ops, chunk.revn);
        this.#broadcastChange(chunk.revn, chunk.ops, author);
      }
    return { revn: next, count: outcome.count, result: outcome.result };
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
  async #scheduleAlarm(delay = ALARM_DELAY_MS): Promise<void> {
    const soon = Date.now() + delay;
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
    /** The nodes to save, already copied aside at their revision (see #freeze). */
    frozen?: { readonly table: string; readonly revn: number; readonly copies: CopiesFormat },
  ): Promise<SavedVersion> {
    const revn = frozen?.revn ?? this.#revn;
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

    if (!frozen && revn !== this.#revn) return this.#saveVersion(fileId, options);
    // Copied aside without awaiting, so the snapshot is one consistent revision however long
    // writing it takes.
    const own = frozen ? null : this.#freeze();
    const table = own?.table ?? null;
    const copies = frozen?.copies ?? (own as { copies: CopiesFormat }).copies;
    let size: number;
    let summary: ReturnType<typeof summarizeEdits>;
    let authors: string[];
    let startedAt: number | null;
    const now = Date.now();
    try {
      // What changed since the last version, read a log row at a time.
      const range = [previous, revn] as const;
      const who = this.#sql
        .exec<{ user_id: string; first: number }>(
          "SELECT user_id, MIN(at) AS first FROM log WHERE revn > ? AND revn <= ? AND client_id != 'system' GROUP BY user_id ORDER BY MIN(revn)",
          ...range,
        )
        .toArray();
      authors = who.map((row) => row.user_id).filter((id) => !id.startsWith("guest:"));
      startedAt = who.length > 0 ? Math.min(...who.map((row) => row.first)) : null;
      const sql = this.#sql;
      summary = summarizeEdits(
        (function* () {
          for (const row of sql.exec<{ ops: string }>(
            "SELECT ops FROM log WHERE revn > ? AND revn <= ? AND client_id != 'system' ORDER BY revn",
            ...range,
          ))
            yield JSON.parse(row.ops) as Op[];
        })(),
      );
      size = await writeSnapshot(
        this.env.FILES,
        snapshotKey(fileId, revn),
        { fileId, revn, at: now, copies },
        tablePages(this.#sql, frozen?.table ?? (table as string)),
      );
    } finally {
      if (table) dropTable(this.#sql, table);
    }
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
        startedAt,
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

  /** The oldest revision a client can catch up from: none before the last import. */
  #catchupFrom(): number {
    return Number(this.#meta("catchup_from") ?? 0);
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

  /** Every socket still in the room (one that's been let go has no attachment). */
  #attachments(): Array<{ ws: WebSocket; me: Attachment }> {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, me: ws.deserializeAttachment() as Attachment | null }))
      .filter((a): a is { ws: WebSocket; me: Attachment } => a.me !== null);
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
      if ((me.viewing || !this.#reads(me, this.#copies)) && message.t === "txn") {
        // A client from before compact copies can't take changes as stored: it's sent the file
        // again, every VIEW_REFRESH_MS at most (the alarm sends it when it's held back).
        ws.serializeAttachment({ ...me, stale: true });
        if (this.#refreshViewers() !== null) void this.#scheduleAlarm(VIEW_REFRESH_MS);
        continue;
      }
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

/**
 * A tool that failed, as its answer: its own failure as worded, anything
 * else (a bug) logged, with the engine let go in case it was left half-done.
 */
function failedRun(engine: AgentEngine, name: string, error: unknown): AgentCallResult {
  if (error instanceof ToolFailure) return { ok: false, message: error.message };
  console.error(`agent tool ${name} failed`, error);
  engine.drop();
  return {
    ok: false,
    message: `${name} failed unexpectedly, and changed nothing. Try it another way, or in smaller steps.`,
  };
}

export type UpdateResult =
  | {
      readonly ok: true;
      readonly revn: number;
      /** Main's changes it brought in. */
      readonly changes: number;
      /** Main's changes to things the branch had changed too: the branch's stayed. */
      readonly kept: number;
      /** Main's revision as read: the branch's base from now on. */
      readonly mainRevn: number;
    }
  | { readonly ok: false; readonly message: string };

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
  | { readonly ok: false; readonly reason: "invalid"; readonly message: string }
  /** The branch's base isn't in R2. */
  | { readonly ok: false; readonly reason: "missing"; readonly missing: string };

export type ImportResult =
  | { readonly ok: true; readonly revn: number; readonly nodes: number }
  | { readonly ok: false; readonly reason: "not-empty" }
  /** The file changed after the import began: nothing was imported. */
  | { readonly ok: false; readonly reason: "changed" }
  /** No such import: never begun, committed, given up, or replaced by another. */
  | { readonly ok: false; readonly reason: "gone" }
  | { readonly ok: false; readonly reason: "invalid"; readonly message: string };

export type ImportBegun =
  | {
      readonly ok: true;
      readonly importId: string;
      /** How the file stores copies (decision 0029): the browser sends them so when it can. */
      readonly copies: CopiesFormat;
    }
  | { readonly ok: false; readonly reason: "not-empty" };

export type ImportPartResult =
  | { readonly ok: true; readonly staged: number }
  | { readonly ok: false; readonly reason: "gone" }
  | { readonly ok: false; readonly reason: "invalid"; readonly message: string };

export type PublishResult =
  | { readonly ok: true; readonly version: SavedVersion; readonly assets: LibraryAsset[] }
  | { readonly ok: false; readonly reason: "empty" | "too-many" };

/** The nodes a change touches: each operation's node, and where it creates or moves one. */
function touchedIds(ops: readonly Op[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    ids.add(op.id);
    if (op.op === "create" || op.op === "move") ids.add(op.parent);
  }
  return [...ids];
}

/** A sweep of comment pins: toward which form, for which change of form (see #formChanged). */
interface PinSweep {
  readonly to: CopiesFormat;
  readonly gen: number;
}

function pinSweepFlag(to: CopiesFormat, gen: number): string {
  return `${to}:${gen}`;
}

/** A `pins_sweep` flag read back; one without a form and change (older) is for the current ones. */
function parsePinSweep(flag: string, copies: CopiesFormat, gen: number): PinSweep {
  const [to, at] = flag.split(":");
  return to === "compact" || to === "materialized" ? { to, gen: Number(at) } : { to: copies, gen };
}
