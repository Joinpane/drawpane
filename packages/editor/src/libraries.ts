/**
 * Team libraries in a document (docs/decisions/0010-team-libraries.md):
 * what a library file offers, and the operations that copy its components
 * into a file that uses it and bring those copies up to date.
 *
 * A file keeps what it uses from a library under a `library` node: copies
 * of the published mains and everything they need (nested mains, text
 * styles, variable collections), with ids derived from the library's, so a
 * copy is found again by id alone. Instances on pages point at the copies,
 * and updating the copies syncs the instances through the editor's usual
 * propagation, overrides kept.
 */
import {
  getProp,
  keyBetween,
  type LibraryAsset,
  type NodeRecord,
  type Op,
  type Props,
  ROOT_ID,
} from "@drawpane/model";
import { componentSetOf, isComponentSet, isMainComponent, listComponents } from "./components";
import type { Doc } from "./doc";

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

/** JSON with object keys sorted, so equal values hash alike. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
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
function collectionOf(doc: Doc, variableId: string): string | null {
  const variable = doc.get(variableId);
  return variable?.type === "variable" ? variable.parent : null;
}

/** The nodes another node points at: what its copy needs to be there too. */
function references(doc: Doc, node: NodeRecord): string[] {
  const out: string[] = [];
  const p = node.props as Record<string, unknown>;
  if (typeof p.instanceOf === "string")
    out.push(componentSetOf(doc, p.instanceOf)?.id ?? p.instanceOf);
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
function subtree(doc: Doc, id: string): NodeRecord[] {
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
export function dependencyRoots(doc: Doc, assetIds: Iterable<string>): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const queue = [...assetIds];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id) || !doc.has(id)) continue;
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
export function assetHash(doc: Doc, assetId: string): string {
  const parts: string[] = [];
  for (const root of dependencyRoots(doc, [assetId]))
    for (const node of subtree(doc, root)) {
      const props =
        node.id === root
          ? Object.fromEntries(Object.entries(node.props).filter(([k]) => !PLACEMENT.has(k)))
          : node.props;
      parts.push(stable([node.id, node.type, node.id === root ? "" : node.key, props]));
    }
  return hash64(parts.join("\n"));
}

