/**
 * Penpot flex and grid layout to Drawpane auto layout. Two differences to
 * mind: Penpot's flex flows in reverse layer order (the topmost layer comes
 * first) unless the direction is reversed, while Drawpane flows in layer
 * order; and Penpot's row gap is between rows whatever the direction, while
 * Drawpane's `gap` runs along the main axis.
 */
import type { GridArea, GridTrack } from "@drawpane/model";
import type { Notes } from "./notes";
import { num } from "./styles";

type Raw = Record<string, unknown>;

/**
 * The order Drawpane should keep a frame's children in (bottom first),
 * from Penpot's `shapes` (bottom first): reversed for a forward flex, so
 * the flow comes out the same.
 */
export function childOrder(frame: Raw, shapes: readonly string[]): string[] {
  if (frame.layout === "flex") {
    const dir = String(frame.layoutFlexDir ?? "row");
    const reversed =
      dir === "row-reverse" || dir === "column-reverse" || dir.startsWith("reverse-");
    return reversed ? [...shapes] : [...shapes].reverse();
  }
  return [...shapes];
}

const JUSTIFY: Record<string, string> = {
  start: "start",
  center: "center",
  end: "end",
  "space-between": "space-between",
  "space-around": "space-between",
  "space-evenly": "space-between",
  stretch: "start",
};
const ALIGN: Record<string, string> = {
  start: "start",
  center: "center",
  end: "end",
  stretch: "stretch",
};

function padding(frame: Raw): Record<string, number> {
  const p = (frame.layoutPadding ?? {}) as Raw;
  const top = Math.max(0, num(p.p1));
  const right = Math.max(0, num(p.p2));
  // "simple" padding mirrors the first two sides.
  const simple = frame.layoutPaddingType === "simple";
  const bottom = simple ? top : Math.max(0, num(p.p3));
  const left = simple ? right : Math.max(0, num(p.p4));
  const out: Record<string, number> = {};
  if (top) out.paddingTop = top;
  if (right) out.paddingRight = right;
  if (bottom) out.paddingBottom = bottom;
  if (left) out.paddingLeft = left;
  return out;
}

function track(t: Raw, notes: Notes): GridTrack {
  const value = num(t.value, 1);
  switch (t.type) {
    case "fixed":
      return { unit: "px", value: Math.max(0, value) };
    case "flex":
      return { unit: "fr", value: Math.min(1000, Math.max(0.01, value)) };
    case "percent":
      notes.add("grid-percent");
      return { unit: "fr", value: Math.min(1000, Math.max(0.01, value)) };
    default:
      return { unit: "auto" };
  }
}

/** A frame's own layout props. */
export function containerLayout(frame: Raw, notes: Notes): Record<string, unknown> {
  if (frame.layout !== "flex" && frame.layout !== "grid") return {};
  const gaps = (frame.layoutGap ?? {}) as Raw;
  const rowGap = num(gaps.rowGap);
  const columnGap = num(gaps.columnGap);
  const out: Record<string, unknown> = { ...padding(frame) };
  const justify = String(frame.layoutJustifyContent ?? "start");
  if (justify === "space-around" || justify === "space-evenly") notes.add("layout-spacing");
  const justifyContent = JUSTIFY[justify] ?? "start";
  if (justifyContent !== "start") out.justifyContent = justifyContent;
  const alignItems = ALIGN[String(frame.layoutAlignItems ?? "start")] ?? "start";
  if (alignItems !== "start") out.alignItems = alignItems;
  if (frame.layout === "flex") {
    const column = String(frame.layoutFlexDir ?? "row").includes("column");
    out.layoutMode = column ? "column" : "row";
    // Along the flow, then between wrapped lines.
    const main = column ? rowGap : columnGap;
    const cross = column ? columnGap : rowGap;
    if (main) out.gap = main;
    if (frame.layoutWrapType === "wrap") {
      out.layoutWrap = true;
      if (cross) out.rowGap = cross;
    }
    return out;
  }
  out.layoutMode = "grid";
  if (columnGap) out.gap = columnGap;
  if (rowGap) out.rowGap = rowGap;
  const columns = Array.isArray(frame.layoutGridColumns) ? (frame.layoutGridColumns as Raw[]) : [];
  const rows = Array.isArray(frame.layoutGridRows) ? (frame.layoutGridRows as Raw[]) : [];
  if (columns.length > 0) out.gridColumns = columns.slice(0, 64).map((t) => track(t, notes));
  if (rows.length > 0) out.gridRows = rows.slice(0, 64).map((t) => track(t, notes));
  const justifyItems = ALIGN[String(frame.layoutJustifyItems ?? "start")] ?? "start";
  if (justifyItems !== "start") out.justifyItems = justifyItems;
  return out;
}

/** Where each child of a grid frame sits, from its cells. */
export function gridAreas(frame: Raw): Map<string, GridArea> {
  const out = new Map<string, GridArea>();
  if (frame.layout !== "grid") return out;
  const cells = (frame.layoutGridCells ?? {}) as Record<string, Raw>;
  const line = (n: unknown) => Math.min(256, Math.max(1, Math.round(num(n, 1))));
  for (const cell of Object.values(cells)) {
    if (cell.position === "auto") continue;
    const shapes = Array.isArray(cell.shapes) ? (cell.shapes as string[]) : [];
    for (const id of shapes)
      out.set(id, {
        column: line(cell.column),
        row: line(cell.row),
        columnSpan: line(cell.columnSpan),
        rowSpan: line(cell.rowSpan),
      });
  }
  return out;
}

const SIZING: Record<string, string> = { fill: "fill", fix: "fixed", auto: "hug" };
const SELF: Record<string, string> = {
  start: "start",
  center: "center",
  end: "end",
  stretch: "stretch",
};

/** A child's layout props, when its parent frame has a layout. */
export function childLayout(shape: Raw, notes: Notes): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const h = SIZING[String(shape.layoutItemHSizing)];
  const v = SIZING[String(shape.layoutItemVSizing)];
  if (h && h !== "fixed") out.sizingH = h;
  if (v && v !== "fixed") out.sizingV = v;
  if (shape.layoutItemAbsolute === true) out.positioning = "absolute";
  const self = SELF[String(shape.layoutItemAlignSelf)];
  if (self) out.alignSelf = self;
  for (const [from, to] of [
    ["layoutItemMinW", "minWidth"],
    ["layoutItemMaxW", "maxWidth"],
    ["layoutItemMinH", "minHeight"],
    ["layoutItemMaxH", "maxHeight"],
  ] as const) {
    const value = shape[from];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[to] = value;
  }
  const m = (shape.layoutItemMargin ?? {}) as Raw;
  if (["m1", "m2", "m3", "m4"].some((k) => num(m[k]) !== 0)) notes.add("layout-margins");
  return out;
}
