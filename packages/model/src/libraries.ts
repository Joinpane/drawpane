/**
 * Team libraries (docs/decisions/0010-team-libraries.md): what a publish
 * holds, shared by the API and the editor.
 */
import { z } from "zod";
import { heldNodeIds } from "./convert";
import type { VersionPerson } from "./history";
import { ID_PATTERN, ROOT_ID } from "./ids";
import type { NodeRecord } from "./ops";
import { getProp, type Props } from "./schema";

/** A content hash of everything a published component draws: what tells a change. */
export const ASSET_HASH = /^[0-9a-f]{16}$/;

/** A component (or set of variants) a publish offers. */
export const LibraryAsset = z.object({
  /** Its main component's (or set's) id in the library file. */
  id: z.string().regex(ID_PATTERN),
  name: z.string().max(256),
  description: z.string().max(2000),
  /** A set of variants, inserted as its first variant. */
  set: z.boolean(),
  hash: z.string().regex(ASSET_HASH),
});
export type LibraryAsset = z.infer<typeof LibraryAsset>;

/** At most this many components per publish. */
export const MAX_LIBRARY_ASSETS = 2000;

export const LibraryAssets = z.array(LibraryAsset).max(MAX_LIBRARY_ASSETS);

/** One publish of a library: its version of the file, and what it offers. */
export interface LibraryPublish {
  readonly id: string;
  /** The library's file, and its name now. */
  readonly fileId: string;
  readonly fileName: string;
  /** The version holding the published snapshot, and its revision. */
  readonly versionId: string;
  readonly revn: number;
  readonly publishedAt: number;
  readonly publishedBy: VersionPerson | null;
  /** What changed, as its publisher put it. */
  readonly description: string | null;
  readonly assets: readonly LibraryAsset[];
}

// ---------------------------------------------------------------------------
// What a library offers, from any document (the editor's, or a snapshot's nodes)

/** What reading a library takes from a document: the editor's `Doc`, or `nodeReader(nodes)`. */
export interface DocReader {
  get(id: string): NodeRecord | undefined;
  childIds(parent: string): readonly string[];
  /** Page ids in file order, as they're asked for (a file may have any number of pages). */
  pageIds(): Iterable<string>;
  /**
   * The ids of what the file offers as components (a main, or the set a
   * main is a variant of), each once, in file order, when the reader can
   * find them without walking every layer (the Worker's reader over
   * SQLite). Past `max` of them, any `max + 1` of them, in no order, so
   * nothing past the limit is read.
   */
  componentAssets?(max: number): readonly string[];
  /**
   * A node's child ids in order, read a page at a time as they're asked
   * for, when the reader can (SQLite): what a walk over a large file reads
   * instead of `childIds`, so it never holds every child of a wide node.
   */
  children?(parent: string): Iterable<string>;
}

/** A node's child ids in order, a page at a time where the reader can. */
function childrenOf(doc: DocReader, parent: string): Iterable<string> {
  return doc.children ? doc.children(parent) : doc.childIds(parent);
}

/**
 * A node and everything inside it, parents first, children in order, one at
 * a time: what's held is the path down to the node it's at, not the subtree.
 */
export function* walkSubtree(doc: DocReader, id: string): Generator<NodeRecord> {
  const root = doc.get(id);
  if (!root) return;
  yield root;
  const stack: Iterator<string>[] = [childrenOf(doc, id)[Symbol.iterator]()];
  while (stack.length > 0) {
    const next = (stack[stack.length - 1] as Iterator<string>).next();
    if (next.done) {
      stack.pop();
      continue;
    }
    const node = doc.get(next.value);
    // A child that isn't there is left out, with whatever it holds.
    if (!node) continue;
    yield node;
    stack.push(childrenOf(doc, node.id)[Symbol.iterator]());
  }
}

/** A reader over a snapshot's nodes (in the Worker, which has no editor). */
export function nodeReader(nodes: readonly NodeRecord[]): DocReader {
  const byId = new Map<string, NodeRecord>();
  const children = new Map<string, NodeRecord[]>();
  for (const node of nodes) {
    byId.set(node.id, node);
    const list = children.get(node.parent);
    if (list) list.push(node);
    else children.set(node.parent, [node]);
  }
  const ids = new Map<string, readonly string[]>();
  for (const [parent, list] of children)
    ids.set(
      parent,
      list
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1))
        .map((n) => n.id),
    );
  return {
    get: (id) => byId.get(id),
    childIds: (parent) => ids.get(parent) ?? [],
    pageIds: () => (ids.get(ROOT_ID) ?? []).filter((id) => byId.get(id)?.type === "page"),
  };
}

