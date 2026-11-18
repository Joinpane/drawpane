/**
 * The review of component properties phase 1 (#187), as tests: each case
 * failed on #187's head and passes with decision 0035's amended item 3 (an
 * instance's values kept by property id) and the fixes the review asked for.
 * Each runs with copies stored both ways, and checks undo and what another
 * client receives where the case changes structure.
 */
import { readFileSync } from "node:fs";
import {
  Doc,
  dependencyRoots,
  Editor,
  instanceProperties,
  libraryNodeId,
  overrideGroups,
  pinInstances,
  shownFields,
} from "@drawpane/editor";
import { convertFile, type Figma } from "@drawpane/figma";
import { getProp, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../figma/test/fixtures/component-properties.json", import.meta.url),
    "utf8",
  ),
) as Figma.File;

type FigmaNode = { id: string; name?: string; visible?: boolean; children?: FigmaNode[] } & Record<
  string,
  unknown
>;

function find(node: FigmaNode, id: string): FigmaNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return undefined;
}

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown>,
): NodeRecord => ({ id, type, parent, key, props: props as NodeRecord["props"] });

const imported = (file: Figma.File = fixture) => pinInstances(convertFile(file).nodes).nodes;

/**
 * An editor storing copies as `compact` says, opened on `nodes` (the
 * fixture, imported, by default), with what it sends recorded so another
 * client can apply it.
 */
function open(compact: boolean, nodes?: NodeRecord[]) {
  const initial = nodes ?? imported();
  const editor = new Editor({ clientId: "review", measurer: { width: (_f, t) => t.length * 7 } });
  editor.state.set({ role: "editor" });
  editor.doc.resetStored([], compact ? "compact" : "materialized");
  editor.doc.reset(structuredClone(initial));
  editor.setPage(nodes ? "p" : "f0-1");
  const sent: Op[][] = [];
  const commit = editor.sync.commit.bind(editor.sync);
  editor.sync.commit = (ops: readonly Op[]) => {
    const inverse = commit(ops);
    if (ops.length > 0) sent.push([...editor.doc.lastStoredOps]);
    return inverse;
  };
  const id = (s: string) => editor.doc.resetIds.get(s) ?? s;
  const props = (s: string) => editor.doc.get(id(s))?.props ?? {};
  /** Another client: the same file, then what this one sent, as stored. */
  const peer = () => {
    const other = new Doc({ compactCopies: compact });
    other.resetStored([], compact ? "compact" : "materialized");
    other.reset(structuredClone(initial));
    for (const ops of sent) other.applyStored(ops);
    return other;
  };
  return { editor, id, props, peer };
}

const row = (editor: Editor, instance: string, property: string) =>
  instanceProperties(editor.doc, instance)?.rows.find((r) => r.id === property);

/** A subtree as presented: types, sources and values, ids aside (they differ between forms). */
function shape(doc: Doc, id: string): unknown {
  const n = doc.get(id);
  if (!n) return null;
  const { overrides: _o, ...props } = n.props as Record<string, unknown>;
  return {
    type: n.type,
    props,
    children: doc.childIds(id).map((c) => shape(doc, c)),
  };
}

