/**
 * Font files for the headless editor (docs/decisions/0021-agent-tools.md):
 * the bytes its HarfBuzz text measurer reads, the same files the browser
 * draws and shapes the same text from, so a layout made here is the one a
 * person sees.
 *
 * A face is asked for one of three ways (`HarfBuzzMeasurer`'s
 * `MeasuredFace` in @drawpane/editor), each answered as the browser
 * answers it:
 *
 * - **As the canvas draws it** (`canvas`). A Google family's stylesheet
 *   has one face per weight it offers; a variable family's all point at
 *   its variable file. CSS picks the face (`cssWeight`), so the file is
 *   the family's variable TrueType (from Google's download manifest) at
 *   that weight, or the static file for it. The built-in families are the
 *   app's own variable files (Instrument Sans 400 to 700, JetBrains Mono
 *   100 to 800, upright only; Instrument Serif regular). Browsers load
 *   these as Google's unicode-range subsets (Latin, Latin Extended…), so
 *   the subsets come along, read from Google's stylesheet for browsers.
 *   Team families are their uploaded faces, picked the same way, whole.
 * - **As the shaper shapes it** (OpenType features): the static TrueType
 *   file nearest the face, as `faceFileUrl` in apps/web has it.
 * - **Its variable file** (`variable`, for variable axes), as
 *   `variableFileUrl` there has it.
 *
 * Google files come through the font proxy's own upstream and R2 copies
 * (api/fonts.ts), team fonts from R2. HarfBuzz reads TrueType and OpenType
 * only, so a team face uploaded as WOFF or WOFF2 has no file here (as for
 * the browser's shaper): the measurer reports it. Files are kept for the
 * isolate's life, up to a budget.
 */
import { type FontFormat, sniffFont } from "@drawpane/model";
import {
  copyFromGoogle,
  fontFileKey,
  GSTATIC_PROXY,
  googleStylesheet,
  googleStylesheetUrl,
  googleVariableFiles,
  scriptFontFile,
} from "@drawpane/worker/src/api/fonts";
import { teamFontKey } from "@drawpane/worker/src/api/team-fonts";
import type { Env } from "./env";

/** A face, as `MeasuredFace` in @drawpane/editor. */
export interface HeadlessFace {
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
  /** Its family's variable file, for text that sets axes. */
  readonly variable?: boolean;
  readonly subset?: string;
  /** The file the canvas draws it from. */
  readonly canvas?: boolean;
}

/** A face's file and the weight it's drawn at, as `FontFile` in @drawpane/editor. */
export interface HeadlessFontFile {
  readonly bytes: ArrayBuffer;
  readonly weight?: number;
  /** The unicode-range subsets browsers load it as, in order. */
  readonly subsets?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
}

/** A stylesheet's unicode-range subsets, rule by rule, as [first, last] code points ("U+4??" is a span). */
export function unicodeRanges(css: string): Array<Array<[number, number]>> {
  return [...css.matchAll(/unicode-range:\s*([^;}]+)/g)].map(([, list = ""]) =>
    list.split(",").flatMap((part): Array<[number, number]> => {
      const m = /^U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?$/i.exec(part.trim());
      if (!m?.[1]) return [];
      const from = Number.parseInt(m[1].replace(/\?/g, "0"), 16);
      const to = Number.parseInt(m[2] ?? m[1].replace(/\?/g, "F"), 16);
      return [[from, to]];
    }),
  );
}

/** What a Google family offers, as the editor's catalog has it (apps/web/src/fonts/google-fonts.json). */
export interface GoogleFamily {
  readonly weights: readonly number[];
  readonly italics: readonly number[];
  readonly variable: boolean;
}

export interface HeadlessFontOptions {
  readonly env: Pick<Env, "DB" | "FILES" | "GOOGLE_FONTS">;
  /** The file's team, whose fonts win over any other family of their name. */
  readonly teamId: string | null;
  /** Keeps a promise going past the response (the request's `waitUntil`), for cache writes. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  /** A Google family's weights and styles, or null when Google has no such family; the catalog by default. */
  readonly google?: (family: string) => Promise<GoogleFamily | null>;
}

const ALL_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const range = (from: number, to: number) => ALL_WEIGHTS.filter((w) => w >= from && w <= to);

/** The families the app ships (apps/web/src/fonts/fonts.ts), as its stylesheets offer them. */
const BUNDLED: Readonly<
  Record<string, GoogleFamily & { readonly span: readonly [number, number] }>
