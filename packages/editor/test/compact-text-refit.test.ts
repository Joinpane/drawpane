import { compactByInstance, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { expect, it } from "vitest";
import { Editor } from "../src/editor";

/**
 * A copy of a component that shows its own text keeps the box it was imported
 * with when an edit to its main can't change what it shows: the browser's
 * measurement differs slightly from the one the box was saved with.
 */
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
  return { editor, props, id };
}

const page: NodeRecord = { id: "page", type: "page", parent: ROOT_ID, key: "a0", props: {} };

it("preserves an imported text box driven by an independent binding when the main text changes", () => {
  const source = {
    width: 100,
    height: 20,
    textAutoResize: "none",
    characters: "Token",
  } as const;
  const { editor, props } = open(
    [
      page,
      {
        id: "c",
        type: "collection",
        parent: ROOT_ID,
        key: "a1",
        props: { modes: [{ id: "default", name: "Default" }] },
      },
      {
        id: "v",
        type: "variable",
        parent: "c",
        key: "a0",
        props: { variableType: "string", values: { default: "Token" } },
      },
      {
        id: "main",
        type: "frame",
        parent: "page",
        key: "a0",
        props: { width: 100, height: 50, isComponent: true },
      },
      { id: "mainText", type: "text", parent: "main", key: "a0", props: source },
      {
        id: "copy",
        type: "frame",
        parent: "page",
        key: "a1",
        props: { width: 100, height: 50, instanceOf: "main" },
      },
      {
        id: "copyText",
        type: "text",
        parent: "copy",
        key: "a0",
        props: {
          ...source,
          mirrors: "mainText",
          characters: "Saved fallback",
          bindings: { characters: "v" },
          textAutoResize: "width",
          width: 72,
          overrides: ["characters", "textAutoResize"],
        },
      },
    ],
    true,
  );
  expect(props("copyText").characters).toBe("Token");
  editor.updateText("mainText", "New main");
  expect(props("copyText").characters).toBe("Token");
  expect(props("copyText").width).toBe(72);
});

it("preserves an imported text box when an unrelated main text stroke changes", () => {
  const source = {
    width: 100,
    height: 20,
    textAutoResize: "none",
    characters: "Token",
  } as const;
  const { editor, props } = open(
    [
      page,
      {
        id: "c",
        type: "collection",
        parent: ROOT_ID,
        key: "a1",
        props: { modes: [{ id: "default", name: "Default" }] },
      },
      {
        id: "v",
        type: "variable",
        parent: "c",
        key: "a0",
        props: { variableType: "string", values: { default: "Token" } },
      },
      {
        id: "main",
        type: "frame",
        parent: "page",
        key: "a0",
        props: { width: 100, height: 50, isComponent: true },
      },
      { id: "mainText", type: "text", parent: "main", key: "a0", props: source },
      {
        id: "copy",
        type: "frame",
        parent: "page",
        key: "a1",
        props: { width: 100, height: 50, instanceOf: "main" },
      },
      {
        id: "copyText",
        type: "text",
        parent: "copy",
        key: "a0",
        props: {
          ...source,
          mirrors: "mainText",
          characters: "Saved fallback",
          textAutoResize: "width",
          width: 72,
          overrides: ["characters", "textAutoResize"],
        },
      },
    ],
    true,
  );
  expect(props("copyText").characters).toBe("Saved fallback");
  editor.setProp(["mainText"], "strokes", [{ type: "solid", color: "#000000" }]);
  expect(props("copyText").characters).toBe("Saved fallback");
  expect(props("copyText").width).toBe(72);
});
