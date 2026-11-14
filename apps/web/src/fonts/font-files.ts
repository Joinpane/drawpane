/**
 * A face's font file: the bytes behind a family, weight and style, for what
 * needs more than the browser's own text drawing. PDF export embeds them;
 * shaping (OpenType features, decision 0005) reads glyphs from them.
 *
 * Google and built-in families come as static TrueType through this
 * server's font proxy (one file per weight); team fonts are their uploaded
 * files. System and local fonts have no bytes we can read.
 */
import type { FontFormat } from "@drawpane/model";
import { type FontFamily, fonts, nearestWeight } from "./fonts";

/** A face text is set in: family, weight and style. */
export interface Face {
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
}

export const faceKey = (f: Face) => `${f.family}\u0000${f.weight}\u0000${f.italic}`;

/** A file a family offers, with the face it holds. */
export interface FaceFile {
  readonly weight: number;
  readonly italic: boolean;
  readonly url: string;
}

/** The faces a stylesheet offers, with where to get each. */
export function parseFontFaces(css: string): FaceFile[] {
  const out: FaceFile[] = [];
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

/** The face nearest to what text asks for: same style if there is one, then the nearest weight. */
export function pickFace<T extends { weight: number; italic: boolean }>(
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

/**
 * The files a family offers for `wanted` faces, in `formats` (team fonts are
 * whatever was uploaded; the proxy always serves TrueType). Empty when it
 * has no files we can read: a system or local font.
 */
export async function facesOffered(
  family: string,
  info: FontFamily,
  wanted: readonly Face[],
  formats: readonly FontFormat[],
): Promise<FaceFile[]> {
  if (info.source === "team") {
    const teamId = fonts.teamId;
    if (!teamId) return [];
    return (info.faces ?? [])
      .filter((f) => formats.includes(f.format))
      .map((f) => ({
        weight: f.weight,
        italic: f.italic,
        url: `/api/teams/${encodeURIComponent(teamId)}/fonts/file/${f.sha}`,
      }));
  }
  // Built-in families are Google fonts too, so both come through the proxy.
  if (info.source !== "google" && info.source !== "bundled") return [];
  if (!formats.includes("ttf")) return [];
  const variants = new Set(
    wanted.map((face) => {
      const available = face.italic && info.italics.length > 0 ? info.italics : info.weights;
      const weight = info.variable ? face.weight : nearestWeight(available, face.weight);
      return `${weight}${face.italic && info.italics.length > 0 ? "i" : ""}`;
    }),
  );
  const response = await fetch(
    `/api/fonts/google.css?family=${encodeURIComponent(family)}&variants=${[...variants].join(",")}&format=ttf`,
  );
  if (!response.ok) throw new Error(String(response.status));
  return parseFontFaces(await response.text());
}

/**
 * The URL of the file nearest one face, or null when the family has none we
 * can read in `formats` (or isn't known at all).
 */
export async function faceFileUrl(
  face: Face,
  formats: readonly FontFormat[],
): Promise<string | null> {
  const info = await fonts.resolve(face.family);
  if (!info) return null;
  const offered = await facesOffered(face.family, info, [face], formats);
  return pickFace(offered, face)?.url ?? null;
}
