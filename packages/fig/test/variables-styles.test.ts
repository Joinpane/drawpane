/**
 * A file's variables and styles come in, and bound values resolve where
 * each copy is (decision 0034): an effect style whose shadow is bound to
 * variables, linked by a component, with a copy in a frame set to Light and
 * one set to Dark. Figma saves the component's shadow as it is in its own
 * (default) mode; each copy shows its frame's mode's shadow.
 *
 * Made by adding records to a committed sample with a Light and Dark
 * collection and frames set to each (`pattern.fig`), as variable-modes.test.ts does.
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
const guid = (localID: number): Guid => ({ sessionID: 901, localID });
const key = (g: Guid) => `${g.sessionID}:${g.localID}`;
const alias = (target: Guid, type: "COLOR" | "FLOAT") => ({
  value: { alias: { guid: target } },
  dataType: "ALIAS",
  resolvedDataType: type,
});
const identity = (x = 0, y = 0) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });

function fixture() {
  const parsed = parseFigBuffer(bytes.slice().buffer as ArrayBuffer);
  const records = parsed.nodeChanges;
  const set = records.find((r) => r.type === "VARIABLE_SET") as NodeChange & {
    variableSetModes: { id: Guid; name: string }[];
  };
  const mode = (name: string) => set.variableSetModes.find((m) => m.name.startsWith(name))?.id;
  const light = mode("Light") as Guid;
  const dark = mode("Dark") as Guid;
  const foreground = records.find((r) => r.type === "VARIABLE" && r.name === "Colors/Foreground")
    ?.guid as Guid;
  const frameIn = (m: Guid) =>
    records.find(
      (r) =>
        r.type === "FRAME" &&
        (
          r.variableModeBySetMap as { entries?: { variableModeID?: Guid }[] } | undefined
        )?.entries?.some((e) => e.variableModeID && key(e.variableModeID) === key(m)),
    ) as NodeChange;
  const lightFrame = frameIn(light);
  const darkFrame = frameIn(dark);
  const internal = set.parentIndex?.guid as Guid;
  const page = lightFrame.parentIndex?.guid as Guid;

  const shadowY = guid(1);
  const flag = guid(2);
  const style = guid(3);
  const unused = guid(4);
  const card = guid(10);
  const surface = guid(11);
  const lightCopy = guid(12);
  const darkCopy = guid(13);
  const shadow = (y: number, a: number) => ({
    type: "DROP_SHADOW",
    offset: { x: 0, y },
    radius: 4,
    spread: 0,
    visible: true,
    blendMode: "NORMAL",
    showShadowBehindNode: true,
    color: { r: 0, g: 0, b: 0, a },
    yVar: alias(shadowY, "FLOAT"),
    colorVar: alias(foreground, "COLOR"),
  });

  const added = [
    {
      guid: shadowY,
      phase: "CREATED",
      parentIndex: { guid: internal, position: "~a" },
      type: "VARIABLE",
      name: "Shadow/Y",
      description: "How far shadows fall",
      variableSetID: { guid: set.guid },
      variableResolvedType: "FLOAT",
      variableScopes: ["EFFECT_FLOAT"],
      codeSyntax: { entries: [{ platform: "WEB", value: "--shadow-y" }] },
      variableDataValues: {
        entries: [
          { modeID: light, variableData: { value: { floatValue: 0 }, dataType: "FLOAT" } },
          { modeID: dark, variableData: { value: { floatValue: 8 }, dataType: "FLOAT" } },
        ],
      },
    },
    {
      guid: flag,
      phase: "CREATED",
      parentIndex: { guid: internal, position: "~b" },
      type: "VARIABLE",
      name: "Flags/Shown",
      variableSetID: { guid: set.guid },
      variableResolvedType: "BOOLEAN",
      variableDataValues: {
        entries: [
          { modeID: light, variableData: { value: { boolValue: true }, dataType: "BOOLEAN" } },
          { modeID: dark, variableData: { value: { boolValue: false }, dataType: "BOOLEAN" } },
        ],
      },
    },
    // The effect style, saved as it is in Light.
    {
      guid: style,
      phase: "CREATED",
      parentIndex: { guid: internal, position: "~c" },
      type: "ROUNDED_RECTANGLE",
      name: "shadow/card",
      styleType: "EFFECT",
      isPublishable: true,
      visible: true,
      opacity: 1,
      size: { x: 100, y: 100 },
      transform: identity(),
      effects: [shadow(0, 1)],
    },
    // A fill style no layer uses: Figma lists it, so it comes in too.
    {
      guid: unused,
      phase: "CREATED",
      parentIndex: { guid: internal, position: "~d" },
      type: "ROUNDED_RECTANGLE",
      name: "surface/muted",
      styleType: "FILL",
      isPublishable: true,
      visible: true,
      opacity: 1,
      size: { x: 100, y: 100 },
      transform: identity(),
      fillPaints: [
        {
          type: "SOLID",
          color: { r: 1, g: 1, b: 1, a: 1 },
          opacity: 1,
          visible: true,
          blendMode: "NORMAL",
          colorVar: alias(foreground, "COLOR"),
        },
      ],
    },
    {
      guid: card,
      phase: "CREATED",
      parentIndex: { guid: page, position: "~z" },
      type: "SYMBOL",
      name: "Card",
      visible: true,
      opacity: 1,
      size: { x: 40, y: 40 },
      transform: identity(3000, 3000),
    },
    {
      guid: surface,
      phase: "CREATED",
      parentIndex: { guid: card, position: "!" },
      type: "ROUNDED_RECTANGLE",
      name: "Surface",
      visible: true,
      opacity: 1,
      size: { x: 40, y: 40 },
      transform: identity(),
      fillPaints: [
        {
          type: "SOLID",
          color: { r: 1, g: 1, b: 1, a: 1 },
          opacity: 1,
          visible: true,
          blendMode: "NORMAL",
        },
      ],
      effects: [shadow(0, 1)],
      styleIdForEffect: { guid: style },
    },
    ...[
      [lightCopy, lightFrame],
      [darkCopy, darkFrame],
    ].map(([id, frame]) => ({
      guid: id,
      phase: "CREATED",
      parentIndex: { guid: (frame as NodeChange).guid, position: "~z" },
      type: "INSTANCE",
      name: "Card",
      visible: true,
      opacity: 1,
      size: { x: 40, y: 40 },
      transform: identity(8, 8),
      symbolData: { symbolID: card, symbolOverrides: [] },
    })),
  ] as unknown as NodeChange[];
  const saved = patchFigArchive(
    bytes.slice().buffer as ArrayBuffer,
    { records: added, fields: [], blobs: [], removed: [], replaceVariables: false },
    {
      thumbnailPNG: parsed.thumbnailPNG ?? new Uint8Array(),
      metaJSON: parsed.metaJSON ?? "{}",
      images: [],
    },
  );
  return {
    bytes: saved,
    ids: {
      shadowY: drawpaneId(`VariableID:${key(shadowY)}`),
      flag: drawpaneId(`VariableID:${key(flag)}`),
      style: drawpaneId(key(style)),
      unused: drawpaneId(key(unused)),
      surface: drawpaneId(key(surface)),
      lightSurface: drawpaneId(`I${key(lightCopy)};${key(surface)}`),
      darkSurface: drawpaneId(`I${key(darkCopy)};${key(surface)}`),
      collection: drawpaneId(`VariableCollectionId:${key(set.guid as Guid)}`),
    },
  };
}

describe("variables and styles", { timeout: 60_000 }, () => {
  it("come in, and bound shadows resolve in each copy's mode", async () => {
    const f = fixture();
    const fig = await readFig(f.bytes);
    const file = fig.file as Figma.File;
    expect(Object.values(file.variables?.variables ?? {}).map((v) => v.name)).toEqual(
      expect.arrayContaining(["Shadow/Y", "Flags/Shown"]),
    );

    const { nodes } = convertFile(file);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const get = (id: string) => byId.get(id) as NodeRecord;

    // The collection, with both modes, and its variables, metadata included.
    const collection = get(f.ids.collection);
    expect(collection.type).toBe("collection");
    expect(getProp(collection.props, "modes").map((m) => m.name)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Light/), expect.stringMatching(/^Dark/)]),
    );
    const y = get(f.ids.shadowY);
    expect(y).toMatchObject({ type: "variable", parent: f.ids.collection });
    expect(y.props).toMatchObject({
      variableType: "number",
      description: "How far shadows fall",
      scopes: ["EFFECT_FLOAT"],
      codeSyntax: { web: "--shadow-y" },
    });
    expect(Object.values(getProp(y.props, "values")).sort()).toEqual([0, 8]);
    expect(get(f.ids.flag).props).toMatchObject({ variableType: "boolean" });
    expect(Object.values(getProp(get(f.ids.flag).props, "values")).sort()).toEqual([false, true]);

    // The effect style, its shadow bound, and the component's surface linking it.
    const style = get(f.ids.style);
    expect(style.type).toBe("effectStyle");
    expect(getProp(style.props, "name")).toBe("shadow/card");
    expect(getProp(style.props, "effects")[0]).toMatchObject({
      type: "drop-shadow",
      bind: { y: f.ids.shadowY, color: expect.any(String) },
    });
    expect(get(f.ids.surface).props.effectStyle).toBe(f.ids.style);
    const unused = get(f.ids.unused);
    expect(unused.type).toBe("paintStyle");
    expect(getProp(unused.props, "fills")[0]).toMatchObject({
      type: "solid",
      bind: { color: expect.any(String) },
    });

    // Copies differ from their main only by what their variables give: no override.
    for (const id of [f.ids.lightSurface, f.ids.darkSurface])
      expect(getProp(get(id).props, "overrides")).not.toContain("effects");

    // Resolved where each copy is: Light's shadow doesn't fall, Dark's does, in Dark's foreground.
    const resolver = new TokenResolver(new MemoryStore(nodes));
    const shadowOf = (id: string) => {
      const e = getProp(resolver.resolve(get(id)).props, "effects")[0];
      return e?.type === "drop-shadow" ? { y: e.y, color: e.color } : null;
    };
    expect(shadowOf(f.ids.surface)).toEqual({ y: 0, color: "#353839" });
    expect(shadowOf(f.ids.lightSurface)).toEqual({ y: 0, color: "#353839" });
    expect(shadowOf(f.ids.darkSurface)).toEqual({ y: 8, color: "#fffafa" });
  });
});
