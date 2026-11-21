import createBidi from "bidi-js";

export type TextDirection = "ltr" | "rtl";

export const RIGHT_TO_LEFT =
  /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]|[\u{10800}-\u{10fff}]|[\u{1e800}-\u{1efff}]/u;

const BIDI_CONTROL = /\p{Bidi_Control}/u;
const TRAILING = /[\p{White_Space}\u2066-\u2069]/u;
const bidi = createBidi();

interface DirectionalRange {
  readonly start: number;
  readonly end: number;
  readonly direction: TextDirection;
}

/** Embedding levels are resolved per paragraph and applied to each wrapped line. */
export function bidiText(text: string) {
  if (!RIGHT_TO_LEFT.test(text) && !BIDI_CONTROL.test(text)) return null;
  const embedding = bidi.getEmbeddingLevels(text);
  const paragraphAt = (at: number) => {
    let lo = 0;
    let hi = embedding.paragraphs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((embedding.paragraphs[mid]?.end ?? -1) < at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const line = (start: number, end: number): DirectionalRange[] => {
    if (start >= end) return [];
    const paragraphs = [];
    for (let index = paragraphAt(start); index < embedding.paragraphs.length; index++) {
      const paragraph = embedding.paragraphs[index];
      if (!paragraph || paragraph.start >= end) break;
      let trailing = Math.min(end, paragraph.end + 1);
      const first = Math.max(start, paragraph.start);
      while (trailing > first && TRAILING.test(text[trailing - 1] ?? "")) trailing--;
      paragraphs.push({ ...paragraph, trailing });
    }
    const levels = embedding.levels.slice(start, end);
    for (const paragraph of paragraphs)
      levels.fill(paragraph.level, paragraph.trailing - start, paragraph.end + 1 - start);
    const ranges: DirectionalRange[] = [];
    const owners = new Uint32Array(end - start);
    for (let offset = start; offset < end; ) {
      const level = levels[offset - start] ?? 0;
      let next = offset + 1;
      while (next < end && levels[next - start] === level) next++;
      const direction = level % 2 === 0 ? "ltr" : "rtl";
      owners.fill(ranges.length, offset - start, next - start);
      ranges.push({ start: offset, end: next, direction });
      offset = next;
    }
    for (const paragraph of paragraphs) {
      const first = Math.max(start, paragraph.start) - start;
      const last = Math.min(end, paragraph.end + 1) - start;
      let highest = paragraph.level;
      let lowest = paragraph.level | 1;
      for (let i = first; i < last; i++) {
        const level = levels[i] ?? 0;
        highest = Math.max(highest, level);
        lowest = Math.min(lowest, level | 1);
      }
      for (let level = highest; level >= lowest; level--) {
        for (let i = first; i < last; i++) {
          if ((levels[i] ?? 0) < level) continue;
          const from = i;
          while (i + 1 < last && (levels[i + 1] ?? 0) >= level) i++;
          owners.subarray(from, i + 1).reverse();
        }
      }
    }
    return [...new Set(owners)].map((i) => ranges[i] as DirectionalRange);
  };
  return {
    line,
    paragraphDirection: (index: number): TextDirection =>
      embedding.paragraphs[Math.min(paragraphAt(index), embedding.paragraphs.length - 1)]?.level ===
      1
        ? "rtl"
        : "ltr",
  };
}
