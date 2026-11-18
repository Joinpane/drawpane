/**
 * Font aliases in the Worker (decision 0034): which family the headless
 * editor's text is drawn in, answered as the browser's font registry answers
 * it, so a layout an agent makes is the one a person sees.
 *
 * A family is here when the team uploaded it, the app ships it, it's a
 * system family, or Google's catalog has it (unless Google is off): what the
 * editor's registry knows. Fonts on someone's own computer are the one thing
 * only a browser knows; the Worker can't see them.
 *
 * Layout asks synchronously, so `prepare` looks everything up first (the
 * team's families and aliases from D1, the catalog), as the measurer's
 * `load` fetches files before measuring. The team's part is looked up again
 * after a minute, so an alias someone sets reaches a long-lived room.
 */
import type { FontResolver } from "@drawpane/editor";
import {
  aliasTargets,
  BUNDLED_FONT_FAMILIES,
  type FontAliasIndex,
  fontAliasIndex,
  resolveFontFamily,
  SYSTEM_FONT_FAMILIES,
} from "@drawpane/model";
import { teamFontAliases } from "../api/team-fonts";
import type { Env } from "../env";
import { catalogFamily, type GoogleFamily } from "./font-files";

/** How long the team's families and aliases are kept before they're looked up again. */
export const TEAM_FONTS_TTL_MS = 60_000;

export interface HeadlessFontResolver extends FontResolver {
  /** Looks up what resolving these families needs. Call before laying text in them out. */
  prepare(families: Iterable<string>): Promise<void>;
  /** Whether `family` has been prepared (so `family` and `standIns` answer for it). */
  prepared(family: string): boolean;
}

export interface HeadlessFontResolverOptions {
  readonly env: Pick<Env, "DB" | "GOOGLE_FONTS">;
  /** The file's team, looked up once. */
  readonly teamId: () => Promise<string | null>;
  /** A Google family, or null; the editor's catalog by default. */
  readonly google?: (family: string) => Promise<GoogleFamily | null>;
  readonly now?: () => number;
}

interface TeamFonts {
  readonly families: ReadonlySet<string>;
  readonly aliases: FontAliasIndex;
  readonly signature: string;
  readonly at: number;
}

const BUILT_IN = new Set([...BUNDLED_FONT_FAMILIES, ...SYSTEM_FONT_FAMILIES]);

export function headlessFontResolver(options: HeadlessFontResolverOptions): HeadlessFontResolver {
  const { env } = options;
  const google = options.google ?? catalogFamily;
  const now = options.now ?? Date.now;
  const googleOn = env.GOOGLE_FONTS !== "off";
  let team: TeamFonts | null = null;
  let loadingTeam: Promise<void> | null = null;
  /** Whether a family is here apart from the team's fonts (built in, system, Google). */
  const elsewhere = new Map<string, boolean>();
  const prepared = new Set<string>();
  let generation = 0;

  const refreshTeam = async () => {
    const teamId = await options.teamId();
    let families = new Set<string>();
    let aliases: FontAliasIndex = new Map();
    let signature = "";
    if (teamId) {
      const [rows, list] = await Promise.all([
        env.DB.prepare("SELECT DISTINCT family FROM team_fonts WHERE team_id = ?")
          .bind(teamId)
          .all<{ family: string }>(),
        teamFontAliases(env.DB, teamId),
      ]);
      families = new Set(rows.results.map((r) => r.family));
      aliases = fontAliasIndex(list);
      signature = JSON.stringify([[...families].sort(), list.map((a) => [a.family, a.targets])]);
    }
    if (team && team.signature !== signature) {
      // What families resolve to changed: what was prepared is looked at again.
      prepared.clear();
      generation++;
    }
    team = { families, aliases, signature, at: now() };
  };

  const ensureTeam = async () => {
    if (team && now() - team.at < TEAM_FONTS_TTL_MS) return;
    loadingTeam ??= refreshTeam().finally(() => {
      loadingTeam = null;
    });
    await loadingTeam;
  };

  const isElsewhere = async (family: string) => {
    let hit = elsewhere.get(family);
    if (hit === undefined) {
      hit = BUILT_IN.has(family) || (googleOn && (await google(family).catch(() => null)) !== null);
      elsewhere.set(family, hit);
    }
    return hit;
  };

  /** Here, as far as is known; a family not looked up yet counts as here (so it isn't aliased). */
  const available = (family: string) =>
    (team?.families.has(family) ?? false) || (elsewhere.get(family) ?? true);

  return {
    get generation() {
      return generation;
    },

    family(family, size) {
      return resolveFontFamily(family, size, available, team?.aliases);
    },

    standIns(family) {
      return aliasTargets(family, team?.aliases).filter(available);
    },

    prepared: (family) => prepared.has(family),

    async prepare(families) {
      await ensureTeam();
      const fresh: string[] = [];
      for (const family of new Set(families)) if (!prepared.has(family)) fresh.push(family);
      if (fresh.length === 0) return;
      const names = new Set<string>();
      for (const family of fresh) {
        names.add(family);
        for (const target of aliasTargets(family, team?.aliases)) names.add(target);
      }
      const before = [...names].map((n) => available(n));
      await Promise.all([...names].filter((n) => !team?.families.has(n)).map(isElsewhere));
      for (const family of fresh) prepared.add(family);
      // A family that was taken as here and isn't: earlier layouts drew it wrong.
      if ([...names].some((n, i) => available(n) !== before[i])) generation++;
    },
  };
}
