/**
 * Variant properties bound to a variable, the way iOS kits switch their
 * materials and controls between Light and Dark: a component set with a
 * "Mode" property, an instance of it nested in a main with the property
 * bound to a string variable, and copies of the main in frames set to Light
 * and to Dark. Figma shows each copy's nested instance as the variant the
 * variable names in the copy's mode, keeping the copy's overrides; Figma's
 * REST API gives the same (`componentId` names the Dark variant in a Dark
 * frame).
 *
 * Made by adding records to a committed sample that has a Light and Dark
 * collection and frames set to each (`pattern.fig`).
 */
import { readFileSync } from "node:fs";
import type { Figma } from "@drawpane/figma";
import { parseFigBuffer, patchFigArchive } from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { describe, expect, it } from "vitest";
import { readFig } from "../src";

const bytes = new Uint8Array(readFileSync(new URL("./fixtures/pattern.fig", import.meta.url)));

type Guid = { sessionID: number; localID: number };
const guid = (localID: number, sessionID = 910): Guid => ({ sessionID, localID });
const key = (g: Guid) => `${g.sessionID}:${g.localID}`;
const identity = (x = 0, y = 0) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const alias = (target: Guid) => ({
  value: { alias: { guid: target } },
  dataType: "ALIAS",
  resolvedDataType: "STRING",
});
const solid = (v: number) => [
  {
    type: "SOLID",
    color: { r: v, g: v, b: v, a: 1 },
    opacity: 1,
    visible: true,
    blendMode: "NORMAL",
  },
];

/** The "Mode" property's definition id, as Figma makes them (any guid). */
const MODE_PROP = guid(4_000_000_001, 4_000_000_000);

/** A `VARIANT_PROPERTIES` binding of the Mode property to a variable. */
const modeBinding = (variable: Guid) => ({
  entries: [
    {
      variableField: "VARIANT_PROPERTIES",
      variableData: {
        dataType: "EXPRESSION",
        resolvedDataType: "SYMBOL_ID",
        value: {
          expressionValue: {
            expressionFunction: "RESOLVE_VARIANT",
            expressionArguments: [
              {
                dataType: "MAP",
                resolvedDataType: "MAP",
                value: {
                  mapValue: {
                    values: [{ key: "Mode", guidKey: MODE_PROP, value: alias(variable) }],
                  },
                },
              },
            ],
          },
        },
      },
    },
  ],
});

interface Sample {
  set: Guid;
  variablesParent: Guid;
  light: Guid;
  dark: Guid;
  lightFrame: NodeChange;
  darkFrame: NodeChange;
}

/** The sample's mode collection, its Light and Dark modes, and a frame set to each. */
function sampleModes(records: readonly NodeChange[]): Sample {
  const set = records.find((r) => r.type === "VARIABLE_SET") as NodeChange & {
    variableSetModes: { id: Guid; name: string }[];
  };
  const mode = (name: string) => {
    const found = set.variableSetModes.find((m) => m.name.startsWith(name));
    if (!found) throw new Error(`no ${name} mode`);
    return found.id;
  };
  const light = mode("Light");
  const dark = mode("Dark");
  const frameIn = (m: Guid) =>
    records.find(
      (r) =>
        r.type === "FRAME" &&
        (
          r.variableModeBySetMap as { entries?: { variableModeID?: Guid }[] } | undefined
        )?.entries?.some((e) => e.variableModeID && key(e.variableModeID) === key(m)),
    );
  const lightFrame = frameIn(light);
  const darkFrame = frameIn(dark);
  if (!lightFrame?.guid || !darkFrame?.guid) throw new Error("the sample changed");
  return {
    set: set.guid as Guid,
    variablesParent: set.parentIndex?.guid as Guid,
    light,
    dark,
    lightFrame,
    darkFrame,
  };
}

const ids = {
  scheme: guid(1),
  tokens: guid(2),
  tokenMode: guid(3),
  token: guid(4),
  componentSet: guid(10),
  lightVariant: guid(11),
  darkVariant: guid(12),
  lightFill: guid(13),
  darkFill: guid(14),
  lightBadge: guid(15),
  darkBadge: guid(16),
  fillKey: guid(17),
  badgeKey: guid(18),
  popover: guid(20),
  popoverMaterial: guid(21),
  sheet: guid(22),
  sheetMaterial: guid(23),
  lightCopy: guid(30),
  darkCopy: guid(31),
  sheetInDark: guid(32),
  darkenedCopy: guid(33),
  placedInDark: guid(34),
};

