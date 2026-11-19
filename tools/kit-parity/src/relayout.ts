/** Compare the imported boxes with the browser editor's layout and constraint fixups. */
import { constraintOps, Doc, type LayoutBox, layoutBox, layoutOps } from "@drawpane/editor";
import { getProp, LAYER_TYPES, type NodeRecord } from "@drawpane/model";
import { readNodes } from "./detach";

const BOX = ["x", "y", "width", "height"] as const;
const LIMIT = 0.5;
const TOKENS = [
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "gap",
  "rowGap",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "visible",
] as const;
const layers = new Set<string>(LAYER_TYPES);

function box(node: NodeRecord, group?: LayoutBox) {
  return BOX.map((prop) => group?.[prop] ?? getProp(node.props, prop));
}

function differs(a: readonly number[], b: readonly number[]): boolean {
  return a.some((value, i) => Math.abs(value - (b[i] as number)) > LIMIT);
}

interface Tally {
  layers: number;
  changed: number;
  alreadyChanged: number;
  hiddenChanged: number;
}

interface Example {
  id: string;
  name: string;
  before: number[];
  after: number[];
}

export function measureRelayout(nodes: readonly NodeRecord[]) {
  const doc = new Doc();
  doc.reset(nodes);
  const changed = new Set<string>();
  const frames: (Tally & { id: string; name: string })[] = [];
  const causes = new Map<string, { count: number; examples: Example[] }>();
  const totals: Tally = { layers: 0, changed: 0, alreadyChanged: 0, hiddenChanged: 0 };
  const alreadyChanged = new Set<string>();
  const tokenInputs = new Set<string>();
  const constraints = new Set<string>();
  const hidden = new Set<string>();
  const visibility = new Map<string, boolean>();
  const groupBoxes = new Map<string, LayoutBox>();
  const unresolved = {
    get: (id: string) => doc.getUnresolved(id),
    childIds: (id: string) => doc.childIds(id),
  };
  const visible = (id: string): boolean => {
    const known = visibility.get(id);
    if (known !== undefined) return known;
    const node = doc.get(id);
    const shown = !node || (getProp(node.props, "visible") && visible(node.parent));
    visibility.set(id, shown);
    return shown;
  };

  const imported = nodes.filter((node) => layers.has(node.type));
  for (const node of imported) {
    if (!visible(node.id)) hidden.add(node.id);
    if (node.type === "group") {
      const raw = layoutBox(unresolved, node.id);
      groupBoxes.set(node.id, raw);
      if (differs(box(node, raw), box(node, layoutBox(doc, node.id)))) alreadyChanged.add(node.id);
      continue;
    }
    const resolved = doc.get(node.id);
    if (!resolved || resolved === node) continue;
    if (differs(box(node), box(resolved))) alreadyChanged.add(node.id);
    if (TOKENS.some((prop) => getProp(node.props, prop) !== getProp(resolved.props, prop)))
      tokenInputs.add(node.id);
  }
  const ops = layoutOps(
    doc,
    imported.map((node) => node.id),
  );
  const constrained = constraintOps(doc, ops);
  for (const op of constrained) constraints.add(op.id);
  doc.apply([...ops, ...constrained]);

  const hiddenChanged = new Set<string>();
  // Count each measured layer once in the kit, and include subtree counts for every frame.
  for (const node of imported) {
    const result = doc.get(node.id);
    if (!result) continue;
    totals.layers++;
    if (alreadyChanged.has(node.id)) totals.alreadyChanged++;
    const before = box(node, groupBoxes.get(node.id));
    const after = box(result, node.type === "group" ? layoutBox(doc, node.id) : undefined);
    if (!differs(before, after)) continue;
    totals.changed++;
    if (hidden.has(node.id)) {
      hiddenChanged.add(node.id);
      totals.hiddenChanged++;
    }
    const parent = doc.get(node.parent);
    // These are observable contributors, not inferred importer diagnoses.
    const cause = alreadyChanged.has(node.id)
      ? "bound box differs before layout"
      : constraints.has(node.id)
        ? "constraints follow a resized frame"
        : tokenInputs.has(node.id) || tokenInputs.has(node.parent)
          ? "layer or parent has a different resolved layout input"
          : hidden.has(node.id)
            ? "layout within a hidden subtree"
            : getProp(node.props, "layoutMode") === "grid" ||
                (parent && getProp(parent.props, "layoutMode") === "grid")
              ? "grid layout"
              : "flow layout";
    changed.add(node.id);
    const entry = causes.get(cause) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 10)
      entry.examples.push({ id: node.id, name: getProp(node.props, "name"), before, after });
    causes.set(cause, entry);
  }
  function tally(id: string): Tally {
    const node = doc.getUnresolved(id);
    const result = {
      layers: node && layers.has(node.type) ? 1 : 0,
      changed: changed.has(id) ? 1 : 0,
      alreadyChanged: alreadyChanged.has(id) ? 1 : 0,
      hiddenChanged: hiddenChanged.has(id) ? 1 : 0,
    };
    for (const child of doc.childIds(id)) {
      const counts = tally(child);
      result.layers += counts.layers;
      result.changed += counts.changed;
      result.alreadyChanged += counts.alreadyChanged;
      result.hiddenChanged += counts.hiddenChanged;
    }
    if (node?.type === "frame") frames.push({ id, name: getProp(node.props, "name"), ...result });
    return result;
  }
  for (const node of nodes) if (node.type === "page" || node.type === "library") tally(node.id);
  return {
    threshold: LIMIT,
    boxOrder: BOX,
    ...totals,
    framesAffected: frames.filter((frame) => frame.changed > 0).length,
    frames,
    causes: [...causes]
      .map(([cause, entry]) => ({ cause, ...entry }))
      .sort((a, b) => b.count - a.count),
  };
}

export function relayoutReport(path: string) {
  return measureRelayout(readNodes(path));
}
