/**
 * Converts one file of a Penpot export to Drawpane nodes: pages and their
 * layers (boards, groups, shapes, paths, text with its styled runs),
 * components and variants, the library's colours (as colour variables) and
 * typographies (as text styles), and prototype interactions and flows.
 *
 * Penpot ids are kept, so references inside the file (components, styles,
 * variables, prototype destinations) carry over as they are. Anything that
 * can't come across exactly is counted in `notes` for the import summary.
 */
import {
  type GridArea,
  keysBetween,
  type LayoutGrid,
  type NodeRecord,
  type NodeType,
  newId,
  type Reaction,
  ROOT_ID,
  type RulerGuide,
} from "@drawpane/model";
import {
  boxIn,
  boxMatrix,
  IDENTITY,
  invert,
  type Matrix,
  parsePenpotPath,
  pathBounds,
  round,
  serializePath,
  shapeMatrix,
  shapeSize,
  transformPath,
} from "./geometry";
import { childLayout, childOrder, containerLayout, gridAreas } from "./layout";
import { Notes } from "./notes";
import type { PenpotFile, PenpotRecord } from "./read";
import {
  blendMode,
  color,
  constraints,
  effects,
  fills,
  type MediaLookup,
  num,
  radii,
  strokes,
} from "./styles";
import { convertText, typographyProps } from "./text";

type Raw = Record<string, unknown>;

const ROOT_FRAME = "00000000-0000-0000-0000-000000000000";
const COLORS_COLLECTION = "penpot-colors";
const MODE = "m1";

export interface ConvertedFile {
  readonly name: string;
  readonly nodes: NodeRecord[];
  readonly notes: Notes;
}

/** Where a layer sits while converting: its frame's space and what contains it. */
interface Place {
  /** The page affine of the coordinate space its parent's children use (the nearest frame, or the page). */
  readonly space: Matrix;
  /** The Penpot parent: a frame with a layout lays the layer out. */
  readonly parent: Raw | null;
  /** Directly in a group (Penpot's default constraints differ there). */
  readonly inGroup: boolean;
  /** Inside a copy of a component in this file: layers mirror the main's. */
  readonly inInstance: boolean;
  readonly grid: ReadonlyMap<string, GridArea>;
}

/** Penpot's override groups to the Drawpane properties a copy keeps as its own. */
const TOUCHED: Record<string, readonly string[]> = {
  "fill-group": ["fills"],
  "stroke-group": ["strokes", "strokeWeight", "strokeAlign", "strokeDashes"],
  "content-group": ["characters", "textRuns", "pathData"],
  "text-font-group": [
    "fontFamily",
    "fontWeight",
    "fontStyle",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "textCase",
    "textDecoration",
  ],
  "name-group": ["name"],
  "visibility-group": ["visible"],
  "radius-group": ["cornerRadius", "cornerRadii"],
  "layer-effects-group": ["opacity", "blendMode"],
  "shadow-group": ["effects"],
  "blur-group": ["effects"],
  "geometry-group": ["width", "height"],
  "constraints-group": ["constraintH", "constraintV"],
  "show-content": ["clipContent"],
  "mask-group": ["isMask"],
};

