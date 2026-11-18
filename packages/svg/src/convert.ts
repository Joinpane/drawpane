/**
 * An SVG document as Drawpane layers, the way Figma imports one: a frame the
 * size of the SVG holding its shapes as layers you can edit.
 *
 * `<g>` (and `<a>`, `<switch>`, nested `<svg>` and `<use>`) become groups,
 * `<rect>` rectangles, `<circle>` and `<ellipse>` ellipses, `<line>` lines,
 * `<path>`, `<polygon>` and `<polyline>` vectors, and `<text>` text. Every
 * layer sits in the frame's space, as Drawpane's do: an element's
 * transforms (its own, its groups', the viewBox's) end up in its box
 * (position, rotation, flip, size) where a box can say them, and are baked
 * into a vector's points where it can't (a skewed rectangle becomes a
 * vector, exactly).
 *
 * Paint and stroke come from the computed style (style.ts): presentation
 * attributes, `<style>` rules and `style=""`, inherited down the tree.
 * Clip paths and masks become Drawpane masks; filters that are shadows or
 * blurs become effects. What can't be carried over exactly is counted in
 * `notes`; scripts, event attributes, `foreignObject` and external
 * references are never read.
 */
import {
  apply,
  boxIn,
  boxMatrix,
  IDENTITY,
  type Matrix,
  multiply,
  parseSvgPath,
  pathBounds,
  type Segment,
  serializePath,
  transformPath,
} from "@drawpane/import-kit";
import type { Effect, LayerType, Paint, Props } from "@drawpane/model";
import { filterEffects } from "./effects";
import { Notes } from "./notes";
import { hrefNs, opacityOf, type PaintPlacement, PaintReader } from "./paint";
import { SvgProblem } from "./parse";
import { type Style, Styles } from "./style";
import { parseTransform, parseViewBox, viewBoxMatrix } from "./transform";
import { parseLength, parseNumbers, type Viewport } from "./units";

/** One converted layer and its children, props in the frame's space. */
export interface SvgLayer {
  readonly type: LayerType;
  readonly props: Props;
  readonly children?: readonly SvgLayer[];
}

export interface ConvertedSvg {
  /** A frame the size of the SVG, holding everything. */
  readonly root: SvgLayer;
  readonly notes: Notes;
  /** How many layers there are, the frame included. */
  readonly layerCount: number;
}

export interface ConvertOptions {
  /** The frame's name: the file's, or "SVG" for pasted markup. */
  readonly name?: string;
  /** Most layers to make before refusing, so a huge file fails with a reason. */
  readonly maxLayers?: number;
}

/** Most layers an SVG becomes. More than this is refused. */
export const SVG_MAX_LAYERS = 5000;

type MutableProps = Record<string, unknown>;
type Box = ReturnType<typeof boxIn>;

