/**
 * Edits that once left stale layout behind (PR 266's review): each ends
 * where a full layout of the document would, and stays there through a
 * reload, undo and redo.
 */
import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { layoutOps } from "../src/layout";

const measurer = { width: (_font: string, text: string) => text.length * 7 };

function make(nodes: NodeRecord[], copies: "compact" | "materialized" = "materialized") {
  const editor = new Editor({ measurer, clientId: "cases" });
  editor.doc.resetStored(nodes, copies);
  editor.state.set({ role: "editor" });
  editor.setPage("p");
  return editor;
}

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: NodeRecord["props"] = {},
  key = "a0",
): NodeRecord => ({ id, type, parent, key, props });
const page = node("p", "page", ROOT_ID);
const row = { layoutMode: "row", sizingH: "hug", sizingV: "hug", width: 30, height: 10 } as const;
const modes = node(
  "c",
  "collection",
  ROOT_ID,
  {
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ],
  },
  "a1",
);
const prop = (editor: Editor, id: string, name: "x" | "width" | "visible" | "paddingLeft") =>
  getProp(editor.doc.get(id)?.props ?? {}, name);
/** What laying out the whole document afresh would still change. */
const unsettled = (editor: Editor) => {
  const frames: string[] = [];
  const walk = (id: string) => {
    for (const child of editor.doc.childIds(id)) {
      if (editor.doc.get(child)?.type === "frame") frames.push(child);
      walk(child);
    }
  };
  walk("p");
  return layoutOps(editor.doc, frames);
};

