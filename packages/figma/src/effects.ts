/**
 * Figma's effects as Drawpane's. Shadow and blur radii mean the same in
 * both (decision 0013: twice the Gaussian's deviation), so they carry over
 * as they are. Figma's REST API returns glass without its settings, so it
 * comes in with Drawpane's defaults and a note; a `.fig` has them all.
 */
import { DEFAULT_GLASS, DEFAULT_NOISE, DEFAULT_TEXTURE, type Effect } from "@drawpane/model";
import type { Notes } from "./notes";
import { blendMode, hexColor } from "./paint";
import type * as Figma from "./rest";

const NOISE_TYPES = { MONOTONE: "mono", DUOTONE: "duo", MULTITONE: "multi" } as const;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function convertEffect(e: Figma.Effect, notes: Notes): Effect | null {
  const visible = e.visible === false ? { visible: false } : {};
  switch (e.type) {
    case "DROP_SHADOW":
    case "INNER_SHADOW":
      return {
        type: e.type === "DROP_SHADOW" ? "drop-shadow" : "inner-shadow",
        color: hexColor(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 }),
        x: round2(e.offset?.x ?? 0),
        y: round2(e.offset?.y ?? 0),
        blur: round2(Math.max(0, e.radius ?? 0)),
        spread: round2(e.spread ?? 0),
        // "Show behind transparent areas", off: cut out under the layer (decision 0031).
        ...(e.type === "DROP_SHADOW" && e.showShadowBehindNode === false
          ? { showBehind: false }
          : {}),
        ...(blendMode(e.blendMode) ? { blendMode: blendMode(e.blendMode) } : {}),
        ...visible,
      };
    case "LAYER_BLUR":
    case "BACKGROUND_BLUR":
      if (e.blurType === "PROGRESSIVE") notes.add("blur-progressive");
      return {
        type: e.type === "LAYER_BLUR" ? "layer-blur" : "background-blur",
        radius: round2(Math.max(0, e.radius ?? 0)),
        ...visible,
      };
    case "NOISE":
      return {
        ...DEFAULT_NOISE,
        noiseType: NOISE_TYPES[e.noiseType ?? "MONOTONE"] ?? "mono",
        size: clamp(e.noiseSize ?? DEFAULT_NOISE.size, 0.5, 50),
        density: clamp(Math.round((e.density ?? DEFAULT_NOISE.density / 100) * 100), 0, 100),
        color: e.color ? hexColor(e.color) : DEFAULT_NOISE.color,
        secondaryColor: e.secondaryColor
          ? hexColor(e.secondaryColor)
          : DEFAULT_NOISE.secondaryColor,
        opacity: clamp(Math.round((e.opacity ?? DEFAULT_NOISE.opacity / 100) * 100), 0, 100),
        ...visible,
      };
    case "TEXTURE":
      return {
        ...DEFAULT_TEXTURE,
        size: clamp(e.noiseSize ?? DEFAULT_TEXTURE.size, 0.5, 50),
        radius: clamp(e.radius ?? DEFAULT_TEXTURE.radius, 0, 100),
        clipToShape: e.clipToShape ?? DEFAULT_TEXTURE.clipToShape,
        ...visible,
      };
    case "GLASS": {
      if (e.depth === undefined && e.lightIntensity === undefined) {
        notes.add("glass-settings");
        return { ...DEFAULT_GLASS, ...visible };
      }
      const share = (v: number | undefined, fallback: number) =>
        v === undefined ? fallback : clamp(round2(v * 100), 0, 100);
      // Figma's angles run 0–360; Drawpane keeps them about 0 (315 is −45, the top left).
      const angle = e.lightAngle ?? DEFAULT_GLASS.angle;
      return {
        type: "glass",
        angle: round2(((((angle + 180) % 360) + 360) % 360) - 180),
        intensity: share(e.lightIntensity, DEFAULT_GLASS.intensity),
        // Glass from before Figma had refraction has none set, and a depth under a pixel.
        refraction: share(e.refraction, DEFAULT_GLASS.refraction),
        depth: clamp(round2(e.depth ?? DEFAULT_GLASS.depth), 0, 200),
        dispersion: share(e.dispersion, DEFAULT_GLASS.dispersion),
        frost: clamp(round2(e.radius ?? DEFAULT_GLASS.frost), 0, 100),
        splay: share(e.splay, DEFAULT_GLASS.splay),
        ...visible,
      };
    }
    default:
      return null;
  }
}

export function convertEffects(
  effects: readonly Figma.Effect[] | undefined,
  notes: Notes,
): Effect[] {
  const out: Effect[] = [];
  for (const e of effects ?? []) {
    const converted = convertEffect(e, notes);
    if (converted) out.push(converted);
  }
  return out.slice(0, 32);
}
