/**
 * Auto layout, mapped 1:1 to CSS.
 *
 * Row and column frames are flexbox (`display: flex`, `flex-direction`,
 * `flex-wrap`, `gap`, `padding`, `justify-content`, `align-items`, and per
 * child `flex: 1` for Fill, `fit-content` for Hug, `align-self`,
 * `position: absolute`). Wrapped lines distribute with `alignContent:
 * "space-between"`, pack according to `alignItems` with `"auto"`, or pack at
 * the start with `"start"` (the default).
 *
 * Grid frames are CSS grid (`grid-template-columns/rows` with px, fr and auto
 * tracks, `column-gap`/`row-gap`, `justify-items`/`align-items`, and per child
 * `grid-area`, `justify-self`, `align-self`). Items without an area flow into
 * the next free cell, row by row, adding rows as needed.
 *
 * The editor that makes an edit runs layout and writes the results into the
 * same transaction. Every peer then sees identical positions without running
 * layout itself, and files stay plain data.
 */
import { type GridTrack, getProp, type NodeRecord, type Op } from "@drawpane/model";
import type { Doc } from "./doc";
import { round2 } from "./geometry";
import { strokeWidths } from "./stroke-sides";

export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Axis = "h" | "v";
type Align = "start" | "center" | "end" | "stretch";

/** A grid item's cells, from 0: where it starts and how many tracks it spans. */
export interface GridCell {
  readonly column: number;
  readonly row: number;
  readonly columnSpan: number;
  readonly rowSpan: number;
}

/** A solved grid: each track's start and size in the frame's local space, and each item's cells. */
export interface GridGeometry {
  readonly columns: readonly { start: number; size: number }[];
  readonly rows: readonly { start: number; size: number }[];
  readonly columnTracks: readonly GridTrack[];
  readonly rowTracks: readonly GridTrack[];
  readonly cells: ReadonlyMap<string, GridCell>;
}

interface FlexAxes {
  readonly row: boolean;
  readonly main: Axis;
  readonly cross: Axis;
  readonly pad: ReturnType<typeof padding>;
  readonly innerMain: number;
  readonly innerCross: number;
  /** Inner space without clamping to 0, so alignment still centres when padding exceeds a fixed box. */
  readonly rawInnerMain: number;
  readonly rawInnerCross: number;
  readonly hugsMain: boolean;
  readonly wraps: boolean;
  readonly gap: number;
  /** Between wrapped lines (0 when cross-axis spacing is Auto / space-between). */
  readonly lineGap: number;
}

const AUTO: GridTrack = { unit: "auto" };
const ONE_FR: GridTrack = { unit: "fr", value: 1 };

function isLayoutFrame(node: NodeRecord | undefined): node is NodeRecord {
  return node?.type === "frame" && getProp(node.props, "layoutMode") !== "none";
}

function isGrid(node: NodeRecord): boolean {
  return getProp(node.props, "layoutMode") === "grid";
}

function participates(node: NodeRecord): boolean {
  return getProp(node.props, "visible") && getProp(node.props, "positioning") === "auto";
}

/**
 * The layers an auto layout frame places, in order: visible and not
 * absolute. A group takes part as the box around what's in it. The one rule
 * for layout, X-ray and Explain alike.
 */
export function flowChildren(doc: Doc, frameId: string): NodeRecord[] {
  const out: NodeRecord[] = [];
  for (const id of doc.childIds(frameId)) {
    const child = doc.get(id);
    if (child && inFlow(child)) out.push(child);
  }
  return out;
}

/** Whether auto layout places this layer, in a layout frame (see `flowChildren`). */
export function inFlow(node: NodeRecord): boolean {
  return participates(node);
}

/**
 * A layer's box as auto layout sees it, in its parent's space: its own
 * position and size, or for a group, the box around everything in it.
 */
export function layoutBox(doc: Pick<Doc, "get" | "childIds">, id: string): LayoutBox {
  const node = doc.get(id);
  if (node?.type !== "group") {
    const p = node?.props ?? {};
    return {
      x: getProp(p, "x"),
      y: getProp(p, "y"),
      width: getProp(p, "width"),
      height: getProp(p, "height"),
    };
  }
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const child of doc.childIds(id)) {
    const b = layoutBox(doc, child);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }
  return Number.isFinite(x0)
    ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
    : { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * Whether auto layout decides where this layer goes: it's in a layout
 * frame's flow, or inside a group (or groups) that is.
 */
export function placedByLayout(doc: Doc, id: string): boolean {
  let node = doc.get(id);
  while (node) {
    if (!inFlow(node)) return false;
    const parent = doc.get(node.parent);
    if (parent?.type !== "group") return isLayoutFrame(parent);
    node = parent;
  }
  return false;
}

/** Gap for auto layout when there's nothing to read it from. */
const DEFAULT_GAP = 8;

/**
 * How layers already sit, as auto layout: the direction they run in (the
 * axis their centres spread along most, unless given), and the gap, the
 * median space between neighbours (so one stray doesn't set it). Turning
 * on auto layout then keeps the spacing people already made.
 */
export function inferFlow(
  boxes: readonly LayoutBox[],
  direction?: "row" | "column",
): { direction: "row" | "column"; gap: number } {
  const spread = (axis: "x" | "y") => {
    const centres = boxes.map((b) => (axis === "x" ? b.x + b.width / 2 : b.y + b.height / 2));
    return Math.max(...centres) - Math.min(...centres);
  };
  const dir = direction ?? (boxes.length < 2 || spread("x") >= spread("y") ? "row" : "column");
  if (boxes.length < 2) return { direction: dir, gap: DEFAULT_GAP };
  const row = dir === "row";
  const sorted = [...boxes].sort((a, b) => (row ? a.x - b.x : a.y - b.y));
  const gaps = sorted.slice(1).map((b, i) => {
    const a = sorted[i] as LayoutBox;
    return row ? b.x - (a.x + a.width) : b.y - (a.y + a.height);
  });
  gaps.sort((a, b) => a - b);
  const mid = gaps.length / 2;
  const median =
    gaps.length % 2 === 1
      ? (gaps[Math.floor(mid)] as number)
      : ((gaps[mid - 1] as number) + (gaps[mid] as number)) / 2;
  return { direction: dir, gap: Math.max(0, Math.round(median)) };
}

/** The space between a frame's edges and what's in it: auto layout padding that moves nothing. */
export function inferPadding(
  frame: { readonly width: number; readonly height: number },
  boxes: readonly LayoutBox[],
): { top: number; right: number; bottom: number; left: number } {
  if (boxes.length === 0) return { top: 0, right: 0, bottom: 0, left: 0 };
  const inset = (v: number) => Math.max(0, Math.round(v));
  return {
    left: inset(Math.min(...boxes.map((b) => b.x))),
    top: inset(Math.min(...boxes.map((b) => b.y))),
    right: inset(frame.width - Math.max(...boxes.map((b) => b.x + b.width))),
    bottom: inset(frame.height - Math.max(...boxes.map((b) => b.y + b.height))),
  };
}

/** The layers that hold a position: a group's are its contents', all the way down. */
function positioned(doc: Doc, id: string): string[] {
  const node = doc.get(id);
  if (node?.type !== "group") return [id];
  return doc.childIds(id).flatMap((child) => positioned(doc, child));
}

function clamp(value: number, min: number | null, max: number | null): number {
  let v = value;
  if (max !== null && v > max) v = max;
  if (min !== null && v < min) v = min;
  return Math.max(0, v);
}

function sizing(node: NodeRecord, axis: Axis) {
  // A group is as big as what's in it: never Fill or Hug, like Figma's.
  if (node.type === "group") return "fixed";
  return getProp(node.props, axis === "h" ? "sizingH" : "sizingV");
}

function limits(node: NodeRecord, axis: Axis): [number | null, number | null] {
  return axis === "h"
    ? [getProp(node.props, "minWidth"), getProp(node.props, "maxWidth")]
    : [getProp(node.props, "minHeight"), getProp(node.props, "maxHeight")];
}

function padding(frame: NodeRecord) {
  const p = frame.props;
  const [top, right, bottom, left] =
    getProp(p, "strokesIncludedInLayout") &&
    getProp(p, "strokeAlign") === "inside" &&
    getProp(p, "strokes").some((paint) => paint.visible !== false)
      ? strokeWidths(frame)
      : [0, 0, 0, 0];
  return {
    top: getProp(p, "paddingTop") + (top ?? 0),
    right: getProp(p, "paddingRight") + (right ?? 0),
    bottom: getProp(p, "paddingBottom") + (bottom ?? 0),
    left: getProp(p, "paddingLeft") + (left ?? 0),
  };
}

/** How a child sits across a flex line: its own `alignSelf`, else the frame's `alignItems`. */
function crossAlign(frame: NodeRecord, child: NodeRecord): Align {
  const self = getProp(child.props, "alignSelf");
  if (self !== "auto") return self;
  const items = getProp(frame.props, "alignItems");
  return items === "baseline" ? "start" : items;
}

/** How a grid item sits in its cells on one axis. */
function cellAlign(frame: NodeRecord, child: NodeRecord, axis: Axis): Align {
  if (axis === "v") return crossAlign(frame, child);
  const self = getProp(child.props, "justifySelf");
  return self !== "auto" ? self : getProp(frame.props, "justifyItems");
}

/**
 * Whether a child takes the size of the space it sits in on an axis: Fill
 * always does; Stretch alignment does unless the child hugs its content.
 */
function stretches(child: NodeRecord, axis: Axis, align: Align): boolean {
  if (child.type === "group") return false;
  const s = sizing(child, axis);
  return s === "fill" || (align === "stretch" && s !== "hug");
}

/** The columns a grid frame defines: at least one, a single 1fr when it names none. */
export function gridColumnsOf(frame: NodeRecord): readonly GridTrack[] {
  const columns = getProp(frame.props, "gridColumns");
  return columns.length > 0 ? columns : [ONE_FR];
}

/**
 * Places grid items in cells: those with a `gridArea` first (kept inside the
 * defined columns), then the rest in order into the next free cell, row by
 * row. Returns each item's cells and how many rows the grid ends up with.
 */
export function placeGridItems(
  frame: NodeRecord,
  items: readonly NodeRecord[],
): { cells: Map<string, GridCell>; rowCount: number } {
  const columnCount = gridColumnsOf(frame).length;
  const cells = new Map<string, GridCell>();
  const taken = new Set<string>();
  const occupy = (cell: GridCell) => {
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++)
      for (let c = cell.column; c < cell.column + cell.columnSpan; c++) taken.add(`${r},${c}`);
  };
  let rowCount = Math.max(1, getProp(frame.props, "gridRows").length);
  for (const item of items) {
    const area = getProp(item.props, "gridArea");
    if (!area) continue;
    const column = Math.min(area.column, columnCount) - 1;
    const cell: GridCell = {
      column,
      row: area.row - 1,
      columnSpan: Math.min(area.columnSpan, columnCount - column),
      rowSpan: area.rowSpan,
    };
    cells.set(item.id, cell);
    occupy(cell);
    rowCount = Math.max(rowCount, cell.row + cell.rowSpan);
  }
  // Auto-placement moves forward only, like CSS's default `grid-auto-flow: row`.
  let cursor = 0;
  for (const item of items) {
    if (cells.has(item.id)) continue;
    while (taken.has(`${Math.floor(cursor / columnCount)},${cursor % columnCount}`)) cursor++;
    const cell: GridCell = {
      column: cursor % columnCount,
      row: Math.floor(cursor / columnCount),
      columnSpan: 1,
      rowSpan: 1,
    };
    cells.set(item.id, cell);
    occupy(cell);
    rowCount = Math.max(rowCount, cell.row + 1);
    cursor++;
  }
  return { cells, rowCount };
}

