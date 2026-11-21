/**
 * Font files by face: what anything that draws or measures text without the
 * browser needs (decision 0021). HarfBuzz shaping and measuring read glyphs from them. The
 * caller decides where bytes come from: in the browser, the font proxy; in
 * the Worker, the proxy's upstream for Google and built-in families and R2
 * for team fonts.
 *
 * Files are TrueType or OpenType (sfnt).
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
  /** A fixed script fallback slice ID. */
  readonly subset?: string;
}

/** The bytes of a face's font file (TrueType or OpenType), or null when there are none to have. */
export type FontBytesLoader = (face: Face) => Promise<ArrayBuffer | null>;

/** One key per file a face can load: a variable file covers every weight. */
export const faceKey = (f: Face): string =>
  f.subset !== undefined
    ? `${f.family}\u0000subset\u0000${f.subset}`
    : f.variable
      ? `${f.family}\u0000variable\u0000${f.italic}`
      : `${f.family}\u0000${f.weight}\u0000${f.italic}`;
