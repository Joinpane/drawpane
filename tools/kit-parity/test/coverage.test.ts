import { describe, expect, it } from "vitest";
import {
  type FeatureResult,
  figmaIdOf,
  measureCoverage,
  type Obj,
  type OutNode,
  styleWeight,
} from "../src/coverage";

const guid = (s: number, l: number) => ({ sessionID: s, localID: l });
const under = (parent: { sessionID: number; localID: number }, position = "a") => ({
  parentIndex: { guid: parent, position },
});
const PAGE = guid(0, 1);
const INTERNAL = guid(0, 2);

/** A small file: a page, the internal page with a collection and a variable, and some layers. */
const records: Obj[] = [
  { guid: guid(0, 0), type: "DOCUMENT" },
  { guid: PAGE, type: "CANVAS", name: "Page", ...under(guid(0, 0)) },
  { guid: INTERNAL, type: "CANVAS", name: "Internal", internalOnly: true, ...under(guid(0, 0)) },
  {
    guid: guid(1, 100),
    type: "VARIABLE_SET",
    name: "Theme",
    variableSetModes: [
      { id: guid(1, 0), name: "Light" },
      { id: guid(1, 1), name: "Dark" },
    ],
    ...under(INTERNAL),
  },
  {
    guid: guid(1, 101),
    type: "VARIABLE",
    name: "color/primary",
    variableResolvedType: "COLOR",
    variableSetID: { guid: guid(1, 100) },
    ...under(INTERNAL),
  },
  {
    guid: guid(1, 102),
    type: "VARIABLE",
    name: "space/2",
    variableResolvedType: "FLOAT",
    variableSetID: { guid: guid(1, 100) },
    ...under(INTERNAL),
  },
  {
    guid: guid(1, 1),
    type: "FRAME",
    name: "Card",
    stackMode: "HORIZONTAL",
    effects: [{ type: "DROP_SHADOW", radius: 4, offset: { x: 0, y: 2 }, spread: 0 }],
    fillPaints: [{ type: "SOLID", colorVar: { value: { alias: { guid: guid(1, 101) } } } }],
    variableConsumptionMap: {
      entries: [
        {
          variableField: "STACK_SPACING",
          variableData: { value: { alias: { guid: guid(1, 102) } } },
        },
      ],
    },
    ...under(PAGE),
  },
  {
    guid: guid(1, 2),
    type: "TEXT",
    name: "Label",
    fontName: { family: "Inter", style: "Semi Bold" },
    textCase: "UPPER",
    ...under(guid(1, 3)),
  },
  {
    guid: guid(1, 3),
    type: "SYMBOL",
    name: "Button",
    componentPropDefs: [{ id: guid(2, 1), name: "Show icon", type: "BOOL" }],
    ...under(PAGE, "b"),
  },
  {
    guid: guid(1, 4),
    type: "FRAME",
    name: "Field",
    effects: [{ type: "INNER_SHADOW", radius: 2, offset: { x: 0, y: 1 } }],
    ...under(PAGE, "c"),
  },
  {
    guid: guid(9, 9),
    type: "INSTANCE",
    name: "Button",
    symbolData: { symbolID: guid(1, 3), symbolOverrides: [] },
    ...under(PAGE, "d"),
  },
];

const output: OutNode[] = [
  { id: "f0-1", type: "page", parent: "root", props: { name: "Page" } },
  {
    id: "f1-1",
    type: "frame",
    parent: "f0-1",
    props: {
      name: "Card",
      layoutMode: "row",
      fills: [{ type: "solid", color: "#ff0000" }],
      effects: [{ type: "drop-shadow", x: 0, y: 2, blur: 4, spread: 0, color: "#000000" }],
    },
  },
  { id: "f1-3", type: "frame", parent: "f0-1", props: { name: "Button", isComponent: true } },
  {
    id: "f1-2",
    type: "text",
    parent: "f1-3",
    props: { name: "Label", fontFamily: "Inter", fontWeight: 600, textCase: "upper" },
  },
  { id: "f1-4", type: "frame", parent: "f0-1", props: { name: "Field" } },
  { id: "f9-9", type: "frame", parent: "f0-1", props: { name: "Button", instanceOf: "f1-3" } },
  {
    id: "fI9-9_1-2",
    type: "text",
    parent: "f9-9",
    props: { name: "Label", mirrors: "f1-2", overrides: ["width"] },
  },
];

async function run(): Promise<Map<string, FeatureResult>> {
  const result = await measureCoverage(records, output);
  return new Map(result.features.map((f) => [f.key, f]));
}

