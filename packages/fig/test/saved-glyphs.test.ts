/**
 * Text whose font isn't here, drawn from the glyph outlines the .fig saved
 * with it (decision 0037), and laid out as usual once it's edited.
 *
 * The file is a committed sample (`pattern.fig`) with a text layer added in
 * a family nobody has, "Glyphless Test Sans", whose saved glyphs are made
 * up here: a square for "A" and a triangle for "B". No real font's outlines
 * are involved.
 */
import { readFileSync } from "node:fs";
import { Doc, exportSvg, glyphTable, Scene, savedText, type TextMeasurer } from "@drawpane/editor";
import { convertFile } from "@drawpane/figma";
import { getProp, glyphKey, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { parseFigBuffer, patchFigArchive } from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { describe, expect, it } from "vitest";
import { readFig } from "../src";

const bytes = new Uint8Array(readFileSync(new URL("./fixtures/pattern.fig", import.meta.url)));
const FAMILY = "Glyphless Test Sans";

/** A path blob as Figma writes one: opcodes, each followed by float32 arguments (ems, y up). */
function blob(commands: Array<[number, ...number[]]>): Uint8Array {
  const size = commands.reduce((n, [, ...args]) => n + 1 + args.length * 4, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [op, ...args] of commands) {
    out[at++] = op;
    for (const a of args) {
      view.setFloat32(at, a, true);
      at += 4;
    }
  }
  return out;
}
// 1 move, 2 line, 0 close. Figma's own glyphs often start with a close, which SVG path data
// can't: the import drops it.
const SQUARE = blob([[0], [1, 0.1, 0], [2, 0.6, 0], [2, 0.6, 0.5], [2, 0.1, 0.5], [0]]);
const TRIANGLE = blob([[1, 0.05, 0], [2, 0.55, 0], [2, 0.3, 0.6], [0]]);

function fixture() {
  const parsed = parseFigBuffer(bytes.slice().buffer as ArrayBuffer);
  const page = parsed.nodeChanges.find((r) => r.type === "CANVAS" && !r.internalOnly)?.guid;
  if (!page) throw new Error("the sample changed");
  const first = parsed.blobs.length;
  const records = [
    {
      guid: { sessionID: 900, localID: 1 },
      phase: "CREATED",
      parentIndex: { guid: page, position: "~z" },
      type: "TEXT",
      name: "Saved glyphs",
      visible: true,
      opacity: 1,
      size: { x: 25, y: 24 },
      transform: { m00: 1, m01: 0, m02: 4000, m10: 0, m11: 1, m12: 4000 },
      fontSize: 20,
      fontName: { family: FAMILY, style: "Regular", postscript: "" },
      textData: { characters: "AB" },
      textAutoResize: "WIDTH_AND_HEIGHT",
      lineHeight: { value: 100, units: "RAW" },
      letterSpacing: { value: 0, units: "PERCENT" },
      fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
      derivedTextData: {
        layoutSize: { x: 25, y: 24 },
        baselines: [
          {
            position: { x: 0, y: 18.4 },
            width: 25,
            lineY: 0,
            lineHeight: 24,
            lineAscent: 18,
            firstCharacter: 0,
            endCharacter: 2,
          },
        ],
        glyphs: [
          {
            commandsBlob: first,
            position: { x: 0, y: 18.4 },
            fontSize: 20,
            firstCharacter: 0,
            advance: 0.6,
          },
          {
            commandsBlob: first + 1,
            position: { x: 12, y: 18.4 },
            fontSize: 20,
            firstCharacter: 1,
            advance: 0.6,
          },
        ],
      },
    },
  ] as unknown as NodeChange[];
  return patchFigArchive(
    bytes.slice().buffer as ArrayBuffer,
    { records, fields: [], blobs: [SQUARE, TRIANGLE], removed: [], replaceVariables: false },
    {
      thumbnailPNG: parsed.thumbnailPNG ?? new Uint8Array(),
      metaJSON: parsed.metaJSON ?? "{}",
      images: [],
    },
  );
}

/** Measures every character half an em wide; only FAMILY is missing. */
const measurer: TextMeasurer = {
  width: (font, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16) * 0.5,
  missing: (family) => family === FAMILY,
};

async function converted(): Promise<NodeRecord[]> {
  const fig = await readFig(fixture());
  return convertFile(fig.file).nodes;
}

function svgOf(doc: Doc, id: string, m: TextMeasurer = measurer): string {
  return exportSvg(new Scene(doc), m, [id], { x: 0, y: 0, width: 10_000, height: 10_000 });
}

describe("saved glyph outlines", { timeout: 60_000 }, () => {
  it("come in with the text, each outline once, in a glyph set at the root", async () => {
    const nodes = await converted();
    const text = nodes.find((n) => n.props.name === "Saved glyphs");
    const layout = text ? getProp(text.props, "glyphLayout") : null;
    expect(layout).not.toBeNull();
    if (!text || !layout) return;
    expect(layout.key).toBe(glyphKey(text.props));
    expect(layout.refs).toHaveLength(2);
    // Each glyph: its ref, then its place on the baseline, as Figma saved it.
    expect(layout.g).toEqual([0, 0, 18.4, 1, 12, 18.4]);
    expect(layout.size).toBe(20);
    const sets = nodes.filter((n) => n.type === "glyphSet");
    expect(sets.every((s) => s.parent === ROOT_ID)).toBe(true);
    const outlines = Object.assign({}, ...sets.map((s) => getProp(s.props, "glyphOutlines")));
    // The square, in thousandths of an em, y up.
    expect(outlines[layout.refs[0] as string]).toBe("M100 0 L600 0 L600 500 L100 500 Z");
    // The sample's own Inter text came with its glyphs too, sharing the table.
    expect(Object.keys(outlines).length).toBeGreaterThan(2);
  });

  it("draw the text while its font is missing, and the font once it's here", async () => {
    const nodes = await converted();
    const doc = new Doc();
    doc.reset(nodes);
    const text = nodes.find((n) => n.props.name === "Saved glyphs") as NodeRecord;
    const node = doc.get(text.id) as NodeRecord;
    expect(savedText(node, measurer, glyphTable(doc))).not.toBeNull();

    const svg = svgOf(doc, text.id);
    // The square at 20 px, from x 0 on the baseline (18.4, drawn at 18): 2 to 12 across, 8 to 18 down.
    expect(svg).toContain("M2 18L12 18L12 8L2 8Z");
    expect(svg).not.toContain("<text");

    // The font is here: it's laid out and drawn in it.
    const withFont: TextMeasurer = { ...measurer, missing: () => false };
    expect(svgOf(doc, text.id, withFont)).toContain("<text");
  });

  it("are dropped once the text is edited, drawn as usual instead", async () => {
    const nodes = await converted();
    const doc = new Doc();
    doc.reset(nodes);
    const text = nodes.find((n) => n.props.name === "Saved glyphs") as NodeRecord;
    doc.apply([{ op: "set", id: text.id, prop: "characters", value: "AB!" }]);
    const node = doc.get(text.id) as NodeRecord;
    // Still saved in the file, but stale: never drawn.
    expect(getProp(node.props, "glyphLayout")).not.toBeNull();
    expect(savedText(node, measurer, glyphTable(doc))).toBeNull();
    const svg = svgOf(doc, text.id);
    expect(svg).toContain("<text");
    expect(svg).toContain("AB!");
    expect(svg).not.toContain("M2 18L12 18L12 8L2 8Z");

    // Undone, it's what Figma laid out again.
    doc.apply([{ op: "set", id: text.id, prop: "characters", value: "AB" }]);
    expect(svgOf(doc, text.id)).toContain("M2 18L12 18L12 8L2 8Z");
  });

  it("keep their colour when only the colour changes", async () => {
    const nodes = await converted();
    const doc = new Doc();
    doc.reset(nodes);
    const text = nodes.find((n) => n.props.name === "Saved glyphs") as NodeRecord;
    doc.apply([
      { op: "set", id: text.id, prop: "fills", value: [{ type: "solid", color: "#ff0000" }] },
    ]);
    const svg = svgOf(doc, text.id);
    expect(svg).toContain("M2 18L12 18L12 8L2 8Z");
    expect(svg).toContain('fill="#ff0000"');
  });
});
