import type { ShapedText } from "./text";

/** The first general-purpose fallback in the canvas font stack. */
export const FALLBACK_FAMILY = "Instrument Sans";

export interface FontCoverage {
  readonly unicodes: { has(codePoint: number): boolean };
  /** The CSS unicode-range subset that owns a code point, or -1 for none. */
  readonly subset?: (codePoint: number) => number;
}

interface FontRun {
  text: string;
  readonly start: number;
  readonly face: number;
}

/** Strong right-to-left characters (as shaping.ts has them). */
export const RIGHT_TO_LEFT =
  /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]|[\u{10800}-\u{10fff}]|[\u{1e800}-\u{1efff}]/u;
/** Characters that belong with the one before: marks, joiners and variation selectors. */
const ATTACHED = /\p{M}|\u200c|\u200d|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]/u;
const LETTER = /\p{L}/u;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * `text` split where the file drawing it changes (the first face in `chain`
 * that has each character, -1 for none, and its subset there) or its
 * direction does, as the browser splits text into runs before shaping each.
 */
export function fontRuns(text: string, chain: ReadonlyArray<FontCoverage | null>): FontRun[] {
  const out: Array<FontRun & { subset: number; rtl: boolean | null }> = [];
  let offset = 0;
  for (const char of text) {
    const start = offset;
    offset += char.length;
    const last = out[out.length - 1];
    const cp = char.codePointAt(0) as number;
    let subset = -1;
    const face = chain.findIndex((f) => {
      if (!f?.unicodes.has(cp)) return false;
      subset = f.subset?.(cp) ?? 0;
      return subset !== -1;
    });
    if (last && (IGNORABLE.test(char) || (last.face === face && ATTACHED.test(char)))) {
      last.text += char;
      continue;
    }
    const rtl = RIGHT_TO_LEFT.test(char) ? true : LETTER.test(char) ? false : null;
    if (
      last &&
      last.face === face &&
      last.subset === subset &&
      (rtl === null || last.rtl === null || last.rtl === rtl)
    ) {
      last.text += char;
      last.rtl ??= rtl;
    } else out.push({ text: char, start, face, subset, rtl });
  }
  return out;
}

/** Wide characters: CJK, Hangul, kana, fullwidth forms and emoji, a full em in any font. */
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f000}-\u{1faff}]|[\u{20000}-\u{3fffd}]|\p{Extended_Pictographic}/u;

/**
 * An estimate, in em, for characters none of the files has: wide ones a
 * full em, Arabic and Hebrew letters 0.4 (joined, they run narrow), the
 * rest 0.55.
 */
export function lastResortWidth(text: string): number {
  let em = 0;
  for (const char of text) {
    if (ATTACHED.test(char) || IGNORABLE.test(char)) continue;
    em += WIDE.test(char) ? 1 : RIGHT_TO_LEFT.test(char) ? 0.4 : 0.55;
  }
  return em;
}

/** A built-in .notdef outline in 1,000 units per em. Its counters use nonzero winding. */
const LAST_RESORT_BOX =
  "M 45 0 L 505 0 L 505 720 L 45 720 Z M 115 70 L 115 650 L 435 650 L 435 70 Z";
const SPACE_OR_CONTROL = /^[\s\p{Cc}\p{Default_Ignorable_Code_Point}]+$/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A box where even the fallback face has no outline. Its advance comes from the
 * browser's system fallback when available. Headless uses the same em estimates
 * for measurement and drawing.
 */
export function lastResortText(
  text: string,
  size: number,
  measure?: (text: string) => number,
): ShapedText {
  const glyphs: ShapedText["glyphs"][number][] = [];
  const estimated = lastResortWidth(text);
  const width = measure?.(text) ?? estimated * size;
  const unit = estimated > 0 ? width / estimated : size;
  let pen = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    const advance = lastResortWidth(segment) * unit;
    if (!SPACE_OR_CONTROL.test(segment)) {
      glyphs.push({
        d: LAST_RESORT_BOX,
        path: null,
        x: pen + (advance - size * 0.55) / 2,
        y: 0,
        cluster: index,
      });
    }
    pen += advance;
  }
  return { glyphs, scale: size / 1000, width };
}