const round3 = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};
const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const scaleOf = (m: Matrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
/** Columns of a transform: their lengths, and whether they stay at right angles. */
function axes(m: Matrix): { sx: number; sy: number; orthogonal: boolean } {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  const dot = m[0] * m[2] + m[1] * m[3];
  return { sx, sy, orthogonal: sx > 1e-9 && sy > 1e-9 && Math.abs(dot) <= 1e-6 * sx * sy };
}

/** Elements that never draw by themselves: they're referenced, or they're metadata. */
const NOT_DRAWN = new Set([
  "defs",
  "symbol",
  "clipPath",
  "mask",
  "pattern",
  "marker",
  "linearGradient",
  "radialGradient",
  "filter",
  "style",
  "script",
  "title",
  "desc",
  "metadata",
  "font",
  "font-face",
  "cursor",
  "view",
  "animate",
  "animateMotion",
  "animateTransform",
  "set",
]);
const CONTAINERS = new Set(["g", "a", "switch", "svg"]);
const SHAPES = new Set(["rect", "circle", "ellipse", "line", "polyline", "polygon", "path"]);

/** A shape's geometry: its outline in the frame, and the native layer it can be, if any. */
interface Geometry {
  /** The outline, in the frame's space. */
  readonly segments: Segment[];
  /** Bounds in the element's own user space, for bounding-box units. */
  readonly bbox: { x: number; y: number; width: number; height: number } | null;
  /** A rectangle, ellipse or line the transforms leave as one (rotated or flipped at most). */
  readonly native:
    | { kind: "rect"; box: Box; radius: number }
    | { kind: "ellipse"; box: Box }
    | { kind: "line"; box: Box }
    | null;
  /** True for a polyline, line or open path: a shape whose ends take caps. */
  readonly open: boolean;
}

interface Context {
  /** The element's parent's user space onto the frame. */
  readonly ctm: Matrix;
  readonly style: Style;
  /** The nearest viewport, in user units, for percentages. */
  readonly viewport: Viewport;
  /** `<use>` elements being expanded, to stop a reference cycle. */
  readonly uses: ReadonlySet<Element>;
}

class Converter {
  readonly notes = new Notes();
  readonly #styles: Styles;
  readonly #ids = new Map<string, Element>();
  readonly #paints: PaintReader;
  readonly #frame: Viewport;
  readonly #maxLayers: number;
  #count = 1;

  constructor(root: Element, frame: Viewport, maxLayers: number) {
    this.#styles = new Styles(root);
    for (const el of root.getElementsByTagName("*")) {
      const id = el.getAttribute("id");
      if (id && !this.#ids.has(id)) this.#ids.set(id, el);
    }
    this.#paints = new PaintReader(this.#ids, this.#styles, this.notes);
    this.#frame = frame;
    this.#maxLayers = maxLayers;
  }

  get count(): number {
    return this.#count;
  }

  #counted(layer: SvgLayer): SvgLayer {
    this.#count++;
    if (this.#count > this.#maxLayers)
      throw new SvgProblem(
        `The SVG makes more than ${this.#maxLayers.toLocaleString("en-US")} layers, too many to edit. Simplify it first.`,
      );
    return layer;
  }

  /** The computed style of `el`, with its font size resolved to px for its children's ems. */
  style(el: Element, ctx: Context): Style {
    const style = this.#styles.compute(el, ctx.style) as Map<string, string>;
    const parentSize = fontSizeOf(ctx.style);
    const size = style.get("font-size");
    if (size !== undefined && size !== ctx.style.get("font-size")) {
      const px = fontSizeValue(size, parentSize, ctx.viewport);
      style.set("font-size", `${px}px`);
    }
    return style;
  }

  /** The element's referenced element by a `url(#id)` property, if local. */
  #ref(value: string | undefined): Element | null {
    if (!value) return null;
    const m = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/i.exec(value.trim());
    return m ? (this.#ids.get(m[1] as string) ?? null) : null;
  }

  /** Children of a container as layers, bottom first. */
  children(el: Element, ctx: Context): SvgLayer[] {
    const out: SvgLayer[] = [];
    const kids = [...el.children];
    // A switch draws its first child it can (Drawpane reads no feature tests: the first).
    const list =
      el.localName === "switch"
        ? kids.filter((k) => !NOT_DRAWN.has(k.localName)).slice(0, 1)
        : kids;
    for (const child of list) out.push(...this.element(child, ctx));
    return out;
  }

  /** One element as zero or more layers. */
  element(el: Element, ctx: Context): SvgLayer[] {
    const tag = el.localName;
    if (NOT_DRAWN.has(tag)) return [];
    if (tag === "image") {
      this.notes.add("image");
      return [];
    }
    if (tag === "foreignObject") {
      this.notes.add("foreign");
      return [];
    }
    const drawable = CONTAINERS.has(tag) || SHAPES.has(tag) || tag === "use" || tag === "text";
    if (!drawable) return [];
    const style = this.style(el, ctx);
    if (style.get("display") === "none") return [];
    const own = parseTransform(el.getAttribute("transform") ?? style.get("transform"));
    let ctm = multiply(ctx.ctm, own);
    let viewport = ctx.viewport;
    let inner: SvgLayer[];
    let geometry: Geometry | null = null;
    let leaf: SvgLayer | null = null;

    if (tag === "use") {
      const href = el.getAttribute("href") ?? hrefNs(el);
      const target = href?.startsWith("#") ? this.#ids.get(href.slice(1)) : undefined;
      if (!target || ctx.uses.has(el) || target.contains(el)) return [];
      const x = parseLength(el.getAttribute("x"), "x", viewport, fontSizeOf(style)) ?? 0;
      const y = parseLength(el.getAttribute("y"), "y", viewport, fontSizeOf(style)) ?? 0;
      ctm = multiply(ctm, translate(x, y));
      const uses = new Set(ctx.uses).add(el);
      const nextCtx: Context = { ctm, style, viewport, uses };
      if (target.localName === "symbol" || target.localName === "svg") {
        const placed = this.#viewportOf(target, el, nextCtx);
        inner = this.children(target, {
          ...nextCtx,
          ctm: multiply(ctm, placed.matrix),
          viewport: placed.viewport,
          style: this.style(target, nextCtx),
        });
      } else inner = this.element(target, nextCtx);
    } else if (CONTAINERS.has(tag)) {
      if (tag === "svg") {
        const placed = this.#viewportOf(el, el, { ...ctx, style });
        const x = parseLength(el.getAttribute("x"), "x", viewport, fontSizeOf(style)) ?? 0;
        const y = parseLength(el.getAttribute("y"), "y", viewport, fontSizeOf(style)) ?? 0;
        ctm = multiply(multiply(ctm, translate(x, y)), placed.matrix);
        viewport = placed.viewport;
      }
      inner = this.children(el, { ctm, style, viewport, uses: ctx.uses });
    } else if (tag === "text") {
      leaf = this.#text(el, style, ctm, viewport);
      inner = leaf ? [leaf] : [];
    } else {
      geometry = shapeGeometry(el, style, ctm, viewport);
      if (!geometry) return [];
      leaf = this.#shape(el, style, ctm, viewport, geometry);
      inner = leaf ? [leaf] : [];
    }
    if (inner.length === 0) return [];

    // What the element itself adds: its opacity, blend mode, effects, clip and mask.
    const decoration: MutableProps = {};
    const opacity = opacityOf(style.get("opacity"));
    if (opacity < 0.999) decoration.opacity = Math.round(opacity * 10_000) / 10_000;
    const blend = style.get("mix-blend-mode");
    // CSS's plus-lighter and plus-darker are Drawpane's linear dodge and burn.
    const mode = blend ? BLENDS.get(blend) : undefined;
    if (mode) decoration.blendMode = mode;
    const filter = style.get("filter");
    if (filter && filter !== "none") {
      const target = this.#ref(filter);
      const effects = target?.localName === "filter" ? filterEffects(target, scaleOf(ctm)) : null;
      if (effects) decoration.effects = effects satisfies Effect[];
      else this.notes.add("filter");
    }
    const masked = this.#maskLayer(el, style, ctm, viewport, geometry, ctx);
    // Clipped to the whole frame (Figma's export does that), which clips nothing the frame doesn't.
    const redundant = masked === "redundant";
    const mask = redundant ? null : masked;
    const name = nameOf(el);

    if (leaf && !mask) {
      Object.assign(leaf.props as MutableProps, decoration);
      return [leaf];
    }
    if (leaf && mask) {
      // The shape keeps its own look; a group holds it with its mask below.
      Object.assign(leaf.props as MutableProps, decoration);
      return [
        this.#counted({
          type: "group",
          props: { name: mask.wrapper } as Props,
          children: [mask.layer, leaf],
        }),
      ];
    }
    // A group: dropped when it's only a wrapper with nothing of its own.
    const plain = !mask && Object.keys(decoration).length === 0 && !name;
    if (plain && (inner.length === 1 || redundant)) return inner;
    // A wrapper for one layer's shadow or opacity (Figma writes `<g filter>` round a shape): the layer takes them.
    const single = inner.length === 1 ? (inner[0] as SvgLayer) : null;
    if (single && !mask && !name && absorbs(single, decoration)) return [single];
    const props: MutableProps = { name: name ?? (mask ? mask.wrapper : "Group"), ...decoration };
    return [
      this.#counted({
        type: "group",
        props: props as Props,
        children: mask ? [mask.layer, ...inner] : inner,
      }),
    ];
  }

  /** Where a `<symbol>` or nested `<svg>` puts its content: its viewBox in the box `sizer` gives it. */
  #viewportOf(el: Element, sizer: Element, ctx: Context): { matrix: Matrix; viewport: Viewport } {
    const fs = fontSizeOf(ctx.style);
    const w =
      parseLength(sizer.getAttribute("width"), "x", ctx.viewport, fs) ??
      parseLength(el.getAttribute("width"), "x", ctx.viewport, fs) ??
      ctx.viewport.width;
    const h =
      parseLength(sizer.getAttribute("height"), "y", ctx.viewport, fs) ??
      parseLength(el.getAttribute("height"), "y", ctx.viewport, fs) ??
      ctx.viewport.height;
    const box = parseViewBox(el.getAttribute("viewBox"));
    if (!box) return { matrix: IDENTITY, viewport: { width: w, height: h } };
    return {
      matrix: viewBoxMatrix(box, { width: w, height: h }, el.getAttribute("preserveAspectRatio")),
      viewport: { width: box.width, height: box.height },
    };
  }

  /** A shape element as a layer: native where the model has its kind, else a vector. */
  #shape(el: Element, style: Style, ctm: Matrix, viewport: Viewport, g: Geometry): SvgLayer | null {
    const dashes = this.#dashes(style, ctm, viewport);
    // Drawpane fits dashes to a box's sides; SVG runs them round the outline. A vector does that.
    const native = dashes.length > 0 && g.native?.kind !== "line" ? null : g.native;
    const props: MutableProps = {};
    let type: LayerType;
    let unit: Matrix | null;
    if (native) {
      const b = native.box;
      type = native.kind === "rect" ? "rect" : native.kind === "ellipse" ? "ellipse" : "line";
      Object.assign(props, {
        x: b.x,
        y: b.y,
        width: b.width,
        height: native.kind === "line" ? 0 : b.height,
        ...(b.rotation !== 0 ? { rotation: b.rotation } : {}),
        ...(b.flipX ? { flipX: true } : {}),
      });
      if (native.kind === "rect" && native.radius > 0) props.cornerRadius = round3(native.radius);
      const m = boxMatrix(IDENTITY, b);
      unit = b.width > 0 && b.height > 0 ? multiply(m, [b.width, 0, 0, b.height, 0, 0]) : null;
    } else {
      const bounds = pathBounds(g.segments);
      if (!bounds) return null;
      const local = transformPath(g.segments, translate(-bounds.x, -bounds.y));
      const d = serializePath(local);
      if (d.length > 2_000_000) {
        this.notes.add("too-long");
        return null;
      }
      type = "path";
      Object.assign(props, {
        x: round3(bounds.x),
        y: round3(bounds.y),
        width: round3(bounds.width),
        height: round3(bounds.height),
        pathData: d,
      });
      if (style.get("fill-rule") === "evenodd") props.windingRule = "evenodd";
      unit =
        bounds.width > 0 && bounds.height > 0
          ? [bounds.width, 0, 0, bounds.height, bounds.x, bounds.y]
          : null;
    }
    const placement: PaintPlacement = { ctm, bbox: g.bbox, unit, viewport };
    const fill =
      type === "line"
        ? null
        : this.#paints.read(
            style.get("fill") ?? "black",
            opacityOf(style.get("fill-opacity")),
            style,
            placement,
          );
    const stroke = this.#paints.read(
      style.get("stroke"),
      opacityOf(style.get("stroke-opacity")),
      style,
      placement,
    );
    props.fills = fill ? [fill] : [];
    if (stroke) Object.assign(props, this.#strokeProps(style, ctm, viewport, type, stroke, dashes));
    if (style.get("visibility") === "hidden" || style.get("visibility") === "collapse")
      props.visible = false;
    if (g.open || type === "path")
      for (const m of ["marker-start", "marker-mid", "marker-end"]) {
        const v = style.get(m);
        if (v && v !== "none" && this.#ref(v)) {
          this.notes.add("marker");
          break;
        }
      }
    props.name = nameOf(el) ?? DEFAULT_NAMES[type];
    return this.#counted({ type, props: props as Props });
  }

  /** A dash array in frame px (an odd list repeats, as the spec says), or none. */
  #dashes(style: Style, ctm: Matrix, viewport: Viewport): number[] {
    const text = style.get("stroke-dasharray");
    if (!text || text === "none") return [];
    const fs = fontSizeOf(style);
    const values = text
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((t) => parseLength(t, "other", viewport, fs));
    if (values.some((v) => v === null || v < 0)) return [];
    let list = values as number[];
    if (list.every((v) => v === 0)) return [];
    if (list.length % 2 === 1) list = [...list, ...list];
    const s = scaleOf(ctm);
    return list.slice(0, 16).map((v) => round3(v * s));
  }

  #strokeProps(
    style: Style,
    ctm: Matrix,
    viewport: Viewport,
    type: LayerType,
    stroke: Paint,
    dashes: number[],
  ): MutableProps {
    const props: MutableProps = { strokes: [stroke] };
    const fs = fontSizeOf(style);
    const width = parseLength(style.get("stroke-width") ?? "1", "other", viewport, fs) ?? 1;
    const nonScaling = style.get("vector-effect") === "non-scaling-stroke";
    const a = axes(ctm);
    if (!nonScaling && Math.abs(a.sx - a.sy) > 0.01 * Math.max(a.sx, a.sy))
      this.notes.add("stroke");
    props.strokeWeight = round3(Math.max(0, nonScaling ? width : width * scaleOf(ctm)));
    if (type !== "line") props.strokeAlign = "center";
    const join = style.get("stroke-linejoin");
    if (join === "round" || join === "bevel") props.strokeJoin = join;
    if (type === "line" || type === "path") {
      const cap = style.get("stroke-linecap");
      if (cap === "round" || cap === "square") props.strokeCap = cap;
    }
    if (dashes.length > 0) props.strokeDashes = dashes;
    const offset = Number.parseFloat(style.get("stroke-dashoffset") ?? "0");
    if (dashes.length > 0 && Number.isFinite(offset) && Math.abs(offset) > 1e-6)
      this.notes.add("dash-offset");
    return props;
  }

  /**
   * The mask a clip path or mask makes for an element, as the layer that goes
   * first in its group, or null when there's none or it changes nothing.
   */
  #maskLayer(
    el: Element,
    style: Style,
    ctm: Matrix,
    viewport: Viewport,
    geometry: Geometry | null,
    ctx: Context,
  ): { layer: SvgLayer; wrapper: string } | "redundant" | null {
    const clip = this.#ref(style.get("clip-path"));
    const mask = this.#ref(style.get("mask"));
    // Bounds for bounding-box units: the shape's, or a group's by its children's outlines.
    const bbox = () => geometry?.bbox ?? this.#userBounds(el, style, ctx);
    if (clip?.localName === "clipPath") {
      const units =
        clip.getAttribute("clipPathUnits") === "objectBoundingBox" ? unitsMatrix(bbox()) : IDENTITY;
      if (!units) return null;
      const space = multiply(multiply(ctm, units), parseTransform(clip.getAttribute("transform")));
      const outlines: Segment[][] = [];
      let evenodd = false;
      for (const child of clip.children) {
        const childStyle = this.style(child, { ...ctx, style });
        if (childStyle.get("display") === "none") continue;
        const target =
          child.localName === "use"
            ? this.#ids.get((child.getAttribute("href") ?? hrefNs(child) ?? "").slice(1))
            : child;
        if (!target || !SHAPES.has(target.localName)) {
          if (target && target.localName === "text") this.notes.add("clip");
          continue;
        }
        const own = multiply(space, parseTransform(child.getAttribute("transform")));
        const g = shapeGeometry(target, childStyle, own, viewport);
        if (!g) continue;
        if ((childStyle.get("clip-rule") ?? style.get("clip-rule")) === "evenodd") evenodd = true;
        outlines.push(g.segments);
        // The one shape: a native rectangle or ellipse when it can be.
        if (clip.children.length === 1 && g.native && g.native.kind !== "line") {
          const b = g.native.box;
          if (g.native.kind === "rect" && covers(b, this.#frame) && g.native.radius === 0)
            return "redundant";
          this.#count++;
          return {
            wrapper: "Clip group",
            layer: {
              type: g.native.kind === "rect" ? "rect" : "ellipse",
              props: {
                name: nameOf(clip) ?? "Clip path",
                x: b.x,
                y: b.y,
                width: b.width,
                height: b.height,
                ...(b.rotation !== 0 ? { rotation: b.rotation } : {}),
                ...(b.flipX ? { flipX: true } : {}),
                ...(g.native.kind === "rect" && g.native.radius > 0
                  ? { cornerRadius: round3(g.native.radius) }
                  : {}),
                fills: [{ type: "solid", color: "#000000" }],
                isMask: true,
              } as Props,
            },
          };
        }
      }
      if (clip.getAttribute("clip-path")) this.notes.add("clip");
      if (outlines.length === 0) {
        // Clipped to nothing: nothing shows. A zero-size mask says so.
        this.#count++;
        return {
          wrapper: "Clip group",
          layer: { type: "rect", props: { name: "Clip path", isMask: true, fills: [] } as Props },
        };
      }
      if (outlines.length > 1 && evenodd) this.notes.add("clip");
      return {
        wrapper: "Clip group",
        layer: this.#outlineMask(outlines, evenodd, nameOf(clip) ?? "Clip path", "outline"),
      };
    }
    if (mask?.localName === "mask") {
      const units =
        mask.getAttribute("maskContentUnits") === "objectBoundingBox"
          ? unitsMatrix(bbox())
          : IDENTITY;
      if (!units) return null;
      const alpha = (this.#styles.specified(mask).get("mask-type") ?? "luminance") === "alpha";
      const contentCtx: Context = {
        ctm: multiply(ctm, units),
        style: this.#styles.compute(mask, new Map()),
        viewport,
        uses: ctx.uses,
      };
      const before = this.#count;
      const layers = this.children(mask, contentCtx);
      const only = layers.length === 1 ? layers[0] : undefined;
      if (only && (only.type === "rect" || only.type === "ellipse" || only.type === "path")) {
        const fills = (only.props.fills ?? []) as Paint[];
        const white =
          fills.length === 1 &&
          fills[0]?.type === "solid" &&
          (fills[0].color === "#ffffff" || alpha) &&
          (fills[0].opacity ?? 1) >= 0.999 &&
          !only.props.strokes?.length &&
          (only.props.opacity ?? 1) >= 0.999;
        const props: MutableProps = { ...only.props, isMask: true, name: nameOf(mask) ?? "Mask" };
        if (!white) props.maskType = alpha ? "alpha" : "luminance";
        if (only.props.strokes?.length) this.notes.add("mask");
        return { wrapper: "Mask group", layer: { type: only.type, props: props as Props } };
      }
      // Several shapes, a group or text: their outlines together, as a clip.
      this.#count = before;
      this.notes.add("mask");
      const outlines: Segment[][] = [];
      const visit = (el: Element, m: Matrix, s: Style) => {
        for (const child of el.children) {
          const cs = this.style(child, { ...contentCtx, style: s });
          const cm = multiply(m, parseTransform(child.getAttribute("transform")));
          if (SHAPES.has(child.localName)) {
            const g = shapeGeometry(child, cs, cm, viewport);
            if (g) outlines.push(g.segments);
          } else if (CONTAINERS.has(child.localName)) visit(child, cm, cs);
        }
      };
      visit(mask, contentCtx.ctm, contentCtx.style);
      if (outlines.length === 0) return null;
      return {
        wrapper: "Mask group",
        layer: this.#outlineMask(outlines, false, nameOf(mask) ?? "Mask", "outline"),
      };
    }
    return null;
  }

  #outlineMask(
    outlines: Segment[][],
    evenodd: boolean,
    name: string,
    maskType: "outline",
  ): SvgLayer {
    const all = outlines.flat();
    const bounds = pathBounds(all) ?? { x: 0, y: 0, width: 0, height: 0 };
    this.#count++;
    return {
      type: "path",
      props: {
        name,
        x: round3(bounds.x),
        y: round3(bounds.y),
        width: round3(bounds.width),
        height: round3(bounds.height),
        pathData: serializePath(transformPath(all, translate(-bounds.x, -bounds.y))),
        ...(evenodd ? { windingRule: "evenodd" } : {}),
        fills: [{ type: "solid", color: "#000000" }],
        isMask: true,
        ...(maskType === "outline" ? {} : { maskType }),
      } as Props,
    };
  }

  /** A container's bounds in its own user space, from its shapes' outlines. */
  #userBounds(el: Element, style: Style, ctx: Context): Geometry["bbox"] {
    const all: Segment[] = [];
    const visit = (node: Element, m: Matrix, s: Style, depth: number) => {
      if (depth > 32) return;
      for (const child of node.children) {
        if (NOT_DRAWN.has(child.localName)) continue;
        const cs = this.style(child, { ...ctx, style: s });
        const cm = multiply(m, parseTransform(child.getAttribute("transform")));
        if (SHAPES.has(child.localName)) {
          const g = shapeGeometry(child, cs, cm, ctx.viewport);
          if (g) all.push(...g.segments);
        } else if (CONTAINERS.has(child.localName)) visit(child, cm, cs, depth + 1);
      }
    };
    visit(el, IDENTITY, style, 0);
    return pathBounds(all);
  }

  /** A `<text>` as a text layer: its words, font and paint, placed by its baseline and anchor. */
  #text(el: Element, style: Style, ctm: Matrix, viewport: Viewport): SvgLayer | null {
    const lines: string[] = [];
    let current = "";
    let positioned = false;
    let firstX: number | null = null;
    let firstY: number | null = null;
    const fs = fontSizeOf(style);
    const readXY = (node: Element) => {
      const x = parseNumbers(node.getAttribute("x"))[0];
      const y = parseNumbers(node.getAttribute("y"))[0];
      if (firstX === null && x !== undefined)
        firstX = parseLength(node.getAttribute("x")?.split(/[\s,]+/)[0], "x", viewport, fs);
      if (firstY === null && y !== undefined)
        firstY = parseLength(node.getAttribute("y")?.split(/[\s,]+/)[0], "y", viewport, fs);
      return { x, y };
    };
    readXY(el);
    const walk = (node: Element, depth: number) => {
      if (depth > 8) return;
      for (const child of node.childNodes) {
        if (child.nodeType === 3) current += child.textContent ?? "";
        else if (child.nodeType === 1) {
          const c = child as Element;
          if (c.localName === "textPath") {
            positioned = true;
            walk(c, depth + 1);
          } else if (c.localName === "tspan" || c.localName === "a") {
            const { x, y } = readXY(c);
            const dy = parseNumbers(c.getAttribute("dy"))[0];
            if ((y !== undefined || (dy !== undefined && dy !== 0)) && current.trim()) {
              lines.push(current);
              current = "";
            } else if (x !== undefined && current.trim()) positioned = true;
            if (c.getAttribute("dx") || c.getAttribute("rotate")) positioned = true;
            walk(c, depth + 1);
          }
        }
      }
    };
    walk(el, 0);
    lines.push(current);
    const preserve = el.getAttribute("xml:space") === "preserve";
    const text = lines
      .map((l) => (preserve ? l.replace(/[\n\t]/g, " ") : l.replace(/\s+/g, " ").trim()))
      .filter((l) => l.length > 0)
      .join("\n");
    if (!text) return null;
    if (positioned) this.notes.add("text");

    const a = axes(ctm);
    if (!a.orthogonal || Math.abs(a.sx - a.sy) > 0.01 * Math.max(a.sx, a.sy))
      this.notes.add("text");
    const s = scaleOf(ctm);
    const size = Math.min(4096, Math.max(1, fs * s));
    const anchor = style.get("text-anchor") ?? "start";
    const count = text.split("\n").length;
    const longest = Math.max(...text.split("\n").map((l) => l.length));
    // A box wide enough for the line, so an anchored line stays where its anchor is.
    const width = anchor === "start" ? 0 : (longest * 0.6 + 2) * fs * 1.5;
    const ux = (firstX ?? 0) - (anchor === "middle" ? width / 2 : anchor === "end" ? width : 0);
    // The first baseline is at y; the line's top is about an ascent above it.
    const uy = (firstY ?? 0) - fs * 0.93;
    const height = fs * 1.25 * count;
    const world = multiply(multiply(ctm, translate(ux, uy)), [1 / s, 0, 0, 1 / s, 0, 0]);
    const box = boxIn(IDENTITY, world, width * s, height * s);
    const props: MutableProps = {
      characters: text.slice(0, 200_000),
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      ...(box.rotation !== 0 ? { rotation: box.rotation } : {}),
      ...(box.flipX ? { flipX: true } : {}),
      fontSize: round3(size),
      textAutoResize: anchor === "start" ? "width" : "height",
      ...(anchor === "middle"
        ? { textAlign: "center" }
        : anchor === "end"
          ? { textAlign: "right" }
          : {}),
    };
    const family = fontFamily(style.get("font-family"));
    if (family) props.fontFamily = family;
    const weight = fontWeight(style.get("font-weight"));
    if (weight !== 400) props.fontWeight = weight;
    const fontStyle = style.get("font-style");
    if (fontStyle === "italic" || fontStyle === "oblique") props.fontStyle = "italic";
    const spacing = parseLength(style.get("letter-spacing"), "x", viewport, fs);
    if (spacing) props.letterSpacing = { unit: "px", value: round3(spacing * s) };
    const decoration = style.get("text-decoration") ?? "";
    if (decoration.includes("underline")) props.textDecoration = "underline";
    else if (decoration.includes("line-through")) props.textDecoration = "strikethrough";
    const placement: PaintPlacement = {
      ctm,
      bbox: { x: ux, y: uy, width: Math.max(1, width || longest * fs * 0.6), height },
      unit: [box.width || 1, 0, 0, box.height || 1, box.x, box.y],
      viewport,
    };
    const fill = this.#paints.read(
      style.get("fill") ?? "black",
      opacityOf(style.get("fill-opacity")),
      style,
      placement,
    );
    props.fills = fill ? [fill] : [];
    const stroke = this.#paints.read(
      style.get("stroke"),
      opacityOf(style.get("stroke-opacity")),
      style,
      placement,
    );
    if (stroke) {
      props.strokes = [stroke];
      props.strokeWeight = round3(
        (parseLength(style.get("stroke-width") ?? "1", "other", viewport, fs) ?? 1) * s,
      );
      props.strokeAlign = "center";
    }
    if (style.get("visibility") === "hidden") props.visible = false;
    const name = nameOf(el);
    if (name) props.name = name;
    return this.#counted({ type: "text", props: props as Props });
  }
}

