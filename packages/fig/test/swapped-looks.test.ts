/**
 * A nested instance swapped to another component takes the new component's
 * look, except what it overrides: an outline button swapped for a filled
 * one fills, and loses the outline's border.
 */
import { SceneGraph, type SceneNode } from "@open-pencil/scene-graph";
import { describe, expect, it } from "vitest";
import { adaptNode, localMatrix } from "../src/adapt";
import { RestIds } from "../src/ids";
import { FigNotes } from "../src/notes";
import type { RawRecord } from "../src/raw";
import { applySwappedLooks } from "../src/swaps";
import { layerBoundVariables } from "../src/tokens";

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

  it("takes the chosen variant's layout binding when the old one resolves in another mode", () => {
    const { graph, copy, ids, records, layers } = scene();
    const collection = graph.createCollection("Style");
    const mode = graph.createMode(collection.id, "Spacious") as string;
    const regular = graph.createVariable("Regular padding", "FLOAT", collection.id, 10);
    const compact = graph.createVariable("Compact padding", "FLOAT", collection.id, 8);
    regular.valuesByMode[mode] = 24;
    compact.valuesByMode[mode] = 16;
    const [outline, filled] = [...layers.values()] as [string, string];
    graph.updateNode(outline, { paddingLeft: 10, boundVariables: { paddingLeft: regular.id } });
    graph.updateNode(filled, { paddingLeft: 8, boundVariables: { paddingLeft: compact.id } });
    graph.updateNode(copy.id, {
      width: 134,
      paddingLeft: 24,
      boundVariables: { paddingLeft: regular.id },
      variableModes: { [collection.id]: mode },
    });

    applySwappedLooks(graph, ids, records, layers);

    expect(graph.getNode(copy.id)).toMatchObject({
      width: 134,
      paddingLeft: 16,
      boundVariables: { paddingLeft: compact.id },
    });
  });

  it("leave instances that weren't swapped alone", () => {
    const { graph, copy, ids, records, layers } = scene();
    // Its record names the component it shows: no swap.
    records.set("9:9", { symbolData: { symbolID: { sessionID: 1, localID: 2 } } } as RawRecord);
    expect(applySwappedLooks(graph, ids, records, layers)).toBe(0);
    expect((graph.getNode(copy.id) as SceneNode).fills[0]?.color).toEqual(WHITE);
  });
});

it("inherits padding from the chosen variant when the copy omitted the old binding", () => {
  const { graph, copy, ids, records, layers } = scene({ paddingLeft: 10 });
  const collection = graph.createCollection("Style");
  const regular = graph.createVariable("Regular padding", "FLOAT", collection.id, 10);
  const compact = graph.createVariable("Compact padding", "FLOAT", collection.id, 8);
  const [outline, filled] = [...layers.values()] as [string, string];
  graph.updateNode(outline, { paddingLeft: 10, boundVariables: { paddingLeft: regular.id } });
  graph.updateNode(filled, { paddingLeft: 8, boundVariables: { paddingLeft: compact.id } });

  applySwappedLooks(graph, ids, records, layers);

  expect(graph.getNode(copy.id)).toMatchObject({
    paddingLeft: 8,
    boundVariables: { paddingLeft: compact.id },
  });
});

it("keeps padding bound to an independently authored token that happens to match in the saved mode", () => {
  const { graph, copy, ids, records, layers } = scene();
  const collection = graph.createCollection("Style");
  const regular = graph.createVariable("Regular padding", "FLOAT", collection.id, 10);
  const custom = graph.createVariable("Custom padding", "FLOAT", collection.id, 10);
  const compact = graph.createVariable("Compact padding", "FLOAT", collection.id, 8);
  const [outline, filled] = [...layers.values()] as [string, string];
  graph.updateNode(outline, { paddingLeft: 10, boundVariables: { paddingLeft: regular.id } });
  graph.updateNode(filled, { paddingLeft: 8, boundVariables: { paddingLeft: compact.id } });
  graph.updateNode(copy.id, { paddingLeft: 10, boundVariables: { paddingLeft: custom.id } });
  applySwappedLooks(graph, ids, records, layers);
  expect(graph.getNode(copy.id)).toMatchObject({
    paddingLeft: 10,
    boundVariables: { paddingLeft: custom.id },
  });
});

