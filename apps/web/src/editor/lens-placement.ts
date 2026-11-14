/**
 * Where the Selection Lens goes: under the selection by default, and
 * somewhere else (above, beside, or floating at the bottom of a selection
 * bigger than the screen) when that would cover less of the work around it.
 *
 * Pure geometry in screen pixels, so it's cheap to run on every camera move
 * and easy to test. What counts as "the work around it" is `lensObstacles`.
 */
import type { Doc, Scene } from "@drawpane/editor";
import { getProp } from "@drawpane/model";

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type LensSide = "below" | "above" | "right" | "left" | "inside";

export interface LensPlacement {
  readonly side: LensSide;
  /** The Lens's top-left corner. */
  readonly x: number;
  readonly y: number;
}

export interface LensPlacementInput {
  /** The selection. */
  readonly target: Box;
  /** The Lens itself. */
  readonly size: { readonly width: number; readonly height: number };
  /** Where the Lens may go: the canvas between the panes, the top bar and the zoom bar. */
  readonly area: Box;
  /** Layers the Lens shouldn't cover. */
  readonly obstacles: readonly Box[];
  /** A name label sits above the selection (top-level frames). */
  readonly labelAbove?: boolean;
  /** Where it was last time: staying put beats a small gain, so it doesn't hop as you pan. */
  readonly previous?: LensSide | null;
  /** Only these sides (while a popover hangs off the Lens), falling back to any. */
  readonly sides?: readonly LensSide[];
}

/** Below clears the size pill under the selection. */
const GAP_BELOW = 36;
const GAP = 12;
const GAP_ABOVE_LABEL = 28;
/** Earlier sides win unless a later one covers this much less (a share of the Lens's area). */
const PREFERENCE = 0.04;
const STICKINESS = 0.1;
/** Sitting right against a layer crowds it as much as covering its edge does. */
const CLEARANCE = 8;
const ORDER: readonly LensSide[] = ["below", "above", "right", "left", "inside"];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** How much of `b`, grown by the clearance, the box `a` covers. */
function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width + CLEARANCE) - Math.max(a.x, b.x - CLEARANCE);
  const h = Math.min(a.y + a.height, b.y + b.height + CLEARANCE) - Math.max(a.y, b.y - CLEARANCE);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Where the Lens would sit on `side`, or null when it doesn't fit there. */
function candidate(side: LensSide, input: LensPlacementInput): Box | null {
  const { target: t, size, area } = input;
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  // Centre on the part of the selection that's on screen.
  const left = Math.max(t.x, area.x);
  const visibleRight = Math.min(t.x + t.width, right);
  const middleX = visibleRight > left ? (left + visibleRight) / 2 : t.x + t.width / 2;
  const centered = clamp(middleX - size.width / 2, area.x, right - size.width);
  const middle = clamp(t.y + t.height / 2 - size.height / 2, area.y, bottom - size.height);
  let box: Box;
  switch (side) {
    case "below":
      box = { x: centered, y: t.y + t.height + GAP_BELOW, ...size };
      break;
    case "above":
      box = {
        x: centered,
        y: t.y - (input.labelAbove ? GAP_ABOVE_LABEL : GAP) - size.height,
        ...size,
      };
      break;
    case "right":
      box = { x: t.x + t.width + GAP, y: middle, ...size };
      break;
    case "left":
      box = { x: t.x - GAP - size.width, y: middle, ...size };
      break;
    case "inside": {
      // A selection taller than the screen: float at the bottom of what's visible of it.
      const visibleBottom = Math.min(t.y + t.height, bottom);
      const visibleTop = Math.max(t.y, area.y);
      if (visibleBottom - visibleTop < size.height + GAP * 2) return null;
      box = { x: centered, y: visibleBottom - GAP - size.height, ...size };
      break;
    }
  }
  const inside =
    box.x >= area.x - 0.5 &&
    box.y >= area.y - 0.5 &&
    box.x + box.width <= right + 0.5 &&
    box.y + box.height <= bottom + 0.5;
  // The Lens floats over the selection only when nothing outside it has room.
  return inside ? box : null;
}

/** The best place for the Lens, or null when it fits nowhere (it hides). */
export function placeLens(input: LensPlacementInput): LensPlacement | null {
  const area = input.size.width * input.size.height;
  let best: { side: LensSide; box: Box; score: number } | null = null;
  const allowed = input.sides ?? ORDER;
  ORDER.forEach((side, rank) => {
    if (!allowed.includes(side)) return;
    const box = candidate(side, input);
    if (!box) return;
    let score = rank * PREFERENCE * area;
    for (const o of input.obstacles) score += overlap(box, o);
    if (side === input.previous) score -= STICKINESS * area;
    // Floating inside covers the selection itself: only when nothing else fits.
    if (side === "inside") score += area * 10;
    if (!best || score < best.score) best = { side, box, score };
  });
  if (!best) {
    if (!input.sides) return null;
    const { sides: _, ...any } = input;
    return placeLens(any);
  }
  const { side, box } = best as { side: LensSide; box: Box };
  return { side, x: Math.round(box.x), y: Math.round(box.y) };
}

/**
 * The layers the Lens should keep clear of, in page coordinates: what sits
 * beside the selection at every level up to the page (siblings, then the
 * parent's siblings…). Its ancestors only frame it, so they don't count.
 */
export function lensObstacles(doc: Doc, scene: Scene, id: string): Box[] {
  const out: Box[] = [];
  const path = [id, ...doc.ancestors(id).map((a) => a.id)];
  for (let i = 0; i < path.length - 1; i++) {
    const self = path[i] as string;
    const parent = path[i + 1] as string;
    for (const sibling of doc.childIds(parent)) {
      if (sibling === self || !scene.isVisible(sibling)) continue;
      const node = doc.get(sibling);
      if (!node || node.type === "textStyle" || node.type === "collection") continue;
      const bounds = scene.bounds(sibling);
      if (bounds && bounds.width > 0 && bounds.height > 0) out.push(bounds);
    }
  }
  return out;
}

/** Whether the selection shows its name above it on the canvas (a top-level frame). */
export function hasLabelAbove(doc: Doc, id: string): boolean {
  const node = doc.get(id);
  const parent = node ? doc.get(node.parent) : undefined;
  return node?.type === "frame" && parent?.type === "page" && getProp(node.props, "visible");
}
