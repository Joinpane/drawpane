/**
 * What the missing fonts panel lists (decision 0034): each family the file
 * uses that isn't here, each style of a family that is here but lacks it,
 * and each family drawn through an alias, with how many layers use them.
 */
import { type FontUse, fontFaceKey, type TextFace } from "@drawpane/editor";
import type { FontResolution } from "@drawpane/model";
import { type FontFamily, WEIGHT_NAMES } from "./fonts";

/** What the panel needs of the font registry. */
export interface FontLookup {
  get(name: string): FontFamily | null;
  resolution(family: string, size: number): FontResolution;
}

export interface StyleReport extends TextFace {
  readonly key: string;
  /** "Semibold Italic". */
  readonly label: string;
  /** Text layers set in it. */
  readonly layers: readonly string[];
  /** Text styles set in it. */
  readonly styles: number;
  /** Shown in a nearby style instead, or in the fallback font. */
  readonly missing: boolean;
}

export interface FamilyReport {
  readonly family: string;
  /**
   * `missing`: nothing provides it (it shows in the fallback). `styles`: it's
   * here, without some of its styles. `aliased`: an alias draws it in other
   * families (which may lack some of its styles too).
   */
  readonly status: "missing" | "styles" | "aliased";
  /** For `aliased`: the families it's drawn in, smallest size first. */
  readonly drawnIn: readonly string[];
  readonly via: FontResolution["via"];
  /** Text layers using it, each once. */
  readonly layers: number;
  readonly styles: readonly StyleReport[];
}

/** "Regular", "Semibold Italic", "Italic", "450". */
export function styleLabel(weight: number, italic: boolean): string {
  const name = WEIGHT_NAMES[weight] ?? String(weight);
  if (!italic) return name;
  return weight === 400 ? "Italic" : `${name} Italic`;
}

/**
 * Whether a family has a style: a variable family any weight in its range,
 * a static one its own weights. System and local fonts don't say which
 * weights they have, so they're taken to have them all.
 */
export function hasStyle(f: FontFamily, weight: number, italic: boolean): boolean {
  if (f.source === "system" || f.source === "local") return true;
  const weights = italic ? f.italics : f.weights;
  if (weights.length === 0) return false;
  if (f.variable) {
    const lo = Math.min(...weights);
    const hi = Math.max(...weights);
    return weight >= lo && weight <= hi;
  }
  return weights.includes(weight);
}

/** The panel's rows, from the file's font usage: missing first, then missing styles, then aliases. */
export function fontReport(uses: readonly FontUse[], lookup: FontLookup): FamilyReport[] {
  const byFamily = new Map<string, FontUse[]>();
  for (const use of uses) byFamily.set(use.family, [...(byFamily.get(use.family) ?? []), use]);
  const out: FamilyReport[] = [];
  for (const [family, list] of byFamily) {
    const sizes = [...new Set(list.flatMap((u) => u.sizes))].sort((a, b) => a - b);
    const resolutions = sizes.map((size) => lookup.resolution(family, size));
    const aliased = resolutions.find((r) => r.via !== null);
    const own = lookup.get(family);
    const status = aliased ? "aliased" : own ? "styles" : "missing";
    const drawnIn = aliased
      ? [...new Set(resolutions.filter((r) => r.via !== null).map((r) => r.family))]
      : [];
    const styles = list
      .map((u): StyleReport => {
        // Each size it's set at draws in its own family (an alias may pick one per size).
        const missing =
          status === "missing" ||
          u.sizes.some((size) => {
            const drawn = lookup.get(lookup.resolution(family, size).family);
            return !drawn || !hasStyle(drawn, u.weight, u.italic);
          });
        return {
          family,
          weight: u.weight,
          italic: u.italic,
          key: fontFaceKey(u),
          label: styleLabel(u.weight, u.italic),
          layers: u.layers,
          styles: u.styles.length,
          missing,
        };
      })
      .sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic));
    if (status === "styles" && !styles.some((s) => s.missing)) continue;
    out.push({
      family,
      status,
      drawnIn,
      via: aliased?.via ?? null,
      layers: new Set(list.flatMap((u) => u.layers)).size,
      styles,
    });
  }
  const rank = { missing: 0, styles: 1, aliased: 2 } as const;
  return out.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] || b.layers - a.layers || a.family.localeCompare(b.family),
  );
}