/** The sample with the set, the mains, their copies, and the variables they bind. */
function fixture() {
  const parsed = parseFigBuffer(bytes.slice().buffer as ArrayBuffer);
  const s = sampleModes(parsed.nodeChanges);
  const page = s.lightFrame.parentIndex?.guid as Guid;
  // The set lives on another page, so a page at a time its variants come from elsewhere.
  const otherPage = parsed.nodeChanges.find(
    (r) => r.type === "CANVAS" && !r.internalOnly && r.guid && key(r.guid) !== key(page),
  )?.guid as Guid;
  const base = { phase: "CREATED", visible: true, opacity: 1 };
  const variant = (id: Guid, name: string, value: string, x: number) => ({
    ...base,
    guid: id,
    parentIndex: { guid: ids.componentSet, position: value === "Light" ? "!" : "#" },
    type: "SYMBOL",
    name,
    size: { x: 40, y: 40 },
    transform: identity(x, 0),
    variantPropSpecs: [{ propDefId: MODE_PROP, value }],
  });
  const rect = (
    id: Guid,
    parent: Guid,
    name: string,
    v: number,
    overrideKey: Guid,
    pos: string,
  ) => ({
    ...base,
    guid: id,
    parentIndex: { guid: parent, position: pos },
    type: "RECTANGLE",
    name,
    size: { x: name === "Badge" ? 10 : 40, y: name === "Badge" ? 10 : 40 },
    transform: identity(),
    fillPaints: solid(v),
    overrideKey,
  });
  const main = (id: Guid, name: string, x: number) => ({
    ...base,
    guid: id,
    parentIndex: { guid: page, position: `~${name}` },
    type: "SYMBOL",
    name,
    size: { x: 40, y: 40 },
    transform: identity(x, 3000),
  });
  const nested = (id: Guid, parent: Guid, bound: boolean) => ({
    ...base,
    guid: id,
    parentIndex: { guid: parent, position: "!" },
    type: "INSTANCE",
    name: "Material",
    size: { x: 40, y: 40 },
    transform: identity(),
    symbolData: { symbolID: ids.lightVariant, symbolOverrides: [] },
    ...(bound ? { variableConsumptionMap: modeBinding(ids.token) } : {}),
  });
  const copy = (id: Guid, of: Guid, frame: NodeChange, overrides: unknown[], pos: string) => ({
    ...base,
    guid: id,
    parentIndex: { guid: frame.guid, position: `~${pos}` },
    type: "INSTANCE",
    name: "Copy",
    size: { x: 40, y: 40 },
    transform: identity(8, 8),
    symbolData: { symbolID: of, symbolOverrides: overrides },
  });

  const records = [
    // "Scheme": a string with the mode's name, in the sample's Light and Dark collection.
    {
      guid: ids.scheme,
      phase: "CREATED",
      parentIndex: { guid: s.variablesParent, position: "~v1" },
      type: "VARIABLE",
      name: "Scheme",
      variableSetID: { guid: s.set },
      variableResolvedType: "STRING",
      variableDataValues: {
        entries: [
          { modeID: s.light, variableData: { value: { textValue: "Light" }, dataType: "STRING" } },
          { modeID: s.dark, variableData: { value: { textValue: "Dark" }, dataType: "STRING" } },
        ],
      },
    },
    // A token of another collection (one mode) aliasing it, which is what the main binds.
    {
      guid: ids.tokens,
      phase: "CREATED",
      parentIndex: { guid: s.variablesParent, position: "~v2" },
      type: "VARIABLE_SET",
      name: "Tokens",
      variableSetModes: [{ id: ids.tokenMode, name: "Default", sortPosition: "!" }],
    },
    {
      guid: ids.token,
      phase: "CREATED",
      parentIndex: { guid: s.variablesParent, position: "~v3" },
      type: "VARIABLE",
      name: "material/mode",
      variableSetID: { guid: ids.tokens },
      variableResolvedType: "STRING",
      variableDataValues: { entries: [{ modeID: ids.tokenMode, variableData: alias(ids.scheme) }] },
    },
    // The set: Mode=Light (a white fill) and Mode=Dark (a black one), each with a badge.
    {
      ...base,
      guid: ids.componentSet,
      parentIndex: { guid: otherPage, position: "~set" },
      type: "FRAME",
      name: "Material",
      isStateGroup: true,
      size: { x: 100, y: 40 },
      transform: identity(3000, 3000),
      componentPropDefs: [{ id: MODE_PROP, name: "Mode", type: "VARIANT", sortPosition: "!" }],
    },
    variant(ids.lightVariant, "Mode=Light", "Light", 0),
    variant(ids.darkVariant, "Mode=Dark", "Dark", 50),
    rect(ids.lightFill, ids.lightVariant, "Fill", 1, ids.fillKey, "!"),
    rect(ids.darkFill, ids.darkVariant, "Fill", 0, ids.fillKey, "!"),
    rect(ids.lightBadge, ids.lightVariant, "Badge", 0.5, ids.badgeKey, "#"),
    rect(ids.darkBadge, ids.darkVariant, "Badge", 0.5, ids.badgeKey, "#"),
    // A popover whose material binds Mode, and a sheet whose material doesn't.
    main(ids.popover, "Popover", 3200),
    nested(ids.popoverMaterial, ids.popover, true),
    main(ids.sheet, "Sheet", 3300),
    nested(ids.sheetMaterial, ids.sheet, false),
    // Copies: in Light; in Dark with its badge hidden; a sheet in Dark that binds Mode in its
    // override; a popover in Light whose override sets its material to Dark.
    copy(ids.lightCopy, ids.popover, s.lightFrame, [], "a"),
    copy(
      ids.darkCopy,
      ids.popover,
      s.darkFrame,
      [{ guidPath: { guids: [ids.popoverMaterial, ids.badgeKey] }, visible: false }],
      "a",
    ),
    copy(
      ids.sheetInDark,
      ids.sheet,
      s.darkFrame,
      [
        {
          guidPath: { guids: [ids.sheetMaterial] },
          variableConsumptionMap: modeBinding(ids.scheme),
        },
      ],
      "b",
    ),
    copy(
      ids.darkenedCopy,
      ids.popover,
      s.lightFrame,
      [
        {
          guidPath: { guids: [ids.popoverMaterial] },
          variableModeBySetMap: {
            entries: [{ variableSetID: { guid: s.set }, variableModeID: s.dark }],
          },
        },
      ],
      "b",
    ),
    // A material placed straight in the Dark frame, saved Light: Figma saves the variant a
    // layer shows, so what it saved stands.
    {
      ...nested(ids.placedInDark, s.darkFrame.guid as Guid, true),
      parentIndex: { guid: s.darkFrame.guid, position: "~c" },
    },
  ] as unknown as NodeChange[];

  return patchFigArchive(
    bytes.slice().buffer as ArrayBuffer,
    { records, fields: [], blobs: [], removed: [], replaceVariables: false },
    {
      thumbnailPNG: parsed.thumbnailPNG ?? new Uint8Array(),
      metaJSON: parsed.metaJSON ?? "{}",
      images: [],
    },
  );
}

