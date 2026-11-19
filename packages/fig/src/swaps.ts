/**
 * A nested instance swapped to another component (an instance swap
 * property, or a variant chosen on it) takes the swapped-in component's own
 * look, as Figma shows it.
 *
 * Figma saves a nested instance's own properties on its record, the same as
 * its component's. When an instance swaps it for another component, Figma
 * draws it with the new component's fills, strokes, effects and corners,
 * except what the instance overrides. Open Pencil 0.16 swaps its layers but
 * keeps the record's own properties, so an outline button swapped for a
 * filled one keeps the outline's white fill and border while its label takes
 * the filled one's colour. Here every such property still equal to the old
 * component's, bound to what the old component binds it to (so not an
 * override), takes the new component's value and its binding: a swapped
 * button's fill follows the filled variant's variable, in every mode.
 *
 * Its auto layout too: a Field whose Input is swapped for a Textarea lays the
 * Textarea out as a column with its own padding and gap, not the Input's
 * row. (Kept as the Input's, it also differed from the Textarea's main
 * everywhere, and came in as overrides, decision 0035.) How it sits in its
 * parent (grow, stretch, constraints) stays the instance's own.
 */
import type { SceneGraph, SceneNode } from "@open-pencil/scene-graph";
import type { RestIds } from "./ids";
import { guidString, type RawRecord } from "./raw";

/** What a swap carries over: paints, strokes, effects, corners, opacity and auto layout. */
const LOOK = [
  "fills",
  "strokes",
  "strokeWeight",
  "strokeAlign",
  "independentStrokeWeights",
  "borderTopWeight",
  "borderRightWeight",
  "borderBottomWeight",
  "borderLeftWeight",
  "effects",
  "cornerRadius",
  "topLeftRadius",
  "topRightRadius",
  "bottomLeftRadius",
  "bottomRightRadius",
  "independentCorners",
  "cornerSmoothing",
  "opacity",
  // Its own auto layout, and the sizes it may take.
  "layoutMode",
  "layoutWrap",
  "primaryAxisAlign",
  "counterAxisAlign",
  "primaryAxisSizing",
  "counterAxisSizing",
  "itemSpacing",
  "counterAxisSpacing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "clipsContent",
] as const;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Kiwi's names for the look fields a variable binds, as an override's consumption map has them. */
const BOUND_LOOK_FIELDS: Readonly<Record<string, string>> = {
  CORNER_RADIUS: "cornerRadius",
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: "topLeftRadius",
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: "topRightRadius",
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: "bottomLeftRadius",
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: "bottomRightRadius",
  STROKE_WEIGHT: "strokeWeight",
  BORDER_TOP_WEIGHT: "borderTopWeight",
  BORDER_RIGHT_WEIGHT: "borderRightWeight",
  BORDER_BOTTOM_WEIGHT: "borderBottomWeight",
  BORDER_LEFT_WEIGHT: "borderLeftWeight",
  STACK_SPACING: "itemSpacing",
  STACK_COUNTER_SPACING: "counterAxisSpacing",
  STACK_PADDING_LEFT: "paddingLeft",
  STACK_PADDING_TOP: "paddingTop",
  STACK_PADDING_RIGHT: "paddingRight",
  STACK_PADDING_BOTTOM: "paddingBottom",
  OPACITY: "opacity",
  MIN_WIDTH: "minWidth",
  MAX_WIDTH: "maxWidth",
  MIN_HEIGHT: "minHeight",
  MAX_HEIGHT: "maxHeight",
};
/**
 * The plain look values an override saves in the units Open Pencil keeps
 * them in. Open Pencil 0.16 swaps a nested instance itself and drops these
 * from the override when it does, so they're put back from the record.
 */
