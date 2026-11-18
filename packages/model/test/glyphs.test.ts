/** Saved glyph outlines (decision 0037): the table's bounds, the layout's checks, the fingerprint. */
import { describe, expect, it } from "vitest";
import {
  applyOp,
  FILE_GLYPHS,
  GLYPH_SET_GLYPHS,
  GlyphLayout,
  GlyphTableBuilder,
  glyphKey,
  LAYER_GLYPHS,
  MemoryStore,
  PROPS,
  type Props,
  ROOT_ID,
  type SavedGlyph,
} from "../src";

const props: Props = { characters: "Hi", fontFamily: "Nowhere Sans", fontSize: 16, width: 20 };
const glyph = (i: number, d = `M0 0 L${i} 0 Z`): SavedGlyph => ({
  d,
  x: i * 8,
  y: 12,
  size: 16,
  char: i,
});

describe("glyph table", () => {
  it("keeps each outline once, placing glyphs by index", () => {
    const table = new GlyphTableBuilder();
    const a = table.layout(props, [glyph(0, "M0 0 Z"), glyph(1, "M0 0 Z")]);
    const b = table.layout(props, [glyph(0, "M0 0 Z")]);
    expect(table.size).toBe(1);
    expect(a?.refs).toEqual(b?.refs);
    expect(a?.g).toEqual([0, 0, 12, 0, 8, 12]);
    // Characters in order and one size: neither is stored per glyph.
    expect(a?.c).toBeUndefined();
    expect(a?.s).toBeUndefined();
    expect(GlyphLayout.safeParse(a).success).toBe(true);
  });

  it("splits into sets within their bounds, and stops at the file's", () => {
    const table = new GlyphTableBuilder();
    const many = Array.from({ length: GLYPH_SET_GLYPHS + 10 }, (_, i) => glyph(i));
    for (let at = 0; at < many.length; at += 100)
      expect(table.layout(props, many.slice(at, at + 100))).not.toBeNull();
    const sets = table.sets((n) => Array.from({ length: n }, (_, i) => `b${i}`));
    expect(sets).toHaveLength(2);
    for (const s of sets) {
      expect(s.parent).toBe(ROOT_ID);
      expect(PROPS.glyphOutlines.schema.safeParse(s.props.glyphOutlines).success).toBe(true);
    }
    // A layer of more glyphs than one layer holds keeps none.
    const long = Array.from({ length: LAYER_GLYPHS + 1 }, (_, i) => glyph(0, `M${i} 0 Z`));
    expect(table.layout(props, long)).toBeNull();
    // Past the file's distinct glyphs, a layer with new ones keeps none; known ones still go.
    const full = new GlyphTableBuilder();
    for (let i = 0; i < FILE_GLYPHS; i += 1000)
      full.layout(
        props,
        Array.from({ length: Math.min(1000, FILE_GLYPHS - i) }, (_, j) => glyph(i + j)),
      );
    expect(full.size).toBe(FILE_GLYPHS);
    expect(full.layout(props, [glyph(FILE_GLYPHS)])).toBeNull();
    expect(full.layout(props, [glyph(0)])).not.toBeNull();
    expect(full.skipped).toBe(1);
  });

  it("checks that every glyph names one of its refs", () => {
    const layout = new GlyphTableBuilder().layout(props, [glyph(0)]);
    expect(GlyphLayout.safeParse({ ...layout, g: [1, 0, 0] }).success).toBe(false);
    expect(GlyphLayout.safeParse({ ...layout, g: [0, 0] }).success).toBe(false);
    expect(GlyphLayout.safeParse({ ...layout, c: [0, 1] }).success).toBe(false);
  });

  it("is a root-level node, and holds outlines only", () => {
    const store = new MemoryStore();
    const create = (id: string, parent: string, d: string) =>
      applyOp(store, {
        op: "create",
        id,
        type: "glyphSet",
        parent,
        key: "a0",
        props: { glyphOutlines: { "0123456789abcdef": d } },
      });
    expect(() => create("g1", ROOT_ID, "M0 0 L1 1 Z")).not.toThrow();
    expect(() => create("g2", ROOT_ID, "<script>")).toThrow();
  });
});

describe("glyph key", () => {
  it("changes with the text and its type, not its colours", () => {
    const key = glyphKey(props);
    expect(glyphKey({ ...props, fills: [{ type: "solid", color: "#ff0000" }] })).toBe(key);
    expect(glyphKey({ ...props, characters: "Ho" })).not.toBe(key);
    expect(glyphKey({ ...props, fontWeight: 700 })).not.toBe(key);
    // A default stated or left out is the same.
    expect(glyphKey({ ...props, fontWeight: 400 })).toBe(key);
    // A run only colouring keeps it; one changing the type doesn't.
    const red = [{ type: "solid" as const, color: "#ff0000" }];
    expect(glyphKey({ ...props, textRuns: [{ start: 0, end: 1, fills: red }] })).toBe(key);
    expect(glyphKey({ ...props, textRuns: [{ start: 0, end: 1, fontSize: 20 }] })).not.toBe(key);
    // Runs split or merged the same way are the same.
    expect(
      glyphKey({
        ...props,
        textRuns: [
          { start: 0, end: 1, fontSize: 20 },
          { start: 1, end: 2, fontSize: 20 },
        ],
      }),
    ).toBe(glyphKey({ ...props, textRuns: [{ start: 0, end: 2, fontSize: 20 }] }));
  });
});
