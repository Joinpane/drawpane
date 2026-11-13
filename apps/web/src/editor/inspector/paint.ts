/**
 * Paint helpers shared by the fill, stroke and effect controls: swatch CSS,
 * gradient angles, converting a paint between kinds, the colors a file
 * already uses, and the color behind a layer (for contrast).
 */
import type { Doc } from "@drawpane/editor";
import { getProp, type NodeRecord, type Paint } from "@drawpane/model";
import { composite, cssColor, parseHex, type Rgba, toHex } from "@drawpane/ui";

export type GradientPaint = Extract<Paint, { type: "linear" | "radial" | "angular" }>;
export type GradientKind = GradientPaint["type"];
export type SolidPaint = Extract<Paint, { type: "solid" }>;
export type PaintKind = "solid" | "gradient" | "image";

export const CHECKER =
  "repeating-conic-gradient(var(--line-strong) 0% 25%, var(--surface-raised) 0% 50%) 0 0 / 8px 8px";

/** A paint's color with its opacity applied, as rgba. */
export function rgbaOf(hex: string, opacity = 1): Rgba {
  const c = parseHex(hex) ?? { r: 0, g: 0, b: 0, a: 1 };
  return { ...c, a: c.a * opacity };
}

/** The color a picker shows for a solid paint: its color with the paint's opacity as alpha. */
export function solidPickerValue(paint: SolidPaint): string {
  return toHex(rgbaOf(paint.color, paint.opacity ?? 1));
}

/** A picker's color back onto a solid paint: six-digit color, alpha into opacity. */
export function withPickerValue(paint: SolidPaint, hex: string): SolidPaint {
  const c = parseHex(hex) ?? { r: 0, g: 0, b: 0, a: 1 };
  const { opacity: _drop, ...rest } = paint;
  // Opacity is shown in whole percent: store what's shown (a hex byte can't say 50% exactly).
  const a = Math.round(c.a * 100) / 100;
  return { ...rest, color: toHex({ ...c, a: 1 }), ...(a < 1 ? { opacity: a } : {}) };
}

/** CSS angle (0° points up, clockwise) of a linear gradient's handles. */
export function gradientAngle(paint: Pick<GradientPaint, "from" | "to">): number {
  const deg = (Math.atan2(paint.to.x - paint.from.x, -(paint.to.y - paint.from.y)) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360);
}

/** Handles for a linear gradient at a CSS angle, across the whole box. */
export function handlesForAngle(angle: number): Pick<GradientPaint, "from" | "to"> {
  const r = (angle * Math.PI) / 180;
  const dx = Math.sin(r) / 2;
  const dy = -Math.cos(r) / 2;
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return {
    from: { x: round(0.5 - dx), y: round(0.5 - dy) },
    to: { x: round(0.5 + dx), y: round(0.5 + dy) },
  };
}

function stopsCss(paint: GradientPaint): string {
  return [...paint.stops]
    .sort((a, b) => a.position - b.position)
    .map(
      (s) =>
        `${cssColor(rgbaOf(s.color, paint.opacity ?? 1))} ${Math.round(s.position * 1000) / 10}%`,
    )
    .join(", ");
}

/** Handles for an angular gradient around `centre`, starting at a CSS angle (0° up, clockwise). */
export function angularHandles(
  centre: { x: number; y: number },
  angle: number,
): Pick<GradientPaint, "from" | "to"> {
  const r = (angle * Math.PI) / 180;
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return {
    from: { x: round(centre.x), y: round(centre.y) },
    to: { x: round(centre.x + Math.sin(r) / 2), y: round(centre.y - Math.cos(r) / 2) },
  };
}

/** CSS for a gradient, as the swatch and the stop bar show it. */
export function gradientCss(paint: GradientPaint, opaque = false): string {
  const p = opaque ? { ...paint, opacity: 1 } : paint;
  if (paint.type === "angular") {
    return `conic-gradient(from ${gradientAngle(paint)}deg at ${paint.from.x * 100}% ${paint.from.y * 100}%, ${stopsCss(p)})`;
  }
  if (paint.type === "radial") {
    const r = Math.hypot(paint.to.x - paint.from.x, paint.to.y - paint.from.y) * 100;
    return `radial-gradient(circle ${Math.max(1, r)}% at ${paint.from.x * 100}% ${paint.from.y * 100}%, ${stopsCss(p)})`;
  }
  return `linear-gradient(${gradientAngle(paint)}deg, ${stopsCss(p)})`;
}

/** The background of a paint's swatch: the paint over a checkerboard. */
export function swatchCss(paint: Paint): string {
  if (paint.type === "solid") {
    const c = cssColor(rgbaOf(paint.color, paint.opacity ?? 1));
    return `linear-gradient(${c}, ${c}), ${CHECKER}`;
  }
  if (paint.type === "image") return "var(--surface-sunken)";
  return `${gradientCss(paint)}, ${CHECKER}`;
}

export function paintKind(paint: Paint): PaintKind {
  return paint.type === "solid" ? "solid" : paint.type === "image" ? "image" : "gradient";
}

