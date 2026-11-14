/**
 * Layout grids and ruler guides: where their lines fall, in frame or page
 * coordinates. Pure geometry, shared by the overlay that draws them, the
 * snapping that uses them and the rulers that place them.
 */
import { getProp, type LayoutGrid, type NodeRecord, type RulerGuide } from "@drawpane/model";
import type { Doc } from "./doc";
import { apply, type Matrix, type Point } from "./geometry";
import type { Scene } from "./scene";

/** A column or row of a layout grid, as a span on its axis in the frame's local box. */
export interface Track {
  readonly start: number;
  readonly size: number;
}

/** The default grids, like Figma's: 12 columns or rows with 20px margins and gutters, or an 8px grid. */
export function defaultLayoutGrid(type: LayoutGrid["type"]): LayoutGrid {
  if (type === "grid") return { type, size: 8, color: "#ff00001a" };
  return {
    type,
    count: type === "columns" ? 12 : 8,
    gutter: 20,
    margin: 20,
    alignment: "stretch",
    size: 64,
    color: "#ff00001a",
  };
}

/** The tracks of a columns or rows grid for a frame `extent` wide (columns) or tall (rows). */
export function gridTracks(
  grid: Extract<LayoutGrid, { type: "columns" | "rows" }>,
  extent: number,
): Track[] {
  const { count, gutter, margin, alignment } = grid;
  let size = grid.size;
  let start: number;
  if (alignment === "stretch") {
    size = Math.max(0, (extent - 2 * margin - gutter * (count - 1)) / count);
    start = margin;
  } else {
    const total = count * size + (count - 1) * gutter;
    start =
      alignment === "start"
        ? margin
        : alignment === "end"
          ? extent - margin - total
          : (extent - total) / 2;
  }
  const out: Track[] = [];
  for (let i = 0; i < count; i++) out.push({ start: start + i * (size + gutter), size });
  return out;
}

/** Positions of a square grid's lines across `extent`, starting at 0. */
export function gridLines(size: number, extent: number, limit = 2_000): number[] {
  if (size <= 0) return [];
  const out: number[] = [];
  for (let at = size; at < extent && out.length < limit; at += size) out.push(at);
  return out;
}

/** A frame's visible layout grids. */
export function visibleGrids(node: NodeRecord): LayoutGrid[] {
  if (node.type !== "frame") return [];
  return getProp(node.props, "layoutGrids").filter((g) => g.visible !== false);
}

/**
 * The edges a layer snaps to inside a frame's layout grids, in page
 * coordinates: column edges on x, row edges on y, a square grid's lines both
 * ways. Only for unrotated frames,
 * where a local edge is a page line.
 */
export function gridSnapLines(
  scene: Scene,
  frameId: string,
): Array<{ axis: "x" | "y"; at: number }> {
  const node = scene.doc.get(frameId);
  if (node?.type !== "frame") return [];
  const m = scene.worldMatrix(frameId);
  if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9) return [];
  const width = getProp(node.props, "width");
  const height = getProp(node.props, "height");
  const out: Array<{ axis: "x" | "y"; at: number }> = [];
  for (const grid of visibleGrids(node)) {
    if (grid.type === "grid") {
      // A square grid's lines, both ways (capped, so a fine grid on a huge frame stays cheap).
      for (const t of gridLines(grid.size, width, 1_000))
        out.push({ axis: "x", at: m[4] + t * m[0] });
      for (const t of gridLines(grid.size, height, 1_000))
        out.push({ axis: "y", at: m[5] + t * m[3] });
      continue;
    }
    const axis = grid.type === "columns" ? "x" : "y";
    const origin = axis === "x" ? m[4] : m[5];
    const scale = axis === "x" ? m[0] : m[3];
    for (const t of gridTracks(grid, axis === "x" ? width : height)) {
      out.push(
        { axis, at: origin + t.start * scale },
        { axis, at: origin + (t.start + t.size) * scale },
      );
    }
  }
  return out;
}

