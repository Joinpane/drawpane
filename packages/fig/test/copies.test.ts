/**
 * Copies as Figma saved them: the sizes and places Figma worked out for an
 * instance's layers (`derivedSymbolData`), and what an instance put in a
 * component's slot, with the ids Figma gives it.
 *
 * Each case is a page of records added to a committed sample (Open
 * Pencil's `patchFigArchive`), saved the way Figma saves them, and read
 * alone.
 */
import { readFileSync } from "node:fs";
import type { Figma } from "@drawpane/figma";
import { parseFigBuffer, patchFigArchive } from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { beforeAll, describe, expect, it } from "vitest";
import { openFig } from "../src";

const guid = (localID: number) => ({ sessionID: 900, localID });
const id = (localID: number) => `900:${localID}`;
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const BLACK = {
  type: "SOLID",
  color: { r: 0, g: 0, b: 0, a: 1 },
  opacity: 1,
  visible: true,
  blendMode: "NORMAL",
};

/** A layer record: its guid, parent and place among its siblings, kind and box. */
function layer(
  localID: number,
  parent: { sessionID: number; localID: number },
  position: string,
  type: string,
  fields: Record<string, unknown> & { size: { x: number; y: number } },
): NodeChange {
  return {
    guid: guid(localID),
    phase: "CREATED",
    parentIndex: { guid: parent, position },
    type,
    name: `${type} ${localID}`,
    visible: true,
    opacity: 1,
    transform: at(0, 0),
    strokeWeight: 1,
    strokeAlign: "INSIDE",
    strokeJoin: "MITER",
    ...fields,
  } as unknown as NodeChange;
}

function text(
  localID: number,
  parent: { sessionID: number; localID: number },
  position: string,
  characters: string,
  fields: Record<string, unknown> & { size: { x: number; y: number } },
): NodeChange {
  return layer(localID, parent, position, "TEXT", {
    fontSize: 14,
    fontName: { family: "Inter", style: "Regular", postscript: "Inter-Regular" },
    lineHeight: { value: 20, units: "PIXELS" },
    letterSpacing: { value: 0, units: "PERCENT" },
    textData: { characters },
    textAutoResize: "WIDTH_AND_HEIGHT",
    fillPaints: [BLACK],
    ...fields,
  });
}

const slotAssignment = (property: number, content: number) => ({
  defID: guid(property),
  value: {},
  varValue: {
    value: { slotContentIdValue: { guid: guid(content) } },
    dataType: "SLOT_CONTENT_ID",
    resolvedDataType: "SLOT_CONTENT_ID",
  },
});

const PAGE = guid(1);
const INTERNAL = { sessionID: 0, localID: 2 };

