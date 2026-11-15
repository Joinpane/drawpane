/**
 * A Figma file (GET /v1/files/:key?geometry=paths) as a Drawpane document.
 *
 * Figma nests transforms: each node's `relativeTransform` is relative to its
 * parent, except that groups and boolean operations don't make a space of
 * their own, as in Drawpane, where every layer's box is in its nearest
 * frame's space. So each node's page affine is worked out down the tree and
 * expressed in its frame's (import-kit's `boxIn`). Which space a group's
 * children are relative to is checked against Figma's bounding boxes, so
 * either reading of the format lands them where Figma shows them.
 *
 * Shapes Drawpane has as kinds (frames, rectangles, ellipses, lines, text)
 * stay editable as those; stars, polygons, arcs, vectors and booleans
 * become paths from Figma's own geometry. Anything that can't come across
 * exactly is counted in `notes`.
 */
import {
  apply,
  boxIn,
  IDENTITY,
  type Matrix,
  multiply,
  parseSvgPath,
  serializePath,
} from "@drawpane/import-kit";
import { keysBetween, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { convertEffects } from "./effects";
import { drawpaneId, mirroredId } from "./ids";
import { childLayout, containerLayout, layoutGrids } from "./layout";
import { Notes } from "./notes";
import { blendMode, convertPaints, hexColor, type ImageLookup } from "./paint";
import type * as Figma from "./rest";
import { textProps } from "./text";

type Props = Record<string, unknown>;

export interface ConvertOptions {
  /** Figma image refs to the Drawpane media they were uploaded as; missing ones are left out. */
  readonly images?: ImageLookup;
}

export interface ConvertedFile {
  readonly name: string;
  readonly nodes: NodeRecord[];
  readonly notes: Notes;
}

const FRAMES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);
const SPACELESS = new Set(["GROUP", "BOOLEAN_OPERATION"]);
/** Kinds with nothing to import: export areas, and FigJam and Slides furniture. */
const SKIPPED = new Set(["SLICE"]);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const relative = (t: Figma.Transform | undefined): Matrix =>
  t ? [t[0][0], t[1][0], t[0][1], t[1][1], t[0][2], t[1][2]] : IDENTITY;

