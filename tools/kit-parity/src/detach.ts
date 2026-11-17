/**
 * How many of a converted file's instances the compact form (decision 0029)
 * keeps as instances, and why the rest are detached: `compactByInstance`,
 * as the import runs it before upload, on the nodes `convert.ts` saved (or
 * on a stored snapshot's lines), with each detach's reason grouped by kind
 * and, for a layer the main doesn't have, what that layer is.
 */
import { readFileSync } from "node:fs";
import { Doc, isInstanceRoot, syncInstanceOps } from "@drawpane/editor";
import {
  compactByInstance,
  isMainNode,
  MemoryStore,
  type NodeRecord,
  ROOT_ID,
  topLevelRoots,
} from "@drawpane/model";

/** Nodes from lines of JSON (a snapshot's header line, if any, is skipped). */
export function readNodes(path: string): NodeRecord[] {
  const nodes: NodeRecord[] = [];
  const text = readFileSync(path, "utf8");
  let at = 0;
  while (at < text.length) {
    let end = text.indexOf("\n", at);
    if (end < 0) end = text.length;
    const line = text.slice(at, end);
    at = end + 1;
    if (!line.trim()) continue;
    const value = JSON.parse(line);
    if (value && typeof value.id === "string" && typeof value.type === "string") nodes.push(value);
  }
  return nodes;
}

/** A reason with its ids taken out, so reasons of one kind group. */
export function reasonKind(why: string): string {
  return why
    .replace(/\bf?I?[0-9]+[-:][0-9]+(?:[;_][0-9]+[-:][0-9]+)*\b/g, "<id>")
    .replace(/\b[0-9A-Za-z]{16}\b/g, "<copy>")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b\d+(\.\d+)?\b/g, "<n>");
}

export interface DetachReport {
  readonly nodes: number;
  readonly stored: number;
  readonly overrides: number;
  readonly topLevel: { readonly total: number; readonly kept: number; readonly detached: number };
  /** Instance roots anywhere (nested ones included), before and after. */
  readonly instanceRoots: {
    readonly before: number;
    /** Still a stored, linked instance root (top level, or inside a main). */
    readonly keptStored: number;
    /** Inside a kept instance: presented from its main, not stored. */
    readonly compacted: number;
    /** Unlinked: a detached root, or a nested instance inside one. */
    readonly detached: number;
  };
  readonly reasons: { readonly kind: string; readonly count: number; readonly example: string }[];
  /** For "no copy of X": what X and the instance's layer copying it are, grouped. */
  readonly missing: {
    readonly shape: string;
    readonly count: number;
    readonly examples: string[];
  }[];
  readonly detachedRoots: { readonly id: string; readonly why: string }[];
}

const instanceOf = (node: NodeRecord | undefined): string | undefined =>
  node?.type === "frame" ? (node.props.instanceOf as string | undefined) : undefined;

