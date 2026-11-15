// Fetches Figma's renders of the parity cells (at 2×) into goldens/<suite>/<id>.png:
//
//   FIGMA_TOKEN=… node tools/figma-parity/fetch-goldens.mjs <file link> [suite…]
//
// The token needs file content read access. Cells are the frames named
// "<suite>/<id>" on the file's "Parity: <suite>" pages (build-in-figma.mjs).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [, , link, ...only] = process.argv;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: a tool run by hand, outside every build pipeline.
const token = process.env.FIGMA_TOKEN;
if (!link || !token) {
  console.error("Usage: FIGMA_TOKEN=… node fetch-goldens.mjs <file link> [suite…]");
  process.exit(1);
}
const key = /figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/.exec(link)?.[1] ?? link;

async function api(path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.figma.com/v1/${path}`, {
      headers: { "X-Figma-Token": token },
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }
}

const file = await api(`files/${key}?depth=2`);
const cells = file.document.children
  .filter((p) => p.name.startsWith("Parity: "))
  .filter((p) => only.length === 0 || only.includes(p.name.slice(8)))
  .flatMap((p) => p.children.filter((n) => n.name.includes("/")));
console.log(`${cells.length} cells in "${file.name}"`);

for (let i = 0; i < cells.length; i += 50) {
  const batch = cells.slice(i, i + 50);
  const { images } = await api(
    `images/${key}?ids=${batch.map((c) => encodeURIComponent(c.id)).join(",")}&format=png&scale=2`,
  );
  for (const cell of batch) {
    const url = images[cell.id];
    if (!url) throw new Error(`Figma didn't render ${cell.name}.`);
    const [suite, id] = cell.name.split("/");
    const out = join(here, "goldens", suite, `${id}.png`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(await (await fetch(url)).arrayBuffer()));
  }
}
console.log(`Wrote ${cells.length} goldens to ${join(here, "goldens")}`);
