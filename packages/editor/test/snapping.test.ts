/**
 * Snapping and selection while dragging, from the third review: Shift-drag
 * keeps the selection, Shift's lock holds against smart guides, the pixel
 * grid survives a snap, a board's guides stay on that board, square layout
 * grids snap, and rotated layers and frames behave.
 */
import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { Interaction, type PointerInput } from "../src/interaction";

function setup() {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 6 }, clientId: "t" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  editor.setViewport(1600, 1200);
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

const props = (editor: Editor, id: string) => (editor.doc.get(id) as NodeRecord).props;
const xy = (editor: Editor, id: string) => [
  getProp(props(editor, id), "x"),
  getProp(props(editor, id), "y"),
];

describe("Shift and the selection", () => {
  it("Shift-dragging a selected layer moves the whole selection; a Shift-click still deselects it", () => {
    const { editor, interaction } = setup();
    const a = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 100, height: 100 },
      "p",
    ) as string;
    const b = editor.createLayer(
      "rect",
      { x: 300, y: 100, width: 100, height: 100 },
      "p",
    ) as string;
    editor.select([a, b]);
    interaction.down(at(150, 150, { shift: true }));
    interaction.move(at(200, 150, { shift: true }));
    interaction.move(at(270, 150, { shift: true }));
    interaction.up(at(270, 150, { shift: true }));
    expect(editor.s.selection).toEqual([a, b]);
    expect(xy(editor, a)).toEqual([220, 100]);
    expect(xy(editor, b)).toEqual([420, 100]);
    // A Shift-click without a drag takes it out of the selection.
    interaction.down(at(270, 150, { shift: true }));
    interaction.up(at(270, 150, { shift: true }));
    expect(editor.s.selection).toEqual([b]);
  });
});

describe("Shift's axis lock", () => {
  it("holds the locked axis even when a sibling's edge is within snapping range", () => {
    const { editor, interaction } = setup();
    const m = editor.createLayer("rect", { x: 100, y: 104, width: 50, height: 50 }, "p") as string;
    editor.createLayer("rect", { x: 500, y: 100, width: 50, height: 50 }, "p");
    editor.select([m]);
    interaction.down(at(125, 129, { shift: true }));
    interaction.move(at(200, 130, { shift: true }));
    interaction.move(at(305, 131, { shift: true }));
    expect(getProp(props(editor, m), "y")).toBe(104);
    expect(editor.s.guides.every((g) => g.axis === "x")).toBe(true);
    interaction.up(at(305, 131, { shift: true }));
  });
});

describe("pixel grid and smart guides", () => {
  it("moving: centring an odd-width layer in its frame still lands on whole pixels", () => {
    const { editor, interaction } = setup();
    const frame = editor.createLayer(
      "frame",
      { x: 0, y: 0, width: 800, height: 600 },
      "p",
    ) as string;
    const r = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 101, height: 51 },
      frame,
    ) as string;
    editor.select([r]);
    // Its centre (150.5) dragged near the frame's centre (400).
    interaction.down(at(150, 125));
    interaction.move(at(250, 125));
    interaction.move(at(398, 125));
    const [x] = xy(editor, r);
    expect(Number.isInteger(x)).toBe(true);
    expect(Math.abs((x as number) + 50.5 - 400)).toBeLessThanOrEqual(0.5);
    interaction.up(at(398, 125));
  });

  it("resizing: an edge snapped to a half-pixel centre still leaves whole sizes", () => {
    const { editor, interaction } = setup();
    const r = editor.createLayer("rect", { x: 100, y: 100, width: 200, height: 50 }, "p") as string;
    // A sibling 101 wide: its centre is at 350.5.
    editor.createLayer("rect", { x: 300, y: 300, width: 101, height: 50 }, "p");
    editor.select([r]);
    interaction.down(at(300, 125));
    interaction.move(at(330, 125));
    interaction.move(at(348, 125));
    expect(Number.isInteger(getProp(props(editor, r), "width"))).toBe(true);
    interaction.up(at(348, 125));
  });

  it("drawing: a corner snapped to a half-pixel centre still lands on whole pixels", () => {
    const { editor, interaction } = setup();
    editor.createLayer("rect", { x: 300, y: 300, width: 101, height: 51 }, "p");
    editor.setTool("rect");
    interaction.down(at(352, 327));
    interaction.move(at(420, 380));
    interaction.move(at(500, 420));
    const id = editor.s.selection[0] as string;
    for (const k of ["x", "y", "width", "height"] as const)
      expect(Number.isInteger(getProp(props(editor, id), k)), k).toBe(true);
    interaction.up(at(500, 420));
  });

  it("moving onto a stretched layout grid's fractional column edge lands on a whole pixel", () => {
    const { editor, interaction } = setup();
    const frame = editor.createLayer("frame", { x: 0, y: 0, width: 1000, height: 600 }, "p", {
      layoutGrids: [
        {
          type: "columns",
          count: 12,
          gutter: 20,
          margin: 32,
          alignment: "stretch",
          size: 0,
          color: "#ff000033",
        },
      ],
    }) as string;
    const r = editor.createLayer(
      "rect",
      { x: 200, y: 200, width: 40, height: 40 },
      frame,
    ) as string;
    editor.select([r]);
    // The second column starts at 32 + 1·(1000 − 64 − 220)/12 + 20 = 111.67.
    interaction.down(at(220, 220));
    interaction.move(at(180, 220));
    interaction.move(at(132, 220));
    expect(Number.isInteger(getProp(props(editor, r), "x"))).toBe(true);
    interaction.up(at(132, 220));
  });

  it("a proportional (Shift) resize keeps whole sizes", () => {
    const { editor, interaction } = setup();
    const r = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 300, height: 199 },
      "p",
    ) as string;
    editor.select([r]);
    interaction.down(at(400, 299, { shift: true }));
    interaction.move(at(420, 310, { shift: true }));
    interaction.move(at(451, 330, { shift: true }));
    expect(Number.isInteger(getProp(props(editor, r), "width"))).toBe(true);
    expect(Number.isInteger(getProp(props(editor, r), "height"))).toBe(true);
    interaction.up(at(451, 330, { shift: true }));
  });

  it("moving a rotated layer keeps its own X and Y whole", () => {
    const { editor, interaction } = setup();
    const r = editor.createLayer("rect", { x: 100, y: 100, width: 100, height: 60 }, "p", {
      rotation: 30,
    }) as string;
    editor.select([r]);
    const b = editor.scene.bounds(r);
    if (!b) throw new Error("no bounds");
    const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    interaction.down(at(c.x, c.y));
    interaction.move(at(c.x + 30, c.y + 10));
    interaction.move(at(c.x + 73.3, c.y + 41.9));
    const [x, y] = xy(editor, r);
    expect(Number.isInteger(x)).toBe(true);
    expect(Number.isInteger(y)).toBe(true);
    interaction.up(at(c.x + 73.3, c.y + 41.9));
  });
});

