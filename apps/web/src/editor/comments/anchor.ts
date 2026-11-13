/**
 * Anchoring math for comment pins.
 *
 * A pin dropped on a layer stores the layer's id and the point in its local
 * box, so it follows the layer through moves, rotations and reparenting. It
 * also stores the page point, which is where the pin falls back to when the
 * layer is deleted (or the thread wasn't pinned to one).
 */
import { apply, hitTest, type Point, round2, type Scene } from "@drawpane/editor";
import type { CommentAnchor } from "@drawpane/model";

/** How far, in page units, a click can miss a thin layer (a line) and still pin to it. */
const PIN_TOLERANCE = 2;

/** The layer a pin dropped at `p` attaches to: the deepest visible, unlocked layer under it. */
export function pinTarget(scene: Scene, pageId: string, p: Point): string | null {
  return hitTest(scene, pageId, p, PIN_TOLERANCE);
}

/** The anchor for a new thread at page point `p`. */
export function anchorAt(scene: Scene, pageId: string, p: Point): CommentAnchor {
  const nodeId = pinTarget(scene, pageId, p);
  const page = { x: round2(p.x), y: round2(p.y) };
  if (!nodeId) return { ...page, nodeId: null, offset: null };
  const local = scene.toLocal(nodeId, p);
  return { ...page, nodeId, offset: { x: round2(local.x), y: round2(local.y) } };
}

export interface PinPosition {
  readonly pageId: string;
  /** Page coordinates. */
  readonly point: Point;
  /** False when the thread was pinned to a layer that no longer exists. */
  readonly attached: boolean;
}

/**
 * Where a thread's pin is now. A pinned thread follows its layer, onto
 * whichever page the layer lives on; otherwise it sits at its page point.
 */
export function resolveAnchor(scene: Scene, anchor: CommentAnchor, pageId: string): PinPosition {
  const { nodeId, offset } = anchor;
  if (nodeId && offset) {
    const page = scene.doc.pageOf(nodeId);
    if (page && page.id !== nodeId) {
      return { pageId: page.id, point: apply(scene.worldMatrix(nodeId), offset), attached: true };
    }
    return { pageId, point: { x: anchor.x, y: anchor.y }, attached: false };
  }
  return { pageId, point: { x: anchor.x, y: anchor.y }, attached: true };
}

/** "Hero card · Home — iOS": the pinned layer and its board, or the page for unpinned threads. */
export function anchorLabel(scene: Scene, anchor: CommentAnchor, pageId: string): string {
  const doc = scene.doc;
  const node = anchor.nodeId ? doc.get(anchor.nodeId) : undefined;
  const page = node ? doc.pageOf(node.id) : doc.get(pageId);
  const pageName = page?.props.name ?? "Deleted page";
  if (!node || node.type === "page") return pageName;
  const board = doc.ancestors(node.id).findLast((a) => a.type !== "page");
  const name = node.props.name ?? "Layer";
  return `${name} · ${board?.props.name ?? pageName}`;
}
