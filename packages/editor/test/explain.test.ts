import { type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { explainSize, sizeMode } from "../src/explain";
import { Interaction } from "../src/interaction";
import { sizePill, sizePillAt } from "../src/size-pill";
import { explainedFrame, xrayRegionAt, xrayRegions } from "../src/xray";

function setup() {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 8 }, clientId: "t" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  // The design's example: Home (340 wide, 20 padding) holds Upcoming, a
  // vertical stack that fills its width and hugs three 52px Event rows.
  const home = editor.createLayer("frame", { x: 0, y: 0, width: 340, height: 700 }, "p", {
    name: "Home",
    layoutMode: "column",
    paddingLeft: 20,
    paddingRight: 20,
    paddingTop: 20,
  }) as string;
  const upcoming = editor.createLayer("frame", { x: 0, y: 0, width: 100, height: 100 }, home, {
    name: "Upcoming",
    layoutMode: "column",
    gap: 8,
    paddingTop: 12,
    paddingBottom: 12,
    sizingH: "fill",
    sizingV: "hug",
  }) as string;
  const rows = [0, 1, 2].map(
    (i) =>
      editor.createLayer("rect", { x: 0, y: i * 60, width: 300, height: 52 }, upcoming, {
        name: "Event row",
      }) as string,
  );
  return { editor, home, upcoming, rows };
}

const height = (editor: Editor, id: string) =>
  (editor.doc.get(id) as NodeRecord).props.height as number;

describe("explainSize", () => {
  it("adds up a hugging stack: padding, children and gaps", () => {
    const { editor, upcoming, rows } = setup();
    expect(height(editor, upcoming)).toBe(196);
    const e = explainSize(editor.doc, upcoming, "height");
    expect(e?.question).toBe("Why is Upcoming 196 px tall?");
    expect(e?.answer).toBe("Height hugs its children in a vertical stack.");
    expect(e?.formula).toBe("12 + 3 × 52 + 2 × 8 + 12");
    expect(e?.terms.map((t) => t.label)).toEqual([
      "Padding top",
      "3 × Event row · fixed 52",
      "2 gaps of 8",
      "Padding bottom",
    ]);
    expect(e?.actions).toEqual([
      { kind: "fix", label: "Set fixed height" },
      { kind: "select", label: "Select Event row", ids: rows },
    ]);
  });

  it("explains a fill across a stack as the parent minus its padding", () => {
    const { editor, upcoming } = setup();
    const e = explainSize(editor.doc, upcoming, "width");
    expect(e?.size).toBe(300);
    expect(e?.answer).toBe("Width is Fill: Home is 340, minus 20 left and 20 right padding.");
    expect(e?.formula).toBe("340 − 20 − 20");
  });

  it("explains a fill along a row as a share of what's left", () => {
    const { editor } = setup();
    const row = editor.createLayer("frame", { x: 0, y: 0, width: 400, height: 40 }, "p", {
      name: "Toolbar",
      layoutMode: "row",
      gap: 10,
    }) as string;
    editor.createLayer("rect", { x: 0, y: 0, width: 100, height: 40 }, row, { name: "Logo" });
    const a = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 40 }, row, {
      name: "Search",
      sizingH: "fill",
    }) as string;
    editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 40 }, row, {
      name: "Filters",
      sizingH: "fill",
    });
    const e = explainSize(editor.doc, a, "width");
    expect(e?.size).toBe(140);
    expect(e?.answer).toContain("shares what Toolbar has left with 1 other Fill layer");
    expect(e?.formula).toBe("(400 − 100 − 2 × 10) ÷ 2");
  });

  it("says when a size is just fixed, and offers hugging for a layout frame", () => {
    const { editor, home, rows } = setup();
    expect(explainSize(editor.doc, rows[0] as string, "height")?.answer).toBe(
      "Height is fixed at 52: set by hand.",
    );
    expect(explainSize(editor.doc, home, "height")?.actions).toEqual([
      { kind: "hug", label: "Hug contents" },
    ]);
  });

  it("counts a group in the stack as the box around its layers", () => {
    const { editor, upcoming, rows } = setup();
    // Group the last row with a badge pinned beside it: the group is 52 tall, like a row.
    const badge = editor.createLayer("rect", { x: 0, y: 0, width: 20, height: 20 }, upcoming, {
      name: "Badge",
      positioning: "absolute",
    }) as string;
    editor.setProp([badge], "x", 280);
    editor.setProp([badge], "y", 12 + 52 + 8 + 52 + 8 + 16);
    editor.select([rows[2] as string, badge]);
    editor.group();
    const e = explainSize(editor.doc, upcoming, "height");
    expect(e?.size).toBe(196);
    expect(e?.formula).toBe("12 + 2 × 52 + 52 + 2 × 8 + 12");
  });

  it("explains text that sizes itself", () => {
    const { editor } = setup();
    const t = editor.createLayer("text", { x: 0, y: 0, width: 10, height: 10 }, "p", {
      characters: "Hello",
    }) as string;
    expect(explainSize(editor.doc, t, "width")?.answer).toBe(
      "Width hugs the text: as wide as its longest line.",
    );
  });
});

