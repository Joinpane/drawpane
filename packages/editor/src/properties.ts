/**
 * Component properties on an instance (decision 0035), and its overrides in
 * words.
 *
 * A main (or its set) defines its properties (`componentProps`); its layers
 * say which of their values a property drives (`propRefs`). An instance's
 * values are in a record (`propValues`, see `property-values.ts`): its own,
 * or, for a nested instance in a copy, the record of the instance it's in.
 * The layers they drive show them as they're read. Nested instances a main
 * exposes (`exposeProps`) show their own properties under the instance's.
 */
import {
  type ComponentPropDef,
  type ComponentPropType,
  getProp,
  type NodeRecord,
  ROOT_LOCAL_PROPS,
} from "@drawpane/model";
import { componentSetOf, isInstanceRoot, isMainComponent, variantProperties } from "./components";
import type { Doc } from "./doc";
import { layerName } from "./names";
import {
  definitionsOf,
  drivenLayers,
  FIELD_OF,
  fieldValue,
  fromRecordValue,
  instanceValues,
  refKey,
} from "./property-values";

export { definitionsOf, FIELD_OF };

export interface PropertyRow {
  /** The property's id (a variant's entry may have none: then its name). */
  readonly id: string;
  readonly name: string;
  readonly type: ComponentPropType;
  readonly description?: string;
  /** A boolean, a text, a component id (instance swap) or a variant's value. */
  readonly value: boolean | string | null;
  /** A variant's values. */
  readonly options?: readonly string[];
  /** An instance swap's preferred components, in order. */
  readonly preferred?: readonly string[];
  /** The layers it drives in this instance (none for a variant). */
  readonly targets: readonly string[];
  /** Whether this instance changed it. */
  readonly changed: boolean;
}

export interface InstanceProperties {
  readonly instanceId: string;
  /** The instance's layer name: a nested one's heading. */
  readonly name: string;
  readonly rows: readonly PropertyRow[];
  /** Exposed nested instances, in layer order. */
  readonly nested: readonly InstanceProperties[];
}

/** Nested instances under `rootId` whose main exposes them, in layer order (not inside other instances). */
function exposedUnder(doc: Doc, rootId: string): string[] {
  const out: string[] = [];
  const visit = (parent: string) => {
    for (const id of doc.childIds(parent)) {
      const node = doc.get(id);
      if (!node) continue;
      if (isInstanceRoot(node)) {
        if (getProp(node.props, "exposeProps")) out.push(id);
        continue;
      }
      visit(id);
    }
  };
  visit(rootId);
  return out;
}

/**
 * An instance's properties, as its panel shows them: its main's (variants
 * in the set's order) with this instance's values, then the exposed nested
 * instances' in turn. Null when it isn't an instance of a live main.
 */