it("carries an inherited layout expression into the selected variant", () => {
  const { graph, copy, ids, records, layers } = scene();
  const collection = graph.createCollection("Style");
  const mode = graph.createMode(collection.id, "Wide") as string;
  const regular = graph.createVariable("Regular padding", "FLOAT", collection.id, 10);
  const compact = graph.createVariable("Compact padding", "FLOAT", collection.id, 8);
  compact.valuesByMode[mode] = 12;
  const [outline, filled] = [...layers.values()] as [string, string];
  graph.updateNode(outline, {
    paddingLeft: 10,
    paddingRight: 5,
    boundVariables: { paddingLeft: regular.id, paddingRight: regular.id },
    variableBindingScales: { paddingRight: 0.5 },
  });
  graph.updateNode(filled, {
    paddingLeft: 16,
    paddingRight: 3,
    boundVariables: { paddingLeft: compact.id },
    variableBindingScales: { paddingLeft: 2 },
  });
  graph.updateNode(copy.id, {
    paddingLeft: 10,
    paddingRight: 5,
    boundVariables: { paddingLeft: regular.id, paddingRight: regular.id },
    variableBindingScales: { paddingRight: 0.5 },
    variableModes: { [collection.id]: mode },
  });
  applySwappedLooks(graph, ids, records, layers);
  const result = graph.getNode(copy.id);
  expect(result?.paddingLeft).toBe(24);
  expect(result?.paddingRight).toBe(3);
  expect(result?.boundVariables).toEqual({ paddingLeft: compact.id });
  expect(result?.variableBindingScales).toEqual({ paddingLeft: 2 });
});

it("keeps an explicit exclusion of strokes from layout across a swap", () => {
  const { graph, copy, ids, records, layers } = scene();
  const [, filled] = [...layers.values()] as [string, string];
  graph.updateNode(filled, { strokesIncludedInLayout: true });
  applySwappedLooks(
    graph,
    {
      sourceGuid: (node) => ids.sourceGuid(node),
      overridesOf: () => [{ bordersTakeSpace: false }],
    },
    records,
    layers,
  );
  expect(graph.getNode(copy.id)?.strokesIncludedInLayout).toBe(false);
});

it("takes the selected variant's strokes-in-layout setting", () => {
  const { graph, copy, ids, records, layers } = scene();
  const [, filled] = [...layers.values()] as [string, string];
  graph.updateNode(filled, { strokesIncludedInLayout: true });
  applySwappedLooks(graph, ids, records, layers);
  expect(graph.getNode(copy.id)?.strokesIncludedInLayout).toBe(true);
});

it("carries counterAxisAlignContent from the selected variant and respects explicit overrides", () => {
  const { graph, copy, ids, records, layers } = scene();
  const [, filled] = [...layers.values()] as [string, string];
  graph.updateNode(filled, { counterAxisAlignContent: "SPACE_BETWEEN" });
  applySwappedLooks(graph, ids, records, layers);
  expect(graph.getNode(copy.id)?.counterAxisAlignContent).toBe("SPACE_BETWEEN");

  const over = scene();
  const [, filledOver] = [...over.layers.values()] as [string, string];
  over.graph.updateNode(filledOver, { counterAxisAlignContent: "SPACE_BETWEEN" });
  applySwappedLooks(
    over.graph,
    {
      sourceGuid: (node) => over.ids.sourceGuid(node),
      overridesOf: () => [{ stackCounterAlignContent: "AUTO" }],
    },
    over.records,
    over.layers,
  );
  expect(over.graph.getNode(over.copy.id)?.counterAxisAlignContent).toBe("AUTO");
});

it("keeps an independently authored multiplier even when its saved number equals the old main", () => {
  const { graph, copy, ids, records, layers } = scene();
  const collection = graph.createCollection("Spacing");
  const wide = graph.createMode(collection.id, "Wide") as string;
  const regular = graph.createVariable("Regular", "FLOAT", collection.id, 10);
  regular.valuesByMode[wide] = 5;
  const compact = graph.createVariable("Compact", "FLOAT", collection.id, 8);
  const [oldId, newId] = [...layers.values()] as [string, string];
  graph.updateNode(oldId, { paddingLeft: 10, boundVariables: { paddingLeft: regular.id } });
  graph.updateNode(newId, { paddingLeft: 8, boundVariables: { paddingLeft: compact.id } });
  graph.updateNode(copy.id, {
    paddingLeft: 10,
    boundVariables: { paddingLeft: regular.id },
    variableBindingScales: { paddingLeft: 2 },
    variableModes: { [collection.id]: wide },
  });
  applySwappedLooks(graph, ids, records, layers);
  expect(graph.getNode(copy.id)).toMatchObject({
    paddingLeft: 10,
    boundVariables: { paddingLeft: regular.id },
    variableBindingScales: { paddingLeft: 2 },
  });
});

