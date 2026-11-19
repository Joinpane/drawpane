/**
 * Open Pencil's paints and effects as REST's. The scene graph's values are
 * what the layer shows (styles and overrides applied); the raw record adds
 * what 0.16 doesn't keep (image adjustments, noise and texture settings,
 * progressive blurs), taken only from an entry of the same kind in the same
 * place, so a stale or overridden record never contradicts what's shown.
 */
import type { Figma } from "@drawpane/figma";
import type { Effect, Fill } from "@open-pencil/scene-graph";
import { gradientHandles, type Matrix, rows } from "./geometry";
import type { FigNotes } from "./notes";
import { type RawEffect, type RawPaint, rawImageRef } from "./raw";

const rgba = (c: { r: number; g: number; b: number; a?: number }): Figma.RGBA => ({
  r: c.r,
  g: c.g,
  b: c.b,
  a: c.a ?? 1,
});

/** REST's image filters from Figma's paint filter (newer files) or colour adjustment (older). */
function filters(raw: RawPaint | undefined): Record<string, number> | undefined {
  const f = raw?.paintFilter ?? raw?.filterColorAdjust;
  if (!f) return undefined;
  const out: Record<string, number> = {};
  const take = (from: string, to: string) => {
    const v = f[from];
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) > 1e-6) out[to] = v;
  };
  take("exposure", "exposure");
  take("contrast", "contrast");
  take("vibrance", "saturation");
  take("temperature", "temperature");
  take("tint", "tint");
  take("highlights", "highlights");
  take("shadows", "shadows");
  return Object.keys(out).length > 0 ? out : undefined;
}

export function convertFill(
  f: Fill,
  raw: RawPaint | undefined,
  notes: FigNotes,
): Figma.Paint | null {
  const common = {
    ...(f.visible === false ? { visible: false } : {}),
    ...(f.opacity !== undefined && f.opacity !== 1 ? { opacity: f.opacity } : {}),
    ...(f.blendMode && f.blendMode !== "NORMAL" ? { blendMode: f.blendMode } : {}),
  };
  switch (f.type) {
    case "SOLID":
      return { type: "SOLID", color: rgba(f.color), ...common };
    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND": {
      const handles = gradientHandles(f.type, f.gradientTransform as Matrix | undefined);
      if (!handles) return null;
      return {
        type: f.type,
        gradientHandlePositions: handles,
        gradientStops: (f.gradientStops ?? []).map((s) => ({
          position: s.position,
          color: rgba(s.color),
        })),
        ...common,
      };
    }
    case "IMAGE": {
      const ref = f.imageHash?.toLowerCase();
      const scaleMode = f.imageScaleMode === "CROP" ? "STRETCH" : (f.imageScaleMode ?? "FILL");
      const sameImage = raw?.type === "IMAGE" && rawImageRef(raw) === ref;
      const adjusted = sameImage ? filters(raw) : undefined;
      return {
        type: "IMAGE",
        ...(ref ? { imageRef: ref } : {}),
        scaleMode,
        // Figma keeps a transform with every image, but it means something only for a crop.
        ...(scaleMode === "STRETCH" && f.imageTransform
          ? { imageTransform: rows(f.imageTransform as Matrix) }
          : {}),
        ...(f.scale !== undefined ? { scalingFactor: f.scale } : {}),
        ...(adjusted ? { filters: adjusted } : {}),
        ...common,
      };
    }
    case "VIDEO":
    case "PATTERN":
      // The converter says these can't come across.
      return { type: f.type, ...common };
    default:
      notes.add("paint-noise");
      return null;
  }
}

export function convertFills(
  fills: readonly Fill[],
  raw: readonly RawPaint[] | undefined,
  notes: FigNotes,
): Figma.Paint[] {
  const out: Figma.Paint[] = [];
  fills.forEach((f, i) => {
    const p = convertFill(f, raw?.[i], notes);
    if (p) out.push(p);
  });
  return out;
}

export function convertEffect(
  e: Effect,
  raw: RawEffect | undefined,
  notes: FigNotes,
): Figma.Effect | null {
  const type = e.type as string;
  const same = raw?.type === type ? raw : undefined;
  const visible = e.visible === false ? { visible: false } : {};
  switch (type) {
    case "DROP_SHADOW":
    case "INNER_SHADOW":
      return {
        type,
        color: rgba(e.color),
        offset: { x: e.offset.x, y: e.offset.y },
        radius: e.radius,
        spread: e.spread,
        ...(e.blendMode && e.blendMode !== "NORMAL" ? { blendMode: e.blendMode } : {}),
        ...(e.showShadowBehindNode !== undefined
          ? { showShadowBehindNode: e.showShadowBehindNode }
          : {}),
        ...visible,
      };
    case "FOREGROUND_BLUR":
    case "LAYER_BLUR":
    case "BACKGROUND_BLUR":
      return {
        type: type === "BACKGROUND_BLUR" ? "BACKGROUND_BLUR" : "LAYER_BLUR",
        radius: e.radius,
        ...(same?.blurOpType === "PROGRESSIVE" ? { blurType: "PROGRESSIVE" as const } : {}),
        ...visible,
      };
    case "NOISE":
      return {
        type: "NOISE",
        color: rgba(same?.color ?? e.color),
        ...(same?.noiseType ? { noiseType: same.noiseType } : {}),
        ...(same?.noiseSize ? { noiseSize: same.noiseSize.x } : {}),
        ...(same?.density !== undefined ? { density: same.density } : {}),
        ...(same?.secondaryColor ? { secondaryColor: rgba(same.secondaryColor) } : {}),
        ...(same?.opacity !== undefined ? { opacity: same.opacity } : {}),
        ...visible,
      };
    case "GRAIN":
      return {
        type: "TEXTURE",
        radius: e.radius,
        ...(same?.noiseSize ? { noiseSize: same.noiseSize.x } : {}),
        ...(same?.clipToShape !== undefined ? { clipToShape: same.clipToShape } : {}),
        ...visible,
      };
    case "GLASS":
      // The record's names for the plugin API's (checked against it on a large iOS UI kit):
      // frost is the radius, depth refractionRadius, splay reflectionDistance.
      return {
        type: "GLASS",
        ...(same?.radius !== undefined ? { radius: same.radius } : {}),
        ...(same?.refractionRadius !== undefined ? { depth: same.refractionRadius } : {}),
        ...(same?.refractionIntensity !== undefined
          ? { refraction: same.refractionIntensity }
          : {}),
        ...(same?.specularAngle !== undefined ? { lightAngle: same.specularAngle } : {}),
        ...(same?.specularIntensity !== undefined
          ? { lightIntensity: same.specularIntensity }
          : {}),
        ...(same?.chromaticAberration !== undefined
          ? { dispersion: same.chromaticAberration }
          : {}),
        ...(same?.reflectionDistance !== undefined ? { splay: same.reflectionDistance } : {}),
        ...visible,
      };
    default:
      notes.add("effect-unsupported");
      return null;
  }
}

export function convertEffects(
  effects: readonly Effect[],
  raw: readonly RawEffect[] | undefined,
  notes: FigNotes,
): Figma.Effect[] {
  const out: Figma.Effect[] = [];
  effects.forEach((e, i) => {
    const converted = convertEffect(e, raw?.[i], notes);
    if (converted) out.push(converted);
  });
  return out;
}
