/**
 * The one-step migration of a file stored before decision 0034's semantics,
 * run by its room when it next loads (and on a version restored from
 * before), before anyone reads it.
 *
 * Layer opacity bound to a number variable: Drawpane read a value of 1 or
 * less as a fraction (0.5 was 50%) and anything larger as a percentage. Now
 * every value is a percentage, as Figma's are. So that no file changes how
 * it looks, nothing is reinterpreted:
 * - a variable bound only to layer opacity (nothing else binds it, nothing
 *   aliases it, it holds literals) has each fraction multiplied by 100 in
 *   place: 0.5 becomes 50, which reads as 50% as it did;
 * - a variable used for anything else too (a width, a gap, an alias) keeps
 *   its values: the layers binding it to opacity are bound instead to a new
 *   variable beside it, "<name> (opacity %)", holding the percentages it
 *   read as in each of its collection's modes.
 *
 * Everything else from before reads as it did (the old `fill` and `stroke`
 * keys are still resolved), so it needs nothing.
 */

import type { NodeRecord, Op } from "./ops";
import { keyBetween } from "./order-key";
import { getProp, type Props, type VariableValue } from "./schema";
import { MAX_ALIAS_DEPTH, tokenRefs } from "./tokens";

/**
 * The token semantics a file's nodes are stored in: 0 before decision 0034
 * (opacity variables read as fractions up to 1), 1 since. A room keeps it in
 * its meta (`tokens`), and a snapshot in its header; a file at 0 is migrated
 * by `legacyTokenOps` when its room loads it.
 */
export const TOKENS_VERSION = 1;

/** The id of the opacity variable split off a shared one (the same for the same variable). */
export function opacityVariableId(variableId: string): string {
  return `${variableId.slice(0, 56)}_opacity`.slice(-64);
}

interface Variable {
  readonly node: NodeRecord;
  readonly values: Record<string, VariableValue>;
}

/**
 * The operations migrating `nodes` (every node of a file stored at token
 * version 0, read once, in any order) to `TOKENS_VERSION`. Empty when
 * nothing needs it. Holds the file's variables and collections, and the
 * bindings of layers bound to opacity, not the file.
 */
export function legacyTokenOps(nodes: Iterable<NodeRecord>): Op[] {
  const variables = new Map<string, Variable>();
  const modesOf = new Map<string, string[]>();
  const opacityUsers = new Map<string, Array<{ id: string; bindings: Record<string, string> }>>();
  /** Variables bound to anything other than layer opacity, or aliased by another. */
  const shared = new Set<string>();
  for (const node of nodes) {
    if (node.type === "collection") {
      modesOf.set(
        node.id,
        getProp(node.props, "modes").map((m) => m.id),
      );
      continue;
    }
    if (node.type === "variable") {
      const values = getProp(node.props, "values");
      variables.set(node.id, { node, values });
      for (const value of Object.values(values))
        if (value && typeof value === "object") shared.add(value.alias);
      continue;
    }
    const bindings = (node.props as Props).bindings as Record<string, string> | undefined;
    const opacity = bindings?.opacity;
    if (bindings && typeof opacity === "string") {
      const list = opacityUsers.get(opacity) ?? [];
      list.push({ id: node.id, bindings });
      opacityUsers.set(opacity, list);
    }
    const refs = tokenRefs(node.props);
    let opacityRefs = typeof opacity === "string" ? 1 : 0;
    for (const id of refs.variables) {
      if (id === opacity && opacityRefs > 0) {
        opacityRefs--;
        continue;
      }
      shared.add(id);
    }
  }

  /** A variable's number in a mode, aliases followed (another collection's in its first mode). */
  const literal = (id: string, mode: string, depth = 0): number | undefined => {
    const variable = variables.get(id);
    if (!variable || depth >= MAX_ALIAS_DEPTH) return undefined;
    if (getProp(variable.node.props, "variableType") !== "number") return undefined;
    const modes = modesOf.get(variable.node.parent) ?? [];
    const at = modes.includes(mode) ? mode : modes[0];
    const value =
      (at ? variable.values[at] : undefined) ??
      (modes[0] ? variable.values[modes[0]] : undefined) ??
      Object.values(variable.values)[0];
    if (value === undefined) return undefined;
    if (typeof value === "object") return literal(value.alias, mode, depth + 1);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  /** What a value read as before, as a percentage. */
  const percent = (v: number) => (v > 0 && v <= 1 ? v * 100 : v);

  const ops: Op[] = [];
  for (const [id, users] of opacityUsers) {
    const variable = variables.get(id);
    if (!variable || getProp(variable.node.props, "variableType") !== "number") continue;
    const modes = modesOf.get(variable.node.parent) ?? Object.keys(variable.values);
    const read = new Map<string, number>();
    for (const mode of modes) {
      const v = literal(id, mode);
      if (v !== undefined) read.set(mode, v);
    }
    if (![...read.values()].some((v) => v > 0 && v <= 1)) continue;
    const literals = Object.values(variable.values).every((v) => typeof v === "number");
    if (!shared.has(id) && literals) {
      const values: Record<string, VariableValue> = {};
      for (const [mode, v] of Object.entries(variable.values))
        values[mode] = typeof v === "number" ? percent(v) : v;
      ops.push({ op: "set", id, prop: "values", value: values });
      continue;
    }
    const fork = opacityVariableId(id);
    const values: Record<string, number> = {};
    for (const [mode, v] of read) values[mode] = percent(v);
    const name = getProp(variable.node.props, "name") || "Opacity";
    ops.push({
      op: "create",
      id: fork,
      type: "variable",
      parent: variable.node.parent,
      key: keyBetween(variable.node.key, null),
      props: {
        name: `${name.slice(0, 240)} (opacity %)`,
        variableType: "number",
        values,
        scopes: ["OPACITY"],
      } as Props,
    });
    for (const user of users)
      ops.push({
        op: "set",
        id: user.id,
        prop: "bindings",
        value: { ...user.bindings, opacity: fork },
      });
  }
  return ops;
}

/**
 * `nodes` (a whole file at token version 0: a snapshot saved before
 * decision 0034, a library published before it) migrated as its room would
 * migrate it. The same array when nothing needs it.
 */
export function migratedNodes(nodes: readonly NodeRecord[]): NodeRecord[] {
  const ops = legacyTokenOps(nodes);
  if (ops.length === 0) return nodes as NodeRecord[];
  const sets = new Map<string, Record<string, unknown>>();
  const out: NodeRecord[] = [];
  for (const op of ops)
    if (op.op === "set") sets.set(op.id, { ...sets.get(op.id), [op.prop]: op.value });
    else if (op.op === "create")
      out.push({ id: op.id, type: op.type, parent: op.parent, key: op.key, props: op.props });
  return [
    ...nodes.map((node) => {
      const set = sets.get(node.id);
      return set ? { ...node, props: { ...node.props, ...set } as Props } : node;
    }),
    ...out,
  ];
}