/** What a library file offers: its components, a set of variants as one, in file order. */
export function libraryAssets(doc: Doc): LibraryAsset[] {
  const out: LibraryAsset[] = [];
  const seen = new Set<string>();
  for (const component of listComponents(doc)) {
    const set = componentSetOf(doc, component.id);
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
export function assetMain(doc: Doc, assetId: string): string | null {
  const node = doc.get(assetId);
  if (isMainComponent(node)) return assetId;
  if (isComponentSet(node))
    return doc.childIds(assetId).find((id) => isMainComponent(doc.get(id))) ?? null;
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

// ---------------------------------------------------------------------------
// Copies in a file that uses the library

/** A library as a file using it knows it. */
export interface LibraryRef {
  readonly fileId: string;
  readonly name: string;
  readonly publishId: string;
}

/** The libraries a file uses: its library nodes. */
export function usedLibraries(doc: Doc): LibraryRef[] {
  const out: LibraryRef[] = [];
  for (const id of doc.childIds(ROOT_ID)) {
    const node = doc.get(id);
    if (node?.type !== "library") continue;
    const fileId = getProp(node.props, "libraryFile");
    const publishId = getProp(node.props, "libraryPublish");
    if (fileId && publishId) out.push({ fileId, name: getProp(node.props, "name"), publishId });
  }
  return out;
}

/** Is `id` one of a library's copies (or its library node)? Copies are read-only. */
export function isLibraryCopy(doc: Doc, id: string): boolean {
  for (let node = doc.get(id); node; node = doc.get(node.parent))
    if (node.type === "library") return true;
  return false;
}

/** A node's props with every id it points at turned into its copy's. */
function remap(node: NodeRecord, to: (id: string) => string): Props {
  const props: Record<string, unknown> = { ...node.props };
  const p = node.props as Record<string, unknown>;
  for (const key of ["instanceOf", "mirrors", "textStyle"] as const)
    if (typeof p[key] === "string") props[key] = to(p[key] as string);
  if (Array.isArray(p.readingOrder)) props.readingOrder = (p.readingOrder as string[]).map(to);
  if (p.bindings && typeof p.bindings === "object")
    props.bindings = Object.fromEntries(
      Object.entries(p.bindings as Record<string, string>).map(([k, v]) => [k, to(v)]),
    );
  if (p.variableModes && typeof p.variableModes === "object")
    props.variableModes = Object.fromEntries(
      Object.entries(p.variableModes as Record<string, string>).map(([k, v]) => [to(k), v]),
    );
  if (p.values && typeof p.values === "object")
    props.values = Object.fromEntries(
      Object.entries(p.values as Record<string, unknown>).map(([mode, v]) => [
        mode,
        v && typeof v === "object" && "alias" in v
          ? { alias: to((v as { alias: string }).alias) }
          : v,
      ]),
    );
  return props as Props;
}

/** The key after a parent's last child. */
function keyAfterLast(doc: Doc, parent: string): string {
  const last = doc.childIds(parent).at(-1);
  return keyBetween(last ? (doc.get(last)?.key ?? null) : null, null);
}

/**
 * Operations that make a file's copies of `assetIds` (and what they need)
 * match `source`, a library's published snapshot: copying what's missing,
 * and, with `update`, bringing what's there in line. Removed from the
 * library, a copy stays as it is, so its instances don't break. The editor
 * then syncs instances of changed copies as for any edit to a main.
 */
function reconcileOps(
  doc: Doc,
  source: Doc,
  lib: LibraryRef,
  assetIds: Iterable<string>,
  update: boolean,
): Op[] {
  const to = (id: string) => libraryNodeId(lib.fileId, id);
  const container = libraryContainerId(lib.fileId);
  const ops: Op[] = [];
  const existing = doc.get(container);
  if (!existing)
    ops.push({
      op: "create",
      id: container,
      type: "library",
      parent: ROOT_ID,
      key: keyAfterLast(doc, ROOT_ID),
      props: { name: lib.name, libraryFile: lib.fileId, libraryPublish: lib.publishId },
    });
  else if (update) {
    if (getProp(existing.props, "libraryPublish") !== lib.publishId)
      ops.push({ op: "set", id: container, prop: "libraryPublish", value: lib.publishId });
    if (getProp(existing.props, "name") !== lib.name)
      ops.push({ op: "set", id: container, prop: "name", value: lib.name });
  }

  const roots = dependencyRoots(source, assetIds);
  const wanted = new Set<string>();
  for (const root of roots) for (const node of subtree(source, root)) wanted.add(to(node.id));

  const lastRoot = doc.childIds(container).at(-1);
  let rootKey = lastRoot ? (doc.get(lastRoot)?.key ?? null) : null;
  const reconcile = (sourceId: string, parent: string, key: string) => {
    const src = source.get(sourceId);
    if (!src) return;
    const id = to(sourceId);
    const props = remap(src, to);
    const here = doc.get(id);
    if (!here || here.type !== src.type) {
      if (here) ops.push({ op: "delete", id });
      ops.push({ op: "create", id, type: src.type, parent, key, props });
    } else {
      if (here.parent !== parent || here.key !== key) ops.push({ op: "move", id, parent, key });
      for (const prop of new Set([...Object.keys(here.props), ...Object.keys(props)])) {
        const want = (props as Record<string, unknown>)[prop];
        const have = (here.props as Record<string, unknown>)[prop];
        if (stable(want) !== stable(have))
          ops.push({ op: "set", id, prop: prop as never, value: want === undefined ? null : want });
      }
    }
    for (const child of source.childIds(sourceId)) {
      const childKey = source.get(child)?.key;
      if (childKey) reconcile(child, id, childKey);
    }
  };
  for (const root of roots) {
    const here = doc.get(to(root));
    // Inserting leaves copies the file has as they are: updating is its own step.
    if (here && !update) continue;
    let key = here?.parent === container ? here.key : null;
    if (key === null) {
      key = keyBetween(rootKey, null);
      rootKey = key;
    }
    reconcile(root, container, key);
  }

  // What the library no longer has inside the copies it still has: deleted
  // last, after anything that moved out of it has. Whole copies it dropped stay.
  if (update)
    for (const root of roots) {
      const top = doc.get(to(root));
      if (!top || top.parent !== container) continue;
      const drop = (id: string) => {
        for (const child of doc.childIds(id)) {
          if (!wanted.has(child)) ops.push({ op: "delete", id: child });
          else drop(child);
        }
      };
      drop(top.id);
    }
  return ops;
}

/**
 * Operations that copy a library's assets into a file, with what they need,
 * leaving copies the file already has alone (inserting takes the publish
 * the file has: updating is its own step).
 */
export function importOps(
  doc: Doc,
  source: Doc,
  lib: LibraryRef,
  assetIds: Iterable<string>,
): Op[] {
  return reconcileOps(doc, source, lib, assetIds, false);
}

/**
 * Operations that bring every copy a file has from a library in line with
 * a newer publish (`source`, its snapshot), adding what they now need.
 */
export function updateOps(doc: Doc, source: Doc, lib: LibraryRef): Op[] {
  const container = libraryContainerId(lib.fileId);
  if (!doc.has(container)) return [];
  // The library nodes the file's copies came from, found by their ids.
  const original = new Map<string, string>();
  for (const node of source.nodes()) original.set(libraryNodeId(lib.fileId, node.id), node.id);
  const assets: string[] = [];
  for (const id of doc.childIds(container)) {
    const from = original.get(id);
    if (from) assets.push(from);
  }
  return reconcileOps(doc, source, lib, assets, true);
}

/**
 * How many instances in the file (outside the library's own copies) are of
 * a library's components: while any are, the library stays.
 */
export function libraryUses(doc: Doc, libraryFileId: string): number {
  const container = libraryContainerId(libraryFileId);
  let uses = 0;
  for (const node of doc.nodes()) {
    if (node.type !== "frame") continue;
    const of = getProp(node.props, "instanceOf");
    if (!of || doc.get(of)?.parent === undefined) continue;
    // An instance of a copy (anywhere under the library node), not itself a copy.
    let copyRoot = doc.get(of);
    while (copyRoot && copyRoot.parent !== container && copyRoot.parent !== ROOT_ID)
      copyRoot = doc.get(copyRoot.parent);
    if (copyRoot?.parent === container && !isLibraryCopy(doc, node.id)) uses++;
  }
  return uses;
}
