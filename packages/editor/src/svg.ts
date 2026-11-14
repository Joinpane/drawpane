/**
 * SVG export for simple layers.
 *
 * Covered: rectangles (with one or four corner radii), ellipses, polygons and
 * stars, lines and paths (with their winding rule and end markers), text as `<text>` with one `<tspan>` per line,
 * frames as `<g>` (clipped with a `<clipPath>` when they clip content) and
 * groups. Each layer keeps its rotation and flips (as a transform matrix),
 * its opacity and blend mode, solid and gradient fills (one element per
 * paint, bottom first; angular gradients as a pattern of fine wedges), and solid or gradient strokes with weight, position
 * (inside and outside are emulated with a clip path or mask), dashes, joins
 * and caps.
 *
 * Image fills are drawn when the caller supplies the image (`options.images`:
 * a URL, such as a data: URL for a self-contained file, and its natural
 * size), placed by their scale mode and clipped to the layer's shape.
 *
 * Drop and inner shadows (with spread, as the canvas casts them) and layer
 * blur are SVG filters in page space, so a rotated layer's shadow still
 * falls the way it does on the canvas. A layer blur blurs the whole layer,
 * children, strokes and shadows included, as on the canvas and in Figma.
 *
 * Not covered yet:
 * - image fills without a supplied image, and image strokes (left out)
 * - background blur (SVG can't blur what's behind an element)
 * - per-paint blend modes on strokes
 * - text that depends on fonts the viewer lacks: text stays live, so it
 *   renders in whatever font the viewing app has (outlining comes later)
 * - auto layout: positions are exported as they are on the canvas, not as
 *   flexbox
 */
import { getProp, type NodeRecord, type Paint, type Props } from "@drawpane/model";
import { exportBounds } from "./export";
import { type Matrix, type Rect, round2 } from "./geometry";
import { FULL_CROP, imagePlacement } from "./images";
import { markersOf, trimmedStroke } from "./markers";
import { hasMask, maskScopes } from "./masks";
import { textSpans } from "./rich-text";
import type { Scene } from "./scene";
import {
  layoutText,
  lineOffset,
  type ShapedText,
  type TextFragment,
  type TextMeasurer,
  textBlockOffset,
} from "./text";
import { nodePath } from "./vector/shapes";
import { serializePath } from "./vector/svg";

const BLEND_CSS = new Set([
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
]);

/** Numbers as short as they can be without visible loss. */
export function svgNumber(n: number): string {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? "0" : String(v);
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function transformAttr(m: Matrix): string {
  const [a, b, c, d, e, f] = m;
  if (a === 1 && b === 0 && c === 0 && d === 1) {
    if (e === 0 && f === 0) return "";
    return ` transform="translate(${svgNumber(e)} ${svgNumber(f)})"`;
  }
  return ` transform="matrix(${m.map(svgNumber).join(" ")})"`;
}

/** `#rrggbbaa` → colour and alpha. */
function splitColor(hex: string): { color: string; alpha: number } {
  return {
    color: hex.slice(0, 7),
    alpha: hex.length === 9 ? Number.parseInt(hex.slice(7, 9), 16) / 255 : 1,
  };
}

const attr = (name: string, value: string | number) =>
  ` ${name}="${typeof value === "number" ? svgNumber(value) : escapeXml(value)}"`;

/** Wedges in an exported angular gradient: two per degree. */
const ANGULAR_WEDGES = 180;

/** The colour at `t` (0–1) along gradient stops, interpolated in sRGB with alpha. */
export function stopColorAt(
  stops: ReadonlyArray<{ position: number; color: string }>,
  t: number,
): string {
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const first = sorted[0];
  if (!first) return "#000000";
  const rgba = (hex: string) => {
    const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
    return [n(1), n(3), n(5), hex.length === 9 ? n(7) : 255];
  };
  if (t <= first.position) return first.color;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1] as (typeof sorted)[number];
    const b = sorted[i] as (typeof sorted)[number];
    if (t > b.position) continue;
    const k = b.position === a.position ? 0 : (t - a.position) / (b.position - a.position);
    const ca = rgba(a.color);
    const cb = rgba(b.color);
    const mix = ca.map((v, j) => Math.round(v + ((cb[j] as number) - v) * k));
    const hex = (v: number) => v.toString(16).padStart(2, "0");
    return `#${hex(mix[0] as number)}${hex(mix[1] as number)}${hex(mix[2] as number)}${mix[3] === 255 ? "" : hex(mix[3] as number)}`;
  }
  return (sorted.at(-1) as (typeof sorted)[number]).color;
}

class SvgWriter {
  readonly defs: string[] = [];
  readonly body: string[] = [];
  #ids = 0;

  id(prefix: string): string {
    return `${prefix}${++this.#ids}`;
  }

