/**
 * Layout X-ray: an auto layout frame's padding and gaps as regions, while
 * Alt is held. The overlay draws them, and dragging one changes it (drag the
 * top padding down to grow it, a gap sideways to widen it), so what's shown
 * is what can be grabbed: both read the same regions from here.
 */
import { getProp } from "@drawpane/model";
import type { Editor } from "./editor";
import { type ExplainAxis, sizeMode } from "./explain";
import type { Point, Rect } from "./geometry";
import { type GridGeometry, gridGeometry } from "./layout";

export type XrayProp =
  | "paddingTop"
  | "paddingRight"
  | "paddingBottom"
  | "paddingLeft"
  | "gap"
  | "rowGap";

export interface XrayRegion {
  readonly frameId: string;
  readonly prop: XrayProp;
  /** In the frame's own box. */
  readonly rect: Rect;
  /** Dragging along this axis, in this direction, makes the value bigger. */
  readonly axis: "x" | "y";
  readonly sign: 1 | -1;
  readonly kind: "padding" | "gap";
}

/** The frames X-ray shows: each selected or hovered auto layout frame, or the one a layer sits in. */
export function xrayFrames(editor: Editor): string[] {
  const { selection, hover } = editor.s;
  const out = new Set<string>();
  for (const id of new Set([...selection, ...(hover ? [hover] : [])])) {
    const node = editor.doc.get(id);
    const frameId = node?.type === "frame" ? id : node?.parent;
    const frame = frameId ? editor.doc.get(frameId) : undefined;
    if (frame?.type === "frame" && getProp(frame.props, "layoutMode") !== "none") out.add(frame.id);
  }
  return [...out];
}

/**
 * The frame whose padding and gaps make up an explained size: the layer
 * itself when it hugs, its parent when it fills, none when it's set by hand.
 */
export function explainedFrame(editor: Editor, id: string, axis: ExplainAxis): string | null {
  const node = editor.doc.get(id);
  if (!node) return null;
  const mode = sizeMode(editor.doc, id, axis);
  const frameId = mode === "hug" ? id : mode === "fill" ? node.parent : null;
  const frame = frameId ? editor.doc.get(frameId) : undefined;
  return frame?.type === "frame" && getProp(frame.props, "layoutMode") !== "none" ? frame.id : null;
}