describe("X-ray regions", () => {
  it("has a region for each padding and each gap, and finds the one under a point", () => {
    const { editor, upcoming } = setup();
    const regions = xrayRegions(editor, upcoming);
    expect(regions.filter((r) => r.kind === "gap").map((r) => r.prop)).toEqual(["gap", "gap"]);
    expect(regions.filter((r) => r.kind === "padding").map((r) => r.prop)).toEqual([
      "paddingTop",
      "paddingBottom",
    ]);
    // Upcoming sits at (20, 20) in Home: its first gap spans y 64..72 there.
    editor.select([upcoming]);
    expect(xrayRegionAt(editor, { x: 100, y: 20 + 12 + 52 + 4 })?.prop).toBe("gap");
    expect(xrayRegionAt(editor, { x: 100, y: 20 + 6 })?.prop).toBe("paddingTop");
  });
});

describe("dragging in X-ray", () => {
  const at = (x: number, y: number, shift = false) => ({
    screen: { x, y },
    button: 0,
    shift,
    alt: true,
    mod: false,
    clicks: 1,
  });

  it("drags a gap wider, as one undo step, and Shift steps by 8", () => {
    const { editor, upcoming } = setup();
    const ix = new Interaction(editor);
    editor.select([upcoming]);
    editor.state.set({ xray: true });
    // The first gap, at y 84..92 on the page (the camera is at 1:1).
    ix.down(at(100, 88));
    ix.move(at(100, 94));
    expect((editor.doc.get(upcoming) as NodeRecord).props.gap).toBe(14);
    ix.move(at(100, 99, true));
    expect((editor.doc.get(upcoming) as NodeRecord).props.gap).toBe(16);
    ix.up(at(100, 99, true));
    // Two gaps of 16: the stack grew by 16.
    expect(height(editor, upcoming)).toBe(212);
    editor.undo();
    expect((editor.doc.get(upcoming) as NodeRecord).props.gap).toBe(8);
  });

  it("drags the top padding down to grow it, and never below 0", () => {
    const { editor, upcoming } = setup();
    const ix = new Interaction(editor);
    editor.select([upcoming]);
    editor.state.set({ xray: true });
    ix.down(at(100, 26));
    ix.move(at(100, 36));
    expect((editor.doc.get(upcoming) as NodeRecord).props.paddingTop).toBe(22);
    ix.move(at(100, -80));
    expect((editor.doc.get(upcoming) as NodeRecord).props.paddingTop ?? 0).toBe(0);
    ix.up(at(100, -80));
  });
});

describe("the size pill and Explain", () => {
  const click = (x: number, y: number) => ({
    screen: { x, y },
    button: 0,
    shift: false,
    alt: false,
    mod: false,
    clicks: 1,
  });

  it("says Fill and Hug, and which frame's padding and gaps add up", () => {
    const { editor, home, upcoming, rows } = setup();
    expect(sizeMode(editor.doc, upcoming, "width")).toBe("fill");
    expect(sizeMode(editor.doc, upcoming, "height")).toBe("hug");
    expect(sizeMode(editor.doc, rows[0] as string, "height")).toBe("fixed");
    expect(explainedFrame(editor, upcoming, "height")).toBe(upcoming);
    expect(explainedFrame(editor, upcoming, "width")).toBe(home);
    expect(explainedFrame(editor, rows[0] as string, "height")).toBeNull();
    editor.select([upcoming]);
    const pill = sizePill(editor);
    expect(pill?.parts.map((p) => [p.value, p.mode])).toEqual([
      ["300", "Fill"],
      ["196", "Hug"],
    ]);
    // Several layers: their bounds, with nothing to explain.
    editor.select(rows);
    expect(sizePill(editor)?.parts.map((p) => p.mode)).toEqual([null, null]);
    expect(sizePill(editor)?.explainable).toBe(false);
  });

  it("opens Explain for the number clicked, closes on a second click or a new selection", () => {
    const { editor, upcoming, rows } = setup();
    const ix = new Interaction(editor);
    editor.select([upcoming]);
    const pill = sizePill(editor);
    if (!pill) throw new Error("no pill");
    const y = pill.box.y + pill.box.height / 2;
    const [w, h] = pill.parts;
    expect(sizePillAt(editor, { x: w.x + 2, y })).toBe("width");
    ix.down(click(h.x + 2, y));
    ix.up(click(h.x + 2, y));
    expect(editor.s.explain).toEqual({ id: upcoming, axis: "height" });
    // The selection stays put: the click was on the pill, not the canvas.
    expect(editor.s.selection).toEqual([upcoming]);
    ix.down(click(h.x + 2, y));
    ix.up(click(h.x + 2, y));
    expect(editor.s.explain).toBeNull();

    editor.state.set({ explain: { id: upcoming, axis: "width" } });
    editor.select([rows[0] as string]);
    expect(editor.s.explain).toBeNull();
  });
});

describe("the size pill and X-ray", () => {
  it("steps aside rather than cover a gap X-ray is showing", () => {
    const { editor } = setup();
    // A column with a roomy gap: the first child's pill would sit in it.
    const stack = editor.createLayer("frame", { x: 0, y: 0, width: 200, height: 300 }, "p", {
      layoutMode: "column",
      gap: 40,
    }) as string;
    const first = editor.createLayer(
      "rect",
      { x: 0, y: 0, width: 200, height: 40 },
      stack,
    ) as string;
    editor.createLayer("rect", { x: 0, y: 0, width: 200, height: 40 }, stack);
    editor.select([first]);
    expect(sizePill(editor)).not.toBeNull();
    editor.state.set({ xray: true });
    expect(sizePill(editor)).toBeNull();
    expect(sizePillAt(editor, { x: 100, y: 57 })).toBeNull();
    editor.state.set({ xray: false });
    expect(sizePill(editor)).not.toBeNull();
  });
});