const BLENDS = new Map<string, string>([
  ["plus-lighter", "linear-dodge"],
  ["plus-darker", "linear-burn"],
  ...[
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "color-dodge",
    "color-burn",
    "hard-light",
    "soft-light",
    "difference",
    "exclusion",
    "hue",
    "saturation",
    "color",
    "luminosity",
  ].map((m) => [m, m] as const),
]);

const DEFAULT_NAMES: Readonly<Record<LayerType, string>> = {
  frame: "Frame",
  group: "Group",
  rect: "Rectangle",
  ellipse: "Ellipse",
  polygon: "Polygon",
  star: "Star",
  line: "Line",
  path: "Vector",
  text: "Text",
};

/**
 * Moves a wrapper group's opacity, blend mode and effects onto its only
 * layer when that changes nothing: opacities multiply, and the layer has no
 * blend mode or effects of its own. False (and nothing moved) otherwise.
 */
function absorbs(layer: SvgLayer, decoration: MutableProps): boolean {
  const props = layer.props as MutableProps;
  if (decoration.blendMode && props.blendMode) return false;
  if (decoration.effects && props.effects) return false;
  // A group's blur blurs a mask with what it masks: a masked group keeps it.
  if (decoration.effects && layer.type === "group") return false;
  if (decoration.opacity !== undefined)
    props.opacity =
      Math.round(
        (decoration.opacity as number) * ((props.opacity as number | undefined) ?? 1) * 10_000,
      ) / 10_000;
  if (decoration.blendMode) props.blendMode = decoration.blendMode;
  if (decoration.effects) props.effects = decoration.effects;
  return true;
}

