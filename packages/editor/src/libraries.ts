/**
 * Team libraries in a document (docs/decisions/0010-team-libraries.md):
 * the operations that copy a library's components into a file that uses it
 * and bring those copies up to date. What a library offers (its assets and
 * their hashes) is in @drawpane/model, shared with the Worker.
 *
 * A file keeps what it uses from a library under a `library` node: copies
 * of the published mains and everything they need (nested mains, text
 * styles, variable collections), with ids derived from the library's, so a
 * copy is found again by id alone. Copies are read-only: only these
 * operations write them. Instances on pages point at the copies, and
 * updating the copies syncs the instances through the editor's usual
 * propagation, overrides kept. A copy an instance in the file uses is never
 * deleted, whatever the library did with it.
 */
import {
  type ComponentPropDef,
  copyChildId,
  dependencyRoots,
  getProp,
  keyBetween,
  libraryContainerId,
  libraryNodeId,
  type NodeRecord,
  type Op,
  type Props,
  ROOT_ID,
  renameTokenIds,
  stableJson,
  subtree,
} from "@drawpane/model";
import type { Doc } from "./doc";

export {
  type AssetChanges,
  assetChanges,
  assetHash,
  assetMain,
  dependencyRoots,
  libraryAssets,
  libraryContainerId,
  libraryNodeId,
} from "@drawpane/model";

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

/** The library node a node is under (or is), if any. */
export function libraryOf(doc: Doc, id: string): NodeRecord | undefined {
  for (let node = doc.get(id); node; node = doc.get(node.parent))
    if (node.type === "library") return node;
  return undefined;
}

/** Is `id` one of a library's copies (or a library node)? Copies are read-only. */
export function isLibraryCopy(doc: Doc, id: string): boolean {
  return libraryOf(doc, id) !== undefined;
}

/**
 * Would these operations write a library's copies (or library nodes)? Only
 * the library operations may: everything else is refused, so copies stay
 * what the library published.
 */
export function touchesLibraryCopies(doc: Doc, ops: readonly Op[]): boolean {
  return ops.some((op) => {
    if (op.op === "create") return op.type === "library" || isLibraryCopy(doc, op.parent);
    if (op.op === "move") return isLibraryCopy(doc, op.id) || isLibraryCopy(doc, op.parent);
    return isLibraryCopy(doc, op.id);
  });
}

/**
 * The copies instances in the file (outside the copies themselves) are of,
 * with the sets they're variants of: what the file uses, and must keep.
 * Instances in `without` (about to be deleted) don't count.
 */
export function usedCopies(doc: Doc, without: ReadonlySet<string> = new Set()): Set<string> {
  const used = new Set<string>();
  for (const node of doc.nodes()) {
    if (node.type !== "frame" || without.has(node.id)) continue;
    const of = getProp(node.props, "instanceOf");
    if (!of || !isLibraryCopy(doc, of) || isLibraryCopy(doc, node.id)) continue;
    used.add(of);
    const parent = doc.get(doc.get(of)?.parent ?? "");
    if (parent?.type === "frame" && getProp(parent.props, "isComponentSet")) used.add(parent.id);
  }
  return used;
}

/**
 * How many instances in the file (outside the library's own copies) are of
 * a library's components: while any are, the library stays.
 */
export function libraryUses(doc: Doc, libraryFileId: string): number {
  const container = libraryContainerId(libraryFileId);
  let uses = 0;
  for (const node of doc.nodes()) {
    if (node.type !== "frame" || isLibraryCopy(doc, node.id)) continue;
    const of = getProp(node.props, "instanceOf");
    if (of && libraryOf(doc, of)?.id === container) uses++;
  }
  return uses;
}

