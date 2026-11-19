/**
 * Bound fields that Figma reads through something else on the layer
 * (decision 0034), found where the shadcn kit drew otherwise than Figma:
 *
 * - Corner radii: Figma draws a layer's uniform radius unless its corners
 *   are independent, so per-corner bindings on a layer whose corners aren't
 *   don't change what it draws. An image box whose corners were bound to a
 *   14 px radius drew square in Figma and rounded here.
 * - Letter spacing and line height: a bound number is read in the unit the
 *   layer's own value has, a percentage of the font size or pixels. A link
 *   set to 0% tracking under a binding worth 1.2 drew at 0.144 px in Figma
 *   and at 1.2 px here (and on main, which took Open Pencil's value).
 *
 * Made by adding records to a committed sample (`pattern.fig`).
 */
import { readFileSync } from "node:fs";
import { convertFile, drawpaneId, type Figma } from "@drawpane/figma";
import { getProp, MemoryStore, type NodeRecord, TokenResolver } from "@drawpane/model";
import { parseFigBuffer, patchFigArchive } from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { describe, expect, it } from "vitest";
import { readFig } from "../src";

const bytes = new Uint8Array(readFileSync(new URL("./fixtures/pattern.fig", import.meta.url)));

type Guid = { sessionID: number; localID: number };
const guid = (localID: number): Guid => ({ sessionID: 920, localID });
const key = (g: Guid) => `${g.sessionID}:${g.localID}`;
const identity = (x = 0, y = 0) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });

const ids = {
  radius: guid(1),
  tracking: guid(2),
  leading: guid(3),
  plain: guid(10),
  independent: guid(11),
  percentText: guid(20),
  pixelText: guid(21),
  percentLeading: guid(22),
  main: guid(30),
  label: guid(31),
  copy: guid(32),
};

const binding = (field: string, variable: Guid) => ({
  variableField: field,
  variableData: {
    value: { alias: { guid: variable } },
    dataType: "ALIAS",
    resolvedDataType: "FLOAT",
  },
});
const corners = (variable: Guid) => ({
  entries: [
    "RECTANGLE_TOP_LEFT_CORNER_RADIUS",
    "RECTANGLE_TOP_RIGHT_CORNER_RADIUS",
    "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS",
    "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS",
  ].map((field) => binding(field, variable)),
});

function fixture() {
  const parsed = parseFigBuffer(bytes.slice().buffer as ArrayBuffer);
  const records = parsed.nodeChanges;
  const set = records.find((r) => r.type === "VARIABLE_SET") as NodeChange & {
    variableSetModes: { id: Guid }[];
  };
  const modes = set.variableSetModes.map((m) => m.id);
  const page = records.find((r) => r.type === "CANVAS" && !r.internalOnly)?.guid as Guid;
  const base = { phase: "CREATED", visible: true, opacity: 1 };
  const number = (id: Guid, name: string, value: number, pos: string) => ({
    guid: id,
    phase: "CREATED",
    parentIndex: { guid: set.parentIndex?.guid, position: pos },
    type: "VARIABLE",
    name,
    variableSetID: { guid: set.guid },
    variableResolvedType: "FLOAT",
    variableDataValues: {
      entries: modes.map((modeID) => ({
        modeID,
        variableData: { value: { floatValue: value }, dataType: "FLOAT" },
      })),
    },
  });
  const box = (id: Guid, name: string, x: number, independent: boolean) => ({
    ...base,
    guid: id,
    parentIndex: { guid: page, position: `~${name}` },
    type: "FRAME",
    name,
    size: { x: 40, y: 40 },
    transform: identity(x, 5000),
    fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
    rectangleTopLeftCornerRadius: 14,
    rectangleTopRightCornerRadius: 14,
    rectangleBottomLeftCornerRadius: 14,
    rectangleBottomRightCornerRadius: 14,
    ...(independent ? { rectangleCornerRadiiIndependent: true } : {}),
    variableConsumptionMap: corners(ids.radius),
  });
  const text = (
    id: Guid,
    parent: Guid,
    name: string,
    y: number,
    fields: Record<string, unknown>,
    bound: { field: string; variable: Guid }[],
  ) => ({
    ...base,
    guid: id,
    parentIndex: { guid: parent, position: `~${name}` },
    type: "TEXT",
    name,
    size: { x: 200, y: 30 },
    transform: identity(0, y),
    fontName: { family: "Inter", style: "Regular", postscript: "" },
    fontSize: 20,
    textData: { characters: name },
    textAutoResize: "WIDTH_AND_HEIGHT",
    ...fields,
    variableConsumptionMap: { entries: bound.map((b) => binding(b.field, b.variable)) },
  });
  const added = [
    number(ids.radius, "Radius", 14, "~u1"),
    number(ids.tracking, "Tracking", 5, "~u2"),
    number(ids.leading, "Leading", 150, "~u3"),
    box(ids.plain, "Square", 0, false),
    box(ids.independent, "Rounded", 100, true),
    text(
      ids.percentText,
      page,
      "Percent",
      5100,
      { letterSpacing: { value: 0, units: "PERCENT" } },
      [{ field: "LETTER_SPACING", variable: ids.tracking }],
    ),
    text(ids.pixelText, page, "Pixels", 5200, { letterSpacing: { value: 0, units: "PIXELS" } }, [
      { field: "LETTER_SPACING", variable: ids.tracking },
    ]),
    text(
      ids.percentLeading,
      page,
      "Leading",
      5300,
      { lineHeight: { value: 100, units: "PERCENT" } },
      [{ field: "LINE_HEIGHT", variable: ids.leading }],
    ),
    // A main whose label tracks in pixels, and a copy that sets the label's tracking in percent,
    // keeping the binding (the kit's "Learn more" link).
    {
      ...base,
      guid: ids.main,
      parentIndex: { guid: page, position: "~Button" },
      type: "SYMBOL",
      name: "Button",
      size: { x: 200, y: 30 },
      transform: identity(0, 5400),
    },
    text(ids.label, ids.main, "Label", 0, { letterSpacing: { value: 0, units: "PIXELS" } }, [
      { field: "LETTER_SPACING", variable: ids.tracking },
    ]),
    {
      ...base,
      guid: ids.copy,
      parentIndex: { guid: page, position: "~Copy" },
      type: "INSTANCE",
      name: "Copy",
      size: { x: 200, y: 30 },
      transform: identity(0, 5500),
      symbolData: {
        symbolID: ids.main,
        symbolOverrides: [
          { guidPath: { guids: [ids.label] }, letterSpacing: { value: 0, units: "PERCENT" } },
        ],
      },
    },
  ] as unknown as NodeChange[];
  return patchFigArchive(
    bytes.slice().buffer as ArrayBuffer,
    { records: added, fields: [], blobs: [], removed: [], replaceVariables: false },
    {
      thumbnailPNG: parsed.thumbnailPNG ?? new Uint8Array(),
      metaJSON: parsed.metaJSON ?? "{}",
      images: [],
    },
  );
}

