/**
 * Font aliases (decision 0034): which family text is drawn in when the family
 * it names isn't here, chosen by its size where a family comes in optical
 * sizes.
 *
 * Apple ships "SF Pro" as one variable family with an optical size axis,
 * and as two static ones: "SF Pro Text" for small type and "SF Pro Display"
 * for large. Files made on a Mac name "SF Pro"; teams can usually upload only
 * the static files. An alias maps "SF Pro" to both, with the sizes each is
 * for, so 17 px text draws in SF Pro Text and 34 px in SF Pro Display, at its
 * own weight and style, without rewriting the file.
 *
 * Two kinds, one shape:
 *
 * - Built in (`BUILT_IN_FONT_ALIASES`): data, not code paths. Add a row for
 *   another family with the same pattern.
 * - A team's own (`team_font_aliases` in D1): set from the missing fonts
 *   panel, for everyone on the team, every file. A team's alias is tried
 *   before a built-in one for the same family.
 *
 * Precedence (`resolveFontFamily`): the family itself when it's here (a team
 * that uploads the variable "SF Pro" gets exactly that); then the team's
 * alias; then the built-in one; else the family itself, which then shows as
 * missing. Within an alias, the first target that's here and whose sizes hold
 * the text's size; else the nearest by size of those that are here. Aliases
 * don't chain.
 */

export interface FontAliasTarget {
  /** The family drawn instead. */
  readonly family: string;
  /** The smallest font size (px) it's for, inclusive; unset is from 0. */
  readonly minSize?: number;
  /** The size it's for up to, exclusive; unset is no limit. */
  readonly maxSize?: number;
}

export interface FontAlias {
  /** The family text names. */
  readonly family: string;
  /** What to draw it in, tried in order. */
  readonly targets: readonly FontAliasTarget[];
}

/** A team's alias, as the API lists it. */
export interface TeamFontAlias extends FontAlias {
  /** Who set it (their name), when they're still around. */
  readonly updatedBy: string | null;
  readonly updatedAt: number;
}

/**
 * Where Apple's text and display cuts meet: "SF Pro Text for 19 points or
 * smaller, SF Pro Display for 20 points or larger" (Apple's typography
 * guidance). Sizes in between (19.5) go to Text, as below the 20 pt line.
 */
export const OPTICAL_SIZE_SPLIT = 20;

const opticalPair = (family: string, text: string, display: string): FontAlias => ({
  family,
  targets: [
    { family: text, maxSize: OPTICAL_SIZE_SPLIT },
    { family: display, minSize: OPTICAL_SIZE_SPLIT },
  ],
});

/**
 * The aliases every team has. Apple's SF families, by the names files use:
 *
 * - "SF Pro" and "SF Compact": the variable families, split into their Text
 *   and Display cuts at 20 px.
 * - The cuts themselves fall back to the variable family, when that's what
 *   a team uploaded.
 * - "SF UI Text" and "SF UI Display" (the names before 2017) go to the
 *   same cuts under today's names.
 *
 * "SF Pro Rounded", "SF Compact Rounded", "SF Mono" and "New York" ship as
 * single families under those names, so they need no alias.
 */
export const BUILT_IN_FONT_ALIASES: readonly FontAlias[] = [
  opticalPair("SF Pro", "SF Pro Text", "SF Pro Display"),
  opticalPair("SF Compact", "SF Compact Text", "SF Compact Display"),
  { family: "SF Pro Text", targets: [{ family: "SF Pro" }] },
  { family: "SF Pro Display", targets: [{ family: "SF Pro" }] },
  { family: "SF Compact Text", targets: [{ family: "SF Compact" }] },
  { family: "SF Compact Display", targets: [{ family: "SF Compact" }] },
  { family: "SF UI Text", targets: [{ family: "SF Pro Text" }, { family: "SF Pro" }] },
  { family: "SF UI Display", targets: [{ family: "SF Pro Display" }, { family: "SF Pro" }] },
];

const BUILT_IN = new Map(BUILT_IN_FONT_ALIASES.map((a) => [a.family, a]));

/** The built-in alias for a family, if there is one. */
export const builtInFontAlias = (family: string): FontAlias | null => BUILT_IN.get(family) ?? null;

/** Aliases by family, for looking up. */
export type FontAliasIndex = ReadonlyMap<string, FontAlias>;

export const fontAliasIndex = (aliases: Iterable<FontAlias>): FontAliasIndex =>
  new Map([...aliases].map((a) => [a.family, a]));

const EMPTY: FontAliasIndex = new Map();

/** Whether a target is for text of `size` px. */
export const targetHolds = (t: FontAliasTarget, size: number): boolean =>
  size >= (t.minSize ?? 0) && size < (t.maxSize ?? Number.POSITIVE_INFINITY);

/** How far `size` is from a target's sizes (0 inside them). */
function distance(t: FontAliasTarget, size: number): number {
  if (size < (t.minSize ?? 0)) return (t.minSize ?? 0) - size;
  // The largest size is exclusive: text exactly at it is just outside.
  if (t.maxSize !== undefined && size >= t.maxSize) return size - t.maxSize + 1e-9;
  return 0;
}

/**
 * The family of an alias's targets that text of `size` px draws in: the
 * first that's here and holds the size, else the nearest by size of those
 * here (the first on a tie). Null when none is here.
 */