> = {
  "Instrument Sans": { weights: range(400, 700), italics: [], variable: true, span: [400, 700] },
  "Instrument Serif": { weights: [400], italics: [], variable: false, span: [400, 400] },
  "JetBrains Mono": { weights: range(100, 800), italics: [], variable: true, span: [100, 800] },
};

/**
 * The weight CSS draws a face at, among the weights a family's faces offer
 * (CSS Fonts 4, font matching): the weight itself when offered; for 400 to
 * 500, the nearest heavier up to 500, then lighter, then heavier; below
 * 400, lighter first; above 500, heavier first.
 */
export function cssWeight(available: readonly number[], wanted: number): number | null {
  if (available.length === 0) return null;
  if (available.includes(wanted)) return wanted;
  const lighter = available.filter((w) => w < wanted).sort((a, b) => b - a);
  const heavier = available.filter((w) => w > wanted).sort((a, b) => a - b);
  if (wanted >= 400 && wanted <= 500) {
    const upTo500 = heavier.filter((w) => w <= 500);
    return upTo500[0] ?? lighter[0] ?? heavier[0] ?? null;
  }
  return (wanted < 400 ? (lighter[0] ?? heavier[0]) : (heavier[0] ?? lighter[0])) ?? null;
}

/** The weight nearest `wanted` (ties go heavier), as apps/web's `nearestWeight`. */
function nearestWeight(available: readonly number[], wanted: number): number {
  let best = available[0] ?? wanted;
  for (const w of available) {
    const d = Math.abs(w - wanted);
    const bd = Math.abs(best - wanted);
    if (d < bd || (d === bd && w > best)) best = w;
  }
  return best;
}

/** The face nearest one asked for: same style if there is one, then the nearest weight (apps/web's `pickFace`). */
function pickFace<T extends { weight: number; italic: boolean }>(
  faces: readonly T[],
  want: { weight: number; italic: boolean },
): T | null {
  const styled = faces.filter((f) => f.italic === want.italic);
  const pool = styled.length > 0 ? styled : faces;
  if (pool.length === 0) return null;
  const weight = nearestWeight(
    pool.map((f) => f.weight),
    want.weight,
  );
  return pool.find((f) => f.weight === weight) ?? null;
}

/** A team's uploaded face, with what picking among them needs. */
interface TeamFace {
  readonly weight: number;
  readonly weightMax: number | null;
  readonly italic: boolean;
  readonly format: FontFormat;
  readonly sha: string;
}

/** The team face CSS draws `face` from, and the weight on its axis (a variable face covers its range). */
export function pickTeamFace(
  faces: readonly TeamFace[],
  face: { weight: number; italic: boolean },
): { face: TeamFace; weight: number } | null {
  const styled = faces.filter((f) => f.italic === face.italic);
  const pool = styled.length > 0 ? styled : faces;
  const covering = pool.find(
    (f) => f.weightMax !== null && f.weight <= face.weight && face.weight <= f.weightMax,
  );
  if (covering) return { face: covering, weight: face.weight };
  const ends = pool.flatMap((f) => (f.weightMax !== null ? [f.weight, f.weightMax] : [f.weight]));
  const weight = cssWeight(ends, face.weight);
  if (weight === null) return null;
  const picked = pool.find((f) => f.weight === weight || f.weightMax === weight);
  return picked ? { face: picked, weight } : null;
}

const READABLE = (f: { format: FontFormat }) => f.format === "ttf" || f.format === "otf";

/** Font files by R2 key, kept for the isolate's life within a budget; the least recently used go first. */
const files = new Map<string, Promise<ArrayBuffer | null>>();
const fileSizes = new Map<string, number>();
let held = 0;
const BUDGET = 48 * 1024 * 1024;
/** Stylesheets and manifests by what was asked, for the isolate's life. */
const lookups = new Map<string, Promise<unknown>>();
const MAX_LOOKUPS = 500;

/** Forgets every file and lookup this isolate keeps (for tests). */
export function clearHeadlessFonts(): void {
  files.clear();
  fileSizes.clear();
  lookups.clear();
  held = 0;
}

function remember<T>(key: string, load: () => Promise<T>): Promise<T> {
  let hit = lookups.get(key) as Promise<T> | undefined;
  if (!hit) {
    if (lookups.size >= MAX_LOOKUPS) lookups.clear();
    hit = load();
    // A failure is tried again next time.
    hit.catch(() => lookups.delete(key));
    lookups.set(key, hit);
  }
  return hit;
}

