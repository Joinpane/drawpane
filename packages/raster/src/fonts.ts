/**
 * Font files by face: what anything that draws or measures text without the
 * browser needs (decision 0021). The headless renderer hands them to the
 * rasteriser; HarfBuzz shaping and measuring read glyphs from them. The
 * caller decides where bytes come from: in the browser, the font proxy; in
 * the Worker, the proxy's upstream for Google and built-in families and R2
 * for team fonts.
 *
 * Files are TrueType or OpenType (sfnt). WOFF and WOFF2 are for browsers:
 * neither HarfBuzz nor resvg reads them.
 */

/** A face text is set in. */
export interface Face {
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
  /**
   * The family's variable file, rather than its file for this weight: for
   * text that sets axes. One file covers every weight, so the weight only
   * helps pick among a team's uploads.
   */
  readonly variable?: boolean;
}

/** The bytes of a face's font file (TrueType or OpenType), or null when there are none to have. */
export type FontBytesLoader = (face: Face) => Promise<ArrayBuffer | null>;

/** One key per file a face can load: a variable file covers every weight. */
export const faceKey = (f: Face): string =>
  f.variable
    ? `${f.family}\u0000variable\u0000${f.italic}`
    : `${f.family}\u0000${f.weight}\u0000${f.italic}`;

/**
 * A loader that asks for each face once and remembers the answer, failures
 * included (as null): a render asks for the same faces over and over.
 */
export function cachedFontLoader(load: FontBytesLoader): FontBytesLoader {
  const cache = new Map<string, Promise<ArrayBuffer | null>>();
  return (face) => {
    const key = faceKey(face);
    let hit = cache.get(key);
    if (!hit) {
      hit = load(face).catch(() => null);
      cache.set(key, hit);
    }
    return hit;
  };
}

/** Whether bytes are a font resvg and HarfBuzz read: TrueType, OpenType or a collection. */
export function isSfnt(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const tag = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  return tag === "\x00\x01\x00\x00" || tag === "true" || tag === "OTTO" || tag === "ttcf";
}
