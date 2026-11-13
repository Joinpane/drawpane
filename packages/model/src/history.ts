/**
 * Version history helpers shared by the FileRoom and the editor.
 *
 * - `summarizeEdits` turns a run of transactions into "38 edits: 14 style
 *   changes, 11 text edits…", the summary each saved version carries.
 * - `restoreOps` works out the operations that turn the current document (or
 *   some of its layers) back into how it was in a saved version. Restoring is
 *   an ordinary transaction, so it syncs, it is logged, and nothing after it
 *   is lost.
 */
import { ROOT_ID } from "./ids";
import type { NodeRecord, Op } from "./ops";
import { keyBetween } from "./order-key";
import { isPropName, NODE_TYPES, type NodeType, PROPS, type PropName, propAllowed } from "./schema";

// ---------------------------------------------------------------------------
// What kind of change an edit was

export const CHANGE_KINDS = [
  "added",
  "removed",
  "arranged",
  "geometry",
  "style",
  "text",
  "layout",
  "vector",
  "component",
  "prototype",
  "tokens",
  "renamed",
  "other",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

const PROP_KIND: Readonly<Record<PropName, ChangeKind>> = {
  name: "renamed",
  visible: "other",
  locked: "other",
  opacity: "style",
  blendMode: "style",
  x: "geometry",
  y: "geometry",
  width: "geometry",
  height: "geometry",
  rotation: "geometry",
  flipX: "geometry",
  flipY: "geometry",
  lockAspect: "geometry",
  isMask: "arranged",
  rulerGuides: "other",
  layoutGrids: "layout",
  fills: "style",
  strokes: "style",
  strokeWeight: "style",
  strokeAlign: "style",
  strokeCap: "style",
  markerStart: "style",
  markerEnd: "style",
  strokeJoin: "style",
  strokeDashes: "style",
  effects: "style",
  cornerRadius: "style",
  pointCount: "geometry",
  innerRadius: "geometry",
  cornerRadii: "style",
  isComponent: "component",
  isComponentSet: "component",
  variantProps: "component",
  componentDescription: "component",
  instanceOf: "component",
  mirrors: "component",
  overrides: "component",
  clipContent: "style",
  layoutMode: "layout",
  layoutWrap: "layout",
  gap: "layout",
  rowGap: "layout",
  paddingTop: "layout",
  paddingRight: "layout",
  paddingBottom: "layout",
  paddingLeft: "layout",
  justifyContent: "layout",
  alignItems: "layout",
  gridColumns: "layout",
  gridRows: "layout",
  justifyItems: "layout",
  sizingH: "layout",
  sizingV: "layout",
  minWidth: "layout",
  maxWidth: "layout",
  minHeight: "layout",
  maxHeight: "layout",
  positioning: "layout",
  alignSelf: "layout",
  justifySelf: "layout",
  gridArea: "layout",
  constraintH: "layout",
  constraintV: "layout",
  characters: "text",
  fontFamily: "text",
  fontWeight: "text",
  fontStyle: "text",
  fontSize: "text",
  lineHeight: "text",
  letterSpacing: "text",
  textAlign: "text",
  textAlignVertical: "text",
  textAutoResize: "text",
  textCase: "text",
  textDecoration: "text",
  pathData: "vector",
  windingRule: "vector",
  backgroundColor: "style",
  reactions: "prototype",
  flows: "prototype",
  prototypeDevice: "prototype",
  modes: "tokens",
  variableType: "tokens",
  values: "tokens",
  description: "tokens",
  bindings: "tokens",
  variableModes: "tokens",
};

const TOKEN_TYPES: ReadonlySet<NodeType> = new Set(["collection", "variable"]);

/** The kinds of change one transaction makes, each counted once. */
export function changeKinds(ops: readonly Op[]): Set<ChangeKind> {
  const kinds = new Set<ChangeKind>();
  for (const op of ops) {
    switch (op.op) {
      case "create":
        kinds.add(TOKEN_TYPES.has(op.type) ? "tokens" : "added");
        break;
      case "delete":
        kinds.add("removed");
        break;
      case "move":
        kinds.add("arranged");
        break;
      case "set":
        kinds.add(isPropName(op.prop) ? PROP_KIND[op.prop] : "other");
        break;
    }
  }
  return kinds;
}

export interface EditSummary {
  /** Transactions: one drag, one paste, one rename each count once. */
  readonly edits: number;
  /** How many of those edits made each kind of change. */
  readonly kinds: Readonly<Partial<Record<ChangeKind, number>>>;
}

export const EMPTY_SUMMARY: EditSummary = { edits: 0, kinds: {} };

/** Summarizes a run of transactions, oldest first or in any order. */
export function summarizeEdits(transactions: Iterable<readonly Op[]>): EditSummary {
  let edits = 0;
  const kinds: Partial<Record<ChangeKind, number>> = {};
  for (const ops of transactions) {
    edits++;
    for (const kind of changeKinds(ops)) kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return { edits, kinds };
}

// ---------------------------------------------------------------------------
// Restoring

/** The read side of a `NodeStore`: enough to diff against. */
export interface NodeReader {
  get(id: string): NodeRecord | undefined;
  childIds(parent: string): readonly string[];
}

export interface RestoreOptions {
  /**
   * Restore only these layers (and everything inside them) instead of the
   * whole file. Each is put back where it was when its old parent still
   * exists, else left where it is now, else added to its old page or
   * `fallbackParent`.
   */
  readonly roots?: readonly string[];
  /** Where a restored layer goes when neither its old parent nor its old page exists any more. */
  readonly fallbackParent?: string;
}

export interface RestorePlan {
  readonly ops: Op[];
  /**
   * Values in the version the current schema no longer accepts (a property
   * that was removed or tightened), left out of the restore.
   */
  readonly dropped: number;
  /** The layers that were restored, for selecting them afterwards. */
  readonly restored: readonly string[];
}

const nodeTypes: ReadonlySet<string> = new Set(NODE_TYPES);

/** Structural equality for JSON-like property values. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.hasOwn(b, k)) return false;
    if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

/** A version's properties, minus anything today's schema refuses. */
function sanitize(
  type: NodeType,
  props: Readonly<Record<string, unknown>>,
  count: { dropped: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (
      !isPropName(prop) ||
      !propAllowed(type, prop) ||
      !PROPS[prop].schema.safeParse(value).success
    ) {
      count.dropped++;
      continue;
    }
    out[prop] = value;
  }
  return out;
}

/** The version's tree: nodes by id and child ids by parent, in no particular order. */
class Target {
  readonly nodes = new Map<string, NodeRecord>();
  readonly children = new Map<string, string[]>();

  constructor(nodes: Iterable<NodeRecord>) {
    for (const node of nodes) {
      if (!nodeTypes.has(node.type)) continue;
      this.nodes.set(node.id, node);
      let list = this.children.get(node.parent);
      if (!list) {
        list = [];
        this.children.set(node.parent, list);
      }
      list.push(node.id);
    }
  }

  /** `id` and everything under it, parents before children. */
  subtree(id: string): string[] {
    if (!this.nodes.has(id)) return [];
    return this.#walk([id]);
  }

  /** Every node reachable from the root, parents before children. Orphans are left out. */
  all(): string[] {
    return this.#walk(this.children.get(ROOT_ID) ?? []);
  }

  #walk(start: readonly string[]): string[] {
    const out = [...start];
    for (let i = 0; i < out.length; i++) {
      for (const child of this.children.get(out[i] as string) ?? []) out.push(child);
    }
    return out;
  }

  pageOf(id: string): string | null {
    let node = this.nodes.get(id);
    for (let depth = 0; node && depth < 256; depth++) {
      if (node.type === "page") return node.id;
      node = this.nodes.get(node.parent);
    }
    return null;
  }
}

/** `id` (the root counts, though it is never stored) and everything under it now, parents first. */
function currentSubtree(current: NodeReader, id: string): string[] {
  if (id !== ROOT_ID && !current.get(id)) return [];
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const child of current.childIds(out[i] as string)) out.push(child);
  }
  return out;
}