async function converted() {
  const fig = await readFig(fixture());
  const { nodes } = convertFile(fig.file as Figma.File);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const resolver = new TokenResolver(new MemoryStore(nodes));
  const get = (id: string): NodeRecord => {
    const node = byId.get(id);
    if (!node) throw new Error(`no ${id}`);
    return node;
  };
  const copyOf = (instance: Guid, layer: Guid) =>
    get(drawpaneId(`I${key(instance)};${key(layer)}`));
  return { get: (g: Guid) => get(drawpaneId(key(g))), copyOf, resolver };
}

describe("bound fields read through the layer", { timeout: 60_000 }, () => {
  it("corner bindings drive a layer's corners only when they're independent", async () => {
    const { get, resolver } = await converted();
    const square = get(ids.plain);
    // Figma draws the uniform radius (0): the per-corner bindings don't change it.
    expect(getProp(square.props, "bindings")).toEqual({});
    expect(getProp(resolver.resolve(square).props, "cornerRadii")).toBeNull();
    expect(getProp(resolver.resolve(square).props, "cornerRadius")).toBe(0);
    const rounded = get(ids.independent);
    expect(Object.keys(getProp(rounded.props, "bindings")).sort()).toEqual([
      "bottomLeftRadius",
      "bottomRightRadius",
      "topLeftRadius",
      "topRightRadius",
    ]);
    const radii = getProp(resolver.resolve(rounded).props, "cornerRadii");
    const radius = getProp(resolver.resolve(rounded).props, "cornerRadius");
    expect(radii ?? [radius, radius, radius, radius]).toEqual([14, 14, 14, 14]);
  });

  it("a bound letter spacing is read in the layer's unit", async () => {
    const { get, resolver } = await converted();
    const percent = get(ids.percentText);
    // 5% of 20 px, as Figma draws it: saved and resolved in percent.
    expect(getProp(percent.props, "letterSpacing")).toEqual({ unit: "percent", value: 5 });
    expect(getProp(resolver.resolve(percent).props, "letterSpacing")).toEqual({
      unit: "percent",
      value: 5,
    });
    const pixels = get(ids.pixelText);
    expect(getProp(pixels.props, "letterSpacing")).toEqual({ unit: "px", value: 5 });
    expect(getProp(resolver.resolve(pixels).props, "letterSpacing")).toEqual({
      unit: "px",
      value: 5,
    });
  });

  it("a copy that sets its tracking in percent reads its main's binding in percent", async () => {
    const { copyOf, resolver } = await converted();
    const label = copyOf(ids.copy, ids.label);
    expect(getProp(label.props, "letterSpacing")).toEqual({ unit: "percent", value: 5 });
    expect(getProp(resolver.resolve(label).props, "letterSpacing")).toEqual({
      unit: "percent",
      value: 5,
    });
  });

  it("a bound line height is read in the layer's unit", async () => {
    const { get, resolver } = await converted();
    const leading = get(ids.percentLeading);
    // 150% of 20 px, not 150 px.
    expect(getProp(leading.props, "lineHeight")).toEqual({ unit: "percent", value: 150 });
    expect(getProp(resolver.resolve(leading).props, "lineHeight")).toEqual({
      unit: "percent",
      value: 150,
    });
  });
});