  /** `fill`/`stroke` attributes for a paint, or null when SVG export can't express it. */
  paint(kind: "fill" | "stroke", paint: Paint, w: number, h: number): string | null {
    const opacity = paint.opacity ?? 1;
    if (paint.type === "solid") {
      const { color, alpha } = splitColor(paint.color);
      const a = alpha * opacity;
      return `${attr(kind, color)}${a < 1 ? attr(`${kind}-opacity`, a) : ""}`;
    }
    if (paint.type === "angular") {
      // SVG has no conic gradient: a pattern of thin wedges, each the colour
      // at its middle, reads the same at any size people export.
      const id = this.id("angular");
      const cx = paint.from.x * w;
      const cy = paint.from.y * h;
      const start = Math.atan2(paint.to.y * h - cy, paint.to.x * w - cx);
      const r = Math.max(
        Math.hypot(cx, cy),
        Math.hypot(w - cx, cy),
        Math.hypot(cx, h - cy),
        Math.hypot(w - cx, h - cy),
        1,
      );
      const wedges: string[] = [];
      const n = ANGULAR_WEDGES;
      // Each wedge overlaps the next by a hair so no seams show.
      const overlap = (Math.PI * 2) / n / 4;
      for (let i = 0; i < n; i++) {
        const a0 = start + (i / n) * Math.PI * 2;
        const a1 = start + ((i + 1) / n) * Math.PI * 2 + overlap;
        const { color, alpha } = splitColor(stopColorAt(paint.stops, (i + 0.5) / n));
        const d = `M${svgNumber(cx)} ${svgNumber(cy)}L${svgNumber(cx + Math.cos(a0) * r)} ${svgNumber(cy + Math.sin(a0) * r)}L${svgNumber(cx + Math.cos(a1) * r)} ${svgNumber(cy + Math.sin(a1) * r)}Z`;
        wedges.push(
          `<path d="${d}"${attr("fill", color)}${alpha < 1 ? attr("fill-opacity", alpha) : ""}/>`,
        );
      }
      this.defs.push(
        `<pattern id="${id}" patternUnits="userSpaceOnUse"${attr("width", Math.max(w, 1))}${attr("height", Math.max(h, 1))}>${wedges.join("")}</pattern>`,
      );
      return ` ${kind}="url(#${id})"${opacity < 1 ? attr(`${kind}-opacity`, opacity) : ""}`;
    }
    if (paint.type === "linear" || paint.type === "radial") {
      const id = this.id("gradient");
      const fx = paint.from.x * w;
      const fy = paint.from.y * h;
      const tx = paint.to.x * w;
      const ty = paint.to.y * h;
      const stops = paint.stops
        .map((s) => {
          const { color, alpha } = splitColor(s.color);
          return `<stop${attr("offset", s.position)}${attr("stop-color", color)}${alpha < 1 ? attr("stop-opacity", alpha) : ""}/>`;
        })
        .join("");
      this.defs.push(
        paint.type === "linear"
          ? `<linearGradient id="${id}" gradientUnits="userSpaceOnUse"${attr("x1", fx)}${attr("y1", fy)}${attr("x2", tx)}${attr("y2", ty)}>${stops}</linearGradient>`
          : `<radialGradient id="${id}" gradientUnits="userSpaceOnUse"${attr("cx", fx)}${attr("cy", fy)}${attr("r", Math.hypot(tx - fx, ty - fy))}>${stops}</radialGradient>`,
      );
      return ` ${kind}="url(#${id})"${opacity < 1 ? attr(`${kind}-opacity`, opacity) : ""}`;
    }
    return null;
  }
}

/** The layer's outline in its own box coordinates, as an element name and its geometry attributes. */
function shapeOf(node: NodeRecord, w: number, h: number): { tag: string; attrs: string } | null {
  switch (node.type) {
    case "ellipse":
      return {
        tag: "ellipse",
        attrs: `${attr("cx", w / 2)}${attr("cy", h / 2)}${attr("rx", w / 2)}${attr("ry", h / 2)}`,
      };
    case "line":
      return {
        tag: "line",
        attrs: `${attr("x1", 0)}${attr("y1", h / 2)}${attr("x2", w)}${attr("y2", h / 2)}`,
      };
    case "polygon":
    case "star": {
      const outline = nodePath(node);
      return outline ? { tag: "path", attrs: attr("d", serializePath(outline)) } : null;
    }
    case "path": {
      const rule = getProp(node.props, "windingRule");
      return {
        tag: "path",
        attrs: `${attr("d", getProp(node.props, "pathData"))}${rule === "evenodd" ? attr("fill-rule", "evenodd") : ""}`,
      };
    }
    case "rect":
    case "frame": {
      const max = Math.min(w, h) / 2;
      const radii = getProp(node.props, "cornerRadii");
      if (radii?.some((r) => r > 0)) {
        const [tl = 0, tr = 0, br = 0, bl = 0] = radii.map((r) => Math.min(r, max));
        const corners: Corners = [tl, tr, br, bl];
        return { tag: "path", attrs: attr("d", roundedRectPath(0, 0, w, h, corners)) };
      }
      const r = Math.min(getProp(node.props, "cornerRadius"), max);
      return {
        tag: "rect",
        attrs: `${attr("width", w)}${attr("height", h)}${r > 0 ? attr("rx", r) : ""}`,
      };
    }
    default:
      return null;
  }
}

type Corners = readonly [tl: number, tr: number, br: number, bl: number];

/** A rectangle at (x, y) with its own radius per corner, as path data. */
function roundedRectPath(x: number, y: number, w: number, h: number, corners: Corners): string {
  const [tl, tr, br, bl] = corners;
  const n = svgNumber;
  return [
    `M${n(x + tl)} ${n(y)}`,
    `H${n(x + w - tr)}`,
    tr ? `A${n(tr)} ${n(tr)} 0 0 1 ${n(x + w)} ${n(y + tr)}` : "",
    `V${n(y + h - br)}`,
    br ? `A${n(br)} ${n(br)} 0 0 1 ${n(x + w - br)} ${n(y + h)}` : "",
    `H${n(x + bl)}`,
    bl ? `A${n(bl)} ${n(bl)} 0 0 1 ${n(x)} ${n(y + h - bl)}` : "",
    `V${n(y + tl)}`,
    tl ? `A${n(tl)} ${n(tl)} 0 0 1 ${n(x + tl)} ${n(y)}` : "",
    "Z",
  ]
    .filter(Boolean)
    .join("");
}

