/**
 * Component properties from import to the instance panel (decision 0035),
 * without the kit: a small Figma file with a Button set (a variant, a
 * boolean, a text and an instance swap) and a Field exposing a nested
 * Button, converted and pinned as the dashboard's import does, then opened
 * in an editor storing copies both ways.
 */
import { readFileSync } from "node:fs";
import {
  countChanges,
  Editor,
  instanceProperties,
  overrideGroups,
  pinInstances,
  setCompactCopiesDefault,
  shownFields,
} from "@drawpane/editor";
import { convertFile, type Figma } from "@drawpane/figma";
import { getProp, type NodeRecord } from "@drawpane/model";
import { afterAll, describe, expect, it } from "vitest";

const file = JSON.parse(
  readFileSync(
    new URL("../../figma/test/fixtures/component-properties.json", import.meta.url),
    "utf8",
  ),
) as Figma.File;

function imported(): NodeRecord[] {
  return pinInstances(convertFile(file).nodes).nodes;
}

describe("importing component properties", () => {
  const nodes = imported();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const props = (id: string) => byId.get(id)?.props ?? {};

  it("keeps a set's definitions in Figma's order, with defaults and preferred components", () => {
    expect(getProp(props("f1-1"), "componentProps")).toEqual([
      { id: expect.stringMatching(/^v/), name: "Variant", type: "variant" },
      { id: "10:1", name: "Show Icon", type: "boolean", default: true },
      { id: "10:2", name: "Label", type: "text", default: "Button" },
      { id: "10:3", name: "Icon", type: "instance", default: "f3-1", preferred: ["f3-1", "f4-1"] },
    ]);
    expect(getProp(props("f5-1"), "componentProps")).toEqual([
      { id: "20:1", name: "Label Text", type: "text", default: "Label" },
    ]);
  });

  it("keeps which layers each property drives, and which nested instances show theirs", () => {
    expect(getProp(props("f1-3"), "propRefs")).toEqual({ visible: "10:1", instanceOf: "10:3" });
    expect(getProp(props("f1-4"), "propRefs")).toEqual({ characters: "10:2" });
    expect(getProp(props("f5-3"), "exposeProps")).toBe(true);
    // Copies have them as their main layers do.
    expect(getProp(props("fI6-2_5-3"), "exposeProps")).toBe(true);
    expect(getProp(props("fI6-2_5-3_1-4"), "propRefs")).toEqual({ characters: "10:2" });
  });

  it("marks overridden only what Figma counts as changed, not what layout decides", () => {
    const marked = nodes
      .filter((n) => getProp(n.props, "overrides").length > 0)
      .map((n) => [n.id, getProp(n.props, "overrides")]);
    expect(Object.fromEntries(marked)).toEqual({
      // Nested instances in mains, named for what they are there.
      "f1-3": ["name"],
      "f1-6": ["name"],
      // The outline button: its text. Not its hug width, nor its label's auto width.
      "fI6-1_1-7": ["characters"],
      // The field: its label, and its nested button's hidden icon and label.
      "fI6-2_5-2": ["characters"],
      "fI6-2_5-3_1-3": ["visible"],
      "fI6-2_5-3_1-4": ["characters"],
    });
    // An instance of a variant holds no variant values of its own.
    expect(props("f6-1").variantProps).toBeUndefined();
  });

  it("doesn't count where an instance sits as a change: its constraints are its own", () => {
    const moved = structuredClone(file);
    const find = (n: Figma.Node, id: string): Figma.Node | undefined =>
      n.id === id ? n : (n.children ?? []).map((c) => find(c, id)).find(Boolean);
    const outline = find(moved.document, "6:1") as { constraints?: unknown };
    outline.constraints = { horizontal: "RIGHT", vertical: "BOTTOM" };
    const nodes = pinInstances(convertFile(moved).nodes).nodes;
    const root = nodes.find((n) => n.id === "f6-1");
    expect(getProp(root?.props ?? {}, "constraintH")).toBe("end");
    expect(getProp(root?.props ?? {}, "overrides")).toEqual([]);
  });
});