const records: NodeChange[] = [
  {
    guid: PAGE,
    phase: "CREATED",
    parentIndex: { guid: { sessionID: 0, localID: 0 }, position: "~~~" },
    type: "CANVAS",
    name: "Copies",
    visible: true,
    opacity: 1,
  } as unknown as NodeChange,

  // An icon placeholder: 24 square, its icon scaling across and pinned to the top.
  layer(10, PAGE, "!", "SYMBOL", { size: { x: 24, y: 24 }, fillPaints: [] }),
  layer(11, guid(10), "!", "RECTANGLE", {
    size: { x: 24, y: 24 },
    fillPaints: [BLACK],
    horizontalConstraint: "SCALE",
    verticalConstraint: "MIN",
  }),
  // Shrunk to 16 square: Figma saves its icon at 16 square too.
  layer(12, PAGE, '"', "INSTANCE", {
    size: { x: 16, y: 16 },
    transform: at(100, 0),
    symbolData: { symbolID: guid(10), symbolOverrides: [], uniformScaleFactor: 1 },
    derivedSymbolData: [
      { guidPath: { guids: [guid(11)] }, size: { x: 16, y: 16 }, transform: at(0, 0) },
    ],
  }),

  // A label whose text a copy overrides: Figma saves the width the new text takes.
  layer(20, PAGE, "#", "SYMBOL", { size: { x: 16, y: 20 }, transform: at(0, 100), fillPaints: [] }),
  text(21, guid(20), "!", "Hi", { size: { x: 16, y: 20 } }),
  layer(22, PAGE, "$", "INSTANCE", {
    size: { x: 82, y: 20 },
    transform: at(100, 100),
    symbolData: {
      symbolID: guid(20),
      symbolOverrides: [
        { guidPath: { guids: [guid(21)] }, textData: { characters: "Hello there" } },
      ],
      uniformScaleFactor: 1,
    },
    derivedSymbolData: [
      { guidPath: { guids: [guid(21)] }, size: { x: 82, y: 20 }, transform: at(0, 0) },
    ],
  }),

  // A card with a slot (property 900:3) holding a default label.
  layer(30, PAGE, "%", "SYMBOL", {
    size: { x: 120, y: 40 },
    transform: at(0, 200),
    fillPaints: [],
    stackMode: "VERTICAL",
    stackVerticalPadding: 8,
    stackHorizontalPadding: 8,
    stackPaddingRight: 8,
    stackPaddingBottom: 8,
  }),
  layer(31, guid(30), "!", "FRAME", {
    size: { x: 104, y: 24 },
    transform: at(8, 8),
    fillPaints: [],
    componentPropRefs: [{ defID: guid(3), componentPropNodeField: "SLOT_CONTENT_ID" }],
  }),
  text(32, guid(31), "!", "Default", { size: { x: 50, y: 20 } }),
  // And an icon in its default content.
  layer(34, guid(31), '"', "INSTANCE", {
    size: { x: 24, y: 24 },
    symbolData: { symbolID: guid(10), symbolOverrides: [], uniformScaleFactor: 1 },
  }),
  // What a copy of it puts in the slot, saved on the internal page.
  layer(40, INTERNAL, "~~~0", "FRAME", {
    size: { x: 104, y: 24 },
    fillPaints: [],
    isSlotContent: true,
  }),
  text(41, guid(40), "!", "Assigned", { size: { x: 60, y: 20 } }),
  // The copy, taller than its main: Figma lays the slot out 16 down.
  layer(33, PAGE, "&", "INSTANCE", {
    size: { x: 120, y: 56 },
    transform: at(200, 200),
    symbolData: { symbolID: guid(30), symbolOverrides: [], uniformScaleFactor: 1 },
    componentPropAssignments: [slotAssignment(3, 40)],
    derivedSymbolData: [
      { guidPath: { guids: [guid(31)] }, size: { x: 104, y: 24 }, transform: at(8, 16) },
    ],
  }),

  // A main that nests a card and fills its slot itself, and a copy of that main.
  layer(50, PAGE, "'", "SYMBOL", {
    size: { x: 140, y: 60 },
    transform: at(0, 300),
    fillPaints: [],
  }),
  layer(51, guid(50), "!", "INSTANCE", {
    size: { x: 120, y: 40 },
    transform: at(10, 10),
    symbolData: { symbolID: guid(30), symbolOverrides: [], uniformScaleFactor: 1 },
    componentPropAssignments: [slotAssignment(3, 60)],
  }),
  layer(60, INTERNAL, "~~~1", "FRAME", {
    size: { x: 104, y: 24 },
    fillPaints: [],
    isSlotContent: true,
  }),
  text(61, guid(60), "!", "Nested", { size: { x: 50, y: 20 } }),
  layer(52, PAGE, "(", "INSTANCE", {
    size: { x: 140, y: 60 },
    transform: at(200, 300),
    symbolData: { symbolID: guid(50), symbolOverrides: [], uniformScaleFactor: 1 },
  }),

  // A main that nests a card leaving its slot as it is, and a copy of that main.
  layer(70, PAGE, ")", "SYMBOL", {
    size: { x: 140, y: 60 },
    transform: at(0, 400),
    fillPaints: [],
  }),
  layer(71, guid(70), "!", "INSTANCE", {
    size: { x: 120, y: 40 },
    transform: at(10, 10),
    symbolData: { symbolID: guid(30), symbolOverrides: [], uniformScaleFactor: 1 },
  }),
  layer(72, PAGE, "*", "INSTANCE", {
    size: { x: 140, y: 60 },
    transform: at(200, 400),
    symbolData: { symbolID: guid(70), symbolOverrides: [], uniformScaleFactor: 1 },
  }),
];

