/**
 * .fig import fidelity fixes for relayout stability:
 * - Instances do not inherit their SYMBOL's own placement-in-parent fields.
 * - variableModeBySetMap overrides merge by collection instead of clobbering other collections.
 * - derivedTextData.layoutSize applies when derivedSymbolData omits entry.size.
 */
import { readFileSync } from "node:fs";
import { convertFile, drawpaneId, type Figma } from "@drawpane/figma";
import { parseFigBuffer, patchFigArchive } from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { describe, expect, it } from "vitest";
import { readFig } from "../src";

const bytes = new Uint8Array(readFileSync(new URL("./fixtures/pattern.fig", import.meta.url)));

type Guid = { sessionID: number; localID: number };
const guid = (localID: number): Guid => ({ sessionID: 940, localID });
const key = (g: Guid) => `${g.sessionID}:${g.localID}`;
const identity = (x = 0, y = 0) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });

function buildArchive() {
  const parsed = parseFigBuffer(bytes.slice().buffer as ArrayBuffer);
  const records = parsed.nodeChanges;
  const setA = records.find((r) => r.type === "VARIABLE_SET") as NodeChange & {
    variableSetModes: { id: Guid }[];
  };
  const page = records.find((r) => r.type === "CANVAS" && !r.internalOnly)?.guid as Guid;
  const internal = setA.parentIndex?.guid as Guid;
  const base = { phase: "CREATED", visible: true, opacity: 1 };

  const setB = guid(1);
  const modeB1 = guid(2);
  const modeB2 = guid(3);
  const varWidth = guid(4);
  const varGap = guid(5);
  const varLabel = guid(6);
  const missingVar = guid(99);

  const symStretched = guid(10);
  const rowParent = guid(11);
  const instUnstretched = guid(12);
  const gridParent = guid(13);
  const gridCol1 = guid(14);
  const gridCol2 = guid(15);
  const gridRow1 = guid(16);
  const gridRow2 = guid(17);
  const instGridPlaced = guid(18);

  const symText = guid(20);
  const textChild = guid(21);
  const instText = guid(22);

  const symModes = guid(30);
  const boxInModes = guid(31);
  const instModes = guid(32);

  const gridMissing = guid(40);
  const gridResolved = guid(41);

  const added = [
    {
      guid: setB,
      phase: "CREATED",
      parentIndex: { guid: internal, position: "~setB" },
      type: "VARIABLE_SET",
      name: "Device",
      variableSetModes: [
        { id: modeB1, name: "Phone", sortPosition: "!" },
        { id: modeB2, name: "Tablet", sortPosition: "#" },
      ],
    },
    {
      guid: varWidth,
      phase: "CREATED",
      parentIndex: { guid: internal, position: "~varW" },
      type: "VARIABLE",
      name: "IndicatorWidth",
      variableSetID: { guid: setB },
      variableResolvedType: "FLOAT",
      variableDataValues: {
        entries: [
          { modeID: modeB1, variableData: { value: { floatValue: 120 }, dataType: "FLOAT" } },
          { modeID: modeB2, variableData: { value: { floatValue: 315 }, dataType: "FLOAT" } },
        ],
      },
    },
    {
      guid: varGap,
      phase: "CREATED",
      parentIndex: { guid: internal, position: "~varG" },
      type: "VARIABLE",
      name: "GridGap",
      variableSetID: { guid: setB },
      variableResolvedType: "FLOAT",
      variableDataValues: {
        entries: [
          { modeID: modeB1, variableData: { value: { floatValue: 24 }, dataType: "FLOAT" } },
          { modeID: modeB2, variableData: { value: { floatValue: 32 }, dataType: "FLOAT" } },
        ],
      },
    },
    {
      guid: varLabel,
      phase: "CREATED",
      parentIndex: { guid: internal, position: "~varL" },
      type: "VARIABLE",
      name: "NotANumber",
      variableSetID: { guid: setB },
      variableResolvedType: "STRING",
      variableDataValues: {
        entries: [
          { modeID: modeB1, variableData: { value: { textValue: "auto" }, dataType: "STRING" } },
          { modeID: modeB2, variableData: { value: { textValue: "wide" }, dataType: "STRING" } },
        ],
      },
    },
    // 1. SYMBOL placed with STRETCH / grow=1 / constraints inside its own parent;
    // INSTANCE should not inherit those, while keeping its own grid placement and constraints.
    {
      ...base,
      guid: symStretched,
      parentIndex: { guid: page, position: "~symS" },
      type: "SYMBOL",
      name: "Key",
      size: { x: 40, y: 40 },
      transform: identity(0, 6000),
      stackChildAlignSelf: "STRETCH",
      stackChildPrimaryGrow: 1,
      horizontalConstraint: "CENTER",
      verticalConstraint: "MAX",
    },
    {
      ...base,
      guid: rowParent,
      parentIndex: { guid: page, position: "~rowP" },
      type: "FRAME",
      name: "Row",
      size: { x: 200, y: 80 },
      transform: identity(0, 6100),
      stackMode: "HORIZONTAL",
    },
    {
      ...base,
      guid: instUnstretched,
      parentIndex: { guid: rowParent, position: "!" },
      type: "INSTANCE",
      name: "FixedKey",
      size: { x: 40, y: 40 },
      transform: identity(0, 0),
      symbolData: { symbolID: symStretched, symbolOverrides: [] },
    },
    {
      ...base,
      guid: gridParent,
      parentIndex: { guid: page, position: "~gridP" },
      type: "FRAME",
      name: "PlacedGrid",
      size: { x: 200, y: 120 },
      transform: identity(0, 6150),
      stackMode: "GRID",
      gridColumns: {
        entries: [
          { id: gridCol1, position: "!" },
          { id: gridCol2, position: "#" },
        ],
      },
      gridRows: {
        entries: [
          { id: gridRow1, position: "!" },
          { id: gridRow2, position: "#" },
        ],
      },
      gridColumnGap: 8,
      gridRowGap: 8,
    },
    {
      ...base,
      guid: instGridPlaced,
      parentIndex: { guid: gridParent, position: "!" },
      type: "INSTANCE",
      name: "PlacedKey",
      size: { x: 40, y: 40 },
      transform: identity(0, 0),
      symbolData: { symbolID: symStretched, symbolOverrides: [] },
      gridColumnAnchor: gridCol2,
      gridRowAnchor: gridRow2,
      horizontalConstraint: "MAX",
      verticalConstraint: "STRETCH",
    },
    // 4. Grid gaps bound to missing / non-numeric aliases must keep raw gridColumnGap / gridRowGap,
    // while valid FLOAT aliases resolve onto gridColumnGap / gridRowGap.
    {
      ...base,
      guid: gridMissing,
      parentIndex: { guid: page, position: "~gridMiss" },
      type: "FRAME",
      name: "GridMissingGap",
      size: { x: 200, y: 100 },
      transform: identity(0, 6400),
      stackMode: "GRID",
      gridColumnGap: 18,
      gridRowGap: 14,
      variableConsumptionMap: {
        entries: [
          {
            variableField: "STACK_SPACING",
            variableData: {
              value: { alias: { guid: missingVar } },
              dataType: "ALIAS",
              resolvedDataType: "FLOAT",
            },
          },
          {
            variableField: "STACK_COUNTER_SPACING",
            variableData: {
              value: { alias: { guid: varLabel } },
              dataType: "ALIAS",
              resolvedDataType: "STRING",
            },
          },
        ],
      },
    },
    {
      ...base,
      guid: gridResolved,
      parentIndex: { guid: page, position: "~gridRes" },
      type: "FRAME",
      name: "GridResolvedGap",
      size: { x: 200, y: 100 },
      transform: identity(0, 6520),
      stackMode: "GRID",
      gridColumnGap: 18,
      gridRowGap: 14,
      variableConsumptionMap: {
        entries: [
          {
            variableField: "STACK_SPACING",
            variableData: {
              value: { alias: { guid: varGap } },
              dataType: "ALIAS",
              resolvedDataType: "FLOAT",
            },
          },
          {
            variableField: "STACK_COUNTER_SPACING",
            variableData: {
              value: { alias: { guid: varGap } },
              dataType: "ALIAS",
              resolvedDataType: "FLOAT",
            },
          },
        ],
      },
    },
    // 2. derivedSymbolData has derivedTextData.layoutSize without entry.size.
    {
      ...base,
      guid: symText,
      parentIndex: { guid: page, position: "~symT" },
      type: "SYMBOL",
      name: "MenuRow",
      size: { x: 100, y: 22 },
      transform: identity(0, 6200),
    },
    {
      ...base,
      guid: textChild,
      parentIndex: { guid: symText, position: "!" },
      type: "TEXT",
      name: "Symbol",
      size: { x: 60, y: 22 },
      transform: identity(0, 0),
      fontName: { family: "Inter", style: "Regular", postscript: "" },
      fontSize: 16,
      textData: { characters: "A" },
    },
    {
      ...base,
      guid: instText,
      parentIndex: { guid: page, position: "~instT" },
      type: "INSTANCE",
      name: "MenuRowCopy",
      size: { x: 100, y: 19 },
      transform: identity(0, 6250),
      symbolData: { symbolID: symText, symbolOverrides: [] },
      derivedSymbolData: [
        {
          guidPath: { guids: [textChild] },
          derivedTextData: { layoutSize: { x: 60, y: 19 } },
        },
      ],
    },
    // 3. Instance with two collection modes whose own root override only mentions collection A.
    {
      ...base,
      guid: symModes,
      parentIndex: { guid: page, position: "~symM" },
      type: "SYMBOL",
      name: "HomeIndicator",
      size: { x: 120, y: 10 },
      transform: identity(0, 6300),
    },
    {
      ...base,
      guid: boxInModes,
      parentIndex: { guid: symModes, position: "!" },
      type: "RECTANGLE",
      name: "Bar",
      size: { x: 120, y: 5 },
      transform: identity(0, 0),
      variableConsumptionMap: {
        entries: [
          {
            variableField: "WIDTH",
            variableData: {
              value: { alias: { guid: varWidth } },
              dataType: "ALIAS",
              resolvedDataType: "FLOAT",
            },
          },
        ],
      },
    },
    {
      ...base,
      guid: instModes,
      parentIndex: { guid: page, position: "~instM" },
      type: "INSTANCE",
      name: "HomeIndicatorTablet",
      size: { x: 315, y: 10 },
      transform: identity(0, 6350),
      variableModeBySetMap: {
        entries: [
          { variableSetID: { guid: setA.guid }, variableModeID: setA.variableSetModes[0]?.id },
          { variableSetID: { guid: setB }, variableModeID: modeB2 },
        ],
      },
      symbolData: {
        symbolID: symModes,
        symbolOverrides: [
          {
            guidPath: { guids: [symModes] },
            variableModeBySetMap: {
              entries: [
                {
                  variableSetID: { guid: setA.guid },
                  variableModeID: setA.variableSetModes[0]?.id,
                },
              ],
            },
          },
        ],
      },
    },
  ] as unknown as NodeChange[];

  const archive = patchFigArchive(
    bytes.slice().buffer as ArrayBuffer,
    { records: added, fields: [], blobs: [], removed: [], replaceVariables: false },
    {
      thumbnailPNG: parsed.thumbnailPNG ?? new Uint8Array(),
      metaJSON: parsed.metaJSON ?? "{}",
      images: [],
    },
  );
  return {
    archive,
    ids: {
      instUnstretched,
      instGridPlaced,
      instText,
      textChild,
      instModes,
      boxInModes,
      setB,
      modeB2,
      gridMissing,
      gridResolved,
    },
  };
}

