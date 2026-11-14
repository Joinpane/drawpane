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
 * Not covered yet:
 * - image fills without a supplied image, and image strokes (left out)
 * - shadows, layer blur and background blur
 * - per-paint blend modes on strokes
 * - text that depends on fonts the viewer lacks: text stays live, so it
 *   renders in whatever font the viewing app has (outlining comes later)
 * - auto layout: positions are exported as they are on the canvas, not as
 *   flexbox
 */
import { getProp, type NodeRecord, type Paint, type Props } from "@drawpane/model";
import { type Matrix, type Rect, round2 } from "./geometry";
import { FULL_CROP, imagePlacement } from "./images";
import { markersOf, trimmedStroke } from "./markers";
import { hasMask, maskScopes } from "./masks";
import { textSpans } from "./rich-text";
import type { Scene } from "./scene";
import { layoutText, type TextFragment, type TextMeasurer, textBlockOffset } from "./text";
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
        const [tl, tr, br, bl] = radii.map((r) => Math.min(r, max)) as [
          number,
          number,
          number,
          number,
        ];
        const n = svgNumber;
        const d = [
          `M${n(tl)} 0`,
          `H${n(w - tr)}`,
          tr ? `A${n(tr)} ${n(tr)} 0 0 1 ${n(w)} ${n(tr)}` : "",
          `V${n(h - br)}`,
          br ? `A${n(br)} ${n(br)} 0 0 1 ${n(w - br)} ${n(h)}` : "",
          `H${n(bl)}`,
          bl ? `A${n(bl)} ${n(bl)} 0 0 1 0 ${n(h - bl)}` : "",
          `V${n(tl)}`,
          tl ? `A${n(tl)} ${n(tl)} 0 0 1 ${n(tl)} 0` : "",
          "Z",
        ]
          .filter(Boolean)
          .join("");
        return { tag: "path", attrs: attr("d", d) };
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
      if (parts.length > 0) into.push(`<g${name}${wrapperAttrs}>${parts.join("")}</g>`);
      return;
    }

    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const transform = transformAttr(scene.worldMatrix(id));

    if (node.type === "text") {
      text(node, w, h, transform, parts);
    } else {
      const shape = shapeOf(node, w, h);
      if (shape) {
        if (node.type !== "line")
          for (const paint of getProp(node.props, "fills")) {
            if (paint.visible === false) continue;
            const blendStyle =
              paint.blendMode && BLEND_CSS.has(paint.blendMode)
                ? ` style="mix-blend-mode:${paint.blendMode}"`
                : "";
            if (paint.type === "image") {
              const image = imageFill(paint, shape, w, h, transform, blendStyle);
              if (image) parts.push(image);
              continue;
            }
            const fill = out.paint("fill", paint, w, h);
            if (!fill) continue;
            parts.push(`<${shape.tag}${transform}${shape.attrs}${fill}${blendStyle}/>`);
          }
        if (node.type === "frame") {
          const children: string[] = [];
          visitChildren(id, children);
          if (children.length > 0) {
            if (getProp(node.props, "clipContent")) {
              const clip = out.id("clip");
              out.defs.push(
                `<clipPath id="${clip}"><${shape.tag}${transform}${shape.attrs}/></clipPath>`,
              );
              parts.push(`<g clip-path="url(#${clip})">${children.join("")}</g>`);
            } else {
              parts.push(...children);
            }
          }
        }
        strokes(node, shape, w, h, transform, parts);
      }
    }
    if (parts.length === 0) return;
    if (wrapperAttrs || name) into.push(`<g${name}${wrapperAttrs}>${parts.join("")}</g>`);
    else into.push(...parts);
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
      const region = `${attr("x", -m)}${attr("y", -m)}${attr("width", w + m * 2)}${attr("height", h + m * 2)}`;
      out.defs.push(
        `<mask id="${mask}" maskUnits="userSpaceOnUse"${region}><rect${transform}${region} fill="#fff"/><${shape.tag}${transform}${shape.attrs} fill="#000"/></mask>`,
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
          const inner = line.fragments
            .map((frag) => {
              let own = typeOf(frag);
              if (frag.fills) {
                const top = [...frag.fills].reverse().find((f) => f.visible !== false);
                const fill = pass === 0 && top ? out.paint("fill", top, w, h) : null;
                own += fill ?? ' fill="none"';
              }
              return own ? `<tspan${own}>${escapeXml(frag.text)}</tspan>` : escapeXml(frag.text);
            })
            .join("");
          return `<tspan${attr("x", round2(lineX))}${attr("y", round2(line.baseline + dy))}>${inner}</tspan>`;
        })
        .join("");
    const fills = getProp(base, "fills");
    const paints: Paint[] = fills.length > 0 ? fills : [{ type: "solid", color: "#000000" }];
    let pass = 0;
    for (const paint of paints) {
      if (paint.visible === false) continue;
      const fill = out.paint("fill", paint, w, h);
      if (!fill) continue;
      parts.push(`<text${transform}${style}${fill} xml:space="preserve">${lines(pass++)}</text>`);
    }
    // The layer's own fills are all hidden: its own-coloured fragments still show.
    if (pass === 0 && layout.lines.some((l) => l.fragments.some((f) => f.fills)))
      parts.push(`<text${transform}${style} fill="none" xml:space="preserve">${lines(0)}</text>`);
  };

  for (const id of ids) visit(id, out.body);
  const { x, y, width, height } = bounds;
  const viewBox = [x, y, width, height].map(svgNumber).join(" ");
  const defs = out.defs.length > 0 ? `<defs>${out.defs.join("")}</defs>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNumber(width)}" height="${svgNumber(height)}" viewBox="${viewBox}">${defs}${out.body.join("")}</svg>\n`;
}