/** Every node of a REST file by id. */
function byId(node: Figma.Node, out = new Map<string, Figma.Node>()) {
  out.set(node.id, node);
  for (const c of node.children ?? []) byId(c, out);
  return out;
}

describe("copies as Figma saved them", { timeout: 60_000 }, () => {
  let nodes: Map<string, Figma.Node>;
  beforeAll(async () => {
    const sample = new Uint8Array(readFileSync(new URL("./fixtures/pattern.fig", import.meta.url)));
    const parsed = parseFigBuffer(sample.slice().buffer as ArrayBuffer);
    const bytes = patchFigArchive(
      sample.slice().buffer as ArrayBuffer,
      { records, fields: [], blobs: [], removed: [], replaceVariables: false },
      {
        thumbnailPNG: parsed.thumbnailPNG ?? new Uint8Array(),
        metaJSON: parsed.metaJSON ?? "{}",
        images: [],
      },
    );
    const fig = await openFig(bytes);
    const read = await fig.read({ pageIds: [id(1)] });
    nodes = byId(read.file.document);
  });

  it("keeps the size Figma saved for a nested layer, not one constraints work out per axis", () => {
    // Its constraint scales it across only: worked out from the main, it'd be 16 by 24.
    expect(nodes.get(`I${id(12)};${id(11)}`)?.size).toEqual({ x: 16, y: 16 });
  });

  it("keeps the width Figma measured for overridden text, not the main's", () => {
    const label = nodes.get(`I${id(22)};${id(21)}`);
    expect(label?.characters).toBe("Hello there");
    expect(label?.size?.x).toBe(82);
  });

  it("places a slot where Figma laid it out in the copy", () => {
    const slot = nodes.get(`I${id(33)};${id(31)}`);
    expect(slot?.relativeTransform?.[1]?.[2]).toBe(16);
  });

  it("names a copy's slot content under the slot, as Figma does", () => {
    const slot = nodes.get(`I${id(33)};${id(31)}`);
    expect(slot?.children?.map((c) => [c.id, c.characters])).toEqual([
      [`I${id(33)};${id(31)};${id(41)}`, "Assigned"],
    ]);
  });

  it("names the default content of a slot in a copy's nested instance after the main's layers", () => {
    const slot = nodes.get(`I${id(72)};${id(71)};${id(31)}`);
    expect(slot?.children?.map((c) => c.id)).toEqual([
      `I${id(72)};${id(71)};${id(32)}`,
      `I${id(72)};${id(71)};${id(34)}`,
    ]);
  });

  it("names a main's own slot content under the slot in the main, and without it in a copy", () => {
    // In the main, the instance that fills the slot is a saved layer.
    const own = nodes.get(`I${id(51)};${id(31)}`);
    expect(own?.children?.map((c) => [c.id, c.characters])).toEqual([
      [`I${id(51)};${id(31)};${id(61)}`, "Nested"],
    ]);
    // In a copy of the main, it's a copy too.
    const copied = nodes.get(`I${id(52)};${id(51)};${id(31)}`);
    expect(copied?.children?.map((c) => [c.id, c.characters])).toEqual([
      [`I${id(52)};${id(51)};${id(61)}`, "Nested"],
    ]);
  });
});
