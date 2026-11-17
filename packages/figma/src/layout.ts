/**
 * Figma's auto layout, constraints and layout grids as Drawpane's. Both
 * model auto layout on CSS flexbox and grid, so most of it is a rename.
 */
import type { GridTrack, LayoutGrid } from "@drawpane/model";
import { hexColor } from "./paint";
import type * as Figma from "./rest";

type Props = Record<string, unknown>;
const round2 = (n: number) => Math.round(n * 100) / 100;

const JUSTIFY = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  SPACE_BETWEEN: "space-between",
} as const;
const ALIGN = { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "baseline" } as const;
const SIZING = { FIXED: "fixed", HUG: "hug", FILL: "fill" } as const;
const CONSTRAINT = {
  MIN: "start",
  LEFT: "start",
  TOP: "start",
  MAX: "end",
  RIGHT: "end",
  BOTTOM: "end",
  CENTER: "center",
  STRETCH: "stretch",
  LEFT_RIGHT: "stretch",
  TOP_BOTTOM: "stretch",
  SCALE: "scale",
} as const;

const pick = <T extends Record<string, string>>(
  map: T,
  key: string | undefined,
): T[keyof T] | undefined => (key !== undefined && key in map ? map[key as keyof T] : undefined);

/** Drawpane takes up to 64 tracks a side. */
const MAX_TRACKS = 64;

