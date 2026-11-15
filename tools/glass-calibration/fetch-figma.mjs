// Fetches Figma's renders of the calibration cells (glass-<id>.png at 2×)
// through its REST API. Needs a token that can read file content:
//
//   FIGMA_TOKEN=… node tools/glass-calibration/fetch-figma.mjs <file key or link> [out dir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , input, out = "/tmp/glass-figma"] = process.argv;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: a tool run by hand, outside every build pipeline.
const token = process.env.FIGMA_TOKEN;
if (!input || !token) {
  console.error("Usage: FIGMA_TOKEN=… node fetch-figma.mjs <file key or link> [out dir]");
  process.exit(1);
}
const key = /figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/.exec(input)?.[1] ?? input;

async function api(path) {
  const res = await fetch(`https://api.figma.com/v1/${path}`, {
    headers: { "X-Figma-Token": token },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const file = await api(`files/${key}?depth=2`);
const page = file.document.children.find((p) => p.name === "Glass calibration");
if (!page) throw new Error('No "Glass calibration" page: run the plugin in that file first.');
const cells = page.children.filter((n) => n.name.startsWith("glass-"));
console.log(`${cells.length} cells in "${file.name}"`);

const { images } = await api(
  `images/${key}?ids=${cells.map((c) => encodeURIComponent(c.id)).join(",")}&format=png&scale=2`,
);
mkdirSync(out, { recursive: true });
for (const cell of cells) {
  const url = images[cell.id];
  if (!url) throw new Error(`Figma didn't render ${cell.name}.`);
  const res = await fetch(url);
  writeFileSync(join(out, `${cell.name}.png`), Buffer.from(await res.arrayBuffer()));
}
console.log(`Wrote ${cells.length} renders to ${out}`);