export function convertFile(file: PenpotFile, media: MediaLookup): ConvertedFile {
  const notes = new Notes();
  const nodes: NodeRecord[] = [];
  const add = (node: NodeRecord) => nodes.push(node);

  // Components defined here: main shape id by component id, and their records.
  const mains = new Map<string, string>();
  const componentOf = new Map<string, PenpotRecord>();
  for (const component of file.components.values()) {
    if (component.deleted === true || typeof component.mainInstanceId !== "string") continue;
    mains.set(component.id, component.mainInstanceId);
    componentOf.set(component.mainInstanceId, component);
  }
  const typographies = new Set(file.typographies.keys());
  const colors = new Set(file.colors.keys());

  // ---- Library: text styles and colour variables, at the root before the pages.
  const rootKeys = keysBetween(null, null, file.typographies.size + 1 + file.pages.length);
  let rootKey = 0;
  if (file.colors.size > 0) {
    add({
      id: COLORS_COLLECTION,
      type: "collection",
      parent: ROOT_ID,
      key: rootKeys[rootKey++] as string,
      props: { name: "Colors", modes: [{ id: MODE, name: "Default" }] },
    });
    const keys = keysBetween(null, null, file.colors.size);
    [...file.colors.values()].forEach((c, i) => {
      const hex = color(c.color, num(c.opacity, 1));
      if (!hex) return;
      add({
        id: c.id,
        type: "variable",
        parent: COLORS_COLLECTION,
        key: keys[i] as string,
        props: { name: libraryName(c), variableType: "color", values: { [MODE]: hex } },
      });
    });
  } else rootKey++;
  for (const t of file.typographies.values())
    add({
      id: t.id,
      type: "textStyle",
      parent: ROOT_ID,
      key: rootKeys[rootKey++] as string,
      props: typographyProps(t),
    });
  if (file.hasTokens) notes.add("tokens");
  // A masked group's bottom layer, marked when the group is reached (before its children).
  const maskIds = new Set<string>();

  // ---- Pages
  for (const page of file.pages) {
    const pageId = page.record.id;
    const shapes = page.shapes;
    const flows = (page.record.flows ?? {}) as Record<string, Raw>;
    const pageProps: Record<string, unknown> = {
      name: String(page.record.name ?? "Page").slice(0, 256),
    };
    const background = color(page.record.background);
    if (background) pageProps.backgroundColor = background.slice(0, 7);
    const flowList = Object.values(flows)
      .filter((f) => typeof f.startingFrame === "string" && shapes.has(f.startingFrame))
      .slice(0, 64)
      .map((f) => ({
        id: typeof f.id === "string" ? f.id : newId(),
        name: String(f.name ?? "Flow").slice(0, 64) || "Flow",
        start: f.startingFrame as string,
        description: "",
      }));
    if (flowList.length > 0) pageProps.flows = flowList;
    const guides = pageGuides(page.record);
    if (guides.length > 0) pageProps.rulerGuides = guides;
    add({
      id: pageId,
      type: "page",
      parent: ROOT_ID,
      key: rootKeys[rootKey++] as string,
      props: pageProps,
    });

    const root = shapes.get(ROOT_FRAME);
    const top = Array.isArray(root?.shapes) ? (root.shapes as string[]) : [];
    const place: Place = {
      space: IDENTITY,
      parent: null,
      inGroup: false,
      inInstance: false,
      grid: new Map(),
    };
    children(pageId, top, place);

    function children(parentId: string, ids: readonly string[], at: Place): void {
      const list = ids.filter((id) => shapes.has(id) && id !== ROOT_FRAME);
      const keys = keysBetween(null, null, list.length);
      list.forEach((id, i) => {
        shape(shapes.get(id) as PenpotRecord, parentId, keys[i] as string, at);
      });
    }

    function shape(s: PenpotRecord, parentId: string, key: string, at: Place): void {
      const type = String(s.type);
      const props: Record<string, unknown> = { name: String(s.name ?? type).slice(0, 256) };
      if (s.hidden === true) props.visible = false;
      if (s.blocked === true) props.locked = true;
      const opacity = num(s.opacity, 1);
      if (opacity < 1) props.opacity = Math.max(0, opacity);
      const blend = blendMode(s.blendMode);
      if (blend) props.blendMode = blend;
      const fx = effects(s);
      if (fx.length > 0) props.effects = fx;
      const inLayout = at.parent?.layout === "flex" || at.parent?.layout === "grid";
      if (inLayout) {
        Object.assign(props, childLayout(s, notes));
        const area = at.grid.get(s.id);
        if (area) props.gridArea = area;
      } else if (at.parent) Object.assign(props, constraints(s, at.inGroup));

      // Components: a main is a frame with isComponent; a copy points at its main.
      const isMain = s.mainInstance === true && typeof s.componentId === "string";
      const mainId = typeof s.componentId === "string" ? mains.get(s.componentId) : undefined;
      const isCopyHead = !isMain && typeof s.componentId === "string";
      let inInstance = at.inInstance;
      if (isCopyHead && mainId === undefined) notes.add("library-component");
      if (at.inInstance || (isCopyHead && mainId !== undefined)) {
        if (typeof s.shapeRef === "string" && !isCopyHead) props.mirrors = s.shapeRef;
        const overrides = touched(s.touched);
        if (overrides.length > 0) props.overrides = overrides;
      }

      switch (type) {
        case "frame": {
          const box = boxOf(s, at);
          Object.assign(props, box.props, fillsAndStrokes(s, false), radii(s));
          if (s.showContent === true) props.clipContent = false;
          Object.assign(props, containerLayout(s, notes));
          const grids = layoutGrids(s.grids);
          if (grids.length > 0) props.layoutGrids = grids;
          if (isMain) {
            props.isComponent = true;
            const component = componentOf.get(s.id);
            const variant = variantProps(component);
            if (variant) props.variantProps = variant;
          }
          if (s.isVariantContainer === true) props.isComponentSet = true;
          if (isCopyHead && mainId !== undefined) {
            props.instanceOf = mainId;
            inInstance = true;
          }
          const reactions = interactions(s);
          if (reactions.length > 0) props.reactions = reactions;
          add({ id: s.id, type: "frame", parent: parentId, key, props });
          const order = childOrder(s, Array.isArray(s.shapes) ? (s.shapes as string[]) : []);
          children(s.id, order, {
            space: box.matrix,
            parent: s,
            inGroup: false,
            inInstance,
            grid: gridAreas(s),
          });
          return;
        }
        case "group": {
          if (isMain) notes.add("component-not-frame");
          const reactions = interactions(s);
          if (reactions.length > 0) props.reactions = reactions;
          add({ id: s.id, type: "group", parent: parentId, key, props });
          const ids = Array.isArray(s.shapes) ? (s.shapes as string[]) : [];
          // A masked group's bottom layer is the mask.
          if (s.maskedGroup === true && ids[0]) maskIds.add(ids[0]);
          children(s.id, ids, { ...at, parent: s, inGroup: true, inInstance, grid: new Map() });
          return;
        }
        case "rect":
        case "image":
        case "circle": {
          if (isMain) notes.add("component-not-frame");
          const box = boxOf(s, at);
          Object.assign(props, box.props, fillsAndStrokes(s, false));
          if (type !== "circle") Object.assign(props, radii(s));
          if (type === "image" && s.metadata && typeof s.metadata === "object") {
            // Pre-migration image shapes: a rectangle filled with the image.
            const image = fills(
              [{ fillImage: { ...(s.metadata as Raw), keepAspectRatio: false } }],
              media,
              notes,
            );
            if (image.length > 0) props.fills = image;
          }
          if (maskIds.has(s.id)) props.isMask = true;
          const reactions = interactions(s);
          if (reactions.length > 0) props.reactions = reactions;
          add({
            id: s.id,
            type: type === "circle" ? "ellipse" : "rect",
            parent: parentId,
            key,
            props,
          });
          return;
        }
        case "text": {
          if (isMain) notes.add("component-not-frame");
          const box = boxOf(s, at);
          const text = convertText(s, media, notes);
          Object.assign(props, box.props, text.props);
          if (text.typography && typographies.has(text.typography) && !props.textRuns)
            props.textStyle = text.typography;
          const reactions = interactions(s);
          if (reactions.length > 0) props.reactions = reactions;
          add({ id: s.id, type: "text", parent: parentId, key, props });
          return;
        }
        case "path":
        case "bool": {
          if (isMain) notes.add("component-not-frame");
          if (type === "bool") notes.add("boolean-flattened");
          const segments = transformPath(
            parsePenpotPath(s.content ?? s.boolContent),
            invert(at.space),
          );
          const bounds = pathBounds(segments);
          if (!bounds) return;
          const x = round(bounds.x);
          const y = round(bounds.y);
          const local = transformPath(segments, [1, 0, 0, 1, -x, -y]);
          Object.assign(props, {
            x,
            y,
            width: round(bounds.width),
            height: round(bounds.height),
            pathData: serializePath(local),
          });
          const attrs = (s.svgAttrs ?? {}) as Raw;
          if (attrs.fillRule === "evenodd" || attrs.fillRule === "evenOdd")
            props.windingRule = "evenodd";
          const open = !segments.some((seg) => seg.c === "Z");
          Object.assign(props, fillsAndStrokes(s, open));
          if (maskIds.has(s.id)) props.isMask = true;
          const reactions = interactions(s);
          if (reactions.length > 0) props.reactions = reactions;
          add({ id: s.id, type: "path", parent: parentId, key, props });
          return;
        }
        default:
          if (type === "svg-raw") notes.add("svg-raw-skipped");
      }
    }

    /** A shape's box in its frame's space, and the page affine its children's space will have. */
    function boxOf(s: PenpotRecord, at: Place) {
      const { width, height } = shapeSize(s);
      const box = boxIn(at.space, shapeMatrix(s), width, height);
      if (box.skewed) notes.add("skewed");
      const props: Record<string, unknown> = {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
      if (box.rotation !== 0) props.rotation = box.rotation;
      if (box.flipX) props.flipX = true;
      return { props, matrix: boxMatrix(at.space, box) };
    }
  }

  return { name: file.name, nodes: tidy(nodes, colors), notes };

  function fillsAndStrokes(s: Raw, open: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const f = fills(s.fills, media, notes);
    if (f.length > 0) out.fills = f;
    const stroke = strokes(s.strokes, open, media, notes);
    if (stroke.strokes.length > 0) Object.assign(out, stroke);
    // A fill tied to a library colour in this file stays tied to its variable.
    const list = Array.isArray(s.fills) ? (s.fills as Raw[]) : [];
    const ref = list.length === 1 ? list[0]?.fillColorRefId : undefined;
    if (typeof ref === "string" && colors.has(ref) && typeof list[0]?.fillColor === "string")
      out.bindings = { fill: ref };
    return out;
  }

  function interactions(s: Raw): Reaction[] {
    const list = Array.isArray(s.interactions) ? (s.interactions as Raw[]) : [];
    const out: Reaction[] = [];
    for (const i of list.slice(0, 32)) {
      const reaction = interaction(i);
      if (reaction) out.push(reaction);
      else notes.add("interaction-skipped");
    }
    return out;
  }

  function interaction(i: Raw): Reaction | null {
    const trigger =
      i.eventType === "click" || i.eventType === "mouse-press"
        ? ({ type: "tap" } as const)
        : i.eventType === "mouse-enter" || i.eventType === "mouse-over"
          ? ({ type: "hover" } as const)
          : i.eventType === "after-delay"
            ? ({ type: "delay", ms: Math.min(60_000, Math.max(0, num(i.delay, 600))) } as const)
            : null;
    if (!trigger) return null;
    const to = typeof i.destination === "string" ? i.destination : null;
    const exists = (id: string | null): id is string =>
      id !== null && file.pages.some((p) => p.shapes.has(id));
    let action: Reaction["action"] | null = null;
    switch (i.actionType) {
      case "navigate":
        if (exists(to)) action = { type: "navigate", to };
        break;
      case "open-overlay":
      case "toggle-overlay":
        if (exists(to))
          action = {
            type: "overlay",
            to,
            position: overlayPosition(i.overlayPosType),
            closeOnOutside: i.closeClickOutside === true,
            dim: i.backgroundOverlay === true ? 0.4 : 0,
          };
        break;
      case "close-overlay":
        action = { type: "close-overlay" };
        break;
      case "prev-screen":
        action = { type: "back" };
        break;
      case "open-url":
        if (
          typeof i.url === "string" &&
          /^(https?:\/\/[^\s/?#]+\S*|mailto:\S+|tel:[0-9+().\- ]+)$/i.test(i.url)
        )
          action = { type: "url", url: i.url.slice(0, 2048), newTab: true };
        break;
    }
    if (!action) return null;
    return { id: newId(), trigger, action, transition: transition(i.animation) };
  }
}

function overlayPosition(
  v: unknown,
): "center" | "top-left" | "top-right" | "top" | "bottom-left" | "bottom-right" | "bottom" {
  switch (v) {
    case "top-left":
      return "top-left";
    case "top-right":
      return "top-right";
    case "top-center":
      return "top";
    case "bottom-left":
      return "bottom-left";
    case "bottom-right":
      return "bottom-right";
    case "bottom-center":
      return "bottom";
    default:
      return "center";
  }
}

function transition(raw: unknown): Reaction["transition"] {
  const a = (raw ?? {}) as Raw;
  const easing =
    a.easing === "linear"
      ? ({ type: "linear" } as const)
      : a.easing === "ease-in"
        ? ({ type: "ease-in" } as const)
        : a.easing === "ease-out"
          ? ({ type: "ease-out" } as const)
          : ({ type: "ease-in-out" } as const);
  const direction = ["left", "right", "up", "down"].includes(String(a.direction))
    ? (a.direction as "left" | "right" | "up" | "down")
    : "left";
  const duration = Math.min(10_000, Math.max(0, num(a.duration, 300)));
  const type =
    a.animationType === "dissolve"
      ? "dissolve"
      : a.animationType === "slide"
        ? a.way === "out"
          ? "slide-out"
          : "slide-in"
        : a.animationType === "push"
          ? "push"
          : "instant";
  return { type, direction, duration: type === "instant" ? 0 : duration, easing };
}

/** "Brand / Primary": a library item's group path and name, as Drawpane's "/" names. */
function libraryName(item: Raw): string {
  return (
    [item.path, item.name]
      .filter((s) => typeof s === "string" && s.trim() !== "")
      .map((s) => (s as string).trim())
      .join("/")
      .replace(/\s*\/\s*/g, "/")
      .slice(0, 256) || "Color"
  );
}

function touched(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const group of raw)
    if (typeof group === "string") for (const prop of TOUCHED[group] ?? []) out.add(prop);
  return [...out].slice(0, 64);
}

function variantProps(component: PenpotRecord | undefined): Record<string, string> | null {
  const list = Array.isArray(component?.variantProperties)
    ? (component.variantProperties as Raw[])
    : [];
  const out: Record<string, string> = {};
  for (const p of list) {
    const name = String(p.name ?? "")
      .trim()
      .slice(0, 64);
    if (name) out[name] = String(p.value ?? "").slice(0, 64);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function layoutGrids(raw: unknown): LayoutGrid[] {
  if (!Array.isArray(raw)) return [];
  const out: LayoutGrid[] = [];
  for (const g of raw as Raw[]) {
    const params = (g.params ?? {}) as Raw;
    const c = (params.color ?? {}) as Raw;
    const hex = color(c.color, num(c.opacity, 0.1)) ?? "#de47621a";
    const visible = g.display === false ? { visible: false } : {};
    if (g.type === "square") {
      out.push({
        type: "grid",
        size: Math.min(10_000, Math.max(1, num(params.size, 16))),
        color: hex,
        ...visible,
      });
      continue;
    }
    if (g.type !== "column" && g.type !== "row") continue;
    const kind = String(params.type ?? "stretch");
    out.push({
      type: g.type === "column" ? "columns" : "rows",
      count: Math.min(100, Math.max(1, Math.round(num(params.size, 12)))),
      gutter: Math.max(0, num(params.gutter, 8)),
      margin: Math.max(0, num(params.margin, 0)),
      alignment:
        kind === "left"
          ? "start"
          : kind === "right"
            ? "end"
            : kind === "center"
              ? "center"
              : "stretch",
      size: Math.max(0, num(params.itemLength, 0)),
      color: hex,
      ...visible,
    });
  }
  return out.slice(0, 16);
}

function pageGuides(page: Raw): RulerGuide[] {
  const guides = (page.guides ?? {}) as Record<string, Raw>;
  return Object.values(guides)
    .filter(
      (g) => (g.axis === "x" || g.axis === "y") && (g.frameId === undefined || g.frameId === null),
    )
    .slice(0, 200)
    .map((g) => ({ axis: g.axis as "x" | "y", offset: num(g.position) }));
}

/**
 * Drops references to nodes that didn't come across (a copy's layer whose
 * main is gone, a binding to a missing colour), so the file is consistent.
 */
function tidy(nodes: NodeRecord[], colors: ReadonlySet<string>): NodeRecord[] {
  const ids = new Set(nodes.map((n) => n.id));
  const types = new Map<string, NodeType>(nodes.map((n) => [n.id, n.type]));
  return nodes.map((node) => {
    const props = { ...node.props } as Record<string, unknown>;
    let changed = false;
    if (typeof props.mirrors === "string" && !ids.has(props.mirrors)) {
      delete props.mirrors;
      delete props.overrides;
      changed = true;
    }
    if (typeof props.instanceOf === "string" && types.get(props.instanceOf) !== "frame") {
      delete props.instanceOf;
      changed = true;
    }
    const bindings = props.bindings as Record<string, string> | undefined;
    if (bindings?.fill && !colors.has(bindings.fill)) {
      delete props.bindings;
      changed = true;
    }
    return changed ? { ...node, props: props as NodeRecord["props"] } : node;
  });
}
