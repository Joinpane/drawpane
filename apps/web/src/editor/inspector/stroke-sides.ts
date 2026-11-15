/**
 * The inspector's stroke sides, as Figma has them: all four, one side, or a
 * width for each (`strokeWeights`, top, right, bottom, left). `strokeWeight`
 * stays the widest side, so everything that reads one width (and switching
 * back to all sides) sees what the layer shows.
 */
type Sides = readonly [number, number, number, number];

export const SIDES_MODES = ["all", "top", "right", "bottom", "left", "custom"] as const;
export type SidesMode = (typeof SIDES_MODES)[number];

const SIDE_INDEX = { top: 0, right: 1, bottom: 2, left: 3 } as const;

/** What a layer's widths are: all sides alike, one side alone, or each its own. */
export function sidesMode(weights: Sides | null): SidesMode {
  if (!weights) return "all";
  const [t, r, b, l] = weights;
  if (t === r && r === b && b === l) return "all";
  const lit = weights.filter((w) => w > 0).length;
  const side = (["top", "right", "bottom", "left"] as const)[weights.findIndex((w) => w > 0)];
  return lit === 1 && side ? side : "custom";
}

/** The two props a layer takes for `mode`, from its width (or its widest side) now. */
export function forMode(
  mode: SidesMode,
  weight: number,
  weights: Sides | null,
): { strokeWeights: Sides | null; strokeWeight: number } {
  const widest = weights ? Math.max(...weights) : weight;
  const w = widest > 0 ? widest : 1;
  if (mode === "all") return { strokeWeights: null, strokeWeight: w };
  if (mode === "custom") {
    // What the sides are now, each its own from here.
    const custom = weights ?? ([w, w, w, w] as const);
    return { strokeWeights: custom, strokeWeight: Math.max(...custom) };
  }
  const sides: [number, number, number, number] = [0, 0, 0, 0];
  sides[SIDE_INDEX[mode]] = w;
  return { strokeWeights: sides, strokeWeight: w };
}

/**
 * The width field's value set to `value`: the one side shown, or every side
 * (as wide all round, so an ordinary stroke again).
 */
export function withWeight(
  weights: Sides | null,
  value: number,
): { strokeWeights: Sides | null; strokeWeight: number } {
  const mode = sidesMode(weights);
  if (!weights || mode === "all" || mode === "custom")
    return { strokeWeights: null, strokeWeight: value };
  const sides = weights.map((w) => (w > 0 ? value : 0)) as unknown as Sides;
  return { strokeWeights: sides, strokeWeight: value };
}

/** One side's width set to `value`, the others kept. */
export function withSide(
  weights: Sides,
  side: keyof typeof SIDE_INDEX,
  value: number,
): { strokeWeights: Sides; strokeWeight: number } {
  const sides = [...weights] as [number, number, number, number];
  sides[SIDE_INDEX[side]] = value;
  return { strokeWeights: sides, strokeWeight: Math.max(...sides) };
}
