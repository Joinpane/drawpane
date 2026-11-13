import { getProp, type Op, type Props, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { constrainSpan } from "../src/constraints";
import { Editor } from "../src/editor";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = { width: (_font, text) => text.length * 8 };

/** A 200×100 frame with the given children (rects unless `type` says otherwise). */
function setup(
  children: Array<Props & { id: string; type?: "rect" | "frame" | "group"; parent?: string }>,
  frame: Props = {},
) {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    {
      op: "create",
      id: "f",
      type: "frame",
      parent: "p",
      key: "a0",
      props: { width: 200, height: 100, ...frame },
    },
    ...children.map(
      ({ id, type, parent, ...props }, i): Op => ({
        op: "create",
        id,
        type: type ?? "rect",
        parent: parent ?? "f",
        key: `a${i}`,
        props,
      }),
    ),
  ]);
  editor.setPage("p");
  const box = (id: string) => {
    const n = editor.doc.get(id);
    if (!n) throw new Error(id);
    return [
      getProp(n.props, "x"),
      getProp(n.props, "y"),
      getProp(n.props, "width"),
      getProp(n.props, "height"),
    ];
  };
  const resize = (width: number, height: number, options = {}) =>
    editor.commit(
      [
        { op: "set", id: "f", prop: "width", value: width },
        { op: "set", id: "f", prop: "height", value: height },
      ],
      "Resize",
      options,
    );
  return { editor, box, resize };
}

const child = { x: 20, y: 10, width: 40, height: 30 };

describe("constrainSpan", () => {
  it.each([
    ["start", { pos: 20, size: 40 }],
    ["end", { pos: 70, size: 40 }],
    ["center", { pos: 45, size: 40 }],
    ["stretch", { pos: 20, size: 90 }],
    ["scale", { pos: 25, size: 50 }],
  ] as const)("%s keeps the right relationship when 200 grows to 250", (c, expected) => {
    expect(constrainSpan(c, 20, 40, 200, 250)).toEqual(expected);
  });

  it("never stretches below zero and never scales from zero", () => {
    expect(constrainSpan("stretch", 20, 40, 200, 100).size).toBe(0);
    expect(constrainSpan("scale", 20, 40, 0, 100)).toEqual({ pos: 20, size: 40 });
  });
});

describe("constraints when a frame is resized", () => {
  it("leaves start-pinned layers alone", () => {
    const { box, resize } = setup([{ id: "a", ...child }]);
    resize(300, 200);
    expect(box("a")).toEqual([20, 10, 40, 30]);
  });

  it("pins to the end, centre, both edges or scales, per axis", () => {
    const { box, resize } = setup([
      { id: "end", ...child, constraintH: "end", constraintV: "end" },
      { id: "center", ...child, constraintH: "center", constraintV: "center" },
      { id: "stretch", ...child, constraintH: "stretch", constraintV: "stretch" },
      { id: "scale", ...child, constraintH: "scale", constraintV: "scale" },
    ]);
    resize(300, 200);
    expect(box("end")).toEqual([120, 110, 40, 30]);
    expect(box("center")).toEqual([70, 60, 40, 30]);
    expect(box("stretch")).toEqual([20, 10, 140, 130]);
    expect(box("scale")).toEqual([30, 20, 60, 60]);
  });

  it("is one undo step with the frame", () => {
    const { editor, box, resize } = setup([{ id: "a", ...child, constraintH: "stretch" }]);
    resize(300, 100);
    expect(box("a")).toEqual([20, 10, 140, 30]);
    editor.undo();
    expect(box("f")).toEqual([0, 0, 200, 100]);
    expect(box("a")).toEqual([20, 10, 40, 30]);
    editor.redo();
    expect(box("a")).toEqual([20, 10, 140, 30]);
  });

  it("can be skipped, as when ⌘ is held", () => {
    const { box, resize } = setup([{ id: "a", ...child, constraintH: "end" }]);
    resize(300, 100, { constraints: false });
    expect(box("a")).toEqual([20, 10, 40, 30]);
  });

  it("moves a group's members together and scales them when stretched", () => {
    const { box, resize } = setup([
      { id: "g", type: "group", constraintH: "end" },
      { id: "g1", parent: "g", x: 10, y: 0, width: 20, height: 10 },
      { id: "g2", parent: "g", x: 40, y: 0, width: 20, height: 10 },
      { id: "s", type: "group", constraintH: "stretch" },
      { id: "s1", parent: "s", x: 10, y: 50, width: 40, height: 10 },
      { id: "s2", parent: "s", x: 50, y: 50, width: 40, height: 10 },
    ]);
    resize(280, 100);
    expect(box("g1")).toEqual([90, 0, 20, 10]);
    expect(box("g2")).toEqual([120, 0, 20, 10]);
    // 80 wide grows by 80 to 160: everything inside doubles from the group's left edge.
    expect(box("s1")).toEqual([10, 50, 80, 10]);
    expect(box("s2")).toEqual([90, 50, 80, 10]);
  });

  it("passes a nested frame's new size on to its own children", () => {
    const { box, resize } = setup([
      { id: "inner", type: "frame", x: 0, y: 0, width: 200, height: 50, constraintH: "stretch" },
      { id: "badge", parent: "inner", x: 170, y: 10, width: 20, height: 20, constraintH: "end" },
    ]);
    resize(260, 100);
    expect(box("inner")).toEqual([0, 0, 260, 50]);
    expect(box("badge")).toEqual([230, 10, 20, 20]);
  });

  it("leaves auto layout children to the layout, but constrains absolute ones", () => {
    const { box, resize } = setup(
      [
        { id: "flow", width: 40, height: 20, constraintH: "end" },
        { id: "pinned", ...child, positioning: "absolute", constraintH: "end" },
      ],
      { layoutMode: "row" },
    );
    resize(300, 100);
    expect(box("flow")[0]).toBe(0);
    expect(box("pinned")[0]).toBe(120);
  });

  it("keeps what the same edit says about a child it also moves", () => {
    const { editor, box } = setup([{ id: "a", ...child, constraintH: "end" }]);
    editor.commit([
      { op: "set", id: "f", prop: "width", value: 300 },
      { op: "set", id: "a", prop: "x", value: 5 },
    ]);
    expect(box("a")[0]).toBe(5);
  });
});

