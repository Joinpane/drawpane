/**
 * Figma's effects as Drawpane's. Shadow and blur radii mean the same in
 * both (decision 0013: twice the Gaussian's deviation), so they carry over
 * as they are. Figma's REST API returns glass without its settings, so it
 * comes in with Drawpane's defaults and a note.
 */
import { DEFAULT_GLASS, DEFAULT_NOISE, DEFAULT_TEXTURE, type Effect } from "@drawpane/model";
import type { Notes } from "./notes";
import { blendMode, hexColor } from "./paint";
import type * as Figma from "./rest";

const NOISE_TYPES = { MONOTONE: "mono", DUOTONE: "duo", MULTITONE: "multi" } as const;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A variable a REST alias names, as a Drawpane id, when the file brings it (tokens.ts). */
type Lookup = (alias: unknown) => string | undefined;

/** An effect's fields bound to variables, by Drawpane's names (decision 0034). */
function binds(
  e: Figma.Effect,
  variables: Lookup | undefined,
  fields: Readonly<Record<string, string>>,
): { bind?: Record<string, string> } {
  if (!variables || !e.boundVariables) return {};
  const bind: Record<string, string> = {};
  for (const [figma, ours] of Object.entries(fields)) {
    const id = variables(e.boundVariables[figma as keyof typeof e.boundVariables]);
    if (id) bind[ours] = id;
  }
  return Object.keys(bind).length > 0 ? { bind } : {};
}

const SHADOW_FIELDS = {
  offsetX: "x",
  offsetY: "y",
  radius: "blur",
  spread: "spread",
  color: "color",
} as const;

export function convertEffect(e: Figma.Effect, notes: Notes, variables?: Lookup): Effect | null {
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
        ...binds(e, variables, SHADOW_FIELDS),
      };
    case "LAYER_BLUR":
    case "BACKGROUND_BLUR":
      if (e.blurType === "PROGRESSIVE") notes.add("blur-progressive");
      return {
        type: e.type === "LAYER_BLUR" ? "layer-blur" : "background-blur",
        radius: round2(Math.max(0, e.radius ?? 0)),
        ...visible,
        ...binds(e, variables, { radius: "radius" }),
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
    case "GLASS":
      notes.add("glass-settings");
      return { ...DEFAULT_GLASS, ...visible };
    default:
      return null;
  }
}

export function convertEffects(
  effects: readonly Figma.Effect[] | undefined,
  notes: Notes,
  variables?: Lookup,
): Effect[] {
  const out: Effect[] = [];
  for (const e of effects ?? []) {
    const converted = convertEffect(e, notes, variables);
    if (converted) out.push(converted);
  }
  return out.slice(0, 32);
}
