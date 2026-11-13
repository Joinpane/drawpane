import { type Op, type Props, ROOT_ID } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import {
  gridCellAt,
  gridGeometry,
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

  it("produces no ops when nothing changes", () => {
    const { doc } = setup({ layoutMode: "row", gap: 10 }, [{}, {}]);
    expect(layoutOps(doc, ["f"])).toEqual([]);
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
