/**
 * The layers tree as rows: what kind each layer reads as, which layers a
 * search or filter finds, and the flattened list the panel draws (topmost
 * layer first, like every design tool). Pure, so it's tested without React.
 */
import { canMoveInto, type Doc, hasMask, layerName, maskScopes } from "@drawpane/editor";
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
/** What a layer is called on screen (a text layer, by what it says): see the engine's `layerName`. */
export { layerName };

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

export interface Aim {
  readonly doc: Doc;
  readonly rows: readonly Row[];
  /** The row under the pointer, and where on it: 0 at its top, 1 at its bottom. */
  readonly index: number;
  readonly y: number;
  /** The pointer's nesting level, across the panel. */
  readonly depth: number;
  /** The layers being dragged. */
  readonly moving: readonly string[];
  /** A layer's parent in the list, or null at the top level. */
  readonly parentOf: (id: string) => string | null;
}

/**
 * Where a drag aims, or null when dropping there would do nothing, so the
 * panel only ever shows a drop that will happen. Like `dropTarget`, except
 * over a row that's being dragged, where a layer can only move out (left,
 * from the bottom of the groups it ends), the way the last layer in a frame
 * leaves it.
 */
export function aimDrop({ doc, rows, index, y, depth, moving, parentOf }: Aim): DropTarget | null {
  const row = rows[index];
  if (!row) return null;
  const own = moving.includes(row.node.id);
  const target = dropTarget(rows, index, own ? 1 : y, depth, parentOf);
  if (!target) return null;
  if (own && !(target.where === "after" && target.depth < row.depth)) return null;
  return dropPlacement(doc, target, moving) ? target : null;
}

/** Where a drop puts the layers: under a parent, between two of its children (bottom to top). */
export interface DropPlacement {
  readonly parent: string;
  /** The sibling just under the drop in z-order, or null at the bottom. */
  readonly below: string | null;
  /** The sibling just over it, or null at the top. */
  readonly above: string | null;
}

/**
 * Turns a drop target into a place among siblings, leaving out the layers
 * being moved. Null when the drop would put a layer inside itself or into
 * an instance (or a component inside itself), or is relative to one of the
 * layers being moved.
 */
export function dropPlacement(
  doc: Doc,
  target: Pick<DropTarget, "id" | "where">,
  moving: readonly string[],
): DropPlacement | null {
  const node = doc.get(target.id);
  // Relative to a layer that's moving too: nowhere to put it.
  if (!node || moving.includes(node.id)) return null;
  const into = target.where === "inside" ? node.id : node.parent;
  if (moving.some((id) => id === into || doc.ancestors(into).some((a) => a.id === id))) return null;
  // Not into an instance's layers, and never a component into itself.
  if (!canMoveInto(doc, moving, into)) return null;
  const siblings = doc.childIds(into).filter((id) => !moving.includes(id));
  if (target.where === "inside")
    return { parent: into, below: siblings.at(-1) ?? null, above: null };
  const index = siblings.indexOf(node.id);
  // The panel lists topmost first, so "before" in the list means above in z-order.
  return target.where === "before"
    ? { parent: into, below: node.id, above: siblings[index + 1] ?? null }
    : { parent: into, below: siblings[index - 1] ?? null, above: node.id };
}

/* Geometry: how wide the tree draws, and where it scrolls to show a row. */

/** Each nesting level indents a row this much (the LayerRow's 12px), from its 4px start. */
export const INDENT = 12;
export const INDENT_START = 4;
/** A row's caret, icon and the gaps around them, before its name starts. */
const LEAD = 12 + 4 + 16 + 4;
/**
 * The room a name keeps however deep its row (about a dozen characters): past
 * that, the tree scrolls sideways rather than squeezing names to "K…".
 */
const NAME_MIN = 96;
/** The lock and the eye at a row's end, the gap before them and the row's end padding. */
const TRAIL = 4 + 16 + 4 + 16 + 6;

/** How wide a row at `depth` must be to keep its name readable. */
export function rowWidthFor(depth: number): number {
  return INDENT_START + depth * INDENT + LEAD + NAME_MIN + TRAIL;
}

/**
 * Where to scroll a tree `viewport` wide (now at `scrollLeft`) so a row at
 * `depth` shows its caret and the start of its name, clear of the toggles over
 * the right edge; null if it already does. It keeps a level of the parent in
 * view, so the row still reads as nested.
 */
export function revealLeft(depth: number, scrollLeft: number, viewport: number): number | null {
  const start = INDENT_START + depth * INDENT;
  const nameEnd = start + LEAD + NAME_MIN;
  if (start >= scrollLeft && nameEnd <= scrollLeft + viewport - TRAIL) return null;
  return Math.max(0, start - INDENT);
}

/* Pinned ancestors: the rows that stay at the top of the tree while you scroll inside them. */

/** Each row's parent row and where its children end, for finding a row's ancestors without a walk. */
export interface RowIndex {
  /** The row index of each row's parent, or -1 at the top level. */
  readonly parent: Int32Array;
  /** One past the last row inside each row (its own index + 1 when nothing of it is open). */
  readonly end: Int32Array;
}

/** Indexes the rows by nesting, in one pass. */
export function indexRows(rows: readonly Row[]): RowIndex {
  const parent = new Int32Array(rows.length);
  const end = new Int32Array(rows.length);
  /** The open ancestors of the row being looked at, outermost first. */
  const stack: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const depth = (rows[i] as Row).depth;
    while (stack.length > 0 && (rows[stack.at(-1) as number] as Row).depth >= depth)
      end[stack.pop() as number] = i;
    parent[i] = stack.at(-1) ?? -1;
    stack.push(i);
  }
  for (const i of stack) end[i] = rows.length;
  return { parent, end };
}

export interface Pinned {
  /** The rows pinned at the top, outermost first. */
  readonly rows: readonly number[];
  /**
   * How far the innermost pinned row is pushed up (0 or less), as the end of
   * what it holds scrolls past it, so the next row takes its place smoothly.
   */
  readonly offset: number;
}

const NONE: Pinned = { rows: [], offset: 0 };

/**
 * The rows pinned at the top of a tree scrolled to `scrollTop`, as in Figma:
 * every ancestor of the topmost row in view whose own row has scrolled out,
 * stacked by depth, each one taking a row's height from the view below it.
 * At most `max`, outermost first.
 */
export function pinnedRows(
  index: RowIndex,
  scrollTop: number,
  rowHeight: number,
  max: number,
): Pinned {
  const count = index.parent.length;
  if (count === 0 || scrollTop <= 0 || max <= 0) return NONE;
  const pinned: number[] = [];
  while (pinned.length < max) {
    // The row just under what's pinned so far, and its ancestor one level below the last pinned.
    const at = Math.floor((scrollTop + pinned.length * rowHeight) / rowHeight);
    if (at >= count) break;
    const outer = pinned.at(-1) ?? -1;
    let ancestor = at;
    let next = index.parent[at] as number;
    while (next !== outer && next !== -1) {
      ancestor = next;
      next = index.parent[next] as number;
    }
    // Pinned only once its own row has gone under the rows pinned above it.
    if (next !== outer || ancestor === at) break;
    pinned.push(ancestor);
  }
  if (pinned.length === 0) return NONE;
  // The last pinned row slides up as the last row inside it scrolls under the stack.
  const last = pinned.at(-1) as number;
  const bottom = (index.end[last] as number) * rowHeight - scrollTop;
  const offset = Math.min(0, bottom - pinned.length * rowHeight);
  return { rows: pinned, offset };
}