const isMain = (node: NodeRecord | undefined) =>
  node?.type === "frame" && getProp(node.props, "isComponent");
const isSet = (node: NodeRecord | undefined) =>
  node?.type === "frame" && getProp(node.props, "isComponentSet");
/** The set a main component is a variant of. */
function setOf(doc: DocReader, id: string): NodeRecord | undefined {
  const node = doc.get(id);
  const parent = node ? doc.get(node.parent) : undefined;
  return isMain(node) && isSet(parent) ? parent : undefined;
}
/**
 * What the file offers, each once, in file order: a main, or the set it's a
 * variant of. Past `max`, `max + 1` of them (see `DocReader.componentAssets`).
 */
function assetIds(doc: DocReader, max: number): readonly string[] {
  if (doc.componentAssets) return doc.componentAssets(max);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const page of doc.pageIds())
    for (const node of walkSubtree(doc, page)) {
      if (node.id === page || !isMain(node)) continue;
      const id = setOf(doc, node.id)?.id ?? node.id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length > max) return out;
    }
  return out;
}

// ---------------------------------------------------------------------------
// Hashing

/**
 * cyrb53, a fast, well-mixed 53-bit hash of a string, taken a piece at a
 * time: the hash of pieces fed in turn is the hash of their concatenation.
 */
class Cyrb53 {
  #h1: number;
  #h2: number;

  constructor(seed: number) {
    this.#h1 = 0xdeadbeef ^ seed;
    this.#h2 = 0x41c6ce57 ^ seed;
  }

  update(text: string): void {
    let h1 = this.#h1;
    let h2 = this.#h2;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    this.#h1 = h1;
    this.#h2 = h2;
  }

  digest(): number {
    let h1 = this.#h1;
    let h2 = this.#h2;
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
}

/** 64 bits of hash (two cyrb53 seeds), as 16 hex digits, taken a piece at a time. */
class Hash64 {
  readonly #a = new Cyrb53(1);
  readonly #b = new Cyrb53(2);

  update(text: string): this {
    this.#a.update(text);
    this.#b.update(text);
    return this;
  }