it("takes an inherited padding binding through a swap at 2x instance scale", () => {
  const { graph, copy, ids, records, layers } = scene();
  const collection = graph.createCollection("Spacing");
  const regular = graph.createVariable("Regular", "FLOAT", collection.id, 10);
  const compact = graph.createVariable("Compact", "FLOAT", collection.id, 8);
  const [oldId, newId] = [...layers.values()] as [string, string];
  graph.updateNode(oldId, { paddingLeft: 10, boundVariables: { paddingLeft: regular.id } });
  graph.updateNode(newId, { paddingLeft: 8, boundVariables: { paddingLeft: compact.id } });
  graph.updateNode(copy.id, {
    paddingLeft: 20,
    componentScale: 2,
    boundVariables: { paddingLeft: regular.id },
    variableBindingScales: { paddingLeft: 2 },
  });
  applySwappedLooks(graph, ids, records, layers);
  const result = graph.getNode(copy.id) as SceneNode;
  expect(result.paddingLeft).toBe(16);
  expect(result.boundVariables.paddingLeft).toBe(compact.id);
  expect(result.variableBindingScales.paddingLeft).toBe(2);
  expect(
    layerBoundVariables(result, (id) =>
      typeof id === "string" ? { type: "VARIABLE_ALIAS", id } : undefined,
    ),
  ).toBeUndefined();
});

it("keeps the selected mode's scaled stroke weight as the adapter's literal fallback", () => {
  const { graph, copy, ids, records, layers } = scene({ strokeWeight: 10 });
  const collection = graph.createCollection("Strokes");
  const wide = graph.createMode(collection.id, "Wide") as string;
  const regular = graph.createVariable("Regular", "FLOAT", collection.id, 10);
  const compact = graph.createVariable("Compact", "FLOAT", collection.id, 8);
  compact.valuesByMode[wide] = 12;
  const [oldId, newId] = [...layers.values()] as [string, string];
  graph.updateNode(oldId, { strokeWeight: 10, boundVariables: { strokeWeight: regular.id } });
  graph.updateNode(newId, {
    strokeWeight: 16,
    strokes: [
      { color: DARK, weight: 16, opacity: 1, visible: true, align: "INSIDE" },
    ] as SceneNode["strokes"],
    boundVariables: { strokeWeight: compact.id },
    variableBindingScales: { strokeWeight: 2 },
  });
  graph.updateNode(copy.id, {
    boundVariables: { strokeWeight: regular.id },
    variableModes: { [collection.id]: wide },
  });
  applySwappedLooks(graph, ids, records, layers);

  const result = graph.getNode(copy.id) as SceneNode;
  const parent = graph.getNode(result.parentId as string) as SceneNode;
  const converted = adaptNode(result, parent, localMatrix(parent), {
    graph,
    ids: new RestIds(graph, layers),
    records,
    notes: new FigNotes(),
    aliasOf: (id) => (typeof id === "string" ? { type: "VARIABLE_ALIAS", id } : undefined),
  });
  expect(converted.boundVariables?.strokeWeight).toBeUndefined();
  expect(converted.strokeWeight).toBe(24);
});

it("writes a placed padding fallback once when the chosen variant has a multiplier", () => {
  const { graph, copy, ids, records, layers } = scene({ paddingLeft: 10 });
  const collection = graph.createCollection("Spacing");
  const wide = graph.createMode(collection.id, "Wide") as string;
  const regular = graph.createVariable("Regular", "FLOAT", collection.id, 10);
  const compact = graph.createVariable("Compact", "FLOAT", collection.id, 8);
  compact.valuesByMode[wide] = 12;
  const [oldId, newId] = [...layers.values()] as [string, string];
  graph.updateNode(oldId, { paddingLeft: 10, boundVariables: { paddingLeft: regular.id } });
  graph.updateNode(newId, {
    paddingLeft: 16,
    boundVariables: { paddingLeft: compact.id },
    variableBindingScales: { paddingLeft: 2 },
  });
  graph.updateNode(copy.id, {
    boundVariables: { paddingLeft: regular.id },
    variableModes: { [collection.id]: wide },
  });
  applySwappedLooks(graph, ids, records, layers);
  const result = graph.getNode(copy.id) as SceneNode;
  expect(result.paddingLeft).toBe(24);
  expect(
    layerBoundVariables(result, (id) =>
      typeof id === "string" ? { type: "VARIABLE_ALIAS", id } : undefined,
    ),
  ).toBeUndefined();
});

it("preserves explicit scaled padding on a 2x source instance record even when it equals old main times scale", () => {
  const { graph, copy, ids, records, layers } = scene();
  const [oldId, newId] = [...layers.values()] as [string, string];
  graph.updateNode(oldId, { paddingLeft: 10 });
  graph.updateNode(newId, { paddingLeft: 8 });
  graph.updateNode(copy.id, { paddingLeft: 20, componentScale: 2 });
  records.set("9:9", {
    symbolData: { symbolID: { sessionID: 1, localID: 1 } },
    stackHorizontalPadding: 20,
  } as RawRecord);

  applySwappedLooks(graph, ids, records, layers);

  expect(graph.getNode(copy.id)?.paddingLeft).toBe(20);
});

