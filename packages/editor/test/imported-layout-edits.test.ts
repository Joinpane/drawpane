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

it("distributes wrapped tracks when the Figma cross-axis spacing is Auto", () => {
  const alias = { type: "VARIABLE_ALIAS", id: "VariableID:1:1" } as const;
  const at = (x: number, y = 0): Figma.Transform => [
    [1, 0, x],
    [0, 1, y],
  ];
  const file = {
    name: "Bound Auto cross gap",
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
              size: { x: 100, y: 100 },
              layoutWrap: "WRAP",
              counterAxisAlignContent: "SPACE_BETWEEN",
              counterAxisSpacing: 7,
              relativeTransform: at(0),
              layoutMode: "HORIZONTAL",
              primaryAxisAlignItems: "SPACE_BETWEEN",
              itemSpacing: 0,
              boundVariables: { itemSpacing: alias, counterAxisSpacing: alias },
              children: [
                {
                  id: "2:1",
                  name: "Left",
                  type: "RECTANGLE",
                  size: { x: 60, y: 20 },
                  relativeTransform: at(0, 0),
                },
                {
                  id: "2:2",
                  name: "Right",
                  type: "RECTANGLE",
                  size: { x: 60, y: 20 },
                  relativeTransform: at(0, 80),
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
  expect(editor.doc.get(right)?.props.y).toBe(80);
  expect(editor.doc.get(row)?.props).toMatchObject({
    alignContent: "space-between",
    rowGap: 30,
  });
  expect(editor.doc.get(row)?.props.bindings?.rowGap).toBe(drawpaneId(alias.id));
  editor.doc.apply(layoutOps(editor.doc, [row]));
  expect(editor.doc.get(right)?.props.y).toBe(80);

  // Switching distribution away from space-between recovers the dormant rowGap binding.
  editor.setProp([row], "alignContent", "auto");
  expect(editor.doc.get(right)?.props.y).toBe(50);
});

it("shrinks a hugging frame when an edit removes its last flow child while preserving already-empty frames", () => {
  const make = () =>
    open([
      page,
      {
        id: "hug",
        type: "frame",
        parent: "page",
        key: "a0",
        props: {
          layoutMode: "row",
          sizingH: "hug",
          sizingV: "hug",
          paddingTop: 10,
          paddingRight: 10,
          paddingBottom: 10,
          paddingLeft: 10,
          width: 120,
          height: 60,
        },
      },
      {
        id: "only",
        type: "rect",
        parent: "hug",
        key: "a0",
        props: { x: 10, y: 10, width: 100, height: 40 },
      },
    ]);

  // Deleting the only flow child shrinks 120x60 to 20x20 (its padding).
  const del = make();
  del.editor.select(["only"]);
  del.editor.deleteSelection();
  expect(del.props("hug")).toMatchObject({ width: 20, height: 20 });

  // Hiding the only flow child shrinks to 20x20.
  const hide = make();
  hide.editor.setProp(["only"], "visible", false);
  expect(hide.props("hug")).toMatchObject({ width: 20, height: 20 });

  // Taking the only child out of flow shrinks to 20x20.
  const abs = make();
  abs.editor.setProp(["only"], "positioning", "absolute");
  expect(abs.props("hug")).toMatchObject({ width: 20, height: 20 });

  // Moving the only child out shrinks to 20x20.
  const moved = make();
  moved.editor.commit(
    moved.editor.reparentOps("only", "page", moved.editor.topKey("page")),
    "Move",
  );
  expect(moved.props("hug")).toMatchObject({ width: 20, height: 20 });

  // Hiding the only flow child via a bound visibility variable shrinks to 20x20.
  const bound = open([
    page,
    {
      id: "c",
      type: "collection",
      parent: ROOT_ID,
      key: "a1",
      props: { modes: [{ id: "m1", name: "Default" }] },
    },
    {
      id: "vis",
      type: "variable",
      parent: "c",
      key: "a0",
      props: { variableType: "boolean", values: { m1: true } },
    },
    {
      id: "hug",
      type: "frame",
      parent: "page",
      key: "a0",
      props: {
        layoutMode: "row",
        sizingH: "hug",
        sizingV: "hug",
        paddingTop: 10,
        paddingRight: 10,
        paddingBottom: 10,
        paddingLeft: 10,
        width: 120,
        height: 60,
      },
    },
    {
      id: "only",
      type: "rect",
      parent: "hug",
      key: "a0",
      props: { x: 10, y: 10, width: 100, height: 40, bindings: { visible: "vis" } },
    },
  ]);
  bound.editor.setProp(["vis"], "values", { m1: false });
  expect(bound.props("hug")).toMatchObject({ width: 20, height: 20 });

  // An already-empty imported hug frame keeps its saved dimensions on relayout and unrelated edits.
  const empty = open([
    page,
    {
      id: "emptyHug",
      type: "frame",
      parent: "page",
      key: "a0",
      props: {
        layoutMode: "row",
        sizingH: "hug",
        sizingV: "hug",
        paddingTop: 10,
        paddingRight: 10,
        paddingBottom: 10,
        paddingLeft: 10,
        width: 120,
        height: 60,
      },
    },
  ]);
  expect(layoutOps(empty.editor.doc, ["emptyHug"])).toEqual([]);
  empty.editor.setProp(["emptyHug"], "fills", [{ type: "solid", color: "#ff0000" }]);
  expect(empty.props("emptyHug")).toMatchObject({ width: 120, height: 60 });

  // Explicitly switching an empty fixed-width frame to Hug measures normally (shrinks to padding).
  const fixedEmpty = open([
    page,
    {
      id: "emptyFixed",
      type: "frame",
      parent: "page",
      key: "a0",
      props: {
        layoutMode: "row",
        sizingH: "fixed",
        sizingV: "hug",
        paddingTop: 10,
        paddingRight: 10,
        paddingBottom: 10,
        paddingLeft: 10,
        width: 120,
        height: 60,
      },
    },
  ]);
  fixedEmpty.editor.setProp(["emptyFixed"], "sizingH", "hug");
  expect(fixedEmpty.props("emptyFixed")).toMatchObject({ width: 20, height: 60 });
});

it("preserves a hug copy's visible literal width across compaction when its box width binding is inactive", () => {
  const nodes: NodeRecord[] = [
    page,
    {
      id: "c",
      type: "collection",
      parent: ROOT_ID,
      key: "a1",
      props: { modes: [{ id: "m1", name: "Default" }] },
    },
    {
      id: "v40",
      type: "variable",
      parent: "c",
      key: "a0",
      props: { variableType: "number", values: { m1: 40 } },
    },
    {
      id: "main",
      type: "frame",
      parent: "page",
      key: "a0",
      props: {
        isComponent: true,
        layoutMode: "row",
        sizingH: "hug",
        width: 120,
        height: 40,
        bindings: { width: { variable: "v40", unit: "box" } },
      },
    },
    {
      id: "copy",
      type: "frame",
      parent: "page",
      key: "a1",
      props: {
        instanceOf: "main",
        layoutMode: "row",
        sizingH: "hug",
        width: 80,
        height: 40,
        bindings: { width: { variable: "v40", unit: "box" } },
      },
    },
  ];
  const materialized = open(nodes, false);
  const compact = open(nodes, true);
  expect(materialized.props("copy").width).toBe(80);
  expect(compact.props("copy").width).toBe(80);
});