const PLAIN_LOOK_FIELDS: Readonly<Record<string, string>> = {
  opacity: "opacity",
  cornerRadius: "cornerRadius",
  rectangleTopLeftCornerRadius: "topLeftRadius",
  rectangleTopRightCornerRadius: "topRightRadius",
  rectangleBottomLeftCornerRadius: "bottomLeftRadius",
  rectangleBottomRightCornerRadius: "bottomRightRadius",
  cornerSmoothing: "cornerSmoothing",
  strokeWeight: "strokeWeight",
  borderTopWeight: "borderTopWeight",
  borderRightWeight: "borderRightWeight",
  borderBottomWeight: "borderBottomWeight",
  borderLeftWeight: "borderLeftWeight",
  stackSpacing: "itemSpacing",
  stackCounterSpacing: "counterAxisSpacing",
  stackVerticalPadding: "paddingTop",
  stackPaddingRight: "paddingRight",
  stackPaddingBottom: "paddingBottom",
  stackHorizontalPadding: "paddingLeft",
};

/**
 * The record fields an override sets a look field with, by Kiwi name: the
 * lists (whose paints and effects carry their own bindings) and the plain
 * values. One an override saves is the instance's own, bound or not.
 */
const SET_LOOK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  fillPaints: ["fills"],
  strokePaints: ["strokes"],
  effects: ["effects"],
  opacity: ["opacity"],
  cornerRadius: ["cornerRadius"],
  rectangleTopLeftCornerRadius: ["topLeftRadius"],
  rectangleTopRightCornerRadius: ["topRightRadius"],
  rectangleBottomLeftCornerRadius: ["bottomLeftRadius"],
  rectangleBottomRightCornerRadius: ["bottomRightRadius"],
  rectangleCornerRadiiIndependent: ["independentCorners"],
  cornerSmoothing: ["cornerSmoothing"],
  strokeWeight: ["strokeWeight"],
  strokeAlign: ["strokeAlign"],
  borderStrokeWeightsIndependent: ["independentStrokeWeights"],
  borderTopWeight: ["borderTopWeight"],
  borderRightWeight: ["borderRightWeight"],
  borderBottomWeight: ["borderBottomWeight"],
  borderLeftWeight: ["borderLeftWeight"],
  stackMode: ["layoutMode"],
  stackWrap: ["layoutWrap"],
  stackPrimaryAlignItems: ["primaryAxisAlign"],
  stackCounterAlignItems: ["counterAxisAlign"],
  stackPrimarySizing: ["primaryAxisSizing"],
  stackCounterSizing: ["counterAxisSizing"],
  stackSpacing: ["itemSpacing"],
  stackCounterSpacing: ["counterAxisSpacing"],
  stackVerticalPadding: ["paddingTop"],
  stackPaddingRight: ["paddingRight"],
  stackPaddingBottom: ["paddingBottom"],
  stackHorizontalPadding: ["paddingLeft"],
  minSize: ["minWidth", "minHeight"],
  maxSize: ["maxWidth", "maxHeight"],
  frameMaskDisabled: ["clipsContent"],
};

/**
 * The look fields the instances around a layer bind or set explicitly in
 * their overrides: the layer's own, kept through a swap with its value and
 * binding, even where its value matches the old component's (decision 0034).
 */
function explicitLooks(overrides: readonly Readonly<Record<string, unknown>>[]): {
  /** Fields an override binds or sets. */
  readonly set: Set<string>;
  /** Fields an override binds. */
  readonly bound: Set<string>;
  /** Plain values an override sets, in the units Open Pencil keeps them in (the outermost's). */
  readonly values: Map<string, unknown>;
} {
  const set = new Set<string>();
  const bound = new Set<string>();
  const values = new Map<string, unknown>();
  for (const o of overrides) {
    for (const map of [o.variableConsumptionMap, o.parameterConsumptionMap]) {
      const entries = (map as { entries?: { variableField?: unknown }[] } | undefined)?.entries;
      for (const entry of entries ?? []) {
        const field = typeof entry.variableField === "string" ? entry.variableField : "";
        const look = BOUND_LOOK_FIELDS[field];
        if (look) {
          set.add(look);
          bound.add(look);
        }
      }
    }
    for (const [field, looks] of Object.entries(SET_LOOK_FIELDS))
      if (o[field] !== undefined) for (const look of looks) set.add(look);
    for (const [field, look] of Object.entries(PLAIN_LOOK_FIELDS))
      if (typeof o[field] === "number" && !values.has(look)) values.set(look, o[field]);
  }
  return { set, bound, values };
}