/** One CSS track: "32px", "1fr", "auto", or minmax() of them, which sizes as its maximum. */
function parseTrack(text: string): GridTrack | null {
  const t = text.trim().toLowerCase();
  const minmax = t.match(/^minmax\((.*),(.*)\)$/);
  if (minmax) return parseTrack(minmax[2] as string);
  if (t === "auto" || t === "min-content" || t === "max-content") return { unit: "auto" };
  const m = t.match(/^(\d+(?:\.\d+)?|\.\d+)(px|fr)?$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (m[2] === "fr") return value > 0 ? { unit: "fr", value: Math.min(1000, value) } : null;
  return { unit: "px", value };
}

/**
 * A CSS track list, as Figma's REST API writes a grid's rows and columns:
 * "32px 118px 1fr", with repeat(n, …) and minmax(a, b). Null when a part isn't a track.
 */
export function parseTrackList(text: string | undefined): GridTrack[] | null {
  if (!text) return null;
  let rest = text;
  // Innermost first, so a repeat() holding minmax() reads whole.
  const repeat = /repeat\(\s*(\d+)\s*,\s*((?:[^()]|\([^()]*\))+)\)/i;
  for (let m = rest.match(repeat); m; m = rest.match(repeat)) {
    const n = Math.min(MAX_TRACKS, Number(m[1]));
    rest = rest.replace(
      m[0],
      ` ${Array.from({ length: n }, () => (m?.[2] ?? "").trim()).join(" ")} `,
    );
  }
  const tracks: GridTrack[] = [];
  // Parts split at spaces outside parentheses.
  for (const part of rest.match(/[^\s()]+(?:\([^()]*\))?/g) ?? []) {
    const track = parseTrack(part);
    if (!track) return null;
    tracks.push(track);
  }
  return tracks.length > 0 ? tracks.slice(0, MAX_TRACKS) : null;
}

/** A frame's own auto layout: direction, wrap, gaps, padding and alignment. */
export function containerLayout(node: Figma.Node): Props {
  const mode = node.layoutMode;
  if (!mode || mode === "NONE") return {};
  const props: Props = {
    layoutMode: mode === "HORIZONTAL" ? "row" : mode === "VERTICAL" ? "column" : "grid",
    paddingTop: round2(Math.max(0, node.paddingTop ?? 0)),
    paddingRight: round2(Math.max(0, node.paddingRight ?? 0)),
    paddingBottom: round2(Math.max(0, node.paddingBottom ?? 0)),
    paddingLeft: round2(Math.max(0, node.paddingLeft ?? 0)),
    gap: round2(node.itemSpacing ?? 0),
  };
  if (props.layoutMode === "grid") {
    // Items sit at the start of their cells unless they say otherwise, as in Figma.
    props.gap = round2(node.gridColumnGap ?? 0);
    props.rowGap = round2(node.gridRowGap ?? 0);
    const columns = parseTrackList(node.gridColumnsSizing);
    const rows = parseTrackList(node.gridRowsSizing);
    if (columns) props.gridColumns = columns;
    if (rows) props.gridRows = rows;
    return props;
  }
  if (node.layoutWrap === "WRAP") {
    props.layoutWrap = true;
    props.rowGap = round2(node.counterAxisSpacing ?? 0);
  }
  const justify = pick(JUSTIFY, node.primaryAxisAlignItems);
  if (justify) props.justifyContent = justify;
  const align = pick(ALIGN, node.counterAxisAlignItems);
  if (align) props.alignItems = align;
  return props;
}

/**
 * How a layer sizes and places itself: hug, fill or fixed on each axis (in
 * Figma's newer terms, or worked out from the older ones), its limits,
 * absolute placement in an auto layout, and constraints.
 */
export function childLayout(node: Figma.Node, parent: Figma.Node | undefined): Props {
  const props: Props = {};
  const parentMode = parent?.layoutMode && parent.layoutMode !== "NONE" ? parent.layoutMode : null;
  let h = pick(SIZING, node.layoutSizingHorizontal);
  let v = pick(SIZING, node.layoutSizingVertical);
  if (!h || !v) {
    // Older files: a frame's own sizing modes, and a child's grow and stretch in its parent.
    const own = node.layoutMode && node.layoutMode !== "NONE" ? node.layoutMode : null;
    const primaryHug = own && node.primaryAxisSizingMode === "AUTO";
    const counterHug = own && node.counterAxisSizingMode === "AUTO";
    if (own === "HORIZONTAL" || own === "GRID") {
      h ??= primaryHug ? "hug" : undefined;
      v ??= counterHug ? "hug" : undefined;
    } else if (own === "VERTICAL") {
      v ??= primaryHug ? "hug" : undefined;
      h ??= counterHug ? "hug" : undefined;
    }
    // A grid's item grows across and stretches down its cells, as in a row.
    if (parentMode === "HORIZONTAL" || parentMode === "GRID") {
      if (node.layoutGrow === 1) h ??= "fill";
      if (node.layoutAlign === "STRETCH") v ??= "fill";
    } else if (parentMode === "VERTICAL") {
      if (node.layoutGrow === 1) v ??= "fill";
      if (node.layoutAlign === "STRETCH") h ??= "fill";
    }
  }
  if (h && h !== "fixed") props.sizingH = h;
  if (v && v !== "fixed") props.sizingV = v;
  for (const key of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) {
    const value = node[key];
    if (typeof value === "number" && value >= 0) props[key] = round2(value);
  }
  if (parentMode === "GRID" && v === "fill" && node.type !== "TEXT" && !hugsDown(node)) {
    // A frame whose own height is fixed, filling its grid cells: Figma's row is never shorter
    // than that height (a hugging one is sized by its content alone).
    const height = round2(Math.max(0, node.size?.y ?? 0));
    const min = props.minHeight;
    if (typeof min !== "number" || min < height) props.minHeight = height;
  }
  if (parentMode && node.layoutPositioning === "ABSOLUTE") props.positioning = "absolute";
  if (parentMode === "GRID") Object.assign(props, gridItem(node));
  const ch = pick(CONSTRAINT, node.constraints?.horizontal);
  const cv = pick(CONSTRAINT, node.constraints?.vertical);
  if (ch && ch !== "start") props.constraintH = ch;
  if (cv && cv !== "start") props.constraintV = cv;
  if (node.preserveRatio) props.lockAspect = true;
  return props;
}

/** Whether a frame's own auto layout hugs its content down (whatever its parent makes of it). */
function hugsDown(node: Figma.Node): boolean {
  if (node.layoutMode === "VERTICAL") return node.primaryAxisSizingMode === "AUTO";
  if (node.layoutMode === "HORIZONTAL" || node.layoutMode === "GRID")
    return node.counterAxisSizingMode === "AUTO";
  return false;
}

const CELL_ALIGN = { MIN: "start", CENTER: "center", MAX: "end" } as const;
/** Drawpane's grid lines and spans go up to 256. */
const MAX_LINE = 256;

/** Where a grid's item sits: its cells (when anchored; otherwise it flows) and its alignment in them. */
function gridItem(node: Figma.Node): Props {
  const props: Props = {};
  const row = node.gridRowAnchorIndex;
  const column = node.gridColumnAnchorIndex;
  if (typeof row === "number" && typeof column === "number" && row >= 0 && column >= 0) {
    const line = (n: number) => Math.min(MAX_LINE, Math.max(1, Math.round(n)));
    props.gridArea = {
      column: line(column + 1),
      row: line(row + 1),
      columnSpan: line(node.gridColumnSpan ?? 1),
      rowSpan: line(node.gridRowSpan ?? 1),
    };
  }
  const justify = pick(CELL_ALIGN, node.gridChildHorizontalAlign);
  if (justify) props.justifySelf = justify;
  const align = pick(CELL_ALIGN, node.gridChildVerticalAlign);
  if (align) props.alignSelf = align;
  return props;
}

const GRID_ALIGN = { MIN: "start", STRETCH: "stretch", CENTER: "center", MAX: "end" } as const;

export function layoutGrids(grids: readonly Figma.LayoutGrid[] | undefined): LayoutGrid[] {
  const out: LayoutGrid[] = [];
  for (const g of grids ?? []) {
    const color = g.color ? hexColor(g.color) : "#ff000019";
    const visible = g.visible === false ? { visible: false } : {};
    if (g.pattern === "GRID") {
      out.push({
        type: "grid",
        size: Math.min(10_000, Math.max(1, g.sectionSize ?? 10)),
        color,
        ...visible,
      });
      continue;
    }
    out.push({
      type: g.pattern === "COLUMNS" ? "columns" : "rows",
      count: Math.min(100, Math.max(1, Math.round(g.count ?? 1))),
      gutter: Math.max(0, g.gutterSize ?? 0),
      margin: Math.max(0, g.offset ?? 0),
      alignment: pick(GRID_ALIGN, g.alignment) ?? "stretch",
      size: Math.max(0, g.sectionSize ?? 0),
      color,
      ...visible,
    });
  }
  return out.slice(0, 16);
}
