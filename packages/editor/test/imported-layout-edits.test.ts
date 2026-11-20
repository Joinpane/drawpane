import { compactByInstance, getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { expect, it } from "vitest";
import { convertFile, drawpaneId, type Figma } from "../../figma/src/index";
import { Editor } from "../src/editor";
import { layoutOps } from "../src/layout";

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

it("refits a compact copy with a visible stroke when the main has no stroke", () => {
  const frame = {
    layoutMode: "row",
    width: 100,
    height: 50,
    strokesIncludedInLayout: true,
    strokeAlign: "inside",
    strokeWeight: 5,
  } as const;
  const { editor, props } = open(
    [
      page,
      {
        id: "main",
        type: "frame",
        parent: "page",
        key: "a0",
        props: { ...frame, isComponent: true },
      },
      {
        id: "mainChild",
        type: "rect",
        parent: "main",
        key: "a0",
        props: { sizingH: "fill", width: 100, height: 20 },
      },
      {
        id: "copy",
        type: "frame",
        parent: "page",
        key: "a1",
        props: {
          ...frame,
          width: 200,
          instanceOf: "main",
          strokes: [{ type: "solid", color: "#000000" }],
          overrides: ["strokes"],
        },
      },
      {
        id: "copyChild",
        type: "rect",
        parent: "copy",
        key: "a0",
        props: {
          mirrors: "mainChild",
          sizingH: "fill",
          x: 5,
          y: 5,
          width: 190,
          height: 20,
        },
      },
    ],
    true,
  );
  editor.setProp(["main"], "strokeAlign", "outside");
  expect(props("copy").strokeAlign).toBe("outside");
  expect(props("copyChild").width).toBe(200);
});

it("refits a copy whose inherited characters binding is detached", () => {
  const source = {
    width: 100,
    height: 20,
    textAutoResize: "none",
    characters: "Token",
    bindings: { characters: "v" },
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
          width: 50,
          overrides: ["characters", "textAutoResize"],
        },
      },
    ],
    true,
  );
  expect(props("copyText").characters).toBe("Token");
  editor.updateText("mainText", "New main");
  expect(props("copyText").characters).toBe("Saved fallback");
  expect(props("copyText").width).toBe(140);
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

it("refits layout when a linked stroke style hides its paint", () => {
  const { editor, props } = open([
    page,
    {
      id: "style",
      type: "paintStyle",
      parent: ROOT_ID,
      key: "a1",
      props: {
        fills: [{ type: "solid", color: "#000000" }],
      },
    },
    {
      id: "f",
      type: "frame",
      parent: "page",
      key: "a0",
      props: {
        layoutMode: "row",
        width: 100,
        height: 50,
        strokeWeight: 5,
        strokeStyle: "style",
        strokeAlign: "inside",
        strokesIncludedInLayout: true,
      },
    },
    {
      id: "child",
      type: "rect",
      parent: "f",
      key: "a0",
      props: {
        x: 5,
        y: 5,
        width: 90,
        height: 20,
        sizingH: "fill",
      },
    },
  ]);
  editor.setProp(["style"], "fills", [{ type: "solid", color: "#000000", visible: false }]);
  expect(props("f").strokes?.[0]?.visible).toBe(false);
  expect(props("child").width).toBe(100);
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

it("does not reuse a packed variable gap as a minimum for Figma Auto spacing", () => {
  const alias = { type: "VARIABLE_ALIAS", id: "VariableID:1:1" } as const;
  const at = (x: number): Figma.Transform => [
    [1, 0, x],
    [0, 1, 0],
  ];
  const file = {
    name: "Bound Auto gap",
    variables: {
      variableCollections: {
        "VariableCollectionId:1:0": {
          id: "VariableCollectionId:1:0",
          name: "Spacing",
          modes: [{ modeId: "1:2", name: "Default" }],
          defaultModeId: "1:2",
          variableIds: [alias.id],
        },
      },
      variables: {
        [alias.id]: {
          id: alias.id,
          name: "Gap",
          variableCollectionId: "VariableCollectionId:1:0",
          resolvedType: "FLOAT",
          valuesByMode: { "1:2": 30 },
        },
      },
    },
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [
        {
          id: "0:1",
          name: "Page",
          type: "CANVAS",
          children: [
            {
              id: "2:0",
              name: "Row",
              type: "FRAME",
              size: { x: 100, y: 20 },
              relativeTransform: at(0),
              layoutMode: "HORIZONTAL",
              primaryAxisAlignItems: "SPACE_BETWEEN",
              itemSpacing: 30,
              layoutWrap: "WRAP",
              counterAxisSpacing: 7,
              boundVariables: { itemSpacing: alias },
              children: [
                {
                  id: "2:1",
                  name: "Left",
                  type: "RECTANGLE",
                  size: { x: 40, y: 20 },
                  relativeTransform: at(0),
                },
                {
                  id: "2:2",
                  name: "Right",
                  type: "RECTANGLE",
                  size: { x: 40, y: 20 },
                  relativeTransform: at(60),
                },
              ],
            },
          ],
        },
      ],
    },
  } satisfies Figma.File;
  const { nodes } = convertFile(file);
  const { editor } = open(nodes);
  const row = drawpaneId("2:0");
  const right = drawpaneId("2:2");
  expect(editor.doc.get(right)?.props.x).toBe(60);
  expect(editor.doc.get(row)?.props).toMatchObject({ gap: 0, rowGap: 7 });
  expect(editor.doc.get(row)?.props.bindings?.gap).toBeUndefined();
  editor.doc.apply(layoutOps(editor.doc, [row]));
  expect(editor.doc.get(right)?.props).toMatchObject({ x: 60, y: 0 });
});
