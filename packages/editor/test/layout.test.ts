import { type Op, type Props, ROOT_ID } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import {
  gridCellAt,
  gridGeometry,
  layoutBox,
  layoutOps,
  layoutRoots,
  parseTrackList,
  placeGridItems,
  solveTracks,
  trackLabel,
} from "../src/layout";

function setup(frame: Props, children: Props[], extra: Op[] = []) {
  const doc = new Doc();
  doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    {
      op: "create",
      id: "f",
      type: "frame",
      parent: "p",
      key: "a0",
      props: { width: 300, height: 100, ...frame },
    },
    ...children.map(
      (props, i): Op => ({
        op: "create",
        id: `c${i}`,
        type: "rect",
        parent: "f",
        key: `a${i}`,
        props: { width: 50, height: 20, ...props },
      }),
    ),
    ...extra,
  ]);
  doc.apply(layoutOps(doc, ["f"]));
  const box = (id: string) => {
    const p = doc.get(id)?.props ?? {};
    return [p.x ?? 0, p.y ?? 0, p.width ?? 0, p.height ?? 0];
  };
  return { doc, box };
}

describe("auto layout", () => {
  it("places a row with gap and padding", () => {
    const { box } = setup({ layoutMode: "row", gap: 10, paddingLeft: 8, paddingTop: 4 }, [
      {},
      {},
      {},
    ]);
    expect(box("c0")).toEqual([8, 4, 50, 20]);
    expect(box("c1")).toEqual([68, 4, 50, 20]);
    expect(box("c2")).toEqual([128, 4, 50, 20]);
  });

  it("hugs content in both axes", () => {
    const { box } = setup(
      {
        layoutMode: "column",
        gap: 4,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 6,
        paddingRight: 6,
        sizingH: "hug",
        sizingV: "hug",
      },
      [{ width: 40 }, { width: 80 }],
    );
    expect(box("f")).toEqual([0, 0, 92, 64]);
    expect(box("c1")).toEqual([6, 34, 80, 20]);
  });

  it("reserves the frame's own inside stroke in Fill and Hug", () => {
    const { doc, box } = setup(
      {
        layoutMode: "column",
        width: 100,
        sizingV: "hug",
        paddingLeft: 3,
        strokesIncludedInLayout: true,
        strokes: [{ type: "solid", color: "#000000" }],
        strokeWeights: [1, 2, 3, 4],
      },
      [{ sizingH: "fill" }],
    );
    expect(box("f")).toEqual([0, 0, 100, 24]);
    expect(box("c0")).toEqual([7, 1, 91, 20]);

    doc.apply([{ op: "set", id: "f", prop: "strokeAlign", value: "outside" }]);
    doc.apply(layoutOps(doc, ["f"]));
    expect(box("f")).toEqual([0, 0, 100, 20]);
    expect(box("c0")).toEqual([3, 0, 97, 20]);
  });

  it("shares space between Fill children and respects max", () => {
    const { box } = setup({ layoutMode: "row", gap: 10 }, [
      { sizingH: "fill" },
      { sizingH: "fill", maxWidth: 40 },
      { width: 60 },
    ]);
    // 300 - 60 - 20 gap = 220; second clamps to 40, first takes 180.
    expect(box("c0")[2]).toBe(180);
    expect(box("c1")[2]).toBe(40);
    expect(box("c2")[0]).toBe(240);
  });

  it("justifies and aligns like flexbox", () => {
    let { box } = setup({ layoutMode: "row", justifyContent: "center", alignItems: "center" }, [
      {},
      {},
    ]);
    expect(box("c0")).toEqual([100, 40, 50, 20]);
    ({ box } = setup({ layoutMode: "row", justifyContent: "space-between" }, [{}, {}, {}]));
    expect(box("c2")[0]).toBe(250);
    ({ box } = setup({ layoutMode: "row", alignItems: "stretch" }, [{}]));
    expect(box("c0")[3]).toBe(100);
    ({ box } = setup({ layoutMode: "row", justifyContent: "end" }, [{}]));
    expect(box("c0")[0]).toBe(250);
  });

  it("skips hidden and absolute children", () => {
    const { box } = setup({ layoutMode: "row" }, [
      { visible: false },
      { positioning: "absolute", x: 99 },
      {},
    ]);
    expect(box("c1")[0]).toBe(99);
    expect(box("c2")[0]).toBe(0);
  });

  it("propagates a size change up through hugging frames", () => {
    const { doc, box } = setup(
      { layoutMode: "row", sizingH: "hug", sizingV: "hug" },
      [],
      [
        {
          op: "create",
          id: "inner",
          type: "frame",
          parent: "f",
          key: "a0",
          props: { layoutMode: "column", sizingH: "hug", sizingV: "hug" },
        },
        {
          op: "create",
          id: "leaf",
          type: "rect",
          parent: "inner",
          key: "a0",
          props: { width: 30, height: 30 },
        },
      ],
    );
    expect(box("f")).toEqual([0, 0, 30, 30]);
    doc.apply([{ op: "set", id: "leaf", prop: "width", value: 70 }]);
    expect(layoutRoots(doc, ["leaf"])).toEqual(["f"]);
    doc.apply(layoutOps(doc, ["leaf"]));
    expect(box("inner")[2]).toBe(70);
    expect(box("f")[2]).toBe(70);
  });

  it("lays out a layout frame that's absolute inside another: its size and contents, not its place", () => {
    const { doc, box } = setup(
      { layoutMode: "row", gap: 10 },
      [{}],
      [
        {
          op: "create",
          id: "badge",
          type: "frame",
          parent: "f",
          key: "a5",
          props: {
            x: 200,
            y: 40,
            positioning: "absolute",
            layoutMode: "row",
            sizingH: "hug",
            sizingV: "hug",
            paddingLeft: 4,
            paddingRight: 4,
          },
        },
        {
          op: "create",
          id: "dot",
          type: "rect",
          parent: "badge",
          key: "a0",
          props: { width: 30, height: 8 },
        },
      ],
    );
    expect(box("badge")).toEqual([200, 40, 38, 8]);
    doc.apply([{ op: "set", id: "dot", prop: "width", value: 12 }]);
    doc.apply(layoutOps(doc, ["dot"]));
    expect(box("badge")).toEqual([200, 40, 20, 8]);
    expect(box("dot")).toEqual([4, 0, 12, 8]);
  });

  it("places a group as the box around its layers, moving them with it", () => {
    // Row: c0 (50 wide), then a group of two rects spanning 30..90 by 0..30, gap 10.
    const { doc, box } = setup(
      { layoutMode: "row", gap: 10 },
      [{}],
      [
        { op: "create", id: "g", type: "group", parent: "f", key: "a5", props: {} },
        {
          op: "create",
          id: "g1",
          type: "rect",
          parent: "g",
          key: "a0",
          props: { x: 200, y: 40, width: 20, height: 10 },
        },
        {
          op: "create",
          id: "g2",
          type: "rect",
          parent: "g",
          key: "a1",
          props: { x: 240, y: 50, width: 20, height: 20 },
        },
      ],
    );
    // The group starts right after c0 and its gap; its layers keep their places in it.
    expect(box("g1")).toEqual([60, 0, 20, 10]);
    expect(box("g2")).toEqual([100, 10, 20, 20]);
    expect(layoutBox(doc, "g")).toEqual({ x: 60, y: 0, width: 60, height: 30 });
    // Never stretched: its size is its layers'.
    doc.apply([{ op: "set", id: "f", prop: "alignItems", value: "stretch" }]);
    doc.apply(layoutOps(doc, ["f"]));
    expect(layoutBox(doc, "g")).toEqual({ x: 60, y: 0, width: 60, height: 30 });
  });

  it("re-lays out when a layer inside a group changes, and re-hugs a frame inside one", () => {
    const { doc, box } = setup(
      { layoutMode: "row", gap: 10, sizingH: "hug" },
      [{}],
      [
        { op: "create", id: "g", type: "group", parent: "f", key: "a5", props: {} },
        {
          op: "create",
          id: "inner",
          type: "frame",
          parent: "g",
          key: "a0",
          props: { x: 0, y: 0, layoutMode: "row", gap: 4, sizingH: "hug", sizingV: "hug" },
        },
        {
          op: "create",
          id: "i1",
          type: "rect",
          parent: "inner",
          key: "a0",
          props: { width: 10, height: 10 },
        },
        {
          op: "create",
          id: "i2",
          type: "rect",
          parent: "inner",
          key: "a1",
          props: { width: 10, height: 10 },
        },
      ],
    );
    expect(box("inner")).toEqual([60, 0, 24, 10]);
    expect(box("f")[2]).toBe(84);
    doc.apply([{ op: "set", id: "i2", prop: "width", value: 30 }]);
    doc.apply(layoutOps(doc, ["i2"]));
    expect(box("inner")).toEqual([60, 0, 44, 10]);
    expect(box("f")[2]).toBe(104);
  });

  it("shrinks a frame that hugs across when its content does, whatever stretches", () => {
    const { doc, box } = setup({ layoutMode: "row", sizingV: "hug", alignItems: "stretch" }, [
      { height: 40, alignSelf: "start" },
      { height: 10 },
    ]);
    // The tall layer sizes the row; the other stretches to it.
    expect(box("f")[3]).toBe(40);
    expect(box("c1")[3]).toBe(40);
    doc.apply([{ op: "set", id: "c0", prop: "height", value: 20 }]);
    doc.apply(layoutOps(doc, ["c0"]));
    expect(box("f")[3]).toBe(20);
    expect(box("c1")[3]).toBe(20);
  });

  it("keeps a frame that hugs across only layers that fill it at their size", () => {
    // A shadcn kit checkbox: a column that hugs its width around one label
    // set to Fill. Nothing else sizes the column, so the label keeps its
    // width rather than collapsing to nothing (one letter per line).
    const column = setup({ layoutMode: "column", sizingH: "hug", width: 204, height: 14 }, [
      { width: 204, height: 14, sizingH: "fill" },
    ]);
    expect(column.box("f")[2]).toBe(204);
    expect(column.box("c0")[2]).toBe(204);
    // The kit's card title: a row that hugs its height around a title that fills it.
    const row = setup({ layoutMode: "row", sizingV: "hug", width: 200, height: 20 }, [
      { width: 200, height: 20, sizingH: "fill", sizingV: "fill" },
    ]);
    expect(row.box("f")[3]).toBe(20);
    expect(row.box("c0")[3]).toBe(20);
    // As wrapped lines: a line of only stretching layers is as thick as they are.
    const wrapped = setup(
      { layoutMode: "row", layoutWrap: true, sizingV: "hug", width: 100, height: 0, rowGap: 4 },
      [
        { width: 80, height: 30 },
        { width: 80, height: 12, sizingV: "fill" },
      ],
    );
    expect(wrapped.box("f")[3]).toBe(46);
    // Once something else sizes it, the stretching layers follow again.
    column.doc.apply([
      {
        op: "create",
        id: "c1",
        type: "rect",
        parent: "f",
        key: "a1",
        props: { width: 120, height: 10 },
      },
    ]);
    column.doc.apply(layoutOps(column.doc, ["c1"]));
    expect(column.box("f")[2]).toBe(120);
    expect(column.box("c0")[2]).toBe(120);
  });

  it("hands a text layer's size to the layout when it fills or stretches, like Figma", () => {
    const { doc, box } = setup(
      { layoutMode: "column", alignItems: "stretch", width: 200 },
      [],
      [
        {
          op: "create",
          id: "t",
          type: "text",
          parent: "f",
          key: "a0",
          props: { characters: "Hi", width: 20, height: 20, textAutoResize: "width" },
        },
      ],
    );
    // Stretched across: its width is the layout's now, so it grows in height only.
    expect(box("t")[2]).toBe(200);
    expect(doc.get("t")?.props.textAutoResize).toBe("height");
    // Settled: laying out again changes nothing.
    expect(layoutOps(doc, ["f"])).toEqual([]);
  });

  it("produces no ops when nothing changes", () => {
    const { doc } = setup({ layoutMode: "row", gap: 10 }, [{}, {}]);
    expect(layoutOps(doc, ["f"])).toEqual([]);
  });

  it("keeps empty hugging frames at their current size instead of collapsing to 0", () => {
    const empty = setup(
      { layoutMode: "column", sizingH: "hug", sizingV: "hug", width: 120, height: 22 },
      [{ visible: false, width: 40, height: 10 }],
    );
    expect(empty.box("f")).toEqual([0, 0, 120, 22]);
    const emptyGrid = setup(
      {
        layoutMode: "grid",
        sizingH: "hug",
        sizingV: "hug",
        width: 180,
        height: 40,
        gridColumns: [{ unit: "auto" }],
      },
      [],
    );
    expect(emptyGrid.box("f")).toEqual([0, 0, 180, 40]);
  });

  it("keeps default space-between CSS-compatible and enables Figma centering/overflow only when marked", () => {
    // Legacy/native frame without spaceBetweenMode: single child stays at start, overflow clamps to 0.
    const legacyWrapped = setup(
      {
        layoutMode: "row",
        layoutWrap: true,
        justifyContent: "space-between",
        width: 100,
        height: 100,
      },
      [
        { width: 60, height: 20 },
        { width: 60, height: 20 },
      ],
    );
    expect(legacyWrapped.box("c0")).toEqual([0, 0, 60, 20]);
    expect(legacyWrapped.box("c1")).toEqual([0, 20, 60, 20]);

    const legacyOverflow = setup(
      {
        layoutMode: "column",
        justifyContent: "space-between",
        height: 48,
        paddingTop: 4,
        paddingBottom: 4,
      },
      [{ height: 22 }, { height: 20 }],
    );
    expect(legacyOverflow.box("c0")[1]).toBe(4);
    expect(legacyOverflow.box("c1")[1]).toBe(26);

    // Explicit Figma provenance: single child centers, overflow allows negative spacing.
    const single = setup(
      {
        layoutMode: "row",
        justifyContent: "space-between",
        spaceBetweenMode: "figma",
        width: 402,
        paddingLeft: 16,
        paddingRight: 16,
      },
      [{ width: 8, height: 8 }],
    );
    // 16 + (402 - 32 - 8) / 2 = 197
    expect(single.box("c0")[0]).toBe(197);

    const overflow = setup(
      {
        layoutMode: "column",
        justifyContent: "space-between",
        spaceBetweenMode: "figma",
        height: 48,
        paddingTop: 4,
        paddingBottom: 4,
      },
      [{ height: 22 }, { height: 20 }],
    );
    // inner = 40, used = 42, negative spacing = -2 -> second sits flush at 44 - 20 = 24
    expect(overflow.box("c0")[1]).toBe(4);
    expect(overflow.box("c1")[1]).toBe(24);
  });

  it("centers children using unclamped inner space when padding exceeds a fixed box", () => {
    const { box } = setup(
      {
        layoutMode: "column",
        justifyContent: "center",
        height: 161,
        paddingTop: 165,
        paddingBottom: 165,
      },
      [{ height: 22 }],
    );
    // 165 + (161 - 330 - 22) / 2 = 69.5
    expect(box("c0")[1]).toBe(69.5);
  });

  it("measures and positions rotated flow children by their axis-aligned bounds", () => {
    // 90 deg vertical separator in a 16x44 row with 8px left padding, filling vertically.
    const { box } = setup(
      { layoutMode: "row", width: 16, height: 44, paddingLeft: 8, paddingRight: 8 },
      [],
      [
        {
          op: "create",
          id: "sep",
          type: "line",
          parent: "f",
          key: "a0",
          props: { width: 44, height: 0, rotation: 90, sizingV: "fill" },
        },
      ],
    );
    expect(box("sep")).toEqual([-14, 22, 44, 0]);

    // Oblique rotated child (45 deg) occupies its AABB width and height in a hugging row.
    const oblique = setup({ layoutMode: "row", sizingH: "hug", sizingV: "hug" }, [
      { width: 40, height: 100, rotation: -45 },
    ]);
    const aabb = Math.round((40 + 100) * Math.SQRT1_2 * 100) / 100;
    expect(oblique.box("f")[2]).toBeCloseTo(aabb, 1);
    expect(oblique.box("f")[3]).toBeCloseTo(aabb, 1);
    expect(oblique.box("c0")[0]).toBeCloseTo((aabb - 40) / 2, 1);
    expect(oblique.box("c0")[1]).toBeCloseTo((aabb - 100) / 2, 1);
  });

  it("fills oblique rotated children to line thickness sensibly and stays idempotent across passes", () => {
    // Review repro: 100x100 wrapping row with a 50x10 rect rotated 30 deg (sizingV: fill)
    // and a 48x20 sibling stretches local height to 20 (matching Figma, never collapsing to 0)
    // and emits zero ops on the second pass.
    const wrapped = setup({ layoutMode: "row", layoutWrap: true, width: 100, height: 100 }, [
      { width: 50, height: 10, rotation: 30, sizingV: "fill" },
      { width: 48, height: 20 },
    ]);
    expect(wrapped.box("c0")[2]).toBe(50);
    expect(wrapped.box("c0")[3]).toBe(20);
    expect(wrapped.box("c1")[0]).toBeCloseTo(50 * Math.cos(Math.PI / 6) + 20 * 0.5, 1);
    expect(wrapped.box("c1")[1]).toBe(0);
    expect(layoutOps(wrapped.doc, ["f"])).toEqual([]);

    // Oblique cross-Fill inside a taller line with a main-Fill sibling.
    const mixed = setup({ layoutMode: "row", layoutWrap: true, width: 200, height: 100 }, [
      { width: 50, height: 10, rotation: 30, sizingV: "fill" },
      { width: 40, height: 40, sizingH: "fill" },
    ]);
    expect(mixed.box("c0")[3]).toBe(40);
    expect(mixed.box("c1")[2]).toBeGreaterThan(100);
    expect(layoutOps(mixed.doc, ["f"])).toEqual([]);

    // Oblique Fill on both main and cross axes.
    const both = setup({ layoutMode: "row", width: 200, height: 100 }, [
      { width: 40, height: 20, rotation: 30, sizingH: "fill", sizingV: "fill" },
    ]);
    expect(both.box("c0")[2]).toBe(200);
    expect(both.box("c0")[3]).toBe(100);
    expect(layoutOps(both.doc, ["f"])).toEqual([]);

    // All-stretch cross-hugging row with an oblique rotated Fill child must not grow per pass.
    const hugging = setup({ layoutMode: "row", sizingV: "hug", width: 200, height: 50 }, [
      { width: 50, height: 10, rotation: 30, sizingV: "fill" },
    ]);
    expect(hugging.box("c0")[3]).toBe(10);
    expect(layoutOps(hugging.doc, ["f"])).toEqual([]);
  });

  it("keeps stretched layout frames and text at their content height inside cross-hugging rows", () => {
    const { box } = setup(
      { layoutMode: "row", sizingV: "hug", width: 300, height: 35 },
      [{ width: 40, height: 17 }],
      [
        {
          op: "create",
          id: "stack",
          type: "frame",
          parent: "f",
          key: "a1",
          props: { layoutMode: "column", sizingH: "fill", sizingV: "fill", width: 200, height: 35 },
        },
        {
          op: "create",
          id: "t1",
          type: "rect",
          parent: "stack",
          key: "a0",
          props: { width: 100, height: 20 },
        },
        {
          op: "create",
          id: "t2",
          type: "rect",
          parent: "stack",
          key: "a1",
          props: { width: 100, height: 15 },
        },
      ],
    );
    expect(box("f")[3]).toBe(35);
    expect(box("stack")[3]).toBe(35);

    const textRow = setup(
      { layoutMode: "row", sizingV: "hug", width: 300, height: 48 },
      [{ width: 72, height: 36 }],
      [
        {
          op: "create",
          id: "heading",
          type: "text",
          parent: "f",
          key: "a1",
          props: {
            characters: "Shop by Category",
            width: 200,
            height: 48,
            sizingH: "fill",
            sizingV: "fill",
            textAutoResize: "height",
          },
        },
      ],
    );
    expect(textRow.box("f")[3]).toBe(48);
    expect(textRow.box("heading")[3]).toBe(48);
  });
});