type Bound = Readonly<Record<string, string>>;

/** The variables a node binds a look field to (`fills/0/color` for a list's, the field's own name otherwise). */
function bindingsOf(bound: Bound | undefined, field: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, id] of Object.entries(bound ?? {}))
    if (key === field || key.startsWith(`${field}/`)) out[key] = id;
  return out;
}

/**
 * Gives swapped nested instances their new component's look where they
 * don't override it. `layers` maps record guids to the layers they became.
 * Returns how many instances changed.
 */
export function applySwappedLooks(
  graph: SceneGraph,
  ids: Pick<RestIds, "sourceGuid"> & Partial<Pick<RestIds, "overridesOf">>,
  records: ReadonlyMap<string, RawRecord>,
  layers: ReadonlyMap<string, string>,
): number {
  let changed = 0;
  for (const node of graph.getAllNodes()) {
    if (node.type !== "INSTANCE" || !node.componentId) continue;
    // The record it copies, and the component that record names.
    const source = ids.sourceGuid(node);
    const symbol = source ? records.get(source)?.symbolData?.symbolID : undefined;
    if (!symbol) continue;
    const before = guidString(symbol);
    const now = ids.sourceGuid(graph.getNode(node.componentId) as SceneNode);
    if (!now || now === before) continue;
    const oldLayer = layers.get(before);
    const oldMain = oldLayer ? graph.getNode(oldLayer) : undefined;
    const newMain = graph.getNode(node.componentId);
    if (!oldMain || !newMain) continue;
    const updates: Record<string, unknown> = {};
    const own = node as unknown as Record<string, unknown>;
    const was = oldMain as unknown as Record<string, unknown>;
    const next = newMain as unknown as Record<string, unknown>;
    // Provenance, not colour (decision 0034): a field the instance doesn't override (its value
    // still the old component's) takes the new component's value and its binding, whatever
    // the copy's binding was (a main holding the copy may bind it to another variable, and
    // Open Pencil leaves some copies' bindings out). One whose value differs is an override:
    // its value and binding are kept.
    // A field an override binds or sets is the instance's own, even when it matches the old
    // component's value (two variables can agree in the mode it was saved in).
    const explicit = explicitLooks(ids.overridesOf?.(node) ?? []);
    const bound = { ...(node.boundVariables as Bound | undefined) };
    let rebound = false;
    for (const field of LOOK) {
      if (explicit.set.has(field)) {
        // The override's own: its plain value back where Open Pencil's swap dropped it, and,
        // unless the override binds it too, no binding of the new component's over it.
        const value = explicit.values.get(field);
        if (value === undefined) continue;
        if (!same(own[field], value)) updates[field] = value;
        if (!explicit.bound.has(field)) {
          const binds = bindingsOf(bound, field);
          if (Object.keys(binds).length > 0) {
            for (const key of Object.keys(binds)) delete bound[key];
            rebound = true;
          }
        }
        continue;
      }
      if (!same(own[field], was[field])) continue;
      const ownBinds = bindingsOf(node.boundVariables as Bound, field);
      if (!same(own[field], next[field])) updates[field] = structuredClone(next[field]);
      const nextBinds = bindingsOf(newMain.boundVariables as Bound, field);
      if (same(ownBinds, nextBinds)) continue;
      for (const key of Object.keys(ownBinds)) delete bound[key];
      Object.assign(bound, nextBinds);
      rebound = true;
    }
    if (rebound) updates.boundVariables = bound;
    if (Object.keys(updates).length > 0) {
      graph.updateNode(node.id, updates as Partial<SceneNode>);
      changed++;
    }
  }
  return changed;
}
