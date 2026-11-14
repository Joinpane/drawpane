/**
 * Reading order (PRD: "focus order can be annotated and exported"): the
 * order a screen reader, and keyboard focus, moves through a board. What
 * counts is what someone reads or presses: text, and layers the prototype
 * taps (a button is one stop, whatever is inside it). Until someone orders
 * them, the layout does: rows top to bottom, left to right within a row.
 * A board's `readingOrder` keeps the order someone chose; layers added since
 * join at the end, and ones removed drop out.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import type { Editor } from "./editor";
import type { Rect } from "./geometry";

export type ReadingRole = "heading" | "text" | "button" | "image";

export interface ReadingItem {
  readonly id: string;
  readonly name: string;
  readonly role: ReadingRole;
}

export interface ReadingOrder {
  readonly items: readonly ReadingItem[];
  /** Whether someone set it, rather than it following the layout. */
  readonly custom: boolean;
}

/** Text this size or bigger reads as a heading. */
const HEADING_SIZE = 20;

function tapped(node: NodeRecord): boolean {
  return getProp(node.props, "reactions").some((r) => r.trigger.type === "tap");
}

function hasImage(node: NodeRecord): boolean {
  return getProp(node.props, "fills").some((f) => f.type === "image");
}

/** What a stop is to a screen reader. */
export function readingRole(node: NodeRecord): ReadingRole {
  if (tapped(node)) return "button";
  if (node.type === "text") {
    return getProp(node.props, "fontSize") >= HEADING_SIZE ? "heading" : "text";
  }
  return "image";
}

/** A stop's name: a text's words, else the layer's name. */
function readingName(node: NodeRecord): string {
  const text = node.type === "text" ? getProp(node.props, "characters").trim() : "";
  return (text || getProp(node.props, "name") || node.type).replace(/\s+/g, " ").slice(0, 120);
}

/** The board's stops, in the order the layout suggests. */
export function layoutReadingOrder(editor: Editor, boardId: string): string[] {
  const stops: { id: string; box: Rect }[] = [];
  const visit = (parent: string) => {
    for (const id of editor.doc.childIds(parent)) {
      const node = editor.doc.get(id);
      if (!node || !editor.scene.isVisible(id)) continue;
      const box = editor.scene.bounds(id);
      // A tapped layer is one stop with all it holds; text and images are stops of their own.
      const stop =
        tapped(node) || node.type === "text" || (node.type !== "frame" && hasImage(node));
      if (stop && box) stops.push({ id, box });
      else if (!stop) visit(id);
    }
  };
  visit(boardId);
  return sortByRows(stops).map((s) => s.id);
}

/**
 * Rows, top to bottom, then left to right: two stops share a row when they
 * overlap vertically by more than half the shorter one's height.
 */
function sortByRows<T extends { box: Rect }>(stops: readonly T[]): T[] {
  const byTop = [...stops].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows: T[][] = [];
  for (const stop of byTop) {
    const row = rows.at(-1);
    const first = row?.[0];
    if (row && first) {
      const top = Math.max(first.box.y, stop.box.y);
      const bottom = Math.min(first.box.y + first.box.height, stop.box.y + stop.box.height);
      if (bottom - top > Math.min(first.box.height, stop.box.height) / 2) {
        row.push(stop);
        continue;
      }
    }
    rows.push([stop]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.box.x - b.box.x));
}

/** A board's reading order: the one someone set (kept up to date), or the layout's. */
export function readingOrderOf(editor: Editor, boardId: string): ReadingOrder {
  const board = editor.doc.get(boardId);
  const layout = layoutReadingOrder(editor, boardId);
  const stored = board?.type === "frame" ? getProp(board.props, "readingOrder") : null;
  const order = stored
    ? [
        ...stored.filter((id) => layout.includes(id)),
        // Added since it was set: after the rest, in layout order.
        ...layout.filter((id) => !stored.includes(id)),
      ]
    : layout;
  const items = order.flatMap((id) => {
    const node = editor.doc.get(id);
    return node ? [{ id, name: readingName(node), role: readingRole(node) }] : [];
  });
  return { items, custom: stored !== null };
}

/** The order as a numbered list for a handoff: "1. Good morning, Ana (heading)". */
export function readingOrderText(order: ReadingOrder, boardName: string): string {
  const lines = order.items.map((item, i) => `${i + 1}. ${item.name} (${item.role})`);
  return [`Reading order: ${boardName}`, "", ...lines].join("\n");
}
