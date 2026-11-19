/**
 * Smoothed corners, drawn: every consumer of a box's outline uses the one
 * geometry (corners.ts), so the headless renderer's pixels (SVG through
 * resvg, as exports and agents' renders draw), hit testing, the SVG export's
 * path and the vector outline (flatten, booleans) agree. The canvas draws
 * the same Path2D and is checked against the headless renderer in
 * `apps/web/e2e/parity/headless.spec.ts`, and against Figma in
 * `apps/web/e2e/parity` (suite "corners").
 */
import { getProp, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import type { ResvgRasteriser } from "@drawpane/raster";
import { nodeRasteriser } from "@drawpane/raster/node";
import { beforeAll, describe, expect, it } from "vitest";
import { boxPath, flattenBox, pathData } from "../src/corners";
import { Doc } from "../src/doc";
import { base64, createHeadlessRenderer } from "../src/headless-render";
import { hitsNode } from "../src/hit";
import { Scene } from "../src/scene";
import { exportSvg } from "../src/svg";
import type { TextMeasurer } from "../src/text";
import { pathBounds } from "../src/vector/bounds";
import { nodePath } from "../src/vector/shapes";

const measurer: TextMeasurer = { width: (_font, text) => text.length * 8 };
const solid = (color: string) => [{ type: "solid" as const, color }];

let rasteriser: ResvgRasteriser;
beforeAll(async () => {
  rasteriser = await nodeRasteriser();
});

function docWith(
  layers: Array<[id: string, type: string, props: Record<string, unknown>, parent?: string]>,
) {
  const d = new Doc();
  d.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "P" } },
    {
      op: "create",
      id: "bg",
      type: "rect",
      parent: "p",
      key: "a0",
      props: { x: 0, y: 0, width: 240, height: 160, fills: solid("#ffffff") },
    },
    ...layers.map(
      ([id, type, props, parent], i) =>
        ({
          op: "create",
          id,
          type,
          parent: parent ?? "p",
          key: `a${String(i + 1).padStart(3, "0")}`,
          props,
        }) as Op,
    ),
  ]);
  return d;
}

async function pixels(d: Doc) {
  const r = createHeadlessRenderer({
    measurer,
    rasteriser,
    fonts: async () => null,
    images: async () => null,
  });
  const out = await r.renderPng(d, "p", { scale: 1, background: "#ffffff" });
  const px = rasteriser.pixels(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${out.width}" height="${out.height}"><image width="${out.width}" height="${out.height}" href="data:image/png;base64,${base64(out.png)}"/></svg>`,
    { scale: 1, fonts: [] },
  );
  return (x: number, y: number) => [
    ...px.data.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 3),
  ];
}

const BOX = { x: 20, y: 20, width: 200, height: 120, cornerRadius: 30, cornerSmoothing: 0.6 };

describe("smoothed corners, drawn", () => {
  it("fill where hit testing says the shape is, and nowhere else", async () => {
    const d = docWith([["sq", "rect", { ...BOX, fills: solid("#0000ff") }]]);
    const at = await pixels(d);
    const scene = new Scene(d);
    const node = d.get("sq") as NodeRecord;
    let checked = 0;
    const wrong: string[] = [];
    // The top-left corner's reach (1.6 × 30) and a little more, pixel centres.
    for (let y = 20; y < 75; y++)
      for (let x = 20; x < 75; x++) {
        const [r = 0, , b = 0] = at(x, y);
        const blue = b > 230 && r < 25;
        const white = r > 230;
        if (!blue && !white) continue; // An edge pixel, partly covered.
        checked++;
        if (hitsNode(scene, node, { x: x + 0.5, y: y + 0.5 }, 0) !== blue) wrong.push(`${x},${y}`);
      }
    expect(checked).toBeGreaterThan(2500);
    expect(wrong).toEqual([]);
  });

  it("cut off what a plain circle keeps, along the edge", async () => {
    const plain = await pixels(
      docWith([["r", "rect", { ...BOX, cornerSmoothing: 0, fills: solid("#0000ff") }]]),
    );
    const smooth = await pixels(docWith([["r", "rect", { ...BOX, fills: solid("#0000ff") }]]));
    // How much white shows along the top two rows, over the corner's reach: a smoothed corner
    // eases in over 48 px where a plain one turns within 30, so more shows.
    const white = (at: (x: number, y: number) => number[]) => {
      let sum = 0;
      for (let y = 20; y < 22; y++) for (let x = 20; x < 70; x++) sum += at(x, y)[0] ?? 0;
      return sum / 255;
    };
    expect(white(smooth)).toBeGreaterThan(white(plain) + 3);
    // Past the reach both are all edge.
    expect(plain(20 + 50, 20)).toEqual([0, 0, 255]);
    expect(smooth(20 + 50, 20)).toEqual([0, 0, 255]);
  });

  it("clip a frame's content to the same curve the frame fills", async () => {
    const d = docWith([
      ["f", "frame", { ...BOX, fills: [], clipContent: true }],
      ["c", "rect", { x: -20, y: -20, width: 260, height: 180, fills: solid("#00ff00") }, "f"],
    ]);
    const at = await pixels(d);
    const scene = new Scene(d);
    const frame = d.get("f") as NodeRecord;
    const wrong: string[] = [];
    for (let y = 20; y < 75; y++)
      for (let x = 20; x < 75; x++) {
        const [r = 0, g = 0] = at(x, y);
        const green = g > 230 && r < 25;
        if (!green && r < 230) continue;
        if (hitsNode(scene, frame, { x: x + 0.5, y: y + 0.5 }, 0) !== green)
          wrong.push(`${x},${y}`);
      }
    expect(wrong).toEqual([]);
  });

  it("export the same path the canvas and booleans use", () => {
    const d = docWith([["sq", "rect", { ...BOX, fills: solid("#0000ff") }]]);
    const scene = new Scene(d);
    const svg = exportSvg(scene, measurer, ["sq"], { x: 20, y: 20, width: 200, height: 120 });
    const expected = pathData(boxPath(200, 120, [30, 30, 30, 30], 0.6), 0, 0);
    expect(svg).toContain(`d="${expected}"`);
    // The vector outline (flatten to path, booleans) passes through the same points.
    const node = d.get("sq") as NodeRecord;
    const outline = nodePath(node);
    expect(pathBounds(outline ?? [])).toEqual({ x: 0, y: 0, width: 200, height: 120 });
    const anchors = outline?.[0]?.anchors ?? [];
    const onCurve = flattenBox(boxPath(200, 120, [30, 30, 30, 30], 0.6), 1);
    for (const p of onCurve)
      expect(anchors.some((a) => Math.hypot(a.x - p.x, a.y - p.y) < 1e-6)).toBe(true);
    expect(getProp(node.props, "cornerSmoothing")).toBe(0.6);
  });

  it("export a plain rounded box as a rect, as Figma does", () => {
    const d = docWith([["r", "rect", { ...BOX, cornerSmoothing: 0, fills: solid("#0000ff") }]]);
    const svg = exportSvg(new Scene(d), measurer, ["r"], { x: 20, y: 20, width: 200, height: 120 });
    expect(svg).toContain('width="200" height="120" rx="30"');
  });
});
