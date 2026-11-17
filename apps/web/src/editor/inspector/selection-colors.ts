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

/** The layers in the selection and below it; null once there are more than `limit`. */
function subtree(doc: Doc, ids: readonly string[], limit = Infinity): NodeRecord[] | null {
  const out: NodeRecord[] = [];
  const seen = new Set<string>();
  const stack = [...ids].reverse();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = doc.get(id);
    if (!node) continue;
    if (out.length >= limit) return null;
    out.push(node);
    const children = doc.childIds(id);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as string);
  }
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
 * Null when the selection holds more than `limit` layers: in a kit-sized
 * frame, reading every layer's paints is more than a click should wait for.
 */
export function selectionColors(
  doc: Doc,
  ids: readonly string[],
  limit = Infinity,
): SelectionColor[] | null {
  const layers = subtree(doc, ids, limit);
  if (!layers) return null;
  const counts = new Map<string, number>();
  for (const node of layers)
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
  for (const node of subtree(doc, ids) ?? []) {
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
