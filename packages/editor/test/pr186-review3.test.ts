import {
  changedFields,
  compactByInstance,
  getProp,
  libraryNodeId,
  type NodeRecord,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { runTool } from "../src/agent/tools";
import { Editor } from "../src/editor";
import { Editor as MainEraEditor } from "./main-era/editor-af07ef0.mjs";

function node(
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: NodeRecord["props"] = {},
): NodeRecord {
  return { id, type, parent, key: "a0", props };
}

function editor(nodes: NodeRecord[], copies: "compact" | "materialized") {
  const result = new Editor({ clientId: "review3", measurer: { width: () => 10 } });
  result.doc.resetStored(nodes, copies);
  result.state.set({ role: "editor" });
  result.setPage("p");
  return result;
}

const legacy = () => [
  node("p", "page", ROOT_ID),
  node("c", "collection", ROOT_ID, { modes: [{ id: "a", name: "A" }] }),
  node("v", "variable", "c", { variableType: "number", values: { a: 0.5 } }),
  node("r", "rect", "p", { name: "Before", opacity: 0.5, bindings: { opacity: "v" } }),
];

describe("PR 186 data preservation review", () => {
  it("preserves the saved legacy width when moving the bound layer through the clipboard", () => {
    const old = new MainEraEditor({ clientId: "old-review3", measurer: { width: () => 10 } });
    const nodes = legacy();
    nodes.push(
      node("size", "variable", "c", { variableType: "number", values: { a: 40 } }),
      node("shape", "rect", "p", { width: 32, maxWidth: 32 }),
    );
    old.doc.resetStored(nodes, "materialized");
    old.state.set({ role: "editor" });
    old.setPage("p");
    old.bindVariable(["shape"], "width", "size");
    expect(old.doc.get("shape")?.props.width).toBe(40);
    expect(old.doc.get("shape")?.props.bindings).toEqual({ width: "size" });
    const current = editor(old.doc.stored(), "materialized");
    expect(current.doc.getUnresolved("shape")?.props.width).toBe(40);
    current.select(["shape"]);
    const clipboard = current.cut();
    if (!clipboard) throw new Error("The legacy layer did not copy");
    expect(current.paste(clipboard)).toBe(true);
    const id = current.state.get().selection[0];
    if (!id) throw new Error("The legacy layer did not paste");
    expect(current.doc.getUnresolved(id)?.props.width).toBe(40);
    expect(current.doc.get(id)?.props.width).toBe(40);
  });

  it("keeps the last saved legacy opacity when compacting an instance after deleting its token", () => {
    const nodes = [
      node("p", "page", ROOT_ID),
      node("main", "frame", "p", { isComponent: true }),
      node("original", "rect", "main", { opacity: 0.5, bindings: { opacity: "deleted" } }),
      node("instance", "frame", "p", { instanceOf: "main" }),
      node("copy", "rect", "instance", {
        mirrors: "original",
        opacity: 0.25,
        bindings: { opacity: "deleted" },
      }),
    ];
    const before = editor(nodes, "materialized");
    expect(before.doc.get("copy")?.props.opacity).toBe(0.25);
    const compact = compactByInstance(nodes);
    expect(compact.detached.size).toBe(0);
    const id = compact.ids.get("copy");
    if (!id) throw new Error("The copy wasn't compacted");
    const after = editor(compact.nodes, "compact");
    after.doc.childIds("instance");
    expect(after.doc.get(id)?.props.opacity).toBe(0.25);
  });

  it("keeps a layer's own tracking unit when its linked text style is renamed", () => {
    const nodes = legacy();
    nodes.push(
      node("tracking", "variable", "c", { variableType: "number", values: { a: 5 } }),
      node("style", "textStyle", ROOT_ID, {
        name: "Before",
        letterSpacing: { unit: "px", value: 2 },
      }),
      node("label", "text", "p", {
        characters: "Label",
        fontSize: 20,
        letterSpacing: { unit: "percent", value: 5 },
        bindings: { letterSpacing: "tracking" },
        textStyle: "style",
      }),
    );
    const design = editor(nodes, "materialized");
    expect(design.doc.get("label")?.props.letterSpacing).toEqual({ unit: "percent", value: 5 });
    expect(design.commit([{ op: "set", id: "style", prop: "name", value: "After" }])).toBe(true);
    expect(design.doc.getUnresolved("label")?.props.bindings).toEqual({
      letterSpacing: "tracking",
    });
    expect(design.doc.getUnresolved("label")?.props.letterSpacing).toEqual({
      unit: "percent",
      value: 5,
    });
    expect(design.doc.get("label")?.props.letterSpacing).toEqual({ unit: "percent", value: 5 });
  });

  it("lays out a compact instance in its own mode even when it hasn't been read", () => {
    const nodes = [
      node("p", "page", ROOT_ID),
      node("other", "page", ROOT_ID),
      node("c", "collection", ROOT_ID, {
        modes: [
          { id: "light", name: "Light" },
          { id: "dark", name: "Dark" },
        ],
      }),
      node("v", "variable", "c", { variableType: "number", values: { light: 8, dark: 16 } }),
      node("main", "frame", "p", { isComponent: true }),
      node("inner", "frame", "main", {
        layoutMode: "row",
        width: 100,
        height: 30,
        paddingLeft: 8,
        bindings: { paddingLeft: "v" },
      }),
      node("dot", "rect", "inner", { x: 8, width: 10, height: 10 }),
      node("dark", "frame", "other", { variableModes: { c: "dark" } }),
      node("instance", "frame", "dark", { instanceOf: "main" }),
      node("innerCopy", "frame", "instance", {
        mirrors: "inner",
        layoutMode: "row",
        width: 100,
        height: 30,
        paddingLeft: 16,
        bindings: { paddingLeft: "v" },
      }),
      node("copy", "rect", "innerCopy", { mirrors: "dot", x: 16, width: 10, height: 10 }),
    ];
    const compact = compactByInstance(nodes);
    expect(compact.detached.size).toBe(0);
    const warm = editor(compact.nodes, "compact");
    const cold = editor(compact.nodes, "compact");
    const inner = warm.doc.childIds("instance")[0];
    if (!inner) throw new Error("The compact instance has no child");
    const id = warm.doc.childIds(inner)[0];
    if (!id) throw new Error("The copied layout has no child");
    expect(warm.doc.get(id)?.props.x).toBe(16);

    warm.setVariableValue("v", "dark", 24);
    cold.setVariableValue("v", "dark", 24);
    cold.doc.childIds("instance");
    expect(getProp(warm.doc.get(inner)?.props ?? {}, "paddingLeft")).toBe(24);
    expect(getProp(cold.doc.get(inner)?.props ?? {}, "paddingLeft")).toBe(24);
    expect(warm.doc.get(id)?.props.x).toBe(24);
    expect(cold.doc.get(id)?.props.x).toBe(24);
  });

  it("compares legacy and percent bindings as different edits in a three-way plan", () => {
    const before = node("r", "rect", "p", { bindings: { opacity: "v" } });
    const branch = node("r", "rect", "p", {
      bindings: { opacity: { variable: "v", unit: "percent" } },
    });
    const main = node("r", "rect", "p", { bindings: { opacity: "another" } });
    expect(changedFields(before, branch, before)).toMatchObject([
      {
        field: "bindings",
        base: before.props.bindings,
        branch: branch.props.bindings,
        conflict: false,
      },
    ]);
    expect(changedFields(before, branch, main)).toMatchObject([
      { field: "bindings", conflict: true },
    ]);
  });

  it.each(["materialized", "compact"] as const)(
    "keeps a pasted legacy binding and restores its representation after undo (%s)",
    async (copies) => {
      const design = editor(legacy(), copies);
      const clipboard = JSON.stringify({
        format: "drawpane/nodes",
        nodes: [node("r", "rect", "", { opacity: 0.5, bindings: { opacity: "v" } })],
      });
      expect(design.paste(clipboard)).toBe(true);
      const id = design.state.get().selection[0];
      if (!id) throw new Error("No pasted selection");
      expect(design.doc.get(id)?.props.opacity).toBe(0.5);
      expect(design.doc.getUnresolved(id)?.props.bindings).toEqual({ opacity: "v" });
      await runTool(design, "bind_token", { ids: [id], key: "opacity", variableId: "v" });
      expect(design.doc.get(id)?.props.opacity).toBe(0.005);
      expect(design.doc.getUnresolved(id)?.props.bindings).toEqual({
        opacity: { variable: "v", unit: "percent" },
      });
      design.undo();
      expect(design.doc.get(id)?.props.opacity).toBe(0.5);
      expect(design.doc.getUnresolved(id)?.props.bindings).toEqual({ opacity: "v" });
    },
  );

  it.each(["materialized", "compact"] as const)(
    "library insert copies the variable ID and keeps an opacity binding unitless (%s)",
    (copies) => {
      const sourceNodes = legacy().slice(0, 3);
      sourceNodes.push(
        node("component", "frame", "p", {
          isComponent: true,
          width: 20,
          height: 20,
          opacity: 0.5,
          bindings: { opacity: "v" },
        }),
      );
      const source = editor(sourceNodes, copies);
      const target = editor([node("p", "page", ROOT_ID)], copies);
      const lib = { fileId: "source", publishId: "publish", name: "Library" };
      const instance = target.insertLibraryComponent(source.doc, lib, "component");
      if (!instance) throw new Error("The library instance was not inserted");
      expect(target.doc.getUnresolved(instance)?.props.bindings).toEqual({
        opacity: libraryNodeId(lib.fileId, "v"),
      });
      expect(target.doc.get(instance)?.props.opacity).toBe(0.5);
    },
  );
});
