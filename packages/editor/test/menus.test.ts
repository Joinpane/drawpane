import { getProp, type Op, type Props, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = { width: (_font, text) => text.length * 8 };

function setup(
  nodes: Array<
    Props & { id: string; type?: "rect" | "frame" | "text" | "ellipse" | "group"; parent?: string }
  >,
) {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    ...nodes.map(
      ({ id, type, parent, ...props }, i): Op => ({
        op: "create",
        id,
        type: type ?? "rect",
        parent: parent ?? "p",
        key: `a${i}`,
        props,
      }),
    ),
  ]);
  editor.setPage("p");
  const box = (id: string) => {
    const n = editor.doc.get(id);
    return [
      getProp(n?.props ?? {}, "x"),
      getProp(n?.props ?? {}, "y"),
      getProp(n?.props ?? {}, "width"),
      getProp(n?.props ?? {}, "height"),
    ];
  };
  return { editor, box };
}

describe("copy and paste properties", () => {
  it("copies a layer's style onto others, skipping what they can't have", () => {
    const { editor } = setup([
      {
        id: "styled",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        fills: [{ type: "solid", color: "#ff5a1f" }],
        cornerRadius: 8,
        opacity: 0.5,
        effects: [{ type: "layer-blur", radius: 4 }],
      },
      { id: "plain", type: "ellipse", x: 50, y: 0, width: 20, height: 20 },
      { id: "label", type: "text", x: 0, y: 50, characters: "Hi", fontSize: 24 },
    ]);
    editor.select(["styled"]);
    expect(editor.copyProperties()).toBe(true);
    editor.select(["plain", "label"]);
    expect(editor.pasteProperties()).toBe(true);
    const plain = editor.doc.get("plain")?.props ?? {};
    expect(plain).toMatchObject({ fills: [{ type: "solid", color: "#ff5a1f" }], opacity: 0.5 });
    // Ellipses have no corners; text keeps its own size (a rectangle has no text style).
    expect(plain.cornerRadius).toBeUndefined();
    expect(getProp(editor.doc.get("label")?.props ?? {}, "fontSize")).toBe(24);
    // One undo step for everything.
    editor.undo();
    expect(editor.doc.get("plain")?.props.fills).toBeUndefined();
    expect(editor.doc.get("label")?.props.opacity).toBeUndefined();
  });

  it("resets properties the source leaves at their default", () => {
    const { editor } = setup([
      { id: "a", width: 10, height: 10 },
      { id: "b", width: 10, height: 10, opacity: 0.3, cornerRadius: 4 },
    ]);
    editor.select(["a"]);
    editor.copyProperties();
    editor.select(["b"]);
    editor.pasteProperties();
    expect(editor.doc.get("b")?.props.opacity).toBeUndefined();
    expect(editor.doc.get("b")?.props.cornerRadius).toBeUndefined();
  });
});

describe("paste here", () => {
  it("centres pasted layers on the point, inside the frame there", () => {
    const { editor, box } = setup([
      { id: "frame", type: "frame", x: 100, y: 100, width: 400, height: 400 },
      { id: "dot", x: 0, y: 0, width: 20, height: 10 },
    ]);
    editor.select(["dot"]);
    const data = editor.copy() as string;
    expect(editor.paste(data, { at: { x: 300, y: 200 } })).toBe(true);
    const pasted = editor.s.selection[0] as string;
    expect(editor.doc.get(pasted)?.parent).toBe("frame");
    // Frame-local: page (290, 195) minus the frame's origin.
    expect(box(pasted)).toEqual([190, 95, 20, 10]);
    editor.undo();
    expect(editor.doc.has(pasted)).toBe(false);
  });
});

describe("layers at a point", () => {
  it("lists every layer under the pointer, deepest and topmost first", () => {
    const { editor } = setup([
      { id: "frame", type: "frame", x: 0, y: 0, width: 200, height: 200 },
      { id: "back", parent: "frame", x: 10, y: 10, width: 100, height: 100 },
      { id: "g", type: "group", parent: "frame" },
      { id: "front", parent: "g", x: 20, y: 20, width: 50, height: 50 },
      { id: "elsewhere", parent: "frame", x: 150, y: 150, width: 20, height: 20 },
    ]);
    expect(editor.layersAt({ x: 30, y: 30 })).toEqual(["front", "g", "back", "frame"]);
  });
});

describe("tidy up", () => {
  it("evens out a rough row", () => {
    const { editor, box } = setup([
      { id: "a", x: 0, y: 0, width: 40, height: 20 },
      { id: "b", x: 50, y: 6, width: 40, height: 20 },
      { id: "c", x: 110, y: -4, width: 40, height: 20 },
    ]);
    editor.select(["a", "b", "c"]);
    editor.tidyUp();
    // Gaps of 10 and 20 average to 15; tops line up with the highest layer.
    expect(box("a")).toEqual([0, -4, 40, 20]);
    expect(box("b")).toEqual([55, -4, 40, 20]);
    expect(box("c")).toEqual([110, -4, 40, 20]);
  });

  it("snaps a rough grid into rows and columns of equal cells", () => {
    const { editor, box } = setup([
      { id: "a", x: 0, y: 0, width: 50, height: 50 },
      { id: "b", x: 62, y: 3, width: 50, height: 40 },
      { id: "c", x: 2, y: 58, width: 40, height: 50 },
      { id: "d", x: 58, y: 62, width: 50, height: 50 },
    ]);
    editor.select(["a", "b", "c", "d"]);
    editor.tidyUp();
    // Cells are 50×50; gaps average 14 across (12, 16) and 8 down.
    expect(box("a").slice(0, 2)).toEqual([0, 0]);
    expect(box("b").slice(0, 2)).toEqual([64, 0]);
    expect(box("c").slice(0, 2)).toEqual([0, 58]);
    expect(box("d").slice(0, 2)).toEqual([64, 58]);
  });
});

describe("pages", () => {
  it("duplicates a page with everything on it and opens the copy", () => {
    const { editor } = setup([
      { id: "card", type: "frame", x: 0, y: 0, width: 100, height: 100, name: "Card" },
      { id: "dot", parent: "card", x: 10, y: 10, width: 5, height: 5 },
    ]);
    editor.commit([{ op: "set", id: "p", prop: "name", value: "Home" }]);
    const copy = editor.duplicatePage("p") as string;
    expect(editor.doc.pageIds()).toEqual(["p", copy]);
    expect(editor.doc.get(copy)?.props.name).toBe("Home copy");
    expect(editor.s.pageId).toBe(copy);
    const [frame] = editor.doc.childIds(copy);
    expect(editor.doc.get(frame as string)?.props.name).toBe("Card");
    expect(editor.doc.childIds(frame as string)).toHaveLength(1);
    editor.undo();
    expect(editor.doc.pageIds()).toEqual(["p"]);
  });
});