/**
 * Sizes grid tracks on one axis, following CSS: px tracks are fixed, auto
 * tracks fit their largest single-track item, and fr tracks share the free
 * space but never shrink below their content. With no definite space
 * (`inner` null: the frame hugs), fr tracks size to content in proportion.
 * Items spanning several tracks grow the auto tracks they span when they
 * don't fit.
 */
export function solveTracks(
  defs: readonly GridTrack[],
  items: readonly { start: number; span: number; size: number }[],
  gap: number,
  inner: number | null,
): number[] {
  const content = defs.map(() => 0);
  for (const item of items) {
    if (item.span !== 1) continue;
    content[item.start] = Math.max(content[item.start] ?? 0, item.size);
  }
  const sizes = defs.map((def, i) =>
    def.unit === "px" ? def.value : def.unit === "auto" ? (content[i] ?? 0) : 0,
  );
  const flexible = defs.flatMap((def, i) => (def.unit === "fr" ? [i] : []));
  const fr = (i: number) => {
    const def = defs[i] as GridTrack;
    return def.unit === "fr" ? def.value : 0;
  };
  if (flexible.length > 0) {
    if (inner === null) {
      // Hugging: one fraction that fits every fr track's content.
      const fraction = Math.max(0, ...flexible.map((i) => (content[i] ?? 0) / fr(i)));
      for (const i of flexible) sizes[i] = fraction * fr(i);
    } else {
      // The free space shared by fr, with tracks whose share is smaller than
      // their content frozen at that size and the rest re-shared.
      const fixed = sizes.reduce((sum, s, i) => (defs[i]?.unit === "fr" ? sum : sum + s), 0);
      let free = inner - fixed - gap * Math.max(0, defs.length - 1);
      let open = [...flexible];
      for (let pass = 0; pass <= flexible.length && open.length > 0; pass++) {
        const total = open.reduce((sum, i) => sum + fr(i), 0);
        const fraction = Math.max(0, free) / total;
        const frozen = open.filter((i) => fraction * fr(i) < (content[i] ?? 0));
        if (frozen.length === 0) {
          for (const i of open) sizes[i] = fraction * fr(i);
          break;
        }
        for (const i of frozen) {
          sizes[i] = content[i] ?? 0;
          free -= sizes[i] ?? 0;
        }
        open = open.filter((i) => !frozen.includes(i));
      }
    }
  }
  // Spanning items: grow the auto tracks they cross, evenly, to fit them.
  for (const item of items) {
    if (item.span === 1) continue;
    const span = defs.map((_, i) => i).slice(item.start, item.start + item.span);
    const have = span.reduce((sum, i) => sum + (sizes[i] ?? 0), 0) + gap * (span.length - 1);
    const autos = span.filter((i) => defs[i]?.unit === "auto");
    if (have >= item.size || autos.length === 0) continue;
    const extra = (item.size - have) / autos.length;
    for (const i of autos) sizes[i] = (sizes[i] ?? 0) + extra;
  }
  return sizes;
}

/** How a track reads: 200px, 1fr, auto. */
export function trackLabel(track: GridTrack): string {
  if (track.unit === "auto") return "auto";
  return `${Math.round(track.value * 100) / 100}${track.unit}`;
}

/** One track typed as text: "200", "200px", "1fr", "1.5 fr", "auto". Null when it isn't one. */
export function parseTrack(text: string): GridTrack | null {
  const t = text.trim().toLowerCase();
  if (t === "auto" || t === "hug") return { unit: "auto" };
  const m = t.match(/^(\d+(?:\.\d+)?|\.\d+)\s*(px|fr)?$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (m[2] === "fr") return value > 0 && value <= 1000 ? { unit: "fr", value } : null;
  return { unit: "px", value };
}

/**
 * A CSS track list, as typed or pasted: "200px 1fr 1fr" or "repeat(3, 1fr)",
 * mixed freely. Null when any part isn't a track, or there are more than 64.
 */
export function parseTrackList(text: string): GridTrack[] | null {
  const tracks: GridTrack[] = [];
  const rest = text.replace(
    /repeat\(\s*(\d+)\s*,\s*([^)]+)\)/gi,
    (_, n: string, inner: string) =>
      ` ${Array.from({ length: Math.min(64, Number(n)) }, () => inner.trim()).join(" ")} `,
  );
  // "1 fr" is one track: join a number to a unit after it.
  for (const part of rest
    .replace(/(\d)\s+(px|fr)\b/gi, "$1$2")
    .split(/[\s,]+/)
    .filter(Boolean)) {
    const track = parseTrack(part);
    if (!track) return null;
    tracks.push(track);
  }
  return tracks.length > 0 && tracks.length <= 64 ? tracks : null;
}

