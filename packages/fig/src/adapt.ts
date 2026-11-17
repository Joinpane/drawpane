/**
 * Open Pencil's scene graph of a .fig file as the file Figma's REST API
 * returns (`GET /v1/files/:key?geometry=paths`), so `@drawpane/figma`'s
 * converter reads both the same way and they import alike.
 *
 * The graph has instances filled in with their components' layers,
 * overrides and component properties applied, and styles resolved. It
 * places each layer relative to its parent (groups included, as Figma saves
 * them), which is one of the two readings the converter checks against
 * each layer's bounding box, so the boxes here are worked out the same way.
 */
import type { Figma } from "@drawpane/figma";
import type { LayoutGrid, SceneGraph, SceneNode, Stroke } from "@open-pencil/scene-graph";
import { getNodeLocalMatrix } from "@open-pencil/scene-graph/coordinate";
import { commandsToPath } from "./geometry";
import type { RestIds } from "./ids";
import type { FigNotes } from "./notes";
import { convertEffects, convertFills } from "./paint";
import {
  guidString,
  type RawGuid,
  type RawRecord,
  type RawTrackOrder,
  type RawTrackSizes,
  type RawTrackSizing,
} from "./raw";
import { textFields } from "./text";

type Writable<T> = { -readonly [K in keyof T]: T[K] };
type RestNode = Writable<Figma.Node> & { vectorNetwork?: unknown };

/** Row-major 3×3, as Open Pencil's matrices are. */
type Mat = readonly number[];
const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const multiply = (a: Mat, b: Mat): Mat => [
  (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[3] as number),
  (a[0] as number) * (b[1] as number) + (a[1] as number) * (b[4] as number),
  (a[0] as number) * (b[2] as number) + (a[1] as number) * (b[5] as number) + (a[2] as number),
  (a[3] as number) * (b[0] as number) + (a[4] as number) * (b[3] as number),
  (a[3] as number) * (b[1] as number) + (a[4] as number) * (b[4] as number),
  (a[3] as number) * (b[2] as number) + (a[4] as number) * (b[5] as number) + (a[5] as number),
  0,
  0,
  1,
];

