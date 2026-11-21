/** Open outline families used after Instrument Sans. */
export const SCRIPT_FALLBACK_FAMILIES = [
  "Noto Sans",
  "Noto Sans JP",
  "Noto Sans KR",
  "Noto Sans SC",
  "Noto Sans TC",
  "Noto Sans Arabic",
  "Noto Sans Hebrew",
  "Noto Sans Symbols 2",
  "Noto Sans Math",
  "Noto Emoji",
] as const;

export type ScriptFallbackFamily = (typeof SCRIPT_FALLBACK_FAMILIES)[number];
export type CjkRegion = "JP" | "KR" | "SC" | "TC";

export interface ScriptSubset {
  readonly family: ScriptFallbackFamily;
  /** A fixed catalogue ID, independent of which characters are present in a file. */
  readonly subset: string;
}

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}\u3099\u309a\u30fb\u30fc\uff65\uff70]/u;
const HANGUL = /\p{Script=Hangul}/u;

export function cjkRegionFor(text: string, locale = ""): CjkRegion {
  if (KANA.test(text)) return "JP";
  if (HANGUL.test(text)) return "KR";
  if (/^ja(?:-|$)/i.test(locale)) return "JP";
  if (/^ko(?:-|$)/i.test(locale)) return "KR";
  if (/^zh(?:-[a-z0-9]+)*-(?:Hant|TW|HK|MO)(?:-|$)/i.test(locale)) return "TC";
  return "SC";
}

export function scriptFallbackFamily(
  char: string,
  region: CjkRegion = "SC",
): ScriptFallbackFamily | null {
  if (/\p{Emoji_Presentation}/u.test(char)) return "Noto Emoji";
  if (KANA.test(char)) return "Noto Sans JP";
  if (HANGUL.test(char)) return "Noto Sans KR";
  if (/[\p{Script=Han}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u.test(char))
    return `Noto Sans ${region}`;
  if (/[\p{Script_Extensions=Greek}\p{Script_Extensions=Cyrillic}]/u.test(char)) return "Noto Sans";
  if (/\p{Script_Extensions=Arabic}/u.test(char)) return "Noto Sans Arabic";
  if (/\p{Script_Extensions=Hebrew}/u.test(char)) return "Noto Sans Hebrew";
  if (/\p{Sm}/u.test(char)) return "Noto Sans Math";
  if (/[\p{So}\u2460-\u24ff]/u.test(char)) return "Noto Sans Symbols 2";
  return null;
}

/** Fixed 256-code-point blocks. Small alphabets use the whole static face to preserve shaping context. */
const HAN_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x30ff],
  [0x3400, 0x4dff],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0xff00, 0xffff],
  [0x20000, 0x2ffff],
  [0x30000, 0x323ff],
];
const KANA_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x3100, 0x31ff],
  [0x1b000, 0x1b1ff],
];
const HANGUL_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x11ff],
  [0xa900, 0xa9ff],
  [0xac00, 0xd7ff],
];
const EMOJI_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x2300, 0x23ff],
  [0x2500, 0x27ff],
  [0x2b00, 0x2bff],
  [0x1f000, 0x1faff],
];

const JAPANESE_BLOCKS = [...HAN_BLOCKS, ...KANA_BLOCKS];
const KOREAN_BLOCKS = [...HAN_BLOCKS, ...HANGUL_BLOCKS];

function fixedBlocks(family: ScriptFallbackFamily) {
  switch (family) {
    case "Noto Sans JP":
      return JAPANESE_BLOCKS;
    case "Noto Sans KR":
      return KOREAN_BLOCKS;
    case "Noto Sans TC":
    case "Noto Sans SC":
      return HAN_BLOCKS;
    case "Noto Emoji":
      return EMOJI_BLOCKS;
    default:
      return null;
  }
}

/** The immutable catalogue entry for a family and slice. Null means the key is outside the catalogue. */
export function scriptSlice(
  family: string,
  subset: string,
): { start: number; end: number } | "all" | null {
  if (!SCRIPT_FALLBACK_FAMILIES.some((allowed) => allowed === family)) return null;
  const blocks = fixedBlocks(family as ScriptFallbackFamily);
  if (!blocks) return subset === "all" ? "all" : null;
  if (!/^[1-9a-f][0-9a-f]{1,3}00$/.test(subset)) return null;
  const start = Number.parseInt(subset, 16);
  const end = start + 255;
  return blocks.some(([a, b]) => a <= start && end <= b) ? { start, end } : null;
}

export function scriptSubsetsFor(text: string, region: CjkRegion): ScriptSubset[] {
  const found = new Map<string, ScriptSubset>();
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0xa0) continue;
    const family = scriptFallbackFamily(char, region);
    if (!family) continue;
    const subset = fixedBlocks(family) ? (cp - (cp % 256)).toString(16) : "all";
    if (scriptSlice(family, subset)) found.set(`${family}\0${subset}`, { family, subset });
  }
  return [...found.values()].sort(
    (a, b) => a.family.localeCompare(b.family) || a.subset.localeCompare(b.subset),
  );
}

export function scriptSubsets(texts: Iterable<string>, locale?: string): ScriptSubset[] {
  const found = new Map<string, ScriptSubset>();
  for (const text of texts)
    for (const face of scriptSubsetsFor(text, cjkRegionFor(text, locale)))
      found.set(`${face.family}\0${face.subset}`, face);
  return [...found.values()];
}
