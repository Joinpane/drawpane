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
/**
 * Sets one property. `null` resets it to its default. With `key`, on a
 * property whose value is a map (`KEYED_PROPS`: an instance's `propValues`),
 * it sets that one entry, and `null` removes the entry: entries are written,
 * undone and merged on their own, so two people setting different entries
 * never undo each other's (decision 0035, item 15).
 */
export type SetOp = {
  readonly op: "set";
  readonly id: string;
  readonly prop: PropName;
  readonly key?: string;
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
  z.object({
    op: z.literal("set"),
    id: Id,
    prop: PropKey,
    key: PropKey.optional(),
    value: z.unknown(),
  }),
  z.object({ op: z.literal("move"), id: Id, parent: Id, key: Key }),
]);

export const OpsSchema = z.array(OpSchema).min(1).max(MAX_OPS_PER_TRANSACTION);

/**
 * Structural shape of a node record (an import, a snapshot). As with ops,
 * its props are checked against its type when it's created in a store.
 */
export const NodeRecordSchema = z.object({
  id: Id,
  type: z.enum(NODE_TYPES),
  parent: Id,
  key: Key,
  props: z.record(PropKey, z.unknown()),
});

/** Parses untrusted input into operations, or throws a `z.ZodError`. */
export function parseOps(input: unknown): Op[] {
  return OpsSchema.parse(input) as Op[];
}

/**
 * What a `set` writes, as properties: `{ [prop]: value }`, or for a keyed
 * set `{ [prop]: { [key]: value } }`, so what reads ids held in values
 * (`heldNodeIds`) reads an entry as it reads the map.
 */
export function setOpProps(op: SetOp): Props {
  return (
    op.key === undefined ? { [op.prop]: op.value } : { [op.prop]: { [op.key]: op.value } }
  ) as Props;
}

/** `op` with the value `setOpProps` gave, after a change to `props` (renamed ids). */
export function withSetProps(op: SetOp, props: Readonly<Props>): SetOp {
  const value = (props as Record<string, unknown>)[op.prop];
  if (op.key === undefined) return { ...op, value };
  return { ...op, value: (value as Record<string, unknown> | undefined)?.[op.key] ?? null };
}
