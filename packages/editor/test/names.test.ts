import type { NodeRecord } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { layerName } from "../src/names";

const node = (type: NodeRecord["type"], props: Record<string, unknown>): NodeRecord =>
  ({ id: "n", type, parent: "p", key: "a0", props }) as NodeRecord;

describe("layerName", () => {
  it("calls an unnamed text layer by what it says, first line only", () => {
    expect(layerName(node("text", { characters: "Sign in" }))).toBe("Sign in");
    expect(layerName(node("text", { characters: "  Plan your week\nsecond line" }))).toBe(
      "Plan your week",
    );
  });

  it("treats the automatic 'Text 3' as unnamed, but keeps a name someone gave", () => {
    expect(layerName(node("text", { name: "Text 3", characters: "Sign in" }))).toBe("Sign in");
    expect(layerName(node("text", { name: "CTA label", characters: "Sign in" }))).toBe("CTA label");
  });

  it("cuts long text at a word, and falls back when there are no words", () => {
    const long = "Everything that matters this week, in one calm view you can actually trust";
    const name = layerName(node("text", { characters: long }));
    expect(name.endsWith("…")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(49);
    expect(long.startsWith(name.slice(0, -1))).toBe(true);
    expect(layerName(node("text", { characters: "   " }))).toBe("text");
    expect(layerName(node("rect", { name: "" }))).toBe("rect");
  });
});