describe("arranging", () => {
  function rects(...boxes: Array<[number, number, number, number]>) {
    const { editor, box } = setup(
      boxes.map(([x, y, width, height], i) => ({ id: `r${i}`, x, y, width, height })),
      { width: 1000, height: 1000 },
    );
    editor.select(boxes.map((_, i) => `r${i}`));
    return { editor, box };
  }

  it("distributes spacing evenly between the outermost layers", () => {
    const { editor, box } = rects([0, 0, 10, 10], [15, 50, 30, 10], [100, 0, 20, 10]);
    editor.distribute("horizontal");
    // Span 120, sizes 60: two gaps of 30.
    expect(box("r1")).toEqual([40, 50, 30, 10]);
    expect(box("r0")[0]).toBe(0);
    expect(box("r2")[0]).toBe(100);
    editor.undo();
    expect(box("r1")[0]).toBe(15);
  });

  it("needs three layers to distribute", () => {
    const { editor, box } = rects([0, 0, 10, 10], [50, 0, 10, 10]);
    editor.distribute("vertical");
    expect(box("r1")).toEqual([50, 0, 10, 10]);
    expect(editor.s.canUndo).toBe(false);
  });

  it("flips several layers as one picture", () => {
    const { editor, box } = rects([0, 0, 10, 10], [90, 0, 10, 10]);
    editor.state.set({ selection: ["r0"] });
    editor.flip("horizontal");
    expect(getProp(editor.doc.get("r0")?.props ?? {}, "flipX")).toBe(true);
    expect(box("r0")[0]).toBe(0);
    editor.select(["r0", "r1"]);
    editor.flip("vertical");
    expect(getProp(editor.doc.get("r1")?.props ?? {}, "flipY")).toBe(true);
    editor.select(["r0", "r1"]);
    editor.commit([{ op: "set", id: "r1", prop: "y", value: 40 }]);
    editor.flip("vertical");
    // Bounds y 0–50: r0 (0–10) and r1 (40–50) swap places.
    expect(box("r0")[1]).toBe(40);
    expect(box("r1")[1]).toBe(0);
  });

  it("mirrors rotation when flipping", () => {
    const { editor } = rects([0, 0, 40, 10]);
    editor.commit([{ op: "set", id: "r0", prop: "rotation", value: 30 }]);
    editor.flip("horizontal");
    expect(getProp(editor.doc.get("r0")?.props ?? {}, "rotation")).toBe(-30);
  });

  it("keeps proportions for layers with a locked aspect ratio", () => {
    const { editor, box } = rects([0, 0, 200, 100]);
    editor.commit([{ op: "set", id: "r0", prop: "lockAspect", value: true }]);
    editor.resize(["r0"], "width", 100);
    expect(box("r0")).toEqual([0, 0, 100, 50]);
    editor.commit([{ op: "set", id: "r0", prop: "lockAspect", value: false }]);
    editor.resize(["r0"], "height", 80);
    expect(box("r0")).toEqual([0, 0, 100, 80]);
  });
});

describe("frame presets", () => {
  it("adds a named frame in view, beside existing work, and selects it", async () => {
    const { FRAME_PRESETS, matchFramePreset } = await import("../src/presets");
    const { editor, box } = setup([]);
    editor.state.set({ viewport: { width: 400, height: 200 } });
    const phone = FRAME_PRESETS[0]?.presets[1];
    expect(phone?.name).toBe("iPhone 18 Pro");
    const id = editor.insertFramePreset(phone as never) as string;
    // The 200×100 frame sits at the view's centre already: the phone goes to its right.
    expect(box(id)).toEqual([300, 0, 402, 874]);
    expect(getProp(editor.doc.get(id)?.props ?? {}, "name")).toBe("iPhone 18 Pro");
    expect(editor.s.selection).toEqual([id]);
    expect(editor.s.tool).toBe("select");
    expect(matchFramePreset(874, 402)?.name).toBe("iPhone 18 Pro");
    expect(matchFramePreset(401, 874)).toBeUndefined();
  });
});

describe("resize to fit", () => {
  it("wraps a frame around its content without moving anything on the canvas", () => {
    const { editor, box } = setup([
      { id: "a", x: 20, y: 30, width: 40, height: 10 },
      { id: "b", x: 100, y: 50, width: 20, height: 20 },
    ]);
    editor.commit([
      { op: "set", id: "f", prop: "x", value: 500 },
      { op: "set", id: "f", prop: "y", value: 100 },
    ]);
    editor.fitToContent(["f"]);
    expect(box("f")).toEqual([520, 130, 100, 40]);
    expect(box("a")).toEqual([0, 0, 40, 10]);
    expect(box("b")).toEqual([80, 20, 20, 20]);
    editor.undo();
    expect(box("f")).toEqual([500, 100, 200, 100]);
    expect(box("a")).toEqual([20, 30, 40, 10]);
  });
});