for (const compact of [false, true]) {
  describe(`an imported instance's properties (${compact ? "compact" : "materialized"} copies)`, () => {
    afterAll(() => setCompactCopiesDefault(false));

    function open() {
      setCompactCopiesDefault(compact);
      const editor = new Editor({ measurer: { width: (_f, t) => t.length * 7 }, clientId: "t" });
      editor.state.set({ role: "editor" });
      editor.doc.reset(imported());
      editor.setPage("f0-1");
      // Copies are named differently when stored compact: the ids the import gave, as they are now.
      const id = (imported: string) => editor.doc.resetIds.get(imported) ?? imported;
      const get = (imported: string) => editor.doc.get(id(imported))?.props ?? {};
      return { editor, id, get };
    }

    it("shows the main's properties with this instance's values, in order", () => {
      const { editor, id } = open();
      const p = instanceProperties(editor.doc, "f6-1");
      expect(p?.rows.map((r) => [r.name, r.type, r.value, r.changed, r.targets.length])).toEqual([
        ["Variant", "variant", "outline", false, 0],
        ["Show Icon", "boolean", true, false, 1],
        ["Label", "text", "Outline", true, 1],
        ["Icon", "instance", "f3-1", false, 1],
      ]);
      expect(p?.rows[0]?.options).toEqual(["default", "outline"]);
      expect(p?.rows[3]?.preferred).toEqual(["f3-1", "f4-1"]);
      expect(p?.rows[2]?.targets).toEqual([id("fI6-1_1-7")]);
      expect(p?.nested).toEqual([]);
      // What the rows show isn't listed again: nothing else changed.
      expect(overrideGroups(editor.doc, "f6-1", shownFields(p ?? null))).toEqual([]);
      expect(countChanges(editor.doc, "f6-1", p ?? null)).toBe(1);
    });

    it("shows an exposed nested instance's properties under its name", () => {
      const { editor, id } = open();
      const p = instanceProperties(editor.doc, "f6-2");
      expect(p?.rows.map((r) => [r.name, r.value, r.changed])).toEqual([
        ["Label Text", "Bio", true],
      ]);
      expect(p?.nested.map((n) => [n.instanceId, n.name])).toEqual([[id("fI6-2_5-3"), "Button"]]);
      expect(p?.nested[0]?.rows.map((r) => [r.name, r.value, r.changed])).toEqual([
        ["Variant", "default", false],
        ["Show Icon", false, true],
        ["Label", "Save", true],
        ["Icon", "f3-1", false],
      ]);
    });

    it("toggles a boolean and edits a text, as overrides on the layers they drive", () => {
      const { editor, get } = open();
      editor.setInstanceProperty("f6-1", "10:1", false);
      expect(getProp(get("fI6-1_1-6"), "visible")).toBe(false);
      expect(getProp(get("fI6-1_1-6"), "overrides")).toContain("visible");
      editor.setInstanceProperty("f6-1", "10:2", "Delete");
      expect(getProp(get("fI6-1_1-7"), "characters")).toBe("Delete");
      const p = instanceProperties(editor.doc, "f6-1");
      expect(p?.rows.map((r) => [r.name, r.value, r.changed])).toEqual([
        ["Variant", "outline", false],
        ["Show Icon", false, true],
        ["Label", "Delete", true],
        ["Icon", "f3-1", false],
      ]);
      expect(overrideGroups(editor.doc, "f6-1", shownFields(p ?? null))).toEqual([]);
      // One undo step each.
      editor.undo();
      expect(getProp(get("fI6-1_1-7"), "characters")).toBe("Outline");
      editor.undo();
      expect(getProp(get("fI6-1_1-6"), "visible")).toBe(true);
    });

    it("swaps by an instance swap property, and on a nested exposed instance", () => {
      const { editor, id, get } = open();
      editor.setInstanceProperty("f6-1", "10:3", "f4-1");
      expect(getProp(get("fI6-1_1-6"), "instanceOf")).toBe("f4-1");
      expect(instanceProperties(editor.doc, "f6-1")?.rows[3]).toMatchObject({
        value: "f4-1",
        changed: true,
      });
      const nested = id("fI6-2_5-3");
      const variant = instanceProperties(editor.doc, "f6-2")?.nested[0]?.rows[0];
      editor.setInstanceProperty(nested, variant?.id ?? "", "outline");
      expect(getProp(editor.doc.get(nested)?.props ?? {}, "instanceOf")).toBe("f1-5");
      expect(instanceProperties(editor.doc, "f6-2")?.nested[0]?.rows[0]).toMatchObject({
        value: "outline",
        changed: true,
      });
    });

    it("resets one property, leaving the rest", () => {
      const { editor, get } = open();
      editor.setInstanceProperty("f6-1", "10:1", false);
      editor.resetInstanceProperty("f6-1", "10:1");
      expect(getProp(get("fI6-1_1-6"), "visible")).toBe(true);
      expect(getProp(get("fI6-1_1-6"), "overrides")).toEqual([]);
      expect(getProp(get("fI6-1_1-7"), "characters")).toBe("Outline");
      // The button still hugs its longer label: resetting a value doesn't undo layout.
      expect(getProp(get("f6-1"), "width")).toBeGreaterThan(80);
    });

    it("lists other changes in words, by layer, and resets them one at a time", () => {
      const { editor, id, get } = open();
      editor.setProp([id("fI6-1_1-7")], "fontSize", 18);
      editor.setProp(["f6-1"], "fills", [{ type: "solid", color: "#ff0000" }]);
      const p = instanceProperties(editor.doc, "f6-1");
      const groups = overrideGroups(editor.doc, "f6-1", shownFields(p ?? null));
      expect(groups.map((g) => [g.path, g.items.map((i) => i.label)])).toEqual([
        ["", ["Fill"]],
        ["Label", ["Font size"]],
      ]);
      editor.resetOverrides([{ id: id("fI6-1_1-7"), props: ["fontSize"] }]);
      expect(getProp(get("fI6-1_1-7"), "fontSize")).toBe(14);
      // Only that: the fill and the label's text stay changed.
      expect(getProp(get("f6-1"), "overrides")).toContain("fills");
      expect(getProp(get("fI6-1_1-7"), "characters")).toBe("Outline");
    });

    it("resets everything in an instance, its nested instances' changes included", () => {
      const { editor, get } = open();
      editor.select(["f6-2"]);
      editor.resetInstances();
      expect(getProp(get("fI6-2_5-2"), "characters")).toBe("Label");
      expect(getProp(get("fI6-2_5-3_1-3"), "visible")).toBe(true);
      expect(getProp(get("fI6-2_5-3_1-4"), "characters")).toBe("Button");
      expect(countChanges(editor.doc, "f6-2", instanceProperties(editor.doc, "f6-2"))).toBe(0);
    });

    it("renames a property without losing the layers it drives", () => {
      const { editor } = open();
      editor.renameComponentProperty("f1-1", "10:1", "Leading icon");
      const row = instanceProperties(editor.doc, "f6-1")?.rows[1];
      expect(row).toMatchObject({
        name: "Leading icon",
        type: "boolean",
        targets: [expect.any(String)],
      });
    });
  });
}