/** A rectangle that covers the whole frame (so clipping to it changes nothing there). */
function covers(b: Box, frame: Viewport): boolean {
  return (
    b.rotation === 0 &&
    b.x <= 0.01 &&
    b.y <= 0.01 &&
    b.x + b.width >= frame.width - 0.01 &&
    b.y + b.height >= frame.height - 0.01
  );
}

/** Bounding-box units as a matrix, or null when the box has no size (nothing shows). */
function unitsMatrix(b: Geometry["bbox"]): Matrix | null {
  if (!b || b.width <= 0 || b.height <= 0) return null;
  return [b.width, 0, 0, b.height, b.x, b.y];
}

/** The name an editor gave the element: Illustrator's data-name, Inkscape's label, its id, or its title. */
function nameOf(el: Element): string | null {
  const title = [...el.children].find((c) => c.localName === "title")?.textContent?.trim();
  const name =
    el.getAttribute("data-name") ??
    el.getAttributeNS("http://www.inkscape.org/namespaces/inkscape", "label") ??
    el.getAttribute("inkscape:label") ??
    (title || null) ??
    el.getAttribute("id");
  const clean = name?.trim().replace(/\s+/g, " ").slice(0, 256);
  return clean ? clean : null;
}

export function fontSizeOf(style: Style): number {
  const v = style.get("font-size");
  const n = v ? Number.parseFloat(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 16;
}

const FONT_KEYWORDS: Readonly<Record<string, number>> = {
  "xx-small": 9,
  "x-small": 10,
  small: 13,
  medium: 16,
  large: 18,
  "x-large": 24,
  "xx-large": 32,
};

function fontSizeValue(text: string, parent: number, viewport: Viewport): number {
  const keyword = FONT_KEYWORDS[text.trim().toLowerCase()];
  if (keyword) return keyword;
  if (text.trim().endsWith("%")) return (Number.parseFloat(text) / 100) * parent || parent;
  return parseLength(text, "other", viewport, parent) ?? parent;
}

const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "-apple-system",
  "blinkmacsystemfont",
]);

