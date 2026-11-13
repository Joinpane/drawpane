// Builds src/fonts/google-fonts.json, the Google Fonts catalog the font
// picker searches, from Google's public metadata. Run with
// `pnpm --filter @drawpane/web fonts:catalog` to pick up new families.
//
// The output is compact: one row per family, most popular first:
//   [family, category, upright weights, italic weights, variable]
// where weights are bit masks (bit 0 = 100 … bit 8 = 900).
import { writeFileSync } from "node:fs";

const SOURCE = "https://fonts.google.com/metadata/fonts";
const OUT = new URL("../src/fonts/google-fonts.json", import.meta.url);
const CATEGORIES = ["Sans Serif", "Serif", "Display", "Handwriting", "Monospace"];

interface Family {
  family: string;
  category: string;
  fonts: Record<string, unknown>;
  axes: Array<{ tag: string }>;
  popularity: number;
  isOpenSource?: boolean;
  isBrandFont?: boolean;
}

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`${SOURCE}: ${response.status}`);
const metadata = (await response.json()) as { familyMetadataList: Family[] };

const mask = (keys: string[], italic: boolean) =>
  keys.reduce((m, key) => {
    const match = /^([1-9])00(i?)$/.exec(key);
    if (!match || (match[2] === "i") !== italic) return m;
    return m | (1 << (Number(match[1]) - 1));
  }, 0);

const rows = metadata.familyMetadataList
  // Open-source families only (brand fonts like Google Sans aren't licensed for use).
  .filter((f) => f.isOpenSource !== false && !f.isBrandFont)
  .filter((f) => /^[A-Za-z0-9][A-Za-z0-9 ]{0,63}$/.test(f.family))
  .sort((a, b) => a.popularity - b.popularity)
  .map((f) => {
    const keys = Object.keys(f.fonts);
    return [
      f.family,
      Math.max(0, CATEGORIES.indexOf(f.category)),
      mask(keys, false),
      mask(keys, true),
      f.axes.some((a) => a.tag === "wght") ? 1 : 0,
    ];
  })
  .filter((row) => (row[2] as number) !== 0 || (row[3] as number) !== 0);

writeFileSync(OUT, `${JSON.stringify({ categories: CATEGORIES, families: rows })}\n`);
console.log(`Wrote ${rows.length} families to ${OUT.pathname}`);
