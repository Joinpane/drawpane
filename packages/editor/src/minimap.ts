/**
 * The minimap: the page's top-level layers in miniature, the part of the
 * canvas you can see, and where everyone else on the page is pointing. This
 * is the model, in page coordinates; the app draws it and maps clicks back
 * with `minimapFit`. See PRD "Calm multiplayer": presence shows up in the
 * minimap, so you can see where people are without them crowding your view.
 */
import { getProp } from "@drawpane/model";
import type { Editor } from "./editor";
import { type Point, type Rect, unionRects } from "./geometry";

export interface MinimapLayer {
  readonly id: string;
  readonly rect: Rect;
  /** A frame at the top level: a board. */
  readonly board: boolean;
  readonly hidden: boolean;
}

export interface MinimapPeer {
  readonly sessionId: string;
  readonly name: string;
  /** Their pointer on this page; or, when it's off the canvas (over a panel), the middle of their view. */
  readonly at: Point;
  /** Whether `at` is their pointer (a dot) rather than where they're looking (a ring). */
  readonly pointing: boolean;
  /** 1–8: their `presence-n` color. */
  readonly color: number;
  readonly agent: boolean;
}

export interface MinimapModel {
  /** Everything shown: the layers and the visible area together. */
  readonly bounds: Rect;
  readonly layers: readonly MinimapLayer[];
  /** The part of the canvas the panes don't cover. */
  readonly view: Rect;
  readonly peers: readonly MinimapPeer[];
  /** How many boards (top-level frames) the page has. */
  readonly boards: number;
}

/** The minimap for the editor's current page, or null when there's no page or no viewport yet. */
export function minimapModel(editor: Editor): MinimapModel | null {
  const { pageId, peers } = editor.s;
  const view = editor.visibleArea();
  if (!pageId || !view) return null;
  const layers: MinimapLayer[] = [];
  let boards = 0;
  for (const id of editor.doc.childIds(pageId)) {
    const node = editor.doc.get(id);
    const rect = editor.scene.bounds(id);
    if (!node || !rect) continue;
    const board = node.type === "frame";
    if (board) boards++;
    layers.push({ id, rect, board, hidden: !getProp(node.props, "visible") });
  }
  const others: MinimapPeer[] = [];
  for (const peer of peers.values()) {
    const presence = peer.presence;
    if (!presence || presence.pageId !== pageId) continue;
    const looking = presence.viewport;
    const at =
      presence.cursor ??
      (looking ? { x: looking.x + looking.width / 2, y: looking.y + looking.height / 2 } : null);
    if (!at) continue;
    others.push({
      sessionId: peer.sessionId,
      name: peer.name,
      at,
      pointing: presence.cursor !== null,
      color: peer.color,
      agent: peer.kind === "agent",
    });
  }
  // Everyone stays on the map, however far from the content they are.
  const bounds =
    unionRects([
      view,
      ...layers.map((l) => l.rect),
      ...others.map((p) => ({ x: p.at.x, y: p.at.y, width: 0, height: 0 })),
    ]) ?? view;
  return { bounds, layers, view, peers: others, boards };
}

/** How the model's page coordinates map into a `width` × `height` box, `padding` in from its edges. */
export interface MinimapFit {
  readonly scale: number;
  /** Box coordinates of page point (0, 0). */
  readonly x: number;
  readonly y: number;
}

export function minimapFit(bounds: Rect, width: number, height: number, padding = 6): MinimapFit {
  const w = Math.max(1, width - padding * 2);
  const h = Math.max(1, height - padding * 2);
  const scale = Math.min(w / Math.max(bounds.width, 1e-6), h / Math.max(bounds.height, 1e-6));
  // Centred in the box.
  return {
    scale,
    x: width / 2 - (bounds.x + bounds.width / 2) * scale,
    y: height / 2 - (bounds.y + bounds.height / 2) * scale,
  };
}

export function toMinimap(fit: MinimapFit, p: Point): Point {
  return { x: p.x * fit.scale + fit.x, y: p.y * fit.scale + fit.y };
}

export function fromMinimap(fit: MinimapFit, p: Point): Point {
  return { x: (p.x - fit.x) / fit.scale, y: (p.y - fit.y) / fit.scale };
}
