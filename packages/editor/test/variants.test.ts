import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { beforeEach, describe, expect, it } from "vitest";
import { componentSetOf, isComponentSet, variantProperties, variantsOf } from "../src/components";
import { Editor } from "../src/editor";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = { width: (_f, text) => text.length * 8 };

function setup() {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  return editor;
}

/** A button component with a label, filled with `color`. */
function button(editor: Editor, name: string, color: string, x: number) {
  const frame = editor.createLayer("frame", { x, y: 0, width: 100, height: 40 }, "p", {
    name,
    fills: [{ type: "solid", color }],
  }) as string;
  const label = editor.createLayer("text", { x: 10, y: 10, width: 0, height: 0 }, frame, {
    name: "Label",
  }) as string;
  editor.updateText(label, "Save");
  editor.select([frame]);
  editor.createComponent();
  return { frame, label };
}

const props = (editor: Editor, id: string) => editor.doc.get(id)?.props ?? {};
const fill = (editor: Editor, id: string) => {
  const f = getProp(props(editor, id), "fills")[0];
  return f?.type === "solid" ? f.color : undefined;
};
const childNamed = (editor: Editor, parent: string, name: string): NodeRecord | undefined =>
  editor.doc
    .childIds(parent)
    .map((id) => editor.doc.get(id))
    .find((n) => getProp(n?.props ?? {}, "name") === name);

describe("variants", () => {
  let editor: Editor;
  let primary: ReturnType<typeof button>;
  let ghost: ReturnType<typeof button>;
  let set: string;

  beforeEach(() => {
    editor = setup();
    primary = button(editor, "Button/Primary", "#2563eb", 0);
    ghost = button(editor, "Button/Ghost", "#ffffff", 200);
    editor.select([primary.frame, ghost.frame]);
    editor.combineAsVariants();
    set = editor.s.selection[0] as string;
  });

  it("combines components into a set with one property", () => {
    expect(isComponentSet(editor.doc.get(set))).toBe(true);
    expect(getProp(props(editor, set), "name")).toBe("Button");
    expect(variantsOf(editor.doc, set).map((v) => v.id)).toEqual([primary.frame, ghost.frame]);
    expect(variantProperties(editor.doc, set)).toEqual([
      { name: "Property 1", values: ["Primary", "Ghost"] },
    ]);
    expect(getProp(props(editor, primary.frame), "name")).toBe("Property 1=Primary");
    expect(componentSetOf(editor.doc, ghost.frame)?.id).toBe(set);
  });

  it("wraps even a single component into its own set", () => {
    const solo = button(editor, "Badge", "#16a34a", 400);
    editor.select([solo.frame]);
    editor.combineAsVariants();
    const soloSet = editor.s.selection[0] as string;
    expect(soloSet).not.toBe(solo.frame);
    expect(editor.doc.get(solo.frame)?.parent).toBe(soloSet);
    expect(getProp(props(editor, solo.frame), "isComponentSet")).toBe(false);
  });

  it("renames properties and adds variants and properties", () => {
    editor.renameVariantProperty(set, "Property 1", "Kind");
    expect(getProp(props(editor, ghost.frame), "variantProps")).toEqual({ Kind: "Ghost" });
    const danger = editor.addVariant(ghost.frame) as string;
    expect(getProp(props(editor, danger), "isComponent")).toBe(true);
    expect(getProp(props(editor, danger), "variantProps")).toEqual({ Kind: "Variant 3" });
    editor.setVariantProp(danger, "Kind", "Danger");
    expect(getProp(props(editor, danger), "name")).toBe("Kind=Danger");
    editor.addVariantProperty(set, "Medium");
    expect(variantProperties(editor.doc, set).map((p) => p.name)).toEqual(["Kind", "Property 2"]);
  });

  it("switches an instance's variant and keeps overrides on matching layers", () => {
    editor.select([primary.frame]);
    editor.duplicate();
    const instance = editor.s.selection[0] as string;
    expect(fill(editor, instance)).toBe("#2563eb");
    const label = childNamed(editor, instance, "Label") as NodeRecord;
    editor.updateText(label.id, "Delete");

    editor.setInstanceVariant(instance, "Property 1", "Ghost");
    expect(getProp(props(editor, instance), "instanceOf")).toBe(ghost.frame);
    expect(fill(editor, instance)).toBe("#ffffff");
    const newLabel = childNamed(editor, instance, "Label") as NodeRecord;
    expect(getProp(newLabel.props, "characters")).toBe("Delete");
    expect(getProp(newLabel.props, "overrides")).toEqual(["characters"]);
    expect(getProp(newLabel.props, "mirrors")).toBe(ghost.label);

    // One undo step brings the primary variant back.
    editor.undo();
    expect(getProp(props(editor, instance), "instanceOf")).toBe(primary.frame);
    expect(fill(editor, instance)).toBe("#2563eb");
  });

  it("resets a single override", () => {
    editor.select([primary.frame]);
    editor.duplicate();
    const instance = editor.s.selection[0] as string;
    const label = childNamed(editor, instance, "Label") as NodeRecord;
    editor.updateText(label.id, "Delete");
    editor.setProp([label.id], "fontWeight", 700);
    editor.resetOverride(label.id, "characters");
    const after = editor.doc.get(label.id) as NodeRecord;
    expect(getProp(after.props, "characters")).toBe("Save");
    expect(getProp(after.props, "overrides")).toEqual(["fontWeight"]);
    expect(getProp(after.props, "fontWeight")).toBe(700);
  });
});
