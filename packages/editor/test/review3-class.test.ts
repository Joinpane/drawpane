/**
 * The class behind review 3's findings, beyond its five reproductions
 * (pr186-review3.test.ts): every path that moves or compares a bound value
 * keeps the value, its binding (with its unit) and the fallback a binding
 * can't be followed without as one (decision 0034). A resolved value is what
 * the layer shows, never what it saves.
 */
import { compactByInstance, getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: NodeRecord["props"] = {},
): NodeRecord => ({ id, type, parent, key: `a${id}`, props });

function editor(nodes: NodeRecord[], copies: "compact" | "materialized" = "materialized") {
  const result = new Editor({ clientId: "review3-class", measurer: { width: () => 10 } });
  result.doc.resetStored(nodes, copies);
  result.state.set({ role: "editor" });
  result.setPage("p");
  return result;
}

const file = (extra: NodeRecord[]) => [
  node("p", "page", ROOT_ID),
  node("c", "collection", ROOT_ID, { modes: [{ id: "a", name: "A" }] }),
  node("small", "variable", "c", { variableType: "number", values: { a: 10 } }),
  node("half", "variable", "c", { variableType: "number", values: { a: 0.5 } }),
  ...extra,
];

/** A width bound to a variable of 10 whose saved value (its fallback) is 40. */
const boundBox = () =>
  node("r", "rect", "p", { width: 40, height: 20, bindings: { width: "small" } });

describe.each(["materialized", "compact"] as const)("moving a bound layer (%s)", (copies) => {
  it("duplicating keeps its saved value, not what its binding gives", () => {
    const design = editor(file([boundBox()]), copies);
    design.select(["r"]);
    design.duplicate({ inPlace: true });
    const id = design.state.get().selection[0] as string;
    expect(id).not.toBe("r");
    expect(design.doc.get(id)?.props.width).toBe(10);
    expect(design.doc.getUnresolved(id)?.props.width).toBe(40);
    expect(design.doc.getUnresolved(id)?.props.bindings).toEqual({ width: "small" });
  });

  it("copy and paste keep its saved value", () => {
    const design = editor(file([boundBox()]), copies);
    design.select(["r"]);
    const clipboard = design.copy();
    if (!clipboard) throw new Error("nothing copied");
    expect(design.paste(clipboard)).toBe(true);
    const id = design.state.get().selection[0] as string;
    expect(design.doc.get(id)?.props.width).toBe(10);
    expect(design.doc.getUnresolved(id)?.props.width).toBe(40);
  });

  it("paste properties carries the saved opacity with its legacy binding", () => {
    const design = editor(
      file([
        node("r", "rect", "p", { opacity: 0.25, bindings: { opacity: "half" } }),
        node("o", "rect", "p", {}),
      ]),
      copies,
    );
    design.select(["r"]);
    expect(design.copyProperties()).toBe(true);
    design.select(["o"]);
    expect(design.pasteProperties()).toBe(true);
    expect(design.doc.getUnresolved("o")?.props.opacity).toBe(0.25);
    expect(design.doc.getUnresolved("o")?.props.bindings).toEqual({ opacity: "half" });
    expect(design.doc.get("o")?.props.opacity).toBe(0.5);
  });
});

describe("text styles", () => {
  it("a pasted styled text keeps its own tracking binding's unit", () => {
    const design = editor(
      file([
        node("style", "textStyle", ROOT_ID, {
          name: "Body",
          letterSpacing: { unit: "px", value: 2 },
        }),
      ]),
    );
    const clipboard = JSON.stringify({
      format: "drawpane/nodes",
      nodes: [
        node("t", "text", "", {
          characters: "Label",
          fontSize: 20,
          letterSpacing: { unit: "percent", value: 5 },
          bindings: { letterSpacing: "small" },
          textStyle: "style",
        }),
      ],
    });
    expect(design.paste(clipboard)).toBe(true);
    const id = design.state.get().selection[0] as string;
    expect(design.doc.getUnresolved(id)?.props.letterSpacing).toEqual({
      unit: "percent",
      value: 5,
    });
    expect(design.doc.get(id)?.props.letterSpacing).toEqual({ unit: "percent", value: 10 });
  });
});

describe("compacting copies", () => {
  const instance = (main: NodeRecord["props"], copy: NodeRecord["props"]) => [
    ...file([]),
    node("main", "frame", "p", { isComponent: true }),
    node("original", "text", "main", { characters: "a", ...main }),
    node("instance", "frame", "p", { instanceOf: "main" }),
    {
      ...node("copy", "text", "instance", { characters: "a", mirrors: "original", ...copy }),
      key: "aoriginal",
    },
  ];

  it("keeps a copy's tracking unit where it differs from its main's under the same binding", () => {
    const nodes = instance(
      { letterSpacing: { unit: "px", value: 10 }, bindings: { letterSpacing: "small" } },
      { letterSpacing: { unit: "percent", value: 10 }, bindings: { letterSpacing: "small" } },
    );
    const compact = compactByInstance(nodes);
    expect(compact.detached.size).toBe(0);
    const after = editor(compact.nodes, "compact");
    const id = compact.ids.get("copy") as string;
    after.doc.childIds("instance");
    expect(after.doc.get(id)?.props.letterSpacing).toEqual({ unit: "percent", value: 10 });
  });

  // A guard (passes before the fix too): stricter comparison mustn't keep what a binding gives.
  it("still takes a copy's value as its main's where a followed binding gives both", () => {
    const nodes = instance(
      { opacity: 0.5, bindings: { opacity: "half" } },
      { opacity: 0.4, bindings: { opacity: "half" } },
    );
    const compact = compactByInstance(nodes);
    const after = editor(compact.nodes, "compact");
    const id = compact.ids.get("copy") as string;
    after.doc.childIds("instance");
    expect(after.doc.get(id)?.props.opacity).toBe(0.5);
    // Nothing of the copy's own is stored: it follows its main.
    const own = compact.nodes.filter((n) => n.type === "override" && n.parent === "instance");
    expect(own.every((n) => getProp(n.props, "opacity") === 1)).toBe(true);
  });
});
