import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { Interaction, type PointerInput } from "../src/interaction";
import { fit, frameLabelAt, frameLabels, isArtboard } from "../src/labels";

/** An iPhone-sized artboard holding a card that holds a title, plus a loose rectangle. */
function setup() {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 6 }, clientId: "t" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  editor.setViewport(1600, 1200);
  const phone = editor.createLayer("frame", { x: 100, y: 100, width: 400, height: 800 }, "p", {
    name: "iPhone 18 Pro",
  }) as string;
  // Page coordinates: the card sits 40 in from the phone's corner, the title 20 in from the card's.
  const card = editor.createLayer("frame", { x: 140, y: 140, width: 200, height: 200 }, phone, {
    name: "Card",
  }) as string;
  const title = editor.createLayer("rect", { x: 160, y: 160, width: 100, height: 30 }, card, {
    fills: [{ type: "solid", color: "#2b4fd6" }],
  }) as string;
  const loose = editor.createLayer(
    "rect",
    { x: 700, y: 100, width: 100, height: 100 },
    "p",
  ) as string;
  editor.select([]);
  return { editor, phone, card, title, loose, interaction: new Interaction(editor) };
}

const at = (x: number, y: number, clicks = 1, extra: Partial<PointerInput> = {}): PointerInput => ({
  screen: { x, y },
  button: 0,
  shift: false,
  alt: false,
  mod: false,
  clicks,
  ...extra,
});

function click(interaction: Interaction, x: number, y: number, clicks = 1) {
  interaction.down(at(x, y, clicks));
  interaction.up(at(x, y, clicks));
}

describe("artboards", () => {
  it("doesn't pick an artboard by its empty area, but does by its label", () => {
    const { editor, phone, interaction } = setup();
    expect(isArtboard(editor, phone)).toBe(true);
    click(interaction, 450, 850);
    expect(editor.s.selection).toEqual([]);
    // The label sits just above the frame's top-left corner.
    const label = frameLabels(editor).find((l) => l.id === phone);
    expect(label?.text).toBe("iPhone 18 Pro");
    click(interaction, 105, 90);
    expect(editor.s.selection).toEqual([phone]);
  });

  it("drags an artboard by its label", () => {
    const { editor, phone, interaction } = setup();
    interaction.down(at(105, 90));
    interaction.move(at(125, 100));
    interaction.move(at(155, 130));
    interaction.up(at(155, 130));
    const p = (editor.doc.get(phone) as NodeRecord).props;
    expect([getProp(p, "x"), getProp(p, "y")]).toEqual([150, 140]);
  });

  it("renames an artboard from a double-click on its label", () => {
    const { editor, phone, interaction } = setup();
    click(interaction, 105, 90);
    interaction.down(at(105, 90, 2));
    expect(editor.s.renamingFrame).toBe(phone);
    expect(editor.s.selection).toEqual([phone]);
  });

  it("still picks empty frames, components and loose layers anywhere on them", () => {
    const { editor, interaction } = setup();
    const empty = editor.createLayer(
      "frame",
      { x: 900, y: 100, width: 100, height: 100 },
      "p",
    ) as string;
    expect(isArtboard(editor, empty)).toBe(false);
    click(interaction, 950, 150);
    expect(editor.s.selection).toEqual([empty]);
  });

  it("truncates long names to the frame's width, keeping the full name", () => {
    const measure = (t: string) => t.length * 6;
    expect(fit("Short", 100, measure)).toBe("Short");
    expect(fit("A very long frame name", 60, measure)).toBe("A very lo…");
    expect(fit("Name", 4, measure)).toBe("");
    const { editor, phone } = setup();
    editor.setProp([phone], "width", 30);
    const label = frameLabels(editor).find((l) => l.id === phone);
    expect(label?.name).toBe("iPhone 18 Pro");
    expect(label?.text.endsWith("…")).toBe(true);
    // A tiny frame's label stays pickable.
    expect(frameLabelAt(editor, { x: 120, y: 92 })?.id).toBe(phone);
  });
});

describe("entering nested frames", () => {
  it("steps one level deeper with each double-click", () => {
    const { editor, card, title, interaction } = setup();
    // A click inside the artboard selects its direct child, the card.
    click(interaction, 170, 170);
    expect(editor.s.selection).toEqual([card]);
    // Double-click goes into the card, to the layer under the pointer.
    click(interaction, 170, 170);
    interaction.down(at(170, 170, 2));
    interaction.up(at(170, 170, 2));
    expect(editor.s.selection).toEqual([title]);
  });
});

describe("resize snapping", () => {
  it("snaps a dragged edge to a sibling's edge and shows the guide", () => {
    const { editor, loose, interaction } = setup();
    const other = editor.createLayer(
      "rect",
      { x: 700, y: 300, width: 160, height: 50 },
      "p",
    ) as string;
    editor.select([loose]);
    // The right-middle handle sits at (800, 150); drag it near x = 860 (the other's right edge).
    interaction.down(at(800, 150));
    interaction.move(at(830, 150));
    interaction.move(at(857, 150));
    const p = (editor.doc.get(loose) as NodeRecord).props;
    expect(getProp(p, "width")).toBe(160);
    expect(editor.s.guides).toContainEqual(expect.objectContaining({ axis: "x", at: 860 }));
    interaction.up(at(857, 150));
    expect(editor.s.guides).toEqual([]);
    void other;
  });

  it("doesn't snap when nothing is near", () => {
    const { editor, loose, interaction } = setup();
    editor.select([loose]);
    interaction.down(at(800, 150));
    interaction.move(at(820, 150));
    interaction.move(at(833, 150));
    expect(getProp((editor.doc.get(loose) as NodeRecord).props, "width")).toBe(133);
    expect(editor.s.guides).toEqual([]);
    interaction.up(at(833, 150));
  });
});