/** A guide placed on the page: its owner, its index there, and its line in page coordinates. */
export interface PlacedGuide {
  readonly owner: string;
  readonly index: number;
  readonly axis: "x" | "y";
  /** Page coordinate of the line on its axis. */
  readonly at: number;
  /** The line's extent across the other axis in page coordinates; null for page guides (endless). */
  readonly span: { readonly from: number; readonly to: number } | null;
}

/** The owner's matrix if it is unrotated (frame guides need straight lines on the page). */
function straight(m: Matrix): boolean {
  return Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;
}

/**
 * Every guide on a page: the page's own, and those of its top-level frames
 * (frame guides are in the frame's coordinates and span the frame).
 */
export function placedGuides(scene: Scene, pageId: string): PlacedGuide[] {
  const doc: Doc = scene.doc;
  const page = doc.get(pageId);
  if (!page) return [];
  const out: PlacedGuide[] = getProp(page.props, "rulerGuides").map((g, index) => ({
    owner: pageId,
    index,
    axis: g.axis,
    at: g.offset,
    span: null,
  }));
  for (const id of doc.childIds(pageId)) {
    const node = doc.get(id);
    if (node?.type !== "frame" || node.props.visible === false) continue;
    const guides = getProp(node.props, "rulerGuides");
    if (guides.length === 0) continue;
    const m = scene.worldMatrix(id);
    if (!straight(m)) continue;
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const tl = apply(m, { x: 0, y: 0 });
    const br = apply(m, { x: w, y: h });
    guides.forEach((g, index) => {
      const p = apply(m, g.axis === "x" ? { x: g.offset, y: 0 } : { x: 0, y: g.offset });
      out.push({
        owner: id,
        index,
        axis: g.axis,
        at: g.axis === "x" ? p.x : p.y,
        span:
          g.axis === "x"
            ? { from: Math.min(tl.y, br.y), to: Math.max(tl.y, br.y) }
            : { from: Math.min(tl.x, br.x), to: Math.max(tl.x, br.x) },
      });
    });
  }
  return out;
}

/** The guide whose line passes within `tolerance` page units of `p`, nearest first. */
export function guideAt(
  guides: readonly PlacedGuide[],
  p: Point,
  tolerance: number,
): PlacedGuide | null {
  let best: PlacedGuide | null = null;
  let bestD = tolerance;
  for (const g of guides) {
    const along = g.axis === "x" ? p.y : p.x;
    if (g.span && (along < g.span.from - tolerance || along > g.span.to + tolerance)) continue;
    const d = Math.abs((g.axis === "x" ? p.x : p.y) - g.at);
    if (d <= bestD) {
      best = g;
      bestD = d;
    }
  }
  return best;
}

/**
 * Who owns a guide dropped at page point `p`: the top-level frame under it
 * (unrotated, so the guide stays straight), else the page. Returns the
 * offset in the owner's coordinates.
 */
export function guideOwnerAt(
  scene: Scene,
  pageId: string,
  axis: "x" | "y",
  p: Point,
): { owner: string; offset: number } {
  const doc = scene.doc;
  const top = doc.childIds(pageId);
  for (let i = top.length - 1; i >= 0; i--) {
    const id = top[i] as string;
    const node = doc.get(id);
    if (node?.type !== "frame" || node.props.visible === false) continue;
    const m = scene.worldMatrix(id);
    if (!straight(m)) continue;
    const local = scene.toLocal(id, p);
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    if (local.x >= 0 && local.y >= 0 && local.x <= w && local.y <= h)
      return { owner: id, offset: Math.round((axis === "x" ? local.x : local.y) * 100) / 100 };
  }
  return { owner: pageId, offset: Math.round((axis === "x" ? p.x : p.y) * 100) / 100 };
}

/** A guide list with one guide changed, added (index null) or removed (offset null). */
export function withGuide(
  guides: readonly RulerGuide[],
  index: number | null,
  guide: RulerGuide | null,
): RulerGuide[] {
  if (index === null) return guide ? [...guides, guide] : [...guides];
  if (!guide) return guides.filter((_, i) => i !== index);
  return guides.map((g, i) => (i === index ? guide : g));
}