/** The first family named in a font-family list, unless it's a generic one (Drawpane's default then). */
function fontFamily(value: string | undefined): string | null {
  if (!value) return null;
  const first = value
    .split(",")[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
  if (!first || GENERIC.has(first.toLowerCase())) return null;
  return first.slice(0, 128);
}

function fontWeight(value: string | undefined): number {
  if (!value || value === "normal") return 400;
  if (value === "bold" || value === "bolder") return 700;
  if (value === "lighter") return 300;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(1000, Math.max(1, n)) : 400;
}

/** Rounded-rectangle corners: SVG's rules for rx and ry when one or both are missing. */
function radii(
  el: Element,
  w: number,
  h: number,
  viewport: Viewport,
  fs: number,
): [number, number] {
  const rxText = el.getAttribute("rx");
  const ryText = el.getAttribute("ry");
  let rx = rxText && rxText !== "auto" ? parseLength(rxText, "x", viewport, fs) : null;
  let ry = ryText && ryText !== "auto" ? parseLength(ryText, "y", viewport, fs) : null;
  if (rx === null) rx = ry;
  if (ry === null) ry = rx;
  return [Math.min(Math.max(0, rx ?? 0), w / 2), Math.min(Math.max(0, ry ?? 0), h / 2)];
}

const KAPPA = 0.5522847498307936;

/** An ellipse's outline, as SVG starts it: at the right, going clockwise. */
function ellipseSegments(cx: number, cy: number, rx: number, ry: number): Segment[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { c: "M", p: { x: cx + rx, y: cy } },
    {
      c: "C",
      c1: { x: cx + rx, y: cy + ky },
      c2: { x: cx + kx, y: cy + ry },
      p: { x: cx, y: cy + ry },
    },
    {
      c: "C",
      c1: { x: cx - kx, y: cy + ry },
      c2: { x: cx - rx, y: cy + ky },
      p: { x: cx - rx, y: cy },
    },
    {
      c: "C",
      c1: { x: cx - rx, y: cy - ky },
      c2: { x: cx - kx, y: cy - ry },
      p: { x: cx, y: cy - ry },
    },
    {
      c: "C",
      c1: { x: cx + kx, y: cy - ry },
      c2: { x: cx + rx, y: cy - ky },
      p: { x: cx + rx, y: cy },
    },
    { c: "Z" },
  ];
}