export function instanceProperties(
  doc: Doc,
  instanceId: string,
  depth = 0,
): InstanceProperties | null {
  const instance = doc.get(instanceId);
  if (!isInstanceRoot(instance) || !instance) return null;
  const mainId = getProp(instance.props, "instanceOf");
  const main = mainId ? doc.get(mainId) : undefined;
  if (!main || !isMainComponent(main)) return null;
  const set = componentSetOf(doc, main.id);
  const defs = definitionsOf(doc, main.id);
  const refs = drivenLayers(doc, instanceId);
  const record = instanceValues(doc, instanceId);

  const rows: PropertyRow[] = [];
  // Variants: those the definitions place, where they place them; any others first.
  const variants = set ? variantProperties(doc, set.id) : [];
  const current = getProp(main.props, "variantProps");
  // A nested instance's variant changed when it differs from the one its main layer is.
  const sourceId = getProp(instance.props, "mirrors");
  const sourceOf = sourceId ? getProp(doc.get(sourceId)?.props ?? {}, "instanceOf") : null;
  const original = sourceOf ? getProp(doc.get(sourceOf)?.props ?? {}, "variantProps") : null;
  const variantRow = (name: string, def?: ComponentPropDef): PropertyRow | null => {
    const property = variants.find((v) => v.name === name);
    if (!property) return null;
    return {
      id: def?.id ?? name,
      name,
      type: "variant",
      ...(def?.description ? { description: def.description } : {}),
      value: current[name] ?? null,
      options: property.values,
      targets: [],
      changed: original !== null && (original[name] ?? null) !== (current[name] ?? null),
    };
  };
  const placed = new Set(defs.filter((d) => d.type === "variant").map((d) => d.name));
  for (const v of variants)
    if (!placed.has(v.name)) {
      const row = variantRow(v.name);
      if (row) rows.push(row);
    }
  for (const def of defs) {
    if (def.type === "variant") {
      const row = variantRow(def.name, def);
      if (row) rows.push(row);
      continue;
    }
    const field = FIELD_OF[def.type];
    if (!field) continue;
    const targets = refs.get(refKey(def.id, field)) ?? [];
    // A property no layer here takes can't be set on this instance (its value, if it has one, waits).
    if (targets.length === 0) continue;
    const recorded = record[def.id];
    // Its value: the record's; or, when it keeps none, what its layers show from the main.
    const shownBy = doc.get(targets[0] as string);
    const shown = shownBy ? fieldValue(shownBy, field) : null;
    const value =
      recorded !== undefined
        ? fromRecordValue(recorded)
        : shown === null
          ? null
          : fromRecordValue(shown);
    rows.push({
      id: def.id,
      name: def.name,
      type: def.type,
      ...(def.description ? { description: def.description } : {}),
      value,
      ...(def.preferred ? { preferred: def.preferred } : {}),
      targets,
      changed: recorded !== undefined,
    });
  }
  // Deep chains of exposed instances stop somewhere; Figma's kits go three or four deep.
  const nested =
    depth < 8
      ? exposedUnder(doc, instanceId)
          .map((id) => instanceProperties(doc, id, depth + 1))
          .filter((p): p is InstanceProperties => !!p && (p.rows.length > 0 || p.nested.length > 0))
      : [];
  return { instanceId, name: layerName(instance), rows, nested };
}

