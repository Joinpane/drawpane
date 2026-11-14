/**
 * Variable axes (decision 0009) for the inspector: their names, how finely
 * their sliders move, and a summary of what text sets.
 */
import type { FontAxis } from "@drawpane/editor";
import type { FontVariations } from "@drawpane/model";

/** The registered axes' names, for fonts that don't name them and for summaries. */
const REGISTERED: Readonly<Record<string, string>> = {
  wght: "Weight",
  wdth: "Width",
  slnt: "Slant",
  opsz: "Optical size",
  ital: "Italic",
  GRAD: "Grade",
};

/** An axis's name: the font's own, else the registered one, else its tag. */
export function axisName(axis: Pick<FontAxis, "tag" | "name">): string {
  return axis.name?.trim() || REGISTERED[axis.tag] || axis.tag;
}

/** How finely an axis's slider moves: whole units on wide ones, tenths or hundredths on narrow ones. */
export function axisStep(axis: Pick<FontAxis, "min" | "max">): number {
  const span = axis.max - axis.min;
  if (span <= 2) return 0.01;
  if (span <= 30) return 0.1;
  return 1;
}

/** A value as its slider lands: on the axis's step, inside its range. */
export function onAxis(axis: Pick<FontAxis, "min" | "max">, value: number): number {
  const step = axisStep(axis);
  const v = Math.min(axis.max, Math.max(axis.min, value));
  return Math.round(Math.round(v / step) * step * 100) / 100;
}

/** "Width 85 · Grade 50", what the text sets, or null when it sets none. */
export function variationSummary(
  variations: FontVariations,
  names: ReadonlyMap<string, string> = new Map(),
): string | null {
  const tags = Object.keys(variations).sort();
  if (tags.length === 0) return null;
  return tags
    .map((tag) => `${names.get(tag) ?? REGISTERED[tag] ?? tag} ${variations[tag]}`)
    .join(" · ");
}

/** `variations` with one axis set, or back at the font's default when `value` is null. */
export function withAxis(
  variations: FontVariations,
  tag: string,
  value: number | null,
): FontVariations {
  const { [tag]: _, ...rest } = variations;
  return value === null ? rest : { ...rest, [tag]: value };
}
