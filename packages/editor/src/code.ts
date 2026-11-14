/**
 * Design to code: CSS, Tailwind and JSX for a layer, as a developer would
 * write it. Auto layout is flexbox, sizing is width/flex/fit-content, and any
 * value bound to a variable is written as `var(--token)` with the resolved
 * value in a comment, so Inspect shows what ships.
 */
import {
  type BindingKey,
  type GridTrack,
  getProp,
  type NodeRecord,
  type Paint,
  type Props,
} from "@drawpane/model";
import type { Doc } from "./doc";
import { type RunStyle, textSpans } from "./rich-text";
import { letterSpacingPx, lineHeightPx } from "./text";
import { cssVariableName } from "./variables";
import { shapeVertices } from "./vector/shapes";

export interface CssDeclaration {
  readonly property: string;
  readonly value: string;
  /** The resolved value when `value` refers to a variable. */
  readonly resolved?: string;
  /** The variable's name when `value` refers to one. */
  readonly token?: string;
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

function hex(color: string, opacity = 1): string {
  if (opacity >= 1 && color.length === 7) return color;
  const r = Number.parseInt(color.slice(1, 3), 16);
  const g = Number.parseInt(color.slice(3, 5), 16);
  const b = Number.parseInt(color.slice(5, 7), 16);
  const a = (color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) / 255 : 1) * opacity;
  return `rgb(${r} ${g} ${b} / ${Math.round(a * 100)}%)`;
}

function paintCss(paint: Paint): string | null {
  if (paint.visible === false) return null;
  if (paint.type === "solid") return hex(paint.color, paint.opacity ?? 1);
  if (paint.type === "linear" || paint.type === "radial" || paint.type === "angular") {
    const stops = paint.stops
      .map((s) => `${hex(s.color, paint.opacity ?? 1)} ${Math.round(s.position * 100)}%`)
      .join(", ");
    if (paint.type === "angular") {
      // CSS conic angles start at 12 o'clock; ours start toward `to` from 3 o'clock.
      const from = Math.round(
        (Math.atan2(paint.to.y - paint.from.y, paint.to.x - paint.from.x) * 180) / Math.PI + 90,
      );
      return `conic-gradient(from ${((from % 360) + 360) % 360}deg at ${Math.round(paint.from.x * 100)}% ${Math.round(paint.from.y * 100)}%, ${stops})`;
    }
    if (paint.type === "radial")
      return `radial-gradient(circle at ${Math.round(paint.from.x * 100)}% ${Math.round(paint.from.y * 100)}%, ${stops})`;
    const angle = Math.round(
      (Math.atan2(paint.to.y - paint.from.y, paint.to.x - paint.from.x) * 180) / Math.PI + 90,
    );
    return `linear-gradient(${angle}deg, ${stops})`;
  }
  return null; // Images need an asset URL: exported separately.
}

/** Flexbox's names for start and end. */
const flexAlign = (a: string) => (a === "start" || a === "end" ? `flex-${a}` : a);

/** A CSS track list, with `repeat()` when every track is the same. */
function trackList(tracks: readonly GridTrack[]): string {
  const one = (t: GridTrack) =>
    t.unit === "auto" ? "auto" : `${Math.round(t.value * 100) / 100}${t.unit}`;
  const all = tracks.map(one);
  return all.length > 1 && all.every((t) => t === all[0])
    ? `repeat(${all.length}, ${all[0]})`
    : all.join(" ");
}

