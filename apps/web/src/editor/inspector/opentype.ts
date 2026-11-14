/**
 * The OpenType features the inspector offers, by name (decision 0005): the
 * ones designers reach for, grouped, then a font's stylistic sets and
 * character variants by the names the font gives them. Only what the font
 * has is listed.
 */
import type { FontFeatures } from "@drawpane/model";

export interface FeatureChoice {
  readonly tag: string;
  readonly label: string;
}

export interface FeatureGroup {
  readonly title: string;
  readonly choices: readonly FeatureChoice[];
}

/** Features fonts turn on by themselves: a checkbox for one starts checked. */
const ON_BY_DEFAULT: ReadonlySet<string> = new Set(["liga", "clig", "calt", "kern"]);

export const isOnByDefault = (tag: string) => ON_BY_DEFAULT.has(tag);

const NAMED: readonly FeatureGroup[] = [
  {
    title: "Figures",
    choices: [
      { tag: "tnum", label: "Tabular figures" },
      { tag: "pnum", label: "Proportional figures" },
      { tag: "onum", label: "Oldstyle figures" },
      { tag: "lnum", label: "Lining figures" },
      { tag: "zero", label: "Slashed zero" },
      { tag: "frac", label: "Fractions" },
      { tag: "sups", label: "Superscript" },
      { tag: "subs", label: "Subscript" },
      { tag: "ordn", label: "Ordinals" },
    ],
  },
  {
    title: "Letters",
    choices: [
      { tag: "liga", label: "Ligatures" },
      { tag: "dlig", label: "Discretionary ligatures" },
      { tag: "calt", label: "Contextual alternates" },
      { tag: "smcp", label: "Small caps" },
      { tag: "c2sc", label: "Capitals to small caps" },
      { tag: "case", label: "Case-sensitive forms" },
      { tag: "salt", label: "Stylistic alternates" },
      { tag: "swsh", label: "Swashes" },
      { tag: "kern", label: "Kerning" },
    ],
  },
];

const NAMES = new Map(NAMED.flatMap((g) => g.choices.map((c) => [c.tag, c.label] as const)));

/** A feature's name: ours, the font's own for a stylistic set, or the set's number. */
export function featureLabel(tag: string, fontName: string | null = null): string {
  const named = NAMES.get(tag);
  if (named) return named;
  const set = /^ss(\d\d)$/.exec(tag);
  if (set) return fontName ?? `Stylistic set ${Number(set[1])}`;
  const variant = /^cv(\d\d)$/.exec(tag);
  if (variant) return fontName ?? `Character variant ${Number(variant[1])}`;
  return fontName ?? tag;
}

/**
 * The groups to show for a font offering `offered` (tag → its own name):
 * our named features it has, then its stylistic sets and character variants.
 * A feature the text already sets shows even if the font lacks it, so it can
 * be turned off.
 */
export function featureGroups(
  offered: ReadonlyMap<string, string | null>,
  set: Readonly<FontFeatures> = {},
): FeatureGroup[] {
  const has = (tag: string) => offered.has(tag) || tag in set;
  const groups: FeatureGroup[] = NAMED.map((g) => ({
    title: g.title,
    choices: g.choices.filter((c) => has(c.tag)),
  }));
  const own = (pattern: RegExp, title: string) => {
    const tags = [...new Set([...offered.keys(), ...Object.keys(set)])]
      .filter((t) => pattern.test(t))
      .sort();
    groups.push({
      title,
      choices: tags.map((tag) => ({ tag, label: featureLabel(tag, offered.get(tag) ?? null) })),
    });
  };
  own(/^ss\d\d$/, "Stylistic sets");
  own(/^cv\d\d$/, "Character variants");
  return groups.filter((g) => g.choices.length > 0);
}

/** Whether a feature is on for text with `features` (unset is the font's default). */
export function featureOn(features: Readonly<FontFeatures>, tag: string): boolean {
  return features[tag] ?? isOnByDefault(tag);
}

/**
 * `features` with `tag` turned `on`: a feature back at the font's default
 * leaves the map, so files say only what differs.
 */
export function withFeature(
  features: Readonly<FontFeatures>,
  tag: string,
  on: boolean,
): FontFeatures {
  const next: FontFeatures = { ...features };
  if (on === isOnByDefault(tag)) delete next[tag];
  else next[tag] = on;
  return next;
}

/** What's set, in words: "Tabular figures, no ligatures", or null when nothing is. */
export function featureSummary(
  features: Readonly<FontFeatures>,
  names: ReadonlyMap<string, string | null> = new Map(),
): string | null {
  const parts = Object.keys(features)
    .filter((tag) => features[tag] !== isOnByDefault(tag))
    .sort()
    .map((tag) => {
      const label = featureLabel(tag, names.get(tag) ?? null);
      // One sentence: "Tabular figures, no ligatures".
      const lower = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
      return features[tag] ? lower : `no ${lower}`;
    });
  if (parts.length === 0) return null;
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
