// Where glass bends each ray, Figma's against Drawpane's, from a parity
// report of the glass-probe suite (tools/figma-parity/scenes/glass-probe.json):
//
//   PARITY_OUT=/tmp/probe npx playwright test e2e/parity -g "glass-probe:"   (in apps/web)
//   node tools/glass-calibration/displacement.mjs /tmp/probe/index.html
//
// Each probe cell is glass with its light, frost and dispersion off, over a
// ramp from black to white across the glass's box (along x in "-x" cells,
// along y in "-y" ones), so a pixel's grey says where its ray landed. For
// each shape it prints the bend along the centre lines (2× pixels, by
// distance in from the edge) and the mean difference between the two
// fields, overall and in the corners. One grey level is 1.7 px at 2×, so
// differences of about a pixel are the measurement's floor.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../apps/web/package.json"));
const { chromium } = require("@playwright/test");

const [, , report] = process.argv;
if (!report) {
  console.error("Usage: node displacement.mjs <parity report index.html>");
  process.exit(1);
}

const SCALE = 2;
const scenes = JSON.parse(
  readFileSync(join(here, "../figma-parity/scenes/glass-probe.json"), "utf8"),
);
// The glass's box in each cell, at 2×: the ramp spans it.
const boxes = new Map();
for (const cell of scenes.cells) {
  const ramp = cell.layers[0];
  boxes.set(
    cell.id,
    [ramp.x, ramp.y, ramp.width, ramp.height].map((v) => v * SCALE),
  );
}

// The report's rows: each cell's Figma render, then Drawpane's.
const html = readFileSync(report, "utf8");
const rows = new Map();
for (const row of html.split("<tr>")) {
  const id = /<th>([a-z0-9-]+)<br>/.exec(row)?.[1];
  const images = [...row.matchAll(/src="(data:image\/png;base64,[^"]+)"/g)].map((m) => m[1]);
  if (id && images.length >= 2) rows.set(id, images.slice(0, 2));
}

const browser = await chromium.launch();
const page = await browser.newPage();
/** A PNG's grey levels (its red channel: the ramps are grey). */
const grey = (url) =>
  page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    const out = new Array(img.width * img.height);
    for (let i = 0; i < out.length; i++) out[i] = data[i * 4];
    return { width: img.width, levels: out };
  }, url);

const DISTANCES = [2, 4, 8, 12, 16, 24, 32, 48, 64, 80, 100, 120];
const pad = (v, n = 5) => String(v).padStart(n);
console.log(
  `bend along the centre lines, by distance in (2× px): ${DISTANCES.map((d) => pad(d)).join("")}`,
);
const totals = [];
for (const [id, [x0, y0, w, h]] of boxes) {
  const axis = id.endsWith("-x") ? "x" : "y";
  const urls = rows.get(id);
  if (!urls) continue;
  const [figma, ours] = [await grey(urls[0]), await grey(urls[1])];
  const span = axis === "x" ? w : h;
  /** Where the ray at (x, y) landed, minus where it started, along the ramp's axis. */
  const bend = (img, x, y) => {
    const landed = (axis === "x" ? x0 : y0) + (img.levels[y * img.width + x] / 255) * span;
    return landed - ((axis === "x" ? x : y) + 0.5);
  };
  const along = (img) =>
    DISTANCES.filter((d) => d < span / 2).map((d) =>
      pad(Math.round(axis === "x" ? bend(img, x0 + d, y0 + h / 2) : bend(img, x0 + w / 2, y0 + d))),
    );
  console.log(`${id.padEnd(18)} Figma    ${along(figma).join("")}`);
  console.log(`${"".padEnd(18)} Drawpane ${along(ours).join("")}`);
  let all = 0;
  let n = 0;
  let corners = 0;
  let c = 0;
  for (let y = y0 + 3; y < y0 + h - 3; y += 2)
    for (let x = x0 + 3; x < x0 + w - 3; x += 2) {
      const e = Math.abs(bend(figma, x, y) - bend(ours, x, y));
      all += e;
      n++;
      if ((x - x0 < 70 || x0 + w - x < 70) && (y - y0 < 70 || y0 + h - y < 70)) {
        corners += e;
        c++;
      }
    }
  totals.push(all / n);
  console.log(
    `${"".padEnd(18)} field difference ${(all / n).toFixed(2)} px, corners ${(corners / Math.max(1, c)).toFixed(2)} px`,
  );
}
console.log(
  `Mean field difference: ${(totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(2)} px (2×)`,
);
await browser.close();