/** Track starts from sizes: one after another, `gap` apart, from `offset`. */
function trackStarts(sizes: readonly number[], gap: number, offset: number) {
  let at = offset;
  return sizes.map((size) => {
    const track = { start: at, size };
    at += size + gap;
    return track;
  });
}

const total = (sizes: readonly number[], gap: number) =>
  sizes.reduce((sum, s) => sum + s, 0) + gap * Math.max(0, sizes.length - 1);

/**
 * Computes boxes for a layout frame and everything below it that layout
 * controls. `boxes` holds the result; the frame's own size may change when it
 * hugs its content.
 */
export class LayoutEngine {
  readonly #doc: Doc;
  readonly boxes = new Map<string, LayoutBox>();
  /** Which layout frames below the one run are laid out too; the rest keep their insides as they are. */
  readonly #enters: (frame: NodeRecord) => boolean;
  /**
   * Of those, the ones laid out already, which need laying out again only if
   * their parent gives them another size: until then they're read as they are.
   */
  readonly #settled: (frame: NodeRecord) => boolean;
  /** Frames that had flow children before the edit and should shrink when emptied. */
  readonly #shrinkEmpty: ReadonlySet<string> | undefined;
  /** Frames already known to be empty before the edit (overrides main-frame fallback). */
  readonly #keepEmpty: ReadonlySet<string> | undefined;

  constructor(
    doc: Doc,
    options: {
      enters?: (frame: NodeRecord) => boolean;
      settled?: (frame: NodeRecord) => boolean;
      shrinkEmpty?: ReadonlySet<string>;
      keepEmpty?: ReadonlySet<string>;
    } = {},
  ) {
    this.#doc = doc;
    this.#enters = options.enters ?? (() => true);
    this.#settled = options.settled ?? (() => false);
    this.#shrinkEmpty = options.shrinkEmpty;
    this.#keepEmpty = options.keepEmpty;
  }

  #shouldShrinkEmpty(frame: NodeRecord, axis: Axis): boolean {
    if (!this.#shrinkEmpty || this.#shrinkEmpty.size === 0) return false;
    const axisKey = (id: string) => `${id}:${axis}`;
    if (this.#shrinkEmpty.has(frame.id) || this.#shrinkEmpty.has(axisKey(frame.id))) return true;
    if (this.#keepEmpty?.has(frame.id) || this.#keepEmpty?.has(axisKey(frame.id))) return false;
    const mirrors = getProp(frame.props, "mirrors");
    if (mirrors && (this.#shrinkEmpty.has(mirrors) || this.#shrinkEmpty.has(axisKey(mirrors))))
      return true;
    const instanceOf = getProp(frame.props, "instanceOf");
    if (
      instanceOf &&
      (this.#shrinkEmpty.has(instanceOf) || this.#shrinkEmpty.has(axisKey(instanceOf)))
    )
      return true;
    return false;
  }

  /** A child that is a layout frame this run lays out inside. */
  #nested(node: NodeRecord | undefined): node is NodeRecord {
    return isLayoutFrame(node) && this.#enters(node);
  }

  /**
   * A child that is a layout frame to lay out inside now that its parent has
   * placed it: one that isn't settled, or a settled one given another size.
   */
  #placedNested(node: NodeRecord): boolean {
    if (!this.#nested(node)) return false;
    if (!this.#settled(node)) return true;
    const box = this.boxes.get(node.id);
    return (
      box !== undefined &&
      (box.width !== getProp(node.props, "width") || box.height !== getProp(node.props, "height"))
    );
  }

  /** Where each group placed in a flow was before, to move its contents by the difference. */
  readonly #groupOrigins = new Map<string, { x: number; y: number }>();

  box(id: string): LayoutBox {
    let box = this.boxes.get(id);
    if (!box) {
      if (this.#doc.get(id)?.type === "group") {
        box = this.#bounds(id);
        this.#groupOrigins.set(id, { x: box.x, y: box.y });
      } else box = layoutBox(this.#doc, id);
      this.boxes.set(id, box);
    }
    return box;
  }

  /** A group's box from its contents as laid out so far (a frame in it may have just re-hugged). */
  #bounds(groupId: string): LayoutBox {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const id of this.#doc.childIds(groupId)) {
      const node = this.#doc.get(id);
      const b = node?.type === "group" ? this.#bounds(id) : this.box(id);
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width);
      y1 = Math.max(y1, b.y + b.height);
    }
    return Number.isFinite(x0)
      ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      : { x: 0, y: 0, width: 0, height: 0 };
  }

  /** Lays out the layout frames in a group (through nested groups) before the group is measured. */
  #settleGroup(groupId: string): void {
    for (const id of this.#doc.childIds(groupId)) {
      const node = this.#doc.get(id);
      if (node?.type === "group") this.#settleGroup(id);
      else if (this.#nested(node)) this.run(id);
    }
  }

  #get(id: string, axis: Axis): number {
    const b = this.box(id);
    return axis === "h" ? b.width : b.height;
  }

  #set(id: string, axis: Axis, value: number): void {
    const b = this.box(id);
    if (axis === "h") b.width = value;
    else b.height = value;
  }

  /** Text layers whose width or height auto layout now decides (by Fill or stretch). */
  readonly #claimed = new Map<string, Set<Axis>>();

  /**
   * Sizes a child by Fill or stretch. A text layer that sized itself on that
   * axis gives it up to the layout, like Figma's: auto width becomes auto
   * height, and with its height taken too, fixed. Otherwise the text and the
   * layout would both claim the size, and it would jump when either let go.
   */
  #claim(child: NodeRecord, axis: Axis, value: number): void {
    this.#set(child.id, axis, value);
    if (child.type !== "text") return;
    const axes = this.#claimed.get(child.id) ?? new Set<Axis>();
    axes.add(axis);
    this.#claimed.set(child.id, axes);
  }

  #children(frame: NodeRecord): NodeRecord[] {
    return flowChildren(this.#doc, frame.id);
  }

  /** A frame's layout frame children that its flow doesn't place. */
  #outOfFlow(frame: NodeRecord): NodeRecord[] {
    const out: NodeRecord[] = [];
    for (const id of this.#doc.childIds(frame.id)) {
      const child = this.#doc.get(id);
      if (child && this.#nested(child) && !inFlow(child)) out.push(child);
    }
    return out;
  }

