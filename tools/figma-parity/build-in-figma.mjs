// Builds the parity scenes in a Figma file, through Figma in a browser
// (figma-session.mjs):
//
//   FIGMA_EMAIL=… FIGMA_PASSWORD=… node tools/figma-parity/build-in-figma.mjs <file link> [suite…]
//
// Each suite gets a page "Parity: <suite>" (replacing an older one) of frames
// named "<suite>/<id>", built by figma-builder.js in the page. Without
// suites named, it builds every suite in scenes/.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFigma } from "./figma-session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [, , link, ...only] = process.argv;
if (!link) {
  console.error("Usage: node build-in-figma.mjs <figma file link> [suite…]");
  process.exit(1);
}

const suites = readdirSync(join(here, "scenes"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(here, "scenes", f), "utf8")))
  .filter((s) => only.length === 0 || only.includes(s.suite));
const builder = readFileSync(join(here, "figma-builder.js"), "utf8");

const made = await withFigma(link, async (page) => {
  // The builder's function, called in the page as an expression.
  const call = `(${builder.slice(builder.indexOf("async function buildParity"))})(window.figma, ${JSON.stringify(suites)})`;
  const cells = await page.evaluate(call);
  // Give Figma a moment to save before closing.
  await page.waitForTimeout(8000);
  return cells;
});
console.log(
  `Made ${made.length} cells in ${suites.length} suites: ${suites.map((s) => s.suite).join(", ")}`,
);