describe("wrap", () => {
  it("breaks a row into lines and packs them at the start, rowGap apart", () => {
    // 300 wide: four 80s with a 20 gap fit three to a line (80·3 + 40 = 280).
    const { box } = setup({ layoutMode: "row", layoutWrap: true, gap: 20, rowGap: 12 }, [
      { width: 80, height: 20 },
      { width: 80, height: 30 },
      { width: 80, height: 20 },
      { width: 80, height: 10 },
    ]);
    expect(box("c2")).toEqual([200, 0, 80, 20]);
    // Line one is 30 thick (its thickest item).
    expect(box("c3")).toEqual([0, 42, 80, 10]);
  });

  it("hugs the lines' total thickness, and aligns within each line", () => {
    const { box } = setup(
      { layoutMode: "row", layoutWrap: true, rowGap: 10, sizingV: "hug", alignItems: "end" },
      [
        { width: 200, height: 40 },
        { width: 200, height: 20 },
        { width: 50, height: 10 },
      ],
    );
    expect(box("f")[3]).toBe(70);
    // Line two holds the 20 and the 10; the 10 sits at its end.
    expect(box("c2")).toEqual([200, 60, 50, 10]);
  });

  it("shares each line's leftover between its Fill children", () => {
    const { box } = setup({ layoutMode: "row", layoutWrap: true, gap: 10 }, [
      { width: 200 },
      { sizingH: "fill", minWidth: 60 },
      { sizingH: "fill", minWidth: 100 },
    ]);
    // Line one: 200 + 10 + 60 = 270 fits; the third needs 100 more, so it wraps.
    expect(box("c1")[2]).toBe(90);
    expect(box("c2")).toEqual([0, 20, 300, 20]);
  });

  it("never wraps a frame that hugs its main axis", () => {
    const { box } = setup({ layoutMode: "row", layoutWrap: true, sizingH: "hug" }, [
      { width: 200 },
      { width: 200 },
    ]);
    expect(box("f")[2]).toBe(400);
    expect(box("c1")[1]).toBe(0);
  });

  it("lets a child override the frame's alignment", () => {
    const { box } = setup({ layoutMode: "row", alignItems: "start" }, [
      { alignSelf: "end" },
      { alignSelf: "stretch" },
    ]);
    expect(box("c0")[1]).toBe(80);
    expect(box("c1")[3]).toBe(100);
  });

  it("keeps absent alignContent start-packed, aligns alignContent auto by alignItems, and distributes space-between", () => {
    // Stored wrapped frames without alignContent keep the legacy start-packed placement.
    const legacy = setup(
      { layoutMode: "row", layoutWrap: true, width: 100, height: 100, alignItems: "center" },
      [
        { width: 60, height: 20 },
        { width: 60, height: 20 },
      ],
    );
    expect(legacy.box("c0")[1]).toBe(0);
    expect(legacy.box("c1")[1]).toBe(20);

    // Explicit alignContent: "auto" (Figma packed wrap) packs wrapped lines by alignItems.
    const packed = setup(
      {
        layoutMode: "row",
        layoutWrap: true,
        width: 100,
        height: 100,
        alignItems: "center",
        alignContent: "auto",
      },
      [
        { width: 60, height: 20 },
        { width: 60, height: 20 },
      ],
    );
    expect(packed.box("c0")[1]).toBe(30);
    expect(packed.box("c1")[1]).toBe(50);

    const centered = setup(
      {
        layoutMode: "row",
        layoutWrap: true,
        width: 269,
        height: 48,
        alignItems: "center",
        alignContent: "auto",
      },
      [{ width: 80, height: 16 }],
    );
    expect(centered.box("c0")[1]).toBe(16);

    const spread = setup(
      {
        layoutMode: "row",
        layoutWrap: true,
        width: 100,
        height: 100,
        alignContent: "space-between",
        rowGap: 7,
      },
      [
        { width: 60, height: 20 },
        { width: 60, height: 20 },
      ],
    );
    expect(spread.box("c0")[1]).toBe(0);
    expect(spread.box("c1")[1]).toBe(80);
  });
});

