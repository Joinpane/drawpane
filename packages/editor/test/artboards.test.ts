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

describe("holding Control", () => {
  /** A target 4 units right of the loose rectangle (700–800 × 100–200): within snapping range. */
  function nearTarget() {
    const s = setup();
    s.editor.createLayer("rect", { x: 900, y: 300, width: 50, height: 50 }, "p");
    return s;
  }

  it("moves without snapping, and ⌘ alone still snaps", () => {
    const { editor, loose, interaction } = nearTarget();
    editor.select([loose]);
    const x = () => getProp((editor.doc.get(loose) as NodeRecord).props, "x");
    // Dragging right by 96 puts the right edge at 896, 4 short of the target's left edge (900).
    interaction.down(at(750, 150));
    interaction.move(at(800, 150, 1, { noSnap: true }));
    interaction.move(at(846, 150, 1, { noSnap: true }));
    expect(x()).toBe(796);
    expect(editor.s.guides).toEqual([]);
    // Letting go of Control mid-drag snaps again; ⌘ doesn't turn it off.
    interaction.move(at(846, 150, 1, { mod: true }));
    expect(x()).toBe(800);
    interaction.up(at(846, 150));
  });

  it("resizes without snapping", () => {
    const { editor, loose, interaction } = nearTarget();
    editor.select([loose]);
    const width = () => getProp((editor.doc.get(loose) as NodeRecord).props, "width");
    // The right-middle handle at (800, 150), dragged to 896: 4 short of the target's edge.
    interaction.down(at(800, 150));
    interaction.move(at(850, 150, 1, { noSnap: true }));
    interaction.move(at(896, 150, 1, { noSnap: true }));
    expect(width()).toBe(196);
    expect(editor.s.guides).toEqual([]);
    interaction.move(at(896, 150));
    expect(width()).toBe(200);
    interaction.up(at(896, 150));
  });
});

describe("pixel grid", () => {
  /** The setup, zoomed so a screen pixel is 1.6 units, as in the report. */
  function zoomed() {
    const s = setup();
    s.editor.zoomTo(0.625);
    const screen = (x: number, y: number) => s.editor.s.camera.toScreen({ x, y });
    // Pointer events at the screen position of a page point, nudged by screen pixels.
    const point = (x: number, y: number, nx = 0, ny = 0, extra: Partial<PointerInput> = {}) => {
      const p = screen(x, y);
      return at(p.x + nx, p.y + ny, 1, extra);
    };
    return { ...s, point };
  }
  const geometry = (editor: Editor, id: string) => {
    const p = (editor.doc.get(id) as NodeRecord).props;
    return ["x", "y", "width", "height"].map((k) => getProp(p, k as "x"));
  };

  it("draws on whole pixels", () => {
    const { editor, interaction, point } = zoomed();
    editor.setTool("rect");
    interaction.down(point(1000, 500, 0.4, 0.3));
    interaction.move(point(1100, 600, 0.3, 0.6));
    interaction.move(point(1200, 580, 0.7, 0.2));
    const id = editor.s.selection[0] as string;
    expect(geometry(editor, id).every(Number.isInteger)).toBe(true);
    interaction.up(point(1200, 580, 0.7, 0.2));
  });

  it("moves a layer onto whole pixels, keeping a Shift-locked axis exactly", () => {
    const { editor, interaction, point } = zoomed();
    const odd = editor.createLayer(
      "rect",
      { x: 1000.4, y: 500.7, width: 50, height: 50 },
      "p",
    ) as string;
    editor.select([odd]);
    interaction.down(point(1025, 525));
    interaction.move(point(1025, 525, 10.3, 0.4));
    interaction.move(point(1025, 525, 21.7, 0.6));
    const [x, y] = geometry(editor, odd);
    expect(Number.isInteger(x)).toBe(true);
    expect(Number.isInteger(y)).toBe(true);
    interaction.up(point(1025, 525, 21.7, 0.6));
    // With Shift, the axis it doesn't move along stays where it was, fraction and all.
    const other = editor.createLayer(
      "rect",
      { x: 1200, y: 700.7, width: 50, height: 50 },
      "p",
    ) as string;
    editor.select([other]);
    interaction.down(point(1225, 725));
    interaction.move(point(1225, 725, 30.3, 0.4, { shift: true }));
    expect(geometry(editor, other)[1]).toBe(700.7);
    interaction.up(point(1225, 725, 30.3, 0.4, { shift: true }));
  });

  it("resizes the dragged edge onto a whole pixel and leaves the other where it was", () => {
    const { editor, loose, interaction, point } = zoomed();
    editor.select([loose]);
    // The right-middle handle of the loose rectangle (700–800).
    interaction.down(point(800, 150));
    interaction.move(point(800, 150, 15.3, 0));
    interaction.move(point(800, 150, 31.7, 0));
    const [x, , width] = geometry(editor, loose);
    expect(x).toBe(700);
    expect(Number.isInteger(width)).toBe(true);
    interaction.up(point(800, 150, 31.7, 0));
  });

  it("can be turned off", () => {
    const { editor, interaction, point } = zoomed();
    editor.state.set({ pixelSnap: false });
    editor.setTool("rect");
    interaction.down(point(1000, 500));
    interaction.move(point(1100, 600, 0.3, 0.6));
    interaction.move(point(1150, 580, 0.5, 0));
    const id = editor.s.selection[0] as string;
    expect(geometry(editor, id).every(Number.isInteger)).toBe(false);
    interaction.up(point(1150, 580, 0.5, 0));
  });
});