for (const compact of [false, true])
  describe(`component property values (${compact ? "compact" : "materialized"} copies)`, () => {
    // Review finding 1 (P1).
    it("rebuilds a nested swap's layers when it's reset, for undo and other clients too", () => {
      const { editor, id, peer } = open(compact);
      const icon = id("fI6-3_1-3");
      const original = editor.doc.childIds("f1-3").length;
      expect(original).toBeGreaterThan(0);
      const before = shape(editor.doc, icon);
      expect(getProp(editor.doc.get(icon)?.props ?? {}, "instanceOf")).toBe("f4-1");
      editor.resetInstanceProperty("f6-3", "10:3");
      expect(getProp(editor.doc.get(icon)?.props ?? {}, "instanceOf")).toBe("f3-1");
      expect(editor.doc.childIds(icon)).toHaveLength(original);
      const after = shape(editor.doc, icon);
      expect(shape(peer(), icon)).toEqual(after);
      editor.undo();
      expect(shape(editor.doc, icon)).toEqual(before);
      editor.redo();
      expect(shape(editor.doc, icon)).toEqual(after);
    });

    // Review finding 2 (P1), first case.
    it("keeps a text value across variants whose label layers have other names", () => {
      const file = structuredClone(fixture);
      const label = find(file.document as unknown as FigmaNode, "1:4") as FigmaNode;
      label.name = "Different label name";
      const { editor } = open(compact, imported(file));
      editor.setPage("f0-1");
      editor.setInstanceProperty("f6-1", "10:2", "Keep me");
      const variant = instanceProperties(editor.doc, "f6-1")?.rows[0];
      expect(variant?.type).toBe("variant");
      editor.setInstanceProperty("f6-1", variant?.id as string, "default");
      const text = row(editor, "f6-1", "10:2");
      expect(text?.value).toBe("Keep me");
      expect(text?.changed).toBe(true);
      for (const target of text?.targets ?? [])
        expect(getProp(editor.doc.get(target)?.props ?? {}, "characters")).toBe("Keep me");
    });

    // Review finding 2 (P1), second case: no layer holds it in between.
    it("keeps a text value through a variant that has no layer for it", () => {
      const nodes = [
        node("p", "page", ROOT_ID, "a0", {}),
        node("set", "frame", "p", "a0", {
          isComponentSet: true,
          componentProps: [{ id: "label", name: "Label", type: "text", default: "Base" }],
        }),
        node("a", "frame", "set", "a0", {
          isComponent: true,
          variantProps: { State: "With label" },
          width: 100,
          height: 30,
        }),
        node("labelA", "text", "a", "a0", {
          name: "Label",
          characters: "Base",
          propRefs: { characters: "label" },
        }),
        node("b", "frame", "set", "a1", {
          isComponent: true,
          variantProps: { State: "No label" },
          width: 100,
          height: 30,
        }),
        node("i", "frame", "p", "a1", { instanceOf: "a", width: 100, height: 30 }),
        node("copyLabel", "text", "i", "a0", {
          mirrors: "labelA",
          name: "Label",
          characters: "Base",
          propRefs: { characters: "label" },
        }),
      ];
      const { editor, peer } = open(compact, nodes);
      editor.setInstanceProperty("i", "label", "Keep me");
      editor.setInstanceProperty("i", "State", "No label");
      expect(row(editor, "i", "label")).toBeUndefined();
      expect(getProp(editor.doc.get("i")?.props ?? {}, "propValues")).toEqual({ label: "Keep me" });
      editor.setInstanceProperty("i", "State", "With label");
      expect(row(editor, "i", "label")?.value).toBe("Keep me");
      const target = row(editor, "i", "label")?.targets[0] as string;
      expect(getProp(peer().get(target)?.props ?? {}, "characters")).toBe("Keep me");
      // Undoing the round trip and the set leaves no record.
      editor.undo();
      editor.undo();
      editor.undo();
      expect(getProp(editor.doc.get("i")?.props ?? {}, "propValues")).toEqual({});
      expect(row(editor, "i", "label")?.value).toBe("Base");
    });

    // Review design note: one property, several layers, one value.
    it("gives a layer the main adds the value its instances set", () => {
      const { editor, id, peer } = open(compact);
      editor.setInstanceProperty("f6-1", "10:1", false);
      editor.commit([
        {
          op: "create",
          id: "extraIcon",
          type: "rect",
          parent: "f1-5",
          key: "a9",
          props: { name: "Second icon", width: 16, height: 16, propRefs: { visible: "10:1" } },
        },
      ]);
      const boolean = row(editor, "f6-1", "10:1");
      expect(boolean?.targets).toHaveLength(2);
      expect(boolean?.value).toBe(false);
      const values = (doc: Doc) =>
        boolean?.targets.map((t) => getProp(doc.get(t)?.props ?? {}, "visible"));
      expect(values(editor.doc)).toEqual([false, false]);
      expect(values(peer())).toEqual([false, false]);
      // An instance that didn't set it shows the new layer.
      expect(getProp(editor.doc.get(id("fI6-3_1-6"))?.props ?? {}, "visible")).toBe(true);
    });

    it("sets the property when a layer it drives is edited by hand", () => {
      const { editor } = open(compact);
      editor.setInstanceProperty("f6-1", "10:1", true);
      editor.commit([
        {
          op: "create",
          id: "extraIcon",
          type: "rect",
          parent: "f1-5",
          key: "a9",
          props: { name: "Second icon", width: 16, height: 16, propRefs: { visible: "10:1" } },
        },
      ]);
      const targets = row(editor, "f6-1", "10:1")?.targets ?? [];
      expect(targets).toHaveLength(2);
      editor.setProp([targets[1] as string], "visible", false);
      expect(row(editor, "f6-1", "10:1")?.value).toBe(false);
      expect(targets.map((t) => getProp(editor.doc.get(t)?.props ?? {}, "visible"))).toEqual([
        false,
        false,
      ]);
      // Its record has the value (and the label text it held as an override before it had one).
      expect(getProp(editor.doc.get("f6-1")?.props ?? {}, "propValues")).toMatchObject({
        "10:1": false,
      });
    });

    // Review finding 3 (P2).
    it("puts a moved end-pinned child back where its constraint places it", () => {
      const nodes = [
        node("p", "page", ROOT_ID, "a0", {}),
        node("m", "frame", "p", "a0", { isComponent: true, width: 100, height: 40 }),
        node("c", "rect", "m", "a0", { x: 70, width: 20, height: 20, constraintH: "end" }),
        node("i", "frame", "p", "a1", {
          instanceOf: "m",
          width: 200,
          height: 40,
          overrides: ["width"],
        }),
        node("ic", "rect", "i", "a0", {
          mirrors: "c",
          x: 170,
          width: 20,
          height: 20,
          constraintH: "end",
        }),
      ];
      const { editor, id } = open(compact, nodes);
      const child = id("ic");
      editor.setProp([child], "x", 150);
      expect(getProp(editor.doc.get(child)?.props ?? {}, "overrides")).toContain("x");
      editor.resetOverrides([{ id: child, props: ["x"] }]);
      expect(getProp(editor.doc.get(child)?.props ?? {}, "x")).toBe(170);
      expect(getProp(editor.doc.get(child)?.props ?? {}, "overrides")).not.toContain("x");
      // Moving the main layer moves it by as much.
      editor.setProp(["c"], "x", 60);
      expect(getProp(editor.doc.get(child)?.props ?? {}, "x")).toBe(160);
      // Reset all puts it where the constraint says, too.
      editor.setProp([child], "x", 10);
      editor.select(["i"]);
      editor.resetInstances();
      expect(getProp(editor.doc.get(child)?.props ?? {}, "x")).toBe(160);
    });

    it("stretches and centres children of a resized copy from their main layers", () => {
      const nodes = [
        node("p", "page", ROOT_ID, "a0", {}),
        node("m", "frame", "p", "a0", { isComponent: true, width: 100, height: 40 }),
        node("s", "rect", "m", "a0", { x: 10, width: 80, height: 20, constraintH: "stretch" }),
        node("k", "rect", "m", "a1", { x: 40, width: 20, height: 20, constraintH: "center" }),
        node("i", "frame", "p", "a1", {
          instanceOf: "m",
          width: 200,
          height: 40,
          overrides: ["width"],
        }),
        node("is", "rect", "i", "a0", {
          mirrors: "s",
          x: 10,
          width: 180,
          height: 20,
          constraintH: "stretch",
        }),
        node("ik", "rect", "i", "a1", {
          mirrors: "k",
          x: 90,
          width: 20,
          height: 20,
          constraintH: "center",
        }),
      ];
      const { editor, id } = open(compact, nodes);
      editor.setProp(["s"], "width", 60);
      editor.setProp(["k"], "x", 30);
      expect(getProp(editor.doc.get(id("is"))?.props ?? {}, "width")).toBe(160);
      expect(getProp(editor.doc.get(id("ik"))?.props ?? {}, "x")).toBe(80);
    });

    // Review finding 4 (P2).
    it("resets one variant axis of a nested instance and keeps the others", () => {
      const nodes = [
        node("p", "page", ROOT_ID, "a0", {}),
        node("set", "frame", "p", "a0", { isComponentSet: true, name: "Button" }),
        ...[
          ["a", "Light", "Small"],
          ["b", "Dark", "Small"],
          ["c", "Light", "Large"],
          ["d", "Dark", "Large"],
        ].map(([v, Tone, Size], k) =>
          node(v as string, "frame", "set", `a${k}`, {
            isComponent: true,
            width: 100,
            height: 30,
            variantProps: { Tone, Size },
          }),
        ),
        node("outer", "frame", "p", "a1", { isComponent: true, width: 100, height: 30 }),
        node("nested", "frame", "outer", "a0", {
          instanceOf: "a",
          exposeProps: true,
          width: 100,
          height: 30,
        }),
        node("copy", "frame", "p", "a2", { instanceOf: "outer", width: 100, height: 30 }),
        node("copyNested", "frame", "copy", "a0", {
          mirrors: "nested",
          instanceOf: "a",
          exposeProps: true,
          width: 100,
          height: 30,
        }),
      ];
      const { editor, id } = open(compact, nodes);
      const nested = id("copyNested");
      editor.setInstanceProperty(nested, "Tone", "Dark");
      editor.setInstanceProperty(nested, "Size", "Large");
      editor.resetInstanceProperty(nested, "Tone");
      const rows = instanceProperties(editor.doc, nested)?.rows ?? [];
      expect(rows.find((r) => r.id === "Tone")).toMatchObject({ value: "Light", changed: false });
      expect(rows.find((r) => r.id === "Size")).toMatchObject({ value: "Large", changed: true });
      editor.resetInstanceProperty(nested, "Size");
      expect(getProp(editor.doc.get(nested)?.props ?? {}, "instanceOf")).toBe("a");
      expect(getProp(editor.doc.get(nested)?.props ?? {}, "overrides")).not.toContain("instanceOf");
    });

    // Review finding 5 (P2).
    it("binds the variable again when a text property is reset", () => {
      const { editor, id } = open(compact);
      const collection = editor.createCollection("Words") as string;
      const variable = editor.createVariable(collection, "Label", "string", "Bound") as string;
      editor.bindVariable(["f1-7"], "characters", variable);
      const target = id("fI6-1_1-7");
      editor.setInstanceProperty("f6-1", "10:2", "Custom");
      expect(getProp(editor.doc.get(target)?.props ?? {}, "characters")).toBe("Custom");
      expect(getProp(editor.doc.get(target)?.props ?? {}, "bindings").characters).toBeUndefined();
      editor.resetInstanceProperty("f6-1", "10:2");
      const reset = editor.doc.get(target)?.props ?? {};
      expect(getProp(reset, "bindings").characters).toBe(variable);
      expect(getProp(reset, "overrides")).not.toContain("characters");
      expect(getProp(reset, "overrides")).not.toContain("bindings");
      const mode = getProp(editor.doc.get(collection)?.props ?? {}, "modes")[0]?.id as string;
      editor.setVariableValue(variable, mode, "After reset");
      expect(getProp(editor.doc.get(target)?.props ?? {}, "characters")).toBe("After reset");
    });

    // Review finding 6 (P2).
    it("names a library's swap defaults and preferred components as its copies, and copies them", () => {
      const source = open(compact).editor;
      const { editor } = open(compact, [node("p", "page", ROOT_ID, "a0", {})]);
      expect(dependencyRoots(source.doc, ["f1-1"])).toContain("f4-1");
      const instance = editor.insertLibraryComponent(
        source.doc,
        { fileId: "libraryFile", name: "Kit", publishId: "publish" },
        "f1-1",
      ) as string;
      const icon = row(editor, instance, "10:3");
      expect(icon?.preferred).toEqual(["f3-1", "f4-1"].map((c) => libraryNodeId("libraryFile", c)));
      expect(editor.doc.get(libraryNodeId("libraryFile", "f4-1"))).toBeDefined();
      const set = editor.doc.get(libraryNodeId("libraryFile", "f1-1"));
      const def = getProp(set?.props ?? {}, "componentProps").find((d) => d.id === "10:3");
      expect(def?.default).toBe(libraryNodeId("libraryFile", "f3-1"));
    });

    // Review finding 7 (P2).
    it("keeps a boolean's value on a nested instance when the instance is swapped", () => {
      const file = structuredClone(fixture);
      const doc = file.document as unknown as FigmaNode;
      (find(doc, "1:6") as FigmaNode).visible = false;
      (find(doc, "1:3") as FigmaNode).visible = false;
      const set = find(doc, "1:1") as FigmaNode & {
        componentPropertyDefinitions: Record<string, { defaultValue: unknown }>;
      };
      (
        set.componentPropertyDefinitions["Show Icon#10:1"] as { defaultValue: unknown }
      ).defaultValue = false;
      (find(doc, "I6:1;1:6") as FigmaNode).visible = false;
      const { editor, peer } = open(compact, imported(file));
      editor.setPage("f0-1");
      expect(row(editor, "f6-1", "10:1")?.value).toBe(false);
      editor.setInstanceProperty("f6-1", "10:3", "f4-1");
      const after = row(editor, "f6-1", "10:1");
      expect(after?.value).toBe(false);
      expect(after?.changed).toBe(false);
      for (const target of after?.targets ?? []) {
        expect(getProp(editor.doc.get(target)?.props ?? {}, "visible")).toBe(false);
        expect(getProp(peer().get(target)?.props ?? {}, "visible")).toBe(false);
      }
      expect(row(editor, "f6-1", "10:3")?.value).toBe("f4-1");
    });

    it("swaps every layer an instance swap drives, and keeps the choice across a variant switch", () => {
      const { editor } = open(compact);
      editor.setInstanceProperty("f6-1", "10:3", "f4-1");
      expect(getProp(editor.doc.get("f6-1")?.props ?? {}, "propValues")).toMatchObject({
        "10:3": { instance: "f4-1" },
      });
      const variant = instanceProperties(editor.doc, "f6-1")?.rows[0];
      const other = variant?.options?.find((o) => o !== variant.value) as string;
      editor.setInstanceProperty("f6-1", variant?.id as string, other);
      expect(row(editor, "f6-1", "10:3")).toMatchObject({ value: "f4-1", changed: true });
      for (const target of row(editor, "f6-1", "10:3")?.targets ?? [])
        expect(getProp(editor.doc.get(target)?.props ?? {}, "instanceOf")).toBe("f4-1");
    });

    it("forgets every value with Reset all", () => {
      const { editor } = open(compact);
      editor.setInstanceProperty("f6-1", "10:1", false);
      editor.setInstanceProperty("f6-1", "10:2", "Gone");
      editor.select(["f6-1"]);
      editor.resetInstances();
      expect(getProp(editor.doc.get("f6-1")?.props ?? {}, "propValues")).toEqual({});
      expect(row(editor, "f6-1", "10:1")).toMatchObject({ value: true, changed: false });
      expect(row(editor, "f6-1", "10:2")?.changed).toBe(false);
    });

    it("keeps an imported value, folded into the record at import, across the first switch", () => {
      const { editor } = open(compact);
      // The imported outline Button's text is in its record, put there as the file was imported
      // (`foldPropertyValues`), not an override on its label.
      expect(getProp(editor.doc.get("f6-1")?.props ?? {}, "propValues")).toEqual({
        "10:2": "Outline",
      });
      expect(row(editor, "f6-1", "10:2")).toMatchObject({ value: "Outline", changed: true });
      const variant = instanceProperties(editor.doc, "f6-1")?.rows[0];
      const other = variant?.options?.find((o) => o !== variant.value) as string;
      editor.setInstanceProperty("f6-1", variant?.id as string, other);
      expect(getProp(editor.doc.get("f6-1")?.props ?? {}, "propValues")).toMatchObject({
        "10:2": "Outline",
      });
      expect(row(editor, "f6-1", "10:2")?.value).toBe("Outline");
    });

    it("lists the old variant noise of a file from before, as it is (no silent cleanup)", () => {
      const nodes = imported().map((n) =>
        n.id === "f6-1"
          ? {
              ...n,
              props: {
                ...n.props,
                variantProps: { Variant: "outline" },
                overrides: ["variantProps", "width"],
              } as NodeRecord["props"],
            }
          : n,
      );
      const { editor } = open(compact, nodes);
      editor.setPage("f0-1");
      const groups = overrideGroups(
        editor.doc,
        "f6-1",
        shownFields(instanceProperties(editor.doc, "f6-1")),
      );
      expect(groups.some((g) => g.items.some((i) => i.props.includes("variantProps")))).toBe(true);
    });
  });