  /** A hugging frame's size on an axis: its content plus padding, within its limits. */
  #hug(frame: NodeRecord, axis: Axis, content: number): void {
    if (sizing(frame, axis) !== "hug") return;
    const pad = padding(frame);
    const [min, max] = limits(frame, axis);
    const padAxis = axis === "h" ? pad.left + pad.right : pad.top + pad.bottom;
    this.#set(frame.id, axis, clamp(content + padAxis, min, max));
  }

  /** Sine and cosine magnitudes of a layer's rotation, or null when unrotated. */
  #trig(child: NodeRecord): { cos: number; sin: number } | null {
    if (child.type === "group") return null;
    const rot = getProp(child.props, "rotation");
    if (rot === 0) return null;
    const rad = (rot * Math.PI) / 180;
    return { cos: Math.abs(Math.cos(rad)), sin: Math.abs(Math.sin(rad)) };
  }

  /** A child's axis-aligned size in its parent's flow (its own size when unrotated). */
  #flowSize(child: NodeRecord, axis: Axis): number {
    const trig = this.#trig(child);
    if (!trig) return this.#get(child.id, axis);
    const b = this.box(child.id);
    return axis === "h"
      ? b.width * trig.cos + b.height * trig.sin
      : b.width * trig.sin + b.height * trig.cos;
  }

  /** The child's own axis most aligned with `parentAxis` (swapped when turned past 45 deg). */
  #localAxis(child: NodeRecord, parentAxis: Axis): Axis {
    const trig = this.#trig(child);
    if (!trig || trig.sin <= trig.cos) return parentAxis;
    return parentAxis === "h" ? "v" : "h";
  }

  /** Whether a child is rotated at an oblique angle (not a multiple of 90 degrees). */
  #isOblique(child: NodeRecord): boolean {
    const trig = this.#trig(child);
    return trig !== null && Math.min(trig.cos, trig.sin) >= 1e-9;
  }

  /**
   * Projected size along `axis`, substituting `min` on any local axis that the
   * parent stretches so wrapping and track sizing stay invariant across passes.
   */
  #projectedIntrinsic(child: NodeRecord, axis: Axis, stretchH: boolean, stretchV: boolean): number {
    const trig = this.#trig(child);
    if (!trig) {
      const stretch = axis === "h" ? stretchH : stretchV;
      return stretch ? (limits(child, axis)[0] ?? 0) : this.#get(child.id, axis);
    }
    const w = stretchH ? (limits(child, "h")[0] ?? 0) : this.#get(child.id, "h");
    const h = stretchV ? (limits(child, "v")[0] ?? 0) : this.#get(child.id, "v");
    return axis === "h" ? w * trig.cos + h * trig.sin : w * trig.sin + h * trig.cos;
  }

  /** Which of a child's local axes a flex parent stretches. */
  #stretchedLocal(
    frame: NodeRecord,
    child: NodeRecord,
    axes: Pick<FlexAxes, "main" | "cross" | "hugsMain">,
  ): { h: boolean; v: boolean } {
    const stretchMain = sizing(child, axes.main) === "fill" && !axes.hugsMain;
    const stretchCross = stretches(child, axes.cross, crossAlign(frame, child));
    if (!stretchMain && !stretchCross) return { h: false, v: false };
    const localMain = this.#localAxis(child, axes.main);
    const localCross = this.#localAxis(child, axes.cross);
    return {
      h: (stretchMain && localMain === "h") || (stretchCross && localCross === "h"),
      v: (stretchMain && localMain === "v") || (stretchCross && localCross === "v"),
    };
  }

  /** Bottom-up: settle the size of a hugging layout frame from its content. */
  measure(frame: NodeRecord): void {
    const children = this.#children(frame);
    // A settled child measures as it is: laid out already, it would come out the same.
    for (const child of children)
      if (this.#nested(child) && !this.#settled(child)) this.measure(child);
    // Layout frames out of the flow (absolute or hidden) still size themselves
    // and their contents; the flow just doesn't place them. The frames in a
    // group settle before the group's box is read.
    for (const child of this.#outOfFlow(frame)) this.run(child.id);
    for (const id of this.#doc.childIds(frame.id))
      if (this.#doc.get(id)?.type === "group") this.#settleGroup(id);
    if (isGrid(frame)) this.#measureGrid(frame, children);
    else this.#measureFlex(frame, children);
  }

  #flexAxes(frame: NodeRecord): FlexAxes {
    const row = getProp(frame.props, "layoutMode") === "row";
    const main: Axis = row ? "h" : "v";
    const cross: Axis = row ? "v" : "h";
    const pad = padding(frame);
    const box = this.box(frame.id);
    const rawInnerMain = row ? box.width - pad.left - pad.right : box.height - pad.top - pad.bottom;
    const rawInnerCross = row
      ? box.height - pad.top - pad.bottom
      : box.width - pad.left - pad.right;
    const innerMain = Math.max(0, rawInnerMain);
    const innerCross = Math.max(0, rawInnerCross);
    const hugsMain = sizing(frame, main) === "hug";
    // Wrapping needs a main size to wrap at: a hugging frame never wraps.
    const wraps = getProp(frame.props, "layoutWrap") && !hugsMain;
    const lineGap =
      getProp(frame.props, "alignContent") === "space-between" ? 0 : getProp(frame.props, "rowGap");
    return {
      row,
      main,
      cross,
      pad,
      innerMain,
      innerCross,
      rawInnerMain,
      rawInnerCross,
      hugsMain,
      wraps,
      gap: getProp(frame.props, "gap"),
      lineGap,
    };
  }

  /** A child's main size before Fill shares out space: stretched local axes start at their minimum. */
  #basis(frame: NodeRecord, child: NodeRecord, axes: FlexAxes): number {
    const s = this.#stretchedLocal(frame, child, axes);
    return this.#projectedIntrinsic(child, axes.main, s.h, s.v);
  }

  /** Breaks children into lines that fit `innerMain` (one line when not wrapping). */
  #lines(frame: NodeRecord, children: NodeRecord[], axes: FlexAxes): NodeRecord[][] {
    if (!axes.wraps) return [children];
    const lines: NodeRecord[][] = [];
    let line: NodeRecord[] = [];
    let used = 0;
    for (const child of children) {
      const size = this.#basis(frame, child, axes);
      if (line.length > 0 && used + axes.gap + size > axes.innerMain + 1e-6) {
        lines.push(line);
        line = [];
        used = 0;
      }
      used += (line.length > 0 ? axes.gap : 0) + size;
      line.push(child);
    }
    if (line.length > 0) lines.push(line);
    return lines;
  }

  /** How thick a wrapped line is across: its thickest child's cross contribution. */
  #lineCross(frame: NodeRecord, line: NodeRecord[], axes: FlexAxes): number {
    return line.reduce(
      (m, c) =>
        Math.max(
          m,
          this.#contribution(
            c,
            axes.cross,
            stretches(c, axes.cross, crossAlign(frame, c)),
            sizing(c, axes.main) === "fill" && !axes.hugsMain,
          ),
        ),
      0,
    );
  }

  /**
   * How thick a line makes a frame that hugs across. Layers that stretch
   * across follow the frame, so they don't size it (counting them would hold
   * it open after what does size it shrinks). But when every layer in the
   * line stretches, nothing else can: Figma then treats them as their own
   * size (it won't let a frame hug only layers that fill it), so the line is
   * as thick as they are, not their minimum. Imported kits have such frames.
   */
  #hugLineCross(frame: NodeRecord, line: NodeRecord[], axes: FlexAxes): number {
    const { cross } = axes;
    const free = line.length > 0 && line.every((c) => stretches(c, cross, crossAlign(frame, c)));
    if (!free) return this.#lineCross(frame, line, axes);
    return line.reduce((m, c) => Math.max(m, this.#flowSize(c, cross)), 0);
  }

  /**
   * Each line's thickness across, once placed. A single unwrapped line spans
   * the frame. Wrapped lines are as thick as their content; a line whose
   * layers all stretch has nothing to size it, so those lines share the
   * frame's free space across (a hugging frame has none to share), the way a
   * stretched line fills a frame that doesn't wrap.
   */
  #thicknesses(frame: NodeRecord, lines: NodeRecord[][], axes: FlexAxes): number[] {
    if (!axes.wraps) return [axes.innerCross];
    const { cross } = axes;
    if (sizing(frame, cross) === "hug")
      return lines.map((line) => this.#hugLineCross(frame, line, axes));
    const thickness = lines.map((line) => this.#lineCross(frame, line, axes));
    const unsized = lines.map((line) =>
      line.every((c) => stretches(c, cross, crossAlign(frame, c))),
    );
    const count = unsized.filter(Boolean).length;
    if (count === 0) return thickness;
    const sized = thickness.reduce((s, t, i) => s + (unsized[i] ? 0 : t), 0);
    const share =
      Math.max(0, axes.innerCross - sized - axes.lineGap * Math.max(0, lines.length - 1)) / count;
    return thickness.map((t, i) => (unsized[i] ? Math.max(t, share) : t));
  }

  /** A flex frame's lines as placed: their layers, thickness, and the layer that sets it. */
  lines(frame: NodeRecord): FlowLine[] {
    const axes = this.#flexAxes(frame);
    const lines = this.#lines(frame, this.#children(frame), axes);
    const thickness = this.#thicknesses(frame, lines, axes);
    return lines.map((line, i) => {
      let setBy: NodeRecord | null = null;
      if (axes.wraps)
        for (const c of line) {
          if (stretches(c, axes.cross, crossAlign(frame, c))) continue;
          if (!setBy || this.#flowSize(c, axes.cross) > this.#flowSize(setBy, axes.cross))
            setBy = c;
        }
      return { ids: line.map((c) => c.id), thickness: thickness[i] ?? 0, setBy: setBy?.id ?? null };
    });
  }

  /** Space-between distribution summary for CSS export parity. */
  flexDistribution(frame: NodeRecord): FlexDistribution {
    const justify = getProp(frame.props, "justifyContent");
    const figmaSpaceBetween = getProp(frame.props, "spaceBetweenMode") === "figma";
    const align = getProp(frame.props, "alignItems");
    const wraps = getProp(frame.props, "layoutWrap");
    const alignContentProp = getProp(frame.props, "alignContent");
    let cssAlignContent: FlexDistribution["alignContent"] = !wraps
      ? null
      : alignContentProp === "space-between"
        ? "space-between"
        : alignContentProp === "auto" && (align === "center" || align === "end")
          ? align === "center"
            ? "center"
            : "flex-end"
          : "flex-start";
    const figmaMain = justify === "space-between" && figmaSpaceBetween;
    const figmaCross = wraps && alignContentProp === "space-between";
    if (!figmaMain && !figmaCross) {
      return { bake: false, justify, alignContent: cssAlignContent };
    }
    const children = this.#children(frame);
    if (children.length === 0) {
      return { bake: false, justify, alignContent: cssAlignContent };
    }
    const axes = this.#flexAxes(frame);
    const lines = this.#lines(frame, children, axes);
    const thickness = this.#thicknesses(frame, lines, axes);
    let bake = false;
    let cssJustify = justify;
    if (axes.wraps && alignContentProp === "space-between") {
      if (lines.length === 1) {
        cssAlignContent = "center";
        if (axes.rawInnerCross < 0) bake = true;
      } else if (lines.length > 1) {
        const usedCross = thickness.reduce((s, t) => s + t, 0);
        if (usedCross > axes.rawInnerCross + 1e-6) bake = true;
      }
    }
    if (figmaMain) {
      const singleLines = lines.filter((l) => l.length === 1).length;
      const multiLines = lines.filter((l) => l.length > 1).length;
      if (singleLines > 0 && multiLines > 0) {
        bake = true;
      } else if (singleLines > 0) {
        cssJustify = "center";
        if (axes.rawInnerMain < 0) bake = true;
      } else if (multiLines > 0) {
        for (const line of lines) {
          if (line.length <= 1) continue;
          const used = line.reduce((s, c) => s + this.#flowSize(c, axes.main), 0);
          if (used > axes.rawInnerMain + 1e-6) {
            bake = true;
            break;
          }
        }
      }
    }
    return { bake, justify: cssJustify, alignContent: cssAlignContent };
  }

  #measureFlex(frame: NodeRecord, children: NodeRecord[]): void {
    // An already-empty hugging frame keeps its saved box; a frame that just lost
    // its last flow child or explicitly switched an axis to Hug measures normally.
    const empty = children.length === 0;
    const axes = this.#flexAxes(frame);
    const { main, cross } = axes;
    if (axes.hugsMain && (!empty || this.#shouldShrinkEmpty(frame, main))) {
      const sizes = children.map((c) => {
        if (
          this.#isOblique(c) &&
          sizing(frame, cross) !== "hug" &&
          stretches(c, cross, crossAlign(frame, c))
        ) {
          const localCross = this.#localAxis(c, cross);
          const [min, max] = limits(c, localCross);
          const targetCross = clamp(axes.innerCross, min, max);
          const trig = this.#trig(c) as { cos: number; sin: number };
          const w = localCross === "h" ? targetCross : this.#get(c.id, "h");
          const h = localCross === "v" ? targetCross : this.#get(c.id, "v");
          return main === "h" ? w * trig.cos + h * trig.sin : w * trig.sin + h * trig.cos;
        }
        return this.#flowSize(c, main);
      });
      this.#hug(frame, main, total(sizes, axes.gap));
    }
    if (sizing(frame, cross) === "hug" && (!empty || this.#shouldShrinkEmpty(frame, cross))) {
      const lines = this.#lines(frame, children, axes);
      const thickness = lines.map((line) => this.#hugLineCross(frame, line, axes));
      this.#hug(frame, cross, total(thickness, axes.lineGap));
    }
  }

  /** Top-down: place children of a layout frame whose own size is settled. */
  arrange(frame: NodeRecord): void {
    const children = this.#children(frame);
    if (isGrid(frame)) this.#arrangeGrid(frame, children);
    else this.#arrangeFlex(frame, children);
    for (const child of children) if (this.#placedNested(child)) this.arrange(child);
  }

  #arrangeFlex(frame: NodeRecord, children: NodeRecord[]): void {
    const axes = this.#flexAxes(frame);
    const { row, main, cross, gap, innerMain, rawInnerMain, rawInnerCross, hugsMain, pad } = axes;
    const lines = this.#lines(frame, children, axes);
    const thickness = this.#thicknesses(frame, lines, axes);
    const hugsCross = sizing(frame, cross) === "hug";

    // Oblique children that only stretch across settle before main Fill so
    // their final projected main size is included in `fixedTotal`.
    lines.forEach((line, i) => {
      const allStretchCross =
        hugsCross && line.every((c) => stretches(c, cross, crossAlign(frame, c)));
      if (allStretchCross) return;
      for (const child of line) {
        if (!this.#isOblique(child)) continue;
        if (sizing(child, main) === "fill" && !hugsMain) continue;
        if (!stretches(child, cross, crossAlign(frame, child))) continue;
        const local = this.#localAxis(child, cross);
        const [min, max] = limits(child, local);
        this.#claim(child, local, clamp(thickness[i] ?? 0, min, max));
      }
    });

    // Main axis sizes: in each line, Fill children share what is left (a
    // hugging parent can't be filled).
    for (const line of lines) {
      const fills = line.filter((c) => sizing(c, main) === "fill" && !hugsMain);
      const fixedTotal = line
        .filter((c) => !fills.includes(c))
        .reduce((s, c) => s + this.#flowSize(c, main), 0);
      let remaining = innerMain - fixedTotal - gap * Math.max(0, line.length - 1);
      // Distribute, respecting min/max: clamped children drop out and the rest re-share.
      let open = [...fills];
      for (let pass = 0; pass < 4 && open.length > 0; pass++) {
        const share = Math.max(0, remaining) / open.length;
        const next: NodeRecord[] = [];
        let used = 0;
        for (const child of open) {
          const local = this.#localAxis(child, main);
          const [min, max] = limits(child, local);
          const value = clamp(share, min, max);
          this.#claim(child, local, value);
          if (value !== share) used += value;
          else next.push(child);
        }
        if (next.length === open.length) break;
        remaining -= used;
        open = next;
      }
    }

    // If an oblique main-Fill child grew its projected cross size, widen wrapped
    // lines to fit it before stretching the remaining children across.
    if (axes.wraps) {
      lines.forEach((line, i) => {
        for (const child of line) {
          if (!this.#isOblique(child)) continue;
          if (!(sizing(child, main) === "fill" && !hugsMain)) continue;
          if (stretches(child, cross, crossAlign(frame, child))) continue;
          thickness[i] = Math.max(thickness[i] ?? 0, this.#flowSize(child, cross));
        }
      });
    }

    // Cross axis: a single line spans the frame; wrapped lines are as thick as their content.
    lines.forEach((line, i) => {
      const allStretchCross =
        hugsCross && line.every((c) => stretches(c, cross, crossAlign(frame, c)));
      for (const child of line) {
        if (!stretches(child, cross, crossAlign(frame, child))) continue;
        if (this.#isOblique(child)) {
          if (allStretchCross || !(sizing(child, main) === "fill" && !hugsMain)) continue;
        }
        const local = this.#localAxis(child, cross);
        const [min, max] = limits(child, local);
        this.#claim(child, local, clamp(thickness[i] ?? 0, min, max));
      }
    });

    // Children that are layout frames settle their own content first, so a
    // hugging child has its final size before we position it.
    for (const child of children) if (this.#placedNested(child)) this.measure(child);

    const justify = getProp(frame.props, "justifyContent");
    const figmaSpaceBetween = getProp(frame.props, "spaceBetweenMode") === "figma";
    const alignContent = getProp(frame.props, "alignContent");
    const frameAlign = getProp(frame.props, "alignItems");
    let crossStart = row ? pad.top : pad.left;
    let lineStepGap = axes.lineGap;
    if (axes.wraps) {
      if (alignContent === "space-between") {
        const usedCross = thickness.reduce((s, t) => s + t, 0);
        if (lines.length === 1) crossStart += (rawInnerCross - usedCross) / 2;
        else if (lines.length > 1) lineStepGap = (rawInnerCross - usedCross) / (lines.length - 1);
      } else if (alignContent === "auto") {
        const freeCross = rawInnerCross - total(thickness, axes.lineGap);
        if (frameAlign === "center") crossStart += freeCross / 2;
        else if (frameAlign === "end") crossStart += freeCross;
      }
    }
    lines.forEach((line, i) => {
      const lineCross = thickness[i] ?? 0;
      const slotCross = axes.wraps ? lineCross : rawInnerCross;
      const used = line.reduce((s, c) => s + this.#flowSize(c, main), 0);
      const free = rawInnerMain - used - gap * Math.max(0, line.length - 1);
      let offset = row ? pad.left : pad.top;
      let spacing = gap;
      if (justify === "center") offset += free / 2;
      else if (justify === "end") offset += free;
      else if (justify === "space-between") {
        if (figmaSpaceBetween) {
          if (line.length === 1) offset += free / 2;
          else if (line.length > 1) spacing = (rawInnerMain - used) / (line.length - 1);
        } else if (line.length > 1) {
          // CSS keeps the gap as a minimum and shares only the space left above it.
          const extra = innerMain - used - gap * (line.length - 1);
          spacing = gap + Math.max(0, extra) / (line.length - 1);
        }
      }
      for (const child of line) {
        const b = this.box(child.id);
        const rotated = this.#trig(child) !== null;
        const mainSize = this.#flowSize(child, main);
        const crossSize = this.#flowSize(child, cross);
        const align = crossAlign(frame, child);
        let crossPos = crossStart;
        if (align === "center" || (rotated && stretches(child, cross, align)))
          crossPos += (slotCross - crossSize) / 2;
        else if (align === "end") crossPos += slotCross - crossSize;
        const mainLocal = this.#get(child.id, main);
        const crossLocal = this.#get(child.id, cross);
        const mainPos = offset + (mainSize - mainLocal) / 2;
        const finalCrossPos = crossPos + (crossSize - crossLocal) / 2;
        if (row) {
          b.x = mainPos;
          b.y = finalCrossPos;
        } else {
          b.x = finalCrossPos;
          b.y = mainPos;
        }
        offset += mainSize + spacing;
      }
      crossStart += lineCross + lineStepGap;
    });
  }

  /**
   * What an item brings to the line or track it's in: its flow size, or when it
   * stretches, what its content needs (nested layout frames measure their own
   * content; vertically stretched text keeps its text height; other layers
   * bring their minimum).
   */
  #contribution(child: NodeRecord, axis: Axis, stretching: boolean, stretchOther = false): number {
    if (!stretching) {
      if (!stretchOther) return this.#flowSize(child, axis);
      const other = this.#localAxis(child, axis === "h" ? "v" : "h");
      return this.#projectedIntrinsic(child, axis, other === "h", other === "v");
    }
    if (axis === "v" && child.type === "text" && this.#localAxis(child, axis) === "v") {
      const gl = getProp(child.props, "glyphLayout");
      const content =
        gl !== null
          ? gl.h
          : getProp(child.props, "textAutoResize") !== "none"
            ? this.#get(child.id, "v")
            : 0;
      return Math.max(limits(child, "v")[0] ?? 0, content);
    }
    if (isLayoutFrame(child)) return this.#contentSize(child, axis);
    return limits(child, this.#localAxis(child, axis))[0] ?? 0;
  }

  /**
   * The size a layout frame's content needs on an axis, with its padding and
   * within its limits: what it would hug to, its Fill and stretched layout
   * frames at what their own content needs, other Fill and stretched layers
   * at their minimum.
   */
  #contentSize(frame: NodeRecord, axis: Axis): number {
    const children = this.#children(frame);
    const pad = padding(frame);
    let content: number;
    if (isGrid(frame)) {
      const { cells, rowCount } = placeGridItems(frame, children);
      const defs = this.#gridDefs(frame, rowCount);
      const sizes = this.#gridTracks(
        frame,
        children,
        cells,
        axis,
        axis === "h" ? defs.columns : defs.rows,
        null,
      );
      content = total(sizes, getProp(frame.props, axis === "h" ? "gap" : "rowGap"));
    } else {
      const axes = this.#flexAxes(frame);
      if (axis === axes.main) {
        const sizes = children.map((c) =>
          this.#contribution(
            c,
            axis,
            c.type !== "group" && sizing(c, axis) === "fill",
            stretches(c, axes.cross, crossAlign(frame, c)),
          ),
        );
        content = total(sizes, axes.gap);
      } else {
        const lines = this.#lines(frame, children, axes);
        const thickness = lines.map((line) => this.#lineCross(frame, line, axes));
        content = total(thickness, axes.lineGap);
      }
    }
    const [min, max] = limits(frame, axis);
    return clamp(content + (axis === "h" ? pad.left + pad.right : pad.top + pad.bottom), min, max);
  }

  /** Track sizes on one axis of a grid; `inner` null when the frame hugs that axis. */
  #gridTracks(
    frame: NodeRecord,
    children: NodeRecord[],
    cells: ReadonlyMap<string, GridCell>,
    axis: Axis,
    defs: readonly GridTrack[],
    inner: number | null,
  ): number[] {
    const otherAxis: Axis = axis === "h" ? "v" : "h";
    const items = children.map((child) => {
      const cell = cells.get(child.id) as GridCell;
      return {
        start: axis === "h" ? cell.column : cell.row,
        span: axis === "h" ? cell.columnSpan : cell.rowSpan,
        size: this.#contribution(
          child,
          axis,
          stretches(child, axis, cellAlign(frame, child, axis)),
          stretches(child, otherAxis, cellAlign(frame, child, otherAxis)),
        ),
      };
    });
    const gap = getProp(frame.props, axis === "h" ? "gap" : "rowGap");
    return solveTracks(defs, items, gap, inner);
  }

  #gridDefs(frame: NodeRecord, rowCount: number) {
    const rows = getProp(frame.props, "gridRows");
    return {
      columns: gridColumnsOf(frame),
      // Rows beyond the defined ones are implicit, sized to their content.
      rows: Array.from({ length: rowCount }, (_, i) => rows[i] ?? AUTO),
    };
  }

  #measureGrid(frame: NodeRecord, children: NodeRecord[]): void {
    const empty = children.length === 0;
    const hugH = sizing(frame, "h") === "hug" && (!empty || this.#shouldShrinkEmpty(frame, "h"));
    const hugV = sizing(frame, "v") === "hug" && (!empty || this.#shouldShrinkEmpty(frame, "v"));
    if (!hugH && !hugV) return;
    const { cells, rowCount } = placeGridItems(frame, children);
    const defs = this.#gridDefs(frame, rowCount);
    if (hugH) {
      const sizes = this.#gridTracks(frame, children, cells, "h", defs.columns, null);
      this.#hug(frame, "h", total(sizes, getProp(frame.props, "gap")));
    }
    if (hugV) {
      const sizes = this.#gridTracks(frame, children, cells, "v", defs.rows, null);
      this.#hug(frame, "v", total(sizes, getProp(frame.props, "rowGap")));
    }
  }

  /** Solves a grid frame's tracks from the boxes as they stand (its size settled). */
  #solveGrid(
    frame: NodeRecord,
    children: NodeRecord[],
    cells: ReadonlyMap<string, GridCell>,
    rowCount: number,
  ) {
    const defs = this.#gridDefs(frame, rowCount);
    const pad = padding(frame);
    const box = this.box(frame.id);
    const columns = this.#gridTracks(
      frame,
      children,
      cells,
      "h",
      defs.columns,
      Math.max(0, box.width - pad.left - pad.right),
    );
    return { defs, pad, box, columns };
  }

  #arrangeGrid(frame: NodeRecord, children: NodeRecord[]): void {
    const { cells, rowCount } = placeGridItems(frame, children);
    const { defs, pad, box, columns } = this.#solveGrid(frame, children, cells, rowCount);
    const columnGap = getProp(frame.props, "gap");
    const rowGap = getProp(frame.props, "rowGap");
    const span = (sizes: number[], start: number, count: number, gap: number) =>
      total(sizes.slice(start, start + count), gap);

    // Widths first: a child's height can depend on its width (nested layout, text).
    for (const child of children) {
      const cell = cells.get(child.id) as GridCell;
      if (!stretches(child, "h", cellAlign(frame, child, "h"))) continue;
      const local = this.#localAxis(child, "h");
      const [min, max] = limits(child, local);
      this.#claim(
        child,
        local,
        clamp(span(columns, cell.column, cell.columnSpan, columnGap), min, max),
      );
    }
    for (const child of children) if (this.#placedNested(child)) this.measure(child);

    const rows = this.#gridTracks(
      frame,
      children,
      cells,
      "v",
      defs.rows,
      Math.max(0, box.height - pad.top - pad.bottom),
    );
    for (const child of children) {
      const cell = cells.get(child.id) as GridCell;
      if (!stretches(child, "v", cellAlign(frame, child, "v"))) continue;
      const local = this.#localAxis(child, "v");
      const [min, max] = limits(child, local);
      this.#claim(child, local, clamp(span(rows, cell.row, cell.rowSpan, rowGap), min, max));
    }
    for (const child of children) if (this.#placedNested(child)) this.measure(child);

    const columnTracks = trackStarts(columns, columnGap, pad.left);
    const rowTracks = trackStarts(rows, rowGap, pad.top);
    for (const child of children) {
      const cell = cells.get(child.id) as GridCell;
      const b = this.box(child.id);
      const rotated = this.#trig(child) !== null;
      const place = (axis: Axis, start: number, area: number) => {
        const size = this.#flowSize(child, axis);
        const align = cellAlign(frame, child, axis);
        let pos = start;
        if (align === "center" || (rotated && stretches(child, axis, align)))
          pos = start + (area - size) / 2;
        else if (align === "end") pos = start + area - size;
        return pos + (size - this.#get(child.id, axis)) / 2;
      };
      b.x = place(
        "h",
        columnTracks[cell.column]?.start ?? pad.left,
        span(columns, cell.column, cell.columnSpan, columnGap),
      );
      b.y = place(
        "v",
        rowTracks[cell.row]?.start ?? pad.top,
        span(rows, cell.row, cell.rowSpan, rowGap),
      );
    }
  }

  /**
   * A grid frame's tracks and cells as laid out now, for the canvas and for
   * dropping into cells. Reads the document; changes nothing.
   */
  grid(frameId: string): GridGeometry | null {
    const frame = this.#doc.get(frameId);
    if (!isLayoutFrame(frame) || !isGrid(frame)) return null;
    const children = this.#children(frame);
    const { cells, rowCount } = placeGridItems(frame, children);
    const { defs, pad, box, columns } = this.#solveGrid(frame, children, cells, rowCount);
    const rows = this.#gridTracks(
      frame,
      children,
      cells,
      "v",
      defs.rows,
      Math.max(0, box.height - pad.top - pad.bottom),
    );
    return {
      columns: trackStarts(columns, getProp(frame.props, "gap"), pad.left),
      rows: trackStarts(rows, getProp(frame.props, "rowGap"), pad.top),
      columnTracks: defs.columns,
      rowTracks: defs.rows,
      cells,
    };
  }

  /** Runs layout for a frame subtree: measure, then arrange. */
  run(frameId: string): void {
    const frame = this.#doc.get(frameId);
    if (!isLayoutFrame(frame)) return;
    this.measure(frame);
    this.arrange(frame);
  }

  /** `set` operations for every box that differs from the document. */
  diff(): Op[] {
    // A group has no position of its own: moving it moves what's in it.
    const moved = new Map<string, { x: number; y: number }>();
    for (const [id, origin] of this.#groupOrigins) {
      const box = this.boxes.get(id);
      if (!box) continue;
      const dx = box.x - origin.x;
      const dy = box.y - origin.y;
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue;
      for (const leaf of positioned(this.#doc, id)) {
        const own = this.boxes.get(leaf);
        if (own) {
          // Laid out too (a layout frame in the group): move its box with the group.
          own.x += dx;
          own.y += dy;
          continue;
        }
        const node = this.#doc.get(leaf);
        if (!node) continue;
        const at = moved.get(leaf) ?? { x: getProp(node.props, "x"), y: getProp(node.props, "y") };
        moved.set(leaf, { x: at.x + dx, y: at.y + dy });
      }
    }
    const ops: Op[] = [];
    for (const [id, axes] of this.#claimed) {
      const node = this.#doc.get(id);
      if (!node) continue;
      const mode = getProp(node.props, "textAutoResize");
      const next =
        axes.has("v") && mode !== "none"
          ? "none"
          : axes.has("h") && mode === "width"
            ? "height"
            : mode;
      if (next !== mode) ops.push({ op: "set", id, prop: "textAutoResize", value: next });
    }
    for (const [id, at] of moved) {
      const node = this.#doc.get(id);
      if (!node) continue;
      if (round2(at.x) !== round2(getProp(node.props, "x")))
        ops.push({ op: "set", id, prop: "x", value: round2(at.x) });
      if (round2(at.y) !== round2(getProp(node.props, "y")))
        ops.push({ op: "set", id, prop: "y", value: round2(at.y) });
    }
    for (const [id, box] of this.boxes) {
      const node = this.#doc.get(id);
      if (!node || node.type === "group") continue;
      for (const prop of ["x", "y", "width", "height"] as const) {
        const value = round2(box[prop]);
        if (value !== round2(getProp(node.props, prop))) ops.push({ op: "set", id, prop, value });
      }
    }
    return ops;
  }
}

/** A grid frame's tracks and cells as they stand, or null for anything else. */
export function gridGeometry(doc: Doc, frameId: string): GridGeometry | null {
  return new LayoutEngine(doc).grid(frameId);
}

/** The cell of a solved grid at a point in the frame's local space, nearest when between tracks. */
export function gridCellAt(
  grid: GridGeometry,
  x: number,
  y: number,
): { column: number; row: number } {
  const nearest = (tracks: readonly { start: number; size: number }[], at: number) => {
    let best = 0;
    let distance = Number.POSITIVE_INFINITY;
    tracks.forEach((t, i) => {
      const d = at < t.start ? t.start - at : at > t.start + t.size ? at - t.start - t.size : 0;
      if (d < distance) {
        distance = d;
        best = i;
      }
    });
    return best;
  };
  return { column: nearest(grid.columns, x), row: nearest(grid.rows, y) };
}

/**
 * The outermost layout frames whose result may change after `ids` changed:
 * walks up from each node while the parent is a layout frame, so a size change
 * deep inside hugging frames reaches the top.
 */
export function layoutRoots(doc: Doc, ids: Iterable<string>): string[] {
  return layoutClosure(doc, ids).roots;
}

/**
 * What a change to `ids` can lay out differently: the outermost layout
 * frames to run (`roots`), and the layout frames on the way up from each
 * change to its root (`dirty`), the changed frames included. `changed`
 * names more layers the change made (constraints, fix-ups): they're laid
 * out inside if they're under a root, without adding roots of their own.
 * A layer in `moved` changed only its position, which moves what's inside
 * it without laying it out again: only its parent's flow can change, and
 * not even that when the flow doesn't place it.
 */
function layoutClosure(
  doc: Doc,
  ids: Iterable<string>,
  moved?: ReadonlySet<string>,
  changed: Iterable<string> = [],
): { roots: string[]; dirty: Set<string> } {
  const roots = new Set<string>();
  const dirty = new Set<string>();
  const walk = (id: string): string | null => {
    let top: string | null = null;
    let node = doc.get(id);
    if (node && moved?.has(id)) {
      if (!inFlow(node)) return null;
    } else if (isLayoutFrame(node)) {
      top = node.id;
      dirty.add(node.id);
    }
    while (node) {
      // Through groups: a group in a flow is as big as what's in it.
      let parent = doc.get(node.parent);
      while (parent?.type === "group") parent = doc.get(parent.parent);
      if (!isLayoutFrame(parent)) break;
      top = parent.id;
      dirty.add(parent.id);
      node = parent;
    }
    return top;
  };
  for (const id of ids) {
    const top = walk(id);
    if (top) roots.add(top);
  }
  for (const id of changed) walk(id);
  // Each root is as far up as layout reaches from where the change was, so a
  // root inside another (an auto layout frame in a plain frame in an auto
  // layout frame) isn't covered by it: both run.
  return { roots: [...roots], dirty };
}

/**
 * Whether a layer's size can come from its parent's layout: it fills, or
 * its parent stretches it, on either axis. When its parent is laid out
 * again, a layout frame like that is laid out inside too, since its size
 * may have changed; any other keeps its insides as they are unless a
 * change was made in it.
 */
function sizeFromParent(doc: Doc, node: NodeRecord): boolean {
  if (node.type === "group" || !inFlow(node)) return false;
  if (sizing(node, "h") === "fill" || sizing(node, "v") === "fill") return true;
  const parent = doc.get(node.parent);
  if (!isLayoutFrame(parent)) return false;
  if (isGrid(parent))
    return (
      stretches(node, "h", cellAlign(parent, node, "h")) ||
      stretches(node, "v", cellAlign(parent, node, "v"))
    );
  const align = crossAlign(parent, node);
  return stretches(node, "h", align) || stretches(node, "v", align);
}

/** One line of an auto layout frame's flow, across. */
export interface FlowLine {
  readonly ids: readonly string[];
  readonly thickness: number;
  /** The layer that makes the line that thick; null when nothing in it does (a single unwrapped line, or one that shares the frame's free space). */
  readonly setBy: string | null;
}

/** A row or column frame's lines as laid out (one, unless it wraps). */
export function flowLines(doc: Doc, frameId: string): FlowLine[] {
  const frame = doc.get(frameId);
  if (!frame || !isLayoutFrame(frame) || isGrid(frame)) return [];
  return new LayoutEngine(doc).lines(frame);
}

/** How CSS should represent a flex frame's distribution to match Drawpane's placement. */
export interface FlexDistribution {
  /** True when Drawpane's placement cannot be expressed with CSS flexbox (negative gaps or per-line centering). */
  readonly bake: boolean;
  readonly justify: "start" | "center" | "end" | "space-between";
  readonly alignContent: "flex-start" | "center" | "flex-end" | "space-between" | null;
}

/** Distribution summary for a row or column flex frame, used by CSS export. */
export function flexDistribution(doc: Doc, frame: NodeRecord): FlexDistribution {
  return new LayoutEngine(doc).flexDistribution(frame);
}

/**
 * Layout fix-up operations to commit alongside an edit that touched `ids`:
 * everything under the outermost layout frames they reach.
 *
 * With `changes`, only what the change can reach (an edit's commit, which
 * starts from a document laid out already): the layout frames from each
 * change up to its outermost layout frame, the layers those place, and
 * inside them the frames their layout sizes (Fill, stretch). A frame that
 * hugs or has a size of its own, with no change in it, keeps what's inside
 * it as it is: laid out already, it would come out the same. `changed`
 * names every layer the edit's operations made so far, `moved` those whose
 * only change was their position (see `layoutClosure`).
 */
export function layoutOps(
  doc: Doc,
  ids: Iterable<string>,
  options: {
    shrinkEmpty?: ReadonlySet<string>;
    keepEmpty?: ReadonlySet<string>;
    changes?: { readonly moved?: ReadonlySet<string>; readonly changed?: Iterable<string> };
  } = {},
): Op[] {
  const { changes } = options;
  const { roots, dirty } = layoutClosure(doc, ids, changes?.moved, changes?.changed);
  if (roots.length === 0) return [];
  const engine = new LayoutEngine(doc, {
    ...(options.shrinkEmpty ? { shrinkEmpty: options.shrinkEmpty } : {}),
    ...(options.keepEmpty ? { keepEmpty: options.keepEmpty } : {}),
    ...(changes
      ? {
          enters: (frame: NodeRecord) => dirty.has(frame.id) || sizeFromParent(doc, frame),
          settled: (frame: NodeRecord) => !dirty.has(frame.id),
        }
      : {}),
  });
  for (const root of roots) engine.run(root);
  return engine.diff();
}

/** Whether a layer's parent's layout sets its size on an axis: it fills, or stretches across. */
function sizedByParent(doc: Doc, node: NodeRecord): boolean {
  const parent = doc.get(node.parent);
  if (!isLayoutFrame(parent) || !inFlow(node)) return false;
  if (isGrid(parent))
    return (["h", "v"] as const).some((axis) =>
      stretches(node, axis, cellAlign(parent, node, axis)),
    );
  const main: Axis = getProp(parent.props, "layoutMode") === "row" ? "h" : "v";
  return (
    sizing(node, main) === "fill" ||
    stretches(node, main === "h" ? "v" : "h", crossAlign(parent, node))
  );
}

/**
 * Lays out the grids in a file made elsewhere (an import), and what hugs
 * them. Such a file's layout is otherwise kept as it was saved, but a grid's
 * saved items can lag what the grid lays out where it was made (Figma lays
 * its grids out as they're shown, from their tracks and their items'
 * content). So each grid is laid out, and inside it what takes its size
 * from it (Fill and stretched layout frames, all the way down; a layer that
 * hugs or has a size of its own is only moved). Then, where that changed the
 * grid's size, the layout frames above it that hug it, up to the first that
 * doesn't (whose layers it places again). Their other layers keep their
 * insides as they were.
 */
export function gridImportOps(doc: Doc): Op[] {
  const grids: NodeRecord[] = [];
  for (const node of doc.nodes()) if (isLayoutFrame(node) && isGrid(node)) grids.push(node);
  if (grids.length === 0) return [];
  // Layout frames in a grid (through anything), and those above a grid that changed.
  const inGrid = new Map<string, boolean>();
  const insideGrid = (node: NodeRecord): boolean => {
    const known = inGrid.get(node.id);
    if (known !== undefined) return known;
    const parent = doc.get(node.parent);
    const is = isGrid(node) || (parent !== undefined && insideGrid(parent));
    inGrid.set(node.id, is);
    return is;
  };
  const above = new Set<string>();
  const engine = new LayoutEngine(doc, {
    enters: (frame) =>
      above.has(frame.id) || isGrid(frame) || (insideGrid(frame) && sizedByParent(doc, frame)),
  });
  for (const grid of grids) engine.run(grid.id);
  const roots = new Set<string>();
  for (const grid of grids) {
    const box = engine.box(grid.id);
    const resized =
      round2(box.width) !== round2(getProp(grid.props, "width")) ||
      round2(box.height) !== round2(getProp(grid.props, "height"));
    if (!resized) continue;
    let node = grid;
    let top: string | null = null;
    while (inFlow(node)) {
      const parent = doc.get(node.parent);
      if (!isLayoutFrame(parent)) break;
      above.add(parent.id);
      top = parent.id;
      if (sizing(parent, "h") !== "hug" && sizing(parent, "v") !== "hug") break;
      node = parent;
    }
    if (top) roots.add(top);
  }
  // Outermost first; a root inside another's run is laid out again there, from the same boxes.
  for (const root of roots) engine.run(root);
  return engine.diff();
}
