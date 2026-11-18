/**
 * Every instance keeps a record (decision 0035, item 3): what an instance
 * from before records held on the layers its properties drive is folded into
 * one, once, before anyone edits it. The room migrates a stored file when it
 * loads, and every path content comes in by folds it before it's written
 * (an import, a paste, a library's component, a restored version), so no
 * client ever sees an instance without a record, and none folds.
 *
 * The fold keeps every value or unlinks: a key takes the first layer, in
 * layer order, that shows another value than its main layer's; a layer of
 * the same key showing something else, or a value past the record's bounds,
 * is unlinked from its property instead, keeping what it shows as its own
 * (an override), so the file draws as it did. Nothing is dropped.
 */
import { sameValue } from "./history";
import type { NodeRecord, Op } from "./ops";
import {
  type ComponentPropDef,
  getProp,
  MAX_PROPERTY_SCOPE,
  MAX_PROPERTY_VALUES,
  MAX_PROPERTY_VALUES_CHARS,
  type PropertyValue,
  propertyKey,
  propertyValuesChars,
} from "./schema";
import { MemoryStore } from "./store";

/** What a fold reads: a file's nodes, children in layer order. */
export interface RecordReader {
  get(id: string): NodeRecord | undefined;
  childIds(parent: string): readonly string[];
}

/** The field each property type drives. */
const FIELD_OF: Readonly<Record<string, "visible" | "characters" | "instanceOf">> = {
  boolean: "visible",
  text: "characters",
  instance: "instanceOf",
};

const isInstanceRoot = (node: NodeRecord | undefined): boolean =>
  node?.type === "frame" && typeof node.props.instanceOf === "string";

/**
 * Whether a node is an instance that needs a record: an instance root that
 * isn't a copy (no `mirrors`: copies keep their values in the record of the
 * instance they're in) and keeps none.
 */
export function needsRecord(node: NodeRecord): boolean {
  return (
    isInstanceRoot(node) &&
    typeof node.props.mirrors !== "string" &&
    (node.props.propValues === undefined || node.props.propValues === null)
  );
}

/** A driven field's value in a layer, as a record holds it. */
function fieldValue(node: NodeRecord, field: string): PropertyValue | null {
  if (field === "visible") return node.props.visible !== false;
  if (field === "characters")
    return typeof node.props.characters === "string" ? node.props.characters : "";
  if (field === "instanceOf")
    return typeof node.props.instanceOf === "string" ? { instance: node.props.instanceOf } : null;
  return null;
}

/** What a fold changes: the record it makes, and the layers it unlinks or unmarks (`undefined`: removed). */
export interface RecordFold {
  readonly record: Record<string, PropertyValue>;
  readonly patches: ReadonlyMap<string, Record<string, unknown>>;
}

/**
 * Folds an instance from before records (`needsRecord`) into its record:
 * the values its layers, its nested copies' included (under their scope),
 * show for its properties, and the layers unlinked instead (see the top).
 */
