/** Open outline families used after Instrument Sans. Order matches the browser font stack. */
export const SCRIPT_FALLBACK_FAMILIES = [
  "Noto Sans",
  "Noto Sans SC",
  "Noto Sans JP",
  "Noto Sans KR",
  "Noto Sans Arabic",
  "Noto Sans Hebrew",
  "Noto Sans Symbols 2",
  "Noto Sans Math",
  "Noto Emoji",
] as const;

export type ScriptFallbackFamily = (typeof SCRIPT_FALLBACK_FAMILIES)[number];
export const SCRIPT_SUBSET_LIMIT = 128;

export interface ScriptSubset {
  readonly family: ScriptFallbackFamily;
  /** Unique characters in code point order. No text order is transmitted. */
  readonly subset: string;
}

export function scriptFallbackFamily(char: string): ScriptFallbackFamily | null {
  if (/\p{Emoji_Presentation}/u.test(char)) return "Noto Emoji";
  if (/[\p{Script_Extensions=Greek}\p{Script_Extensions=Cyrillic}]/u.test(char)) return "Noto Sans";
  if (/\p{Script=Han}/u.test(char)) return "Noto Sans SC";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) return "Noto Sans JP";
  if (/\p{Script=Hangul}/u.test(char)) return "Noto Sans KR";
  if (/[\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u.test(char)) return "Noto Sans SC";
  if (/\p{Script_Extensions=Arabic}/u.test(char) && !/^[0-9]$/.test(char))
    return "Noto Sans Arabic";
  if (/\p{Script_Extensions=Hebrew}/u.test(char)) return "Noto Sans Hebrew";
  if (/\p{Sm}/u.test(char) && (char.codePointAt(0) ?? 0) >= 0x80) return "Noto Sans Math";
  if (/\p{So}/u.test(char)) return "Noto Sans Symbols 2";
  return null;
}

/** Batches bounded, canonical character sets per script for the font proxy. */
export function scriptSubsets(
  texts: Iterable<string>,
  include: (family: ScriptFallbackFamily, char: string) => boolean = () => true,
): ScriptSubset[] {
  const found = new Map<ScriptFallbackFamily, Set<string>>();
  for (const text of texts) {
    for (const char of text) {
      if (char.length === 1 && char.charCodeAt(0) < 0xa0) continue;
      const family = scriptFallbackFamily(char);
      if (!family || !include(family, char)) continue;
      const chars = found.get(family) ?? new Set<string>();
      chars.add(char);
      found.set(family, chars);
    }
  }
  const result: ScriptSubset[] = [];
  for (const family of SCRIPT_FALLBACK_FAMILIES) {
    const ordered = [...(found.get(family) ?? [])].sort(
      (a, b) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0),
    );
    for (let i = 0; i < ordered.length; i += SCRIPT_SUBSET_LIMIT)
      result.push({ family, subset: ordered.slice(i, i + SCRIPT_SUBSET_LIMIT).join("") });
  }
  return result;
}
