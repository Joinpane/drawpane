/**
 * Figma's paints, colours and blend modes as Drawpane's. Both lay gradients
 * out in the layer's unit square (decision 0013), so handles carry over as
 * they are; Figma's third handle (the gradient's width) is the default
 * perpendicular one almost always, which is what Drawpane draws.
 */
import type { BlendMode, Paint } from "@drawpane/model";
import type { Notes } from "./notes";
import type * as Figma from "./rest";

const hex2 = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, "0");

/** `#rrggbb`, or `#rrggbbaa` when not opaque, from Figma's 0–1 channels. */
export function hexColor(c: Figma.RGBA, alpha = c.a): string {
  const a = Math.min(1, Math.max(0, alpha));
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 0.999 ? hex2(a) : ""}`;
}

const BLENDS: Readonly<Record<string, BlendMode>> = {
  DARKEN: "darken",
  MULTIPLY: "multiply",
  // Drawpane has no linear burn or dodge: the nearest it has.
  LINEAR_BURN: "color-burn",
  COLOR_BURN: "color-burn",
  LIGHTEN: "lighten",
  SCREEN: "screen",
  LINEAR_DODGE: "color-dodge",
  COLOR_DODGE: "color-dodge",
  OVERLAY: "overlay",
  SOFT_LIGHT: "soft-light",
  HARD_LIGHT: "hard-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity",
};

/** A Figma blend mode as Drawpane's, or undefined for normal (and pass-through). */
export function blendMode(mode: string | undefined): BlendMode | undefined {
  return mode ? BLENDS[mode] : undefined;
}

/** Turns a Figma image ref into the Drawpane media (a sha256) it was uploaded as, or null. */
export type ImageLookup = (imageRef: string) => string | null;

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function convertPaint(p: Figma.Paint, images: ImageLookup, notes: Notes): Paint | null {
  const common = {
    ...(p.visible === false ? { visible: false } : {}),
    ...(p.opacity !== undefined && p.opacity < 0.999 ? { opacity: round4(p.opacity) } : {}),
    ...(blendMode(p.blendMode) ? { blendMode: blendMode(p.blendMode) } : {}),
  };
  switch (p.type) {
    case "SOLID":
      return p.color ? { type: "solid", color: hexColor(p.color), ...common } : null;
    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND": {
      const [from, to, width] = p.gradientHandlePositions ?? [];
      const stops = (p.gradientStops ?? []).map((s) => ({
        position: round4(Math.min(1, Math.max(0, s.position))),
        color: hexColor(s.color),
      }));
      if (!from || !to || stops.length < 2) return null;
      if (p.type === "GRADIENT_DIAMOND") notes.add("gradient-diamond");
      // Drawpane's width handle is always a quarter turn from the main one, as long.
      if (width && p.type !== "GRADIENT_LINEAR") {
        const ex = from.x - (to.y - from.y);
        const ey = from.y + (to.x - from.x);
        if (Math.hypot(width.x - ex, width.y - ey) > 0.01) notes.add("gradient-skewed");
      }
      return {
        type:
          p.type === "GRADIENT_LINEAR"
            ? "linear"
            : p.type === "GRADIENT_ANGULAR"
              ? "angular"
              : "radial",
        from: { x: round4(from.x), y: round4(from.y) },
        to: { x: round4(to.x), y: round4(to.y) },
        stops: stops.slice(0, 32),
        ...common,
      };
    }
    case "IMAGE": {
      const ref = p.imageRef ? images(p.imageRef) : null;
      if (!ref) {
        notes.add("image-missing");
        return null;
      }
      if (p.filters && Object.values(p.filters).some((v) => Math.abs(v) > 1e-3))
        notes.add("image-adjusted");
      if (p.scaleMode === "TILE") {
        if (p.scalingFactor !== undefined && Math.abs(p.scalingFactor - 1) > 1e-3)
          notes.add("image-tile-scale");
        return { type: "image", ref, scaleMode: "tile", ...common };
      }
      if (p.scaleMode === "FIT") return { type: "image", ref, scaleMode: "fit", ...common };
      if (p.scaleMode === "STRETCH" && p.imageTransform) {
        // The image's part the layer shows: the transform takes the layer's unit square into the image's.
        const [[a, c, e], [b, d, f]] = p.imageTransform;
        if (Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && a > 0 && d > 0) {
          const x = Math.min(1, Math.max(0, e));
          const y = Math.min(1, Math.max(0, f));
          const crop = {
            x: round4(x),
            y: round4(y),
            width: round4(Math.max(1e-4, Math.min(a, 1 - x))),
            height: round4(Math.max(1e-4, Math.min(d, 1 - y))),
          };
          const whole = crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
          return whole
            ? { type: "image", ref, scaleMode: "stretch", ...common }
            : { type: "image", ref, scaleMode: "crop", crop, ...common };
        }
        notes.add("skewed");
        return { type: "image", ref, scaleMode: "stretch", ...common };
      }
      return {
        type: "image",
        ref,
        scaleMode: p.scaleMode === "STRETCH" ? "stretch" : "fill",
        ...common,
      };
    }
    default:
      notes.add("paint-unsupported");
      return null;
  }
}

export function convertPaints(
  paints: readonly Figma.Paint[] | undefined,
  images: ImageLookup,
  notes: Notes,
): Paint[] {
  const out: Paint[] = [];
  for (const p of paints ?? []) {
    const converted = convertPaint(p, images, notes);
    if (converted) out.push(converted);
  }
  return out.slice(0, 32);
}