it("preserves explicit scaled padding from a source instance root claim at 2x scale", () => {
  const { graph, copy, ids, records, layers } = scene();
  const [oldId, newId] = [...layers.values()] as [string, string];
  graph.updateNode(oldId, { paddingLeft: 10 });
  graph.updateNode(newId, { paddingLeft: 8 });
  graph.updateNode(copy.id, { paddingLeft: 20, componentScale: 2 });
  records.set("9:9", {
    symbolData: {
      symbolID: { sessionID: 1, localID: 1 },
      symbolOverrides: [
        { guidPath: { guids: [{ sessionID: 1, localID: 1 }] }, stackHorizontalPadding: 20 },
      ],
    },
  } as unknown as RawRecord);

  applySwappedLooks(graph, ids, records, layers);

  expect(graph.getNode(copy.id)?.paddingLeft).toBe(20);
});

it("preserves explicit padding on a unit-scale source instance record matching old main", () => {
  const { graph, copy, ids, records, layers } = scene();
  const [oldId, newId] = [...layers.values()] as [string, string];
  graph.updateNode(oldId, { paddingLeft: 10 });
  graph.updateNode(newId, { paddingLeft: 8 });
  graph.updateNode(copy.id, { paddingLeft: 10, componentScale: 1 });
  records.set("9:9", {
    symbolData: { symbolID: { sessionID: 1, localID: 1 } },
    stackHorizontalPadding: 10,
  } as RawRecord);

  applySwappedLooks(graph, ids, records, layers);

  expect(graph.getNode(copy.id)?.paddingLeft).toBe(10);
});

it("preserves explicit legacy stackPadding shorthand on a 2x source instance record", () => {
  const { graph, copy, ids, records, layers } = scene();
  const [oldId, newId] = [...layers.values()] as [string, string];
  graph.updateNode(oldId, {
    paddingTop: 10,
    paddingRight: 10,
    paddingBottom: 10,
    paddingLeft: 10,
  });
  graph.updateNode(newId, {
    paddingTop: 8,
    paddingRight: 8,
    paddingBottom: 8,
    paddingLeft: 8,
  });
  graph.updateNode(copy.id, {
    paddingTop: 20,
    paddingRight: 20,
    paddingBottom: 20,
    paddingLeft: 20,
    componentScale: 2,
  });
  records.set("9:9", {
    symbolData: { symbolID: { sessionID: 1, localID: 1 } },
    stackPadding: 20,
  } as unknown as RawRecord);

  applySwappedLooks(graph, ids, records, layers);

  expect(graph.getNode(copy.id)).toMatchObject({
    paddingTop: 20,
    paddingRight: 20,
    paddingBottom: 20,
    paddingLeft: 20,
  });
});

it("still swaps cached unit-scale padding from oldRecord unless explicitly claimed in root overrides", () => {
  const cached = scene();
  const [cachedOld, cachedNew] = [...cached.layers.values()] as [string, string];
  cached.graph.updateNode(cachedOld, { paddingLeft: 10 });
  cached.graph.updateNode(cachedNew, { paddingLeft: 8 });
  cached.graph.updateNode(cached.copy.id, { paddingLeft: 10, componentScale: 1 });
  cached.records.set("1:1", { stackHorizontalPadding: 10 } as RawRecord);
  cached.records.set("9:9", {
    symbolData: { symbolID: { sessionID: 1, localID: 1 } },
    stackHorizontalPadding: 10,
  } as RawRecord);
  applySwappedLooks(cached.graph, cached.ids, cached.records, cached.layers);
  expect(cached.graph.getNode(cached.copy.id)?.paddingLeft).toBe(8);

  const claimed = scene();
  const [claimedOld, claimedNew] = [...claimed.layers.values()] as [string, string];
  claimed.graph.updateNode(claimedOld, { paddingLeft: 10 });
  claimed.graph.updateNode(claimedNew, { paddingLeft: 8 });
  claimed.graph.updateNode(claimed.copy.id, { paddingLeft: 10, componentScale: 1 });
  claimed.records.set("1:1", { stackHorizontalPadding: 10 } as RawRecord);
  claimed.records.set("9:9", {
    symbolData: {
      symbolID: { sessionID: 1, localID: 1 },
      symbolOverrides: [
        { guidPath: { guids: [{ sessionID: 1, localID: 1 }] }, stackHorizontalPadding: 10 },
      ],
    },
    stackHorizontalPadding: 10,
  } as unknown as RawRecord);
  applySwappedLooks(claimed.graph, claimed.ids, claimed.records, claimed.layers);
  expect(claimed.graph.getNode(claimed.copy.id)?.paddingLeft).toBe(10);
});
