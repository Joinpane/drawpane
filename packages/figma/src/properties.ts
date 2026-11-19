/**
 * Figma's component properties (decision 0035): a component's or set's
 * `componentPropertyDefinitions` as Drawpane's `componentProps`, and a
 * layer's `componentPropertyReferences` as its `propRefs`. An instance's
 * values need nothing: its copies already hold them.
 */
import {
  type ComponentPropDef,
  type ComponentPropType,
  copyChildId,
  PropertyId,
} from "@drawpane/model";
import type * as Figma from "./rest";

const TYPES: Readonly<Record<string, ComponentPropType>> = {
  BOOLEAN: "boolean",
  TEXT: "text",
  INSTANCE_SWAP: "instance",
  VARIANT: "variant",
  SLOT: "slot",
};

/** Where a key's id starts: Figma's keys are "Name#id" for every type but variants. */
function idStart(key: string): number {
  const at = key.lastIndexOf("#");
  return at > 0 && at < key.length - 1 ? at : -1;
}

/**
 * A property's key as a Drawpane property id: Figma's id after the "#", or
 * for a variant (keyed by its name alone) one worked out from the name. The
 * same file always gives the same ids.
 */
export function propertyId(key: string): string {
  const at = idStart(key);
  if (at > 0) {
    const id = key
      .slice(at + 1)
      .replace(/[^\w:.-]/g, "_")
      .slice(0, 64);
    if (PropertyId.safeParse(id).success) return id;
  }
  return `v${copyChildId("variant", key)}`;
}

/** A property's name: its key without Figma's id. */
export function propertyName(key: string): string {
  const at = idStart(key);
  return (at > 0 ? key.slice(0, at) : key).trim().slice(0, 64) || "Property";
}

/** How the converter finds the components a property names. */
export interface PropertyLinks {
  /** A component by its Figma id, as a Drawpane id, when it's in the file. */
  component(figmaId: string): string | undefined;
  /** A component or set by its key, as a Drawpane id, when it's in the file. */
  byKey(key: string): string | undefined;
}

/** A component's or set's property definitions, in Figma's order. */
export function convertDefinitions(
  definitions: Readonly<Record<string, Figma.ComponentPropertyDefinition>>,
  links: PropertyLinks,
): ComponentPropDef[] {
  const out: ComponentPropDef[] = [];
  const ids = new Set<string>();
  for (const [key, definition] of Object.entries(definitions)) {
    const type = TYPES[definition.type];
    if (!type) continue;
    const id = propertyId(key);
    if (ids.has(id)) continue;
    ids.add(id);
    const def: { -readonly [K in keyof ComponentPropDef]: ComponentPropDef[K] } = {
      id,
      name: propertyName(key),
      type,
    };
    const value = definition.defaultValue;
    if (type === "boolean") def.default = value === true || value === "true";
    else if (type === "text" && typeof value === "string") def.default = value.slice(0, 10_000);
    else if (type === "instance" && typeof value === "string") {
      const component = links.component(value);
      if (component) def.default = component;
    }
    if (type === "instance" && definition.preferredValues) {
      const preferred = definition.preferredValues
        .map((p) => links.byKey(p.key))
        .filter((p): p is string => !!p);
      if (preferred.length > 0) def.preferred = [...new Set(preferred)].slice(0, 64);
    }
    if (definition.description) def.description = definition.description.slice(0, 500);
    out.push(def);
    if (out.length === 64) break;
  }
  return out;
}

/**
 * A layer's references to properties, by the field each drives; null when
 * it has none to say (it takes its main layer's, if it's a copy). An
 * explicitly empty set of references (`{}`) is kept, as `{}`: a copy's
 * layer unlinked from its main layer's properties, whose differences are
 * its own and which setting a property leaves alone (decision 0035).
 */
export function convertReferences(
  references: Figma.Node["componentPropertyReferences"],
): Record<string, string> | null {
  if (!references) return null;
  const out: Record<string, string> = {};
  if (references.visible) out.visible = propertyId(references.visible);
  if (references.characters) out.characters = propertyId(references.characters);
  if (references.mainComponent) out.instanceOf = propertyId(references.mainComponent);
  return out;
}
