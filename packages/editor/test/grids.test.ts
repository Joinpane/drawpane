import { getProp, type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import {
  defaultLayoutGrid,
  gridLines,
  gridSnapLines,
  gridTracks,
  guideAt,
  guideOwnerAt,
  placedGuides,
} from "../src/grids";
import { Interaction, type PointerInput } from "../src/interaction";
import { snapRect } from "../src/snap";

const columns = (patch: object = {}) => ({
  type: "columns" as const,
  count: 4,
  gutter: 20,
  margin: 10,
  alignment: "stretch" as const,
  size: 50,
  color: "#ff00001a",
  ...patch,
});

describe("layout grid geometry", () => {
  it("stretches columns between the margins", () => {
    // 400 - 2×10 margins - 3×20 gutters = 320 → four 80-wide columns.
    expect(gridTracks(columns(), 400)).toEqual([
      { start: 10, size: 80 },
      { start: 110, size: 80 },
      { start: 210, size: 80 },
      { start: 310, size: 80 },
    ]);
  });

  it("places fixed-size tracks at the start, centre or end", () => {
    // Four 50-wide tracks with 20 gutters: 260 wide.
    expect(gridTracks(columns({ alignment: "start" }), 400)[0]).toEqual({ start: 10, size: 50 });
    expect(gridTracks(columns({ alignment: "center" }), 400)[0]).toEqual({ start: 70, size: 50 });
    expect(gridTracks(columns({ alignment: "end" }), 400).at(-1)).toEqual({ start: 340, size: 50 });
  });

  it("never makes a negative track, and lines a square grid", () => {
    expect(gridTracks(columns({ count: 10, gutter: 100 }), 100)[0]?.size).toBe(0);
    expect(gridLines(8, 30)).toEqual([8, 16, 24]);
    expect(gridLines(0, 30)).toEqual([]);
  });

  it("starts from Figma's defaults", () => {
    expect(defaultLayoutGrid("columns")).toMatchObject({ count: 12, gutter: 20, margin: 20 });
    expect(defaultLayoutGrid("grid")).toMatchObject({ size: 8 });
  });
});

function setup() {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 8 }, clientId: "t" });
  editor.state.set({ role: "editor", viewport: { width: 1000, height: 800 } });
  const ops: Op[] = [
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    {
      op: "create",
      id: "screen",
      type: "frame",
      parent: "p",
      key: "a0",
      props: { x: 100, y: 100, width: 400, height: 300, layoutGrids: [columns()] },
    },
    {
      op: "create",
      id: "box",
      type: "rect",
      parent: "screen",
      key: "a0",
      props: { x: 0, y: 0, width: 30, height: 30 },
    },
  ];
  editor.doc.apply(ops);
  editor.setPage("p");
  return { editor, interaction: new Interaction(editor) };
}

const at = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({
  screen: { x, y },
  button: 0,
  shift: false,
  alt: false,
  mod: false,
  clicks: 1,
  ...extra,
});

describe("guides", () => {
  it("belong to the frame they're dropped on, or to the page", () => {
    const { editor } = setup();
    expect(guideOwnerAt(editor.scene, "p", "x", { x: 250, y: 200 })).toEqual({
      owner: "screen",
      offset: 150,
    });
    expect(guideOwnerAt(editor.scene, "p", "y", { x: 700, y: 50 })).toEqual({
      owner: "p",
      offset: 50,
    });
  });

  it("are dragged out of a ruler, moved, and dragged back to remove, each one undo step", () => {
    const { editor, interaction } = setup();
    editor.state.set({ insets: { top: 60, left: 40, right: 0, bottom: 0 } });
    // A vertical guide from the left ruler, dropped inside the frame.
    interaction.beginGuide("x", at(20, 200));
    interaction.move(at(250.4, 200));
    expect(editor.s.guideDraft).toMatchObject({ axis: "x", at: 250, offset: 150, removing: false });
    interaction.up(at(250.4, 200));
    expect(getProp(editor.doc.get("screen")?.props ?? {}, "rulerGuides")).toEqual([
      { axis: "x", offset: 150 },
    ]);
    expect(editor.s.guideDraft).toBeNull();

    // Grab it on the canvas and move it; it snaps to the frame's right edge.
    interaction.move(at(250, 300));
    expect(editor.s.hoverGuide).toEqual({ owner: "screen", index: 0 });
    expect(interaction.cursor).toBe("ew-resize");
    interaction.down(at(250, 300));
    interaction.move(at(497, 300));
    interaction.up(at(497, 300));
    expect(getProp(editor.doc.get("screen")?.props ?? {}, "rulerGuides")).toEqual([
      { axis: "x", offset: 400 },
    ]);
    editor.undo();
    expect(getProp(editor.doc.get("screen")?.props ?? {}, "rulerGuides")).toEqual([
      { axis: "x", offset: 150 },
    ]);

    // Back over the ruler: dropping removes it.
    interaction.down(at(250, 300));
    interaction.move(at(10, 300));
    expect(editor.s.guideDraft?.removing).toBe(true);
    interaction.up(at(10, 300));
    expect(editor.doc.get("screen")?.props.rulerGuides).toBeUndefined();
  });

  it("are found under the pointer only along their span", () => {
    const { editor } = setup();
    editor.setGuide("screen", null, { axis: "y", offset: 50 });
    editor.setGuide("p", null, { axis: "x", offset: 700 });
    const placed = placedGuides(editor.scene, "p");
    expect(placed.map((g) => [g.owner, g.axis, g.at])).toEqual([
      ["p", "x", 700],
      ["screen", "y", 150],
    ]);
    expect(guideAt(placed, { x: 300, y: 151 }, 2)?.owner).toBe("screen");
    // Frame guides stop at the frame's edges; page guides go on forever.
    expect(guideAt(placed, { x: 600, y: 150 }, 2)).toBeNull();
    expect(guideAt(placed, { x: 701, y: -5000 }, 2)?.owner).toBe("p");
    expect(editor.guideCount()).toBe(2);
    editor.clearGuides();
    expect(editor.guideCount()).toBe(0);
  });

  it("and grid columns are what moving layers snap to, while grids show", () => {
    const { editor, interaction } = setup();
    // Column edges in page coordinates: 110, 190, 210, 290…
    expect(
      gridSnapLines(editor.scene, "screen")
        .filter((l) => l.axis === "x")
        .map((l) => l.at)
        .slice(0, 4),
    ).toEqual([110, 190, 210, 290]);
    expect(
      snapRect({ x: 207, y: 0, width: 30, height: 30 }, [], 6, [{ axis: "x", at: 210 }]).dx,
    ).toBe(3);

    // Drag the box 7px right: its left edge (page 107) snaps to the first column at 110.
    const drag = () => {
      editor.select(["box"]);
      interaction.down(at(115, 115));
      interaction.move(at(122, 115));
      interaction.up(at(122, 115));
    };
    drag();
    expect(getProp(editor.doc.get("box")?.props ?? {}, "x")).toBe(10);
    editor.undo();
    editor.state.set({ layoutGrids: false });
    drag();
    expect(getProp(editor.doc.get("box")?.props ?? {}, "x")).toBe(7);
  });
});
