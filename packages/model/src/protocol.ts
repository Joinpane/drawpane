/**
 * The file websocket protocol (`/ws/files/:id`). Messages are JSON.
 *
 * Ordering model: the FileRoom gives every accepted transaction the next
 * revision number (`revn`). Clients apply their own transactions at once and
 * keep them pending until `ack`; everyone else receives them as `txn`.
 */
import { z } from "zod";
import type { CommentEvent } from "./comments";
import { ID_PATTERN } from "./ids";
import { type NodeRecord, type Op, OpsSchema } from "./ops";

export const PROTOCOL_VERSION = 1;

/** Nodes per snapshot chunk, so a big file never becomes one huge frame. */
export const SNAPSHOT_CHUNK_SIZE = 2_000;

/** Largest client message accepted, in bytes. */
export const MAX_CLIENT_MESSAGE_BYTES = 4 * 1024 * 1024;

const Id = z.string().regex(ID_PATTERN);

export const Presence = z.object({
  /** Pointer in page coordinates, or null when the pointer left the canvas. */
  cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
  pageId: Id.nullable(),
  selection: z.array(Id).max(500),
});
export type Presence = z.infer<typeof Presence>;

export const ClientMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    protocol: z.literal(PROTOCOL_VERSION),
    /** Stable per browser tab; used to make resent transactions idempotent. */
    clientId: Id,
    /** Last revision this client has fully applied, or null for a fresh load. */
    revn: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    t: z.literal("txn"),
    /** Per-client sequence number, increasing by one per transaction. */
    seq: z.number().int().positive(),
    ops: OpsSchema,
  }),
  z.object({ t: z.literal("presence"), presence: Presence }),
  z.object({ t: z.literal("ping") }),
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
      /** `snapshot`: chunks follow. `catchup`: the missed transactions follow as `txn`. */
      readonly mode: "snapshot" | "catchup";
      /** Highest `seq` the room has accepted from this client id, so it can drop acknowledged resends. */
      readonly lastSeq: number;
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
