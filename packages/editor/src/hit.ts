import { getProp, type NodeRecord } from "@drawpane/model";
import { type Point, type Rect, rectContains, rectsIntersect } from "./geometry";
import { hasMask, maskScopes } from "./masks";
import type { Scene } from "./scene";
import { flattenPath, hitPathData, hitRings } from "./vector/hit";
import { nodePath } from "./vector/shapes";

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
    case "polygon":
    case "star": {
      // Hit inside the outline (not its bounding box: a star's notches miss).
      const outline = nodePath(node);
      if (!outline) return false;
      const strokes = getProp(node.props, "strokes").some((s) => s.visible !== false);
      return hitRings(flattenPath(outline), local, {
        fill: true,
        fillRule: "nonzero",
        strokeReach: Math.max(strokes ? getProp(node.props, "strokeWeight") / 2 : 0, tolerance),
      });
    }
    case "line":
      return (
        local.x >= -tolerance &&
        local.x <= w + tolerance &&
        Math.abs(local.y - h / 2) <= Math.max(tolerance, getProp(node.props, "strokeWeight") / 2)
      );
    case "path": {
      // Geometric, so it works without a canvas. Open subpaths hit on their
      // stroke only; closed ones on their fill too when it is painted (or when
      // nothing is, so an unstyled path stays selectable).
      const fills = getProp(node.props, "fills").some((f) => f.visible !== false);
      const strokes = getProp(node.props, "strokes").some((s) => s.visible !== false);
      return hitPathData(getProp(node.props, "pathData"), local, {
        fill: fills || !strokes,
        fillRule: getProp(node.props, "windingRule"),
        strokeReach: Math.max(strokes ? getProp(node.props, "strokeWeight") / 2 : 0, tolerance),
      });
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
 * A parent's children topmost first, leaving out those a mask clips away at
 * `p` (layers above a mask only show inside it).
 */
function reachable(scene: Scene, parentId: string, p: Point): string[] {
  const doc = scene.doc;
  if (!hasMask(doc, parentId)) return [...doc.childIds(parentId)].reverse();
  const out: string[] = [];
  const inside = new Map<string, boolean>();
  for (const { id, mask } of maskScopes(doc, parentId).reverse()) {
    if (mask) {
      let hit = inside.get(mask.id);
      if (hit === undefined) {
        hit = hitsNode(scene, mask, p, 0);
        inside.set(mask.id, hit);
      }
      if (!hit) continue;
    }
    out.push(id);
  }
  return out;
}

/**
 * The deepest visible, unlocked node under `p`, topmost first. A frame that
 * clips its content only passes hits to children inside its box, and a mask
 * only to the layers it shows. `locked: true` counts locked layers too: they
 * can't be picked, but they can be measured to.
 */
export function hitTest(
  scene: Scene,
  pageId: string,
  p: Point,
  tolerance: number,
  { locked = false }: { readonly locked?: boolean } = {},
): string | null {
  const doc = scene.doc;
  const visit = (id: string): string | null => {
    const node = doc.get(id);
    if (!node || node.props.visible === false || (!locked && node.props.locked === true))
      return null;
    if (node.type === "frame" && getProp(node.props, "clipContent") && !hitsNode(scene, node, p, 0))
      return null;
    for (const child of reachable(scene, id, p)) {
      const hit = visit(child);
      if (hit) return hit;
    }
    if (node.type === "frame") {
      // An empty top-level frame or a nested frame is hit by its body.
      return hitsNode(scene, node, p, 0) ? id : null;
    }
    return hitsNode(scene, node, p, tolerance) ? id : null;
  };
  for (const id of reachable(scene, pageId, p)) {
    const hit = visit(id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Every visible, unlocked layer under `p` with its ancestors, topmost and
 * deepest first: what Figma's "Select layer" submenu lists. Groups count when
 * a member is hit; frames when their body or a child is.
 */
export function hitAll(scene: Scene, pageId: string, p: Point, tolerance: number): string[] {
  const doc = scene.doc;
  const out: string[] = [];
  const visit = (id: string): boolean => {
    const node = doc.get(id);
    if (!node || node.props.visible === false || node.props.locked === true) return false;
    if (node.type === "frame" && getProp(node.props, "clipContent") && !hitsNode(scene, node, p, 0))
      return false;
    let any = false;
    for (const child of reachable(scene, id, p)) if (visit(child)) any = true;
    const self =
      node.type === "group"
        ? any
        : any || hitsNode(scene, node, p, node.type === "frame" ? 0 : tolerance);
    if (self) out.push(id);
    return self;
  };
  for (const id of reachable(scene, pageId, p)) visit(id);
  return out;
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
 * What Alt-hover measures to, from the selection, like Figma: the layer under
 * the pointer at the selection's own level of the tree. Resting on an
 * ancestor's bare area measures to that ancestor (the parent, its parent…);
 * resting on anything else measures to the branch it belongs to, as seen from
 * the nearest ancestor it shares with the selection: a sibling, an
 * ancestor's sibling, another top-level frame, or (inside the selection) the
 * selected layer's child. ⌘ (`deep`) measures to the layer itself.
 *
 * Null when there's nothing to measure to: the pointer is over the selection.
 */
export function measureTarget(
  scene: Scene,
  pageId: string,
  leaf: string,
  selection: readonly string[],
  deep: boolean,
): string | null {
  const doc = scene.doc;
  if (selection.length === 0) return null;
  // The pointer's branch, top-level layer first.
  const chain: string[] = [];
  for (let id: string | undefined = leaf; id && id !== pageId; id = doc.get(id)?.parent) {
    if (!doc.get(id)) return null;
    chain.unshift(id);
  }
  // The selection, and every layer above it.
  const context = new Set<string>();
  for (const id of selection)
    for (let at: string | undefined = id; at && at !== pageId; at = doc.get(at)?.parent)
      context.add(at);
  let shared = -1;
  for (let i = chain.length - 1; i >= 0; i--)
    if (context.has(chain[i] as string)) {
      shared = i;
      break;
    }
  const target = deep
    ? leaf
    : // Below the shared layer, the branch that holds the pointer; or the shared layer's own area.
      ((chain[shared + 1] ?? chain[shared]) as string);
  return selection.includes(target) ? null : target;
}

/**
 * Entering a container: the layer one level below `container` on the way
 * down to `leaf` (null when the leaf isn't inside it). Double-click uses this
 * to step into a group or nested frame, one level per double-click.
 */
export function childToward(scene: Scene, container: string, leaf: string): string | null {
  for (let id = leaf; ; ) {
    const node = scene.doc.get(id);
    if (!node) return null;
    if (node.parent === container) return id;
    id = node.parent;
  }
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