describe("drawing snaps", () => {
  it("starts and ends a shape on the frame's edges, and shows the guides", () => {
    const { editor, phone, interaction } = setup();
    editor.setTool("rect");
    // The phone spans x 100–500, y 100–900. Press 4 in from its corner, release 3 short of its right edge.
    interaction.down(at(104, 104));
    interaction.move(at(300, 150));
    interaction.move(at(497, 180));
    const id = editor.s.selection[0] as string;
    const node = editor.doc.get(id) as NodeRecord;
    expect(node.parent).toBe(phone);
    expect(getProp(node.props, "x")).toBe(0);
    expect(getProp(node.props, "y")).toBe(0);
    expect(getProp(node.props, "width")).toBe(400);
    expect(editor.s.guides).toContainEqual(expect.objectContaining({ axis: "x", at: 500 }));
    interaction.up(at(497, 180));
    expect(editor.s.guides).toEqual([]);
  });

  it("snaps to a sibling's edge and centre, not to the shape being drawn", () => {
    const { editor, interaction } = setup();
    // The loose rectangle spans x 700–800, y 100–200 (centre 750, 150).
    editor.setTool("ellipse");
    interaction.down(at(900, 300));
    interaction.move(at(870, 250));
    interaction.move(at(803, 148));
    const node = editor.doc.get(editor.s.selection[0] as string) as NodeRecord;
    expect(getProp(node.props, "x")).toBe(800);
    expect(getProp(node.props, "y")).toBe(150);
    interaction.up(at(803, 148));
  });

  it("leaves the pointer alone while Control is held, or when nothing is near", () => {
    const { editor, interaction } = setup();
    editor.setTool("rect");
    interaction.down(at(1004, 504, 1, { noSnap: true }));
    interaction.move(at(1100, 600, 1, { noSnap: true }));
    interaction.move(at(1203, 597, 1, { noSnap: true }));
    const node = editor.doc.get(editor.s.selection[0] as string) as NodeRecord;
    expect([getProp(node.props, "x"), getProp(node.props, "width")]).toEqual([1004, 199]);
    expect(editor.s.guides).toEqual([]);
    interaction.up(at(1203, 597, 1, { noSnap: true }));
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