/** CSS declarations for one layer, in the order a person would write them. */
export function cssFor(doc: Doc, node: NodeRecord): CssDeclaration[] {
  const p = node.props;
  const out: CssDeclaration[] = [];
  const bindings = getProp(p, "bindings");
  const tokenName = (key: BindingKey) => {
    const id = bindings[key];
    const variable = id ? doc.get(id) : undefined;
    return variable ? getProp(variable.props, "name") : undefined;
  };
  const push = (property: string, value: string, key?: BindingKey) => {
    const token = key ? tokenName(key) : undefined;
    out.push(
      token
        ? { property, value: `var(${cssVariableName(token)})`, resolved: value, token }
        : { property, value },
    );
  };

  /** `gap` as one value when both directions match, else `row-gap` and `column-gap`. */
  const gaps = (row: number, column: number, rowKey: BindingKey, columnKey: BindingKey) => {
    if (row === column && bindings[rowKey] === bindings[columnKey]) {
      if (row !== 0 || bindings[columnKey]) push("gap", px(column), columnKey);
      return;
    }
    if (row !== 0 || bindings[rowKey]) push("row-gap", px(row), rowKey);
    if (column !== 0 || bindings[columnKey]) push("column-gap", px(column), columnKey);
  };

  const parent = doc.get(node.parent);
  const parentLayout = parent?.type === "frame" ? getProp(parent.props, "layoutMode") : "none";
  const inLayout = parentLayout !== "none" && getProp(p, "positioning") === "auto";
  const isText = node.type === "text";

  // Position: absolute children of plain frames, and explicitly absolute ones.
  if (
    node.type !== "page" &&
    node.type !== "group" &&
    parent &&
    parent.type !== "page" &&
    !inLayout
  ) {
    out.push({ property: "position", value: "absolute" });
    out.push({ property: "left", value: px(getProp(p, "x")) });
    out.push({ property: "top", value: px(getProp(p, "y")) });
  }

  // Where it sits in its parent's layout.
  if (inLayout && parentLayout === "grid") {
    const area = getProp(p, "gridArea");
    if (area) {
      const line = (start: number, span: number) =>
        span > 1 ? `${start} / span ${span}` : `${start}`;
      out.push({ property: "grid-column", value: line(area.column, area.columnSpan) });
      out.push({ property: "grid-row", value: line(area.row, area.rowSpan) });
    }
    const justifySelf = getProp(p, "justifySelf");
    if (justifySelf !== "auto") out.push({ property: "justify-self", value: justifySelf });
  }
  if (inLayout) {
    const alignSelf = getProp(p, "alignSelf");
    if (alignSelf !== "auto")
      out.push({
        property: "align-self",
        value: parentLayout === "grid" ? alignSelf : flexAlign(alignSelf),
      });
  }

  // Layout.
  const layoutMode = node.type === "frame" ? getProp(p, "layoutMode") : "none";
  if (layoutMode === "grid") {
    out.push({ property: "display", value: "grid" });
    out.push({
      property: "grid-template-columns",
      value: trackList(
        getProp(p, "gridColumns").length > 0
          ? getProp(p, "gridColumns")
          : [{ unit: "fr", value: 1 }],
      ),
    });
    if (getProp(p, "gridRows").length > 0)
      out.push({ property: "grid-template-rows", value: trackList(getProp(p, "gridRows")) });
    const justifyItems = getProp(p, "justifyItems");
    if (justifyItems !== "start") out.push({ property: "justify-items", value: justifyItems });
    const align = getProp(p, "alignItems");
    if (align !== "start") out.push({ property: "align-items", value: align });
    gaps(getProp(p, "rowGap"), getProp(p, "gap"), "rowGap", "gap");
  } else if (layoutMode !== "none") {
    out.push({ property: "display", value: "flex" });
    if (layoutMode === "column") out.push({ property: "flex-direction", value: "column" });
    const wraps = getProp(p, "layoutWrap");
    if (wraps) {
      out.push({ property: "flex-wrap", value: "wrap" });
      // Lines pack at the start, as the editor lays them out.
      out.push({ property: "align-content", value: "flex-start" });
    }
    const justify = getProp(p, "justifyContent");
    if (justify !== "start")
      out.push({
        property: "justify-content",
        value: justify === "space-between" ? "space-between" : flexAlign(justify),
      });
    const align = getProp(p, "alignItems");
    if (align !== "start")
      out.push({ property: "align-items", value: align === "baseline" ? align : flexAlign(align) });
    if (!wraps) {
      if (getProp(p, "gap") !== 0 || bindings.gap) push("gap", px(getProp(p, "gap")), "gap");
    } else if (layoutMode === "row") {
      gaps(getProp(p, "rowGap"), getProp(p, "gap"), "rowGap", "gap");
    } else {
      // In a wrapping column the gap between lines runs across, between columns.
      gaps(getProp(p, "gap"), getProp(p, "rowGap"), "gap", "rowGap");
    }
  }
  if (layoutMode !== "none") {
    const [t, r, b, l] = [
      getProp(p, "paddingTop"),
      getProp(p, "paddingRight"),
      getProp(p, "paddingBottom"),
      getProp(p, "paddingLeft"),
    ];
    if (t || r || b || l) {
      if (t === b && l === r && bindings.paddingTop && bindings.paddingTop === bindings.paddingLeft)
        push("padding", px(t), "paddingTop");
      else
        out.push({
          property: "padding",
          value:
            t === b && l === r
              ? t === l
                ? px(t)
                : `${px(t)} ${px(r)}`
              : `${px(t)} ${px(r)} ${px(b)} ${px(l)}`,
        });
    }
  }

  // Size.
  if (node.type !== "page" && node.type !== "group") {
    const row = parentLayout === "row";
    const sizeCss = (axis: "width" | "height") => {
      const sizing = getProp(p, axis === "width" ? "sizingH" : "sizingV");
      const mainAxis = inLayout && ((axis === "width" && row) || (axis === "height" && !row));
      if (sizing === "fill") {
        if (inLayout && parentLayout === "grid") {
          const property = axis === "width" ? "justify-self" : "align-self";
          if (!out.some((d) => d.property === property)) out.push({ property, value: "stretch" });
        } else if (mainAxis) out.push({ property: "flex", value: "1 1 0" });
        else if (inLayout && !out.some((d) => d.property === "align-self"))
          out.push({ property: "align-self", value: "stretch" });
        else out.push({ property: axis, value: "100%" });
        return;
      }
      if (
        sizing === "hug" ||
        (isText &&
          ((axis === "width" && getProp(p, "textAutoResize") === "width") ||
            (axis === "height" && getProp(p, "textAutoResize") !== "none")))
      ) {
        if (!isText) out.push({ property: axis, value: "fit-content" });
        return;
      }
      push(axis, px(getProp(p, axis)), axis);
    };
    sizeCss("width");
    sizeCss("height");
    for (const [prop, css] of [
      ["minWidth", "min-width"],
      ["maxWidth", "max-width"],
      ["minHeight", "min-height"],
      ["maxHeight", "max-height"],
    ] as const) {
      const v = getProp(p, prop);
      if (v !== null) out.push({ property: css, value: px(v) });
    }
  }

  // Appearance.
  if (getProp(p, "opacity") < 1 || bindings.opacity)
    push("opacity", String(Math.round(getProp(p, "opacity") * 100) / 100), "opacity");
  if (node.type === "frame" || node.type === "rect") {
    const radii = getProp(p, "cornerRadii");
    if (radii) out.push({ property: "border-radius", value: radii.map(px).join(" ") });
    else if (getProp(p, "cornerRadius") > 0 || bindings.cornerRadius)
      push("border-radius", px(getProp(p, "cornerRadius")), "cornerRadius");
  }
  if (node.type === "ellipse") out.push({ property: "border-radius", value: "50%" });
  if ((node.type === "polygon" || node.type === "star") && getProp(p, "cornerRadius") === 0) {
    // Exact for sharp corners; rounded ones need the SVG.
    const w = getProp(p, "width") || 1;
    const h = getProp(p, "height") || 1;
    const points = shapeVertices(
      w,
      h,
      getProp(p, "pointCount"),
      node.type === "star" ? getProp(p, "innerRadius") : null,
    )
      .map((v) => `${Math.round((v.x / w) * 1000) / 10}% ${Math.round((v.y / h) * 1000) / 10}%`)
      .join(", ");
    out.push({ property: "clip-path", value: `polygon(${points})` });
  }

  const fills = getProp(p, "fills")
    .map(paintCss)
    .filter((v): v is string => v !== null);
  if (isText) {
    if (fills[0]) push("color", fills[0], "fill");
  } else if (fills.length === 1) {
    push(
      fills[0]?.startsWith("#") || fills[0]?.startsWith("rgb") ? "background-color" : "background",
      fills[0] as string,
      "fill",
    );
  } else if (fills.length > 1) {
    // CSS layers backgrounds top-first; Drawpane stacks paints bottom-first.
    out.push({
      property: "background",
      value: [...fills]
        .reverse()
        .map((f) => (f.includes("gradient") ? f : `linear-gradient(${f}, ${f})`))
        .join(", "),
    });
  }

  const strokes = getProp(p, "strokes")
    .map(paintCss)
    .filter((v): v is string => v !== null);
  const weight = getProp(p, "strokeWeight");
  if (strokes[0] && weight > 0 && !isText) {
    const align = getProp(p, "strokeAlign");
    const color = tokenName("stroke")
      ? `var(${cssVariableName(tokenName("stroke") as string)})`
      : strokes[0];
    if (align === "outside")
      out.push({ property: "outline", value: `${px(weight)} solid ${color}` });
    else {
      out.push({ property: "border", value: `${px(weight)} solid ${color}` });
      if (align === "inside") out.push({ property: "box-sizing", value: "border-box" });
    }
  }

  const shadows: string[] = [];
  for (const e of getProp(p, "effects")) {
    if (e.visible === false) continue;
    if (e.type === "drop-shadow" || e.type === "inner-shadow") {
      shadows.push(
        `${e.type === "inner-shadow" ? "inset " : ""}${px(e.x)} ${px(e.y)} ${px(e.blur)} ${px(e.spread)} ${hex(e.color)}`,
      );
    } else if (e.type === "layer-blur")
      out.push({ property: "filter", value: `blur(${px(e.radius)})` });
    else if (e.type === "background-blur")
      out.push({ property: "backdrop-filter", value: `blur(${px(e.radius)})` });
  }
  if (shadows.length > 0) out.push({ property: "box-shadow", value: shadows.join(", ") });

  const rotation = getProp(p, "rotation");
  if (rotation !== 0 && node.type !== "group")
    out.push({ property: "transform", value: `rotate(${Math.round(rotation * 100) / 100}deg)` });

  if (isText) {
    const family = getProp(p, "fontFamily");
    push("font-family", `"${family}", sans-serif`, "fontFamily");
    push("font-size", px(getProp(p, "fontSize")), "fontSize");
    if (getProp(p, "fontWeight") !== 400)
      out.push({ property: "font-weight", value: String(getProp(p, "fontWeight")) });
    if (getProp(p, "fontStyle") === "italic") out.push({ property: "font-style", value: "italic" });
    const lh = getProp(p, "lineHeight");
    out.push({
      property: "line-height",
      value:
        lh.unit === "auto" ? px(lineHeightPx(p)) : lh.unit === "px" ? px(lh.value) : `${lh.value}%`,
    });
    const ls = letterSpacingPx(p);
    if (ls !== 0) out.push({ property: "letter-spacing", value: px(ls) });
    if (getProp(p, "textAlign") !== "left")
      out.push({ property: "text-align", value: getProp(p, "textAlign") });
    const tc = getProp(p, "textCase");
    if (tc !== "none")
      out.push({
        property: "text-transform",
        value: tc === "upper" ? "uppercase" : tc === "lower" ? "lowercase" : "capitalize",
      });
    const td = getProp(p, "textDecoration");
    if (td !== "none")
      out.push({
        property: "text-decoration",
        value: td === "strikethrough" ? "line-through" : "underline",
      });
  }
  return out;
}

