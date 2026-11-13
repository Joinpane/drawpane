/**
 * Selection colors: every solid color used inside the selection (fills,
 * strokes, gradient stops, shadows), and the operations that swap one for
 * another everywhere it appears, so a whole card recolors in one edit.
 */
import type { Doc } from "@drawpane/editor";
import { getProp, type NodeRecord, type Op, type Paint, type PropValues } from "@drawpane/model";

export interface SelectionColor {
  /** Lowercase `#rrggbb` or `#rrggbbaa`, as stored. */
  readonly color: string;
  /** How many layers use it. */
  readonly layers: number;
}

type Effect = PropValues["effects"][number];

function subtree(doc: Doc, ids: readonly string[]): NodeRecord[] {
  const out: NodeRecord[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = doc.get(id);
    if (!node) return;
    out.push(node);
    for (const c of doc.childIds(id)) walk(c);
  };
  for (const id of ids) walk(id);
  return out;
}

function paintColors(paint: Paint): string[] {
  if (paint.type === "solid") return [paint.color];
  if (paint.type === "image") return [];
  return paint.stops.map((s) => s.color);
}

function nodeColors(node: NodeRecord): Set<string> {
  const colors = new Set<string>();
  for (const p of [...getProp(node.props, "fills"), ...getProp(node.props, "strokes")])
    for (const c of paintColors(p)) colors.add(c.toLowerCase());
  for (const e of getProp(node.props, "effects"))
    if ("color" in e) colors.add(e.color.toLowerCase());
  return colors;
}

/**
 * Colors used in the selection and below it, most used first; ties keep the
 * order the layers use them, so changing a color never reorders the list.
 */
export function selectionColors(doc: Doc, ids: readonly string[]): SelectionColor[] {
  const counts = new Map<string, number>();
  for (const node of subtree(doc, ids))
    for (const c of nodeColors(node)) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()]
    .map(([color, layers]) => ({ color, layers }))
    .sort((a, b) => b.layers - a.layers);
}

/** Operations that change `from` to `to` in every paint and shadow of the selection. */
export function replaceColorOps(doc: Doc, ids: readonly string[], from: string, to: string): Op[] {
  const match = (c: string) => c.toLowerCase() === from.toLowerCase();
  const swapPaint = (p: Paint): Paint => {
    if (p.type === "solid") return match(p.color) ? { ...p, color: to } : p;
    if (p.type === "image") return p;
    return { ...p, stops: p.stops.map((s) => (match(s.color) ? { ...s, color: to } : s)) };
  };
  const swapEffect = (e: Effect): Effect =>
    "color" in e && match(e.color) ? { ...e, color: to } : e;
  const ops: Op[] = [];
  for (const node of subtree(doc, ids)) {
    if (!nodeColors(node).has(from.toLowerCase())) continue;
    for (const prop of ["fills", "strokes"] as const) {
      const now = getProp(node.props, prop);
      const next = now.map(swapPaint);
      if (JSON.stringify(next) !== JSON.stringify(now))
        ops.push({ op: "set", id: node.id, prop, value: next });
    }
    const effects = getProp(node.props, "effects");
    const nextEffects = effects.map(swapEffect);
    if (JSON.stringify(nextEffects) !== JSON.stringify(effects))
      ops.push({ op: "set", id: node.id, prop: "effects", value: nextEffects });
  }
  return ops;
}