  digest(): string {
    const hex = (n: number) => (n % 4294967296).toString(16).padStart(8, "0");
    return hex(this.#a.digest()) + hex(this.#b.digest());
  }
}

/** 64 bits of a string's hash, as 16 hex digits. */
export function hash64(text: string): string {
  return new Hash64().update(text).digest();
}

/** JSON with object keys sorted, so equal values hash (and compare) alike. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * The id a library node's copy has in a file that uses the library: derived
 * from the library's file and the node, so it's the same in every file and
 * every update, and never one of the file's own.
 */
export function libraryNodeId(libraryFileId: string, nodeId: string): string {
  return `lib${hash64(`${libraryFileId}\u0000${nodeId}`)}`;
}

/** The node a file keeps a library's copies under. */
export function libraryContainerId(libraryFileId: string): string {
  return libraryNodeId(libraryFileId, ROOT_ID);
}

// ---------------------------------------------------------------------------
// What a component needs

/** The variable collection a variable belongs to. */
function collectionOf(doc: DocReader, variableId: string): string | null {
  const variable = doc.get(variableId);
  return variable?.type === "variable" ? variable.parent : null;
}

/** The nodes another node points at: what its copy needs to be there too. */
function references(doc: DocReader, node: NodeRecord): string[] {
  const out: string[] = [];
  const p = node.props as Record<string, unknown>;
  if (typeof p.instanceOf === "string") out.push(setOf(doc, p.instanceOf)?.id ?? p.instanceOf);
  if (typeof p.textStyle === "string") out.push(p.textStyle);
  if (p.values && typeof p.values === "object")
    for (const value of Object.values(p.values as Record<string, unknown>))
      if (value && typeof value === "object" && "alias" in value) {
        const collection = collectionOf(doc, (value as { alias: string }).alias);
        if (collection) out.push(collection);
      }
  if (p.bindings && typeof p.bindings === "object")
    for (const variableId of Object.values(p.bindings as Record<string, string>)) {
      const collection = collectionOf(doc, variableId);
      if (collection) out.push(collection);
    }
  if (p.variableModes && typeof p.variableModes === "object")
    out.push(...Object.keys(p.variableModes as Record<string, string>));
  // Shared styles it links, and the collections of what its paints and effects bind (decision 0034).
  for (const link of [p.fillStyle, p.strokeStyle, p.effectStyle])
    if (typeof link === "string") out.push(link);
  for (const variableId of heldNodeIds({
    fills: p.fills,
    strokes: p.strokes,
    effects: p.effects,
  } as Props).others) {
    const collection = collectionOf(doc, variableId);
    if (collection) out.push(collection);
  }
  return out;
}

/**
 * A node and everything inside it, parents first, children in order, as an
 * array (for the editor; a walk over a file of any size uses `walkSubtree`).
 */
export function subtree(doc: DocReader, id: string): NodeRecord[] {
  return [...walkSubtree(doc, id)];
}

/**
 * What copying `assetIds` takes: the top nodes to copy (the assets, the
 * mains, text styles and collections they use, and so on), in the order
 * they're found, without any inside another.
 */
export function dependencyRoots(doc: DocReader, assetIds: Iterable<string>): string[] {
  const roots: string[] = [];
  // Each id queued once, in the order first found: the queue holds what's referenced, not
  // every reference (a large component's copies all naming the same few mains).
  const queue: string[] = [];
  const queued = new Set<string>();
  const enqueue = (id: string) => {
    if (queued.has(id)) return;
    queued.add(id);
    queue.push(id);
  };
  for (const id of assetIds) enqueue(id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    if (!doc.get(id)) continue;
    roots.push(id);
    for (const node of walkSubtree(doc, id)) for (const ref of references(doc, node)) enqueue(ref);
  }
  const rootSet = new Set(roots);
  const insideAnother = (id: string) => {
    for (let n = doc.get(doc.get(id)?.parent ?? ""); n; n = doc.get(n.parent))
      if (rootSet.has(n.id)) return true;
    return false;
  };
  return roots.filter((id) => !insideAnother(id));
}

/** Props that place a top node in its own file: not part of what it looks like. */
const PLACEMENT = new Set(["x", "y", "positioning", "constraintH", "constraintV"]);

/**
 * A content hash of everything a component (or set) draws: its layers and
 * the mains, text styles and variables it uses. Where it sits on its page
 * doesn't count.
 */
export function assetHash(doc: DocReader, assetId: string): string {
  // A line per node, hashed as it's read: the same hash as the lines joined, without the join.
  const hash = new Hash64();
  let first = true;
  for (const root of dependencyRoots(doc, [assetId]))
    for (const node of walkSubtree(doc, root)) {
      const props =
        node.id === root
          ? Object.fromEntries(Object.entries(node.props).filter(([k]) => !PLACEMENT.has(k)))
          : node.props;
      if (!first) hash.update("\n");
      first = false;
      hash.update(stableJson([node.id, node.type, node.id === root ? "" : node.key, props]));
    }
  return hash.digest();
}

/** What a library file offers: its components, a set of variants as one, in file order. */
export function libraryAssets(doc: DocReader): LibraryAsset[] {
  return libraryAssetsWithin(doc, Number.POSITIVE_INFINITY) ?? [];
}

/**
 * What a library offers, or null when that's more than `max` components:
 * counted before any is hashed or its values read, so a file of 40,000
 * components is refused without holding them.
 */
export function libraryAssetsWithin(doc: DocReader, max: number): LibraryAsset[] | null {
  const ids = assetIds(doc, max);
  if (ids.length > max) return null;
  const out: LibraryAsset[] = [];
  for (const id of ids) {
    const asset = doc.get(id);
    if (!asset) continue;
    // A main is offered as itself (it comes before its variants, were it a set too).
    const set = !isMain(asset);
    out.push({
      id,
      name: getProp(asset.props, "name") || (set ? "Set" : "Component"),
      description: getProp(asset.props, "componentDescription"),
      set,
      hash: assetHash(doc, id),
    });
  }
  return out;
}

/** The main to instance for an asset: itself, or a set's first variant. */
export function assetMain(doc: DocReader, assetId: string): string | null {
  const node = doc.get(assetId);
  if (isMain(node)) return assetId;
  if (isSet(node)) return doc.childIds(assetId).find((id) => isMain(doc.get(id))) ?? null;
  return null;
}

/** What changed between two publishes' assets. */
export interface AssetChanges {
  readonly added: readonly LibraryAsset[];
  readonly changed: readonly LibraryAsset[];
  readonly removed: readonly LibraryAsset[];
}

export function assetChanges(
  from: readonly LibraryAsset[],
  to: readonly LibraryAsset[],
): AssetChanges {
  const before = new Map(from.map((a) => [a.id, a]));
  const after = new Set(to.map((a) => a.id));
  return {
    added: to.filter((a) => !before.has(a.id)),
    changed: to.filter((a) => {
      const old = before.get(a.id);
      return old !== undefined && old.hash !== a.hash;
    }),
    removed: from.filter((a) => !after.has(a.id)),
  };
}
