/**
 * Auto layout, mapped 1:1 to CSS.
 *
 * Row and column frames are flexbox (`display: flex`, `flex-direction`,
 * `flex-wrap`, `gap`, `padding`, `justify-content`, `align-items`, and per
 * child `flex: 1` for Fill, `fit-content` for Hug, `align-self`,
 * `position: absolute`). Wrapped lines pack at the start, as with
 * `align-content: flex-start`.
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
  readonly hugsMain: boolean;
  readonly wraps: boolean;
  readonly gap: number;
  /** Between wrapped lines. */
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
 * The layers an auto layout frame places, in order: visible, not absolute,
 * and not groups (a group keeps its own place for now). The one rule for
 * layout, X-ray and Explain alike.
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
  return node.type !== "group" && participates(node);
}

function clamp(value: number, min: number | null, max: number | null): number {
  let v = value;
  if (max !== null && v > max) v = max;
  if (min !== null && v < min) v = min;
  return Math.max(0, v);
}

function sizing(node: NodeRecord, axis: Axis) {
  return getProp(node.props, axis === "h" ? "sizingH" : "sizingV");
}

function limits(node: NodeRecord, axis: Axis): [number | null, number | null] {
  return axis === "h"
    ? [getProp(node.props, "minWidth"), getProp(node.props, "maxWidth")]
    : [getProp(node.props, "minHeight"), getProp(node.props, "maxHeight")];
}