function boundingBox(m: Mat, w: number, h: number) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ] as const) {
    xs.push((m[0] as number) * x + (m[1] as number) * y + (m[2] as number));
    ys.push((m[3] as number) * x + (m[4] as number) * y + (m[5] as number));
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const CONSTRAINT_H = {
  MIN: "LEFT",
  MAX: "RIGHT",
  CENTER: "CENTER",
  STRETCH: "LEFT_RIGHT",
  SCALE: "SCALE",
} as const;
const CONSTRAINT_V = {
  MIN: "TOP",
  MAX: "BOTTOM",
  CENTER: "CENTER",
  STRETCH: "TOP_BOTTOM",
  SCALE: "SCALE",
} as const;
/** Kinds Open Pencil reads as themselves (anything else it saves as a rectangle). */
const RECTANGLES = new Set(["RECTANGLE", "ROUNDED_RECTANGLE"]);

/** The page a node is on, if any. */
function pageOf(graph: SceneGraph, node: SceneNode): SceneNode | null {
  let at: SceneNode | undefined = node;
  while (at && at.type !== "CANVAS") at = at.parentId ? graph.getNode(at.parentId) : undefined;
  return at ?? null;
}
/** Figma's "auto" column or row count, saved as the largest int. */
const AUTO_COUNT = 1_000_000;

export interface AdaptContext {
  readonly graph: SceneGraph;
  readonly ids: RestIds;
  /** Records by guid, as saved. */
  readonly records: ReadonlyMap<string, RawRecord>;
  readonly notes: FigNotes;
}

/** The node's REST kind: Open Pencil's, except where it read a kind it doesn't know as a rectangle. */
function restType(n: SceneNode, raw: RawRecord | undefined, notes: FigNotes): string {
  const type = n.type as string;
  if (type === "RECTANGLE" || type === "ROUNDED_RECTANGLE") {
    if (raw?.type && !RECTANGLES.has(raw.type)) return raw.type;
    return "RECTANGLE";
  }
  if (type === "POLYGON") return "REGULAR_POLYGON";
  if (type === "TEXT" && raw?.type === "TEXT_PATH") notes.add("text-path");
  return type;
}

function layoutGrid(g: LayoutGrid, n: SceneNode): Figma.LayoutGrid | null {
  const pattern =
    g.pattern === "GRID"
      ? "GRID"
      : g.pattern === "COLUMNS" || (g.pattern === "STRIPES" && g.axis !== "Y")
        ? "COLUMNS"
        : "ROWS";
  const alignment = g.alignment ?? g.type;
  if (!alignment && pattern !== "GRID") return null;
  let count = g.count ?? g.numSections;
  if (pattern !== "GRID" && (count === null || count === undefined || count >= AUTO_COUNT)) {
    // An auto count is as many sections as fit.
    const length = pattern === "COLUMNS" ? n.width : n.height;
    const section = (g.sectionSize ?? 0) + (g.gutterSize ?? 0);
    count =
      section > 0
        ? Math.max(1, Math.floor((length - 2 * (g.offset ?? 0) + (g.gutterSize ?? 0)) / section))
        : 1;
  }
  return {
    pattern,
    ...(alignment ? { alignment } : {}),
    ...(count !== null && count !== undefined ? { count } : {}),
    ...(g.sectionSize !== undefined ? { sectionSize: g.sectionSize } : {}),
    ...(g.gutterSize !== undefined ? { gutterSize: g.gutterSize } : {}),
    ...(g.offset !== undefined ? { offset: g.offset } : {}),
    ...(g.visible === false ? { visible: false } : {}),
    color: g.color
      ? { r: g.color.r, g: g.color.g, b: g.color.b, a: g.color.a ?? 1 }
      : { r: 0, g: 0, b: 0, a: 0 },
  };
}

function strokeFields(
  n: SceneNode,
  raw: RawRecord | undefined,
  notes: FigNotes,
): Partial<RestNode> {
  const strokes = n.strokes as Stroke[];
  if (strokes.length === 0) return {};
  // Each stroke carries the node's weight and alignment while it has strokes.
  const first = strokes[0] as Stroke;
  const out: Partial<RestNode> = {
    strokes: convertFills(strokes, raw?.strokePaints, notes),
    strokeWeight: first.weight ?? n.strokeWeight,
    strokeAlign: first.align ?? n.strokeAlign,
    strokeJoin: n.strokeJoin,
    strokeCap: n.strokeCap,
  };
  if (n.dashPattern.length > 0) out.strokeDashes = n.dashPattern;
  if (n.independentStrokeWeights)
    out.individualStrokeWeights = {
      top: n.borderTopWeight,
      right: n.borderRightWeight,
      bottom: n.borderBottomWeight,
      left: n.borderLeftWeight,
    };
  return out;
}

/** A grid's tracks in order (by position), each one's id and size as CSS ("32px", "1fr", "auto"). */
function gridTracks(
  order: RawTrackOrder | undefined,
  sizes: RawTrackSizes | undefined,
): { ids: string[]; list: string } {
  const entries = (order?.entries ?? []).filter((e) => e.id);
  entries.sort((a, b) => {
    const p = a.position ?? "";
    const q = b.position ?? "";
    return p < q ? -1 : p > q ? 1 : 0;
  });
  const ids = entries.map((e) => guidString(e.id as RawGuid));
  const byId = new Map<string, NonNullable<RawTrackSizes["entries"]>[number]["trackSize"]>();
  for (const e of sizes?.entries ?? []) if (e.id) byId.set(guidString(e.id), e.trackSize);
  const css = (s: RawTrackSizing | undefined) =>
    s?.type === "FIXED"
      ? `${Math.max(0, s.value ?? 0)}px`
      : s?.type === "HUG"
        ? "auto"
        : `${(s?.value ?? 1) > 0 ? (s?.value ?? 1) : 1}fr`;
  const list = ids.map((id) => {
    const size = byId.get(id);
    const min = css(size?.minSizing ?? size?.maxSizing);
    const max = css(size?.maxSizing ?? size?.minSizing);
    return min === max ? max : `minmax(${min}, ${max})`;
  });
  return { ids, list: list.join(" ") };
}

/** A grid frame's tracks and gaps; Open Pencil's graph doesn't keep them, so they're read from its record. */
function gridFields(raw: RawRecord | undefined): Partial<RestNode> {
  const rows = gridTracks(raw?.gridRows, raw?.gridRowsSizing);
  const columns = gridTracks(raw?.gridColumns, raw?.gridColumnsSizing);
  return {
    ...(rows.list ? { gridRowsSizing: rows.list } : {}),
    ...(columns.list ? { gridColumnsSizing: columns.list } : {}),
    gridRowGap: raw?.gridRowGap ?? 0,
    gridColumnGap: raw?.gridColumnGap ?? 0,
  };
}

/** A grid auto layout frame: Open Pencil (0.16) reads one as no auto layout, so its record says. */
const isGrid = (n: SceneNode, raw: RawRecord | undefined) =>
  (n.layoutMode as string) === "GRID" || raw?.stackMode === "GRID";

const CELL_ALIGN = new Set(["AUTO", "MIN", "CENTER", "MAX"]);

/**
 * Where a grid's item sits: the row and column it's anchored at (by its parent's track ids), its
 * spans and alignment. A grid that reflows places its items in order, whatever anchors they
 * kept from before (Figma shows them so), so their anchors are left out.
 */
function gridItemFields(raw: RawRecord | undefined, parentRaw: RawRecord | undefined) {
  const out: Partial<RestNode> = {};
  if (raw?.gridRowAnchor && raw.gridColumnAnchor && parentRaw?.gridReflowEnabled !== true) {
    const row = gridTracks(parentRaw?.gridRows, undefined).ids.indexOf(
      guidString(raw.gridRowAnchor),
    );
    const column = gridTracks(parentRaw?.gridColumns, undefined).ids.indexOf(
      guidString(raw.gridColumnAnchor),
    );
    if (row >= 0 && column >= 0) {
      out.gridRowAnchorIndex = row;
      out.gridColumnAnchorIndex = column;
      out.gridRowSpan = Math.max(1, raw.gridRowSpan ?? 1);
      out.gridColumnSpan = Math.max(1, raw.gridColumnSpan ?? 1);
    }
  }
  const h = raw?.gridChildHorizontalAlign;
  const v = raw?.gridChildVerticalAlign;
  if (h && CELL_ALIGN.has(h))
    out.gridChildHorizontalAlign = h as NonNullable<RestNode["gridChildHorizontalAlign"]>;
  if (v && CELL_ALIGN.has(v))
    out.gridChildVerticalAlign = v as NonNullable<RestNode["gridChildVerticalAlign"]>;
  return out;
}

function layoutFields(
  n: SceneNode,
  parent: SceneNode,
  raw: RawRecord | undefined,
  parentRaw: RawRecord | undefined,
): Partial<RestNode> {
  const out: Partial<RestNode> = {
    constraints: {
      horizontal: CONSTRAINT_H[n.horizontalConstraint],
      vertical: CONSTRAINT_V[n.verticalConstraint],
    },
  };
  if (isGrid(n, raw)) {
    // A grid's primary axis is across: its sizing modes read as a row's.
    Object.assign(out, {
      layoutMode: "GRID",
      primaryAxisSizingMode: n.primaryAxisSizing === "HUG" ? "AUTO" : "FIXED",
      counterAxisSizingMode: n.counterAxisSizing === "HUG" ? "AUTO" : "FIXED",
      paddingTop: n.paddingTop,
      paddingRight: n.paddingRight,
      paddingBottom: n.paddingBottom,
      paddingLeft: n.paddingLeft,
      ...gridFields(raw),
    } satisfies Partial<RestNode>);
  }
  if (isGrid(parent, parentRaw)) {
    // Its item grows across and stretches down its cells, saved as a row's child does.
    out.layoutGrow = n.layoutGrow;
    out.layoutAlign = n.layoutAlignSelf === "STRETCH" ? "STRETCH" : "INHERIT";
    if (n.layoutPositioning === "ABSOLUTE") out.layoutPositioning = "ABSOLUTE";
    Object.assign(out, gridItemFields(raw, parentRaw));
  }
  if (n.layoutMode === "HORIZONTAL" || n.layoutMode === "VERTICAL") {
    Object.assign(out, {
      layoutMode: n.layoutMode,
      primaryAxisSizingMode: n.primaryAxisSizing === "HUG" ? "AUTO" : "FIXED",
      counterAxisSizingMode: n.counterAxisSizing === "HUG" ? "AUTO" : "FIXED",
      primaryAxisAlignItems: n.primaryAxisAlign,
      counterAxisAlignItems: n.counterAxisAlign,
      itemSpacing: Number.isFinite(n.itemSpacing) ? n.itemSpacing : 0,
      // Figma saves "the same as the item spacing" as NaN.
      counterAxisSpacing: Number.isFinite(n.counterAxisSpacing)
        ? n.counterAxisSpacing
        : n.itemSpacing,
      paddingTop: n.paddingTop,
      paddingRight: n.paddingRight,
      paddingBottom: n.paddingBottom,
      paddingLeft: n.paddingLeft,
      layoutWrap: n.layoutWrap,
    } satisfies Partial<RestNode>);
  }
  if (parent.layoutMode === "HORIZONTAL" || parent.layoutMode === "VERTICAL") {
    out.layoutGrow = n.layoutGrow;
    out.layoutAlign =
      n.layoutAlignSelf === "AUTO" || n.layoutAlignSelf === "BASELINE"
        ? "INHERIT"
        : n.layoutAlignSelf;
    if (n.layoutPositioning === "ABSOLUTE") out.layoutPositioning = "ABSOLUTE";
  }
  if (n.minWidth !== null) out.minWidth = n.minWidth;
  if (n.maxWidth !== null && Number.isFinite(n.maxWidth)) out.maxWidth = n.maxWidth;
  if (n.minHeight !== null) out.minHeight = n.minHeight;
  if (n.maxHeight !== null && Number.isFinite(n.maxHeight)) out.maxHeight = n.maxHeight;
  if (n.targetAspectRatio) out.preserveRatio = true;
  return out;
}

/**
 * A layer's matrix in its parent. Open Pencil reads a .fig's transform into
 * a position for a turn about the layer's centre, and draws every layer that
 * way but lines, which it turns about their start. So a turned line read
 * from a .fig would land off by the difference (a vertical separator half
 * its length left and down); it's turned here about the centre it was read
 * for.
 */
export function localMatrix(n: SceneNode): Mat {
  if (n.type !== "LINE" || !n.rotation) return getNodeLocalMatrix(n);
  return getNodeLocalMatrix({ ...n, type: "RECTANGLE" });
}

/** One layer and everything under it, in REST's shape. */
export function adaptNode(
  n: SceneNode,
  parent: SceneNode,
  parentAbs: Mat,
  ctx: AdaptContext,
): RestNode {
  const { ids, notes } = ctx;
  const guid = ids.sourceGuid(n);
  const raw = guid ? ctx.records.get(guid) : undefined;
  const type = restType(n, raw, notes);
  const l = localMatrix(n);
  const abs = multiply(parentAbs, l);
  const node: RestNode = {
    id: ids.of(n),
    name: n.name,
    type,
    relativeTransform: [
      [l[0] as number, l[1] as number, l[2] as number],
      [l[3] as number, l[4] as number, l[5] as number],
    ],
    size: { x: n.width, y: n.height },
    absoluteBoundingBox: boundingBox(abs, n.width, n.height),
  };
  if (!n.visible) node.visible = false;
  if (n.locked) node.locked = true;
  if (n.opacity !== 1) node.opacity = n.opacity;
  if (n.blendMode && n.blendMode !== "PASS_THROUGH" && n.blendMode !== "NORMAL")
    node.blendMode = n.blendMode;
  if (n.isMask) {
    node.isMask = true;
    // Open Pencil reads a mask with only the older outline flag as an alpha mask.
    node.maskType = n.maskIsOutline && !raw?.maskType ? "VECTOR" : n.maskType;
  }
  const effects = convertEffects(n.effects, raw?.effects, notes);
  if (effects.length > 0) node.effects = effects;
  node.fills = convertFills(n.fills, raw?.fillPaints, notes);
  Object.assign(node, strokeFields(n, raw, notes));
  if (n.independentCorners)
    node.rectangleCornerRadii = [
      n.topLeftRadius,
      n.topRightRadius,
      n.bottomRightRadius,
      n.bottomLeftRadius,
    ];
  else if (n.cornerRadius > 0) node.cornerRadius = n.cornerRadius;
  if (n.clipsContent) node.clipsContent = true;
  const parentGuid = ids.sourceGuid(parent);
  const parentRaw = parentGuid ? ctx.records.get(parentGuid) : undefined;
  Object.assign(node, layoutFields(n, parent, raw, parentRaw));
  const grids = n.layoutGrids.map((g) => layoutGrid(g, n)).filter((g) => g !== null);
  if (grids.length > 0) node.layoutGrids = grids;

  if (type === "TEXT") Object.assign(node, textFields(n, raw, notes));
  if (n.fillGeometry.length > 0)
    node.fillGeometry = n.fillGeometry.map((g) => ({
      path: commandsToPath(g.commandsBlob),
      windingRule: g.windingRule,
    }));
  if (n.strokeGeometry.length > 0)
    node.strokeGeometry = n.strokeGeometry.map((g) => ({
      path: commandsToPath(g.commandsBlob),
      windingRule: g.windingRule,
    }));
  if (n.vectorNetwork && n.vectorNetwork.segments.length > 0) node.vectorNetwork = n.vectorNetwork;
  if (n.booleanOperation) node.booleanOperation = n.booleanOperation;
  if (n.arcData) node.arcData = { ...n.arcData };

  if (type === "COMPONENT" || type === "COMPONENT_SET") {
    if (n.componentPropertyDefinitions.length > 0)
      node.componentPropertyDefinitions = Object.fromEntries(
        n.componentPropertyDefinitions.map((d) => [
          d.name,
          { type: d.type, defaultValue: d.defaultValue },
        ]),
      );
  }
  if (type === "INSTANCE" && n.componentId) {
    const main = ctx.graph.getNode(n.componentId);
    if (main) node.componentId = ids.of(main);
  }

  const children: RestNode[] = [];
  for (const id of n.childIds) {
    const child = ctx.graph.getNode(id);
    if (child) children.push(adaptNode(child, n, abs, ctx));
  }
  if (children.length > 0 || isContainer(type)) node.children = children;
  return node;
}

const CONTAINERS = new Set([
  "FRAME",
  "GROUP",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
  "SECTION",
  "BOOLEAN_OPERATION",
]);
const isContainer = (type: string) => CONTAINERS.has(type);

/**
 * The REST file, put together a page at a time: each page may come from a
 * graph of its own (large files are read page by page), so a page is
 * adapted while its graph is at hand and only the REST shape is kept.
 */
export class RestFileBuilder {
  readonly #pages: RestNode[] = [];
  readonly #components: Record<
    string,
    { key?: string; name?: string; componentSetId?: string; remote?: boolean; omitted?: boolean }
  > = {};
  readonly #componentSets: Record<string, { name?: string }> = {};
  readonly #styles: Record<string, { name?: string; styleType?: string }> = {};
  /** Layers in the document, pages not counted. */
  layers = 0;

  /** Adds a page (not Figma's internal one) as the next in the document. */
  addPage(page: SceneNode, ctx: AdaptContext): void {
    const guid = ctx.ids.sourceGuid(page);
    const raw = guid ? ctx.records.get(guid) : undefined;
    const children: RestNode[] = [];
    for (const id of page.childIds) {
      const child = ctx.graph.getNode(id);
      if (child) children.push(adaptNode(child, page, IDENTITY, ctx));
    }
    for (const c of children) this.#count(c);
    this.#pages.push({
      id: ctx.ids.of(page),
      name: page.name,
      type: "CANVAS",
      children,
      ...(raw?.backgroundColor ? { backgroundColor: raw.backgroundColor } : {}),
    });
  }

  /**
   * Component keys and the file's styles, from a graph's every node (they live on the internal
   * page), and the components on `omitted` pages (by source guid): pages of the file the import
   * leaves out, whose copies come in detached.
   */
  addLibrary(ctx: AdaptContext, omitted: ReadonlySet<string> = new Set()): void {
    for (const node of ctx.graph.getAllNodes()) {
      if (node.type === "COMPONENT" && node.componentKey) {
        const id = ctx.ids.of(node);
        this.#components[id] = { ...this.#components[id], key: node.componentKey, name: node.name };
        this.#components[id].remote ??= true;
      }
      if (node.type === "COMPONENT" && omitted.size > 0) {
        const page = pageOf(ctx.graph, node);
        const guid = page ? ctx.ids.sourceGuid(page) : null;
        if (guid && omitted.has(guid)) {
          const id = ctx.ids.of(node);
          if (this.#components[id]?.remote !== false)
            this.#components[id] = { ...this.#components[id], name: node.name, omitted: true };
        }
      }
      if (node.sharedStyleType)
        this.#styles[ctx.ids.of(node)] = { name: node.name, styleType: node.sharedStyleType };
    }
  }

  #count(node: RestNode): void {
    this.layers++;
    if (node.type === "COMPONENT")
      this.#components[node.id] = { ...this.#components[node.id], name: node.name, remote: false };
    if (node.type === "COMPONENT_SET") {
      this.#componentSets[node.id] = { name: node.name };
      for (const c of node.children ?? [])
        if (c.type === "COMPONENT")
          this.#components[c.id] = { ...this.#components[c.id], componentSetId: node.id };
    }
    for (const c of node.children ?? []) this.#count(c as RestNode);
  }

  build(name: string, lastModified: string | undefined): Figma.File {
    return {
      name,
      ...(lastModified ? { lastModified } : {}),
      document: { id: "0:0", name: "Document", type: "DOCUMENT", children: this.#pages },
      components: this.#components,
      componentSets: this.#componentSets,
      styles: this.#styles,
    };
  }
}