describe(".fig importer fidelity", { timeout: 60_000 }, () => {
  it("keeps instance placement, merges variable modes by collection, applies derived text layoutSize, and preserves raw grid gaps for unresolved aliases", async () => {
    const { archive, ids } = buildArchive();
    const fig = await readFig(archive);
    const { nodes } = convertFile(fig.file as Figma.File);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const instKey = byId.get(drawpaneId(key(ids.instUnstretched)));
    expect(instKey?.props.sizingH).toBeUndefined();
    expect(instKey?.props.sizingV).toBeUndefined();
    expect(instKey?.props.constraintH).toBeUndefined();
    expect(instKey?.props.constraintV).toBeUndefined();

    // Copy's own grid placement and constraint overrides are preserved.
    const placedKey = byId.get(drawpaneId(key(ids.instGridPlaced)));
    expect(placedKey?.props.gridArea).toEqual({
      column: 2,
      row: 2,
      columnSpan: 1,
      rowSpan: 1,
    });
    expect(placedKey?.props.constraintH).toBe("end");
    expect(placedKey?.props.constraintV).toBe("stretch");

    const copyText = byId.get(drawpaneId(`I${key(ids.instText)};${key(ids.textChild)}`));
    expect(copyText?.props.height).toBe(19);

    const indicator = byId.get(drawpaneId(key(ids.instModes)));
    expect(
      indicator?.props.variableModes?.[drawpaneId(`VariableCollectionId:${key(ids.setB)}`)],
    ).toBe(drawpaneId(key(ids.modeB2)));
    const bar = byId.get(drawpaneId(`I${key(ids.instModes)};${key(ids.boxInModes)}`));
    expect(bar?.props.width).toBe(315);

    // Missing or non-numeric variable aliases keep the raw grid gaps instead of falling to 0.
    const missingGrid = byId.get(drawpaneId(key(ids.gridMissing)));
    expect(missingGrid?.props).toMatchObject({ gap: 18, rowGap: 14 });

    // Resolvable numeric aliases resolve onto the grid gaps.
    const resolvedGrid = byId.get(drawpaneId(key(ids.gridResolved)));
    expect(resolvedGrid?.props).toMatchObject({ gap: 24, rowGap: 24 });
  });
});