/** How far a box under `m` lies from Figma's own bounding box: 0 when they agree. */
function bboxError(m: Matrix, node: Figma.Node): number {
  const bb = node.absoluteBoundingBox;
  const w = node.size?.x ?? bb?.width ?? 0;
  const h = node.size?.y ?? bb?.height ?? 0;
  if (!bb) return 0;
  const corners = [
    apply(m, { x: 0, y: 0 }),
    apply(m, { x: w, y: 0 }),
    apply(m, { x: 0, y: h }),
    apply(m, { x: w, y: h }),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return (
    Math.abs(Math.min(...xs) - bb.x) +
    Math.abs(Math.min(...ys) - bb.y) +
    Math.abs(Math.max(...xs) - (bb.x + bb.width)) +
    Math.abs(Math.max(...ys) - (bb.y + bb.height))
  );
}

/** Figma's "Prop=Value, Prop=Value" variant names as Drawpane's variant props. */
export function variantProps(name: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of name.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim().slice(0, 64);
    if (!key) return null;
    out[key] = part
      .slice(eq + 1)
      .trim()
      .slice(0, 64);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Every Figma image ref the file's paints use: what to fetch and upload before converting. */
export function imageRefs(file: Figma.File): string[] {
  const refs = new Set<string>();
  const paints = (ps: readonly Figma.Paint[] | undefined) => {
    for (const p of ps ?? []) if (p.type === "IMAGE" && p.imageRef) refs.add(p.imageRef);
  };
  const visit = (n: Figma.Node) => {
    paints(n.fills);
    paints(n.strokes);
    for (const s of Object.values(n.styleOverrideTable ?? {})) paints(s.fills);
    for (const c of n.children ?? []) visit(c);
  };
  visit(file.document);
  return [...refs];
}

export function convertFile(file: Figma.File, options: ConvertOptions = {}): ConvertedFile {
  const notes = new Notes();
  const images: ImageLookup = options.images ?? (() => null);
  const nodes: NodeRecord[] = [];
  const byId = new Map<string, NodeRecord>();
  const add = (node: NodeRecord) => {
    nodes.push(node);
    byId.set(node.id, node);
  };

  // Every node id in the file: an instance whose main component isn't here is from a library.
  const present = new Set<string>();
  const index = (n: Figma.Node) => {
    present.add(n.id);
    for (const c of n.children ?? []) index(c);
  };
  index(file.document);

  /** Instances found, to work out what each one overrides once everything is converted. */
  const instances: string[] = [];

  /**
   * Converts `node` and its children. `abs` is its parent's page affine,
   * `space` the page affine of the nearest frame (or page) it's placed in,
   * `parentId` its Drawpane parent, and `mirrors` whether it's inside an
   * instance (its layers copy the main component's).
   */
  const visit = (
    node: Figma.Node,
    parent: Figma.Node,
    parentAbs: Matrix,
    containerAbs: Matrix,
    space: Matrix,
    parentId: string,
    key: string,
    inInstance: boolean,
  ): void => {
    if (SKIPPED.has(node.type)) return;
    const rel = relative(node.relativeTransform);
    // A group's children: relative to the group, or to the group's own space? Whichever Figma's box agrees with.
    let abs = multiply(parentAbs, rel);
    if (SPACELESS.has(parent.type)) {
      const other = multiply(containerAbs, rel);
      if (bboxError(other, node) < bboxError(abs, node)) abs = other;
    }
    const id = drawpaneId(node.id);
    const w = Math.max(0, node.size?.x ?? node.absoluteBoundingBox?.width ?? 0);
    const h = Math.max(0, node.size?.y ?? node.absoluteBoundingBox?.height ?? 0);

    const props: Props = { name: node.name.slice(0, 256) };
    if (node.visible === false) props.visible = false;
    if (node.locked) props.locked = true;
    if (node.opacity !== undefined && node.opacity < 0.999)
      props.opacity = Math.round(node.opacity * 10_000) / 10_000;
    const blend = blendMode(node.blendMode);
    if (blend) props.blendMode = blend;
    const effects = convertEffects(node.effects, notes);
    if (effects.length > 0) props.effects = effects;
    if (node.isMask) {
      props.isMask = true;
      if (node.maskType === "LUMINANCE" || (node.maskType !== "VECTOR" && softMask(node)))
        notes.add("mask-alpha");
    }

    let type: NodeRecord["type"];
    const isGroup = node.type === "GROUP";
    if (FRAMES.has(node.type)) type = "frame";
    else if (isGroup) type = "group";
    else if (node.type === "RECTANGLE") type = "rect";
    else if (node.type === "ELLIPSE" && !isArc(node)) type = "ellipse";
    else if (node.type === "LINE") type = "line";
    else if (node.type === "TEXT") type = "text";
    else if (
      ["VECTOR", "STAR", "REGULAR_POLYGON", "BOOLEAN_OPERATION", "ELLIPSE"].includes(node.type)
    )
      type = "path";
    else {
      notes.add("unsupported-node");
      return;
    }

    if (type !== "group") {
      const box = boxIn(space, abs, w, h);
      if (box.skewed) notes.add("skewed");
      Object.assign(props, {
        x: box.x,
        y: box.y,
        width: round3(w),
        height: round3(h),
        ...(box.rotation !== 0 ? { rotation: box.rotation } : {}),
        ...(box.flipX ? { flipX: true } : {}),
      });
      Object.assign(props, childLayout(node, parent));
    }

    if (type !== "group" && type !== "text") {
      const fills = convertPaints(node.fills, images, notes);
      if (fills.length > 0 || type === "frame") props.fills = fills;
      Object.assign(props, strokeProps(node, type, images, notes));
    }
    if (type === "rect" || type === "frame") Object.assign(props, corners(node));
    if (type === "text") Object.assign(props, textProps(node, images, notes));
    if (type === "path") Object.assign(props, pathProps(node, notes));

    if (type === "frame") {
      props.clipContent = node.type === "SECTION" ? false : node.clipsContent === true;
      Object.assign(props, containerLayout(node));
      const grids = layoutGrids(node.layoutGrids);
      if (grids.length > 0) props.layoutGrids = grids;
      if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
        props[node.type === "COMPONENT" ? "isComponent" : "isComponentSet"] = true;
        if (
          node.componentPropertyDefinitions &&
          Object.keys(node.componentPropertyDefinitions).length > 0
        )
          notes.add("component-properties");
        if (node.type === "COMPONENT" && parent.type === "COMPONENT_SET") {
          const vp = variantProps(node.name);
          if (vp) props.variantProps = vp;
        }
      }
      if (node.type === "INSTANCE") {
        if (node.componentId && present.has(node.componentId)) {
          props.instanceOf = drawpaneId(node.componentId);
          instances.push(id);
        } else notes.add("library-component");
      }
    }
    // A layer inside an instance copies the main component's layer its id names.
    const mirrored = inInstance ? mirroredId(node.id) : null;
    if (mirrored && present.has(mirrored)) props.mirrors = drawpaneId(mirrored);

    add({ id, type, parent: parentId, key, props } as NodeRecord);
    if (type === "path" && node.type === "BOOLEAN_OPERATION") return;

    const children = node.children ?? [];
    if (children.length === 0) return;
    const keys = keysBetween(null, null, children.length);
    const childSpace = type === "frame" ? abs : space;
    const childContainer = SPACELESS.has(node.type) ? containerAbs : abs;
    const nowInInstance =
      inInstance || (node.type === "INSTANCE" && props.instanceOf !== undefined);
    children.forEach((child, i) => {
      visit(child, node, abs, childContainer, childSpace, id, keys[i] as string, nowInInstance);
    });
  };

  const pages = (file.document.children ?? []).filter((p) => p.type === "CANVAS");
  const pageKeys = keysBetween(null, null, pages.length);
  pages.forEach((page, i) => {
    const id = drawpaneId(page.id);
    const props: Props = { name: page.name.slice(0, 256) || "Page" };
    if (page.backgroundColor) props.backgroundColor = hexColor(page.backgroundColor, 1);
    add({ id, type: "page", parent: ROOT_ID, key: pageKeys[i] as string, props } as NodeRecord);
    const children = page.children ?? [];
    const keys = keysBetween(null, null, children.length);
    children.forEach((child, j) => {
      visit(child, page, IDENTITY, IDENTITY, IDENTITY, id, keys[j] as string, false);
    });
  });

  markOverrides(instances, nodes, byId);
  return { name: file.name, nodes, notes };
}

/** A mask Figma draws by its alpha that Drawpane's outline mask would draw differently. */
function softMask(node: Figma.Node): boolean {
  return (node.fills ?? []).some(
    (p) =>
      p.visible !== false &&
      (p.type !== "SOLID" || (p.opacity ?? 1) < 0.999 || (p.color?.a ?? 1) < 0.999),
  );
}

/** An ellipse cut into an arc or a ring: Drawpane draws those as paths. */
function isArc(node: Figma.Node): boolean {
  const a = node.arcData;
  if (!a) return false;
  const sweep = Math.abs(a.endingAngle - a.startingAngle);
  return a.innerRadius > 1e-6 || Math.abs(sweep - 2 * Math.PI) > 1e-4;
}

function corners(node: Figma.Node): Props {
  const radii = node.rectangleCornerRadii;
  if (radii && !radii.every((r) => r === radii[0]))
    return { cornerRadii: radii.map((r) => round3(Math.max(0, r))) };
  const r = radii?.[0] ?? node.cornerRadius ?? 0;
  return r > 0 ? { cornerRadius: round3(r) } : {};
}

const JOIN = { MITER: "miter", BEVEL: "bevel", ROUND: "round" } as const;
const CAP = { NONE: "none", ROUND: "round", SQUARE: "square" } as const;
const MARKERS: Readonly<Record<string, string>> = {
  LINE_ARROW: "arrow",
  ARROW_LINES: "arrow",
  TRIANGLE_ARROW: "triangle",
  TRIANGLE_FILLED: "triangle",
  ARROW_EQUILATERAL: "triangle",
  CIRCLE_FILLED: "circle",
  DIAMOND_FILLED: "diamond",
};

function strokeProps(
  node: Figma.Node,
  type: NodeRecord["type"],
  images: ImageLookup,
  notes: Notes,
): Props {
  const strokes = convertPaints(node.strokes, images, notes);
  if (strokes.length === 0) return {};
  const props: Props = { strokes };
  const sides = node.individualStrokeWeights;
  let weight = node.strokeWeight ?? 1;
  if (sides) {
    const all = [sides.top, sides.right, sides.bottom, sides.left];
    weight = Math.max(...all);
    if (!all.every((s) => s === all[0])) notes.add("stroke-sides");
  }
  props.strokeWeight = round3(Math.max(0, weight));
  if (node.strokeAlign && type !== "line")
    props.strokeAlign = node.strokeAlign === "CENTER" ? "center" : node.strokeAlign.toLowerCase();
  if (node.strokeJoin && node.strokeJoin in JOIN) props.strokeJoin = JOIN[node.strokeJoin];
  if (node.strokeDashes && node.strokeDashes.length > 0)
    props.strokeDashes = node.strokeDashes.slice(0, 16).map((d) => round3(Math.max(0, d)));
  if (type === "line" || type === "path") {
    const cap = node.strokeCap ?? "NONE";
    if (cap in CAP) props.strokeCap = CAP[cap as keyof typeof CAP];
    else if (MARKERS[cap]) props.markerEnd = MARKERS[cap];
  }
  return props;
}

/** A path from Figma's own geometry: its fill outline, or for an open vector, its network. */
function pathProps(node: Figma.Node, notes: Notes): Props {
  if (node.type === "BOOLEAN_OPERATION") notes.add("boolean-flattened");
  else if (node.type !== "VECTOR") notes.add("shape-flattened");
  const fill = node.fillGeometry ?? [];
  if (fill.length > 0) {
    const d = fill.map((g) => serializePath(parseSvgPath(g.path))).join(" ");
    return {
      pathData: d,
      windingRule: fill[0]?.windingRule === "EVENODD" ? "evenodd" : "nonzero",
    };
  }
  const network = (node as { vectorNetwork?: VectorNetwork }).vectorNetwork;
  if (network) return { pathData: networkPath(network) };
  const stroke = node.strokeGeometry ?? [];
  return { pathData: stroke.map((g) => serializePath(parseSvgPath(g.path))).join(" ") };
}

/** Figma's vector network (with `geometry=paths`): vertices joined by curved segments. */
interface VectorNetwork {
  readonly vertices: readonly { x: number; y: number }[];
  readonly segments: readonly {
    start: number;
    end: number;
    tangentStart?: { x: number; y: number };
    tangentEnd?: { x: number; y: number };
  }[];
}

/** A network's segments as path data, chained into subpaths where one ends where the next starts. */
export function networkPath(network: VectorNetwork): string {
  const n = (v: number) => String(round3(v));
  const parts: string[] = [];
  let at: number | null = null;
  for (const s of network.segments) {
    const a = network.vertices[s.start];
    const b = network.vertices[s.end];
    if (!a || !b) continue;
    if (at !== s.start) parts.push(`M${n(a.x)} ${n(a.y)}`);
    const t0 = s.tangentStart ?? { x: 0, y: 0 };
    const t1 = s.tangentEnd ?? { x: 0, y: 0 };
    if (t0.x === 0 && t0.y === 0 && t1.x === 0 && t1.y === 0) parts.push(`L${n(b.x)} ${n(b.y)}`);
    else
      parts.push(
        `C${n(a.x + t0.x)} ${n(a.y + t0.y)} ${n(b.x + t1.x)} ${n(b.y + t1.y)} ${n(b.x)} ${n(b.y)}`,
      );
    at = s.end;
  }
  return parts.join(" ");
}

/** Props an instance's layers don't carry from their main layer: what they override. */
const NOT_OVERRIDES = new Set([
  "name",
  "mirrors",
  "instanceOf",
  "overrides",
  "isComponent",
  "isComponentSet",
  "variantProps",
]);

/**
 * Marks what each instance's layers change from the main component's: the
 * props whose values differ, so syncing from the main leaves them be. The
 * instance's own box is its own, not an override.
 */
function markOverrides(
  instances: readonly string[],
  nodes: readonly NodeRecord[],
  byId: ReadonlyMap<string, NodeRecord>,
): void {
  const children = new Map<string, NodeRecord[]>();
  for (const n of nodes) {
    const list = children.get(n.parent);
    if (list) list.push(n);
    else children.set(n.parent, [n]);
  }
  const diff = (layer: NodeRecord, main: NodeRecord, root: boolean) => {
    const changed: string[] = [];
    const keys = new Set([...Object.keys(layer.props), ...Object.keys(main.props)]);
    for (const k of keys) {
      if (NOT_OVERRIDES.has(k) || (root && (k === "x" || k === "y"))) continue;
      const a = (layer.props as Props)[k];
      const b = (main.props as Props)[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k);
    }
    if (changed.length > 0) (layer.props as Props).overrides = changed.slice(0, 64);
  };
  for (const id of instances) {
    const root = byId.get(id);
    const mainId = (root?.props as Props | undefined)?.instanceOf as string | undefined;
    const main = mainId ? byId.get(mainId) : undefined;
    if (root && main) diff(root, main, true);
    const walk = (parent: string) => {
      for (const layer of children.get(parent) ?? []) {
        const mirror = (layer.props as Props).mirrors as string | undefined;
        const original = mirror ? byId.get(mirror) : undefined;
        if (original) diff(layer, original, false);
        walk(layer.id);
      }
    };
    walk(id);
  }
}
