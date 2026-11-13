/**
 * Typed operations: the single action language shared by the editor, the
 * command bar, the FileRoom, MCP tools and agents.
 */
import { z } from "zod";
import { ID_PATTERN } from "./ids";
import { MAX_ORDER_KEY_LENGTH } from "./order-key";
import { NODE_TYPES, type NodeType, type PropName, type Props } from "./schema";

export interface NodeRecord {
  readonly id: string;
  readonly type: NodeType;
  /** Parent node id, or `ROOT_ID` for pages. */
  readonly parent: string;
  /** Order key among siblings. */
  readonly key: string;
  readonly props: Readonly<Props>;
}

export type CreateOp = {
  readonly op: "create";
  readonly id: string;
  readonly type: NodeType;
  readonly parent: string;
  readonly key: string;
  readonly props: Readonly<Props>;
};
/** Deletes a node and everything inside it. */
export type DeleteOp = { readonly op: "delete"; readonly id: string };
/** Sets one property. `null` resets it to its default. */
export type SetOp = {
  readonly op: "set";
  readonly id: string;
  readonly prop: PropName;
  readonly value: unknown;
};
export type MoveOp = {
  readonly op: "move";
  readonly id: string;
  readonly parent: string;
  readonly key: string;
};
export type Op = CreateOp | DeleteOp | SetOp | MoveOp;

/** Most operations accepted in one transaction (a large paste stays well under this). */
export const MAX_OPS_PER_TRANSACTION = 20_000;

const Id = z.string().regex(ID_PATTERN);
const Key = z.string().min(1).max(MAX_ORDER_KEY_LENGTH);
const PropKey = z.string().min(1).max(64);

/**
 * Structural shape of an operation. Property names and values are checked
 * against the node type later, in `applyOp`, because they depend on the store.
 */
export const OpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create"),
    id: Id,
    type: z.enum(NODE_TYPES),
    parent: Id,
    key: Key,
    props: z.record(PropKey, z.unknown()),
  }),
  z.object({ op: z.literal("delete"), id: Id }),
  z.object({ op: z.literal("set"), id: Id, prop: PropKey, value: z.unknown() }),
  z.object({ op: z.literal("move"), id: Id, parent: Id, key: Key }),
]);

export const OpsSchema = z.array(OpSchema).min(1).max(MAX_OPS_PER_TRANSACTION);

/** Parses untrusted input into operations, or throws a `z.ZodError`. */
export function parseOps(input: unknown): Op[] {
  return OpsSchema.parse(input) as Op[];
}
