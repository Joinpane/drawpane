import { type NodeRecord, ROOT_ID } from "@drawpane/model";
import { expect, it } from "vitest";
import { measureRelayout } from "../src/relayout";

it("counts a moved layer once at a strict half-pixel threshold and resolves the frame's mode", () => {
  const nodes: NodeRecord[] = [
    { id: "p", parent: ROOT_ID, key: "a0", type: "page", props: {} },
    {
      id: "c",
      parent: ROOT_ID,
      key: "a1",
      type: "collection",
      props: {
        modes: [
          { id: "default", name: "Default" },
          { id: "other", name: "Other" },
        ],
      },
    },
    {
      id: "v",
      parent: "c",
      key: "a0",
      type: "variable",
      props: { variableType: "number", values: { default: 2, other: 12 } },
    },
    {
      id: "f",
      parent: "p",
      key: "a0",
      type: "frame",
      props: {
        width: 100,
        height: 100,
        layoutMode: "row",
        paddingLeft: 2,
        variableModes: { c: "other" },
        bindings: { paddingLeft: "v" },
      },
    },
    {
      id: "moved",
      parent: "f",
      key: "a0",
      type: "rect",
      props: { width: 10, height: 10, x: 2, y: 10 },
    },
    {
      id: "within",
      parent: "f",
      key: "a1",
      type: "rect",
      props: { width: 10, height: 10, x: 22.5, y: 0 },
    },
  ];
  const report = measureRelayout(nodes);
  expect(report).toMatchObject({ layers: 3, changed: 1, alreadyChanged: 0, framesAffected: 1 });
  expect(report.frames).toMatchObject([{ id: "f", layers: 3, changed: 1 }]);
  expect(report.causes).toMatchObject([
    {
      count: 1,
      cause: "layer or parent has a different resolved layout input",
      examples: [{ id: "moved", before: [2, 10, 10, 10], after: [12, 0, 10, 10] }],
    },
  ]);
});

it("reports changes below a hidden frame separately from visible drift", () => {
  const nodes: NodeRecord[] = [
    { id: "p", parent: ROOT_ID, key: "a0", type: "page", props: {} },
    {
      id: "hidden",
      parent: "p",
      key: "a0",
      type: "frame",
      props: { layoutMode: "row", visible: false, width: 100, height: 20 },
    },
    {
      id: "child",
      parent: "hidden",
      key: "a0",
      type: "rect",
      props: { x: 5, width: 10, height: 10 },
    },
    { id: "visible", parent: "p", key: "a1", type: "rect", props: { width: 15, height: 15 } },
  ];

  const report = measureRelayout(nodes);

  expect(report).toMatchObject({
    layers: 1,
    changed: 0,
    hiddenLayers: 2,
    hiddenChanged: 1,
    framesAffected: 0,
    causes: [],
  });
  expect(report.frames).toMatchObject([{ id: "hidden", changed: 0, hiddenChanged: 1 }]);
});