export function foldRecord(reader: RecordReader, rootId: string): RecordFold {
  const record: Record<string, PropertyValue> = {};
  const patches = new Map<string, Record<string, unknown>>();
  interface Target {
    readonly node: NodeRecord;
    readonly field: "visible" | "characters" | "instanceOf";
    readonly value: PropertyValue | null;
    readonly differs: boolean;
  }
  const byKey = new Map<string, Target[]>();
  const ownerOf = (node: NodeRecord): NodeRecord | undefined => {
    for (let at = reader.get(node.parent), i = 0; at && at.type !== "page" && i < 1024; i++) {
      if (isInstanceRoot(at)) return at;
      at = reader.get(at.parent);
    }
    return undefined;
  };
  const ownLayerId = (id: string): string => {
    let at = id;
    for (let i = 0; i < 256; i++) {
      const mirrors = reader.get(at)?.props.mirrors;
      if (typeof mirrors !== "string" || !reader.get(mirrors)) return at;
      at = mirrors;
    }
    return at;
  };
  const definitions = (instance: NodeRecord): ComponentPropDef[] => {
    const main = reader.get(instance.props.instanceOf as string);
    if (!main) return [];
    const parent = reader.get(main.parent);
    const set = parent?.type === "frame" && parent.props.isComponentSet === true ? parent : null;
    return [set, main].flatMap((n) => (n ? getProp(n.props, "componentProps") : []));
  };
  // The layers in layer order, its own instance roots' (not copies) left to their own records.
  const stack = [...reader.childIds(rootId)].reverse();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = reader.get(id);
    if (!node) continue;
    if (isInstanceRoot(node) && typeof node.props.mirrors !== "string") continue;
    const kids = reader.childIds(id);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as string);
    const mirrors = node.props.mirrors;
    const source = typeof mirrors === "string" ? reader.get(mirrors) : undefined;
    const refs = getProp(node.props, "propRefs") as Record<string, string | undefined>;
    if (!source || Object.keys(refs).length === 0) continue;
    const owner = ownerOf(node);
    if (!owner) continue;
    // Where its values are kept: the record of the instance it's ultimately in, under a scope.
    const scope: string[] = [];
    let at: NodeRecord | undefined = owner;
    for (let i = 0; at && typeof at.props.mirrors === "string" && i < 256; i++) {
      scope.unshift(ownLayerId(at.id));
      at = ownerOf(at);
    }
    if (!at || at.id !== rootId || scope.length > MAX_PROPERTY_SCOPE) continue;
    const defs = definitions(owner);
    for (const field of ["visible", "characters", "instanceOf"] as const) {
      const propertyId = refs[field];
      const def = propertyId ? defs.find((d) => d.id === propertyId) : undefined;
      if (!propertyId || !def || FIELD_OF[def.type] !== field) continue;
      const value = fieldValue(node, field);
      const differs =
        !sameValue(value, fieldValue(source, field)) ||
        getProp(node.props, "overrides").includes(field);
      const key = propertyKey(scope, propertyId);
      const targets = byKey.get(key) ?? [];
      targets.push({ node, field, value, differs });
      byKey.set(key, targets);
    }
  }
  const patch = (id: string) => {
    let p = patches.get(id);
    if (!p) {
      p = {};
      patches.set(id, p);
    }
    return p;
  };
  for (const [key, targets] of byKey) {
    let value = targets.find((t) => t.differs)?.value ?? null;
    if (value !== null) {
      const next = { ...record, [key]: value };
      if (
        Object.keys(next).length > MAX_PROPERTY_VALUES ||
        propertyValuesChars(next) > MAX_PROPERTY_VALUES_CHARS
      )
        value = null;
      else record[key] = value;
    }
    for (const target of targets) {
      const { node, field } = target;
      const patched = patches.get(node.id);
      const marks: string[] =
        patched && "overrides" in patched
          ? ((patched.overrides as string[] | undefined) ?? [])
          : getProp(node.props, "overrides");
      const shows = value === null ? !target.differs : sameValue(target.value, value);
      if (shows) {
        // It shows the property's value: never its own.
        if (marks.includes(field)) {
          const kept = marks.filter((m) => m !== field);
          patch(node.id).overrides = kept.length > 0 ? kept : undefined;
        }
        continue;
      }
      // It shows something else: unlinked, so it keeps it, as an override.
      const own = patch(node.id);
      const refs = {
        ...((own.propRefs as Record<string, string> | undefined) ??
          getProp(node.props, "propRefs")),
      } as Record<string, string>;
      delete refs[field];
      own.propRefs = refs;
      own.overrides = [...new Set([...marks, field, "propRefs"])].sort();
    }
  }
  return { record, patches };
}

/** A fold's operations: the instance's record made whole, then each patched layer's sets. */
export function foldOps(rootId: string, fold: RecordFold): Op[] {
  const ops: Op[] = [{ op: "set", id: rootId, prop: "propValues", value: fold.record }];
  for (const [id, props] of fold.patches)
    for (const [prop, value] of Object.entries(props))
      ops.push({ op: "set", id, prop: prop as never, value: (value ?? null) as never });
  return ops;
}

/**
 * A file's nodes with every instance from before records folded into its
 * record (`foldRecord`), for content coming in whole (an import, a pasted
 * selection, a library's components, a version). The same array when none
 * needs one.
 */
export function migrateRecords(
  nodes: readonly NodeRecord[],
  /** Nodes they refer to that aren't among them (a pasted instance's main, in the file it's pasted in). */
  outside?: (id: string) => NodeRecord | undefined,
): {
  nodes: NodeRecord[];
  migrated: number;
} {
  const roots = nodes.filter(needsRecord);
  if (roots.length === 0) return { nodes: nodes as NodeRecord[], migrated: 0 };
  const store = new MemoryStore(nodes);
  const reader: RecordReader = {
    get: (id) => store.get(id) ?? outside?.(id),
    childIds: (parent) => store.childIds(parent),
  };
  const updated = new Map<string, Record<string, unknown>>();
  for (const root of roots) {
    const fold = foldRecord(reader, root.id);
    updated.set(root.id, { ...(updated.get(root.id) ?? {}), propValues: fold.record });
    for (const [id, props] of fold.patches)
      updated.set(id, { ...(updated.get(id) ?? {}), ...props });
  }
  return {
    nodes: nodes.map((node) => {
      const patch = updated.get(node.id);
      if (!patch) return node;
      const props: Record<string, unknown> = { ...node.props };
      for (const [prop, value] of Object.entries(patch)) {
        if (value === undefined) delete props[prop];
        else props[prop] = value;
      }
      return { ...node, props: props as NodeRecord["props"] };
    }),
    migrated: roots.length,
  };
}
