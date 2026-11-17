/**
 * One frame's layout, Figma's against Drawpane's, layer by layer, matched by
 * Figma id (Drawpane's id is `drawpaneId` of it, as the importer made it).
 *
 * Boxes are axis-aligned page rects on both sides. A layer counts as moved
 * when it moved relative to its parent (so a shifted container doesn't count
 * every layer inside it again), and as resized when its size differs; both
 * by more than the tolerance. A layer whose id the importer spelled
 * differently (slot content, say) is matched by its place instead: the
 * first unmatched child of its parent's match with the same name, in order. Layers Drawpane never makes (the operands of a
 * boolean, which import as one path) are counted apart from ones missing.
 */
import { drawpaneId } from "@drawpane/figma";

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FigmaNode {
  readonly id: string;
  readonly parent: string | null;
  readonly name: string;
  readonly type: string;
  readonly visible: boolean;
  readonly box: Box | null;
  readonly render: Box | null;
  readonly text?: {
    readonly fonts: readonly string[];
    readonly sizes?: readonly number[];
    readonly chars?: number;
    readonly missingFont: boolean;
    readonly autoResize?: string;
  };
}

export interface DrawpaneNode {
  readonly id: string;
  readonly parent: string | null;
  readonly type: string;
  readonly name: string;
  readonly visible: boolean;
  readonly box: Box | null;
  /** For text: the faces it's drawn in ("Inter/500", "Inter/400i"). */
  readonly faces?: readonly string[];
  /** For text: its widest line unwrapped, and its lines in its box, as Drawpane measures them. */
  readonly text?: { readonly width: number; readonly lines: number };
}

export interface Delta {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** Drawpane minus Figma: position relative to the parent's, then size. */
  readonly dx: number;
  readonly dy: number;
  readonly dw: number;
  readonly dh: number;
}

export interface LayoutDiff {
  readonly figmaNodes: number;
  readonly drawpaneNodes: number;
  readonly matched: number;
  /** Of those, matched by place because the ids differ: Figma's id, then Drawpane's. */
  readonly byPlace: readonly (readonly [string, string])[];
  /** In Figma, not in Drawpane. */
  readonly missing: readonly { id: string; name: string; type: string }[];
  /** Boolean operands Drawpane flattens into one path: expected, counted apart. */
  readonly flattened: number;
  /** In Drawpane, not in Figma. */
  readonly extra: readonly { id: string; type: string }[];
  /** Shown on one side, hidden on the other (the layer's own flag). */
  readonly visibility: readonly { id: string; name: string; figma: boolean; drawpane: boolean }[];
  readonly moved: readonly Delta[];
  readonly resized: readonly Delta[];
  /** Text layers whose box differs (position or size). */
  readonly text: readonly Delta[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function diffLayout(
  figma: readonly FigmaNode[],
  drawpane: readonly DrawpaneNode[],
  tolerance = 0.5,
): LayoutDiff {
  const ours = new Map(drawpane.map((n) => [n.id, n]));
  const theirs = new Map(figma.map((n) => [n.id, n]));
  const matchedIds = new Set<string>();
  const childrenOf = new Map<string, DrawpaneNode[]>();
  for (const n of drawpane)
    if (n.parent) childrenOf.set(n.parent, [...(childrenOf.get(n.parent) ?? []), n]);

  // Figma id → Drawpane layer: by id, else by place under the parent's match (parents come
  // first: both trees are listed depth first).
  const match = new Map<string, DrawpaneNode>();
  const byPlace: [string, string][] = [];
  for (const n of figma) {
    const byId = ours.get(drawpaneId(n.id));
    if (byId && !matchedIds.has(byId.id)) {
      match.set(n.id, byId);
      matchedIds.add(byId.id);
    }
  }
  for (const n of figma) {
    if (match.has(n.id) || !n.parent) continue;
    const parent = match.get(n.parent);
    if (!parent) continue;
    const found = (childrenOf.get(parent.id) ?? []).find(
      (c) => !matchedIds.has(c.id) && c.name === n.name,
    );
    if (!found) continue;
    match.set(n.id, found);
    matchedIds.add(found.id);
    byPlace.push([n.id, found.id]);
  }

  const insideBoolean = (n: FigmaNode): boolean => {
    for (let p = n.parent ? theirs.get(n.parent) : undefined; p; ) {
      if (p.type === "BOOLEAN_OPERATION") return true;
      p = p.parent ? theirs.get(p.parent) : undefined;
    }
    return false;
  };
  // Shown on Figma's side: itself and every ancestor visible.
  const shown = new Map<string, boolean>();
  for (const n of figma) {
    const parentShown = n.parent ? (shown.get(n.parent) ?? true) : true;
    shown.set(n.id, parentShown && n.visible);
  }

  const missing: { id: string; name: string; type: string }[] = [];
  const visibility: { id: string; name: string; figma: boolean; drawpane: boolean }[] = [];
  const moved: Delta[] = [];
  const resized: Delta[] = [];
  const text: Delta[] = [];
  let flattened = 0;

  for (const n of figma) {
    const d = match.get(n.id);
    if (!d) {
      if (insideBoolean(n)) flattened++;
      else missing.push({ id: n.id, name: n.name, type: n.type });
      continue;
    }
    if (d.visible !== n.visible)
      visibility.push({ id: n.id, name: n.name, figma: n.visible, drawpane: d.visible });
    if (!shown.get(n.id) || !n.box || !d.box) continue;
    // Relative to the parent, when both sides have it.
    const fp = n.parent ? theirs.get(n.parent) : undefined;
    const dp = fp ? match.get(fp.id) : undefined;
    const px = fp?.box && dp?.box ? dp.box.x - fp.box.x : 0;
    const py = fp?.box && dp?.box ? dp.box.y - fp.box.y : 0;
    const delta: Delta = {
      id: n.id,
      name: n.name,
      type: n.type,
      dx: r3(d.box.x - n.box.x - px),
      dy: r3(d.box.y - n.box.y - py),
      dw: r3(d.box.width - n.box.width),
      dh: r3(d.box.height - n.box.height),
    };
    const off = Math.abs(delta.dx) > tolerance || Math.abs(delta.dy) > tolerance;
    const size = Math.abs(delta.dw) > tolerance || Math.abs(delta.dh) > tolerance;
    if (n.type === "TEXT") {
      if (off || size) text.push(delta);
      continue;
    }
    if (off) moved.push(delta);
    if (size) resized.push(delta);
  }
  const extra = drawpane
    .filter((n) => !matchedIds.has(n.id))
    .map((n) => ({ id: n.id, type: n.type }));
  const size = (d: Delta) =>
    Math.max(Math.abs(d.dx), Math.abs(d.dy), Math.abs(d.dw), Math.abs(d.dh));
  const worst = (a: Delta, b: Delta) => size(b) - size(a);
  return {
    figmaNodes: figma.length,
    drawpaneNodes: drawpane.length,
    matched: matchedIds.size,
    byPlace,
    missing,
    flattened,
    extra,
    visibility,
    moved: moved.sort(worst),
    resized: resized.sort(worst),
    text: text.sort(worst),
  };
}