/** A CSS class name from a layer name: "Hero card" → "hero-card". */
export function className(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "layer"
  );
}

/** A CSS rule for a layer, with resolved values of variables in comments. */
export function cssRule(doc: Doc, node: NodeRecord): string {
  const name = getProp(node.props, "name") || node.type;
  const lines = cssFor(doc, node).map(
    (d) => `  ${d.property}: ${d.value};${d.resolved ? ` /* ${d.resolved} */` : ""}`,
  );
  return `/* ${name} */\n.${className(name)} {\n${lines.join("\n")}\n}`;
}

// ---------------------------------------------------------------------------
// Tailwind

const SPACING: Record<number, string> = {
  0: "0",
  1: "px",
  2: "0.5",
  4: "1",
  6: "1.5",
  8: "2",
  10: "2.5",
  12: "3",
  14: "3.5",
  16: "4",
  20: "5",
  24: "6",
  28: "7",
  32: "8",
  36: "9",
  40: "10",
  44: "11",
  48: "12",
  56: "14",
  64: "16",
  80: "20",
  96: "24",
};

const NAMED_COLORS: Record<string, string> = { "#ffffff": "white", "#000000": "black" };

function tw(prefix: string, value: string, numeric?: number): string {
  if (value.startsWith("var(")) return `${prefix}-[${value}]`;
  const named = NAMED_COLORS[value.toLowerCase()];
  if (named) return `${prefix}-${named}`;
  if (numeric !== undefined && SPACING[numeric] !== undefined)
    return `${prefix}-${SPACING[numeric]}`;
  return `${prefix}-[${value.replace(/\s+/g, "_")}]`;
}