/** A node's props with every id it points at turned into its copy's. */
function remap(node: NodeRecord, to: (id: string) => string, copied: ReadonlySet<string>): Props {
  // Tokens and what uses them (decision 0034): bindings, paint and effect binds, style links,
  // aliases (their opacity kept), the collections modes are set for.
  const props: Record<string, unknown> = { ...renameTokenIds(node.props, to) };
  const p = node.props as Record<string, unknown>;
  for (const key of ["instanceOf", "mirrors"] as const)
    if (typeof p[key] === "string") props[key] = to(p[key] as string);
  if (Array.isArray(p.readingOrder)) props.readingOrder = (p.readingOrder as string[]).map(to);
  // An instance swap's default and preferred components (decision 0035). Property ids aren't
  // node ids: they stay.
  if (Array.isArray(p.componentProps))
    props.componentProps = (p.componentProps as ComponentPropDef[]).map((def) =>
      def.type !== "instance"
        ? def
        : {
            ...def,
            ...(typeof def.default === "string" ? { default: to(def.default) } : {}),
            ...(def.preferred ? { preferred: def.preferred.map(to) } : {}),
          },
    );
  // A prototype link to a layer that came along points at its copy; others stay as they were.
  if (Array.isArray(p.reactions))
    props.reactions = JSON.parse(JSON.stringify(p.reactions), (key, value) =>
      key === "to" && typeof value === "string" && copied.has(value) ? to(value) : value,
    );
  return props as Props;
}

/**
 * A library node's id in the file. With compact copies on both sides, a
 * copy layer inside a library main isn't stored: its id is derived in the
 * file from its instance's (decision 0029), through the same path, each
 * step a library id.
 */
function copyNamer(doc: Doc, source: Doc, fileId: string): (id: string) => string {
  const to = (id: string) => libraryNodeId(fileId, id);
  if (!doc.compactCopies || !source.compactCopies) return to;
  const memo = new Map<string, string>();
  const name = (id: string): string => {
    const known = memo.get(id);
    if (known) return known;
    const slot = source.copySlot(id);
    const out = slot ? copyChildId(name(slot.parent), name(slot.source)) : to(id);
    memo.set(id, out);
    return out;
  };
  return name;
}

function keyOfLast(doc: Doc, parent: string): string | null {
  const last = doc.childIds(parent).at(-1);
  return last ? (doc.get(last)?.key ?? null) : null;
}

/**
 * Operations that copy what `roots` need from `source` and, with `update`,
 * bring the copies already there in line. Grouped by top copy: a teammate
 * copying the same thing at once makes the same ids, so each group goes in
 * as its own transaction, and a clash only drops the group that clashed.
 */
