import { type Op, type Props, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { layoutOps, layoutRoots } from "../src/layout";

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