/** Finds a property row by id in an instance's properties or its nested ones'. */
export function findPropertyRow(
  properties: InstanceProperties,
  instanceId: string,
  propertyId: string,
): PropertyRow | undefined {
  if (properties.instanceId === instanceId) return properties.rows.find((r) => r.id === propertyId);
  for (const nested of properties.nested) {
    const row = findPropertyRow(nested, instanceId, propertyId);
    if (row) return row;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Overrides in words

/** One change to one layer, as a person names it, and the properties it resets. */
export interface OverrideItem {
  readonly id: string;
  /** "Text", "Fill", "Hidden", "Swapped to Check"… */
  readonly label: string;
  readonly props: readonly string[];
}

export interface OverrideGroup {
  readonly id: string;
  /** The layer's path from the instance: "Textarea › Placeholder"; the instance itself is "". */
  readonly path: string;
  readonly items: readonly OverrideItem[];
}

/** Names for what changed. Properties not listed are named from their own name. */
const LABELS: Readonly<Record<string, string>> = {
  characters: "Text",
  textRuns: "Text style",
  fills: "Fill",
  strokes: "Stroke",
  strokeWeight: "Stroke weight",
  strokeWeights: "Stroke weight",
  strokeAlign: "Stroke position",
  strokeDashes: "Dashes",
  strokeCap: "Stroke ends",
  strokeJoin: "Stroke joins",
  opacity: "Opacity",
  blendMode: "Blend mode",
  cornerRadius: "Corner radius",
  cornerRadii: "Corner radius",
  effects: "Effects",
  width: "Size",
  height: "Size",
  x: "Position",
  y: "Position",
  rotation: "Rotation",
  flipX: "Flip",
  flipY: "Flip",
  sizingH: "Resizing",
  sizingV: "Resizing",
  minWidth: "Min and max size",
  maxWidth: "Min and max size",
  minHeight: "Min and max size",
  maxHeight: "Min and max size",
  fontFamily: "Font",
  fontWeight: "Font weight",
  fontSize: "Font size",
  fontStyle: "Font style",
  lineHeight: "Line height",
  letterSpacing: "Letter spacing",
  textAlign: "Text alignment",
  textAlignVertical: "Text alignment",
  textDecoration: "Decoration",
  textCase: "Case",
  textAutoResize: "Text resizing",
  pathData: "Shape",
  layoutMode: "Auto layout",
  layoutWrap: "Wrap",
  gap: "Gap",
  rowGap: "Gap",
  paddingTop: "Padding",
  paddingRight: "Padding",
  paddingBottom: "Padding",
  paddingLeft: "Padding",
  justifyContent: "Alignment",
  alignItems: "Alignment",
  clipContent: "Clip content",
  layoutGrids: "Layout grids",
  constraintH: "Constraints",
  constraintV: "Constraints",
  name: "Name",
  reactions: "Interactions",
  locked: "Locked",
};

/** Bookkeeping an instance holds that no person changed: never listed. */
const UNLISTED: ReadonlySet<string> = new Set([
  "propRefs",
  "exposeProps",
  "propValues",
  "bindings",
]);

function labelFor(doc: Doc, node: NodeRecord, prop: string): string {
  if (prop === "visible") return getProp(node.props, "visible") ? "Shown" : "Hidden";
  if (prop === "instanceOf") {
    const to = getProp(node.props, "instanceOf");
    const main = to ? doc.get(to) : undefined;
    const set = main ? componentSetOf(doc, main.id) : undefined;
    const name = main ? getProp(main.props, "name") : "";
    return set
      ? `Swapped to ${getProp(set.props, "name")} (${name})`
      : `Swapped to ${name || "another component"}`;
  }
  const known = LABELS[prop];
  if (known) return known;
  const words = prop.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What a person changed in an instance, by layer in layer order, nested
 * instances' layers included. Values a property row shows aren't listed
 * again (`shown`: layer ids to the fields their rows show).
 */
export function overrideGroups(
  doc: Doc,
  instanceId: string,
  shown: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): OverrideGroup[] {
  const groups: OverrideGroup[] = [];
  const visit = (id: string, path: string) => {
    const node = doc.get(id);
    if (!node) return;
    const hidden = shown.get(id);
    const byLabel = new Map<string, string[]>();
    for (const prop of getProp(node.props, "overrides")) {
      if (UNLISTED.has(prop) || hidden?.has(prop)) continue;
      // Where an instance sits in its parent is its own, never a change.
      if (id === instanceId && ROOT_LOCAL_PROPS.has(prop)) continue;
      const label = labelFor(doc, node, prop);
      const list = byLabel.get(label);
      if (list) list.push(prop);
      else byLabel.set(label, [prop]);
    }
    if (byLabel.size > 0)
      groups.push({
        id,
        path,
        items: [...byLabel].map(([label, props]) => ({ id, label, props })),
      });
    for (const child of doc.childIds(id)) {
      const kid = doc.get(child);
      if (!kid) continue;
      const name = layerName(kid);
      visit(child, path ? `${path} › ${name}` : name);
    }
  };
  visit(instanceId, "");
  return groups;
}

/** Layer ids to the fields an instance's property rows show, nested ones included. */
export function shownFields(properties: InstanceProperties | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (id: string, field: string) => {
    const set = out.get(id);
    if (set) set.add(field);
    else out.set(id, new Set([field]));
  };
  const walk = (p: InstanceProperties) => {
    for (const row of p.rows) {
      const field = FIELD_OF[row.type];
      if (field) for (const id of row.targets) add(id, field);
      // A variant row shows which variant the instance is.
      if (row.type === "variant") add(p.instanceId, "instanceOf");
    }
    for (const nested of p.nested) walk(nested);
  };
  if (properties) walk(properties);
  return out;
}

/** How many changes an instance has, in the list's terms plus what its property rows show. */
export function countChanges(
  doc: Doc,
  instanceId: string,
  properties: InstanceProperties | null,
): number {
  let rows = 0;
  const walk = (p: InstanceProperties) => {
    for (const row of p.rows) if (row.changed) rows++;
    for (const nested of p.nested) walk(nested);
  };
  if (properties) walk(properties);
  const listed = overrideGroups(doc, instanceId, shownFields(properties)).reduce(
    (n, g) => n + g.items.length,
    0,
  );
  return rows + listed;
}