describe("edits that leave layout as a full layout would", () => {
  it("lays out the flow around a group whose absolute member was nudged", () => {
    const editor = make([
      page,
      node("frame", "frame", "p", row),
      node("group", "group", "frame"),
      node("first", "rect", "group", { width: 10, height: 10, positioning: "absolute" }),
      node("second", "rect", "group", { x: 10, width: 10, height: 10 }, "a1"),
      node("next", "rect", "frame", { x: 20, width: 10, height: 10 }, "a1"),
    ]);
    editor.select(["first"]);
    editor.nudge(-10, 0);
    expect(prop(editor, "frame", "width")).toBe(40);
    expect(prop(editor, "next", "x")).toBe(30);
    expect(unsettled(editor)).toEqual([]);
  });

  it("lays out inside an auto layout frame a constraint resized", () => {
    const editor = make([
      page,
      node("outer", "frame", "p", { width: 100, height: 60 }),
      node("inner", "frame", "outer", {
        x: 10,
        y: 10,
        width: 80,
        height: 20,
        layoutMode: "row",
        constraintH: "stretch",
      }),
      node("bar", "rect", "inner", { width: 80, height: 10, sizingH: "fill" }),
    ]);
    editor.resize(["outer"], "width", 140);
    expect(prop(editor, "inner", "width")).toBe(120);
    expect(prop(editor, "bar", "width")).toBe(120);
    expect(unsettled(editor)).toEqual([]);
  });

  it("makes room when binding visibility hides a layer", () => {
    const editor = make([
      page,
      modes,
      node("v", "variable", "c", {
        variableType: "boolean",
        values: { light: true, dark: false },
      }),
      node("frame", "frame", "p", row),
      node("first", "rect", "frame", { width: 20, height: 10 }),
      node("next", "rect", "frame", { x: 20, width: 10, height: 10 }, "a1"),
    ]);
    editor.setVariableMode("frame", "c", "dark");
    expect(
      editor.commit([{ op: "set", id: "first", prop: "bindings", value: { visible: "v" } }]),
    ).toBe(true);
    expect(prop(editor, "first", "visible")).toBe(false);
    expect(prop(editor, "frame", "width")).toBe(10);
    expect(prop(editor, "next", "x")).toBe(0);
    expect(unsettled(editor)).toEqual([]);
  });

  it("makes room when rebinding visibility to a variable that shows the layer", () => {
    const editor = make([
      page,
      modes,
      node("old", "variable", "c", {
        variableType: "boolean",
        values: { light: true, dark: true },
      }),
      node(
        "new",
        "variable",
        "c",
        { variableType: "boolean", values: { light: true, dark: true } },
        "a1",
      ),
      node("frame", "frame", "p", row),
      node("first", "rect", "frame", {
        visible: true,
        width: 20,
        height: 10,
        bindings: { visible: "old" },
      }),
      node("next", "rect", "frame", { x: 20, width: 10, height: 10 }, "a1"),
    ]);
    editor.setVariableValue("old", "light", false);
    expect(prop(editor, "frame", "width")).toBe(10);
    editor.bindVariable(["first"], "visible", "new");
    const shown = () => [
      prop(editor, "first", "visible"),
      prop(editor, "frame", "width"),
      prop(editor, "next", "x"),
    ];
    expect(shown()).toEqual([true, 30, 20]);
    expect(unsettled(editor)).toEqual([]);
    // Read back from what's stored, and through undo and redo.
    const reopened = make(editor.doc.stored());
    expect([prop(reopened, "frame", "width"), prop(reopened, "next", "x")]).toEqual([30, 20]);
    editor.undo();
    expect(shown()).toEqual([false, 10, 0]);
    editor.redo();
    expect(shown()).toEqual([true, 30, 20]);
  });

  it("shrinks a copy whose last layer a mode change in its main hides through the copy's own binding", () => {
    const editor = make(
      [
        page,
        modes,
        node("v", "variable", "c", {
          variableType: "boolean",
          values: { light: true, dark: false },
        }),
        node("main", "frame", "p", { isComponent: true, width: 100, height: 100 }),
        node("frame", "frame", "main", { ...row, width: 20, paddingLeft: 3, paddingRight: 3 }),
        node("first", "rect", "frame", { x: 3, width: 14, height: 10 }),
        node("instance", "frame", "p", { instanceOf: "main" }, "a1"),
      ],
      "compact",
    );
    const frame = editor.doc.childIds("instance")[0] as string;
    const first = editor.doc.childIds(frame)[0] as string;
    editor.bindVariable([first], "visible", "v");
    expect(prop(editor, frame, "width")).toBe(20);
    editor.setVariableMode("frame", "c", "dark");
    expect(prop(editor, first, "visible")).toBe(false);
    expect(prop(editor, frame, "width")).toBe(6);
    expect(prop(editor, "frame", "width")).toBe(20);
    expect(unsettled(editor)).toEqual([]);
  });

  it("lays out a swapped instance's layers in the mode they're shown in, through undo and redo", () => {
    const editor = make(
      [
        page,
        modes,
        node("v", "variable", "c", { variableType: "number", values: { light: 8, dark: 16 } }),
        node("old-main", "frame", "p", {
          isComponent: true,
          layoutMode: "row",
          width: 100,
          height: 30,
        }),
        node(
          "new-main",
          "frame",
          "p",
          { isComponent: true, layoutMode: "row", width: 100, height: 30 },
          "a1",
        ),
        node("inner", "frame", "new-main", {
          layoutMode: "row",
          width: 100,
          height: 30,
          paddingLeft: 8,
          bindings: { paddingLeft: "v" },
        }),
        node("dot", "rect", "inner", { x: 8, width: 10, height: 10 }),
        node(
          "dark",
          "frame",
          "p",
          { variableModes: { c: "dark" }, x: 200, width: 200, height: 200 },
          "a2",
        ),
        node("instance", "frame", "dark", { instanceOf: "old-main" }),
      ],
      "compact",
    );
    const dot = () => {
      const inner = editor.doc.childIds("instance")[0] as string;
      return [
        prop(editor, inner, "paddingLeft"),
        prop(editor, editor.doc.childIds(inner)[0] as string, "x"),
      ];
    };
    editor.swapInstance("instance", "new-main");
    expect(dot()).toEqual([16, 16]);
    expect(unsettled(editor)).toEqual([]);
    editor.undo();
    expect(getProp(editor.doc.get("instance")?.props ?? {}, "instanceOf")).toBe("old-main");
    editor.redo();
    expect(dot()).toEqual([16, 16]);
    expect(unsettled(editor)).toEqual([]);
  });

  // The swapped-in layers' auto layout frame sits under a plain frame: the instance's root
  // itself, or a frame between it and an auto layout root (PR 266's re-check).
  it.each([
    ["is the instance's root", false],
    ["sits between auto layout frames", true],
  ])("lays out a swapped instance's auto layout under a plain frame that %s", (_shape, between) => {
    const flow = between ? ({ layoutMode: "row" } as const) : {};
    const editor = make(
      [
        page,
        modes,
        node("v", "variable", "c", { variableType: "number", values: { light: 8, dark: 16 } }),
        node("old-main", "frame", "p", { isComponent: true, width: 100, height: 30, ...flow }),
        node(
          "new-main",
          "frame",
          "p",
          { isComponent: true, width: 100, height: 30, ...flow },
          "a1",
        ),
        ...(between ? [node("plain", "frame", "new-main", { width: 100, height: 30 })] : []),
        node("inner", "frame", between ? "plain" : "new-main", {
          layoutMode: "row",
          width: 100,
          height: 30,
          paddingLeft: 8,
          bindings: { paddingLeft: "v" },
        }),
        node("dot", "rect", "inner", { x: 8, width: 10, height: 10 }),
        node(
          "dark",
          "frame",
          "p",
          { variableModes: { c: "dark" }, x: 200, width: 200, height: 200 },
          "a2",
        ),
        node("instance", "frame", "dark", { instanceOf: "old-main" }),
      ],
      "compact",
    );
    const dot = () => {
      let inner = editor.doc.childIds("instance")[0] as string;
      if (between) inner = editor.doc.childIds(inner)[0] as string;
      return [
        prop(editor, inner, "paddingLeft"),
        prop(editor, editor.doc.childIds(inner)[0] as string, "x"),
      ];
    };
    expect(unsettled(editor)).toEqual([]);
    editor.swapInstance("instance", "new-main");
    expect(dot()).toEqual([16, 16]);
    expect(unsettled(editor)).toEqual([]);
    editor.undo();
    editor.redo();
    expect(dot()).toEqual([16, 16]);
    expect(unsettled(editor)).toEqual([]);
  });

  // Binding a main's layer to another variable that resolves as before in the main's mode
  // writes nothing but the binding, yet its copies in another mode read a new value.
  it.each([
    ["binding", "an unbound padding", false],
    ["rebinding", "a bound padding", true],
  ])("lays out a copy in another mode after %s %s in its main", (_verb, _what, bound) => {
    const editor = make(
      [
        page,
        modes,
        node("pad", "variable", "c", { variableType: "number", values: { light: 8, dark: 16 } }),
        node(
          "wide",
          "variable",
          "c",
          { variableType: "number", values: { light: 8, dark: 24 } },
          "a1",
        ),
        node("main", "frame", "p", {
          isComponent: true,
          layoutMode: "row",
          width: 100,
          height: 30,
        }),
        node("inner", "frame", "main", {
          layoutMode: "row",
          width: 100,
          height: 30,
          paddingLeft: 8,
          ...(bound ? { bindings: { paddingLeft: "pad" } } : {}),
        }),
        node("dot", "rect", "inner", { x: 8, width: 10, height: 10 }),
        node(
          "dark",
          "frame",
          "p",
          { variableModes: { c: "dark" }, x: 200, width: 200, height: 200 },
          "a2",
        ),
      ],
      "compact",
    );
    // Placed through the editor, so the copy is laid out in Dark as it's shown.
    const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
    expect(editor.commit([{ op: "move", id: instance, parent: "dark", key: "a0" }])).toBe(true);
    const inner = editor.doc.childIds(instance)[0] as string;
    const dot = editor.doc.childIds(inner)[0] as string;
    const shown = () => [prop(editor, inner, "paddingLeft"), prop(editor, dot, "x")];
    expect(shown()).toEqual(bound ? [16, 16] : [8, 8]);
    expect(unsettled(editor)).toEqual([]);
    editor.bindVariable(["inner"], "paddingLeft", "wide");
    expect([prop(editor, "inner", "paddingLeft"), prop(editor, "dot", "x")]).toEqual([8, 8]);
    expect(shown()).toEqual([24, 24]);
    expect(unsettled(editor)).toEqual([]);
    const reopened = make(editor.doc.stored(), "compact");
    expect([prop(reopened, inner, "paddingLeft"), prop(reopened, dot, "x")]).toEqual([24, 24]);
    editor.undo();
    expect(shown()).toEqual(bound ? [16, 16] : [8, 8]);
    editor.redo();
    expect(shown()).toEqual([24, 24]);
  });

  // A main set to a mode passes it to its instances; materialized ones are written it in a
  // later round of the commit, and what then reads other values is laid out too.
  it.each(["materialized", "compact"] as const)(
    "lays out an instance in another mode when its main is set to one (copies %s)",
    (copies) => {
      const editor = make(
        [
          page,
          modes,
          node("pad", "variable", "c", { variableType: "number", values: { light: 4, dark: 12 } }),
          node("main", "frame", "p", {
            isComponent: true,
            layoutMode: "row",
            width: 100,
            height: 30,
          }),
          node("inner", "frame", "main", {
            layoutMode: "row",
            width: 100,
            height: 30,
            paddingLeft: 4,
            bindings: { paddingLeft: "pad" },
          }),
          node("dot", "rect", "inner", { x: 4, width: 10, height: 10 }),
          node(
            "dark",
            "frame",
            "p",
            { variableModes: { c: "dark" }, x: 200, width: 200, height: 200 },
            "a2",
          ),
        ],
        copies,
      );
      const instance = editor.insertInstance("main", { x: 0, y: 300 }) as string;
      expect(editor.commit([{ op: "move", id: instance, parent: "dark", key: "a0" }])).toBe(true);
      const inner = editor.doc.childIds(instance)[0] as string;
      const dot = editor.doc.childIds(inner)[0] as string;
      const shown = () => [prop(editor, inner, "paddingLeft"), prop(editor, dot, "x")];
      expect(shown()).toEqual([12, 12]);
      editor.setVariableModes(["main"], "c", "light");
      expect(shown()).toEqual([4, 4]);
      expect(unsettled(editor)).toEqual([]);
      editor.undo();
      expect(shown()).toEqual([12, 12]);
      editor.redo();
      expect(shown()).toEqual([4, 4]);
    },
  );
});
