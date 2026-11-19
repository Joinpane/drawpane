import { checkNode, getProp, glyphKey } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { generateEffectKit } from "../src/effects";

describe("generateEffectKit", () => {
  const kit = generateEffectKit();

  it("makes valid nodes, the same each time", () => {
    for (const node of kit.nodes) expect(() => checkNode(node)).not.toThrow();
    expect(generateEffectKit().nodes).toEqual(kit.nodes);
  });

  it("is heavy on what costs the most to draw", () => {
    expect(kit.stats.layers).toBeGreaterThan(3000);
    expect(kit.stats.readers).toBeGreaterThan(100);
    expect(kit.stats.shadows).toBeGreaterThan(500);
  });

  it("lays out every text from saved glyphs that are still its own", () => {
    const set = kit.nodes.find((n) => n.type === "glyphSet");
    const outlines = set ? getProp(set.props, "glyphOutlines") : {};
    const texts = kit.nodes.filter((n) => n.type === "text");
    expect(texts.length).toBe(kit.stats.texts);
    for (const t of texts) {
      const layout = getProp(t.props, "glyphLayout");
      expect(layout?.key).toBe(glyphKey(t.props));
      for (const ref of layout?.refs ?? []) expect(outlines[ref]).toBeDefined();
    }
  });
});
