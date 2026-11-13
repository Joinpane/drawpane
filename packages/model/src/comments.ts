/**
 * Comments: threads anchored to a point on a page, optionally pinned to a
 * layer so they move with it. They live in D1 (not in the file's Durable
 * Object) so the dashboard can list mentions across files. The REST API
 * returns these shapes, and the FileRoom relays changes to everyone in the
 * file as a `comments` server message.
 */
import { z } from "zod";
import { ID_PATTERN } from "./ids";

/** Longest comment body, in characters. */
export const MAX_COMMENT_LENGTH = 5_000;

/** Most people one comment can mention. */
export const MAX_MENTIONS = 20;

/**
 * Where a thread sits. `x`/`y` are page coordinates, used when the thread
 * isn't pinned to a layer or the layer was deleted. A pinned thread also
 * stores `nodeId` and `offset`, a point in that layer's local box (before
 * rotation and flips), so the pin follows the layer as it moves, rotates or
 * changes frames.
 */
export interface CommentAnchor {
  readonly x: number;
  readonly y: number;
  readonly nodeId: string | null;
  readonly offset: { readonly x: number; readonly y: number } | null;
}

export interface CommentPerson {
  readonly id: string;
  readonly name: string;
}

export interface CommentMessage {
  readonly id: string;
  /** Null when the author's account was deleted. */
  readonly author: CommentPerson | null;
  readonly body: string;
  /** People mentioned in `body`, written there as `@Name`. */
  readonly mentions: readonly CommentPerson[];
  readonly createdAt: number;
  readonly editedAt: number | null;
}

export interface CommentThread {
  readonly id: string;
  readonly fileId: string;
  readonly pageId: string;
  readonly anchor: CommentAnchor;
  /** Who started the thread. Null when their account was deleted. */
  readonly author: CommentPerson | null;
  readonly createdAt: number;
  /** Last activity: a new reply, an edit, resolving or reopening. Lists sort by it. */
  readonly updatedAt: number;
  readonly resolvedAt: number | null;
  readonly resolvedBy: CommentPerson | null;
  /** Oldest first. The first message opened the thread. */
  readonly messages: readonly CommentMessage[];
}

/** What the FileRoom relays after a comment write. */
export type CommentEvent =
  | { readonly kind: "thread"; readonly thread: CommentThread }
  | { readonly kind: "deleted"; readonly threadId: string };

// ---------------------------------------------------------------------------
// Request bodies, shared by the Worker and any client (the app, agents).

const Id = z.string().regex(ID_PATTERN, "That id isn't valid.");
const Coordinate = z
  .number({ error: "Coordinates must be numbers." })
  .refine(Number.isFinite, "Coordinates must be finite numbers.")
  .refine((n) => Math.abs(n) <= 1e7, "That point is too far from the page origin.");

export const CommentBody = z
  .string({ error: "Write a comment first." })
  .trim()
  .min(1, "Write a comment first.")
  .max(MAX_COMMENT_LENGTH, `Keep comments under ${MAX_COMMENT_LENGTH} characters.`);

export const CommentMentions = z
  .array(Id)
  .max(MAX_MENTIONS, `Mention at most ${MAX_MENTIONS} people in one comment.`)
  .default([]);

export const NewCommentThread = z
  .object({
    pageId: Id,
    x: Coordinate,
    y: Coordinate,
    nodeId: Id.nullable().default(null),
    offset: z.object({ x: Coordinate, y: Coordinate }).nullable().default(null),
    body: CommentBody,
    mentions: CommentMentions,
  })
  .refine((v) => (v.nodeId === null) === (v.offset === null), {
    message: "A pinned comment needs both a layer and an offset.",
  });
export type NewCommentThread = z.input<typeof NewCommentThread>;

export const NewCommentReply = z.object({ body: CommentBody, mentions: CommentMentions });
export type NewCommentReply = z.input<typeof NewCommentReply>;

export const CommentEdit = z.object({ body: CommentBody, mentions: CommentMentions });
export type CommentEdit = z.input<typeof CommentEdit>;

/** Where a thread moves to: a page point, optionally pinned to a layer (like a new thread). */
export const CommentAnchorInput = z
  .object({
    x: Coordinate,
    y: Coordinate,
    nodeId: Id.nullable().default(null),
    offset: z.object({ x: Coordinate, y: Coordinate }).nullable().default(null),
  })
  .refine((v) => (v.nodeId === null) === (v.offset === null), {
    message: "A pinned comment needs both a layer and an offset.",
  });

/** Resolve or reopen a thread, move its pin, or both. */
export const CommentThreadPatch = z
  .object({
    resolved: z.boolean({ error: "Say whether the thread is resolved." }).optional(),
    anchor: CommentAnchorInput.optional(),
  })
  .refine((v) => v.resolved !== undefined || v.anchor !== undefined, {
    message: "Say what to change: resolved, or where the comment goes.",
  });
export type CommentThreadPatch = z.input<typeof CommentThreadPatch>;