/** A rectangle's outline as SVG draws it: from the top edge after the first corner, clockwise. */
function rectSegments(
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  ry: number,
): Segment[] {
  if (rx <= 0 || ry <= 0)
    return [
      { c: "M", p: { x, y } },
      { c: "L", p: { x: x + w, y } },
      { c: "L", p: { x: x + w, y: y + h } },
      { c: "L", p: { x, y: y + h } },
      { c: "Z" },
    ];
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const r = x + w;
  const b = y + h;
  return [
    { c: "M", p: { x: x + rx, y } },
    { c: "L", p: { x: r - rx, y } },
    { c: "C", c1: { x: r - rx + kx, y }, c2: { x: r, y: y + ry - ky }, p: { x: r, y: y + ry } },
    { c: "L", p: { x: r, y: b - ry } },
    { c: "C", c1: { x: r, y: b - ry + ky }, c2: { x: r - rx + kx, y: b }, p: { x: r - rx, y: b } },
    { c: "L", p: { x: x + rx, y: b } },
    { c: "C", c1: { x: x + rx - kx, y: b }, c2: { x, y: b - ry + ky }, p: { x, y: b - ry } },
    { c: "L", p: { x, y: y + ry } },
    { c: "C", c1: { x, y: y + ry - ky }, c2: { x: x + rx - kx, y }, p: { x: x + rx, y } },
    { c: "Z" },
  ];
}

