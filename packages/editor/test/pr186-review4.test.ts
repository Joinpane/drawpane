/**
 * Review 4 of #186: the blockers under the fallback rule of decision 0034
 * (a binding's stored value is its last resolved value; a path may refresh
 * it to what the binding gives, but must never silently change what a layer
 * shows, a binding the user or file set, an explicit override, or an
 * acknowledged edit). Items 3, 4 and 8 of the review are follow-ups under
 * that rule and aren't tested here.
 */
import { compactByInstance, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { runTool } from "../src/agent/tools";
import { Editor } from "../src/editor";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: NodeRecord["props"] = {},
): NodeRecord => ({ id, type, parent, key: `a${id}`, props });

const page = node("p", "page", ROOT_ID);
const collection = node("c", "collection", ROOT_ID, { modes: [{ id: "a", name: "A" }] });
const number = (id: string, value: number) =>
  node(id, "variable", "c", { variableType: "number", values: { a: value } });
const size = number("size", 40);
const percent = { variable: "size", unit: "percent" } as const;
const bounded = { variable: "size", unit: "bounded" } as const;
const setup = (nodes: NodeRecord[], copies: "compact" | "materialized" = "materialized") => {
  const editor = new Editor({ clientId: "review4", measurer: { width: () => 10 } });
  editor.doc.resetStored(nodes, copies);
  editor.state.set({ role: "editor" });
  editor.setPage("p");
  return editor;
};

function compactCopy(
  mainProps: NodeRecord["props"],
  copyProps: NodeRecord["props"],
  vars: NodeRecord[],
) {
  const nodes = [
    page,
    collection,
    ...vars,
    node("main", "frame", "p", { isComponent: true }),
    node("original", "text", "main", { characters: "Label", ...mainProps }),
    node("instance", "frame", "p", { instanceOf: "main" }),
    {
      ...node("copy", "text", "instance", {
        characters: "Label",
        mirrors: "original",
        ...copyProps,
      }),
      key: "aoriginal",
    },
  ];
  const compact = compactByInstance(nodes);
  expect(compact.detached.size).toBe(0);
  const after = setup(compact.nodes, "compact");
  const id = after.doc.childIds("instance")[0] as string;
  return { id, before: setup(nodes), after };
}

it("R1 variant: compaction retains the binding unit and fallback of an occurrence with another saved width", () => {
  const { after, id } = compactCopy(
    { width: 23, maxWidth: 32, bindings: { width: "size" } },
    { width: 24, maxWidth: 32, bindings: { width: bounded } },
    [size],
  );
  expect(after.doc.getUnresolved(id)?.props).toMatchObject({
    width: 24,
    bindings: { width: bounded },
  });
  expect(after.doc.get(id)?.props.width).toBe(32);
});

// Blocker 1.
it("R2 variant: applying a text style keeps the layer's own font-size binding and fallback", () => {
  const design = setup([
    page,
    collection,
    size,
    node("body", "textStyle", ROOT_ID, { fontSize: 14 }),
    node("label", "text", "p", {
      fontSize: 24,
      bindings: { fontSize: "size" },
      characters: "Label",
    }),
  ]);
  design.applyTextStyle(["label"], "body");
  expect(design.doc.getUnresolved("label")?.props).toMatchObject({
    textStyle: "body",
    fontSize: 24,
    bindings: { fontSize: "size" },
  });
  expect(design.doc.get("label")?.props.fontSize).toBe(40);
});

// Blocker 2.
it("R3 variant: compaction retains an occurrence fallback when a number cannot drive font size", () => {
  const { before, after, id } = compactCopy(
    { fontSize: 14, bindings: { fontSize: "size" } },
    { fontSize: 24, bindings: { fontSize: "size" } },
    [number("size", 0)],
  );
  expect(before.doc.get("copy")?.props.fontSize).toBe(24);
  expect(after.doc.getUnresolved(id)?.props.fontSize).toBe(24);
  expect(after.doc.get(id)?.props.fontSize).toBe(24);
});

it("bind_token writes the bounded unit and the new height's fallback", async () => {
  const design = setup([
    page,
    collection,
    size,
    node("box", "rect", "p", { height: 24, maxHeight: 32 }),
  ]);
  await runTool(design, "bind_token", { ids: ["box"], key: "height", variableId: "size" });
  expect(design.doc.getUnresolved("box")?.props).toMatchObject({
    height: 32,
    bindings: { height: bounded },
  });
  design.setVariableValue("size", "a", 12);
  expect(design.doc.get("box")?.props.height).toBe(12);
  expect(design.doc.getUnresolved("box")?.props.height).toBe(32);
});

