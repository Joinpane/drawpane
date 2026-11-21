/**
 * Font aliases in the editor (decision 0036): text named "SF Pro" is laid
 * out, measured and exported in the cut its size calls for, and a symbol
 * (a private-use character) its font lacks draws as the missing-glyph box.
 *
 * The SF fonts here are stand-ins: OFL fonts renamed (tools/stand-in-fonts).
 * "SF Pro Text" has one symbol, U+100185, 1.25 em wide; "SF Pro Display" has
 * none. Apple's own files are licensed and never in the repo.
 */
import { readFileSync } from "node:fs";
import { fontAliasIndex, type NodeRecord, type Props, resolveFontFamily } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import {
  type FaceFileLoader,
  HarfBuzzMeasurer,
  measuredFaces,
  parseFont,
} from "../src/harfbuzz-measurer";
import { MISSING_GLYPH_FAMILY } from "../src/missing-glyph-font";
import { fontString, layoutText, shapingRun, type TextMeasurer } from "../src/text";
import { facesUsed } from "./fixtures/svg-raster";

const fixture = (name: string) => {
  const b = readFileSync(new URL(`../../../apps/web/e2e/fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const TEXT = fixture("SFProText-StandIn-Regular.ttf");
const TEXT_BOLD = fixture("SFProText-StandIn-Bold.ttf");
const DISPLAY = fixture("SFProDisplay-StandIn-Regular.ttf");
const SANS = fixture("InstrumentSans-Variable.ttf");

/** The team's fonts: SF Pro Text (regular and bold) and SF Pro Display (regular). */
const loader: FaceFileLoader = async (face) => {
  if (face.family === "SF Pro Text") return face.weight >= 600 ? TEXT_BOLD : TEXT;
  if (face.family === "SF Pro Display") return DISPLAY;
  if (face.family === "Instrument Sans") return SANS;
  return null;
};
const here = (f: string) => ["SF Pro Text", "SF Pro Display", "Instrument Sans"].includes(f);

/** A measurer resolving through aliases, as the browser's and the Worker's do. */
function aliased(m: HarfBuzzMeasurer, available = here, team = fontAliasIndex([])): TextMeasurer {
  return {
    width: (font, text, run) => m.width(font, text, run),
    metrics: (font) => m.metrics(font),
    shape: (text, run) => m.shape(text, run),
    get generation() {
      return m.generation;
    },
    family: (family, size) => resolveFontFamily(family, size, available, team),
  };
}

const SYMBOL = String.fromCodePoint(0x100185);

const textNode = (props: Partial<Props>, characters = "Hello"): NodeRecord => ({
  id: "t",
  type: "text",
  parent: "p",
  key: "a0",
  props: { characters, textAutoResize: "width", ...props } as Props,
});

async function ready(available = here) {
  const m = new HarfBuzzMeasurer(loader);
  await m.load(
    [
      { family: "SF Pro Text", weight: 400, italic: false, canvas: true },
      { family: "SF Pro Text", weight: 700, italic: false, canvas: true },
      { family: "SF Pro Display", weight: 400, italic: false, canvas: true },
    ].map((f) => f),
  );
  return { m, measurer: aliased(m, available) };
}

describe("font strings", () => {
  it("name the cut the size calls for, then the missing-glyph box, then the fallback", () => {
    const fonts = { family: (f: string, size: number) => resolveFontFamily(f, size, here) };
    expect(fontString({ fontFamily: "SF Pro", fontSize: 17 }, fonts).split(", ")).toEqual([
      '400 17px "SF Pro Text"',
      '"SF Pro Text Variable"',
      `"${MISSING_GLYPH_FAMILY}"`,
      '"Instrument Sans Variable"',
      "system-ui",
      "sans-serif",
    ]);
    expect(parseFont(fontString({ fontFamily: "SF Pro", fontSize: 34 }, fonts))?.families).toEqual([
      "SF Pro Display",
      MISSING_GLYPH_FAMILY,
      "Instrument Sans",
    ]);
    // No measurer, or none that knows aliases: the family as named.
    expect(parseFont(fontString({ fontFamily: "SF Pro", fontSize: 34 }))?.families[0]).toBe(
      "SF Pro",
    );
  });

  it("carry weight and italic through untouched", () => {
    const fonts = { family: (f: string, size: number) => resolveFontFamily(f, size, here) };
    expect(
      fontString(
        { fontFamily: "SF Pro", fontSize: 13, fontWeight: 600, fontStyle: "italic" },
        fonts,
      ),
    ).toMatch(/^italic 600 13px "SF Pro Text"/);
  });

  it("shape runs with features in the cut too", () => {
    const fonts = { family: (f: string, size: number) => resolveFontFamily(f, size, here) };
    const run = shapingRun(
      { fontFamily: "SF Pro", fontSize: 28, fontFeatures: { tnum: true } },
      fonts,
    );
    expect(run?.family).toBe("SF Pro Display");
    expect(run?.key.startsWith("SF Pro Display|")).toBe(true);
  });
});

describe("layout", () => {
  it("draws each run in the cut for its own size", async () => {
    const { measurer } = await ready();
    const node = textNode(
      {
        fontFamily: "SF Pro",
        fontSize: 15,
        textRuns: [{ start: 0, end: 5, fontSize: 34 }],
      } as Partial<Props>,
      "Title body",
    );
    const layout = layoutText(node, measurer, null);
    const fonts = layout.lines.flatMap((l) =>
      l.fragments.map((f) => parseFont(f.font)?.families[0]),
    );
    expect(fonts).toEqual(["SF Pro Display", "SF Pro Text"]);
    expect(parseFont(layout.font)?.families[0]).toBe("SF Pro Text");
  });

  it("measures in the stand-in's own advances, weights included", async () => {
    const { m, measurer } = await ready();
    const at = (props: Partial<Props>) => layoutText(textNode(props), measurer, null).width;
    const text = at({ fontFamily: "SF Pro", fontSize: 17 });
    expect(text).toBeCloseTo(
      m.width(fontString({ fontFamily: "SF Pro Text", fontSize: 17 }), "Hello"),
    );
    const bold = at({ fontFamily: "SF Pro", fontSize: 17, fontWeight: 700 });
    expect(bold).toBeGreaterThan(text);
    const display = at({ fontFamily: "SF Pro", fontSize: 34 });
    expect(display).toBeCloseTo(
      m.width(fontString({ fontFamily: "SF Pro Display", fontSize: 34 }), "Hello"),
    );
    expect(m.approximations).toEqual([]);
  });

  it("lists the faces to load in the families they're drawn in", () => {
    const fonts = { family: (f: string, size: number) => resolveFontFamily(f, size, here) };
    const node = textNode({
      fontFamily: "SF Pro",
      fontSize: 13,
      textRuns: [{ start: 0, end: 2, fontSize: 28 }],
    } as Partial<Props>);
    expect(measuredFaces([node], fonts).map((f) => f.family)).toEqual([
      "SF Pro Display",
      "SF Pro Text",
    ]);
  });
});

describe("symbols", () => {
  it("draw from the font that has them", async () => {
    const { m, measurer } = await ready();
    const width = layoutText(
      textNode({ fontFamily: "SF Pro", fontSize: 16 }, SYMBOL),
      measurer,
      null,
    ).width;
    // The stand-in's symbol is 1.25 em.
    expect(width).toBeCloseTo(16 * 1.25, 3);
    expect(m.approximations).toEqual([]);
  });

  it("show as the missing-glyph box where the font lacks them, never a guess", async () => {
    const { m, measurer } = await ready();
    const box = layoutText(
      textNode({ fontFamily: "SF Pro", fontSize: 32 }, SYMBOL),
      measurer,
      null,
    ).width;
    // SF Pro Display has no symbols: the box, 0.7 em.
    expect(box).toBeCloseTo(32 * 0.7, 3);
    expect(m.approximations.filter((a) => a.reason === "glyphs")).toEqual([]);
  });

  it("show as the box in a family that's missing altogether", async () => {
    const { measurer } = await ready(() => false);
    const node = textNode({ fontFamily: "SF Pro", fontSize: 20 }, `A${SYMBOL}`);
    const layout = layoutText(node, measurer, null);
    expect(parseFont(layout.font)?.families[0]).toBe("SF Pro");
    expect(layout.width).toBeGreaterThan(20 * 0.7);
  });

  it("leave the font's metrics alone: the box isn't the first available font", async () => {
    const { m } = await ready();
    const missing = m.metrics(fontString({ fontFamily: "Nowhere Sans", fontSize: 100 }));
    const fallback = m.metrics(fontString({ fontFamily: "Instrument Sans", fontSize: 100 }));
    expect(missing).toEqual(fallback);
  });
});

describe("export and render", () => {
  it("names the cut, then the family as the file has it, in SVG", async () => {
    const { measurer } = await ready();
    const { exportSvg } = await import("../src/svg");
    const { Scene } = await import("../src/scene");
    const doc = new Doc();
    doc.apply([
      { op: "create", id: "p", type: "page", parent: "root", key: "a0", props: {} },
      {
        op: "create",
        id: "t",
        type: "text",
        parent: "p",
        key: "a0",
        props: { characters: "Hi", fontFamily: "SF Pro", fontSize: 34, width: 40, height: 40 },
      },
    ]);
    const svg = exportSvg(new Scene(doc), measurer, ["t"], { x: 0, y: 0, width: 40, height: 40 });
    expect(svg).toContain("font-family=\"'SF Pro Display', 'SF Pro', sans-serif\"");
  });

  it("loads the cut's files for a headless render", () => {
    const fonts = { family: (f: string, size: number) => resolveFontFamily(f, size, here) };
    const doc = new Doc();
    doc.apply([
      { op: "create", id: "p", type: "page", parent: "root", key: "a0", props: {} },
      {
        op: "create",
        id: "t",
        type: "text",
        parent: "p",
        key: "a0",
        props: { characters: "Hi", fontFamily: "SF Pro", fontSize: 12, fontWeight: 700 },
      },
    ]);
    expect(facesUsed(doc, ["t"], fonts)).toEqual([
      { family: "SF Pro Text", weight: 700, italic: false },
    ]);
  });
});
