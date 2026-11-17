/**
 * Where underlines and strikethroughs are drawn, against Figma. Figma's
 * underline isn't the font's (Inter's post table puts its top 0.170 em under
 * the baseline): measured on its renders of Inter at 12 to 20 px, its top
 * is a fifth of the size under the drawn baseline and it's a fifteenth of
 * the size thick. Its strikethrough is where Inter's OS/2 table puts one.
 * The renders compared here are the parity suite's goldens: Figma's own
 * exports of `tools/figma-parity/scenes/text.json`, at 2×.
 */
import { readFileSync } from "node:fs";
import { type Op, ROOT_ID } from "@drawpane/model";
import type { ResvgRasteriser } from "@drawpane/raster";
import { nodeRasteriser } from "@drawpane/raster/node";
import { beforeAll, describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { Editor } from "../src/editor";
import { exportBounds } from "../src/export";
import { type FaceFileLoader, HarfBuzzMeasurer } from "../src/harfbuzz-measurer";
import { base64, createHeadlessRenderer } from "../src/headless-render";
import { exportSvg } from "../src/svg";
import { decorationBar } from "../src/text";

const file = (path: string) => {
  const b = readFileSync(new URL(path, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const INTER = file("../../../apps/web/e2e/fixtures/Inter-Variable.ttf");
const loader: FaceFileLoader = async (face) =>
  face.family === "Inter" && !face.italic ? INTER : null;

async function measurer() {
  const m = new HarfBuzzMeasurer(loader);
  await m.load([{ family: "Inter", weight: 400, italic: false, canvas: true }]);
  return m;
}

let rasteriser: ResvgRasteriser;
beforeAll(async () => {
  rasteriser = await nodeRasteriser();
});

describe("decoration bars, against Figma", () => {
  it("puts an underline a fifth of the size under the baseline, a fifteenth thick", () => {
    // Size, and the top and bottom of Figma's underline under the drawn baseline (px),
    // from its 2× renders of single-line Inter (the median over each size's layers).
    const FIGMA: Array<[number, number, number]> = [
      [12, 2.375, 3.19],
      [14, 2.75, 3.75],
      [16, 3.19, 4.25],
      [18, 3.56, 4.81],
      [20, 4.0, 5.31],
    ];
    for (const [size, top, bottom] of FIGMA) {
      const bar = decorationBar("underline", 100, size);
      expect(Math.abs(bar.y - 100 - top), `${size} px top`).toBeLessThan(0.06);
      expect(Math.abs(bar.y + bar.height - 100 - bottom), `${size} px bottom`).toBeLessThan(0.06);
    }
  });

  it("puts a strikethrough where Inter's OS/2 table does", () => {
    const bar = decorationBar("strikethrough", 100, 16);
    // 671 and 140 of 2048 units at 16 px: Figma's bar runs from 5.25 px over the baseline to 4.13.
    expect(bar.y).toBeCloseTo(100 - 5.242, 3);
    expect(bar.height).toBeCloseTo(1.094, 3);
  });

  it("exports the bars the canvas draws, on the drawn baseline", async () => {
    const m = await measurer();
    const editor = new Editor({ measurer: m, clientId: "test" });
    editor.state.set({ role: "editor" });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page" } },
      ...(["underline", "strikethrough"] as const).map(
        (textDecoration, i): Op => ({
          op: "create",
          id: textDecoration,
          type: "text",
          parent: "p",
          key: `a${i}`,
          props: {
            x: 0,
            y: i * 40,
            width: 300,
            height: 24,
            characters: "Underlined",
            fontFamily: "Inter",
            fontSize: 16,
            lineHeight: { unit: "px", value: 24 },
            textAutoResize: "height",
            textDecoration,
          },
        }),
      ),
    ]);
    editor.setPage("p");
    const bar = (id: string) => {
      const bounds = exportBounds(editor.scene, [id]);
      if (!bounds) throw new Error("no bounds");
      const svg = exportSvg(editor.scene, m, [id], bounds, { raster: 2 });
      const rect = /<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"\/>/.exec(svg);
      return rect ? [Number(rect[1]), Number(rect[2])] : null;
    };
    // Inter 16/24 is drawn on 18: the underline from 21.2, the strikethrough from 12.76.
    expect(bar("underline")).toEqual([21.2, 1.07]);
    expect(bar("strikethrough")).toEqual([12.76, 1.09]);
  });
});

describe("decoration bars, drawn", () => {
  /** Each row's coverage across the text's columns (its 30th percentile, 0 to 1). */
  const rows = (data: Uint8Array | Uint8ClampedArray, width: number, from: number, to: number) => {
    const out: number[] = [];
    for (let y = from; y < to; y++) {
      const col: number[] = [];
      for (let x = 44; x < 300; x++) {
        const i = (y * width + x) * 4;
        const a = (data[i + 3] ?? 0) / 255;
        // Over white, in grey; the text is #1c1b1a.
        const grey = ((data[i] ?? 0) * a + 255 * (1 - a)) as number;
        col.push((255 - grey) / (255 - 0x1c));
      }
      col.sort((p, q) => p - q);
      out.push(col[Math.floor(col.length * 0.3)] ?? 0);
    }
    return out;
  };

  for (const [decoration, from, to] of [
    ["underline", 70, 84],
    ["strikethrough", 50, 70],
  ] as const) {
    it(`draws ${decoration === "underline" ? "an" : "a"} ${decoration} on the rows Figma does`, async () => {
      // The parity suite's cell: Inter 16, auto line height, at (20, 20) in a 280 × 140 frame.
      const d = new Doc();
      d.apply([
        { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
        {
          op: "create",
          id: "f",
          type: "frame",
          parent: "p",
          key: "a0",
          props: { width: 280, height: 140, fills: [{ type: "solid", color: "#ffffff" }] },
        },
        {
          op: "create",
          id: "t",
          type: "text",
          parent: "f",
          key: "a0",
          props: {
            x: 20,
            y: 20,
            width: 240,
            height: 100,
            characters: "The quick brown fox",
            fontFamily: "Inter",
            fontSize: 16,
            fills: [{ type: "solid", color: "#1c1b1a" }],
            textAutoResize: "width",
            textDecoration: decoration,
          },
        },
      ]);
      const r = createHeadlessRenderer({
        measurer: await measurer(),
        rasteriser,
        fonts: async (face) => (face.family === "Inter" && !face.italic ? INTER : null),
        images: async () => null,
      });
      const ours = await r.renderPng(d, "f", { scale: 2 });
      const png = (bytes: Uint8Array) =>
        rasteriser.pixels(
          `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="280"><image width="560" height="280" href="data:image/png;base64,${base64(bytes)}"/></svg>`,
          { scale: 1, fonts: [] },
        );
      const golden = new Uint8Array(
        file(`../../../tools/figma-parity/goldens/text/${decoration}.png`),
      );
      const drawn = rows(png(ours.png).data, 560, from, to);
      const figma = rows(png(golden).data, 560, from, to);
      for (const [i, c] of figma.entries())
        expect(Math.abs((drawn[i] ?? 0) - c), `row ${from + i}`).toBeLessThan(0.2);
    });
  }
});