/** True when `ancestor` is `id` or contains it in the current document. */
function contains(current: NodeReader, ancestor: string, id: string): boolean {
  let node = current.get(id);
  for (let depth = 0; node && depth < 256; depth++) {
    if (node.id === ancestor) return true;
    if (node.parent === ROOT_ID) return false;
    node = current.get(node.parent);
  }
  return false;
}

/** A key after every current child of `parent`, so an added layer lands on top. */
function keyOnTop(current: NodeReader, parent: string): string {
  const last = current.childIds(parent).at(-1);
  const lastKey = last ? current.get(last)?.key : undefined;
  return keyBetween(lastKey ?? null, null);
}

/**
 * The operations that turn `current` into `version`, or only the layers in
 * `options.roots`.
 *
 * Nodes are placed top-down in the version's tree, so every parent is in its
 * final place before its children move into it and a move can never form a
 * cycle. Deletes come last, after anything that should survive has moved out
 * of what is being deleted, so a file never loses its last page on the way.
 */
export function restoreOps(
  current: NodeReader,
  version: Iterable<NodeRecord>,
  options: RestoreOptions = {},
): RestorePlan {
  const target = new Target(version);
  const count = { dropped: 0 };
  const placeOps: Op[] = [];
  const setOps: Op[] = [];
  const deleteOps: Op[] = [];

  /** Brings `id` (whose target parent is already in place) to `parent`/`key` with the version's props. */
  const restoreNode = (id: string, parent: string, key: string): void => {
    const node = target.nodes.get(id) as NodeRecord;
    const props = sanitize(node.type, node.props, count);
    const now = current.get(id);
    if (!now) {
      placeOps.push({ op: "create", id, type: node.type, parent, key, props });
      return;
    }
    if (now.type !== node.type) {
      // Ids never change type; a mismatch means foreign data. Leave it alone.
      count.dropped++;
      return;
    }
    if (now.parent !== parent || now.key !== key) placeOps.push({ op: "move", id, parent, key });
    const was: Readonly<Record<string, unknown>> = now.props;
    for (const prop of new Set([...Object.keys(was), ...Object.keys(props)])) {
      if (!sameValue(was[prop], props[prop])) {
        setOps.push({ op: "set", id, prop: prop as PropName, value: props[prop] ?? null });
      }
    }
  };

  /** Deletes the topmost nodes in `ids` that aren't in `keep`. */
  const deleteMissing = (ids: readonly string[], keep: ReadonlySet<string>): void => {
    const gone = new Set(ids.filter((id) => !keep.has(id)));
    for (const id of gone) {
      const parent = current.get(id)?.parent;
      if (parent === undefined || gone.has(parent)) continue;
      deleteOps.push({ op: "delete", id });
    }
  };

  if (!options.roots) {
    // The whole file: every node of the version, top-down from the root.
    const order = target.all();
    for (const id of order) {
      const node = target.nodes.get(id) as NodeRecord;
      restoreNode(id, node.parent, node.key);
    }
    deleteMissing(currentSubtree(current, ROOT_ID).slice(1), new Set(order));
    return { ops: [...placeOps, ...setOps, ...deleteOps], dropped: count.dropped, restored: [] };
  }

  // Some layers: drop roots nested inside other roots, and roots the version doesn't have.
  const asked = options.roots.filter((id) => {
    const node = target.nodes.get(id);
    return node !== undefined && node.type !== "page" && node.parent !== ROOT_ID;
  });
  const roots = asked.filter(
    (id) => !asked.some((other) => other !== id && target.subtree(other).includes(id)),
  );
  for (const root of roots) {
    const node = target.nodes.get(root) as NodeRecord;
    const now = current.get(root);
    let parent: string;
    let key: string;
    const oldParent = current.get(node.parent);
    if (oldParent && !contains(current, root, node.parent)) {
      parent = node.parent;
      key = node.key;
    } else if (now) {
      parent = now.parent;
      key = now.key;
    } else {
      const page = target.pageOf(root);
      const home = page && current.get(page) ? page : options.fallbackParent;
      if (!home || !current.get(home)) continue;
      parent = home;
      key = keyOnTop(current, home);
    }
    const ids = target.subtree(root);
    restoreNode(root, parent, key);
    for (const id of ids.slice(1)) {
      const child = target.nodes.get(id) as NodeRecord;
      restoreNode(id, child.parent, child.key);
    }
    if (now) deleteMissing(currentSubtree(current, root).slice(1), new Set(ids));
  }
  return { ops: [...placeOps, ...setOps, ...deleteOps], dropped: count.dropped, restored: roots };
}

// ---------------------------------------------------------------------------
// The version list, as the API returns it

export type VersionReason = "auto" | "named" | "restore";

export interface VersionPerson {
  readonly id: string;
  readonly name: string;
}

export interface VersionInfo {
  readonly id: string;
  /** The file revision the version holds. */
  readonly revn: number;
  /** `auto`: saved while editing. `named`: saved by someone with a name. `restore`: saved just before a restore. */
  readonly reason: VersionReason;
  /** Set for named versions (an autosave can be named later). */
  readonly name: string | null;
  readonly description: string | null;
  /** For `restore`: the version that was restored right after this was saved. */
  readonly restoredId: string | null;
  /** Who saved or named it; null for autosaves. */
  readonly createdBy: VersionPerson | null;
  readonly createdAt: number;
  /** When the first edit in it happened, if known. */
  readonly startedAt: number | null;
  /** People who edited since the version before it. */
  readonly authors: readonly VersionPerson[];
  readonly summary: EditSummary;
  /** Compressed snapshot size in bytes. */
  readonly size: number;
}