/** Runs the compact conversion on `nodes` and reports what it kept and detached. */
export function measureDetaches(
  nodes: NodeRecord[],
  log: (line: string) => void = () => {},
): DetachReport {
  const before = new MemoryStore(nodes);
  const isLive = (node: NodeRecord) => {
    const of = instanceOf(node);
    return !!of && of !== node.id && isMainNode(before.get(of));
  };
  const liveBefore = new Set<string>();
  for (const node of before.nodes()) if (isLive(node)) liveBefore.add(node.id);
  const { roots } = topLevelRoots(
    (id) => before.get(id),
    (parent) => before.childIds(parent),
    ROOT_ID,
  );
  log(`  ${nodes.length} nodes, ${liveBefore.size} instance roots, ${roots.length} top level`);

  const started = Date.now();
  const result = compactByInstance(nodes);
  log(`  compacted in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const after = new MemoryStore(result.nodes);

  let keptStored = 0;
  let detachedRoots = 0;
  let overrides = 0;
  for (const node of after.nodes()) {
    if (node.type === "override") overrides++;
    else if (instanceOf(node)) keptStored++;
  }
  for (const id of liveBefore) {
    const now = after.get(id);
    if (now && !instanceOf(now)) detachedRoots++;
  }
  const compacted = liveBefore.size - keptStored - detachedRoots;

  const kinds = new Map<string, { count: number; example: string }>();
  for (const [id, why] of result.detached) {
    const kind = reasonKind(why);
    const entry = kinds.get(kind);
    if (entry) entry.count++;
    else kinds.set(kind, { count: 1, example: `${id}: ${why}` });
  }

  // "no copy of X under Y": the instance has a layer copying X where its main presents none.
  const shapes = new Map<string, { count: number; examples: string[] }>();
  const describe = (node: NodeRecord | undefined): string => {
    if (!node) return "absent";
    const bits: string[] = [node.type];
    if (instanceOf(node)) bits.push("instance");
    if (isMainNode(node)) bits.push("main");
    if (node.props.mirrors) bits.push("copy");
    if (node.props.visible === false) bits.push("hidden");
    return bits.join(" ");
  };
  for (const [rootId, why] of result.detached) {
    const match = /^no copy of (\S+) under (\S+)$/.exec(why);
    if (!match) continue;
    const mirrors = match[1] as string;
    // The instance's layer that copies it.
    let layer: NodeRecord | undefined;
    const stack = [...before.childIds(rootId)];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      const node = before.get(at);
      if (!node) continue;
      if (node.props.mirrors === mirrors) {
        layer = node;
        break;
      }
      stack.push(...before.childIds(at));
    }
    const source = before.get(mirrors);
    const parent = layer ? before.get(layer.parent) : undefined;
    const parentMirrors = parent?.props.mirrors as string | undefined;
    const parentSource = parentMirrors ? before.get(parentMirrors) : undefined;
    // Which main the layer's parent instance presents, and which the source's parent is in.
    const shape = [
      `layer: ${describe(layer)}`,
      `copies: ${describe(source)}`,
      `parent: ${parent?.id === rootId ? "the root" : describe(parent)}`,
      parent &&
      instanceOf(parent) &&
      parentSource &&
      instanceOf(parentSource) !== instanceOf(parent)
        ? "parent swapped"
        : "",
      source && parent && instanceOf(parent) && source.parent !== instanceOf(parent)
        ? "source not under parent's main"
        : "",
    ]
      .filter(Boolean)
      .join("; ");
    const entry = shapes.get(shape) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 5)
      entry.examples.push(
        `${rootId} (${before.get(rootId)?.props.name}): layer ${layer?.id} "${layer?.props.name}" copies ${mirrors} "${source?.props.name}" (parent ${source?.parent}), presented under ${match[2]}`,
      );
    shapes.set(shape, entry);
  }

  const detachedTop = roots.filter((id) => result.detached.has(id)).length;
  return {
    nodes: nodes.length,
    stored: result.nodes.length,
    overrides,
    topLevel: { total: roots.length, kept: roots.length - detachedTop, detached: detachedTop },
    instanceRoots: { before: liveBefore.size, keptStored, compacted, detached: detachedRoots },
    reasons: [...kinds].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.count - a.count),
    missing: [...shapes].map(([shape, v]) => ({ shape, ...v })).sort((a, b) => b.count - a.count),
    detachedRoots: [...result.detached].map(([id, why]) => ({ id, why })),
  };
}

export interface PinReport {
  readonly roots: number;
  readonly detached: number;
  /** Why sync would rebuild each detached copy: its first structural change, grouped. */
  readonly reasons: {
    readonly kind: string;
    readonly count: number;
    readonly examples: string[];
  }[];
}

/**
 * Which instance roots `pinInstances` unlinks (sync would change their
 * structure, not only values), and why: the first operation sync would make
 * that isn't a value, and what it's about.
 */
export function measurePins(nodes: readonly NodeRecord[]): PinReport {
  const doc = new Doc({ compactCopies: false });
  doc.reset(nodes);
  const describe = (id: string): string => {
    const node = doc.get(id);
    if (!node) return "absent";
    const bits: string[] = [node.type];
    if (instanceOf(node)) bits.push("instance");
    if (node.props.visible === false) bits.push("hidden");
    if (!node.props.mirrors) bits.push("copying nothing");
    if (/^fI/.test(node.id)) bits.push("named in a copy");
    return bits.join(" ");
  };
  const kinds = new Map<string, { count: number; examples: string[] }>();
  let roots = 0;
  let detached = 0;
  for (const root of doc.nodes()) {
    if (!isInstanceRoot(root) || root.props.mirrors) continue;
    roots++;
    const ops = syncInstanceOps(doc, root.id);
    const first = ops.find((op) => op.op !== "set");
    if (!first) continue;
    detached++;
    const creates = ops.filter((op) => op.op === "create").length;
    const deletes = ops.filter((op) => op.op === "delete").length;
    const balance =
      creates === deletes ? "as many created" : creates > deletes ? "more created" : "more deleted";
    let kind: string;
    if (first.op === "delete") kind = `delete ${describe(first.id)}`;
    else if (first.op === "create")
      kind = `create ${first.type}${first.props.instanceOf ? " instance" : ""}`;
    else kind = first.op;
    kind += ` (${balance})`;
    const entry = kinds.get(kind) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 5)
      entry.examples.push(
        `${root.id} "${root.props.name}": ${JSON.stringify(first).slice(0, 240)}`,
      );
    kinds.set(kind, entry);
  }
  return {
    roots,
    detached,
    reasons: [...kinds].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.count - a.count),
  };
}
