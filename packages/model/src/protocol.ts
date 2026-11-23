/**
 * The file websocket protocol (`/ws/files/:id`). Messages are JSON.
 *
 * Ordering model: the FileRoom gives every accepted transaction the next
 * revision number (`revn`). Clients apply their own transactions at once and
 * keep them pending until `ack`; everyone else receives them as `txn`.
 */
import { z } from "zod";
import type { CommentEvent } from "./comments";
import type { CopiesFormat } from "./convert";
import { ID_PATTERN } from "./ids";
import { type NodeRecord, type Op, OpsSchema } from "./ops";

/**
 * 2: the room says how the file stores copies (decision 0029), at welcome;
 * the client says which ways it can read, at hello.
 *
 * 3: variables and styles (decision 0034): paint, stop and effect bindings,
 * style links, boolean variables, up to 64 modes, bindings that say their
 * unit. Old data needs nothing (a binding without a unit reads as before),
 * but an older tab (1 or 2) can't keep what it doesn't know: it would strip
 * bindings and links from what it rewrites. So it doesn't write: one that
 * says hello is told to reload (1, which reconnects on most closes, is shown
 * a page saying so), and a socket welcomed before the release, whose
 * attachment says no protocol, has its edits refused and is told the same.
 *
 * 4: an instance keeps what its own auto layout gave its layers when that
 * flow is taken away (PR 286). The client taking it away marks those layers'
 * places and the sizes and text modes the flow decided as their own, in the
 * same transaction, so a later change to the main's flow can't take them. An
 * older tab (3 or before) can take an instance's auto layout away without
 * those marks, and nothing marks them after: the client that receives an edit
 * lays nothing out. So it doesn't write, as for 3: it's told to reload at
 * hello, and one welcomed before the release has its edits refused. Old data
 * needs nothing: a removal saved before keeps reading as it did.
 */
export const PROTOCOL_VERSION = 4;

/** The close code that tells a client the room needs a newer one: reload the page. */
export const RELOAD_CLOSE_CODE = 4426;

/** Nodes per snapshot chunk, so a big file never becomes one huge frame. */
export const SNAPSHOT_CHUNK_SIZE = 2_000;

/**
 * A file of more nodes than this is downloaded (`GET /api/files/:id/document`)
 * by a client that can, instead of sent through the socket: a socket has no
 * backpressure, so a room sending a large file at once holds all of it, and a
 * room has 128 MB. A file this small fits in one snapshot chunk.
 */
export const INLINE_SNAPSHOT_NODES = SNAPSHOT_CHUNK_SIZE;

/** Largest client message accepted, in bytes. */
export const MAX_CLIENT_MESSAGE_BYTES = 4 * 1024 * 1024;

const Id = z.string().regex(ID_PATTERN);

const finite = z.number().refine(Number.isFinite, "must be a finite number");

export const Presence = z.object({
  /** Pointer in page coordinates, or null when the pointer left the canvas. */
  cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
  pageId: Id.nullable(),
  selection: z.array(Id).max(500),
  /** The part of the page on screen, in page coordinates: what followers see. */
  viewport: z.object({ x: finite, y: finite, width: finite, height: finite }).nullable().optional(),
  /** The session this person is following, if any. */
  following: z.string().min(1).max(64).nullable().optional(),
  /** Asking everyone in the file to follow them. */
  spotlight: z.boolean().optional(),
});
export type Presence = z.infer<typeof Presence>;

/** Upper bounds of the edit latency histogram, in ms (log₂ steps). */
export const LATENCY_BUCKETS_MS = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096] as const;

/** The bucket a latency falls in: an index into LATENCY_BUCKETS_MS, or its length for slower. */
export function latencyBucket(ms: number): number {
  const i = LATENCY_BUCKETS_MS.findIndex((ceiling) => ms <= ceiling);
  return i === -1 ? LATENCY_BUCKETS_MS.length : i;
}

