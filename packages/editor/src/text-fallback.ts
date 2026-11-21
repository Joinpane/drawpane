import type { ShapedText } from "./text";
import { bidiText, RIGHT_TO_LEFT, type TextDirection } from "./text-bidi";

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
  readonly direction: TextDirection;
}
/** Characters that belong with the one before: marks, joiners and variation selectors. */
const ATTACHED = /\p{M}|\u200c|\u200d|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]/u;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * `text` split where the file drawing it changes (the first face in `chain`
 * that has each character, -1 for none, and its subset there) or its
 * direction does, as the browser splits text into runs before shaping each.
 */
export function fontRuns(
  text: string,
  chain: ReadonlyArray<FontCoverage | null>,
  direction?: TextDirection,
): FontRun[] {
  const bidi = direction ? null : bidiText(text);
  const ranges = bidi?.line(0, text.length) ?? [
    { start: 0, end: text.length, direction: direction ?? "ltr" },
  ];
  const result: FontRun[] = [];
  for (const range of ranges) {
    const pieces: Array<FontRun & { subset: number }> = [];
    let offset = range.start;
    for (const char of text.slice(range.start, range.end)) {
      const start = offset;
      offset += char.length;
      const last = pieces.at(-1);
      const cp = char.codePointAt(0) as number;
      let subset = -1;
      const face = chain.findIndex((f) => {
        if (!f?.unicodes.has(cp)) return false;
        subset = f.subset?.(cp) ?? 0;
        return subset !== -1;
      });
      if (last && (IGNORABLE.test(char) || (last.face === face && last.subset === subset)))
        last.text += char;
      else pieces.push({ text: char, start, face, subset, direction: range.direction });
    }
    if (range.direction === "rtl") pieces.reverse();
    result.push(...pieces);
  }
  return result;
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
  direction?: TextDirection,
): ShapedText {
  const glyphs: ShapedText["glyphs"][number][] = [];
  const estimated = lastResortWidth(text);
  const width = measure?.(text) ?? estimated * size;
  const unit = estimated > 0 ? width / estimated : size;
  let pen = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    const next = measure
      ? measure(text.slice(0, index + segment.length))
      : pen + lastResortWidth(segment) * unit;
    const advance = Math.max(0, next - pen);
    const left = direction === "rtl" ? width - next : pen;
    if (!SPACE_OR_CONTROL.test(segment)) {
      glyphs.push({
        d: LAST_RESORT_BOX,
        path: null,
        x: left + (advance - size * 0.55) / 2,
        y: 0,
        cluster: index,
      });
    }
    pen = next;
  }
  if (direction === "rtl") glyphs.reverse();
  return { glyphs, scale: size / 1000, width };
}
