import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { Interaction, type PointerInput } from "../src/interaction";

function setup() {
  const editor = new Editor({ measurer: { width: () => 0 }, clientId: "t" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  return editor;
}

const props = (editor: Editor, id: string) => (editor.doc.get(id) as NodeRecord).props;

describe("switching to grid layout", () => {
  it("reads the grid that free layers already form", () => {
    const editor = setup();
    const frame = editor.createLayer(
      "frame",
      { x: 0, y: 0, width: 400, height: 300 },
      "p",
    ) as string;
    // Two rows: three across, then one. Created out of reading order.
    const at = (x: number, y: number) =>
      editor.createLayer("rect", { x, y, width: 80, height: 60 }, frame) as string;
    const d = at(10, 120);
    const c = at(250, 10);
    const a = at(10, 14);
    const b = at(130, 6);
    editor.setLayoutMode([frame], "grid");
    const p = props(editor, frame);
    expect(getProp(p, "layoutMode")).toBe("grid");
    expect(getProp(p, "gridColumns")).toHaveLength(3);
    expect(getProp(p, "gridRows")).toEqual([{ unit: "auto" }, { unit: "auto" }]);
    expect(editor.doc.childIds(frame)).toEqual([a, b, c, d]);
    // Laid out: a, b, c across row one; d starts row two.
    expect(getProp(props(editor, d), "x")).toBe(getProp(props(editor, a), "x"));
    expect(getProp(props(editor, d), "y")).toBeGreaterThan(getProp(props(editor, a), "y"));
    // One undo step puts everything back.
    editor.undo();
    expect(getProp(props(editor, frame), "layoutMode")).toBe("none");
    expect(getProp(props(editor, d), "y")).toBe(120);
  });

  it("keeps a row's order in one row, and an empty frame gets a 2 × 2 of fr", () => {
    const editor = setup();
    const row = editor.createLayer("frame", { x: 0, y: 0, width: 400, height: 100 }, "p", {
      layoutMode: "row",
      gap: 12,
    }) as string;
    for (let i = 0; i < 3; i++)
      editor.createLayer("rect", { x: 0, y: 0, width: 40, height: 40 }, row);
    editor.setLayoutMode([row], "grid");
    expect(getProp(props(editor, row), "gridColumns")).toHaveLength(3);
    expect(getProp(props(editor, row), "rowGap")).toBe(12);

    const empty = editor.createLayer(
      "frame",
      { x: 0, y: 200, width: 200, height: 200 },
      "p",
    ) as string;
    editor.setLayoutMode([empty], "grid");
    expect(getProp(props(editor, empty), "gridRows")).toEqual([
      { unit: "fr", value: 1 },
      { unit: "fr", value: 1 },
    ]);
  });

  it("frames loose layers in a hugging grid", () => {
    const editor = setup();
    const a = editor.createLayer("rect", { x: 0, y: 0, width: 50, height: 50 }, "p") as string;
    const b = editor.createLayer("rect", { x: 70, y: 0, width: 50, height: 50 }, "p") as string;
    editor.select([a, b]);
    editor.addGridLayout();
    const frame = editor.s.selection[0] as string;
    expect(getProp(props(editor, frame), "layoutMode")).toBe("grid");
    expect(getProp(props(editor, frame), "sizingH")).toBe("hug");
    // Two 1fr columns hugging 50-wide content, 8 apart.
    expect(getProp(props(editor, frame), "width")).toBe(108);
  });
});

describe("dragging in a grid", () => {
  const at = (x: number, y: number): PointerInput => ({
    screen: { x, y },
    button: 0,
    shift: false,
    alt: false,
    mod: false,
    clicks: 1,
  });

  it("moves an item to the cell under the pointer", () => {
    const editor = setup();
    const frame = editor.createLayer("frame", { x: 0, y: 0, width: 300, height: 300 }, "p", {
      layoutMode: "grid",
      gridColumns: [
        { unit: "fr", value: 1 },
        { unit: "fr", value: 1 },
        { unit: "fr", value: 1 },
      ],
      gridRows: [
        { unit: "fr", value: 1 },
        { unit: "fr", value: 1 },
        { unit: "fr", value: 1 },
      ],
    }) as string;
    const item = editor.createLayer("rect", { x: 0, y: 0, width: 40, height: 40 }, frame) as string;
    editor.select([item]);
    const interaction = new Interaction(editor);
    interaction.down(at(20, 20));
    interaction.move(at(120, 150));
    interaction.move(at(250, 250));
    interaction.up(at(250, 250));
    expect(getProp(props(editor, item), "gridArea")).toEqual({
      column: 3,
      row: 3,
      columnSpan: 1,
      rowSpan: 1,
    });
    expect(getProp(props(editor, item), "x")).toBe(200);
    expect(getProp(props(editor, item), "y")).toBe(200);
  });
});
