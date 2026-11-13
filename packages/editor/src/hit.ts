import { getProp, type NodeRecord } from "@drawpane/model";
import { type Point, type Rect, rectContains, rectContainsPoint, rectsIntersect } from "./geometry";
import type { Scene } from "./scene";

let hitCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
function pathContext() {
  if (!hitCtx) {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1)
        : document.createElement("canvas");
    hitCtx = canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
  }
  return hitCtx;
}

/** True when page point `p` lands on the node's own shape (not its children). */
export function hitsNode(scene: Scene, node: NodeRecord, p: Point, tolerance: number): boolean {
  if (node.type === "group" || node.type === "page") return false;
  const local = scene.toLocal(node.id, p);
  const w = getProp(node.props, "width");
  const h = getProp(node.props, "height");
  switch (node.type) {
    case "ellipse": {
      const rx = w / 2 + tolerance;
      const ry = h / 2 + tolerance;
      const dx = local.x - w / 2;
      const dy = local.y - h / 2;
      return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
    }
    case "line":
      return (
        local.x >= -tolerance &&
        local.x <= w + tolerance &&
        Math.abs(local.y - h / 2) <= Math.max(tolerance, getProp(node.props, "strokeWeight") / 2)
      );
    case "path": {
      const ctx = pathContext();
      if (!ctx) return rectContainsPoint({ x: 0, y: 0, width: w, height: h }, local);
      let path: Path2D;
      try {
        path = new Path2D(getProp(node.props, "pathData"));
      } catch {
        return false;
      }
      ctx.lineWidth = Math.max(getProp(node.props, "strokeWeight"), tolerance * 2);
      return (
        ctx.isPointInPath(path, local.x, local.y, getProp(node.props, "windingRule")) ||
        ctx.isPointInStroke(path, local.x, local.y)
      );
    }
    default:
      return (
        local.x >= -tolerance &&
        local.y >= -tolerance &&
        local.x <= w + tolerance &&
        local.y <= h + tolerance
      );
  }
}

/**
 * The deepest visible, unlocked node under `p`, topmost first. A frame that
 * clips its content only passes hits to children inside its box.
 */
export function hitTest(scene: Scene, pageId: string, p: Point, tolerance: number): string | null {
  const doc = scene.doc;
  const visit = (id: string): string | null => {
    const node = doc.get(id);
    if (!node || node.props.visible === false || node.props.locked === true) return null;
    if (node.type === "frame" && getProp(node.props, "clipContent") && !hitsNode(scene, node, p, 0))
      return null;
    const children = doc.childIds(id);
    for (let i = children.length - 1; i >= 0; i--) {
      const hit = visit(children[i] as string);
      if (hit) return hit;
    }
    if (node.type === "frame") {
      // An empty top-level frame or a nested frame is hit by its body.
      return hitsNode(scene, node, p, 0) ? id : null;
    }
    return hitsNode(scene, node, p, tolerance) ? id : null;
  };
  const top = doc.childIds(pageId);
  for (let i = top.length - 1; i >= 0; i--) {
    const hit = visit(top[i] as string);
    if (hit) return hit;
  }
  return null;
}

/**
 * Turns the deepest hit into what a click should select, like Figma: top-level
 * frames are artboards, so a click inside one selects its direct child; groups
 * select as a whole until you enter them (double-click) or hold ⌘.
 */
export function selectionTarget(
  scene: Scene,
  pageId: string,
  leaf: string,
  selection: readonly string[],
  deep: boolean,
): string {
  if (deep) return leaf;
  const doc = scene.doc;
  const chain: string[] = [leaf];
  for (let id = leaf; ; ) {
    const node = doc.get(id);
    if (!node || node.parent === pageId) break;
    chain.unshift(node.parent);
    id = node.parent;
  }
  // If the selection is inside this chain, stay at its level (you have "entered" that container).
  for (const selected of selection) {
    const parent = doc.get(selected)?.parent;
    const index = chain.findIndex((id) => doc.get(id)?.parent === parent);
    if (parent !== undefined && parent !== pageId && index !== -1) return chain[index] as string;
    const self = chain.indexOf(selected);
    if (self !== -1 && self < chain.length - 1) return chain[self + 1] as string;
  }
  const top = doc.get(chain[0] as string);
  if (top?.type === "frame" && chain.length > 1) return chain[1] as string;
  return chain[0] as string;
}

/**
 * Nodes a marquee selects: on the page, the top-level layers it touches; inside
 * an artboard (when the marquee starts within one), that frame's children.
 */
export function marqueeHits(scene: Scene, container: string, rect: Rect): string[] {
  const out: string[] = [];
  for (const id of scene.doc.childIds(container)) {
    const node = scene.doc.get(id);
    if (!node || node.props.visible === false || node.props.locked === true) continue;
    const b = scene.bounds(id);
    if (!b) continue;
    if (node.type === "frame" && scene.doc.childIds(id).length > 0 && !rectContains(rect, b)) {
      // Touching an artboard selects what's inside it, not the artboard.
      if (rectsIntersect(rect, b)) out.push(...marqueeHits(scene, id, rect));
      continue;
    }
    if (rectsIntersect(rect, b)) out.push(id);
  }
  return out;
}
