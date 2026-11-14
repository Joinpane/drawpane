/**
 * The layers tree as rows: what kind each layer reads as, which layers a
 * search or filter finds, and the flattened list the panel draws (topmost
 * layer first, like every design tool). Pure, so it's tested without React.
 */
import { type Doc, hasMask, maskScopes } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import type { LayerKind } from "@drawpane/ui";

const KIND: Record<string, LayerKind> = {
  frame: "frame",
  group: "group",
  rect: "rect",
  ellipse: "ellipse",
  polygon: "polygon",
  star: "star",
  line: "line",
  path: "path",
  text: "text",
};

const isComponentish = (node: NodeRecord) =>
  node.type === "frame" &&
  (getProp(node.props, "isComponent") ||
    getProp(node.props, "isComponentSet") ||
    getProp(node.props, "instanceOf") !== null);

const isImage = (node: NodeRecord) =>
  node.type === "rect" && getProp(node.props, "fills").some((f) => f.type === "image");

/** What a layer reads as in the tree: its glyph. */
export function kindOf(node: NodeRecord): LayerKind {
  if (node.type === "frame") {
    if (getProp(node.props, "isComponent") || getProp(node.props, "isComponentSet"))
      return "component";
    if (getProp(node.props, "instanceOf") !== null) return "instance";
    // Auto layout shows its direction, or the grid.
    const mode = getProp(node.props, "layoutMode");
    if (mode === "row") return "frame-row";
    if (mode === "column") return "frame-column";
    if (mode === "grid") return "frame-grid";
  }
  // A line with an end marker reads as an arrow.
  if (
    node.type === "line" &&
    (getProp(node.props, "markerEnd") !== "none" || getProp(node.props, "markerStart") !== "none")
  )
    return "arrow";
  // A rectangle filled with an image reads as an image layer.
  if (isImage(node)) return "image";
  return KIND[node.type] ?? "rect";
}

export type LayerFilter = "all" | "frames" | "text" | "components" | "images" | "hidden" | "locked";

export const LAYER_FILTERS: ReadonlyArray<{ value: LayerFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "frames", label: "Frames" },
  { value: "text", label: "Text" },
  { value: "components", label: "Components" },
  { value: "images", label: "Images" },
  { value: "hidden", label: "Hidden" },
  { value: "locked", label: "Locked" },
];

function passes(node: NodeRecord, filter: LayerFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "frames":
      return node.type === "frame" && !isComponentish(node);
    case "text":
      return node.type === "text";
    case "components":
      return isComponentish(node);
    case "images":
      return isImage(node);
    case "hidden":
      return !getProp(node.props, "visible");
    case "locked":
      return getProp(node.props, "locked");
  }
}

/** The name a layer shows (and is searched by). */
export const layerName = (node: NodeRecord) => getProp(node.props, "name") || node.type;

export interface Row {
  readonly node: NodeRecord;
  readonly depth: number;
  readonly hasChildren: boolean;
  /** "mask" for masks, "clipped" for the layers a mask clips. */
  readonly note?: string;
  /** Only here to show where a search result sits (an ancestor that doesn't match). */
  readonly context?: boolean;
  /** Inside a hidden layer, so hidden too even though its own eye is open. */
  readonly hiddenByParent?: boolean;
}

export interface LayerQuery {
  /** Containers folded shut (ignored while searching: results always show). */
  readonly collapsed: ReadonlySet<string>;
  /** Matches names, case-insensitively, anywhere in them. */
  readonly query?: string;
  readonly filter?: LayerFilter;
}

/**
 * The rows to draw for a page, and (while searching or filtering) the
 * layers found, in the order they're listed.
 */
