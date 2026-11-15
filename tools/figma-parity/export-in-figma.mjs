// Saves Figma's renders of the parity cells (2× PNGs) as goldens, from
// Figma in a browser (figma-session.mjs), with Figma's own exporter:
//
//   FIGMA_EMAIL=… FIGMA_PASSWORD=… node tools/figma-parity/export-in-figma.mjs <file link> [suite…]
//
// The same renders fetch-goldens.mjs gets through the REST API, without
// spending its reads: files on Figma's free plan get only a few a month.
// Cells are the frames named "<suite>/<id>" on "Parity: <suite>" pages.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFigma } from "./figma-session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [, , link, ...only] = process.argv;
if (!link) {
  console.error("Usage: node export-in-figma.mjs <figma file link> [suite…]");
  process.exit(1);
}

const count = await withFigma(link, async (page) => {
  const pages = await page.evaluate(
    (only) =>
      window.figma.root.children
        .filter((p) => p.name.startsWith("Parity: "))
        .map((p) => p.name.slice("Parity: ".length))
        .filter((suite) => only.length === 0 || only.includes(suite)),
    only,
  );
  let n = 0;
  for (const suite of pages) {
    // One page at a time: Figma loads a page's content before its nodes export.
    const cells = await page.evaluate(async (suite) => {
      const figma = window.figma;
      const target = figma.root.children.find((p) => p.name === `Parity: ${suite}`);
      await figma.setCurrentPageAsync(target);
      const out = [];
      for (const frame of target.children.filter((c) => c.name.startsWith(`${suite}/`))) {
        const bytes = await frame.exportAsync({
          format: "PNG",
          constraint: { type: "SCALE", value: 2 },
        });
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000)
          s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        out.push({ id: frame.name.slice(suite.length + 1), png: btoa(s) });
      }
      return out;
    }, suite);
    for (const cell of cells) {
      const file = join(here, "goldens", suite, `${cell.id}.png`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(cell.png, "base64"));
      n++;
    }
  }
  return n;
});
console.log(`Wrote ${count} goldens to ${join(here, "goldens")}`);