function keep(key: string, read: () => Promise<Uint8Array | null>): Promise<ArrayBuffer | null> {
  const hit = files.get(key);
  if (hit) {
    files.delete(key);
    files.set(key, hit);
    return hit;
  }
  const loading = read().then((bytes) => {
    if (!bytes || !sniffable(bytes)) {
      files.delete(key);
      return null;
    }
    const copy = bytes.slice().buffer as ArrayBuffer;
    fileSizes.set(key, copy.byteLength);
    held += copy.byteLength;
    for (const old of files.keys()) {
      if (held <= BUDGET || old === key) break;
      held -= fileSizes.get(old) ?? 0;
      fileSizes.delete(old);
      files.delete(old);
    }
    return copy;
  });
  loading.catch(() => files.delete(key));
  files.set(key, loading);
  return loading;
}

/** TrueType or OpenType: what HarfBuzz reads. */
function sniffable(bytes: Uint8Array): boolean {
  const format = sniffFont(bytes);
  return format === "ttf" || format === "otf";
}

/** The editor's Google catalog, loaded on first use. */
let catalog: Promise<Map<string, GoogleFamily>> | null = null;
export async function catalogFamily(family: string): Promise<GoogleFamily | null> {
  catalog ??= import("../../web/src/fonts/google-fonts.json").then(({ default: data }) => {
    const fromMask = (mask: number) => ALL_WEIGHTS.filter((_, i) => mask & (1 << i));
    const out = new Map<string, GoogleFamily>();
    for (const [name, , upright, italic, variable] of data.families as Array<
      [string, number, number, number, number]
    >)
      out.set(name, {
        weights: fromMask(upright),
        italics: fromMask(italic),
        variable: variable === 1,
      });
    return out;
  });
  return (await catalog).get(family) ?? null;
}

/**
 * A loader for `HarfBuzzMeasurer`: the file for each face, as described at
 * the top of this file, or null when there's none to have (a system or
 * local font, Google turned off, a team font only in WOFF).
 */