describe("guides and grids", () => {
  it("a board's ruler guide snaps layers on that board only", () => {
    const { editor, interaction } = setup();
    const a = editor.createLayer("frame", { x: 0, y: 0, width: 400, height: 400 }, "p", {
      rulerGuides: [{ axis: "y", offset: 263 }],
    }) as string;
    const b = editor.createLayer("frame", { x: 500, y: 0, width: 400, height: 400 }, "p") as string;
    const inA = editor.createLayer("rect", { x: 50, y: 100, width: 40, height: 40 }, a) as string;
    const inB = editor.createLayer("rect", { x: 550, y: 100, width: 40, height: 40 }, b) as string;
    // In B, dragging its top edge to y 260 (3 above A's guide): no snap.
    editor.select([inB]);
    interaction.down(at(570, 120));
    interaction.move(at(570, 200));
    interaction.move(at(570, 280));
    expect(getProp(props(editor, inB), "y")).toBe(260);
    interaction.up(at(570, 280));
    // In A, the same drag snaps to it.
    editor.select([inA]);
    interaction.down(at(70, 120));
    interaction.move(at(70, 200));
    interaction.move(at(70, 280));
    expect(getProp(props(editor, inA), "y")).toBe(263);
    interaction.up(at(70, 280));
  });

  it("a square layout grid snaps edges to its lines", () => {
    const { editor, interaction } = setup();
    const frame = editor.createLayer("frame", { x: 0, y: 0, width: 400, height: 400 }, "p", {
      layoutGrids: [{ type: "grid", size: 8, color: "#ff000033" }],
    }) as string;
    const r = editor.createLayer("rect", { x: 40, y: 40, width: 32, height: 32 }, frame) as string;
    editor.select([r]);
    interaction.down(at(56, 56));
    interaction.move(at(62, 56));
    interaction.move(at(69, 56));
    expect((getProp(props(editor, r), "x") as number) % 8).toBe(0);
    interaction.up(at(69, 56));
  });

  it("doesn't snap inside a rotated frame, where page lines don't follow the frame's axes", () => {
    const { editor, interaction } = setup();
    const frame = editor.createLayer("frame", { x: 100, y: 100, width: 400, height: 400 }, "p", {
      rotation: 15,
    }) as string;
    const child = editor.createLayer(
      "rect",
      { x: 0, y: 0, width: 40, height: 40 },
      frame,
    ) as string;
    editor.createLayer("rect", { x: 0, y: 0, width: 40, height: 40 }, frame);
    // Make the second child somewhere else in the frame.
    editor.select([child]);
    const b = editor.scene.bounds(child);
    if (!b) throw new Error("no bounds");
    interaction.down(at(b.x + 20, b.y + 20));
    interaction.move(at(b.x + 60, b.y + 30));
    interaction.move(at(b.x + 120, b.y + 50));
    expect(editor.s.guides).toEqual([]);
    interaction.up(at(b.x + 120, b.y + 50));
  });
});

describe("modifier keys mid-drag", () => {
  it("a key pressed during a frame resize doesn't switch its children's constraints off", () => {
    const { editor, interaction } = setup();
    const frame = editor.createLayer(
      "frame",
      { x: 100, y: 100, width: 200, height: 200 },
      "p",
    ) as string;
    const pinned = editor.createLayer("rect", { x: 250, y: 150, width: 40, height: 40 }, frame, {
      constraintH: "end",
    }) as string;
    editor.select([frame]);
    // The right-middle handle at (300, 200), dragged 60 right; ⌘/Ctrl pressed only on the way.
    interaction.down(at(300, 200));
    interaction.move(at(330, 200));
    interaction.move(at(360, 200, { mod: true, noSnap: true }));
    interaction.up(at(360, 200, { mod: true, noSnap: true }));
    expect(getProp(props(editor, frame), "width")).toBe(260);
    expect(getProp(props(editor, pinned), "x")).toBe(210);
    // Held from the start, it does: the child stays where it was.
    interaction.down(at(360, 200, { mod: true }));
    interaction.move(at(380, 200, { mod: true }));
    interaction.move(at(400, 200, { mod: true }));
    interaction.up(at(400, 200, { mod: true }));
    expect(getProp(props(editor, pinned), "x")).toBe(210);
  });
});