/**
 * The shape grown (or shrunk, for negative spread) by `spread` on every
 * side, as the canvas renderer casts shadows: exact for rectangles, frames
 * and ellipses; other shapes keep their outline, as Figma does.
 */
function spreadShapeOf(
  node: NodeRecord,
  w: number,
  h: number,
  spread: number,
): { tag: string; attrs: string } | null {
  if (spread === 0) return shapeOf(node, w, h);
  const gw = Math.max(0, w + spread * 2);
  const gh = Math.max(0, h + spread * 2);
  if (node.type === "ellipse") {
    return {
      tag: "ellipse",
      attrs: `${attr("cx", w / 2)}${attr("cy", h / 2)}${attr("rx", gw / 2)}${attr("ry", gh / 2)}`,
    };
  }
  if (node.type === "rect" || node.type === "frame") {
    const max = Math.min(w, h) / 2;
    const grow = (v: number) => (v > 0 ? Math.max(0, Math.min(v, max) + spread) : 0);
    const r = getProp(node.props, "cornerRadius");
    const limit = Math.min(gw, gh) / 2;
    const [tl = 0, tr = 0, br = 0, bl = 0] = (
      getProp(node.props, "cornerRadii") ?? [r, r, r, r]
    ).map((v) => Math.min(grow(v), limit));
    const corners: Corners = [tl, tr, br, bl];
    return { tag: "path", attrs: attr("d", roundedRectPath(-spread, -spread, gw, gh, corners)) };
  }
  return shapeOf(node, w, h);
}

/** Page-space bounds of a box in a layer's own space, grown by `pad`: a filter's region. */
function regionAttrs(
  m: Matrix,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  pad: number,
): string {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ] as const) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  const left = Math.min(...xs) - pad;
  const top = Math.min(...ys) - pad;
  return `${attr("x", left)}${attr("y", top)}${attr("width", Math.max(...xs) + pad - left)}${attr("height", Math.max(...ys) + pad - top)}`;
}

/**
 * Serializes layers (and their children) as a standalone SVG document whose
 * viewBox is `bounds` in page coordinates. See the module comment for what
 * is and isn't covered.
 */
/** An image for an image fill: where to load it from, and its natural size in pixels. */
export interface SvgImageSource {
  readonly href: string;
  readonly width: number;
  readonly height: number;
}

export interface SvgExportOptions {
  /** Images by content hash; image fills without one are left out. */
  readonly images?: (ref: string) => SvgImageSource | null;
  /**
   * Draw text runs with OpenType features as glyph outlines (from the
   * measurer's shaper) instead of relying on `font-feature-settings`: for
   * PDF, whose text can't take features. Other text stays text.
   */
  readonly outlineFeatures?: boolean;
}

