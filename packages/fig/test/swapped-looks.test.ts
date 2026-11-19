/**
 * A nested instance swapped to another component takes the new component's
 * look, except what it overrides: an outline button swapped for a filled
 * one fills, and loses the outline's border.
 */
import { SceneGraph, type SceneNode } from "@open-pencil/scene-graph";
import { describe, expect, it } from "vitest";
import type { RestIds } from "../src/ids";
import type { RawRecord } from "../src/raw";
import { applySwappedLooks } from "../src/swaps";

const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const DARK = { r: 0.09, g: 0.09, b: 0.09, a: 1 };
const RED = { r: 1, g: 0, b: 0, a: 1 };
const solid = (color: typeof WHITE) =>
  [{ type: "SOLID", color, opacity: 1, visible: true, blendMode: "NORMAL" }] as SceneNode["fills"];

function scene(copyProps: Partial<SceneNode> = {}) {
  const graph = new SceneGraph();
  const page =
    graph.getPages(true)[0] ?? graph.createNode("CANVAS", graph.rootId, { name: "Page" });
  const outline = graph.createNode("COMPONENT", page.id, {
    name: "Variant=outline",
    fills: solid(WHITE),
    strokes: [
      {
        color: { r: 0.9, g: 0.9, b: 0.9, a: 1 },
        weight: 1,
        opacity: 1,
        visible: true,
        align: "INSIDE",
      },
    ] as SceneNode["strokes"],
    cornerRadius: 6,
  });
  const filled = graph.createNode("COMPONENT", page.id, {
    name: "Variant=default",
    fills: solid(DARK),
    strokes: [],
    cornerRadius: 6,
  });
  // The copy, swapped to the filled variant, still with the outline's own properties.
  const copy = graph.createNode("INSTANCE", page.id, {
    name: "Button",
    componentId: filled.id,
    fills: solid(WHITE),
    strokes: outline.strokes,
    cornerRadius: 6,
    ...copyProps,
  });
  const guids = new Map<string, string>([
    [outline.id, "1:1"],
    [filled.id, "1:2"],
    [copy.id, "9:9"],
  ]);
  const ids = { sourceGuid: (n: SceneNode) => guids.get(n.id) ?? null } as unknown as RestIds;
  // The record the copy comes from names the outline variant.
  const records = new Map<string, RawRecord>([
    ["9:9", { symbolData: { symbolID: { sessionID: 1, localID: 1 } } } as RawRecord],
  ]);
  const layers = new Map([
    ["1:1", outline.id],
    ["1:2", filled.id],
  ]);
  return { graph, copy, ids, records, layers };
}

describe("swapped nested instances", () => {
  it("take the swapped-in component's fills and strokes", () => {
    const { graph, copy, ids, records, layers } = scene();
    expect(applySwappedLooks(graph, ids, records, layers)).toBe(1);
    const after = graph.getNode(copy.id) as SceneNode;
    expect(after.fills[0]?.color).toEqual(DARK);
    expect(after.strokes).toEqual([]);
  });

  it("keep what they override", () => {
    // A red fill the instance set itself: not the old component's, so it stays.
    const { graph, copy, ids, records, layers } = scene({ fills: solid(RED) });
    applySwappedLooks(graph, ids, records, layers);
    const after = graph.getNode(copy.id) as SceneNode;
    expect(after.fills[0]?.color).toEqual(RED);
    expect(after.strokes).toEqual([]);
  });

  it("take the swapped-in component's auto layout, keeping what they override", () => {
    const { graph, copy, ids, records, layers } = scene({
      layoutMode: "HORIZONTAL",
      paddingTop: 4,
      itemSpacing: 6,
      // Set by the instance itself: not the old component's, so it stays.
      paddingLeft: 20,
    });
    const [outline, filled] = [...layers.values()];
    graph.updateNode(outline as string, {
      layoutMode: "HORIZONTAL",
      paddingTop: 4,
      itemSpacing: 6,
      paddingLeft: 12,
    });
    graph.updateNode(filled as string, {
      layoutMode: "VERTICAL",
      paddingTop: 8,
      itemSpacing: 10,
      paddingLeft: 12,
    });
    applySwappedLooks(graph, ids, records, layers);
    const after = graph.getNode(copy.id) as SceneNode;
    expect([after.layoutMode, after.paddingTop, after.itemSpacing, after.paddingLeft]).toEqual([
      "VERTICAL",
      8,
      10,
      20,
    ]);
  });

  it("leave instances that weren't swapped alone", () => {
    const { graph, copy, ids, records, layers } = scene();
    // Its record names the component it shows: no swap.
    records.set("9:9", { symbolData: { symbolID: { sessionID: 1, localID: 2 } } } as RawRecord);
    expect(applySwappedLooks(graph, ids, records, layers)).toBe(0);
    expect((graph.getNode(copy.id) as SceneNode).fills[0]?.color).toEqual(WHITE);
  });
});
