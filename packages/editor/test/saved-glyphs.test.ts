/**
 * Saved glyph outlines (decision 0037): when they're drawn, where, and in
 * what colours. The outlines are made up here (squares), not any font's.
 */
import {
  GlyphTableBuilder,
  getProp,
  keysBetween,
  type NodeRecord,
  type Op,
  type Props,
  ROOT_ID,
  type SavedGlyph,
} from "@drawpane/model";
import { nodeRasteriser, type ResvgRasteriser } from "@drawpane/raster/node";
import { beforeAll, describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { glyphTable, savedGlyphGroups, savedText } from "../src/saved-glyphs";
import { Scene } from "../src/scene";
import { exportSvg } from "../src/svg";
import type { TextMeasurer } from "../src/text";
import { rasterSvg } from "./fixtures/svg-raster";

const FAMILY = "Glyphless Test Sans";
const SQUARE = "M0 0 L500 0 L500 500 L0 500 Z";

const measurer: TextMeasurer = {
  width: (font, text) => text.length * Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 16) * 0.5,
  missing: (family) => family === FAMILY,
};

/** A text layer's props as an import makes them, with a square per character 12 px apart. */
function imported(
  over: Props = {},
  glyph: (i: number) => Partial<SavedGlyph> = () => ({}),
): { text: NodeRecord; sets: NodeRecord[] } {
  const props: Props = {
    characters: "ABC",
    fontFamily: FAMILY,
    fontSize: 20,
    x: 0,
    y: 0,
    width: 36,
    height: 24,
    textAutoResize: "width",
    fills: [{ type: "solid", color: "#000000" }],
    ...over,
  };
  const table = new GlyphTableBuilder();
  const glyphs = [...getProp(props, "characters")].map((_, i) => ({
    d: SQUARE,
    x: i * 12,
    y: 18,
    size: 20,
    char: i,
    advance: 12,
    ...glyph(i),
  }));
  const layout = table.layout(props, glyphs);
  const text = {
    id: "t",
    type: "text",
    parent: "p",
    key: "a0",
    props: { ...props, glyphLayout: layout },
  } as NodeRecord;
  return { text, sets: table.sets((n) => keysBetween("a0", null, n)) };
}