/** The paint's shared fields (visibility, opacity, blend), copied only when set. */
export function paintBase(paint: Paint) {
  return {
    ...(paint.visible !== undefined ? { visible: paint.visible } : {}),
    ...(paint.opacity !== undefined ? { opacity: paint.opacity } : {}),
    ...(paint.blendMode !== undefined ? { blendMode: paint.blendMode } : {}),
  };
}

/** The main color of any paint: a solid's color, a gradient's first stop. */
export function leadColor(paint: Paint): string {
  if (paint.type === "solid") return paint.color;
  if (paint.type === "image") return "#d9d9d6";
  return [...paint.stops].sort((a, b) => a.position - b.position)[0]?.color ?? "#000000";
}

/** Where each gradient kind puts its handles when a paint becomes that kind. */
function handlesFor(kind: GradientKind): Pick<GradientPaint, "from" | "to"> {
  if (kind === "linear") return handlesForAngle(180);
  if (kind === "radial") return { from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 } };
  return angularHandles({ x: 0.5, y: 0.5 }, 0);
}

/** Converts a paint to a solid or gradient, keeping its color as far as it can. */
export function convertPaint(paint: Paint, to: "solid" | GradientKind): Paint {
  const base = paintBase(paint);
  if (to === "solid") return { type: "solid", color: leadColor(paint).slice(0, 7), ...base };
  if (paint.type !== "solid" && paint.type !== "image") {
    if (paint.type === to) return paint;
    return { ...paint, type: to, ...handlesFor(to) };
  }
  // From a color: that color fading out, the way Figma starts a gradient.
  const c = parseHex(leadColor(paint)) ?? { r: 0, g: 0, b: 0, a: 1 };
  const stops = [
    { position: 0, color: toHex({ ...c, a: 1 }) },
    { position: 1, color: toHex({ ...c, a: 0 }) },
  ];
  return { type: to, ...handlesFor(to), stops, ...base };
}

/** The color at a position along a gradient's stops (for adding a stop there). */
export function colorAt(paint: GradientPaint, position: number): string {
  const stops = [...paint.stops].sort((a, b) => a.position - b.position);
  const first = stops[0];
  if (!first) return "#000000";
  if (position <= first.position) return first.color;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1] as (typeof stops)[number];
    const b = stops[i] as (typeof stops)[number];
    if (position <= b.position) {
      const t = b.position === a.position ? 0 : (position - a.position) / (b.position - a.position);
      const ca = rgbaOf(a.color);
      const cb = rgbaOf(b.color);
      return toHex({
        r: ca.r + (cb.r - ca.r) * t,
        g: ca.g + (cb.g - ca.g) * t,
        b: ca.b + (cb.b - ca.b) * t,
        a: ca.a + (cb.a - ca.a) * t,
      });
    }
  }
  return (stops.at(-1) as (typeof stops)[number]).color;
}

/**
 * Solid colors the page already uses in fills, strokes, gradient stops and
 * shadows, most used first: the "In this file" swatches.
 */
export function documentColors(doc: Doc, pageId: string | null, limit = 18): string[] {
  const counts = new Map<string, number>();
  const add = (hex: string) => {
    const key = hex.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const walk = (id: string) => {
    for (const childId of doc.childIds(id)) {
      const node = doc.get(childId);
      if (!node) continue;
      for (const paint of [...getProp(node.props, "fills"), ...getProp(node.props, "strokes")]) {
        if (paint.type === "solid") add(paint.color);
        else if (paint.type !== "image") for (const s of paint.stops) add(s.color);
      }
      for (const e of getProp(node.props, "effects")) if ("color" in e) add(e.color);
      walk(childId);
    }
  };
  if (pageId) walk(pageId);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([hex]) => hex);
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * The opaque color behind a layer, for contrast: the visible solid fills of
 * its ancestors, composited from the page up. Unknown backgrounds (images,
 * gradients) stop the search; a page without a color counts as white.
 */
export function backdropOf(doc: Doc, node: NodeRecord): { color: Rgba; name: string } | null {
  const chain = doc.ancestors(node.id).filter((n) => n.type !== "group");
  let color = WHITE;
  let name = "white";
  let known = true;
  for (const ancestor of chain.reverse()) {
    if (ancestor.type === "page") {
      const bg = getProp(ancestor.props, "backgroundColor");
      if (bg) {
        color = rgbaOf(bg);
        name = getProp(ancestor.props, "name") || "the page";
      }
      continue;
    }
    for (const paint of getProp(ancestor.props, "fills")) {
      if (paint.visible === false) continue;
      if (paint.type !== "solid") {
        known = false;
        continue;
      }
      const c = rgbaOf(paint.color, paint.opacity ?? 1);
      // An opaque color hides whatever unknown paint was below it.
      if (c.a >= 1) known = true;
      color = composite(c, color);
      name = getProp(ancestor.props, "name") || "its frame";
    }
  }
  return known ? { color, name } : null;
}