export const ClientMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    /**
     * Older clients (1: before compact copies, 2: before variables and styles, 3: before marking
     * what an instance's own flow left) are told to reload.
     */
    protocol: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(PROTOCOL_VERSION)]),
    /** Stable per browser tab; used to make resent transactions idempotent. */
    clientId: Id,
    /** Last revision this client has fully applied, or null for a fresh load. */
    revn: z.number().int().nonnegative().nullable(),
    /** How the client can read copies stored (decision 0029). Version 2 says; version 1 reads materialized only. */
    copies: z
      .array(z.enum(["materialized", "compact"]))
      .max(4)
      .optional(),
    /**
     * The client can download the file over HTTP (welcome mode `download`).
     * Without it, a file comes through the socket when it's small enough
     * (8 MB of JSON); a larger one is a viewer's page saying to reload.
     */
    download: z.literal(true).optional(),
  }),
  z.object({
    t: z.literal("txn"),
    /** Per-client sequence number, increasing by one per transaction. */
    seq: z.number().int().positive(),
    ops: OpsSchema,
  }),
  z.object({ t: z.literal("presence"), presence: Presence }),
  z.object({ t: z.literal("ping") }),
  z.object({
    t: z.literal("stats"),
    /**
     * How long the room took to confirm this client's edits (send to ack),
     * counted into LATENCY_BUCKETS_MS (the last count is anything slower),
     * since the client's last report. For the instance's health page.
     */
    latency: z.array(z.number().int().min(0).max(1_000_000)).length(LATENCY_BUCKETS_MS.length + 1),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export interface Peer {
  readonly sessionId: string;
  readonly userId: string;
  readonly name: string;
  /** 1–8: which `presence-n` token colors this peer. */
  readonly color: number;
  readonly kind: "person" | "agent";
  readonly presence: Presence | null;
}

export interface RemoteTxn {
  readonly revn: number;
  readonly ops: readonly Op[];
  readonly author: { readonly userId: string; readonly sessionId: string };
}

export type ServerMessage =
  | {
      readonly t: "welcome";
      readonly sessionId: string;
      readonly revn: number;
      readonly role: "owner" | "editor" | "viewer";
      readonly peers: readonly Peer[];
      /**
       * `snapshot`: chunks follow. `catchup`: the missed transactions follow as
       * `txn`. `download`: the file is fetched with `ticket` (a client that
       * said it can, and a file of more than INLINE_SNAPSHOT_NODES); the
       * snapshot's header says its revision, and every transaction after it
       * follows as `txn`, some perhaps before it's read.
       */
      readonly mode: "snapshot" | "catchup" | "download";
      /** With `download`: what `GET /api/files/:id/document?ticket=` takes, for a few minutes. */
      readonly ticket?: string;
      /** Highest `seq` the room has accepted from this client id, so it can drop acknowledged resends. */
      readonly lastSeq: number;
      /**
       * How the file stores copies (decision 0029): the snapshot that follows is
       * in this form, and the room takes changes only in it. When it changes
       * (the file converted), the room sends `resync`.
       */
      readonly copies: CopiesFormat;
    }
  | { readonly t: "snapshot"; readonly nodes: readonly NodeRecord[]; readonly done: boolean }
  | ({ readonly t: "txn" } & RemoteTxn)
  | { readonly t: "ack"; readonly seq: number; readonly revn: number }
  | {
      readonly t: "reject";
      readonly seq: number;
      readonly code: string;
      readonly message: string;
      /**
       * The current state of every node the rejected transaction touched
       * (`null` for nodes that don't exist), so the client can restore them.
       */
      readonly fix: Readonly<Record<string, NodeRecord | null>>;
    }
  | { readonly t: "peer"; readonly peer: Peer }
  | { readonly t: "peer-left"; readonly sessionId: string }
  | { readonly t: "presence"; readonly sessionId: string; readonly presence: Presence }
  | { readonly t: "pong" }
  | { readonly t: "error"; readonly code: string; readonly message: string }
  /** A comment thread changed. Comments live in D1; the Worker asks the room to relay this after each write. */
  | { readonly t: "comments"; readonly event: CommentEvent }
  /**
   * The document changed too much at once to send as one change (restoring a
   * large version): forget local state and say hello again with no revision.
   * Pending edits are kept and resent.
   */
  | { readonly t: "resync" }
  /**
   * An owner changed your role on the file's team while you had it open:
   * from now on the room treats you as `role` (a viewer's edits are refused).
   * Being removed closes the socket with 4401 instead.
   */
  | {
      readonly t: "role";
      readonly role: "owner" | "editor" | "viewer";
      /** The role before, to say what changed. */
      readonly previous: "owner" | "editor" | "viewer";
      /** Who changed it: maybe you, in another tab. */
      readonly by: { readonly id: string; readonly name: string };
    }
  /**
   * This file is a branch, and someone merged it into its main file: it's
   * read-only history from now on, and the room treats everyone as a viewer.
   */
  | {
      readonly t: "merged";
      readonly by: { readonly id: string; readonly name: string };
    }
  /** This file is a branch, and someone brought main's latest changes into it. Sent after the change. */
  | {
      readonly t: "updated-from-main";
      readonly by: { readonly id: string; readonly name: string };
      /** How many of main's changes came in. */
      readonly changes: number;
    }
  /** Someone merged a branch into this file. Sent after the change itself. */
  | {
      readonly t: "merged-in";
      readonly by: { readonly id: string; readonly name: string };
      readonly branch: { readonly id: string; readonly name: string };
      /** How many changes it took. */
      readonly changes: number;
    }
  /** Someone restored the whole file to a saved version. Sent after the change itself. */
  | {
      readonly t: "restored";
      readonly by: { readonly userId: string; readonly name: string };
      readonly version: RestoredVersion;
    };

export interface RestoredVersion {
  readonly id: string;
  /** The version's name, or null for an autosave. */
  readonly name: string | null;
  /** When the version was saved, in epoch milliseconds. */
  readonly at: number;
}