export function layerRows(
  doc: Doc,
  pageId: string,
  { collapsed, query = "", filter = "all" }: LayerQuery,
): { rows: Row[]; found: string[] } {
  const needle = query.trim().toLowerCase();
  const searching = needle !== "" || filter !== "all";
  const matches = (node: NodeRecord) =>
    passes(node, filter) && (!needle || layerName(node).toLowerCase().includes(needle));

  const rows: Row[] = [];
  const found: string[] = [];
  /** Appends a subtree's rows; returns whether it held a match (always true when not searching). */
  const walk = (parent: string, depth: number, hiddenAbove: boolean): boolean => {
    const ids = doc.childIds(parent);
    const scopes = hasMask(doc, parent)
      ? new Map(maskScopes(doc, parent).map((s) => [s.id, s]))
      : null;
    let any = false;
    for (let i = ids.length - 1; i >= 0; i--) {
      const node = doc.get(ids[i] as string);
      if (!node) continue;
      const children = doc.childIds(node.id);
      const scope = scopes?.get(node.id);
      const note = scope?.isMask ? "mask" : scope?.mask ? "clipped" : undefined;
      const hidden = hiddenAbove || !getProp(node.props, "visible");
      const row: Row = {
        node,
        depth,
        hasChildren: children.length > 0,
        ...(note ? { note } : {}),
        ...(hiddenAbove ? { hiddenByParent: true } : {}),
      };
      if (!searching) {
        rows.push(row);
        if (children.length > 0 && !collapsed.has(node.id)) walk(node.id, depth + 1, hidden);
        any = true;
        continue;
      }
      // Searching: a layer shows when it matches or holds a match, which it then sits above.
      const at = rows.length;
      const self = matches(node);
      if (self) found.push(node.id);
      const inner = children.length > 0 && walk(node.id, depth + 1, hidden);
      if (self || inner) {
        rows.splice(at, 0, self ? row : { ...row, context: true });
        any = true;
      } else {
        rows.length = at;
      }
    }
    return any;
  };
  walk(pageId, 0, false);
  // `found` was collected depth-first before parents were inserted: put it in list order.
  if (searching) {
    const order = new Map(rows.map((r, i) => [r.node.id, i]));
    found.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  return { rows, found };
}

/** A container and every container inside it: what an Alt-click on its caret folds or opens. */
export function containersWithin(doc: Doc, id: string): string[] {
  const out: string[] = [];
  const visit = (at: string) => {
    if (doc.childIds(at).length === 0) return;
    out.push(at);
    for (const child of doc.childIds(at)) visit(child);
  };
  visit(id);
  return out;
}

/** Where a drop lands, and how the panel shows it. */
export interface DropTarget {
  /** The layer the drop is relative to. */
  readonly id: string;
  /** Above or below it in the list, or inside it (at the top of its list). */
  readonly where: "before" | "after" | "inside";
  /** The row to draw the indicator on, and how: a line above or below it, or a box around it. */
  readonly row: string;
  readonly show: "line-before" | "line-after" | "box";
  /** How far the line is indented, in nesting levels. */
  readonly depth: number;
}

/**
 * Where a drag over row `index` drops, the way Figma decides it: the middle
 * of a frame or group drops inside it; the top half goes above the row; the
 * bottom half goes below it. Below the last row of nested groups, `depth`
 * (where the pointer is across the panel, in nesting levels) picks how far
 * out: below the row itself, or below any group that ends there. Just below
 * an open group's row is inside it, at the top, where the line shows.
 */
export function dropTarget(
  rows: readonly Row[],
  index: number,
  y: number,
  depth: number,
  parentOf: (id: string) => string | null,
): DropTarget | null {
  const row = rows[index];
  if (!row) return null;
  const { node } = row;
  const container = node.type === "frame" || node.type === "group";
  if (container && y > 0.3 && y < 0.7)
    return { id: node.id, where: "inside", row: node.id, show: "box", depth: row.depth + 1 };
  if (y < 0.5)
    return { id: node.id, where: "before", row: node.id, show: "line-before", depth: row.depth };
  const next = rows[index + 1];
  // An open group's children follow it: below its row is the top of its list.
  if (container && next && next.depth > row.depth)
    return { id: node.id, where: "inside", row: node.id, show: "line-after", depth: row.depth + 1 };
  // Below the last row of one or more groups: the pointer picks how far out.
  const lowest = next?.depth ?? 0;
  const chosen = Math.max(lowest, Math.min(row.depth, Math.round(depth)));
  let id = node.id;
  for (let level = row.depth; level > chosen; level--) {
    const parent = parentOf(id);
    if (!parent) break;
    id = parent;
  }
  return { id, where: "after", row: node.id, show: "line-after", depth: chosen };
}
