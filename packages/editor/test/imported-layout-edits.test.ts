import { compactByInstance, getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { expect, it } from "vitest";
import { Editor } from "../src/editor";

function open(nodes: NodeRecord[], compact = false) {
  const editor = new Editor({
    clientId: "test",
    measurer: { width: (_font, text) => text.length * 10 },
  });
  const snapshot = compact ? compactByInstance(nodes) : null;
  editor.doc.resetStored(snapshot?.nodes ?? nodes, compact ? "compact" : "materialized");
  editor.state.set({ role: "editor" });
  editor.setPage("page");
  const id = (id: string) => snapshot?.ids.get(id) ?? id;
  const props = (name: string) => editor.doc.get(id(name))?.props ?? {};
  return { editor, props };
}

const page: NodeRecord = { id: "page", type: "page", parent: ROOT_ID, key: "a0", props: {} };

it("settles Fill inside a hidden frame resized through constraints", () => {
  const { editor, props } = open([
    page,
    {
      id: "outer",
      type: "frame",
      parent: "page",
      key: "a0",
      props: {
        layoutMode: "row",
        width: 100,
        height: 50,
      },
    },
    {
      id: "hidden",
      type: "frame",
      parent: "outer",
      key: "a0",
      props: {
        visible: false,
        layoutMode: "row",
        positioning: "absolute",
        constraintH: "stretch",
        width: 100,
        height: 20,
      },
    },
    {
      id: "child",
      type: "rect",
      parent: "hidden",
      key: "a0",
      props: {
        sizingH: "fill",
        width: 100,
        height: 20,
      },
    },
  ]);
  editor.setProp(["outer"], "width", 200);
  expect(props("hidden").width).toBe(200);
  expect(props("child").width).toBe(200);
});

it("leaves the layout under an already-visible frame alone when an unrelated layout token changes", () => {
  const { editor, props } = open([
    page,
    {
      id: "c",
      type: "collection",
      parent: ROOT_ID,
      key: "a1",
      props: {
        modes: [{ id: "default", name: "Default" }],
      },
    },
    {
      id: "shown",
      type: "variable",
      parent: "c",
      key: "a0",
      props: {
        variableType: "boolean",
        values: { default: true },
      },
    },
    {
      id: "padding",
      type: "variable",
      parent: "c",
      key: "a1",
      props: {
        variableType: "number",
        values: { default: 10 },
      },
    },
    {
      id: "outer",
      type: "frame",
      parent: "page",
      key: "a0",
      props: {
        layoutMode: "row",
        width: 100,
        height: 100,
        bindings: { visible: "shown", paddingLeft: "padding" },
      },
    },
    {
      id: "plain",
      type: "frame",
      parent: "outer",
      key: "a0",
      props: { x: 10, width: 50, height: 50 },
    },
    {
      id: "badge",
      type: "frame",
      parent: "plain",
      key: "a0",
      props: {
        layoutMode: "row",
        sizingH: "hug",
        width: 50,
        height: 20,
      },
    },
    { id: "child", type: "rect", parent: "badge", key: "a0", props: { width: 20, height: 20 } },
  ]);
  editor.setProp(["padding"], "values", { default: 12 });
  expect(props("plain").x).toBe(12);
  expect(props("badge").width).toBe(50);
});

it("undoing Hide restores a plain frame's original imported descendant geometry", () => {
  const { editor, props } = open([
    page,
    { id: "plain", type: "frame", parent: "page", key: "a0", props: { width: 100, height: 50 } },
    {
      id: "badge",
      type: "frame",
      parent: "plain",
      key: "a0",
      props: {
        layoutMode: "row",
        sizingH: "hug",
        width: 50,
        height: 20,
      },
    },
    { id: "child", type: "rect", parent: "badge", key: "a0", props: { width: 20, height: 20 } },
  ]);
  editor.setProp(["plain"], "visible", false);
  expect(props("badge").width).toBe(50);
  editor.undo();
  expect(getProp(props("plain"), "visible")).toBe(true);
  expect(props("badge").width).toBe(50);
  editor.redo();
  expect(getProp(props("plain"), "visible")).toBe(false);
  expect(props("badge").width).toBe(50);
});