describe("grid tracks", () => {
  it("gives px their size, auto its content and fr the rest", () => {
    expect(
      solveTracks(
        [
          { unit: "px", value: 100 },
          { unit: "auto" },
          { unit: "fr", value: 1 },
          { unit: "fr", value: 3 },
        ],
        [{ start: 1, span: 1, size: 40 }],
        10,
        400,
      ),
    ).toEqual([100, 40, 57.5, 172.5]);
  });

  it("keeps an fr track at least as big as its content", () => {
    const sizes = solveTracks(
      [
        { unit: "fr", value: 1 },
        { unit: "fr", value: 1 },
      ],
      [{ start: 0, span: 1, size: 150 }],
      0,
      200,
    );
    expect(sizes).toEqual([150, 50]);
  });

  it("sizes fr in proportion to content when the frame hugs", () => {
    const sizes = solveTracks(
      [
        { unit: "fr", value: 1 },
        { unit: "fr", value: 2 },
      ],
      [
        { start: 0, span: 1, size: 60 },
        { start: 1, span: 1, size: 40 },
      ],
      0,
      null,
    );
    expect(sizes).toEqual([60, 120]);
  });

  it("grows auto tracks to fit an item that spans them", () => {
    const sizes = solveTracks(
      [{ unit: "px", value: 50 }, { unit: "auto" }, { unit: "auto" }],
      [{ start: 0, span: 3, size: 170 }],
      10,
      null,
    );
    expect(sizes).toEqual([50, 50, 50]);
  });

  it("fills a definite space exactly when nothing overflows", () => {
    const track = fc.oneof(
      fc.record({ unit: fc.constant("px" as const), value: fc.integer({ min: 0, max: 40 }) }),
      fc.record({ unit: fc.constant("fr" as const), value: fc.integer({ min: 1, max: 4 }) }),
    );
    fc.assert(
      fc.property(
        fc.array(track, { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 0, max: 12 }),
        (defs, gap) => {
          if (!defs.some((d) => d.unit === "fr")) return;
          const sizes = solveTracks(defs, [], gap, 1000);
          const sum = sizes.reduce((a, b) => a + b, 0) + gap * (defs.length - 1);
          expect(sum).toBeCloseTo(1000, 6);
          for (const s of sizes) expect(s).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe("grid layout", () => {
  const grid: Props = {
    layoutMode: "grid",
    width: 320,
    height: 220,
    paddingTop: 10,
    paddingLeft: 10,
    paddingRight: 10,
    paddingBottom: 10,
    gap: 20,
    rowGap: 20,
    gridColumns: [
      { unit: "px", value: 100 },
      { unit: "fr", value: 1 },
    ],
    gridRows: [
      { unit: "px", value: 40 },
      { unit: "fr", value: 1 },
    ],
  };

  it("flows items into the next free cell, row by row", () => {
    const { box } = setup(grid, [{}, {}, {}]);
    expect(box("c0")).toEqual([10, 10, 50, 20]);
    expect(box("c1")).toEqual([130, 10, 50, 20]);
    expect(box("c2")).toEqual([10, 70, 50, 20]);
  });

  it("places items at their area first, and fills the gaps around them", () => {
    const { doc, box } = setup(grid, [
      {},
      { gridArea: { column: 1, row: 1, columnSpan: 2, rowSpan: 1 }, sizingH: "fill" },
    ]);
    // The spanning header takes row one; the auto item drops to row two.
    expect(box("c1")).toEqual([10, 10, 300, 20]);
    expect(box("c0")).toEqual([10, 70, 50, 20]);
    const f = doc.get("f");
    if (!f) throw new Error("no frame");
    const children = ["c0", "c1"].map((id) => doc.get(id)).filter((n) => n !== undefined);
    expect(placeGridItems(f, children).cells.get("c0")).toEqual({
      column: 0,
      row: 1,
      columnSpan: 1,
      rowSpan: 1,
    });
  });

  it("stretches and aligns items in their cells", () => {
    const { box } = setup({ ...grid, justifyItems: "center", alignItems: "end" }, [
      { alignSelf: "stretch" },
      { justifySelf: "end", sizingV: "fill" },
    ]);
    // Row one is 40 tall: the first stretches to it and centres across 100.
    expect(box("c0")).toEqual([35, 10, 50, 40]);
    // Column two is 180 wide (320 - 20 padding - 100 - 20 gap).
    expect(box("c1")).toEqual([260, 10, 50, 40]);
  });

  it("adds auto rows for items beyond the defined ones", () => {
    const { box } = setup({ ...grid, gridRows: [{ unit: "px", value: 40 }] }, [
      {},
      {},
      { height: 30 },
    ]);
    expect(box("c2")).toEqual([10, 70, 50, 30]);
  });

  it("hugs the sum of its tracks", () => {
    const { box } = setup(
      {
        ...grid,
        sizingH: "hug",
        sizingV: "hug",
        gridColumns: [{ unit: "auto" }, { unit: "px", value: 30 }],
        gridRows: [],
      },
      [{ width: 70, height: 25 }, {}, { height: 15 }],
    );
    // 70 + 20 + 30 + padding 20; rows 25 and 15 with a 20 gap + 20 padding.
    expect(box("f")).toEqual([0, 0, 140, 80]);
  });

  it("reports its geometry and finds the cell under a point", () => {
    const { doc } = setup(grid, [{}]);
    const g = gridGeometry(doc, "f");
    expect(g?.columns).toEqual([
      { start: 10, size: 100 },
      { start: 130, size: 180 },
    ]);
    expect(g?.rows).toEqual([
      { start: 10, size: 40 },
      { start: 70, size: 140 },
    ]);
    if (!g) return;
    expect(gridCellAt(g, 200, 100)).toEqual({ column: 1, row: 1 });
    // In the gap between the columns, the nearer one wins.
    expect(gridCellAt(g, 112, 20)).toEqual({ column: 0, row: 0 });
  });

  it("is stable: a second run changes nothing", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            width: fc.integer({ min: 1, max: 120 }),
            height: fc.integer({ min: 1, max: 80 }),
            sizingH: fc.constantFrom("fixed", "fill", "hug"),
            sizingV: fc.constantFrom("fixed", "fill"),
          }),
          { maxLength: 7 },
        ),
        fc.boolean(),
        (children, hug) => {
          const { doc } = setup(hug ? { ...grid, sizingV: "hug" } : grid, children);
          expect(layoutOps(doc, ["f"])).toEqual([]);
        },
      ),
    );
  });
});

describe("typing tracks", () => {
  it("reads CSS track lists, with repeat()", () => {
    expect(parseTrackList("200px 1fr repeat(2, 2 fr) auto")).toEqual([
      { unit: "px", value: 200 },
      { unit: "fr", value: 1 },
      { unit: "fr", value: 2 },
      { unit: "fr", value: 2 },
      { unit: "auto" },
    ]);
    expect(parseTrackList("120, hug, 80")?.map(trackLabel)).toEqual(["120px", "auto", "80px"]);
    expect(parseTrackList("1fr wide")).toBeNull();
    expect(parseTrackList("0fr")).toBeNull();
    expect(parseTrackList("")).toBeNull();
  });
});
