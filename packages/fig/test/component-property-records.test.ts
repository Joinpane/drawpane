/**
 * Where an instance's property values go when what holds them changes
 * (decision 0035, item 3): the record of the instance that isn't a copy
 * holds its nested instances' values too, so detaching it, deleting its
 * main, converting a file from before records or inserting a library's
 * component each hands them on. In both copy forms.
 */
import { Doc, Editor, instanceProperties, instanceValues, libraryNodeId } from "@drawpane/editor";
import { compactByInstance, getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { expectShowsRecord, FORMS, legacy, measurer, nested, node, open } from "./property-rooms";

/** Texts under `id`, as shown, in layer order. */
function texts(doc: Doc, id: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    const n = doc.get(at);
    if (n?.type === "text") out.push(getProp(n.props, "characters"));
    for (const child of doc.childIds(at)) walk(child);
  };
  walk(id);
  return out;
}

for (const form of FORMS)
  describe(`records hand their values on (${form})`, () => {
    it("detaching keeps what the layers show, and a nested instance takes its values", () => {
      const { editor } = open(form, nested());
      const ni = instanceProperties(editor.doc, "i")?.nested[0]?.instanceId as string;
      editor.setInstanceProperty(ni, "label", "Kept");
      expect(texts(editor.doc, "i")).toEqual(["Kept"]);
      editor.select(["i"]);
      editor.detachInstances();
      expect(getProp(editor.doc.get("i")?.props ?? {}, "instanceOf")).toBeNull();
      expect(getProp(editor.doc.get("i")?.props ?? {}, "propValues")).toEqual({});
      expect(texts(editor.doc, "i")).toEqual(["Kept"]);
      // The nested instance is an instance on its own now, its value in its own record.
      const nestedNow = editor.doc.childIds("i")[0] as string;
      expect(getProp(editor.doc.get(nestedNow)?.props ?? {}, "instanceOf")).toBe("leaf");
      expect(getProp(editor.doc.get(nestedNow)?.props ?? {}, "propValues")).toEqual({
        label: "Kept",
      });
      expectShowsRecord(editor.doc, nestedNow);
      // One undo puts it back as it was.
      editor.undo();
      expect(getProp(editor.doc.get("i")?.props ?? {}, "propValues")).toEqual({
        "na/label": "Kept",
      });
      expect(texts(editor.doc, "i")).toEqual(["Kept"]);
    });

    it("deleting the main keeps an instance's layers as they show, nested values included", () => {
      const { editor } = open(form, nested());
      const ni = instanceProperties(editor.doc, "i")?.nested[0]?.instanceId as string;
      editor.setInstanceProperty(ni, "label", "Kept");
      editor.commit([{ op: "delete", id: "set" }]);
      expect(texts(editor.doc, "i")).toEqual(["Kept"]);
      editor.undo();
      expect(texts(editor.doc, "i")).toEqual(["Kept"]);
      expect(instanceValues(editor.doc, ni)).toEqual({ label: "Kept" });
    });

    it("Reset all forgets every value, the nested instances' included", () => {
      const { editor } = open(form, nested());
      const ni = instanceProperties(editor.doc, "i")?.nested[0]?.instanceId as string;
      editor.setInstanceProperty(ni, "label", "Gone");
      editor.select(["i"]);
      editor.resetInstances();
      expect(getProp(editor.doc.get("i")?.props ?? {}, "propValues")).toEqual({});
      expect(texts(editor.doc, "i")).toEqual(["Base"]);
    });
  });

describe("a file from before records, converted to compact copies", () => {
  it("has the values its layers held folded into the record, not its instance detached", () => {
    const converted = compactByInstance(legacy());
    const root = converted.nodes.find((n) => n.id === "i");
    expect(getProp(root?.props ?? {}, "instanceOf")).toBe("a");
    // The label differs from its main's; the icon shows as its main has it, so nothing's kept for it.
    expect(getProp(root?.props ?? {}, "propValues")).toEqual({ label: "Before" });
    const doc = new Doc({ compactCopies: true });
    doc.resetStored(converted.nodes, "compact");
    expect(texts(doc, "i")).toEqual(["Before"]);
  });
});

for (const form of FORMS)
  it(`a library's component brings its nested instances' values, their scope renamed (${form})`, () => {
    // Leaf2 holds a Leaf (X); the library's main M holds a Leaf2 (N) whose record sets X's label.
    const library: NodeRecord[] = [
      node("p", "page", ROOT_ID, "a0", {}),
      node("leaf", "frame", "p", "a0", {
        isComponent: true,
        name: "Leaf",
        componentProps: [{ id: "label", name: "Label", type: "text" }],
      }),
      node("lt", "text", "leaf", "a0", { characters: "Base", propRefs: { characters: "label" } }),
      node("leaf2", "frame", "p", "a1", { isComponent: true, name: "Leaf2" }),
      node("X", "frame", "leaf2", "a0", { name: "X", instanceOf: "leaf" }),
      node("Xt", "text", "X", "a0", {
        mirrors: "lt",
        characters: "Base",
        propRefs: { characters: "label" },
      }),
      node("M", "frame", "p", "a2", { isComponent: true, name: "M" }),
      node("N", "frame", "M", "a0", {
        name: "N",
        instanceOf: "leaf2",
        propValues: { "X/label": "Deep" },
      }),
      node("Nx", "frame", "N", "a0", { mirrors: "X", name: "X", instanceOf: "leaf" }),
      node("Nxt", "text", "Nx", "a0", {
        mirrors: "Xt",
        characters: "Deep",
        propRefs: { characters: "label" },
      }),
    ];
    const source = new Editor({ clientId: "lib", measurer });
    source.state.set({ role: "editor" });
    source.doc.resetStored([], form);
    source.doc.reset(structuredClone(library));
    expect(texts(source.doc, "M")).toEqual(["Deep"]);
    const { editor } = open(form, [node("p", "page", ROOT_ID, "a0", {})]);
    const instance = editor.insertLibraryComponent(
      source.doc,
      { fileId: "libraryFile", name: "Kit", publishId: "publish" },
      "M",
    ) as string;
    const copied = editor.doc.get(libraryNodeId("libraryFile", "N"));
    expect(getProp(copied?.props ?? {}, "propValues")).toEqual({
      [`${libraryNodeId("libraryFile", "X")}/label`]: "Deep",
    });
    expect(texts(editor.doc, instance)).toEqual(["Deep"]);
  });