describe.each(["compact", "materialized"] as const)("carrying stored values (%s)", (copies) => {
  it.each(["copy", "cut", "duplicate", "page"] as const)(
    "R4 variant: %s keeps the tagged ref through undo and redo",
    (move) => {
      const raw = { width: 24, height: 20, maxWidth: 32, bindings: { width: bounded } };
      const design = setup([page, collection, size, node("box", "rect", "p", raw)], copies);
      design.select(["box"]);
      let id: string;
      if (move === "page") {
        const newPage = design.duplicatePage("p");
        if (!newPage) throw new Error("No duplicated page");
        id = design.doc.childIds(newPage)[0] as string;
      } else {
        if (move === "duplicate") design.duplicate({ inPlace: true });
        else {
          const data = move === "cut" ? design.cut() : design.copy();
          if (!data) throw new Error("Nothing copied");
          expect(design.paste(data)).toBe(true);
        }
        id = design.state.get().selection[0] as string;
      }
      expect(id).not.toBe("box");
      expect(design.doc.getUnresolved(id)?.props).toMatchObject(raw);
      expect(design.doc.get(id)?.props.width).toBe(32);
      design.undo();
      expect(design.doc.getUnresolved(id)).toBeUndefined();
      if (move === "cut") {
        design.undo();
        expect(design.doc.getUnresolved("box")?.props).toMatchObject(raw);
        design.redo();
        expect(design.doc.getUnresolved("box")).toBeUndefined();
      }
      design.redo();
      expect(design.doc.getUnresolved(id)?.props).toMatchObject(raw);
      expect(design.doc.get(id)?.props.width).toBe(32);
    },
  );

  // Blocker 6.
  it("paste properties moves tagged style bindings and leaves existing geometry bindings through history", () => {
    const raw = { width: 24, maxWidth: 32, bindings: { width: bounded } };
    const design = setup(
      [
        page,
        collection,
        size,
        node("source", "rect", "p", { opacity: 0.2, bindings: { opacity: percent } }),
        node("target", "rect", "p", raw),
      ],
      copies,
    );
    design.select(["source"]);
    expect(design.copyProperties()).toBe(true);
    design.select(["target"]);
    expect(design.pasteProperties()).toBe(true);
    const want = { ...raw, opacity: 0.2, bindings: { width: bounded, opacity: percent } };
    expect(design.doc.getUnresolved("target")?.props).toMatchObject(want);
    design.undo();
    expect(design.doc.getUnresolved("target")?.props).toMatchObject(raw);
    design.redo();
    expect(design.doc.getUnresolved("target")?.props).toMatchObject(want);
  });

  // Blocker 7.
  it("paste properties retains an embedded paint binding when layer-level bindings do not change", () => {
    const paints = [{ type: "solid", color: "#aabbcc", bind: { color: "color" } }] as const;
    const design = setup(
      [
        page,
        collection,
        node("color", "variable", "c", { variableType: "color", values: { a: "#123456" } }),
        node("source", "rect", "p", { fills: [...paints] }),
        node("target", "rect", "p", { fills: [{ type: "solid", color: "#abcdef" }] }),
      ],
      copies,
    );
    design.select(["source"]);
    expect(design.copyProperties()).toBe(true);
    design.select(["target"]);
    expect(design.pasteProperties()).toBe(true);
    expect(design.doc.getUnresolved("target")?.props.fills).toEqual(paints);
  });
});

// Item 9's exception: a measured size written into a still-bound width.
it.each(["compact", "materialized"] as const)(
  "duplicating auto-sized text preserves the saved fallback of its bound width (%s)",
  (copies) => {
    const raw = { width: 24, height: 20, bindings: { width: bounded } };
    const design = setup(
      [
        page,
        collection,
        size,
        node("label", "text", "p", { ...raw, characters: "Sample", textAutoResize: "width" }),
      ],
      copies,
    );
    expect(design.doc.get("label")?.props.width).toBe(40);
    design.select(["label"]);
    design.duplicate({ inPlace: true });
    const id = design.state.get().selection[0] as string;
    expect(id).not.toBe("label");
    expect(design.doc.getUnresolved(id)?.props).toMatchObject({
      width: 24,
      bindings: { width: bounded },
    });
  },
);
