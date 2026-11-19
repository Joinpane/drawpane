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
 * component's (so not an override) takes the new component's value.
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

/**
 * Gives swapped nested instances their new component's look where they
 * don't override it. `layers` maps record guids to the layers they became.
 * Returns how many instances changed.
 */
export function applySwappedLooks(
  graph: SceneGraph,
  ids: RestIds,
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
    for (const field of LOOK)
      if (same(own[field], was[field]) && !same(own[field], next[field]))
        updates[field] = structuredClone(next[field]);
    if (Object.keys(updates).length > 0) {
      graph.updateNode(node.id, updates as Partial<SceneNode>);
      changed++;
    }
  }
  return changed;
}
