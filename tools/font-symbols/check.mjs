#!/usr/bin/env node
/**
 * Which font files have SF Symbols (decision 0034). Symbols are characters
 * in Unicode's private-use areas, drawn by the fonts that have them. This
 * counts each file's private-use characters, so you can tell which of your
 * fonts (SF Pro, SF Pro Text, SF Pro Display…) carries the symbols before you
 * upload it as a team font. Read-only: it never copies or uploads a file.
 *
 *     node tools/font-symbols/check.mjs ~/Downloads/SF-Pro-Text-Regular.otf …
 *
 * Text a file sets in a font without its symbols shows the missing-glyph box
 * for each, in the editor, the Worker's measurer and headless renders.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../../packages/editor/package.json", import.meta.url));
const hb = await import(pathToFileURL(require.resolve("harfbuzzjs")).href);

const AREAS = [
  ["U+E000–F8FF", 0xe000, 0xf8ff],
  ["U+F0000–FFFFD", 0xf0000, 0xffffd],
  ["U+100000–10FFFD", 0x100000, 0x10fffd],
];

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node tools/font-symbols/check.mjs <font files…>");
  process.exit(2);
}
for (const file of files) {
  const bytes = readFileSync(file);
  const face = new hb.Face(
    new hb.Blob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  );
  const unicodes = face.collectUnicodes();
  const counts = AREAS.map(([, a, b]) => unicodes.filter((u) => u >= a && u <= b).length);
  const total = counts.reduce((n, c) => n + c, 0);
  console.log(
    `${basename(file)}: ${total === 0 ? "no symbols" : `${total} private-use character${total === 1 ? "" : "s"}`}` +
      (total > 0
        ? ` (${AREAS.map(([name], i) => `${name}: ${counts[i]}`)
            .filter((_, i) => counts[i] > 0)
            .join(", ")})`
        : ""),
  );
}
