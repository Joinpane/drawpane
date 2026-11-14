/**
 * Penpot styles to Drawpane props: fills, strokes, shadows and blurs,
 * blending, corner radii and constraints. Penpot lists fills and strokes
 * topmost first; Drawpane paints its arrays in order (the last on top), so
 * they're reversed.
 */
import { BLEND_MODES, type BlendMode, type Effect, type Paint } from "@drawpane/model";
import type { Notes } from "./notes";

type Raw = Record<string, unknown>;

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** "#RGB" or "#RRGGBB" (any case) with an opacity, to Drawpane's lowercase "#rrggbb[aa]". */
export function color(hex: unknown, opacity = 1): string | null {
  if (typeof hex !== "string") return null;
  let h = hex.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(h))
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  if (/^[0-9a-f]{8}$/.test(h)) {
    opacity *= Number.parseInt(h.slice(6), 16) / 255;
    h = h.slice(0, 6);
  }
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  const a = clamp01(opacity);
  if (a >= 0.999) return `#${h}`;
  return `#${h}${Math.round(a * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/** Penpot media id to Drawpane media hash, for image fills (unknown when not uploaded). */
export type MediaLookup = (mediaId: string) => string | undefined;

function gradient(g: Raw, opacity: number, notes: Notes): Paint | null {
  const stops = (Array.isArray(g.stops) ? (g.stops as Raw[]) : [])
    .map((s) => ({ position: clamp01(num(s.offset)), color: color(s.color, num(s.opacity, 1)) }))
    .filter((s): s is { position: number; color: string } => s.color !== null)
    .sort((a, b) => a.position - b.position);
  if (stops.length === 0) return null;
  if (stops.length === 1)
    stops.push({ ...(stops[0] as { position: number; color: string }), position: 1 });
  const radial = g.type === "radial";
  if (radial && Math.abs(num(g.width, 1) - 1) > 0.01) notes.add("elliptical-gradient");
  return {
    type: radial ? "radial" : "linear",
    from: { x: num(g.startX, 0.5), y: num(g.startY, 0) },
    to: { x: num(g.endX, 0.5), y: num(g.endY, 1) },
    stops: stops.slice(0, 32),
    ...(opacity < 1 ? { opacity: clamp01(opacity) } : {}),
  };
}

function image(i: Raw, opacity: number, media: MediaLookup, notes: Notes): Paint | null {
  const ref = typeof i.id === "string" ? media(i.id) : undefined;
  if (!ref) {
    notes.add("missing-image");
    return null;
  }
  const t = i.transform as Raw | undefined;
  if (t && (num(t.x) !== 0 || num(t.y) !== 0 || num(t.width, 1) !== 1 || num(t.height, 1) !== 1))
    notes.add("image-offset");
  return {
    type: "image",
    ref,
    scaleMode: i.keepAspectRatio === true ? "fill" : "stretch",
    ...(opacity < 1 ? { opacity: clamp01(opacity) } : {}),
  };
}

/** Penpot fills (topmost first) to Drawpane fills (topmost last). */
export function fills(raw: unknown, media: MediaLookup, notes: Notes): Paint[] {
  if (!Array.isArray(raw)) return [];
  const out: Paint[] = [];
  for (const f of raw as Raw[]) {
    const paint = toPaint(f, "fill", media, notes);
    if (paint) out.push(paint);
  }
  return out.reverse().slice(0, 32);
}

function toPaint(f: Raw, kind: "fill" | "stroke", media: MediaLookup, notes: Notes): Paint | null {
  const opacity = num(f[`${kind}Opacity`], num(f.opacity, 1));
  const solid = f[`${kind}Color`];
  const grad = f[`${kind}ColorGradient`];
  const img = f[`${kind}Image`] ?? (kind === "fill" ? f.fillImage : undefined);
  let paint: Paint | null = null;
  if (grad && typeof grad === "object") paint = gradient(grad as Raw, opacity, notes);
  else if (img && typeof img === "object") paint = image(img as Raw, opacity, media, notes);
  else {
    const c = color(solid, opacity);
    if (c) paint = { type: "solid", color: c };
  }
  if (paint && f.hidden === true) return { ...paint, visible: false };
  return paint;
}

export interface StrokeProps {
  strokes: Paint[];
  strokeWeight?: number;
  strokeAlign?: "inside" | "center" | "outside";
  strokeDashes?: number[];
  strokeCap?: "none" | "round" | "square";
  markerStart?: "none" | "arrow" | "triangle" | "circle" | "diamond" | "bar";
  markerEnd?: "none" | "arrow" | "triangle" | "circle" | "diamond" | "bar";
}

const MARKERS: Record<string, StrokeProps["markerEnd"]> = {
  "line-arrow": "arrow",
  "triangle-arrow": "triangle",
  "square-marker": "bar",
  "circle-marker": "circle",
  "diamond-marker": "diamond",
};

/**
 * Penpot strokes to Drawpane's: paints for each, and one weight, alignment,
 * dash pattern and set of ends (from the topmost stroke) for them all.
 */
export function strokes(
  raw: unknown,
  open: boolean,
  media: MediaLookup,
  notes: Notes,
): StrokeProps {
  if (!Array.isArray(raw) || raw.length === 0) return { strokes: [] };
  const list = raw as Raw[];
  const top = list[0] as Raw;
  const paints = list
    .map((s) => toPaint(s, "stroke", media, notes))
    .filter((p): p is Paint => p !== null)
    .reverse();
  const width = Math.max(0, num(top.strokeWidth, 1));
  if (list.some((s) => num(s.strokeWidth, 1) !== width)) notes.add("stroke-weights");
  if (
    ["strokeWidthTop", "strokeWidthRight", "strokeWidthBottom", "strokeWidthLeft"].some(
      (k) => top[k] !== undefined && num(top[k], width) !== width,
    )
  )
    notes.add("stroke-sides");
  const out: StrokeProps = { strokes: paints, strokeWeight: width };
  // Penpot draws a missing alignment centred; Drawpane's default is inside.
  out.strokeAlign =
    top.strokeAlignment === "inner"
      ? "inside"
      : top.strokeAlignment === "outer"
        ? "outside"
        : "center";
  switch (top.strokeStyle) {
    case "dotted":
      out.strokeDashes = [0, width + 5];
      out.strokeCap = "round";
      break;
    case "dashed":
      out.strokeDashes = [num(top.strokeDash, width + 10), num(top.strokeGap, width + 10)];
      break;
    case "mixed":
      out.strokeDashes = [width + 5, width + 5, width + 1, width + 5];
      break;
  }
  if (open) {
    for (const [key, end] of [
      ["strokeCapStart", "markerStart"],
      ["strokeCapEnd", "markerEnd"],
    ] as const) {
      const cap = top[key];
      if (cap === "round" || cap === "square") out.strokeCap = cap;
      else if (typeof cap === "string" && MARKERS[cap]) out[end] = MARKERS[cap];
    }
  }
  return out;
}

/** Shadows and blurs, in Drawpane's order (Penpot applies its shadows reversed). */
export function effects(shape: Raw): Effect[] {
  const out: Effect[] = [];
  const shadows = Array.isArray(shape.shadow) ? (shape.shadow as Raw[]) : [];
  for (const s of [...shadows].reverse()) {
    const c = (s.color ?? {}) as Raw;
    const hex = color(c.color, num(c.opacity, 1));
    if (!hex) continue;
    out.push({
      type: s.style === "inner-shadow" ? "inner-shadow" : "drop-shadow",
      color: hex,
      x: num(s.offsetX),
      y: num(s.offsetY),
      blur: Math.max(0, num(s.blur)),
      spread: num(s.spread),
      ...(s.hidden === true ? { visible: false } : {}),
    });
  }
  const blur = shape.blur as Raw | undefined;
  if (blur && typeof blur === "object") {
    const value = Math.max(0, num(blur.value));
    // Penpot's layer blur is a standard deviation of `value`; the background one, of `value / 2`.
    out.push({
      type: blur.type === "background-blur" ? "background-blur" : "layer-blur",
      radius: blur.type === "background-blur" ? value / 2 : value,
      ...(blur.hidden === true ? { visible: false } : {}),
    });
  }
  const background = shape.backgroundBlur as Raw | undefined;
  if (background && typeof background === "object")
    out.push({
      type: "background-blur",
      radius: Math.max(0, num(background.value)) / 2,
      ...(background.hidden === true ? { visible: false } : {}),
    });
  return out.slice(0, 32);
}

export function blendMode(v: unknown): BlendMode | undefined {
  return typeof v === "string" && v !== "normal" && (BLEND_MODES as readonly string[]).includes(v)
    ? (v as BlendMode)
    : undefined;
}

/** r1..r4 (top-left, top-right, bottom-right, bottom-left) to one radius, or four. */
export function radii(shape: Raw): {
  cornerRadius?: number;
  cornerRadii?: [number, number, number, number];
} {
  const r = ["r1", "r2", "r3", "r4"].map((k) => Math.max(0, num(shape[k], num(shape.rx))));
  const [a, b, c, d] = r as [number, number, number, number];
  if (a === b && b === c && c === d) return a > 0 ? { cornerRadius: a } : {};
  return { cornerRadii: [a, b, c, d] };
}

const CONSTRAINT_H: Record<string, string> = {
  left: "start",
  right: "end",
  leftright: "stretch",
  center: "center",
  scale: "scale",
};
const CONSTRAINT_V: Record<string, string> = {
  top: "start",
  bottom: "end",
  topbottom: "stretch",
  center: "center",
  scale: "scale",
};

/**
 * Constraints, with Penpot's defaults when missing: left and top for a
 * frame's direct children, scale for layers inside groups.
 */
export function constraints(
  shape: Raw,
  inGroup: boolean,
): { constraintH?: string; constraintV?: string } {
  const out: { constraintH?: string; constraintV?: string } = {};
  const h = typeof shape.constraintsH === "string" ? CONSTRAINT_H[shape.constraintsH] : undefined;
  const v = typeof shape.constraintsV === "string" ? CONSTRAINT_V[shape.constraintsV] : undefined;
  const fallback = inGroup ? "scale" : undefined;
  const ch = h ?? fallback;
  const cv = v ?? fallback;
  if (ch && ch !== "start") out.constraintH = ch;
  if (cv && cv !== "start") out.constraintV = cv;
  return out;
}

export { num };
