/**
 * Figma's auto layout, constraints and layout grids as Drawpane's. Both
 * model auto layout on CSS flexbox and grid, so most of it is a rename.
 */
import type { LayoutGrid } from "@drawpane/model";
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
    if (own === "HORIZONTAL") {
      h ??= primaryHug ? "hug" : undefined;
      v ??= counterHug ? "hug" : undefined;
    } else if (own === "VERTICAL") {
      v ??= primaryHug ? "hug" : undefined;
      h ??= counterHug ? "hug" : undefined;
    }
    if (parentMode === "HORIZONTAL") {
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
  if (parentMode && node.layoutPositioning === "ABSOLUTE") props.positioning = "absolute";
  const ch = pick(CONSTRAINT, node.constraints?.horizontal);
  const cv = pick(CONSTRAINT, node.constraints?.vertical);
  if (ch && ch !== "start") props.constraintH = ch;
  if (cv && cv !== "start") props.constraintV = cv;
  if (node.preserveRatio) props.lockAspect = true;
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
