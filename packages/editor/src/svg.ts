/**
 * SVG export for simple layers.
 *
 * Covered: rectangles (with one or four corner radii), ellipses, lines, paths
 * (with their winding rule), text as `<text>` with one `<tspan>` per line,
 * frames as `<g>` (clipped with a `<clipPath>` when they clip content) and
 * groups. Each layer keeps its rotation and flips (as a transform matrix),
 * its opacity and blend mode, solid and gradient fills (one element per
 * paint, bottom first), and solid or gradient strokes with weight, position
 * (inside and outside are emulated with a clip path or mask), dashes, joins
 * and caps.
 *
 * Not covered yet:
 * - image fills and image strokes (skipped; export PNG instead)
 * - shadows, layer blur and background blur
 * - per-paint blend modes on strokes
 * - text that depends on fonts the viewer lacks: text stays live, so it
 *   renders in whatever font the viewing app has (outlining comes later)
 * - auto layout: positions are exported as they are on the canvas, not as
 *   flexbox
 */
import { getProp, type NodeRecord, type Paint } from "@drawpane/model";
import { type Matrix, type Rect, round2 } from "./geometry";
import type { Scene } from "./scene";
import { layoutText, type TextMeasurer } from "./text";

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
export function exportSvg(
  scene: Scene,
  measurer: TextMeasurer,
  ids: readonly string[],
  bounds: Rect,
): string {
  const out = new SvgWriter();

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
      for (const child of scene.doc.childIds(id)) visit(child, parts);
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
            const fill = out.paint("fill", paint, w, h);
            if (!fill) continue;
            const blendStyle =
              paint.blendMode && BLEND_CSS.has(paint.blendMode)
                ? ` style="mix-blend-mode:${paint.blendMode}"`
                : "";
            parts.push(`<${shape.tag}${transform}${shape.attrs}${fill}${blendStyle}/>`);
          }
        if (node.type === "frame") {
          const children: string[] = [];
          for (const child of scene.doc.childIds(id)) visit(child, children);
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
    const elements: string[] = [];
    for (const paint of paints) {
      const stroke = out.paint("stroke", paint, w, h);
      if (stroke)
        elements.push(`<${shape.tag}${transform}${shape.attrs} fill="none"${stroke}${style}/>`);
    }
    if (elements.length > 0) parts.push(wrap(elements.join("")));
  };

  const text = (node: NodeRecord, w: number, h: number, transform: string, parts: string[]) => {
    const mode = getProp(node.props, "textAutoResize");
    const layout = layoutText(node, measurer, mode === "width" ? null : w);
    const align = getProp(node.props, "textAlign");
    const vAlign = getProp(node.props, "textAlignVertical");
    const dy =
      vAlign === "middle" ? (h - layout.height) / 2 : vAlign === "bottom" ? h - layout.height : 0;
    const anchor = align === "center" ? "middle" : align === "right" ? "end" : null;
    const x = align === "center" ? w / 2 : align === "right" ? w : 0;
    const family = getProp(node.props, "fontFamily").replace(/['"]/g, "");
    let style = `${attr("font-family", `'${family}', sans-serif`)}${attr("font-size", getProp(node.props, "fontSize"))}`;
    const weight = getProp(node.props, "fontWeight");
    if (weight !== 400) style += attr("font-weight", weight);
    if (getProp(node.props, "fontStyle") === "italic") style += attr("font-style", "italic");
    if (layout.letterSpacing !== 0) style += attr("letter-spacing", layout.letterSpacing);
    const decoration = getProp(node.props, "textDecoration");
    if (decoration !== "none")
      style += attr(
        "text-decoration",
        decoration === "strikethrough" ? "line-through" : "underline",
      );
    if (anchor) style += attr("text-anchor", anchor);
    const lines = layout.lines
      .map(
        (line) =>
          `<tspan${attr("x", x)}${attr("y", round2(line.baseline + dy))}>${escapeXml(line.text)}</tspan>`,
      )
      .join("");
    const fills = getProp(node.props, "fills");
    const paints: Paint[] = fills.length > 0 ? fills : [{ type: "solid", color: "#000000" }];
    for (const paint of paints) {
      if (paint.visible === false) continue;
      const fill = out.paint("fill", paint, w, h);
      if (fill) parts.push(`<text${transform}${style}${fill} xml:space="preserve">${lines}</text>`);
    }
  };

  for (const id of ids) visit(id, out.body);
  const { x, y, width, height } = bounds;
  const viewBox = [x, y, width, height].map(svgNumber).join(" ");
  const defs = out.defs.length > 0 ? `<defs>${out.defs.join("")}</defs>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNumber(width)}" height="${svgNumber(height)}" viewBox="${viewBox}">${defs}${out.body.join("")}</svg>\n`;
}