/** Tailwind classes for what a styled run changes from its text layer. */
function runClasses(props: Props, own: RunStyle): string[] {
  const out: string[] = [];
  if (own.fontFamily)
    out.push(`font-['${own.fontFamily.replace(/['"]/g, "").replace(/\s+/g, "_")}']`);
  if (own.fontSize !== undefined) out.push(tw("text", px(own.fontSize)));
  if (own.fontWeight !== undefined) out.push(`font-[${own.fontWeight}]`);
  if (own.fontStyle) out.push(own.fontStyle === "italic" ? "italic" : "not-italic");
  if (own.letterSpacing) out.push(tw("tracking", px(letterSpacingPx(props))));
  if (own.textCase)
    out.push(
      { upper: "uppercase", lower: "lowercase", title: "capitalize", none: "normal-case" }[
        own.textCase
      ],
    );
  if (own.textDecoration)
    out.push(
      { underline: "underline", strikethrough: "line-through", none: "no-underline" }[
        own.textDecoration
      ],
    );
  const solid = own.fills?.findLast((f) => f.visible !== false && f.type === "solid");
  if (solid?.type === "solid") out.push(tw("text", solid.color));
  return out;
}

/** Tailwind classes for a layer (arbitrary values where the scale has no step). */
export function tailwindFor(doc: Doc, node: NodeRecord): string[] {
  const classes: string[] = [];
  for (const d of cssFor(doc, node)) {
    const n = Number.parseFloat(d.value);
    const isPx = /^-?[\d.]+px$/.test(d.value);
    switch (d.property) {
      case "position":
        classes.push(d.value);
        break;
      case "left":
        classes.push(tw("left", d.value, isPx ? n : undefined));
        break;
      case "top":
        classes.push(tw("top", d.value, isPx ? n : undefined));
        break;
      case "display":
        classes.push(d.value);
        break;
      case "grid-template-columns":
      case "grid-template-rows": {
        const prefix = d.property === "grid-template-columns" ? "grid-cols" : "grid-rows";
        const repeat = d.value.match(/^repeat\((\d+), 1fr\)$/);
        classes.push(repeat ? `${prefix}-${repeat[1]}` : tw(prefix, d.value));
        break;
      }
      case "grid-column":
      case "grid-row": {
        const prefix = d.property === "grid-column" ? "col" : "row";
        const [start, span] = d.value.split(" / span ");
        classes.push(`${prefix}-start-${start}`);
        if (span) classes.push(`${prefix}-span-${span}`);
        break;
      }
      case "justify-items":
        classes.push(`justify-items-${d.value}`);
        break;
      case "justify-self":
        classes.push(`justify-self-${d.value}`);
        break;
      case "align-content":
        classes.push(`content-${d.value.replace("flex-", "")}`);
        break;
      case "row-gap":
        classes.push(tw("gap-y", d.value, isPx ? n : undefined));
        break;
      case "column-gap":
        classes.push(tw("gap-x", d.value, isPx ? n : undefined));
        break;
      case "flex-direction":
        classes.push("flex-col");
        break;
      case "flex-wrap":
        classes.push("flex-wrap");
        break;
      case "justify-content":
        classes.push(`justify-${d.value.replace("flex-", "").replace("space-", "")}`);
        break;
      case "align-items":
        classes.push(`items-${d.value.replace("flex-", "")}`);
        break;
      case "align-self":
        classes.push(`self-${d.value.replace("flex-", "")}`);
        break;
      case "flex":
        classes.push("flex-1");
        break;
      case "gap":
        classes.push(tw("gap", d.value, isPx ? n : undefined));
        break;
      case "padding": {
        const parts = d.value.split(" ");
        if (parts.length === 1) classes.push(tw("p", d.value, isPx ? n : undefined));
        else if (parts.length === 2) {
          classes.push(
            tw("py", parts[0] as string, Number.parseFloat(parts[0] as string)),
            tw("px", parts[1] as string, Number.parseFloat(parts[1] as string)),
          );
        } else {
          (["pt", "pr", "pb", "pl"] as const).forEach((side, i) => {
            const v = parts[i] as string;
            classes.push(tw(side, v, Number.parseFloat(v)));
          });
        }
        break;
      }
      case "width":
        classes.push(
          d.value === "fit-content"
            ? "w-fit"
            : d.value === "100%"
              ? "w-full"
              : tw("w", d.value, isPx ? n : undefined),
        );
        break;
      case "height":
        classes.push(
          d.value === "fit-content"
            ? "h-fit"
            : d.value === "100%"
              ? "h-full"
              : tw("h", d.value, isPx ? n : undefined),
        );
        break;
      case "border-radius":
        classes.push(d.value === "50%" ? "rounded-full" : tw("rounded", d.value));
        break;
      case "background-color":
      case "background":
        classes.push(tw("bg", d.value));
        break;
      case "color":
        classes.push(tw("text", d.value));
        break;
      case "opacity":
        classes.push(
          `opacity-[${d.value.startsWith("var(") ? d.value : Math.round(n * 100) / 100}]`,
        );
        break;
      case "font-size":
        classes.push(tw("text", d.value));
        break;
      case "font-weight":
        classes.push(`font-[${d.value}]`);
        break;
      case "line-height":
        classes.push(tw("leading", d.value));
        break;
      case "letter-spacing":
        classes.push(tw("tracking", d.value));
        break;
      case "text-align":
        classes.push(`text-${d.value}`);
        break;
      case "box-shadow":
        classes.push(tw("shadow", d.value));
        break;
      default:
        classes.push(`[${d.property}:${d.value.replace(/\s+/g, "_")}]`);
    }
  }
  return classes;
}