export function headlessFontLoader(
  options: HeadlessFontOptions,
): (face: HeadlessFace) => Promise<ArrayBuffer | HeadlessFontFile | null> {
  const { env, teamId } = options;
  const waitUntil = options.waitUntil ?? ((p: Promise<unknown>) => void p.catch(() => {}));
  const google = options.google ?? catalogFamily;
  const googleOn = env.GOOGLE_FONTS !== "off";

  // Looked up once per loader: a team's fonts change as people upload them.
  const teams = new Map<string, Promise<TeamFace[]>>();
  const teamFaces = (family: string): Promise<TeamFace[]> => {
    if (!teamId) return Promise.resolve([]);
    let hit = teams.get(family);
    if (!hit) {
      hit = (async () => {
        const { results } = await env.DB.prepare(
          "SELECT weight, weight_max, italic, format, sha FROM team_fonts WHERE team_id = ? AND family = ?",
        )
          .bind(teamId, family)
          .all<{
            weight: number;
            weight_max: number | null;
            italic: number;
            format: FontFormat;
            sha: string;
          }>();
        return results.map(
          (r): TeamFace => ({
            weight: r.weight,
            weightMax: r.weight_max,
            italic: r.italic === 1,
            format: r.format,
            sha: r.sha,
          }),
        );
      })();
      teams.set(family, hit);
    }
    return hit;
  };

  const teamFile = (face: TeamFace) =>
    keep(teamFontKey(face.sha), async () => {
      const object = await env.FILES.get(teamFontKey(face.sha));
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    });

  /** A gstatic file through this server's proxy path (`/api/fonts/gstatic/…`). */
  const proxied = (url: string) => {
    const at = new URL(url, "https://proxy.invalid");
    const path = at.pathname.startsWith(GSTATIC_PROXY)
      ? at.pathname.slice(GSTATIC_PROXY.length)
      : "";
    const key = fontFileKey(path, at.searchParams);
    if (!key) return Promise.resolve(null);
    return keep(key, async () => {
      const stored = await env.FILES.get(key);
      if (stored) return new Uint8Array(await stored.arrayBuffer());
      return copyFromGoogle(env, key, `${path}${at.search}`);
    });
  };

  /** A static TrueType file for one weight and style, as Google serves it to anything but a browser. */
  const staticFile = async (family: string, weight: number, italic: boolean) => {
    const variant = `${weight}${italic ? "i" : ""}`;
    if (!/^[1-9]00i?$/.test(variant)) return null;
    const upstream = googleStylesheetUrl(family, [variant], null);
    const css = await remember(`css\u0000ttf\u0000${upstream}`, async () => {
      const response = await googleStylesheet(upstream, "ttf", waitUntil);
      return response ? response.text() : null;
    });
    const url = css ? /src:\s*url\(([^)]+)\)/.exec(css)?.[1]?.replace(/^['"]|['"]$/g, "") : null;
    return url ? proxied(url) : null;
  };

  /**
   * The subsets a browser loads a Google family's face as (its stylesheet for
   * browsers); none when Google can't say, and the file is taken whole.
   */
  const subsets = async (family: string, weight: number, italic: boolean) => {
    const upstream = googleStylesheetUrl(family, [`${weight}${italic ? "i" : ""}`], null);
    const css = await remember(`css\u0000woff2\u0000${upstream}`, async () => {
      const response = await googleStylesheet(upstream, "woff2", waitUntil);
      return response ? response.text() : null;
    }).catch(() => null);
    const ranges = css ? unicodeRanges(css) : [];
    return ranges.length > 0 ? { subsets: ranges } : {};
  };

  /** A Google family's variable file for a style (the upright one when it has no italic). */
  const variableFile = async (family: string, italic: boolean, exact = false) => {
    const list = await remember(`variable\u0000${family}`, async () => {
      const response = await googleVariableFiles(family, waitUntil);
      if (!response) return [];
      return ((await response.json()) as { files: Array<{ italic: boolean; url: string }> }).files;
    });
    const file =
      list.find((f) => f.italic === italic) ?? (exact ? undefined : list.find((f) => !f.italic));
    return file ? proxied(file.url) : null;
  };

  return async (face) => {
    if (face.subset !== undefined) {
      const subset = face.subset;
      return keep(`script\0${face.family}\0${subset}`, async () => {
        const bytes = await scriptFontFile(env, face.family, subset);
        return bytes ? new Uint8Array(bytes) : null;
      });
    }
    // A team font wins over any other family of its name.
    const team = await teamFaces(face.family);
    if (team.length > 0) {
      if (face.canvas) {
        const picked = pickTeamFace(team, face);
        if (!picked || !READABLE(picked.face)) return null;
        const bytes = await teamFile(picked.face);
        return bytes && { bytes, weight: picked.weight };
      }
      const readable = team.filter(READABLE);
      const pick = face.variable
        ? (readable.filter((f) => f.weightMax !== null).find((f) => f.italic === face.italic) ??
          readable.find((f) => f.weightMax !== null) ??
          pickFace(readable, face))
        : pickFace(readable, face);
      return pick ? teamFile(pick) : null;
    }

    if (!googleOn) return null;
    const bundled = BUNDLED[face.family];
    const info = bundled ?? (await google(face.family));
    if (!info) return null;

    if (face.canvas) {
      // CSS keeps to the style asked for when the family has it, else draws the upright slanted.
      const italic = face.italic && info.italics.length > 0;
      if (bundled) {
        const weight = Math.min(bundled.span[1], Math.max(bundled.span[0], face.weight));
        const nearest = nearestWeight(info.weights, weight);
        const bytes = info.variable
          ? await variableFile(face.family, false)
          : await staticFile(face.family, nearest, false);
        // The app's own files are Fontsource's, in Google's subsets.
        return bytes && { bytes, weight, ...(await subsets(face.family, nearest, false)) };
      }
      const weight = cssWeight(italic ? info.italics : info.weights, face.weight);
      if (weight === null) return null;
      const bytes =
        (info.variable ? await variableFile(face.family, italic, true) : null) ??
        (await staticFile(face.family, weight, italic));
      return bytes && { bytes, weight, ...(await subsets(face.family, weight, italic)) };
    }
    if (face.variable) return info.variable ? variableFile(face.family, face.italic) : null;
    // The shaper's static file: a variable family's at the weight itself, else the nearest offered.
    const italic = face.italic && info.italics.length > 0;
    const available = italic ? info.italics : info.weights;
    return staticFile(
      face.family,
      info.variable ? face.weight : nearestWeight(available, face.weight),
      italic,
    );
  };
}
