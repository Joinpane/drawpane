/**
 * Team libraries (docs/decisions/0010-team-libraries.md): what a publish
 * holds, shared by the API and the editor.
 */
import { z } from "zod";
import type { VersionPerson } from "./history";
import { ID_PATTERN, ROOT_ID } from "./ids";
import type { NodeRecord } from "./ops";
import { getProp } from "./schema";

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
  pageIds(): readonly string[];
  /**
   * Every main component on the pages, in file order, when the reader can
   * find them without walking every layer (the Worker's reader over SQLite).
   */
  componentMains?(): NodeRecord[];
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
/** Every main component on the file's pages, in order. */
function mains(doc: DocReader): NodeRecord[] {
  if (doc.componentMains) return doc.componentMains();
  const out: NodeRecord[] = [];
  const walk = (parent: string) => {
    for (const id of doc.childIds(parent)) {
      const node = doc.get(id);
      if (!node) continue;
      if (isMain(node)) out.push(node);
      walk(id);
    }
  };
  for (const page of doc.pageIds()) walk(page);
  return out;
}

// ---------------------------------------------------------------------------
// Hashing

/** cyrb53: a fast, well-mixed 53-bit hash of a string. */
function cyrb53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 64 bits of hash, as 16 hex digits. */
function hash64(text: string): string {
  const hex = (n: number) => (n % 4294967296).toString(16).padStart(8, "0");
  return hex(cyrb53(text, 1)) + hex(cyrb53(text, 2));
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
  return out;
}

/** A node and everything inside it, parents first, children in order. */
export function subtree(doc: DocReader, id: string): NodeRecord[] {
  const out: NodeRecord[] = [];
  const visit = (nodeId: string) => {
    const node = doc.get(nodeId);
    if (!node) return;
    out.push(node);
    for (const child of doc.childIds(nodeId)) visit(child);
  };
  visit(id);
  return out;
}

/**
 * What copying `assetIds` takes: the top nodes to copy (the assets, the
 * mains, text styles and collections they use, and so on), in the order
 * they're found, without any inside another.
 */
export function dependencyRoots(doc: DocReader, assetIds: Iterable<string>): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const queue = [...assetIds];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id) || !doc.get(id)) continue;
    seen.add(id);
    roots.push(id);
    for (const node of subtree(doc, id)) queue.push(...references(doc, node));
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
  const parts: string[] = [];
  for (const root of dependencyRoots(doc, [assetId]))
    for (const node of subtree(doc, root)) {
      const props =
        node.id === root
          ? Object.fromEntries(Object.entries(node.props).filter(([k]) => !PLACEMENT.has(k)))
          : node.props;
      parts.push(stableJson([node.id, node.type, node.id === root ? "" : node.key, props]));
    }
  return hash64(parts.join("\n"));
}

/** What a library file offers: its components, a set of variants as one, in file order. */
export function libraryAssets(doc: DocReader): LibraryAsset[] {
  const out: LibraryAsset[] = [];
  const seen = new Set<string>();
  for (const component of mains(doc)) {
    const set = setOf(doc, component.id);
    const asset = set ?? component;
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    out.push({
      id: asset.id,
      name: getProp(asset.props, "name") || (set ? "Set" : "Component"),
      description: getProp(asset.props, "componentDescription"),
      set: set !== undefined,
      hash: assetHash(doc, asset.id),
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
