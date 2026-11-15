/**
 * Font files in the Worker, for drawing and measuring text headlessly
 * (decisions 0021 and 0023): the same files the editor's shaper reads in the
 * browser, found the way the browser finds them.
 *
 * - A team font is the team's own upload, from R2 (TrueType or OpenType;
 *   WOFF and WOFF2 are for browsers, and nothing here reads them).
 * - Google and built-in families are static TrueType, one file per weight,
 *   from Google's stylesheet API, or the family's variable file for text that
 *   sets axes. Files land in R2 under the font proxy's own keys, so the proxy
 *   and the renderer keep one copy between them.
 *
 * A face a family doesn't have gets its nearest: the same style if there is
 * one, then the nearest weight. Null when there's nothing to read (a system
 * font, Google turned off): the renderer draws that text in its fallback.
 */
import { type Face, type FontBytesLoader, isSfnt } from "@drawpane/raster";
import { fontFileFromGoogle, googleStylesheetUrl, PLAIN_UA, variableFiles } from "../api/fonts";
import { teamFontKey } from "../api/team-fonts";
import type { Env } from "../env";

/** The weight nearest `wanted`, heavier on a tie (as the editor's font picker chooses). */
export function nearestWeight(available: readonly number[], wanted: number): number {
  let best = available[0] ?? wanted;
  for (const w of available) {
    const d = Math.abs(w - wanted);
    const bd = Math.abs(best - wanted);
    if (d < bd || (d === bd && w > best)) best = w;
  }
  return best;
}

/** The face nearest one asked for: the same style if there is one, then the nearest weight. */
export function pickFace<T extends { weight: number; italic: boolean }>(
  faces: readonly T[],
  want: { weight: number; italic: boolean },
): T | null {
  const styled = faces.filter((f) => f.italic === want.italic);
  const pool = styled.length > 0 ? styled : faces;
  const weight = nearestWeight(
    pool.map((f) => f.weight),
    want.weight,
  );
  return pool.find((f) => f.weight === weight) ?? null;
}

/** The font files a Google stylesheet offers, by weight and style. */
export function stylesheetFaces(
  css: string,
): Array<{ weight: number; italic: boolean; url: string }> {
  const out: Array<{ weight: number; italic: boolean; url: string }> = [];
  for (const [, body = ""] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const url = /src:\s*url\(([^)]+)\)/.exec(body)?.[1]?.replace(/^['"]|['"]$/g, "");
    if (!url) continue;
    out.push({
      weight: Number(/font-weight:\s*(\d+)/.exec(body)?.[1] ?? 400),
      italic: /font-style:\s*italic/.test(body),
      url,
    });
  }
  return out;
}

interface TeamFaceRow {
  weight: number;
  weight_max: number | null;
  italic: number;
  sha: string;
}

async function teamFont(env: Env, teamId: string, face: Face): Promise<ArrayBuffer | null> {
  const { results } = await env.DB.prepare(
    `SELECT weight, weight_max, italic, sha FROM team_fonts
      WHERE team_id = ? AND family = ? COLLATE NOCASE AND format IN ('ttf', 'otf')`,
  )
    .bind(teamId, face.family)
    .all<TeamFaceRow>();
  if (results.length === 0) return null;
  const faces = results.map((r) => ({ ...r, italic: r.italic === 1 }));
  const variable = faces.filter((f) => f.weight_max !== null);
  const statics = faces.filter((f) => f.weight_max === null);
  // Text that sets axes wants a variable file; other text the static face nearest its weight,
  // since a variable file draws at its default weight wherever axes can't be set.
  const pick =
    (face.variable ? (variable.find((f) => f.italic === face.italic) ?? variable[0]) : null) ??
    pickFace(statics.length > 0 ? statics : faces, face);
  if (!pick) return null;
  const object = await env.FILES.get(teamFontKey(pick.sha));
  return object ? object.arrayBuffer() : null;
}

/** Google's stylesheet for one face (`700i`), as TrueType; null when Google hasn't that face. */
async function googleStylesheet(family: string, variant: string): Promise<string | null> {
  const response = await fetch(googleStylesheetUrl(family, [variant], null), {
    headers: { "user-agent": PLAIN_UA },
  });
  return response.ok ? response.text() : null;
}

async function googleFont(env: Env, face: Face): Promise<ArrayBuffer | null> {
  if (env.GOOGLE_FONTS === "off") return null;
  let url: string | null = null;
  if (face.variable) {
    const response = await fetch(
      `https://fonts.google.com/download/list?family=${encodeURIComponent(face.family)}`,
      { headers: { "user-agent": PLAIN_UA } },
    );
    if (response.ok) {
      const files = variableFiles(await response.text());
      url = (files.find((f) => f.italic === face.italic) ?? files[0])?.url ?? null;
    }
  }
  if (!url) {
    // The exact face first; Google refuses a weight a static family lacks, so then its regular.
    const tries = [
      `${face.weight}${face.italic ? "i" : ""}`,
      ...(face.italic ? ["400i"] : []),
      "400",
    ];
    for (const variant of [...new Set(tries)]) {
      const css = await googleStylesheet(face.family, variant);
      const found = css ? pickFace(stylesheetFaces(css), face) : null;
      if (found) {
        url = found.url;
        break;
      }
    }
  }
  if (!url) return null;
  const bytes = await fontFileFromGoogle(env, url);
  return bytes && isSfnt(new Uint8Array(bytes)) ? bytes : null;
}

/** Font files for a file's text: its team's fonts first, then Google's. */
export function workerFontLoader(env: Env, teamId: string | null): FontBytesLoader {
  return async (face) =>
    (teamId ? await teamFont(env, teamId, face) : null) ?? (await googleFont(env, face));
}