export function exportSvg(
  scene: Scene,
  measurer: TextMeasurer,
  ids: readonly string[],
  bounds: Rect,
  options: SvgExportOptions = {},
): string {
  const out = new SvgWriter();

  /** An image fill: the image placed by its scale mode, clipped to the layer's shape. */
  const imageFill = (
    paint: Extract<Paint, { type: "image" }>,
    shape: { tag: string; attrs: string },
    w: number,
    h: number,
    transform: string,
    blendStyle: string,
  ): string | null => {
    const source = options.images?.(paint.ref);
    if (!source) return null;
    const p = imagePlacement(
      paint.scaleMode,
      { width: w, height: h },
      source,
      paint.crop ?? FULL_CROP,
    );
    const href = attr("href", source.href);
    const clip = out.id("clip");
    out.defs.push(`<clipPath id="${clip}"><${shape.tag}${transform}${shape.attrs}/></clipPath>`);
    let body: string;
    if (p.tile) {
      const tile = out.id("tile");
      out.defs.push(
        `<pattern id="${tile}" patternUnits="userSpaceOnUse"${attr("width", round2(p.width))}${attr("height", round2(p.height))}><image${attr("width", round2(p.width))}${attr("height", round2(p.height))}${href} preserveAspectRatio="none"/></pattern>`,
      );
      body = `<rect${attr("width", w)}${attr("height", h)} fill="url(#${tile})"/>`;
    } else {
      body = `<image${attr("x", round2(p.x))}${attr("y", round2(p.y))}${attr("width", round2(p.width))}${attr("height", round2(p.height))}${href} preserveAspectRatio="none"/>`;
    }
    const opacity =
      paint.opacity !== undefined && paint.opacity < 1 ? attr("opacity", paint.opacity) : "";
    return `<g clip-path="url(#${clip})"${opacity}${blendStyle}><g${transform}>${body}</g></g>`;
  };

  /** An offset and a Gaussian blur in page space, as a canvas shadow is cast; `region` in page space. */
  const shadowFilter = (
    s: { x: number; y: number; blur: number },
    region: string,
    fromAlpha: boolean,
  ) => {
    const id = out.id("shadow");
    // A canvas shadow's blur is twice the Gaussian's standard deviation.
    const sd = s.blur / 2;
    const offset = `<feOffset${fromAlpha ? ' in="SourceAlpha"' : ""}${attr("dx", s.x)}${attr("dy", s.y)} result="moved"/>`;
    const blurred =
      sd > 0 ? `<feGaussianBlur in="moved"${attr("stdDeviation", sd)} result="soft"/>` : "";
    out.defs.push(
      `<filter id="${id}" filterUnits="userSpaceOnUse"${region} color-interpolation-filters="sRGB">${offset}${blurred}</filter>`,
    );
    return id;
  };

  /** How far a shadow can reach past its shape: its offset, blur and spread. */
  const reach = (s: { x: number; y: number; blur: number; spread: number }) =>
    Math.abs(s.x) + Math.abs(s.y) + s.blur * 1.5 + Math.abs(s.spread) + 1;

  /**
   * Drop shadows, under the layer: its shape grown by the spread (or its
   * glyphs, for text) in the shadow's colour, offset and blurred. Whatever
   * the fill's opacity, as on the canvas.
   */
  const dropShadows = (
    node: NodeRecord,
    w: number,
    h: number,
    matrix: Matrix,
    shape: { tag: string; attrs: string } | null,
    into: string[],
  ) => {
    for (const s of getProp(node.props, "effects")) {
      if (s.type !== "drop-shadow" || s.visible === false) continue;
      const region = regionAttrs(matrix, 0, 0, w, h, reach(s));
      const { color, alpha } = splitColor(s.color);
      const ink = `${attr("fill", color)}${alpha < 1 ? attr("fill-opacity", alpha) : ""}`;
      if (shape) {
        const grown = spreadShapeOf(node, w, h, s.spread);
        if (!grown) continue;
        const filter = shadowFilter(s, region, false);
        into.push(
          `<g filter="url(#${filter})"><${grown.tag}${transformAttr(matrix)}${grown.attrs}${ink}/></g>`,
        );
      } else {
        // Text: the glyphs' silhouette, filled with the shadow's colour.
        const glyphs: string[] = [];
        text(node, w, h, transformAttr(matrix), glyphs);
        const filter = shadowFilter(s, region, true);
        const tint = out.id("tint");
        out.defs.push(
          `<filter id="${tint}" filterUnits="userSpaceOnUse"${region} color-interpolation-filters="sRGB"><feFlood${attr("flood-color", color)}${alpha < 1 ? attr("flood-opacity", alpha) : ""}/><feComposite in2="SourceGraphic" operator="in"/></filter>`,
        );
        into.push(
          `<g filter="url(#${tint})"><g filter="url(#${filter})">${glyphs.join("")}</g></g>`,
        );
      }
    }
  };

  /**
   * Inner shadows, over the fills: everything outside the shape shrunk by
   * the spread, in the shadow's colour, offset, blurred and clipped to the shape.
   */
  const innerShadows = (
    node: NodeRecord,
    w: number,
    h: number,
    matrix: Matrix,
    shape: { tag: string; attrs: string },
    into: string[],
  ) => {
    const transform = transformAttr(matrix);
    for (const s of getProp(node.props, "effects")) {
      if (s.type !== "inner-shadow" || s.visible === false) continue;
      const shrunk = spreadShapeOf(node, w, h, -s.spread);
      if (!shrunk) continue;
      const pad = reach(s);
      const region = regionAttrs(matrix, 0, 0, w, h, pad);
      const clip = out.id("clip");
      out.defs.push(`<clipPath id="${clip}"><${shape.tag}${transform}${shape.attrs}/></clipPath>`);
      const ring = out.id("ring");
      out.defs.push(
        `<mask id="${ring}" maskUnits="userSpaceOnUse"${region}><rect${region} fill="#fff"/><${shrunk.tag}${transform}${shrunk.attrs} fill="#000"/></mask>`,
      );
      const filter = shadowFilter(s, region, false);
      const { color, alpha } = splitColor(s.color);
      into.push(
        `<g clip-path="url(#${clip})"><g filter="url(#${filter})"><rect${region}${attr("fill", color)}${alpha < 1 ? attr("fill-opacity", alpha) : ""} mask="url(#${ring})"/></g></g>`,
      );
    }
  };

  /** A layer blur's filter id, or null: CSS-style blur(radius) on the layer's own drawing. */
  /**
   * A layer blur blurs the whole layer, as on the canvas (and in Figma): its
   * fills, strokes and shadows, and a frame's or group's children, as one
   * picture. Wraps a layer's markup in the blur, over all it paints.
   */
  const blurred = (node: NodeRecord, parts: string[]): string[] => {
    let radius = 0;
    for (const e of getProp(node.props, "effects"))
      if (e.type === "layer-blur" && e.visible !== false) radius = Math.max(radius, e.radius);
    if (radius <= 0 || parts.length === 0) return parts;
    const bounds = exportBounds(scene, [node.id]);
    if (!bounds) return parts;
    const id = out.id("blur");
    const pad = radius * 3;
    const region = `${attr("x", bounds.x - pad)}${attr("y", bounds.y - pad)}${attr("width", bounds.width + pad * 2)}${attr("height", bounds.height + pad * 2)}`;
    out.defs.push(
      `<filter id="${id}" filterUnits="userSpaceOnUse"${region} color-interpolation-filters="sRGB"><feGaussianBlur${attr("stdDeviation", radius)}/></filter>`,
    );
    return [`<g filter="url(#${id})">${parts.join("")}</g>`];
  };

  const visit = (id: string, into: string[]) => {
    const node = scene.doc.get(id);
    if (!node || node.props.visible === false || node.type === "page") return;
    const opacity = getProp(node.props, "opacity");
    const blend = getProp(node.props, "blendMode");
    const wrapperAttrs = `${opacity < 1 ? attr("opacity", opacity) : ""}${
      BLEND_CSS.has(blend) ? ` style="mix-blend-mode:${blend}"` : ""
    }`;
    const name = node.props.name ? attr("data-name", node.props.name) : "";
    const parts: string[] = [];

    if (node.type === "group") {
      visitChildren(id, parts);
      const drawn = blurred(node, parts);
      if (drawn.length > 0) into.push(`<g${name}${wrapperAttrs}>${drawn.join("")}</g>`);
      return;
    }

    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const matrix = scene.worldMatrix(id);
    const transform = transformAttr(matrix);
    // In the canvas's order: drop shadows, fills, inner shadows, children, strokes.
    const shadows: string[] = [];
    const below: string[] = [];
    const inner: string[] = [];
    const children: string[] = [];
    const above: string[] = [];

    if (node.type === "text") {
      dropShadows(node, w, h, matrix, null, shadows);
      text(node, w, h, transform, below);
    } else {
      const shape = shapeOf(node, w, h);
      if (shape) {
        dropShadows(node, w, h, matrix, shape, shadows);
        if (node.type !== "line")
          for (const paint of getProp(node.props, "fills")) {
            if (paint.visible === false) continue;
            const blendStyle =
              paint.blendMode && BLEND_CSS.has(paint.blendMode)
                ? ` style="mix-blend-mode:${paint.blendMode}"`
                : "";
            if (paint.type === "image") {
              const image = imageFill(paint, shape, w, h, transform, blendStyle);
              if (image) below.push(image);
              continue;
            }
            const fill = out.paint("fill", paint, w, h);
            if (!fill) continue;
            below.push(`<${shape.tag}${transform}${shape.attrs}${fill}${blendStyle}/>`);
          }
        if (node.type !== "line") innerShadows(node, w, h, matrix, shape, inner);
        if (node.type === "frame") {
          const inside: string[] = [];
          visitChildren(id, inside);
          if (inside.length > 0) {
            if (getProp(node.props, "clipContent")) {
              const clip = out.id("clip");
              out.defs.push(
                `<clipPath id="${clip}"><${shape.tag}${transform}${shape.attrs}/></clipPath>`,
              );
              children.push(`<g clip-path="url(#${clip})">${inside.join("")}</g>`);
            } else {
              children.push(...inside);
            }
          }
        }
        strokes(node, shape, w, h, transform, above);
      }
    }
    const drawn = blurred(node, [...shadows, ...below, ...inner, ...children, ...above]);
    if (drawn.length === 0) return;
    if (wrapperAttrs || name) into.push(`<g${name}${wrapperAttrs}>${drawn.join("")}</g>`);
    else into.push(...drawn);
  };

  /** A parent's children; layers above a mask go in a group clipped to the mask's outline. */
  const visitChildren = (parentId: string, into: string[]) => {
    if (!hasMask(scene.doc, parentId)) {
      for (const child of scene.doc.childIds(parentId)) visit(child, into);
      return;
    }
    let clipped: string[] | null = null;
    let clip = "";
    const flush = () => {
      if (clipped && clipped.length > 0)
        into.push(`<g clip-path="url(#${clip})">${clipped.join("")}</g>`);
      clipped = null;
    };
    for (const { id, isMask } of maskScopes(scene.doc, parentId)) {
      if (!isMask) {
        visit(id, clipped ?? into);
        continue;
      }
      flush();
      const mask = scene.doc.get(id) as NodeRecord;
      const shape = shapeOf(mask, getProp(mask.props, "width"), getProp(mask.props, "height"));
      if (!shape) continue;
      clip = out.id("mask");
      const rule =
        mask.type === "path" && getProp(mask.props, "windingRule") === "evenodd"
          ? ' clip-rule="evenodd"'
          : "";
      out.defs.push(
        `<clipPath id="${clip}"><${shape.tag}${transformAttr(scene.worldMatrix(id))}${shape.attrs}${rule}/></clipPath>`,
      );
      clipped = [];
    }
    flush();
  };

  const strokes = (
    node: NodeRecord,
    shape: { tag: string; attrs: string },
    w: number,
    h: number,
    transform: string,
    parts: string[],
  ) => {
    const paints = getProp(node.props, "strokes").filter((p) => p.visible !== false);
    const weight = getProp(node.props, "strokeWeight");
    if (paints.length === 0 || weight <= 0) return;
    const open = node.type === "line" || node.type === "path";
    const align = open ? "center" : getProp(node.props, "strokeAlign");
    let style = attr("stroke-width", align === "center" ? weight : weight * 2);
    const join = getProp(node.props, "strokeJoin");
    if (join !== "miter") style += attr("stroke-linejoin", join);
    if (open) {
      const cap = getProp(node.props, "strokeCap");
      if (cap !== "none") style += attr("stroke-linecap", cap);
    }
    const dashes = getProp(node.props, "strokeDashes");
    if (dashes.length > 0) style += attr("stroke-dasharray", dashes.map(svgNumber).join(" "));
    // SVG strokes are centred: draw double width and keep only the inside or outside half.
    let wrap = (s: string) => s;
    if (align === "inside") {
      const clip = out.id("clip");
      out.defs.push(`<clipPath id="${clip}"><${shape.tag}${transform}${shape.attrs}/></clipPath>`);
      wrap = (s) => `<g clip-path="url(#${clip})">${s}</g>`;
    } else if (align === "outside") {
      const mask = out.id("mask");
      const m = weight * 2;
      // The mask's own region is in page space (userSpaceOnUse, on an untransformed group);
      // the white rect inside it is in the layer's space, placed by its transform.
      const local = `${attr("x", -m)}${attr("y", -m)}${attr("width", w + m * 2)}${attr("height", h + m * 2)}`;
      const page = regionAttrs(scene.worldMatrix(node.id), -m, -m, w + m, h + m, 0);
      out.defs.push(
        `<mask id="${mask}" maskUnits="userSpaceOnUse"${page}><rect${transform}${local} fill="#fff"/><${shape.tag}${transform}${shape.attrs} fill="#000"/></mask>`,
      );
      wrap = (s) => `<g mask="url(#${mask})">${s}</g>`;
    }
    // End markers: the line stops short under filled ones; markers are solid, never dashed.
    const markers = markersOf(node);
    const trimmed = markers ? trimmedStroke(node, markers.start.inset, markers.end.inset) : null;
    const line = trimmed ? { tag: "path", attrs: attr("d", serializePath(trimmed)) } : shape;
    const elements: string[] = [];
    for (const paint of paints) {
      const stroke = out.paint("stroke", paint, w, h);
      if (stroke)
        elements.push(`<${line.tag}${transform}${line.attrs} fill="none"${stroke}${style}/>`);
      if (!markers) continue;
      for (const marker of [markers.start, markers.end]) {
        if (marker.fill) {
          const fill = out.paint("fill", paint, w, h);
          if (fill)
            elements.push(`<path${transform}${attr("d", serializePath(marker.fill))}${fill}/>`);
        }
        if (marker.stroke && stroke)
          elements.push(
            `<path${transform}${attr("d", serializePath(marker.stroke))} fill="none"${stroke}${attr("stroke-width", weight)} stroke-linecap="round" stroke-linejoin="round"/>`,
          );
      }
    }
    if (elements.length > 0) parts.push(wrap(elements.join("")));
  };

  const text = (node: NodeRecord, w: number, h: number, transform: string, parts: string[]) => {
    const mode = getProp(node.props, "textAutoResize");
    const layout = layoutText(node, measurer, mode === "width" ? null : w);
    const dy = textBlockOffset(node, layout);
    const base = node.props;
    const align = getProp(base, "textAlign");
    const anchor = align === "center" ? "middle" : align === "right" ? "end" : null;
    const lineX = align === "center" ? w / 2 : align === "right" ? w : 0;
    const family = (props: Props) =>
      `'${getProp(props, "fontFamily").replace(/['"]/g, "")}', sans-serif`;
    const decorationOf = (d: string) =>
      d === "strikethrough" ? "line-through" : d === "underline" ? "underline" : "none";
    // The layer's own type on <text>; rich text's fragments state only what differs.
    let style = `${attr("font-family", family(base))}${attr("font-size", getProp(base, "fontSize"))}`;
    if (getProp(base, "fontWeight") !== 400)
      style += attr("font-weight", getProp(base, "fontWeight"));
    if (getProp(base, "fontStyle") === "italic") style += attr("font-style", "italic");
    if (layout.letterSpacing !== 0) style += attr("letter-spacing", layout.letterSpacing);
    if (getProp(base, "textDecoration") !== "none")
      style += attr("text-decoration", decorationOf(getProp(base, "textDecoration")));
    if (anchor) style += attr("text-anchor", anchor);
    // OpenType features as CSS, which SVG text honours (decision 0005).
    const features = (props: Props) => featureSettings(getProp(props, "fontFeatures"));
    if (features(base)) style += attr("style", `font-feature-settings: ${features(base)}`);

    // Runs drawn as glyph outlines (PDF): what the shaper has for them.
    const outlined = new Map<TextFragment, ShapedText>();
    if (options.outlineFeatures && measurer.shape)
      for (const line of layout.lines)
        for (const frag of line.fragments) {
          const shaped = frag.run ? measurer.shape(frag.text, frag.run) : null;
          if (shaped) outlined.set(frag, shaped);
        }

    const spans = textSpans(node);
    const propsAt = (i: number) =>
      (spans.find((sp) => sp.start <= i && i < sp.end) ?? spans[0])?.props ?? base;
    const typeOf = (frag: TextFragment) => {
      const p = propsAt(frag.start);
      let own = "";
      if (getProp(p, "fontFamily") !== getProp(base, "fontFamily"))
        own += attr("font-family", family(p));
      if (frag.fontSize !== getProp(base, "fontSize")) own += attr("font-size", frag.fontSize);
      if (getProp(p, "fontWeight") !== getProp(base, "fontWeight"))
        own += attr("font-weight", getProp(p, "fontWeight"));
      if (getProp(p, "fontStyle") !== getProp(base, "fontStyle"))
        own += attr("font-style", getProp(p, "fontStyle"));
      if (frag.letterSpacing !== layout.letterSpacing)
        own += attr("letter-spacing", frag.letterSpacing);
      if (frag.decoration !== getProp(base, "textDecoration"))
        own += attr("text-decoration", decorationOf(frag.decoration));
      if (features(p) !== features(base))
        own += attr("style", `font-feature-settings: ${features(p) || "normal"}`);
      return own;
    };
    /**
     * The lines, each a text chunk anchored at the layer's alignment, its
     * fragments flowing inside it. A fragment with its own fill paints in it
     * on the first pass and stays clear (still taking its room) on the others.
     */
    const lines = (pass: number) =>
      layout.lines
        .map((line) => {
          const fillOf = (frag: TextFragment) => {
            if (!frag.fills) return "";
            const top = [...frag.fills].reverse().find((f) => f.visible !== false);
            const fill = pass === 0 && top ? out.paint("fill", top, w, h) : null;
            return fill ?? ' fill="none"';
          };
          const y = round2(line.baseline + dy);
          // A line with outlined runs (PDF): its other fragments are placed one by one, where
          // the layout put them, since the viewer measures text without the outlined runs' features.
          if (line.fragments.some((f) => outlined.has(f))) {
            const x0 = lineOffset(line, w, base);
            return line.fragments
              .filter((frag) => !outlined.has(frag) && frag.text)
              .map(
                (frag) =>
                  `<tspan${attr("x", round2(x0 + frag.x))}${attr("y", y)} text-anchor="start"${typeOf(frag)}${fillOf(frag)}>${escapeXml(frag.text)}</tspan>`,
              )
              .join("");
          }
          const inner = line.fragments
            .map((frag) => {
              const own = typeOf(frag) + fillOf(frag);
              return own ? `<tspan${own}>${escapeXml(frag.text)}</tspan>` : escapeXml(frag.text);
            })
            .join("");
          return `<tspan${attr("x", round2(lineX))}${attr("y", y)}>${inner}</tspan>`;
        })
        .join("");
    /** A shaped run's glyphs (and its decoration) in the text box, where the canvas draws them. */
    /**
     * `prefix`: a transform to put before each glyph's own (the layer's, inside a
     * clip path, which can't hold groups). `strokeWidth`: stroked glyphs at that
     * width (scaled into the glyphs' units), without decorations.
     */
    const glyphs = (
      frag: TextFragment,
      shaped: ShapedText,
      { prefix = "", strokeWidth }: { prefix?: string; strokeWidth?: number } = {},
    ) => {
      const line = layout.lines.find((l) => l.fragments.includes(frag));
      if (!line) return "";
      const x0 = lineOffset(line, w, base) + frag.x;
      const y0 = line.baseline + dy;
      // Letter spacing follows each character, as on the canvas.
      const before: number[] = [];
      for (let i = 0, n = 0; i <= frag.text.length; i++) {
        before[i] = n;
        const c = frag.text.charCodeAt(i);
        if (!(c >= 0xdc00 && c <= 0xdfff)) n++;
      }
      const s = round2(shaped.scale * 10000) / 10000;
      let svg = "";
      for (const g of shaped.glyphs) {
        if (!g.d) continue;
        const x = round2(x0 + g.x + frag.letterSpacing * (before[g.cluster] ?? 0));
        const y = round2(y0 - g.y);
        const width =
          strokeWidth === undefined
            ? ""
            : attr("stroke-width", round2((strokeWidth / s) * 100) / 100);
        svg += `<path transform="${prefix}matrix(${s} 0 0 ${-s} ${x} ${y})"${width}${attr("d", g.d)}/>`;
      }
      if (frag.decoration !== "none" && strokeWidth === undefined) {
        const size = frag.fontSize;
        const y = frag.decoration === "underline" ? y0 + size * 0.1 : y0 - size * 0.3;
        svg += `<rect${attr("x", round2(x0))}${attr("y", round2(y))}${attr("width", round2(frag.width))}${attr("height", round2(Math.max(1, size / 16)))}/>`;
      }
      return svg;
    };
    const ownOutlines = [...outlined].filter(([frag]) => frag.fills);
    const layerOutlines = [...outlined]
      .filter(([frag]) => !frag.fills)
      .map(([frag, shaped]) => glyphs(frag, shaped))
      .join("");

    const fills = getProp(base, "fills");
    const paints: Paint[] = fills.length > 0 ? fills : [{ type: "solid", color: "#000000" }];
    let pass = 0;
    for (const paint of paints) {
      if (paint.visible === false) continue;
      const fill = out.paint("fill", paint, w, h);
      if (!fill) continue;
      parts.push(`<text${transform}${style}${fill} xml:space="preserve">${lines(pass++)}</text>`);
      if (layerOutlines) parts.push(`<g${transform}${fill}>${layerOutlines}</g>`);
    }
    // Outlined runs with their own fills: drawn once, in their topmost visible fill.
    for (const [frag, shaped] of ownOutlines) {
      const top = [...(frag.fills ?? [])].reverse().find((f) => f.visible !== false);
      const fill = top ? out.paint("fill", top, w, h) : null;
      if (fill) parts.push(`<g${transform}${fill}>${glyphs(frag, shaped)}</g>`);
    }
    // The layer's own fills are all hidden: its own-coloured fragments still show.
    if (pass === 0 && layout.lines.some((l) => l.fragments.some((f) => f.fills)))
      parts.push(`<text${transform}${style} fill="none" xml:space="preserve">${lines(0)}</text>`);

    // Strokes, around the glyphs (centred on their edges, or inside or outside them).
    const strokePaints = getProp(base, "strokes").filter((p) => p.visible !== false);
    const weight = getProp(base, "strokeWeight");
    if (strokePaints.length === 0 || weight <= 0) return;
    const strokeAlign = getProp(base, "strokeAlign");
    const width = strokeAlign === "center" ? weight : weight * 2;
    const largestSize = Math.max(
      getProp(base, "fontSize"),
      ...layout.lines.flatMap((l) => l.fragments.map((f) => f.fontSize)),
    );
    let strokeStyle = attr("stroke-width", width);
    const join = getProp(base, "strokeJoin");
    if (join !== "miter") strokeStyle += attr("stroke-linejoin", join);
    const dashes = getProp(base, "strokeDashes");
    if (dashes.length > 0) strokeStyle += attr("stroke-dasharray", dashes.map(svgNumber).join(" "));
    // The glyphs as a shape (a clip or a mask): the text, and any outlined runs.
    const inner = /transform="([^"]*)"/.exec(transform)?.[1] ?? "";
    const shapeOfGlyphs = (fill: string, inClip: boolean) =>
      `<text${transform}${style}${fill} xml:space="preserve">${lines(1)}</text>${[...outlined]
        .map(([frag, shaped]) =>
          inClip
            ? glyphs(frag, shaped, { prefix: inner ? `${inner} ` : "" })
            : `<g${transform}${fill}>${glyphs(frag, shaped)}</g>`,
        )
        .join("")}`;
    let wrap = (svg: string) => svg;
    if (strokeAlign === "inside") {
      const clip = out.id("clip");
      out.defs.push(`<clipPath id="${clip}">${shapeOfGlyphs("", true)}</clipPath>`);
      wrap = (svg) => `<g clip-path="url(#${clip})">${svg}</g>`;
    } else if (strokeAlign === "outside") {
      const mask = out.id("mask");
      // In the layer's space: its box, grown by the stroke and the glyphs' overhang.
      const m = weight * 2 + largestSize * 0.5;
      const local = `${attr("x", -m)}${attr("y", -m)}${attr("width", w + m * 2)}${attr("height", Math.max(h, layout.height + dy) + m * 2)}`;
      const page = regionAttrs(
        scene.worldMatrix(node.id),
        -m,
        -m,
        w + m,
        Math.max(h, layout.height + dy) + m,
        0,
      );
      out.defs.push(
        `<mask id="${mask}" maskUnits="userSpaceOnUse"${page}><rect${transform}${local} fill="#fff"/>${shapeOfGlyphs(' fill="#000"', false)}</mask>`,
      );
      wrap = (svg) => `<g mask="url(#${mask})">${svg}</g>`;
    }
    const stroked: string[] = [];
    for (const paint of strokePaints) {
      const stroke = out.paint("stroke", paint, w, h);
      if (!stroke) continue;
      stroked.push(
        `<text${transform}${style} fill="none"${stroke}${strokeStyle} xml:space="preserve">${lines(1)}</text>`,
      );
      for (const [frag, shaped] of outlined)
        stroked.push(
          `<g${transform} fill="none"${stroke}>${glyphs(frag, shaped, { strokeWidth: width })}</g>`,
        );
    }
    if (stroked.length > 0) parts.push(wrap(stroked.join("")));
  };

  for (const id of ids) visit(id, out.body);
  const { x, y, width, height } = bounds;
  const viewBox = [x, y, width, height].map(svgNumber).join(" ");
  const defs = out.defs.length > 0 ? `<defs>${out.defs.join("")}</defs>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNumber(width)}" height="${svgNumber(height)}" viewBox="${viewBox}">${defs}${out.body.join("")}</svg>\n`;
}