/** The native box a transform leaves a w × h box at (x, y) in, if it stays a box. */
function nativeBox(
  ctm: Matrix,
  x: number,
  y: number,
  w: number,
  h: number,
): { box: Box; sx: number; sy: number } | null {
  const a = axes(ctm);
  if (!a.orthogonal) return null;
  const world = multiply(multiply(ctm, translate(x, y)), [1 / a.sx, 0, 0, 1 / a.sy, 0, 0]);
  return { box: boxIn(IDENTITY, world, w * a.sx, h * a.sy), sx: a.sx, sy: a.sy };
}

/** A shape element's geometry, or null when it draws nothing (a zero size, no points). */
export function shapeGeometry(
  el: Element,
  style: Style,
  ctm: Matrix,
  viewport: Viewport,
): Geometry | null {
  const fs = fontSizeOf(style);
  const len = (name: string, axis: "x" | "y" | "other") =>
    parseLength(el.getAttribute(name), axis, viewport, fs) ?? 0;
  const done = (user: Segment[], native: Geometry["native"], open: boolean): Geometry | null => {
    if (user.length === 0) return null;
    return { segments: transformPath(user, ctm), bbox: pathBounds(user), native, open };
  };
  switch (el.localName) {
    case "rect": {
      const x = len("x", "x");
      const y = len("y", "y");
      const w = len("width", "x");
      const h = len("height", "y");
      if (w <= 0 || h <= 0) return null;
      const [rx, ry] = radii(el, w, h, viewport, fs);
      const n = nativeBox(ctm, x, y, w, h);
      let native: Geometry["native"] = null;
      if (n && Math.abs(rx * n.sx - ry * n.sy) <= 0.01)
        native = { kind: "rect", box: n.box, radius: rx * n.sx };
      return done(rectSegments(x, y, w, h, rx, ry), native, false);
    }
    case "circle":
    case "ellipse": {
      const cx = len("cx", "x");
      const cy = len("cy", "y");
      let rx: number;
      let ry: number;
      if (el.localName === "circle") rx = ry = len("r", "other");
      else {
        const rxa = el.getAttribute("rx");
        const rya = el.getAttribute("ry");
        rx = rxa && rxa !== "auto" ? len("rx", "x") : len("ry", "y");
        ry = rya && rya !== "auto" ? len("ry", "y") : rx;
      }
      if (rx <= 0 || ry <= 0) return null;
      const n = nativeBox(ctm, cx - rx, cy - ry, rx * 2, ry * 2);
      return done(
        ellipseSegments(cx, cy, rx, ry),
        n ? { kind: "ellipse", box: n.box } : null,
        false,
      );
    }
    case "line": {
      const p1 = { x: len("x1", "x"), y: len("y1", "y") };
      const p2 = { x: len("x2", "x"), y: len("y2", "y") };
      const user: Segment[] = [
        { c: "M", p: p1 },
        { c: "L", p: p2 },
      ];
      const a = apply(ctm, p1);
      const b = apply(ctm, p2);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1e-9) return null;
      const cos = (b.x - a.x) / length;
      const sin = (b.y - a.y) / length;
      const box = boxIn(IDENTITY, [cos, sin, -sin, cos, a.x, a.y], length, 0);
      return done(user, { kind: "line", box }, true);
    }
    case "polyline":
    case "polygon": {
      const n = parseNumbers(el.getAttribute("points"));
      const user: Segment[] = [];
      for (let i = 0; i + 1 < n.length; i += 2)
        user.push({ c: i === 0 ? "M" : "L", p: { x: n[i] as number, y: n[i + 1] as number } });
      if (user.length < 2) return null;
      if (el.localName === "polygon") user.push({ c: "Z" });
      return done(user, null, el.localName === "polyline");
    }
    case "path": {
      const user = parseSvgPath(el.getAttribute("d") ?? "");
      const open = user.some(
        (s, i) => s.c !== "Z" && (user[i + 1] === undefined || user[i + 1]?.c === "M"),
      );
      return done(user, null, open);
    }
    default:
      return null;
  }
}