export function pickAliasTarget(
  targets: readonly FontAliasTarget[],
  size: number,
  available: (family: string) => boolean,
): string | null {
  let best: FontAliasTarget | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const t of targets) {
    if (!available(t.family)) continue;
    const d = distance(t, size);
    if (d === 0) return t.family;
    if (d < bestDistance) {
      best = t;
      bestDistance = d;
    }
  }
  return best?.family ?? null;
}

/** How a family resolved, for the missing fonts panel. */
export interface FontResolution {
  /** The family text is drawn in. */
  readonly family: string;
  /** Through which alias: the team's, the built-in one, or none (the family itself, or missing). */
  readonly via: "team" | "built-in" | null;
}

/**
 * The family text named `family` at `size` px is drawn in (see the top of
 * this file for the order). `available` says whether a family is here: a
 * team font, built in, a system font or in the Google catalog.
 */
export function resolveFont(
  family: string,
  size: number,
  available: (family: string) => boolean,
  team: FontAliasIndex = EMPTY,
): FontResolution {
  if (available(family)) return { family, via: null };
  const own = team.get(family);
  const fromTeam = own ? pickAliasTarget(own.targets, size, available) : null;
  if (fromTeam) return { family: fromTeam, via: "team" };
  const builtIn = BUILT_IN.get(family);
  const fromBuiltIn = builtIn ? pickAliasTarget(builtIn.targets, size, available) : null;
  if (fromBuiltIn) return { family: fromBuiltIn, via: "built-in" };
  return { family, via: null };
}

/** `resolveFont`'s family. */
export const resolveFontFamily = (
  family: string,
  size: number,
  available: (family: string) => boolean,
  team: FontAliasIndex = EMPTY,
): string => resolveFont(family, size, available, team).family;

/**
 * Every family text named `family` might be drawn in through an alias (the
 * team's targets, then the built-in one's), each once, without the family
 * itself: what to load ahead, since which one a run uses depends on its size.
 */
export function aliasTargets(family: string, team: FontAliasIndex = EMPTY): string[] {
  const out: string[] = [];
  for (const alias of [team.get(family), BUILT_IN.get(family)])
    for (const t of alias?.targets ?? [])
      if (t.family !== family && !out.includes(t.family)) out.push(t.family);
  return out;
}

/** Families that alias to `target` (the reverse of `aliasTargets`). */
export function aliasSources(target: string, team: FontAliasIndex = EMPTY): string[] {
  const out = new Set<string>();
  for (const alias of [...team.values(), ...BUILT_IN_FONT_ALIASES])
    if (alias.targets.some((t) => t.family === target)) out.add(alias.family);
  return [...out];
}

/**
 * The system families the editor offers (web-safe ones every desktop has):
 * here for every browser, so never aliased. The Worker has no files for
 * them, but asks the same question.
 */
export const SYSTEM_FONT_FAMILIES: readonly string[] = [
  "system-ui",
  "Arial",
  "Helvetica",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Georgia",
  "Times New Roman",
  "Courier New",
];

/** The families the app ships (apps/web/src/fonts/fonts.ts). */
export const BUNDLED_FONT_FAMILIES: readonly string[] = [
  "Instrument Sans",
  "Instrument Serif",
  "JetBrains Mono",
];

/** How many aliases a team keeps, at most. */
export const TEAM_FONT_ALIAS_LIMIT = 200;
/** How many targets one alias has, at most. */
export const FONT_ALIAS_TARGET_LIMIT = 8;

export class FontAliasError extends Error {
  override name = "FontAliasError";
}

/** A family name as fonts name themselves: printable, single spaces, 1 to 128 characters. */
function familyName(value: unknown, what: string): string {
  if (typeof value !== "string") throw new FontAliasError(`${what} must be a family name.`);
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > 128 || [...name].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20))
    throw new FontAliasError(`${what} must be a family name of 1 to 128 characters.`);
  return name;
}

function size(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10_000)
    throw new FontAliasError(`${what} must be a size in px from 0 to 10000.`);
  return value;
}

/** An alias as sent (to the API), checked and tidied. Throws FontAliasError with a sentence. */
export function parseFontAlias(input: unknown): FontAlias {
  if (typeof input !== "object" || input === null)
    throw new FontAliasError("Send an alias: a family and what to draw it in.");
  const raw = input as { family?: unknown; targets?: unknown };
  const family = familyName(raw.family, "The family");
  if (!Array.isArray(raw.targets) || raw.targets.length === 0)
    throw new FontAliasError("An alias needs at least one family to draw in.");
  if (raw.targets.length > FONT_ALIAS_TARGET_LIMIT)
    throw new FontAliasError(`An alias draws in up to ${FONT_ALIAS_TARGET_LIMIT} families.`);
  const targets = raw.targets.map((t: unknown): FontAliasTarget => {
    const target = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
    const name = familyName(target.family, "Each target");
    if (name === family) throw new FontAliasError("A family can't be an alias of itself.");
    const minSize = size(target.minSize, "A smallest size");
    const maxSize = size(target.maxSize, "A largest size");
    if (minSize !== undefined && maxSize !== undefined && minSize >= maxSize)
      throw new FontAliasError("A target's smallest size must be below its largest.");
    return {
      family: name,
      ...(minSize !== undefined ? { minSize } : {}),
      ...(maxSize !== undefined ? { maxSize } : {}),
    };
  });
  return { family, targets };
}