function padding(frame: NodeRecord) {
  const p = frame.props;
  return {
    top: getProp(p, "paddingTop"),
    right: getProp(p, "paddingRight"),
    bottom: getProp(p, "paddingBottom"),
    left: getProp(p, "paddingLeft"),
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

  constructor(doc: Doc) {
    this.#doc = doc;
  }

  box(id: string): LayoutBox {
    let box = this.boxes.get(id);
    if (!box) {
      const node = this.#doc.get(id);
      const p = node?.props ?? {};
      box = {
        x: getProp(p, "x"),
        y: getProp(p, "y"),
        width: getProp(p, "width"),
        height: getProp(p, "height"),
      };
      this.boxes.set(id, box);
    }
    return box;
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

  #children(frame: NodeRecord): NodeRecord[] {
    return flowChildren(this.#doc, frame.id);
  }

  /** A frame's layout frame children that its flow doesn't place. */
  #outOfFlow(frame: NodeRecord): NodeRecord[] {
    const out: NodeRecord[] = [];
    for (const id of this.#doc.childIds(frame.id)) {
      const child = this.#doc.get(id);
      if (child && isLayoutFrame(child) && !inFlow(child)) out.push(child);
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

  /** The size a child brings to a line or a track before it stretches. */
  #intrinsic(child: NodeRecord, axis: Axis, stretching: boolean): number {
    return stretching ? (limits(child, axis)[0] ?? 0) : this.#get(child.id, axis);
  }

  /** Bottom-up: settle the size of a hugging layout frame from its content. */
  measure(frame: NodeRecord): void {
    const children = this.#children(frame);
    for (const child of children) if (isLayoutFrame(child)) this.measure(child);
    // Layout frames out of the flow (absolute or hidden) still size themselves
    // and their contents; the flow just doesn't place them.
    for (const child of this.#outOfFlow(frame)) this.run(child.id);
    if (isGrid(frame)) this.#measureGrid(frame, children);
    else this.#measureFlex(frame, children);
  }

  #flexAxes(frame: NodeRecord): FlexAxes {
    const row = getProp(frame.props, "layoutMode") === "row";
    const main: Axis = row ? "h" : "v";
    const cross: Axis = row ? "v" : "h";
    const pad = padding(frame);
    const box = this.box(frame.id);
    const innerMain = Math.max(
      0,
      row ? box.width - pad.left - pad.right : box.height - pad.top - pad.bottom,
    );
    const innerCross = Math.max(
      0,
      row ? box.height - pad.top - pad.bottom : box.width - pad.left - pad.right,
    );
    const hugsMain = sizing(frame, main) === "hug";
    // Wrapping needs a main size to wrap at: a hugging frame never wraps.
    const wraps = getProp(frame.props, "layoutWrap") && !hugsMain;
    return {
      row,
      main,
      cross,
      pad,
      innerMain,
      innerCross,
      hugsMain,
      wraps,
      gap: getProp(frame.props, "gap"),
      lineGap: getProp(frame.props, "rowGap"),
    };
  }

  /** A child's main size before Fill shares out space: Fill starts at its minimum. */
  #basis(child: NodeRecord, main: Axis, hugsMain: boolean): number {
    return this.#intrinsic(child, main, sizing(child, main) === "fill" && !hugsMain);
  }

  /** Breaks children into lines that fit `innerMain` (one line when not wrapping). */
  #lines(children: NodeRecord[], axes: FlexAxes): NodeRecord[][] {
    if (!axes.wraps) return [children];
    const lines: NodeRecord[][] = [];
    let line: NodeRecord[] = [];
    let used = 0;
    for (const child of children) {
      const size = this.#basis(child, axes.main, axes.hugsMain);
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

  /** How thick a wrapped line is across: its thickest child that doesn't stretch to the line. */
  #lineCross(frame: NodeRecord, line: NodeRecord[], cross: Axis): number {
    return line.reduce(
      (m, c) => Math.max(m, this.#intrinsic(c, cross, stretches(c, cross, crossAlign(frame, c)))),
      0,
    );
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
    const thickness = lines.map((line) => this.#lineCross(frame, line, cross));
    if (sizing(frame, cross) === "hug") return thickness;
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
    const lines = this.#lines(this.#children(frame), axes);
    const thickness = this.#thicknesses(frame, lines, axes);
    return lines.map((line, i) => {
      let setBy: NodeRecord | null = null;
      if (axes.wraps)
        for (const c of line) {
          if (stretches(c, axes.cross, crossAlign(frame, c))) continue;
          if (!setBy || this.#get(c.id, axes.cross) > this.#get(setBy.id, axes.cross)) setBy = c;
        }
      return { ids: line.map((c) => c.id), thickness: thickness[i] ?? 0, setBy: setBy?.id ?? null };
    });
  }

  #measureFlex(frame: NodeRecord, children: NodeRecord[]): void {
    const axes = this.#flexAxes(frame);
    const { main, cross } = axes;
    if (axes.hugsMain) {
      const sizes = children.map((c) => this.#get(c.id, main));
      this.#hug(frame, main, total(sizes, axes.gap));
    }
    if (sizing(frame, cross) === "hug") {
      const lines = this.#lines(children, axes);
      const thickness = axes.wraps
        ? lines.map((line) => this.#lineCross(frame, line, cross))
        : [children.reduce((m, c) => Math.max(m, this.#get(c.id, cross)), 0)];
      this.#hug(frame, cross, total(thickness, axes.lineGap));
    }
  }

  /** Top-down: place children of a layout frame whose own size is settled. */
  arrange(frame: NodeRecord): void {
    const children = this.#children(frame);
    if (isGrid(frame)) this.#arrangeGrid(frame, children);
    else this.#arrangeFlex(frame, children);
    for (const child of children) if (isLayoutFrame(child)) this.arrange(child);
  }

  #arrangeFlex(frame: NodeRecord, children: NodeRecord[]): void {
    const axes = this.#flexAxes(frame);
    const { row, main, cross, gap, innerMain, hugsMain, pad } = axes;
    const lines = this.#lines(children, axes);

    // Main axis sizes: in each line, Fill children share what is left (a
    // hugging parent can't be filled).
    for (const line of lines) {
      const fills = line.filter((c) => sizing(c, main) === "fill" && !hugsMain);
      const fixedTotal = line
        .filter((c) => !fills.includes(c))
        .reduce((s, c) => s + this.#get(c.id, main), 0);
      let remaining = innerMain - fixedTotal - gap * Math.max(0, line.length - 1);
      // Distribute, respecting min/max: clamped children drop out and the rest re-share.
      let open = [...fills];
      for (let pass = 0; pass < 4 && open.length > 0; pass++) {
        const share = Math.max(0, remaining) / open.length;
        const next: NodeRecord[] = [];
        let used = 0;
        for (const child of open) {
          const [min, max] = limits(child, main);
          const value = clamp(share, min, max);
          this.#set(child.id, main, value);
          if (value !== share) used += value;
          else next.push(child);
        }
        if (next.length === open.length) break;
        remaining -= used;
        open = next;
      }
    }

    // Cross axis: a single line spans the frame; wrapped lines are as thick as their content.
    const thickness = this.#thicknesses(frame, lines, axes);
    lines.forEach((line, i) => {
      for (const child of line) {
        if (!stretches(child, cross, crossAlign(frame, child))) continue;
        const [min, max] = limits(child, cross);
        this.#set(child.id, cross, clamp(thickness[i] ?? 0, min, max));
      }
    });

    // Children that are layout frames settle their own content first, so a
    // hugging child has its final size before we position it.
    for (const child of children) if (isLayoutFrame(child)) this.measure(child);

    const justify = getProp(frame.props, "justifyContent");
    let crossStart = row ? pad.top : pad.left;
    lines.forEach((line, i) => {
      const lineCross = thickness[i] ?? 0;
      const used = line.reduce((s, c) => s + this.#get(c.id, main), 0);
      const free = innerMain - used - gap * Math.max(0, line.length - 1);
      let offset = row ? pad.left : pad.top;
      let spacing = gap;
      if (justify === "center") offset += free / 2;
      else if (justify === "end") offset += free;
      else if (justify === "space-between" && line.length > 1) {
        spacing = gap + Math.max(0, free) / (line.length - 1);
      }
      for (const child of line) {
        const b = this.box(child.id);
        const size = this.#get(child.id, cross);
        const align = crossAlign(frame, child);
        let crossPos = crossStart;
        if (align === "center") crossPos += (lineCross - size) / 2;
        else if (align === "end") crossPos += lineCross - size;
        if (row) {
          b.x = offset;
          b.y = crossPos;
        } else {
          b.x = crossPos;
          b.y = offset;
        }
        offset += this.#get(child.id, main) + spacing;
      }
      crossStart += lineCross + axes.lineGap;
    });
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
    const items = children.map((child) => {
      const cell = cells.get(child.id) as GridCell;
      return {
        start: axis === "h" ? cell.column : cell.row,
        span: axis === "h" ? cell.columnSpan : cell.rowSpan,
        size: this.#intrinsic(child, axis, stretches(child, axis, cellAlign(frame, child, axis))),
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
    const { cells, rowCount } = placeGridItems(frame, children);
    const defs = this.#gridDefs(frame, rowCount);
    if (sizing(frame, "h") === "hug") {
      const sizes = this.#gridTracks(frame, children, cells, "h", defs.columns, null);
      this.#hug(frame, "h", total(sizes, getProp(frame.props, "gap")));
    }
    if (sizing(frame, "v") === "hug") {
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
      const [min, max] = limits(child, "h");
      this.#set(
        child.id,
        "h",
        clamp(span(columns, cell.column, cell.columnSpan, columnGap), min, max),
      );
    }
    for (const child of children) if (isLayoutFrame(child)) this.measure(child);

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
      const [min, max] = limits(child, "v");
      this.#set(child.id, "v", clamp(span(rows, cell.row, cell.rowSpan, rowGap), min, max));
    }
    for (const child of children) if (isLayoutFrame(child)) this.measure(child);

    const columnTracks = trackStarts(columns, columnGap, pad.left);
    const rowTracks = trackStarts(rows, rowGap, pad.top);
    for (const child of children) {
      const cell = cells.get(child.id) as GridCell;
      const b = this.box(child.id);
      const place = (axis: Axis, start: number, area: number) => {
        const size = this.#get(child.id, axis);
        const align = cellAlign(frame, child, axis);
        if (align === "center") return start + (area - size) / 2;
        if (align === "end") return start + area - size;
        return start;
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
    const ops: Op[] = [];
    for (const [id, box] of this.boxes) {
      const node = this.#doc.get(id);
      if (!node) continue;
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
  const roots = new Set<string>();
  for (const id of ids) {
    let top: string | null = null;
    let node = doc.get(id);
    if (isLayoutFrame(node)) top = node.id;
    while (node) {
      const parent = doc.get(node.parent);
      if (!isLayoutFrame(parent)) break;
      top = parent.id;
      node = parent;
    }
    if (top) roots.add(top);
  }
  // Drop roots nested in other roots.
  return [...roots].filter((id) => !doc.ancestors(id).some((a) => roots.has(a.id)));
}

/** Layout fix-up operations to commit alongside an edit that touched `ids`. */
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

export function layoutOps(doc: Doc, ids: Iterable<string>): Op[] {
  const roots = layoutRoots(doc, ids);
  if (roots.length === 0) return [];
  const engine = new LayoutEngine(doc);
  for (const root of roots) engine.run(root);
  return engine.diff();
}