/** The SVG's own size: width and height, else its viewBox's, else 300 × 150 as browsers do. */
export function svgSize(root: Element): Viewport & { viewBox: ReturnType<typeof parseViewBox> } {
  const viewBox = parseViewBox(root.getAttribute("viewBox"));
  const base = viewBox ?? { width: 300, height: 150 };
  const read = (name: "width" | "height", axis: "x" | "y") => {
    const text = root.getAttribute(name);
    if (!text || text.trim().endsWith("%") || text === "auto") return null;
    const n = parseLength(text, axis, base);
    return n !== null && n > 0 ? n : null;
  };
  let width = read("width", "x");
  let height = read("height", "y");
  // One side given: the other follows the viewBox's proportions.
  if (width === null && height !== null && viewBox)
    width = (height * viewBox.width) / viewBox.height;
  if (height === null && width !== null && viewBox)
    height = (width * viewBox.height) / viewBox.width;
  return { width: width ?? base.width, height: height ?? base.height, viewBox };
}

/** The parsed root `<svg>` element as a frame of layers. */
export function convertSvg(root: Element, options: ConvertOptions = {}): ConvertedSvg {
  const size = svgSize(root);
  const frame = { width: size.width, height: size.height };
  const converter = new Converter(root, frame, options.maxLayers ?? SVG_MAX_LAYERS);
  const matrix = size.viewBox
    ? viewBoxMatrix(size.viewBox, frame, root.getAttribute("preserveAspectRatio"))
    : IDENTITY;
  const rootCtx: Context = {
    ctm: IDENTITY,
    style: new Map(),
    viewport: size.viewBox ?? frame,
    uses: new Set(),
  };
  const style = converter.style(root, rootCtx);
  const children = converter.children(root, {
    ctm: multiply(matrix, parseTransform(root.getAttribute("transform"))),
    style,
    viewport: size.viewBox ?? frame,
    uses: new Set(),
  });
  const props: MutableProps = {
    name: (options.name ?? nameOf(root) ?? "SVG").slice(0, 256),
    x: 0,
    y: 0,
    width: round3(frame.width),
    height: round3(frame.height),
    fills: [],
  };
  const opacity = opacityOf(style.get("opacity"));
  if (opacity < 0.999) props.opacity = Math.round(opacity * 10_000) / 10_000;
  return {
    root: { type: "frame", props: props as Props, children },
    notes: converter.notes,
    layerCount: converter.count,
  };
}