function docOf(text: NodeRecord, sets: readonly NodeRecord[]): Doc {
  const doc = new Doc();
  doc.reset([
    { id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page" } },
    ...sets,
    text,
  ]);
  return doc;
}

const saved = (doc: Doc, m: TextMeasurer = measurer) =>
  savedText(doc.get("t") as NodeRecord, m, glyphTable(doc));
const set = (doc: Doc, prop: string, value: unknown) =>
  doc.apply([{ op: "set", id: "t", prop, value } as Op]);

describe("saved glyphs", () => {
  it("are drawn only while the font is missing", () => {
    const { text, sets } = imported();
    const doc = docOf(text, sets);
    expect(saved(doc)).not.toBeNull();
    expect(saved(doc, { ...measurer, missing: () => false })).toBeNull();
    // A measurer that can't tell what's missing never draws them.
    expect(saved(doc, { width: measurer.width })).toBeNull();
  });

  it("are stale once the text or its type changes, not its colour or place", () => {
    const { text, sets } = imported();
    for (const [prop, value, stale] of [
      ["characters", "ABD", true],
      ["fontSize", 21, true],
      ["fontWeight", 700, true],
      ["letterSpacing", { unit: "px", value: 1 }, true],
      ["textRuns", [{ start: 0, end: 1, fontWeight: 700 }], true],
      ["textAlign", "center", true],
      ["fills", [{ type: "solid", color: "#ff0000" }], false],
      ["textRuns", [{ start: 0, end: 1, fills: [{ type: "solid", color: "#ff0000" }] }], false],
      ["x", 40, false],
      ["opacity", 0.5, false],
    ] as const) {
      const doc = docOf(text, sets);
      set(doc, prop, value);
      expect([prop, saved(doc) === null]).toEqual([prop, stale]);
    }
  });

  it("follow an auto-width text's alignment when its box changes, and drop wrapping text's", () => {
    const centred = imported({ textAlign: "center", textAlignVertical: "middle" });
    let doc = docOf(centred.text, centred.sets);
    set(doc, "width", 46);
    set(doc, "height", 30);
    expect(saved(doc)).toMatchObject({ dx: 5, dy: 3 });

    const wrapping = imported({ textAutoResize: "height" });
    doc = docOf(wrapping.text, wrapping.sets);
    set(doc, "width", 30);
    expect(saved(doc)).toBeNull();
    // Its height changing alone moves nothing at the top.
    doc = docOf(wrapping.text, wrapping.sets);
    set(doc, "height", 40);
    expect(saved(doc)).toMatchObject({ dx: 0, dy: 0 });
  });

  it("aren't drawn when the file has lost one of them", () => {
    const { text } = imported();
    expect(saved(docOf(text, []))).toBeNull();
  });

  it("are coloured by run, underlined from their advances, on whole-pixel baselines", () => {
    const { text, sets } = imported(
      {
        textDecoration: "underline",
        textRuns: [{ start: 1, end: 2, fills: [{ type: "solid", color: "#ff0000" }] }],
      },
      () => ({ y: 18.4 }),
    );
    const doc = docOf(text, sets);
    const s = saved(doc);
    if (!s) throw new Error("not drawn from its glyphs");
    const groups = savedGlyphGroups(s, doc.get("t") as NodeRecord);
    expect(groups.map((g) => g.fills?.[0] ?? null)).toEqual([
      null,
      { type: "solid", color: "#ff0000" },
    ]);
    // "A" and "C" in the layer's fill; the baseline at 18, a square 10 px up from it.
    expect(groups[0]?.d).toBe("M0 18L10 18L10 8L0 8ZM24 18L34 18L34 8L24 8Z");
    expect(groups[1]?.d).toBe("M12 18L22 18L22 8L12 8Z");
    // Underlines under each, from its origin to its advance.
    expect(groups[0]?.bars.map((b) => [b.x, b.w])).toEqual([
      [0, 12],
      [24, 12],
    ]);
    expect(groups[0]?.bars[0]?.y).toBeCloseTo(18 + 20 / 5);
  });

  it("start each path with a move, whatever the saved outline starts with", () => {
    const { text, sets } = imported();
    // An outline as imports before this fix saved some: a close before its first move.
    const old = sets.map((set) => ({
      ...set,
      props: {
        ...set.props,
        glyphOutlines: Object.fromEntries(
          Object.entries(getProp(set.props, "glyphOutlines")).map(([id, d]) => [id, `Z ${d}`]),
        ),
      },
    }));
    const doc = docOf(text, old);
    const s = saved(doc);
    if (!s) throw new Error("not drawn from its glyphs");
    const d = savedGlyphGroups(s, doc.get("t") as NodeRecord)[0]?.d ?? "";
    expect(d.startsWith("M0 18L10 18")).toBe(true);
    expect(d).not.toMatch(/Z(?!M|$)/);
  });

  it("go into SVG as paths, strokes around them", () => {
    const { text, sets } = imported({
      strokes: [{ type: "solid", color: "#0000ff" }],
      strokeWeight: 2,
      strokeAlign: "center",
    });
    const svg = exportSvg(new Scene(docOf(text, sets)), measurer, ["t"], {
      x: 0,
      y: 0,
      width: 40,
      height: 30,
    });
    expect(svg).not.toContain("<text");
    expect(svg).toContain('d="M0 18L10 18L10 8L0 8ZM12 18');
    expect(svg).toContain('stroke="#0000ff"');
  });
});

describe("saved glyphs, rasterised", () => {
  let rasteriser: ResvgRasteriser;
  beforeAll(async () => {
    rasteriser = await nodeRasteriser();
  });

  it("ink where the outlines are, without the font", async () => {
    const { text, sets } = imported();
    const doc = docOf(text, sets);
    const px = rasterSvg(doc, "t", measurer, rasteriser, { background: "#ffffff" });
    const at = (x: number, y: number) => {
      const i = (y * px.width + x) * 4;
      return [...px.data.subarray(i, i + 3)];
    };
    // Inside the first square (0 to 10 across, 8 to 18 down), and the gap after it.
    expect(at(5, 13)).toEqual([0, 0, 0]);
    expect(at(11, 13)).toEqual([255, 255, 255]);
    expect(at(17, 13)).toEqual([0, 0, 0]);
  });
});
