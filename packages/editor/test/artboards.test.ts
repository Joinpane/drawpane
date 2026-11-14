import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import fc from "fast-check";
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

  it("lands on the starting edge when a drag comes back to it", () => {
    // The drag works from where it started, so coming back must put the layer back,
    // not leave it where the previous pointer move had it.
    const { editor, loose, interaction } = setup();
    editor.select([loose]);
    const width = () => getProp((editor.doc.get(loose) as NodeRecord).props, "width");
    interaction.down(at(800, 150));
    interaction.move(at(840, 150));
    expect(width()).toBe(140);
    interaction.move(at(800, 150));
    expect(width()).toBe(100);
    interaction.up(at(800, 150));
  });

  it("snaps a dragged edge back onto its parent's edge (the edge it started on)", () => {
    const { editor, phone, interaction } = setup();
    // A bar along the phone's top, flush with its left edge.
    const bar = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 400, height: 80 },
      phone,
    ) as string;
    editor.select([bar]);
    const p = () => (editor.doc.get(bar) as NodeRecord).props;
    // The left-middle handle sits at (100, 140): pull it in, then back to just inside the edge.
    interaction.down(at(100, 140));
    interaction.move(at(130, 140));
    expect(getProp(p(), "x")).toBe(30);
    interaction.move(at(104, 140));
    expect(getProp(p(), "x")).toBe(0);
    expect(getProp(p(), "width")).toBe(400);
    expect(editor.s.guides).toContainEqual(expect.objectContaining({ axis: "x", at: 100 }));
    interaction.up(at(104, 140));
  });

  it("unflips when a handle dragged past the opposite edge comes back", () => {
    const { editor, loose, interaction } = setup();
    editor.select([loose]);
    const p = () => (editor.doc.get(loose) as NodeRecord).props;
    // Right handle at (800, 150), dragged left past the left edge (700), then back.
    interaction.down(at(800, 150));
    interaction.move(at(650, 150));
    expect(getProp(p(), "flipX")).toBe(true);
    interaction.move(at(820, 150));
    expect(getProp(p(), "flipX")).toBe(false);
    expect(getProp(p(), "x")).toBe(700);
    expect(getProp(p(), "width")).toBe(120);
    interaction.up(at(820, 150));
  });

  it("puts a layer back exactly when any drag of any handle ends where it began", () => {
    const handles = {
      nw: [700, 100],
      n: [750, 100],
      ne: [800, 100],
      e: [800, 150],
      se: [800, 200],
      s: [750, 200],
      sw: [700, 200],
      w: [700, 150],
    } as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...(Object.keys(handles) as (keyof typeof handles)[])),
        // Anywhere from far past the opposite edge (a flip) to well outside.
        fc.array(
          fc.tuple(fc.integer({ min: -250, max: 250 }), fc.integer({ min: -250, max: 250 })),
          {
            minLength: 1,
            maxLength: 8,
          },
        ),
        fc.boolean(),
        (handle, path, shift) => {
          const { editor, loose, interaction } = setup();
          editor.select([loose]);
          const before = { ...(editor.doc.get(loose) as NodeRecord).props };
          const [hx, hy] = handles[handle];
          const with_ = (x: number, y: number) => at(x, y, 1, { shift });
          interaction.down(with_(hx, hy));
          for (const [dx, dy] of path) interaction.move(with_(hx + dx, hy + dy));
          interaction.move(with_(hx, hy));
          const after = (editor.doc.get(loose) as NodeRecord).props;
          for (const prop of ["x", "y", "width", "height", "flipX", "flipY"] as const)
            expect(getProp(after, prop), prop).toEqual(getProp(before, prop));
          interaction.up(with_(hx, hy));
        },
      ),
    );
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
