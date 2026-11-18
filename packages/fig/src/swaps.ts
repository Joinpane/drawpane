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
 */
import type { SceneGraph, SceneNode } from "@open-pencil/scene-graph";
import type { RestIds } from "./ids";
import { guidString, type RawRecord } from "./raw";

/** The look a swap carries over: paints, strokes, effects, corners and opacity. */
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
  "opacity",
] as const;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

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
    // Provenance, not colour (decision 0034): a field the instance doesn't override (its value
    // the old component's, and its binding the old component's or none, as Open Pencil keeps
    // some copies' bindings) takes the new component's value and binding. A binding of its own
    // (another variable than the old component's) is an override, kept.
    const bound = { ...(node.boundVariables as Bound | undefined) };
    let rebound = false;
    for (const field of LOOK) {
      const ownBinds = bindingsOf(node.boundVariables as Bound, field);
      const wasBinds = bindingsOf(oldMain.boundVariables as Bound, field);
      const bindsInherited = Object.keys(ownBinds).length === 0 || same(ownBinds, wasBinds);
      if (!same(own[field], was[field]) || !bindsInherited) continue;
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