function* walk(node: Figma.Node): Generator<Figma.Node> {
  yield node;
  for (const c of node.children ?? []) yield* walk(c);
}

describe("variant properties bound to a variable", { timeout: 60_000 }, () => {
  it.each([
    ["read whole", false],
    ["read a page at a time", true],
  ])(
    "shows each copy's nested instance in the variant its frame's mode names (%s)",
    async (_, pageAtATime) => {
      const fig = await readFig(fixture(), { pageAtATime });
      const nodes = new Map([...walk(fig.file.document)].map((n) => [n.id, n]));
      /** The variant a copy's material shows, its fill's grey, and whether its badge shows. */
      const material = (copy: Guid, nestedId: Guid) => {
        const node = nodes.get(`I${key(copy)};${key(nestedId)}`);
        if (!node) throw new Error(`no material in ${key(copy)}`);
        const [fill, badge] = node.children ?? [];
        const paint = fill?.fills?.[0];
        return {
          variant: node.componentId,
          fill: paint && "color" in paint ? paint.color?.r : undefined,
          badge: badge?.visible !== false,
        };
      };
      const light = { variant: key(ids.lightVariant), fill: 1, badge: true };
      const dark = { variant: key(ids.darkVariant), fill: 0, badge: true };

      expect(material(ids.lightCopy, ids.popoverMaterial)).toEqual(light);
      // Through the token's alias into the Light and Dark collection, the override kept.
      expect(material(ids.darkCopy, ids.popoverMaterial)).toEqual({ ...dark, badge: false });
      // Bound by the copy's override, not the main.
      expect(material(ids.sheetInDark, ids.sheetMaterial)).toEqual(dark);
      // A copy's override that sets the mode on the material itself.
      expect(material(ids.darkenedCopy, ids.popoverMaterial)).toEqual(dark);
      // The main shows as it's placed (Light, the collection's first mode), as saved.
      expect(nodes.get(key(ids.popoverMaterial))?.componentId).toBe(key(ids.lightVariant));
      expect(nodes.get(key(ids.placedInDark))?.componentId).toBe(key(ids.lightVariant));
    },
  );
});