function escapeJsx(text: string): string {
  return text.replace(
    /[{}<>&]/g,
    (c) => ({ "{": "&#123;", "}": "&#125;", "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c,
  );
}

/** JSX with Tailwind classes for a layer and everything inside it. */
export function jsxFor(doc: Doc, node: NodeRecord, depth = 0, limit = 200): string {
  const indent = "  ".repeat(depth);
  const classes = tailwindFor(doc, node).join(" ");
  const attr = classes ? ` className="${classes}"` : "";
  if (node.type === "text") {
    const characters = getProp(node.props, "characters");
    // Styled runs become spans carrying what they change.
    const inner = textSpans(node)
      .map((span) => {
        const text = escapeJsx(characters.slice(span.start, span.end));
        const own = runClasses(span.props, span.own);
        return own.length > 0 ? `<span className="${own.join(" ")}">${text}</span>` : text;
      })
      .join("");
    return `${indent}<p${attr}>${inner}</p>`;
  }
  const children = doc.childIds(node.id);
  if (children.length === 0 || limit <= 0) return `${indent}<div${attr} />`;
  const inner = children
    .map((id) => doc.get(id))
    .filter((c): c is NodeRecord => !!c && getProp(c.props, "visible"))
    .map((c) => jsxFor(doc, c, depth + 1, limit - 1))
    .join("\n");
  return `${indent}<div${attr}>\n${inner}\n${indent}</div>`;
}
