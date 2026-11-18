/**
 * "Drawpane Missing Glyph": one box glyph for every private-use code point
 * (decision 0036). Text lists it right after its own family, so a symbol
 * (SF Symbols are private-use characters in Apple's SF fonts) that the font
 * at hand lacks draws as a box, never as whatever a fallback font has there.
 * The canvas, the HarfBuzz measurer and the headless renderer all use these
 * bytes. Written by tools/stand-in-fonts/make.py; don't edit by hand.
 */

export const MISSING_GLYPH_FAMILY = "Drawpane Missing Glyph";

/** The code points it covers, as [first, last]: the three private-use areas. */
export const PRIVATE_USE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xe000, 0xf8ff],
  [0xf0000, 0xffffd],
  [0x100000, 0x10fffd],
];

const BASE64 = [
  "AAEAAAAKAIAAAwAgT1MvMiV2VIkAAAEoAAAAYGNtYXAAXrndAAABkAAAAHBnbHlmTq8cXAAAAggAAABQaGVhZDAYM+gAAACs",
  "AAAANmhoZWEGQgIeAAAA5AAAACRobXR4AxYAWgAAAYgAAAAGbG9jYQAoABQAAAIAAAAABm1heHAABQAKAAABCAAAACBuYW1l",
  "NJyKEgAAAlgAAAIEcG9zdHB+A2IAAARcAAAAKgABAAAAAQAA/yC6W18PPPUAAwPoAAAAAOci+BwAAAAA5yL4HABaAAACYgLQ",
  "AAAAAwACAAAAAAAAAAEAAAOE/wYAAAK8AFoAWgJiAAEAAAAAAAAAAAAAAAAAAAABAAEAAAACAAgAAgAAAAAAAgAAAAAAAAAA",
  "AAAAAAAAAAAAAwK8AZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAPz8/PwAA",
  "4AD//wOE/wYAAAOEAPoAAAAAAAAAAAAAAAAAAAAgAAACvABaAFoAAAAAAAMAAAADAAAAHAADAAEAAAAcAAMACgAAADwABAAg",
  "AAAABAAEAAEAAOAA//8AAOAA//8gAQABAAAAAAANAAAAAAA0AAAAAAAAAAMAAOAAAAD4/wAAAAEADwAAAA///QAAAAEAEAAA",
  "ABD//QAAAAEAAAAUACgAAAACAFoAAAJiAtAAAwAHAAAzESERJSERIVoCCP4+AXz+hALQ/TBGAkQAAgBaAAACYgLQAAMABwAA",
  "MxEhESUhESFaAgj+PgF8/oQC0P0wRgJEAAAADgCuAAEAAAAAAAEAFgAAAAEAAAAAAAIABwAWAAEAAAAAAAMAHAAdAAEAAAAA",
  "AAQAFgAAAAEAAAAAAAUADQA5AAEAAAAAAAYAHAAdAAEAAAAAAA0ALABGAAMAAQQJAAEALAByAAMAAQQJAAIADgCeAAMAAQQJ",
  "AAMAOACsAAMAAQQJAAQALAByAAMAAQQJAAUAGgDkAAMAAQQJAAYAOACsAAMAAQQJAA0AWAD+RHJhd3BhbmUgTWlzc2luZyBH",
  "bHlwaFJlZ3VsYXJEcmF3cGFuZU1pc3NpbmdHbHlwaC1SZWd1bGFyVmVyc2lvbiAxLjAwMERyYXdwYW5lJ3Mgb3duLCB1bmRl",
  "ciB0aGUgcHJvamVjdCdzIGxpY2Vuc2UuAEQAcgBhAHcAcABhAG4AZQAgAE0AaQBzAHMAaQBuAGcAIABHAGwAeQBwAGgAUgBl",
  "AGcAdQBsAGEAcgBEAHIAYQB3AHAAYQBuAGUATQBpAHMAcwBpAG4AZwBHAGwAeQBwAGgALQBSAGUAZwB1AGwAYQByAFYAZQBy",
  "AHMAaQBvAG4AIAAxAC4AMAAwADAARAByAGEAdwBwAGEAbgBlACcAcwAgAG8AdwBuACwAIAB1AG4AZABlAHIAIAB0AGgAZQAg",
  "AHAAcgBvAGoAZQBjAHQAJwBzACAAbABpAGMAZQBuAHMAZQAuAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAA",
  "AQIDYm94AAA=",
].join("");

/** Whether a code point is private use: what the box font covers. */
export const isPrivateUse = (cp: number): boolean =>
  PRIVATE_USE_RANGES.some(([a, b]) => cp >= a && cp <= b);

/** The CSS unicode-range of what it covers, for @font-face and `FontFace`. */
export const PRIVATE_USE_UNICODE_RANGE = PRIVATE_USE_RANGES.map(
  ([a, b]) => `U+${a.toString(16).toUpperCase()}-${b.toString(16).toUpperCase()}`,
).join(", ");

/**
 * The font file (TrueType), decoded on first use. The same buffer each time
 * (HarfBuzz faces are shared by buffer): don't write to it.
 */
let bytes: ArrayBuffer | null = null;
export function missingGlyphFont(): ArrayBuffer {
  if (!bytes) {
    const text = atob(BASE64);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    bytes = out.buffer;
  }
  return bytes;
}