/** A frame's padding and gap regions. */
export function xrayRegions(editor: Editor, frameId: string): XrayRegion[] {
  const doc = editor.doc;
  const frame = doc.get(frameId);
  if (frame?.type !== "frame") return [];
  const p = frame.props;
  const mode = getProp(p, "layoutMode");
  if (mode === "none") return [];
  const w = getProp(p, "width");
  const h = getProp(p, "height");
  const top = getProp(p, "paddingTop");
  const right = getProp(p, "paddingRight");
  const bottom = getProp(p, "paddingBottom");
  const left = getProp(p, "paddingLeft");
  const out: XrayRegion[] = [];
  const add = (
    prop: XrayProp,
    rect: Rect,
    axis: "x" | "y",
    sign: 1 | -1,
    kind: "padding" | "gap",
  ) => {
    if (rect.width > 0 && rect.height > 0) out.push({ frameId, prop, rect, axis, sign, kind });
  };
  add("paddingTop", { x: 0, y: 0, width: w, height: top }, "y", 1, "padding");
  add("paddingBottom", { x: 0, y: h - bottom, width: w, height: bottom }, "y", -1, "padding");
  add("paddingLeft", { x: 0, y: top, width: left, height: h - top - bottom }, "x", 1, "padding");
  add(
    "paddingRight",
    { x: w - right, y: top, width: right, height: h - top - bottom },
    "x",
    -1,
    "padding",
  );

  if (mode === "grid") {
    // Gaps between tracks, across the whole content box.
    const grid = solvedGrid(editor, frameId);
    if (!grid) return out;
    const between = (tracks: readonly { start: number; size: number }[]) =>
      tracks.slice(1).map((t, i) => {
        const prev = tracks[i] as { start: number; size: number };
        return { at: prev.start + prev.size, size: t.start - prev.start - prev.size };
      });
    for (const g of between(grid.columns))
      add("gap", { x: g.at, y: top, width: g.size, height: h - top - bottom }, "x", 1, "gap");
    for (const g of between(grid.rows))
      add("rowGap", { x: left, y: g.at, width: w - left - right, height: g.size }, "y", 1, "gap");
    return out;
  }

  // Gaps between consecutive children along the flow, across the band the
  // two share (wrapped lines each have their own); between lines, the line gap.
  const row = mode === "row";
  const wrapped = getProp(p, "layoutWrap");
  const children = doc
    .childIds(frameId)
    .map((id) => doc.get(id))
    .filter((c) => c && getProp(c.props, "visible") && getProp(c.props, "positioning") === "auto");
  const box = (id: number) => {
    const c = children[id]?.props;
    return c
      ? { x: getProp(c, "x"), y: getProp(c, "y"), w: getProp(c, "width"), h: getProp(c, "height") }
      : null;
  };
  for (let i = 0; i < children.length - 1; i++) {
    const a = box(i);
    const b = box(i + 1);
    if (!a || !b) continue;
    if (row) {
      // A wrap starts a new line: the space between lines is the line gap.
      if (wrapped && b.x < a.x + a.w) {
        add(
          "rowGap",
          { x: left, y: a.y + a.h, width: w - left - right, height: b.y - a.y - a.h },
          "y",
          1,
          "gap",
        );
        continue;
      }
      const y0 = wrapped ? Math.min(a.y, b.y) : top;
      const y1 = wrapped ? Math.max(a.y + a.h, b.y + b.h) : h - bottom;
      add("gap", { x: a.x + a.w, y: y0, width: b.x - a.x - a.w, height: y1 - y0 }, "x", 1, "gap");
    } else {
      if (wrapped && b.y < a.y + a.h) {
        add(
          "rowGap",
          { x: a.x + a.w, y: top, width: b.x - a.x - a.w, height: h - top - bottom },
          "x",
          1,
          "gap",
        );
        continue;
      }
      const x0 = wrapped ? Math.min(a.x, b.x) : left;
      const x1 = wrapped ? Math.max(a.x + a.w, b.x + b.w) : w - right;
      add("gap", { x: x0, y: a.y + a.h, width: x1 - x0, height: b.y - a.y - a.h }, "y", 1, "gap");
    }
  }
  return out;
}

/** The X-ray region under a page point, gaps first (they sit between padding). */
export function xrayRegionAt(editor: Editor, page: Point): XrayRegion | null {
  let found: XrayRegion | null = null;
  for (const frameId of xrayFrames(editor)) {
    const local = editor.scene.toLocal(frameId, page);
    for (const region of xrayRegions(editor, frameId)) {
      const { x, y, width, height } = region.rect;
      if (local.x < x || local.y < y || local.x > x + width || local.y > y + height) continue;
      if (region.kind === "gap") return region;
      found ??= region;
    }
  }
  return found;
}

/** What a region is called in history and in the label next to it. */
export function xrayLabel(region: XrayRegion): string {
  return region.kind === "gap" ? (region.prop === "rowGap" ? "Line gap" : "Gap") : "Padding";
}

/** Solved grids, per document and version: the overlay repaints on every pointer move. */
const solvedGrids = new WeakMap<
  object,
  { version: number; grids: Map<string, GridGeometry | null> }
>();

export function solvedGrid(editor: Editor, frameId: string): GridGeometry | null {
  let entry = solvedGrids.get(editor.doc);
  if (!entry || entry.version !== editor.doc.version) {
    entry = { version: editor.doc.version, grids: new Map() };
    solvedGrids.set(editor.doc, entry);
  }
  if (!entry.grids.has(frameId)) entry.grids.set(frameId, gridGeometry(editor.doc, frameId));
  return entry.grids.get(frameId) ?? null;
}