/**
 * The same SVG for reading (Inspect): one element per line, indented, and a
 * tag longer than `width` with each attribute on a line of its own. A
 * `<text>` stays on one line with its tspans, since its whitespace is
 * preserved and a line break inside it would show as a space. Collapsing the
 * whitespace between and inside tags gives back the original.
 */
export function formatSvg(svg: string, { width = Number.POSITIVE_INFINITY } = {}): string {
  const tokens = svg.trim().match(/<[^>]+>|[^<]+/g) ?? [];
  const lines: string[] = [];
  const indent = (depth: number) => "  ".repeat(Math.max(0, depth));
  /** A tag at `depth`, its attributes one per line when it's too long for one. */
  const tag = (token: string, depth: number) => {
    const line = indent(depth) + token;
    const parts = /^<([\w:-]+)((?:\s+[\w:-]+="[^"]*")+)\s*(\/?)>$/.exec(token);
    if (line.length <= width || !parts) return line;
    const [, name, attrs = "", close] = parts;
    const each = attrs.match(/[\w:-]+="[^"]*"/g) ?? [];
    return [
      `${indent(depth)}<${name}`,
      ...each.map((a, i) => `${indent(depth + 1)}${a}${i === each.length - 1 ? `${close}>` : ""}`),
    ].join("\n");
  };
  let depth = 0;
  // A <text> element being kept on one line, and how deep inside it we are.
  let inline: string | null = null;
  let inside = 0;
  for (const token of tokens) {
    if (inline !== null) {
      inline += token;
      if (token.startsWith("</")) inside--;
      else if (token.startsWith("<") && !token.endsWith("/>")) inside++;
      if (inside === 0) {
        lines.push(indent(depth) + inline);
        inline = null;
      }
      continue;
    }
    if (!token.startsWith("<")) {
      if (token.trim()) lines.push(indent(depth) + token.trim());
    } else if (token.startsWith("</")) {
      depth--;
      lines.push(indent(depth) + token);
    } else if (token.endsWith("/>")) {
      lines.push(tag(token, depth));
    } else if (/^<text[\s>]/.test(token)) {
      inline = token;
      inside = 1;
    } else {
      lines.push(tag(token, depth));
      depth++;
    }
  }
  return `${lines.join("\n")}\n`;
}

/** OpenType features as CSS `font-feature-settings` ("'tnum' 1, 'liga' 0"), empty for none. */
export function featureSettings(features: Readonly<Record<string, boolean>>): string {
  return Object.keys(features)
    .sort()
    .map((tag) => `'${tag}' ${features[tag] ? 1 : 0}`)
    .join(", ");
}