function reconcileBatches(
  doc: Doc,
  source: Doc,
  lib: LibraryRef,
  roots: readonly string[],
  update: boolean,
): Op[][] {
  const to = copyNamer(doc, source, lib.fileId);
  const container = libraryContainerId(lib.fileId);
  const batches: Op[][] = [];
  const existing = doc.get(container);
  if (!existing)
    batches.push([
      {
        op: "create",
        id: container,
        type: "library",
        parent: ROOT_ID,
        key: keyBetween(keyOfLast(doc, ROOT_ID), null),
        props: { name: lib.name, libraryFile: lib.fileId, libraryPublish: lib.publishId },
      },
    ]);
  else if (update) {
    const head: Op[] = [];
    if (getProp(existing.props, "libraryPublish") !== lib.publishId)
      head.push({ op: "set", id: container, prop: "libraryPublish", value: lib.publishId });
    if (getProp(existing.props, "name") !== lib.name)
      head.push({ op: "set", id: container, prop: "name", value: lib.name });
    if (head.length > 0) batches.push(head);
  }

  const copied = new Set<string>();
  for (const root of roots) for (const node of subtree(source, root)) copied.add(node.id);

  let rootKey = keyOfLast(doc, container);
  const reconcile = (ops: Op[], sourceId: string, parent: string, key: string) => {
    const src = source.get(sourceId);
    if (!src) return;
    const id = to(sourceId);
    const props = remap(src, to, copied);
    const here = doc.get(id);
    if (!here || here.type !== src.type) {
      if (here) ops.push({ op: "delete", id });
      ops.push({ op: "create", id, type: src.type, parent, key, props });
    } else {
      if (here.parent !== parent || here.key !== key) ops.push({ op: "move", id, parent, key });
      for (const prop of new Set([...Object.keys(here.props), ...Object.keys(props)])) {
        const want = (props as Record<string, unknown>)[prop];
        const have = (here.props as Record<string, unknown>)[prop];
        if (stableJson(want) !== stableJson(have))
          ops.push({ op: "set", id, prop: prop as never, value: want === undefined ? null : want });
      }
    }
    for (const child of source.childIds(sourceId)) {
      const childKey = source.get(child)?.key;
      if (childKey) reconcile(ops, child, id, childKey);
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
    const ops: Op[] = [];
    reconcile(ops, root, container, key);
    if (ops.length > 0) batches.push(ops);
  }
  return batches;
}

/**
 * Operations that copy a library's assets into a file, with what they need,
 * leaving copies the file already has alone (inserting takes the publish
 * the file has: updating is its own step), in transactions to apply in turn.
 */
export function importBatches(
  doc: Doc,
  source: Doc,
  lib: LibraryRef,
  assetIds: Iterable<string>,
): Op[][] {
  return reconcileBatches(doc, source, lib, dependencyRoots(source, assetIds), false);
}

/** `importBatches` as one list, for a single transaction. */
export function importOps(
  doc: Doc,
  source: Doc,
  lib: LibraryRef,
  assetIds: Iterable<string>,
): Op[] {
  return importBatches(doc, source, lib, assetIds).flat();
}

/**
 * Operations that bring every copy a file has from a library in line with
 * a newer publish (`source`, its snapshot), adding what they now need.
 *
 * What the file has is its top copies and every main an instance in it
 * uses (a nested one too, so one the library moved out of its component
 * comes out with it). What the library removed from inside a copy goes,
 * unless an instance in the file uses it: that stays as it was, moved out
 * to the top if what held it goes. Whole copies the library dropped stay.
 */
export function updateOps(doc: Doc, source: Doc, lib: LibraryRef): Op[] {
  const container = libraryContainerId(lib.fileId);
  if (!doc.has(container)) return [];
  // The library nodes the file's copies came from, found by their ids.
  const original = new Map<string, string>();
  for (const node of source.nodes()) original.set(libraryNodeId(lib.fileId, node.id), node.id);
  const used = new Set([...usedCopies(doc)].filter((id) => libraryOf(doc, id)?.id === container));
  const assets = new Set<string>();
  for (const id of [...doc.childIds(container), ...used]) {
    const from = original.get(id);
    if (from) assets.add(from);
  }
  const roots = dependencyRoots(source, assets);
  const ops = reconcileBatches(doc, source, lib, roots, true).flat();

  // What the library no longer has inside the copies the file keeps: deleted
  // last, after anything that moved out of it has, keeping what's used.
  const wanted = new Set<string>();
  const name = copyNamer(doc, source, lib.fileId);
  for (const root of roots) for (const node of subtree(source, root)) wanted.add(name(node.id));
  // New top keys go after any the copying above gave out.
  let rootKey = keyOfLast(doc, container);
  for (const op of ops)
    if ((op.op === "create" || op.op === "move") && op.parent === container)
      if (rootKey === null || op.key > rootKey) rootKey = op.key;
  // Used mains the library removed (one it still has moved out already, with the copying).
  const usedInside = (id: string): string[] =>
    wanted.has(id)
      ? []
      : used.has(id)
        ? [id]
        : doc.childIds(id).flatMap((child) => usedInside(child));
  const drop = (id: string) => {
    for (const child of doc.childIds(id)) {
      if (wanted.has(child)) {
        drop(child);
        continue;
      }
      if (used.has(child)) continue;
      // Used mains inside what goes come out first, as copies of their own.
      for (const keep of usedInside(child)) {
        rootKey = keyBetween(rootKey, null);
        ops.push({ op: "move", id: keep, parent: container, key: rootKey });
      }
      ops.push({ op: "delete", id: child });
    }
  };
  for (const top of doc.childIds(container)) if (wanted.has(top)) drop(top);
  return ops;
}

/**
 * Undoing can delete copies a teammate has used since (their instance came
 * after): those deletes are left out, so their instances keep their mains.
 */
export function keepUsedCopies(doc: Doc, ops: readonly Op[]): Op[] {
  const deleted = new Set<string>();
  for (const op of ops)
    if (op.op === "delete") for (const node of subtree(doc, op.id)) deleted.add(node.id);
  // Nothing deleted, nothing to keep: most undos, which needn't look at every copy in the file.
  if (deleted.size === 0) return [...ops];
  const used = usedCopies(doc, deleted);
  if (used.size === 0) return [...ops];
  const holdsUsed = (id: string) => subtree(doc, id).some((node) => used.has(node.id));
  return ops.filter((op) => op.op !== "delete" || !isLibraryCopy(doc, op.id) || !holdsUsed(op.id));
}