describe("coverage", () => {
  it("judges each feature on the converted output", async () => {
    const f = await run();
    expect(f.get("effect/DROP_SHADOW")?.status).toBe("faithful");
    expect(f.get("effect/INNER_SHADOW")?.status).toBe("lost");
    expect(f.get("layout/HORIZONTAL")?.status).toBe("faithful");
    expect(f.get("font/Inter/Semi Bold")?.status).toBe("faithful");
    expect(f.get("text/case/UPPER")?.status).toBe("faithful");
    // Bound values come through baked: the look, not the binding.
    expect(f.get("bound/STACK_SPACING")?.status).toBe("approximate");
    expect(f.get("bound/paint.fill")?.status).toBe("approximate");
    // No collection, variable or boolean property in the output.
    expect(f.get("variables/collection")?.status).toBe("lost");
    expect(f.get("variables/collection-modes")?.status).toBe("lost");
    expect(f.get("variables/type/COLOR")?.status).toBe("lost");
    expect(f.get("props/definition/BOOL")?.status).toBe("lost");
  });

  it("counts a component's layer once for itself and once per copy", async () => {
    const f = await run();
    expect(f.get("font/Inter/Semi Bold")?.layers).toBe(2);
    expect(f.get("effect/DROP_SHADOW")?.layers).toBe(1);
  });

  it("counts what a collection, variable or property definition reaches", async () => {
    const f = await run();
    // The card binds its fill and its gap to two of the collection's variables: one layer.
    expect(f.get("variables/collection")?.layers).toBe(1);
    expect(f.get("variables/type/COLOR")?.layers).toBe(1);
    // The button's property reaches its one instance.
    expect(f.get("props/definition/BOOL")?.layers).toBe(1);
  });

  it("ranks gaps by impact", async () => {
    const result = await measureCoverage(records, output);
    const impacts = result.features.map((x) => x.impact);
    expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
    expect(result.features.find((x) => x.key === "effect/INNER_SHADOW")?.impact).toBe(3);
  });

  it("finds overrides a copy lists that Figma never saved", async () => {
    const result = await measureCoverage(records, output);
    expect(result.overrides.unexplained).toBe(1);
    expect(result.overrides.examples[0]).toEqual({ id: "I9:9;1:2", unexplained: ["width"] });
  });

  it("reads ids and font styles", () => {
    expect(figmaIdOf("fI1-2_3-4")).toBe("I1:2;3:4");
    expect(figmaIdOf("f12-3")).toBe("12:3");
    expect(figmaIdOf("fI1-2_3-4_ab12")).toBeNull();
    expect(styleWeight("Semi Bold Italic")).toEqual({ weight: 600, italic: true });
    expect(styleWeight("ExtraLight")).toEqual({ weight: 200, italic: false });
    expect(styleWeight("Regular")).toEqual({ weight: 400, italic: false });
  });
});

describe("readNodes", () => {
  it("splits lines on newlines only, not on the line separators text can hold", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { readNodes } = await import("../src/coverage");
    const file = join(mkdtempSync(join(tmpdir(), "coverage-")), "nodes.ndjson");
    const nodes = [
      { id: "f1-1", type: "text", parent: "f0-1", props: { characters: "a b c" } },
      { id: "f1-2", type: "frame", parent: "f0-1", props: {} },
    ];
    writeFileSync(file, `${nodes.map((n) => JSON.stringify(n)).join("\n")}\n`);
    const read = [];
    for await (const n of readNodes(file)) read.push(n);
    expect(read).toEqual(nodes);
  });
});

describe("per-layer values", () => {
  it("compares each layer with its own record, not the first one found", async () => {
    const page = { guid: { sessionID: 0, localID: 1 }, type: "CANVAS", name: "Page" };
    const layer = (local: number, opacity: number) => ({
      guid: { sessionID: 1, localID: local },
      type: "ROUNDED_RECTANGLE",
      name: "Box",
      opacity,
      rectangleCornerRadiiIndependent: true,
      rectangleTopLeftCornerRadius: local,
      rectangleTopRightCornerRadius: local,
      rectangleBottomRightCornerRadius: local,
      rectangleBottomLeftCornerRadius: local,
      parentIndex: { guid: page.guid, position: `${local}` },
    });
    const result = await measureCoverage(
      [page, layer(1, 0.5), layer(2, 0.25)],
      [
        { id: "f0-1", type: "page", parent: "root", props: {} },
        { id: "f1-1", type: "rect", parent: "f0-1", props: { opacity: 0.5, cornerRadius: 1 } },
        { id: "f1-2", type: "rect", parent: "f0-1", props: { opacity: 0.25, cornerRadius: 2 } },
      ],
    );
    const f = new Map(result.features.map((x) => [x.key, x]));
    expect(f.get("layer/opacity")?.faithful).toBe(2);
    // Four equal corners come through as one radius.
    expect(f.get("corners/independent")?.faithful).toBe(2);
  });
});
